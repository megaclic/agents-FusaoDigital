// src/modules/zpro/failure.ts
// Z-PRO mirror of src/modules/conversations/error.ts + src/modules/conversations/failure-note.ts
// (Chatwoot) — a failed agent turn is otherwise invisible, so a silent agent and a broken one look
// the same from inside the ticket. Two parts, same as upstream: a lastError badge for the console
// (recordZproConversationError/clearZproConversationError), and a private note posted INSIDE the
// ticket when the turn is DEFINITIVELY lost — no retry coming — so an operator finds out without
// having to open the console (issue #71/#86 upstream parity).
//
// Z-PRO's "direct fence" is simpler than Chatwoot's: Chatwoot must re-fetch the conversation over
// the network because Chatwoot itself is the source of truth for what arrived; Z-PRO already
// mirrors every inbound message locally (mirrorZproMessage), so "did a newer message arrive since
// the one that triggered this turn" is a local query against ZproMessage, no network call.

import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { sanitizeErrorMessage } from "@/lib/redact";
import { runScopedOn } from "@/lib/tenancy";
import { ZproClient } from "./client";
import { sysCtx } from "./ctx";

// ── lastError badge (mirrors Chatwoot's "item 6") ──

export async function recordZproConversationError(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  error: unknown;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  try {
    await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.zproConversation.updateMany({
        where: { id: params.conversationDbId },
        data: {
          lastError: sanitizeErrorMessage(params.error),
          lastErrorAt: new Date(),
        },
      }),
    );
  } catch (err) {
    logger.warn(
      "zpro: failed to record conversation error (conv=%s): %s",
      String(params.conversationDbId),
      err instanceof Error ? err.message : String(err),
    );
  }
}

export async function clearZproConversationError(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  base?: PrismaClient;
}): Promise<void> {
  const base = params.base ?? basePrisma;
  try {
    await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.zproConversation.updateMany({
        where: { id: params.conversationDbId },
        data: { lastError: null, lastErrorAt: null },
      }),
    );
  } catch (err) {
    logger.warn(
      "zpro: failed to clear conversation error (conv=%s): %s",
      String(params.conversationDbId),
      err instanceof Error ? err.message : String(err),
    );
  }
}

// ── failed-turn announcement (mirrors Chatwoot's issue #71/#86) ──

export type ZproTurnFailure =
  // A scheduler job. `deadLettered` is the CAS result, not the attempt count: only the statement
  // that actually moved the row to DEAD may claim the turn is over.
  | { path: "job"; deadLettered: boolean }
  // The direct path. `clear` = no newer CLIENT message exists, so nothing else will answer;
  // `superseded` = one does; `unknown` = the fence could not be read.
  | { path: "direct"; fence: "clear" | "superseded" | "unknown" };

export function isZproTurnLost(f: ZproTurnFailure): boolean {
  return f.path === "job" ? f.deadLettered : f.fence === "clear";
}

// Local query, no network — see the module header for why this differs from Chatwoot's re-fetch.
export async function readZproDirectFence(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  triggerMessageDbId: bigint | null;
  base?: PrismaClient;
}): Promise<"clear" | "superseded" | "unknown"> {
  if (params.triggerMessageDbId === null) return "unknown";
  const base = params.base ?? basePrisma;
  try {
    const newer = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.zproMessage.count({
        where: {
          conversationId: params.conversationDbId,
          senderType: "CLIENT",
          id: { gt: params.triggerMessageDbId as bigint },
        },
      }),
    );
    return newer > 0 ? "superseded" : "clear";
  } catch (err) {
    logger.warn(
      "zpro: failed-turn fence unreadable (conv=%s): %s",
      String(params.conversationDbId),
      err instanceof Error ? err.message : String(err),
    );
    return "unknown";
  }
}

// One announcement per conversation per window — mirrors Chatwoot's FAILURE_NOTICE_COOLDOWN_MS.
export const ZPRO_FAILURE_NOTICE_COOLDOWN_MS = 30 * 60_000;

// Elects the single announcer, atomically — same claim-IS-the-write shape as Chatwoot's
// claimFailureNotice.
async function claimZproFailureNotice(params: {
  tenantId: bigint;
  conversationDbId: bigint;
  now?: Date;
  cooldownMs?: number;
  base?: PrismaClient;
}): Promise<boolean> {
  const base = params.base ?? basePrisma;
  const now = params.now ?? new Date();
  const cooldownMs = params.cooldownMs ?? ZPRO_FAILURE_NOTICE_COOLDOWN_MS;
  const cutoff = new Date(now.getTime() - cooldownMs);
  const { count } = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    db.zproConversation.updateMany({
      where: {
        id: params.conversationDbId,
        OR: [
          { failureNoticeSentAt: null },
          { failureNoticeSentAt: { lt: cutoff } },
        ],
      },
      data: { failureNoticeSentAt: now },
    }),
  );
  return count > 0;
}

function noteText(reason: string): string {
  return [
    "⚠️ Não consegui responder a esta conversa.",
    "Um atendente humano precisa assumir.",
    `Motivo: ${reason}`,
  ].join("\n\n");
}

// Best-effort end to end: a Z-PRO that is down must never turn one failed turn into two, and a
// posting failure must never mask the original turn error.
export async function announceZproFailedTurn(params: {
  tenantId: bigint;
  zproInstanceId: bigint;
  conversationDbId: bigint;
  ticketId: number;
  assess: () => Promise<ZproTurnFailure>;
  error: unknown;
  now?: Date;
  cooldownMs?: number;
  base?: PrismaClient;
}): Promise<"posted" | "not-lost" | "coalesced" | "failed"> {
  const base = params.base ?? basePrisma;
  try {
    if (!isZproTurnLost(await params.assess())) return "not-lost";
    if (
      !(await claimZproFailureNotice({
        tenantId: params.tenantId,
        conversationDbId: params.conversationDbId,
        now: params.now,
        cooldownMs: params.cooldownMs,
        base,
      }))
    ) {
      return "coalesced";
    }
    const instance = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
      db.zproInstance.findUnique({
        where: { id: params.zproInstanceId },
        select: { baseUrl: true, apiId: true, bearerToken: true },
      }),
    );
    if (!instance) {
      logger.warn(
        "zpro: no instance to announce a failed turn on (conv=%s)",
        String(params.conversationDbId),
      );
      return "failed";
    }
    const client = new ZproClient(
      instance.baseUrl,
      instance.apiId,
      decryptJson<string>(instance.bearerToken),
    );
    await client.createNote(
      params.ticketId,
      noteText(sanitizeErrorMessage(params.error)),
    );
    return "posted";
  } catch (err) {
    logger.warn(
      "zpro: failed-turn note not posted (conv=%s): %s",
      String(params.conversationDbId),
      err instanceof Error ? err.message : String(err),
    );
    return "failed";
  }
}
