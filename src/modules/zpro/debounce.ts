// src/modules/zpro/debounce.ts
// Debounce (coalescência de rajadas de mensagem) para o canal Z-PRO — reaproveita a infra genérica
// do Chatwoot: o mesmo SchedulerJob kind "DEBOUNCE" (fast worker, claim FOR UPDATE SKIP LOCKED,
// anti-starvation) e a função armDebounce em si (src/modules/debounce/service.ts, zero acoplamento
// Chatwoot — só bookkeeping de threadId/payload). debounceFlushHandler (src/modules/debounce/
// handler.ts) despacha pra flushZproDebounceJob quando o threadId começa com "zpro:" — nenhuma
// mudança na infra do scheduler em si.
//
// O FLUSH em si é mais simples que o do Chatwoot: lá, o re-fetch é obrigatório porque a regra
// anti-PII proíbe mirrorar o corpo da mensagem — aqui, ZproMessage.body JÁ é a fonte de verdade do
// inbox (mirrorZproMessage grava direto, sem essa restrição — ver docs/zpro.md), então o flush
// coaleça DIRETO do banco local, sem nenhuma chamada de rede pra "re-buscar" a conversa.
//
// Watermark: ZproConversation.lastHandledMessageId (BigInt, nosso próprio ZproMessage.id — não um
// id externo), avançado por um CAS monotônico idêntico ao advanceHandledWatermark do Chatwoot.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn } from "@/lib/tenancy";
import { contactAuthFlowEvent } from "@/modules/contact-auth/service";
import { readLastMessageId } from "@/modules/debounce/service";
import {
  DEBOUNCE_DEFAULTS,
  type DebounceConfig,
  readDebounceConfig,
} from "@/modules/debounce/settings";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import type { ClaimedJob } from "@/modules/scheduler/service";
import type { JobResult } from "@/modules/scheduler/worker";
import { authorizeZproContact } from "./contact-auth";
import { sysCtx } from "./ctx";
import {
  announceZproFailedTurn,
  clearZproConversationError,
  recordZproConversationError,
} from "./failure";
import {
  parseContactExtraInfo,
  withMediaFallback,
  withQuotedPrefix,
} from "./parse";
import { loadZproAgent, runLoadedZproTurn, zproThreadId } from "./runtime";
import type { NormalizedZproEvent } from "./types";

// Resolves the debounce config for the agent bound to this Z-PRO instance (scoped read, no
// network). null when unbound, disabled, or debounce off — the caller then takes the direct
// (no-coalesce) path, mirroring resolveZproSttConfig/resolveZproVisionConfig.
export async function resolveZproDebounceConfig(
  tenantId: bigint,
  zproInstanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<DebounceConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const binding = await db.zproAgentBinding.findFirst({
      where: { tenantId, zproInstanceId },
      select: { agentId: true },
    });
    if (!binding) return null;
    const agent = await db.agent.findUnique({
      where: { id: binding.agentId },
      select: { enabled: true, settings: true },
    });
    if (!agent?.enabled) return null;
    return readDebounceConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

// Inverse of runtime.ts's zproThreadId. null on anything that doesn't match the Z-PRO shape
// (`zpro:<tenantId>:<zproInstanceId>:<ticketId>`) — a Chatwoot threadId (`tenantId:instanceId:
// conversationId`, no "zpro" segment) never matches, so debounceFlushHandler's branch is safe.
export function parseZproThreadId(
  threadId: string,
): { tenantId: bigint; zproInstanceId: bigint; ticketId: number } | null {
  const parts = threadId.split(":");
  if (parts.length !== 4 || parts[0] !== "zpro") return null;
  try {
    const tenantId = BigInt(parts[1] as string);
    const zproInstanceId = BigInt(parts[2] as string);
    const ticketId = Number(parts[3]);
    if (!Number.isInteger(ticketId)) return null;
    return { tenantId, zproInstanceId, ticketId };
  } catch {
    return null;
  }
}

// Shared by both early exits that drop a whole burst without posting (a human already owns the
// ticket, or the contact-authorization gate refused it): advance the watermark off the burst's
// high-water mark kept in the payload at arm time (issue #8 fix) — no query needed — so the next
// flush doesn't re-coalesce what this one already counted as handled.
async function advanceZproWatermarkFromArm(
  base: PrismaClient,
  tenantId: bigint,
  convDbId: bigint,
  job: ClaimedJob,
): Promise<void> {
  const last = readLastMessageId(job.payload);
  if (last === null) return;
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproConversation.updateMany({
      where: {
        id: convDbId,
        OR: [
          { lastHandledMessageId: null },
          { lastHandledMessageId: { lt: BigInt(last) } },
        ],
      },
      data: { lastHandledMessageId: BigInt(last) },
    }),
  );
}

