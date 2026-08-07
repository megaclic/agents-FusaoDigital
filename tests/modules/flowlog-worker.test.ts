import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { TenantContext } from "@/lib/tenancy";
import { processAlertBatch } from "@/modules/flowlog/alert-worker";
import { createAlertChannel } from "@/modules/flowlog/channels";
import { outboundUrl } from "../utils/outbound";

// Alert worker: claim → deliver/retry/dead, and the coalesce window. The claim is cross-tenant, so
// each test asserts ITS OWN delivery row by id (a default-204 fetch makes any co-claimed row a
// harmless success) and branches the injected fetch/assertSafe on the channel URL.

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

let tenantId = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}
const ok204 = (() =>
  new Response(null, { status: 204 })) as unknown as typeof fetch;

async function makeDelivery(channelId: bigint): Promise<bigint> {
  const row = await suDb.alertDelivery.create({
    data: {
      tenantId,
      channelId,
      stage: "generate",
      level: "error",
      summary: "boom",
    },
  });
  return row.id;
}

describe.skipIf(!dbUp)("alert worker", () => {
  beforeAll(async () => {
    tenantId = (
      await suDb.tenant.create({
        data: { name: "FlowW", slug: `flow-w-${process.pid}` },
      })
    ).id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const tbl of ["alert_deliveries", "alert_channels"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${tbl} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("delivers a due delivery (2xx) and marks it DELIVERED", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      {
        name: "ok",
        type: "discord",
        url: outboundUrl("/api/webhooks/ok"),
      },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const batch = await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: ok204,
      now: () => Date.now(),
    });
    // NOTE: assert the CLAIM before the outcome. Every observed flake in this file has been the row
    // not being picked up at all, and `status is PENDING, expected DELIVERED` does not say whether
    // the claim missed it or the delivery failed — checking the summary first names the cause.
    // Lower-bound, not exact: the claim is allowed to sweep up a sibling test's retry row (see the
    // note at the top of the file), so pinning it to 1 would trade one flake for another.
    expect(batch.claimed).toBeGreaterThanOrEqual(1);
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("DELIVERED");
    expect(row?.attempts).toBe(1);
  });

  test("retries on a non-2xx response (back to PENDING with a next attempt)", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      {
        name: "retry",
        type: "webhook",
        url: outboundUrl("/retry"),
      },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const fetchImpl = (async (url: string) =>
      new Response(null, {
        status: url.includes("/retry") ? 500 : 204,
      })) as unknown as typeof fetch;
    const batch = await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl,
      now: () => Date.now(),
    });
    expect(batch.claimed).toBeGreaterThanOrEqual(1);
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(1);
    expect(row?.nextAttemptAt).not.toBeNull();
  });

  test("a blocked (SSRF) URL goes straight to DEAD", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      {
        name: "dead",
        type: "webhook",
        url: outboundUrl("/blocked"),
      },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    const assertSafe = async (url: string) => {
      if (url.includes("/blocked")) throw new Error("ssrf blocked");
      return new URL(url);
    };
    const batch = await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 0,
      fetchImpl: ok204,
      assertSafe,
      now: () => Date.now(),
    });
    expect(batch.claimed).toBeGreaterThanOrEqual(1);
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("DEAD");
  });

  test("a fresh delivery within the coalesce window is NOT claimed", async () => {
    const ch = await createAlertChannel(
      ctx(tenantId),
      {
        name: "window",
        type: "discord",
        url: outboundUrl("/api/webhooks/window"),
      },
      appDb,
    );
    const id = await makeDelivery(BigInt(ch.id));
    await processAlertBatch({
      base: appDb,
      tenantId,
      coalesceWindowMs: 60_000, // a just-created row is younger than the window → skipped
      fetchImpl: ok204,
      now: () => Date.now(),
    });
    const row = await suDb.alertDelivery.findUnique({ where: { id } });
    expect(row?.status).toBe("PENDING");
    expect(row?.attempts).toBe(0);
  });
});
