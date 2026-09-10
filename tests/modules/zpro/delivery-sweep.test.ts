// tests/modules/zpro/delivery-sweep.test.ts
// The Z-PRO twin of tests/modules/delivery-sweep.test.ts (issue #228, ported): a ZproWebhookDelivery
// row stuck PENDING/PROCESSING long past a legitimate turn's duration means the process that claimed
// it died mid-turn, and sweepStrandedZproDeliveries is what stops that from being silent. Simpler
// than the Chatwoot classifier because the ledger itself is simpler (no conversationId/
// inboundMessageId/humanReplyShape to correlate against) — visibility only, no recovery armed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  ensureAllZproDeliverySweeps,
  ensureZproDeliverySweep,
  sweepStrandedZproDeliveries,
} from "@/modules/zpro/delivery-sweep";
import { clearFlowLog, flowLogRows } from "@/tests/utils/flowlog";
import { POLL_DEADLINE_MS } from "@/tests/utils/poll";

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

const STALE_MS = 30 * 60 * 1000;

let tenantId = 0n;
let zproInstanceId = 0n;
let deliverySeq = 0;

async function seedDelivery(over: {
  ageMs: number;
  status?: "PENDING" | "PROCESSING" | "PROCESSED" | "DEAD";
  event?: string;
}): Promise<{ id: bigint; messageId: string }> {
  deliverySeq += 1;
  const messageId = `sweep-${process.pid}-${deliverySeq}`;
  const row = await suDb.zproWebhookDelivery.create({
    data: {
      tenantId,
      zproInstanceId,
      messageId,
      event: over.event ?? "conversation",
      status: over.status ?? "PROCESSING",
      receivedAt: new Date(Date.now() - over.ageMs),
    },
    select: { id: true },
  });
  return { id: row.id, messageId };
}

async function statusOf(rowId: bigint) {
  return suDb.zproWebhookDelivery.findUniqueOrThrow({
    where: { id: rowId },
    select: { status: true, processedAt: true },
  });
}

// Polled: writeFlowEvent's alert dispatch aside, the executionLog row itself lands via a normal
// awaited insert inside sweepStrandedZproDeliveries, but flowLogRows still settles pending writes
// the same way every other flow-log reader in the suite does (see tests/utils/flowlog.ts).
async function deliveryLinesFor(messageId: string, waitMs = POLL_DEADLINE_MS) {
  const started = Date.now();
  while (true) {
    // flowlog-scope: tenant-wide — the ledger row this line is about carries no
    // conversationId/threadId/turnId (see delivery-sweep.ts's header comment: there is nothing to
    // correlate a stranded row to a conversation with), so there is no turn key to filter by in SQL.
    // Safe within this file: every row's `detail.messageId` is unique per test (seedDelivery mints a
    // fresh one each call), and the filter below narrows to it before anything is asserted.
    const rows = await flowLogRows(suDb, {
      where: { tenantId, stage: "delivery" },
      select: { level: true, status: true, detail: true },
    });
    const matching = rows.filter(
      (r) =>
        (r.detail as Record<string, unknown> | null)?.messageId === messageId,
    );
    if (matching.length > 0 || Date.now() - started > waitMs) return matching;
    await Bun.sleep(25);
  }
}

describe.skipIf(!dbUp)("a Z-PRO delivery stranded by a process death", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZSWP", slug: `zswp-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 94,
        instanceName: "ZproSweepInstance",
      },
    });
    zproInstanceId = inst.id;
  });

  afterAll(async () => {
    if (!dbUp) return;
    await clearFlowLog(suDb, { tenantId });
    for (const table of [
      "scheduler_jobs",
      "zpro_webhook_deliveries",
      "zpro_instances",
    ]) {
      await suDb
        .$executeRawUnsafe(`DELETE FROM ${table} WHERE tenant_id = ${tenantId}`)
        .catch(() => {});
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("marks a stale PENDING row DEAD and writes an error-level line", async () => {
    const { id, messageId } = await seedDelivery({
      ageMs: STALE_MS * 2,
      status: "PENDING",
      event: "conversation",
    });
    const counts = await sweepStrandedZproDeliveries({
      tenantId,
      base: appDb,
    });
    expect(counts.stranded).toBeGreaterThanOrEqual(1);
    expect((await statusOf(id)).status).toBe("DEAD");

    const lines = await deliveryLinesFor(messageId);
    expect(lines).toHaveLength(1);
    const line = lines[0];
    if (!line) throw new Error("no delivery line was written");
    expect(line.level).toBe("error");
    expect(line.detail).toMatchObject({
      outcome: "stranded",
      deliveryEvent: "conversation",
      strandedOn: "PENDING",
      messageId,
    });
  });

  test("marks a stale PROCESSING row DEAD too", async () => {
    const { id, messageId } = await seedDelivery({
      ageMs: STALE_MS * 2,
      status: "PROCESSING",
      event: "audioMessage",
    });
    await sweepStrandedZproDeliveries({ tenantId, base: appDb });
    expect((await statusOf(id)).status).toBe("DEAD");
    const lines = await deliveryLinesFor(messageId);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.detail).toMatchObject({ strandedOn: "PROCESSING" });
  });

  test("leaves a recent PROCESSING row alone (still plausibly in flight)", async () => {
    const { id, messageId } = await seedDelivery({
      ageMs: 60_000,
      status: "PROCESSING",
    });
    await sweepStrandedZproDeliveries({ tenantId, base: appDb });
    expect((await statusOf(id)).status).toBe("PROCESSING");
    expect(await deliveryLinesFor(messageId, 300)).toHaveLength(0);
  });

  test("leaves an already-terminal PROCESSED row alone", async () => {
    const { id, messageId } = await seedDelivery({
      ageMs: STALE_MS * 2,
      status: "PROCESSED",
    });
    await sweepStrandedZproDeliveries({ tenantId, base: appDb });
    expect((await statusOf(id)).status).toBe("PROCESSED");
    expect(await deliveryLinesFor(messageId, 300)).toHaveLength(0);
  });

  test("ensureZproDeliverySweep arms one ZPRO_DELIVERY_SWEEP row for the tenant", async () => {
    await ensureZproDeliverySweep(tenantId, appDb);
    const job = await suDb.schedulerJob.findFirst({
      where: { tenantId, kind: "ZPRO_DELIVERY_SWEEP" },
      select: { dedupeKey: true, status: true },
    });
    expect(job?.dedupeKey).toBe("zpro-delivery-sweep");
    expect(job?.status).toBe("PENDING");
  });

  test("ensureAllZproDeliverySweeps arms it across tenants without throwing", async () => {
    await expect(ensureAllZproDeliverySweeps(appDb)).resolves.toBeUndefined();
  });
});