export interface FlushZproDebounceParams {
  job: ClaimedJob;
  base: PrismaClient;
}

export async function flushZproDebounceJob(
  params: FlushZproDebounceParams,
): Promise<JobResult> {
  const { job, base } = params;
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  if (!threadId) return { outcome: "done" };
  const parsed = parseZproThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return { outcome: "done" };
  const { zproInstanceId, ticketId } = parsed;
  const tenantId = job.tenantId;

  // 1. Scoped read: the conversation + the agent-active gate (mirrors Chatwoot's shouldBotHandle
  // check inside flushDebounceJob's tx1).
  const ctx = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conv = await db.zproConversation.findUnique({
      where: { zproInstanceId_ticketId: { zproInstanceId, ticketId } },
      select: {
        id: true,
        agentActive: true,
        lastHandledMessageId: true,
        contactId: true,
        contactName: true,
        contactNumber: true,
        contactExtraInfo: true,
      },
    });
    if (!conv) return null;
    if (!conv.agentActive) {
      return { gateClosed: true as const, convDbId: conv.id };
    }
    return {
      gateClosed: false as const,
      convDbId: conv.id,
      watermark: conv.lastHandledMessageId,
      contactId: conv.contactId,
      contactName: conv.contactName,
      contactNumber: conv.contactNumber,
      contactExtraInfo: conv.contactExtraInfo,
    };
  });
  if (ctx === null) return { outcome: "done" };

  // A human owns the conversation now (took over between the arm and this flush): the burst is
  // theirs to answer. Advance the watermark using the burst's high-water mark kept in the payload
  // at arm time (issue #8 fix, reused as-is from armDebounce — no network/query needed) so the
  // first flush after the human returns it doesn't re-coalesce the whole human-era backlog.
  if (ctx.gateClosed) {
    await advanceZproWatermarkFromArm(base, tenantId, ctx.convDbId, job);
    return { outcome: "done" };
  }

  const loaded = await loadZproAgent(base, tenantId, zproInstanceId);
  if (!loaded) return { outcome: "done" };

  // The contact-authorization gate, again, at the point the turn happens (docs/contact-auth.md,
  // mirrors src/modules/debounce/handler.ts's flushDebounceJob exactly): the webhook checks every
  // incoming message, but a turn is not a message — one allowed message can arm a flush that a
  // later, refused message rides into (the refused delivery arms nothing, but the pending flush
  // re-fetches everything past the watermark), and a revocation landing inside the coalescing
  // window is the same hole from the other side. A refusal ends the flush like a human takeover:
  // the burst counts as handled off the ARM-TIME payload's own last id (no re-fetch), nothing is
  // posted, no customer copy and no handoff — those answer a message the customer just sent, and
  // the webhook path already gave them to the delivery it refused. The flow line is what tells the
  // operator the burst was dropped.
  if (loaded.contactAuthConfig.enabled) {
    const identifier =
      parseContactExtraInfo(ctx.contactExtraInfo).identifier?.trim() || null;
    const auth = await authorizeZproContact({
      tenantId,
      agentId: loaded.agentId,
      contactNumber: ctx.contactNumber,
      contactName: ctx.contactName,
      identifier,
      ticketId,
      // Unavailable outside a live webhook payload (ZproConversation doesn't store it) — same
      // degradation the synthetic event below already accepts for {{canal}}.
      channelType: null,
      // The burst is many messages, not one: there is no single text to forward, and an unlock
      // code is something the customer sends on a message of their own, which the webhook path
      // already checked.
      messageText: null,
      // Its own asking, like the nudge's: it carries no message text and must never join (or be
      // joined by) the flight of an incoming message that does.
      requestKey: "debounce",
      cfg: loaded.contactAuthConfig,
      base,
    });
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        agentId: loaded.agentId,
        threadId: zproThreadId(tenantId, zproInstanceId, String(ticketId)),
        base,
        fullDetail: loaded.fullDetail,
      },
      contactAuthFlowEvent(auth),
    );
    if (auth.outcome !== "allowed") {
      logger.info(
        "zpro debounce flush: contact not authorized (conv=%s outcome=%s), dropping the burst",
        String(ctx.convDbId),
        auth.outcome,
      );
      await advanceZproWatermarkFromArm(base, tenantId, ctx.convDbId, job);
      return { outcome: "done" };
    }
  }

  // 2. Coalesce the burst PAST THE WATERMARK, straight from our own mirror (no re-fetch — see the
  // module header). Cap at maxMessagesPerBurst, keeping the most recent.
  const watermark = ctx.watermark;
  const pendingAll = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproMessage.findMany({
      where: {
        conversationId: ctx.convDbId,
        senderType: "CLIENT",
        ...(watermark != null ? { id: { gt: watermark } } : {}),
      },
      orderBy: { id: "asc" },
      select: {
        id: true,
        body: true,
        quotedText: true,
        messageType: true,
        messageId: true,
      },
    }),
  );
  if (pendingAll.length === 0) return { outcome: "done" };

  const cfg =
    (await resolveZproDebounceConfig(tenantId, zproInstanceId, base)) ??
    DEBOUNCE_DEFAULTS;
  let pending = pendingAll;
  if (pending.length > cfg.maxMessagesPerBurst) {
    logger.warn(
      "zpro debounce flush: burst of %d capped to %d (conv=%s)",
      pending.length,
      cfg.maxMessagesPerBurst,
      String(ctx.convDbId),
    );
    pending = pending.slice(pending.length - cfg.maxMessagesPerBurst);
  }
  const last = pending[pending.length - 1] as (typeof pending)[number];
  const targetWatermark = last.id;

  // 3. Post gate: re-check for a newer inbound (supersede), then advance the watermark
  // monotonically so a concurrent claim cannot also post. Shared by every posting exit in
  // runLoadedZproTurn (input-guardrail reply AND the main reply) — a single check, like Chatwoot's.
  const shouldPost = async (): Promise<boolean> => {
    const newer = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproMessage.count({
        where: {
          conversationId: ctx.convDbId,
          senderType: "CLIENT",
          id: { gt: targetWatermark },
        },
      }),
    );
    if (newer > 0) {
      logger.info(
        "zpro debounce: superseded mid-turn (conv=%s), deferring",
        String(ctx.convDbId),
      );
      return false;
    }
    const cas = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproConversation.updateMany({
        where: {
          id: ctx.convDbId,
          OR: [
            { lastHandledMessageId: null },
            { lastHandledMessageId: { lt: targetWatermark } },
          ],
        },
        data: { lastHandledMessageId: targetWatermark },
      }),
    );
    return cas.count > 0;
  };

  const text = pending
    .map((m) =>
      withQuotedPrefix(withMediaFallback(m.body, m.messageType), m.quotedText),
    )
    .filter(Boolean)
    .join("\n");
  if (!text) {
    // Genuinely nothing to answer (e.g. a plain-text message somehow arrived empty) —
    // withMediaFallback already covers every media type that could otherwise go silent. Advance
    // so future flushes don't keep re-stopping on the same messages.
    await shouldPost();
    return { outcome: "done" };
  }

  // Synthetic event for the coalesced burst: contactName/contactNumber feed prompt vars; the last
  // message's messageId feeds the send helpers' externalKey uniqueness. `body` itself is unused —
  // runLoadedZproTurn takes `text` explicitly. channelType is unavailable outside a live webhook
  // payload (ZproConversation doesn't store it) — left blank, a minor {{canal}} degradation only.
  const event: NormalizedZproEvent = {
    messageId: last.messageId,
    threadId: String(ticketId),
    tenantId: Number(tenantId),
    instanceId: Number(zproInstanceId),
    instanceName: "",
    channelType: "",
    apiId: loaded.instance.apiId,
    contactId: ctx.contactId,
    contactNumber: ctx.contactNumber,
    contactName: ctx.contactName,
    extraInfo: [],
    messageType: "conversation",
    body: "",
    fromMe: false,
    timestamp: Date.now(),
    ticketStatus: "open",
    agentActive: true,
    hasHumanAssigned: false,
  };
  const userSentAudio = pending.some((m) => m.messageType === "audioMessage");

  // One turnId shared between this coalescing line and the turn's own stages (generate/tts/split),
  // so they group under one card in /logs — mirrors Chatwoot's coalesceAndRunTurn.
  const turnId = crypto.randomUUID();
  const flow: FlowContext = {
    tenantId,
    turnId,
    source: "inbox",
    agentId: loaded.agentId,
    threadId: zproThreadId(tenantId, zproInstanceId, event.threadId),
    base,
    fullDetail: loaded.fullDetail,
  };
  emitFlowEvent(flow, {
    stage: "debounce",
    level: "info",
    status: "ok",
    detail: { coalesced: pending.length },
  });

  // A thrown error (LLM/Z-PRO) bubbles to the worker → retry with backoff (watermark not advanced,
  // so the retry re-answers the same burst). Also surfaced on the conversation (upstream #86 parity,
  // src/modules/zpro/failure.ts) so the operator sees a badge; a successful answer clears it. The
  // dead-letter announcement (the private note INSIDE the ticket) fires separately, only once the
  // scheduler has definitively given up — see announceDeadZproDebounceFlush below.
  let outcome: Awaited<ReturnType<typeof runLoadedZproTurn>>;
  try {
    outcome = await runLoadedZproTurn({
      loaded,
      tenantId,
      zproInstanceId,
      event,
      text,
      turnId,
      userSentAudio,
      base,
      shouldPost,
    });
  } catch (err) {
    await recordZproConversationError({
      tenantId,
      conversationDbId: ctx.convDbId,
      error: err,
      base,
    });
    throw err;
  }
  if (outcome === "posted") {
    await clearZproConversationError({
      tenantId,
      conversationDbId: ctx.convDbId,
      base,
    });
  }
  logger.info(
    "zpro debounce flush: conv=%s msgs=%d watermark→%s outcome=%s",
    String(ctx.convDbId),
    pending.length,
    String(targetWatermark),
    outcome,
  );
  // Every outcome except "superseded" consumed the burst — shouldPost's own CAS already advanced
  // the watermark for whichever exit called it (input-guardrail reply or the main reply); this is
  // a defensive re-assert for any exit that returns without ever calling shouldPost (empty/blocked/
  // taken-over never reach a post). Idempotent: a target ≤ the current value is simply a no-op.
  if (outcome !== "superseded") {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproConversation.updateMany({
        where: {
          id: ctx.convDbId,
          OR: [
            { lastHandledMessageId: null },
            { lastHandledMessageId: { lt: targetWatermark } },
          ],
        },
        data: { lastHandledMessageId: targetWatermark },
      }),
    );
  }
  return { outcome: "done" };
}

