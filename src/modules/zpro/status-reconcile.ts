// src/modules/zpro/status-reconcile.ts
// One-shot reconciliation for a ticket we just transferred or resolved: our own outbound writes
// (deactivateAgent/updateTicketInfo) already patch the LOCAL ZproConversation mirror (see
// applyDeferredZproResolve in runtime.ts), but a HUMAN closing the ticket afterward from the Z-PRO
// panel — no message attached — never fires a webhook (mirrorZproMessage only runs on
// method:"message"), so that closure would sit invisible in our own UI forever. Scheduled 3 minutes
// after handoff_to_human/resolve_conversation deactivates the agent, this does ONE live read
// (ZproClient.showTicketById) and syncs status/agentActive if they drifted — confirmed live
// 2026-08-18: a ticket closed via the panel with no new message stayed "open"/agentActive in our
// mirror indefinitely. Not a general poller: it fires once, at a fixed delay, only for tickets we
// just stepped away from.

import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn } from "@/lib/tenancy";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { ZproClient } from "./client";
import { sysCtx } from "./ctx";

const CHECK_DELAY_MS = 3 * 60_000;

export interface ScheduleZproStatusCheckParams {
  tenantId: bigint;
  zproInstanceId: bigint;
  ticketId: number;
  base?: PrismaClient;
  now?: Date;
}

// Re-arms (upsert on tenantId+kind+dedupeKey): a second handoff/resolve on the same ticket within
// the window just pushes the check 3 minutes further out instead of stacking duplicate jobs.
// `enqueue` is injectable so callers/tests can assert the scheduled shape without a DB.
export async function scheduleZproStatusCheck(
  params: ScheduleZproStatusCheckParams,
  enqueue: typeof enqueueJob = enqueueJob,
): Promise<void> {
  const now = params.now ?? new Date();
  await enqueue({
    tenantId: params.tenantId,
    kind: "ZPRO_STATUS_CHECK",
    dedupeKey: `zpro-status-check:${params.zproInstanceId}:${params.ticketId}`,
    runAt: new Date(now.getTime() + CHECK_DELAY_MS),
    // A re-arm here means a NEW handoff/resolve happened on this ticket — the world changed again —
    // not a clock repeating the same check, so a prior failed pass's budget must not carry over.
    rearm: "new-work",
    payload: {
      zproInstanceId: params.zproInstanceId.toString(),
      ticketId: params.ticketId,
    },
    base: params.base,
  });
}

export async function zproStatusCheckHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  const p = job.payload;
  const zproInstanceIdRaw = p.zproInstanceId;
  const ticketId = p.ticketId;
  if (typeof zproInstanceIdRaw !== "string" || typeof ticketId !== "number") {
    return { outcome: "done" };
  }
  let zproInstanceId: bigint;
  try {
    zproInstanceId = BigInt(zproInstanceIdRaw);
  } catch {
    return { outcome: "done" };
  }
  const tenantId = job.tenantId;

  const instance = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproInstance.findUnique({
      where: { id: zproInstanceId },
      select: { baseUrl: true, apiId: true, bearerToken: true },
    }),
  );
  // Instance removed/disconnected since the handoff — nothing to reconcile against.
  if (!instance) return { outcome: "done" };

  const client = new ZproClient(
    instance.baseUrl,
    instance.apiId,
    decryptJson<string>(instance.bearerToken),
  );
  const real = (await client.showTicketById(ticketId).catch(() => null)) as {
    data?: { status?: string; n8nStatus?: boolean };
  } | null;
  const realStatus = real?.data?.status;
  const realAgentActive = real?.data?.n8nStatus;
  if (typeof realStatus !== "string" || typeof realAgentActive !== "boolean") {
    // Ticket API unreachable/malformed — best-effort, nothing to correct.
    return { outcome: "done" };
  }

  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproConversation.updateMany({
      where: {
        zproInstanceId,
        ticketId,
        OR: [
          { status: { not: realStatus } },
          { agentActive: { not: realAgentActive } },
        ],
      },
      data: { status: realStatus, agentActive: realAgentActive },
    }),
  );
  return { outcome: "done" };
}

let registered = false;
export function registerZproStatusCheckHandler(): void {
  if (registered) return;
  registerJobHandler("ZPRO_STATUS_CHECK", (job, base) =>
    zproStatusCheckHandler(job, base ?? basePrisma),
  );
  registered = true;
}
