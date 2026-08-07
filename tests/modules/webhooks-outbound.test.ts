import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { runScopedOn, type ScopedDb } from "@/lib/tenancy";
import { emitOutbound } from "@/modules/webhooks/outbound/service";
import {
  signOutbound,
  verifyOutboundSignature,
} from "@/modules/webhooks/outbound/signing";
import { outboundUrl } from "../utils/outbound";

describe("outbound webhook signing", () => {
  test("signOutbound is deterministic and prefixed", () => {
    const sig = signOutbound("secret", 1700000000, '{"a":1}');
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signOutbound("secret", 1700000000, '{"a":1}')).toBe(sig);
  });

  test("verify accepts a matching signature and rejects tampering", () => {
    const ts = 1700000000;
    const body = '{"event":"conversion"}';
    const sig = signOutbound("secret", ts, body);
    expect(verifyOutboundSignature("secret", ts, body, sig)).toBe(true);
    expect(verifyOutboundSignature("wrong", ts, body, sig)).toBe(false);
    expect(verifyOutboundSignature("secret", ts + 1, body, sig)).toBe(false);
    expect(verifyOutboundSignature("secret", ts, `${body} `, sig)).toBe(false);
  });
});

// ── integration (real DB) ──
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
let tenantId = 0n;
const scoped = <T>(fn: (db: ScopedDb) => Promise<T>) =>
  runScopedOn(appDb, { tenantId, userId: null, role: "TENANT_ADMIN" }, fn);

describe.skipIf(!dbUp)("emitOutbound", () => {
  beforeAll(async () => {
    if (!su) return;
    const t = await su.tenant.create({
      data: { name: "WH", slug: `wh-${process.pid}` },
    });
    tenantId = t.id;
    await su.webhookSubscription.create({
      data: {
        tenantId,
        url: outboundUrl("/hook"),
        events: ["conversation.created", "conversation.status_changed"],
        enabled: true,
      },
    });
    await su.webhookSubscription.create({
      data: {
        tenantId,
        url: outboundUrl("/disabled"),
        events: ["conversation.created"],
        enabled: false,
      },
    });
  });

  afterAll(async () => {
    if (su && tenantId) {
      await su.$executeRawUnsafe(
        `DELETE FROM outbound_webhook_deliveries WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(
        `DELETE FROM webhook_subscriptions WHERE tenant_id = ${tenantId}`,
      );
      await su.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("enqueues one delivery per enabled subscription that listens", async () => {
    const count = await scoped((db) =>
      emitOutbound(db, tenantId, "conversation.created", {
        conversation_id: "100",
      }),
    );
    expect(count).toBe(1); // only the enabled sub listening for "conversation.created"

    const rows = await scoped((db) =>
      db.outboundWebhookDelivery.findMany({
        where: { event: "conversation.created" },
      }),
    );
    expect(rows.length).toBe(1);
    expect(rows[0]?.status).toBe("PENDING");
    expect(rows[0]?.tenantId).toBe(tenantId);
  });

  test("stores the versioned, sanitized envelope as the delivery payload", async () => {
    await scoped((db) =>
      emitOutbound(db, tenantId, "conversation.status_changed", {
        conversation_id: "200",
        status: "resolved",
        previous_status: "open",
      }),
    );
    const rows = await scoped((db) =>
      db.outboundWebhookDelivery.findMany({
        where: { event: "conversation.status_changed" },
      }),
    );
    expect(rows.length).toBe(1);
    const envelope = rows[0]?.payload as Record<string, unknown>;
    expect(envelope.version).toBe(1);
    expect(envelope.event).toBe("conversation.status_changed");
    expect(envelope.tenant_id).toBe(String(tenantId));
    expect(typeof envelope.instance_id).toBe("string");
    expect(typeof envelope.occurred_at).toBe("string");
    expect(envelope.data).toMatchObject({
      conversation_id: "200",
      status: "resolved",
      previous_status: "open",
    });
    // Allowlist guard: no contact PII fields ever reach the envelope.
    const serialized = JSON.stringify(envelope);
    expect(serialized).not.toContain("phone");
    expect(serialized).not.toContain("email");
  });

  test("emits nothing for an event no subscription listens to", async () => {
    const count = await scoped((db) =>
      emitOutbound(db, tenantId, "kanban.card_moved", {}),
    );
    expect(count).toBe(0);
  });
});
