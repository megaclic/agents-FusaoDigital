import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { writeFlowEvent } from "@/modules/flowlog/service";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";

// The Z-PRO twin of ../chatwoot/delivery-sweep.ts (issue #228, ported): a delivery whose row sits
// non-terminal (PENDING/PROCESSING) long after the process that claimed it can plausibly still be
// working means that process died mid-turn, and nothing else will ever move the row. Before this,
// that was silent — Z-PRO's only other failure-visibility path (../zpro/failure.ts's
// announceZproFailedTurn) fires from the CATCH block `runZproAgentTurn` reaches on a thrown error,
// and a dead process never reaches its own catch block.
//
// Deliberately NOT a port of the Chatwoot sweep's classifier. `ZproWebhookDelivery` carries none of
// `ChatwootWebhookDelivery`'s correlation columns (no conversationId, no inboundMessageId, no
// humanReplyShape) — by design, the same "an id, never the event body" privacy rule, but narrower to
// begin with because Z-PRO's webhook is a single global endpoint with no per-route fan-out to
// distinguish. So there is no "lost vs. owed-takeover vs. observer-strand" verdict to compute, and no
// DELIVERY_RECOVERY to arm: nothing here can say which conversation a stranded row belongs to, let
// alone re-run the delivery path against it. This is visibility only — the row goes DEAD and an
// operator learns a message was stranded, carrying the one thing the ledger has: the Z-PRO message
// id and event type. Real recovery (if it is ever built) needs the ledger to carry more first.
const STALE_AFTER_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const BATCH = 500;

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

interface StrandedZproRow {
  id: bigint;
  status: "PENDING" | "PROCESSING";
  zproInstanceId: bigint;
  messageId: string;
  event: string;
  receivedAt: Date;
}

export interface ZproSweepCounts {
  // Terminal, reported: a stranded delivery an operator now knows about.
  stranded: number;
  // The row moved under the sweep (claimed or completed) between the scan and the write.
  raced: number;
}

export interface SweepStrandedZproDeliveriesParams {
  tenantId: bigint;
  base: PrismaClient;
  now?: Date;
  batch?: number;
}

// One pass for one tenant. Exported for the tests, which drive it directly rather than through the
// scheduler tick.
export async function sweepStrandedZproDeliveries(
  params: SweepStrandedZproDeliveriesParams,
): Promise<ZproSweepCounts> {
  const { tenantId, base } = params;
  const now = params.now ?? new Date();
  const batch = params.batch ?? BATCH;
  const counts: ZproSweepCounts = { stranded: 0, raced: 0 };

  // No `claimedAt` column on this ledger (unlike Chatwoot's), so staleness is measured from
  // `receivedAt` alone for both PENDING and PROCESSING — a row that has been anything but terminal
  // for longer than the longest legitimate turn can plausibly take.
  const cutoff = new Date(now.getTime() - STALE_AFTER_MS);
  const rows = (await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproWebhookDelivery.findMany({
      where: {
        status: { in: ["PENDING", "PROCESSING"] },
        receivedAt: { lt: cutoff },
      },
      orderBy: { receivedAt: "asc" },
      take: batch,
      select: {
        id: true,
        status: true,
        zproInstanceId: true,
        messageId: true,
        event: true,
        receivedAt: true,
      },
    }),
  )) as StrandedZproRow[];

  for (const row of rows) {
    // CAS on the status the scan read. Losing it means a redelivery or the original attempt itself
    // moved the row in between (a redelivery is not expected on this webhook, but a late-finishing
    // original claim is exactly the race this guards) — not a failure, nothing to report.
    const { count } = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproWebhookDelivery.updateMany({
        where: { id: row.id, status: row.status },
        data: { status: "DEAD", processedAt: now },
      }),
    );
    if (count === 0) {
      counts.raced += 1;
      continue;
    }

    counts.stranded += 1;
    logger.error(
      "zpro delivery sweep: message %s (%s) on instance %s stranded on %s; the customer's message was never answered",
      row.messageId,
      row.event,
      String(row.zproInstanceId),
      row.status,
    );
    const written = await writeFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        base,
      },
      {
        stage: "delivery",
        level: "error",
        status: "error",
        detail: {
          outcome: "stranded",
          deliveryEvent: row.event,
          strandedOn: row.status,
          messageId: row.messageId,
          zproInstanceId: String(row.zproInstanceId),
        },
      },
    );
    if (!written.delivered) {
      logger.error(
        "zpro delivery sweep: message %s is DEAD but its loss line could not be written; the row is in the DEAD list and nothing was alerted",
        row.messageId,
      );
    }
  }
  return counts;
}

async function zproDeliverySweepHandler(
  job: ClaimedJob,
  base: PrismaClient,
): Promise<JobResult> {
  await sweepStrandedZproDeliveries({ tenantId: job.tenantId, base });
  return {
    outcome: "reschedule",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
  };
}

let registered = false;
export function registerZproDeliverySweepHandler(): void {
  if (registered) return;
  registerJobHandler("ZPRO_DELIVERY_SWEEP", zproDeliverySweepHandler);
  registered = true;
}

// Arms the per-tenant sweep (idempotent — enqueueJob upserts one live row per (tenant, kind,
// dedupeKey), re-arming run_at). The first pass is a sweep interval out, same reasoning as the
// Chatwoot sweep: a boot is exactly when a deploy has just stranded rows, and they are not stale yet.
export async function ensureZproDeliverySweep(
  tenantId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await enqueueJob({
    tenantId,
    kind: "ZPRO_DELIVERY_SWEEP",
    dedupeKey: "zpro-delivery-sweep",
    runAt: new Date(Date.now() + SWEEP_INTERVAL_MS),
    rearm: "same-work",
    base,
  });
}

// Arms the sweep for every existing tenant (called once at boot). Same best-effort discipline as
// ensureAllDeliverySweeps: one tenant failing must not deprive every later tenant of its re-arm.
export async function ensureAllZproDeliverySweeps(
  base: PrismaClient = basePrisma,
): Promise<void> {
  const tenants = await asSuperAdminOn(base, (db) =>
    db.tenant.findMany({ select: { id: true } }),
  );
  for (const t of tenants) {
    try {
      await ensureZproDeliverySweep(t.id, base);
    } catch (err) {
      logger.warn(
        { tenantId: String(t.id), err },
        "zpro delivery sweep re-arm failed for tenant; continuing",
      );
    }
  }
}
