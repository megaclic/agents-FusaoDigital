// tests/modules/zpro/analytics.test.ts
// DB-backed: getZproFunnelMetrics powers the "FusaoChatBot CRM" Dashboard section. Covers the
// pre-existing conversation-state counts plus the AI-usage fields added for token/call parity
// (promptTokens/completionTokens/calls, sourced from LlmUsage.zproConversationId). Also asserts a
// same-tenant Chatwoot LlmUsage row (conversationId set, zproConversationId null) never leaks into
// the Z-PRO figures — the collision risk the zproConversationId column was added to avoid.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { TenantContext } from "@/lib/tenancy";
import { runScopedOn } from "@/lib/tenancy";
import { getZproFunnelMetrics } from "@/modules/zpro/analytics";

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
let zproInstanceId = 0n;
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("getZproFunnelMetrics", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproAnalytics", slug: `zpro-analytics-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 90,
        instanceName: "ZproAnalyticsInstance",
      },
    });
    zproInstanceId = inst.id;

    // Three conversations: one agent-handled+open, one human-escalated, one closed (resolved).
    const [open, escalated, closed] = await Promise.all([
      suDb.zproConversation.create({
        data: {
          tenantId,
          zproInstanceId,
          ticketId: 1,
          status: "open",
          contactId: 1,
          contactNumber: "5511900000001",
          contactName: "Aberto",
          agentActive: true,
        },
      }),
      suDb.zproConversation.create({
        data: {
          tenantId,
          zproInstanceId,
          ticketId: 2,
          status: "pending",
          contactId: 2,
          contactNumber: "5511900000002",
          contactName: "Escalado",
          agentActive: false,
          humanUserId: 42,
        },
      }),
      suDb.zproConversation.create({
        data: {
          tenantId,
          zproInstanceId,
          ticketId: 3,
          status: "closed",
          contactId: 3,
          contactNumber: "5511900000003",
          contactName: "Fechado",
          agentActive: true,
        },
      }),
    ]);

    // Z-PRO LLM usage: two "inbox" calls (must be summed) + one "playground" call (must be
    // excluded, same convention as the Chatwoot funnel/KPIs).
    await suDb.llmUsage.createMany({
      data: [
        {
          tenantId,
          zproConversationId: open.id,
          source: "inbox",
          model: "gpt-4o-mini",
          promptTokens: 100,
          completionTokens: 40,
        },
        {
          tenantId,
          zproConversationId: closed.id,
          source: "inbox",
          model: "gpt-4o-mini",
          promptTokens: 30,
          completionTokens: 10,
        },
        {
          tenantId,
          zproConversationId: open.id,
          source: "playground",
          model: "gpt-4o-mini",
          promptTokens: 999,
          completionTokens: 999,
        },
      ],
    });

    // A same-tenant CHATWOOT usage row (conversationId set, zproConversationId null) — must never
    // be counted toward the Z-PRO funnel's usage figures (the id-collision risk zproConversationId
    // was introduced to avoid: Conversation.id and ZproConversation.id are independent sequences).
    await suDb.llmUsage.create({
      data: {
        tenantId,
        conversationId: escalated.id, // same numeric id as a Z-PRO conversation, different table
        source: "inbox",
        model: "gpt-4o-mini",
        promptTokens: 5000,
        completionTokens: 5000,
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "llm_usage",
        "zpro_conversations",
        "zpro_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("counts conversation states and sums real (inbox) AI usage, isolated from Chatwoot usage on the same tenant", async () => {
    const since = new Date(Date.now() - 60_000);
    const m = await runScopedOn(appDb, ctx(tenantId), (db) =>
      getZproFunnelMetrics(db, since),
    );
    expect(m.conversations).toBe(3);
    expect(m.agentHandled).toBe(2);
    expect(m.humanEscalated).toBe(1);
    expect(m.resolved).toBe(1);
    // Only the two "inbox" Z-PRO rows: 100+30 / 40+10. The playground row and the Chatwoot row
    // (conversationId-keyed, same numeric id as a Z-PRO conversation) are both excluded.
    expect(m.calls).toBe(2);
    expect(m.promptTokens).toBe(130);
    expect(m.completionTokens).toBe(50);
  });

  test("the `since` filter excludes older usage and conversations", async () => {
    const future = new Date(Date.now() + 60_000);
    const m = await runScopedOn(appDb, ctx(tenantId), (db) =>
      getZproFunnelMetrics(db, future),
    );
    expect(m.conversations).toBe(0);
    expect(m.calls).toBe(0);
    expect(m.promptTokens).toBe(0);
  });
});
