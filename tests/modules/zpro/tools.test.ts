// tests/modules/zpro/tools.test.ts
// DB-backed: loadZproIntegrationTools reuses the same generic AgentToolSelection → IntegrationInstance
// → toolpack chain the Chatwoot path uses. Covers the two states an operator will actually hit: an
// agent with no INTEGRATION grant (the common case today, must short-circuit to []) and an agent
// granted the Google Calendar toolpack (must resolve the real tool, keyed off ZproConversation.id as
// the contactDbId stamp since Z-PRO has no Contact table — see docs/zpro.md).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadZproIntegrationTools } from "@/modules/zpro/tools";

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

describe.skipIf(!dbUp)("loadZproIntegrationTools", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproTools", slug: `zpro-tools-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 88,
        instanceName: "ZproToolsInstance",
      },
    });
    zproInstanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "agent_tool_selections",
        "integration_instances",
        "zpro_conversations",
        "zpro_agent_bindings",
        "zpro_instances",
        "agents",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("returns [] when the agent has no INTEGRATION grant", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "No grants agent",
        systemPrompt: "You are a helpful assistant.",
      },
    });

    const result = await loadZproIntegrationTools(
      appDb,
      tenantId,
      agent.id,
      zproInstanceId,
      1001,
      `zpro:${tenantId}:${zproInstanceId}:1001`,
    );
    expect(result.tools).toEqual([]);
  });

  test("resolves the granted Google Calendar tool, stamped with the ZproConversation as contactDbId", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Calendar agent",
        systemPrompt: "You are a scheduling assistant.",
      },
    });
    const integration = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "GOOGLE_CALENDAR",
        name: "Google Calendar",
        enabled: true,
        config: { timeZone: "America/Sao_Paulo", calendarIds: ["primary"] },
        credentialRef: "vault:0", // never resolved in this test — build-time only, no invoke
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "INTEGRATION",
        integrationInstanceId: integration.id,
        enabledTools: ["calendar_create_event"],
        knowledgeBaseIds: [],
      },
    });
    const conversation = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 1002,
        status: "open",
        contactId: 555,
        contactNumber: "5511999999999",
        contactName: "Cliente Teste",
        agentActive: true,
      },
    });

    const result = await loadZproIntegrationTools(
      appDb,
      tenantId,
      agent.id,
      zproInstanceId,
      1002,
      `zpro:${tenantId}:${zproInstanceId}:1002`,
    );

    expect(result.tools.map((t) => t.name)).toContain("calendar_create_event");
    expect(result.conversationId).toBe(conversation.id);
  });

  test("still resolves the tool for a ticket with no matching ZproConversation (no crash on the lookup miss)", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Orphan ticket agent",
        systemPrompt: "You are a scheduling assistant.",
      },
    });
    const integration = await suDb.integrationInstance.create({
      data: {
        tenantId,
        catalogType: "GOOGLE_CALENDAR",
        name: "Google Calendar 2",
        enabled: true,
        config: { timeZone: "America/Sao_Paulo", calendarIds: ["primary"] },
        credentialRef: "vault:0",
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "INTEGRATION",
        integrationInstanceId: integration.id,
        enabledTools: ["calendar_create_event"],
        knowledgeBaseIds: [],
      },
    });

    // No ZproConversation seeded for ticketId 9999 — the tool must still build (contactDbId: null),
    // not throw. The tool itself fails closed (NO_CONTACT) only when actually invoked.
    const result = await loadZproIntegrationTools(
      appDb,
      tenantId,
      agent.id,
      zproInstanceId,
      9999,
      `zpro:${tenantId}:${zproInstanceId}:9999`,
    );
    expect(result.tools.map((t) => t.name)).toContain("calendar_create_event");
    expect(result.conversationId).toBeNull();
  });
});