// The burst is definitively unanswered: the flush exhausted its attempts and the row is DEAD, so no
// retry is coming — mirrors Chatwoot's announceDeadDebounceFlush (debounce/handler.ts), registered
// as this SAME "DEBOUNCE" kind's dead-letter handler (dispatched by thread shape, see
// deadDebounceFlushHandler in debounce/handler.ts).
export async function announceDeadZproDebounceFlush(
  job: ClaimedJob,
  error: string,
  base: PrismaClient,
): Promise<void> {
  const threadId =
    typeof job.payload.threadId === "string" ? job.payload.threadId : null;
  if (!threadId) return;
  const parsed = parseZproThreadId(threadId);
  if (!parsed || parsed.tenantId !== job.tenantId) return;
  const { zproInstanceId, ticketId } = parsed;
  const tenantId = job.tenantId;
  const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproConversation.findUnique({
      where: { zproInstanceId_ticketId: { zproInstanceId, ticketId } },
      select: { id: true },
    }),
  );
  if (!conv) return;
  await announceZproFailedTurn({
    tenantId,
    zproInstanceId,
    conversationDbId: conv.id,
    ticketId,
    // NOTE: Re-read rather than trust the dead-letter that got us here — armDebounce upserts this
    // very row back to PENDING on the next inbound message, and a row that is queued again is a
    // turn that is coming, mirrors Chatwoot's exact reasoning (debounce/handler.ts).
    assess: async () => {
      const row = await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.schedulerJob.findUnique({
          where: { id: job.id },
          select: { status: true },
        }),
      );
      return { path: "job", deadLettered: row?.status === "DEAD" };
    },
    error,
    base,
  });
}
