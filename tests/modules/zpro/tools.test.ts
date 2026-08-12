// tests/modules/zpro/tools.test.ts
// DB-backed: loadZproAgentTools reuses the same generic AgentToolSelection → source-specific
// builder chain the Chatwoot path uses (loadToolSelections + buildToolpackTools/buildRagTools/
// buildHttpTools/loadMcpToolsForAgent/buildNativeTools). Covers each of the 5 grant sources plus
// the always-on utility native tools (calculator/get_current_time), keyed off ZproConversation.id
// as the contactDbId stamp since Z-PRO has no Contact table — see docs/zpro.md.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadZproAgentTools } from "@/modules/zpro/tools";

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

describe.skipIf(!dbUp)("loadZproAgentTools", () => {
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
        "tool_definitions",
        "knowledge_bases",
        "mcp_server_connections",
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

  test("with no grants, only the always-on utility tools (calculator, get_current_time) are present", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "No grants agent",
        systemPrompt: "You are a helpful assistant.",
      },
    });

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 1001,
      threadId: `zpro:${tenantId}:${zproInstanceId}:1001`,
    });
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "calculator",
      "get_current_time",
    ]);
    expect(result.grounded).toBe(false);
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

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 1002,
      threadId: `zpro:${tenantId}:${zproInstanceId}:1002`,
    });

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
    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 9999,
      threadId: `zpro:${tenantId}:${zproInstanceId}:9999`,
    });
    expect(result.tools.map((t) => t.name)).toContain("calendar_create_event");
    expect(result.conversationId).toBeNull();
  });

  test("RAG: a granted search_knowledge exposes the tool and sets grounded=true", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "RAG agent",
        systemPrompt: "You are a support assistant.",
      },
    });
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "Docs" },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "RAG",
        enabledTools: ["search_knowledge"],
        knowledgeBaseIds: [kb.id],
      },
    });

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 1003,
      threadId: `zpro:${tenantId}:${zproInstanceId}:1003`,
    });
    expect(result.tools.map((t) => t.name)).toContain("search_knowledge");
    expect(result.grounded).toBe(true);
  });

  test("HTTP: a granted custom tool is exposed", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "HTTP agent",
        systemPrompt: "You are a support assistant.",
      },
    });
    const td = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: "lookup_price",
        label: "Lookup price",
        urlTemplate: "https://api.example.com/price",
        allowedHosts: ["api.example.com"],
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "HTTP",
        toolDefinitionId: td.id,
        enabledTools: [],
        knowledgeBaseIds: [],
      },
    });

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 1004,
      threadId: `zpro:${tenantId}:${zproInstanceId}:1004`,
    });
    expect(result.tools.map((t) => t.name)).toContain("lookup_price");
  });

  test("MCP: a connection that fails discovery degrades gracefully (no crash, no tools added)", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "MCP agent",
        systemPrompt: "You are a support assistant.",
      },
    });
    const conn = await suDb.mcpServerConnection.create({
      data: {
        tenantId,
        name: "Unreachable",
        transport: "streamableHttp",
        url: "https://127.0.0.1:1/mcp", // nothing listens here
        enabled: true,
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "MCP",
        mcpServerConnectionId: conn.id,
        enabledTools: ["whatever"],
        knowledgeBaseIds: [],
      },
    });

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 1005,
      threadId: `zpro:${tenantId}:${zproInstanceId}:1005`,
    });
    // The unreachable server contributes nothing, but the utility tools still come through.
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "calculator",
      "get_current_time",
    ]);
  });
});
