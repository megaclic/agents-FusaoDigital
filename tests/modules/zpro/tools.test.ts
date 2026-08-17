// tests/modules/zpro/tools.test.ts
// DB-backed: loadZproAgentTools reuses the same generic AgentToolSelection → source-specific
// builder chain the Chatwoot path uses (loadToolSelections + buildToolpackTools/buildRagTools/
// buildHttpTools/loadMcpToolsForAgent/buildNativeTools). Covers each of the 5 grant sources plus
// the always-on utility native tools (calculator/get_current_time), keyed off ZproConversation.id
// as the contactDbId stamp since Z-PRO has no Contact table — see docs/zpro.md. The bottom section
// covers the conversation-scoped NATIVE tools (src/modules/zpro/native-tools.ts), built only when a
// `client` is passed — per-tool behavior is covered in tests/modules/zpro/native-tools.test.ts, this
// file only checks the WIRING (allowlist respected, react_to_message never appears, kanban context
// resolved only when granted).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { resolveBusinessHoursById } from "@/graph/prepare";
import type { ZproClient } from "@/modules/zpro/client";
import { __resetZproCrmCaches } from "@/modules/zpro/crm";
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
        "business_hours",
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

  test("wires resolveBusinessHours: the exact function Chatwoot's buildToolset uses, bound to this tenant", async () => {
    const bh = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Expediente",
        timezone: "America/Sao_Paulo",
        windows: [{ day: 1, start: "09:00", end: "18:00" }],
        source: "LOCAL",
      },
    });

    const resolved = await resolveBusinessHoursById(
      appDb,
      tenantId,
      String(bh.id),
    );
    expect(resolved).toEqual({
      windows: [{ day: 1, start: "09:00", end: "18:00" }],
      timezone: "America/Sao_Paulo",
    });

    // Cross-tenant id must not resolve (RLS fence) — mirrors the "always on" fallback the toolpack
    // relies on for a stale/other-tenant businessHoursId.
    const otherTenant = await suDb.tenant.create({
      data: { name: "Other", slug: `zpro-tools-other-${process.pid}` },
    });
    const otherBh = await suDb.businessHours.create({
      data: {
        tenantId: otherTenant.id,
        name: "Other expediente",
        windows: [],
        source: "LOCAL",
      },
    });
    expect(
      await resolveBusinessHoursById(appDb, tenantId, String(otherBh.id)),
    ).toBeNull();

    await suDb.$executeRawUnsafe(
      `DELETE FROM business_hours WHERE tenant_id = ${otherTenant.id}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = ${otherTenant.id}`,
    );
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

  test("NATIVE: without a client, conversation-scoped native tools are NOT built (utility-only, matches no-grants)", async () => {
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Native no-client agent",
        systemPrompt: "You are a helpful assistant.",
      },
    });
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2001,
        status: "open",
        contactId: 42,
        contactNumber: "5511900000042",
        contactName: "Cliente Nativo",
        agentActive: true,
      },
    });
    // No native selection row ⇒ the permissive default (all tools) would apply IF a client were
    // passed — but none is, so conversation tools stay absent regardless.
    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 2001,
      threadId: `zpro:${tenantId}:${zproInstanceId}:2001`,
    });
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "calculator",
      "get_current_time",
    ]);
  });

  test("NATIVE: with a client + an explicit allowlist, only the granted conversation tools are built (never react_to_message)", async () => {
    __resetZproCrmCaches();
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Native agent",
        systemPrompt: "You are a helpful assistant.",
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "NATIVE",
        enabledTools: [
          "private_note",
          "handoff_to_human",
          "react_to_message",
          "calculator",
        ],
        knowledgeBaseIds: [],
      },
    });
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2002,
        status: "open",
        contactId: 43,
        contactNumber: "5511900000043",
        contactName: "Cliente Nativo 2",
        agentActive: true,
      },
    });
    const client = {} as ZproClient;

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 2002,
      threadId: `zpro:${tenantId}:${zproInstanceId}:2002`,
      client,
      contactName: "Cliente Nativo 2",
      contactNumber: "5511900000043",
    });
    expect(result.conversationId).toBe(conv.id);
    expect(result.tools.map((t) => t.name).sort()).toEqual([
      "calculator",
      "handoff_to_human",
      "private_note",
    ]);
  });

  test("NATIVE: kanban_move_card granted resolves the CRM pipeline context; when omitted, it is skipped (no extra network call)", async () => {
    __resetZproCrmCaches();
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Native kanban agent",
        systemPrompt: "You are a helpful assistant.",
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "NATIVE",
        enabledTools: ["kanban_move_card"],
        knowledgeBaseIds: [],
      },
    });
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2003,
        status: "open",
        contactId: 44,
        contactNumber: "5511900000044",
        contactName: "Cliente Kanban",
        agentActive: true,
      },
    });
    let pipelinesCalled = 0;
    const client = {
      listPipelines: async () => {
        pipelinesCalled++;
        return [{ id: 16, name: "Vendas" }];
      },
      listStages: async () => [{ id: 1, name: "Novo" }],
    } as unknown as ZproClient;

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 2003,
      threadId: `zpro:${tenantId}:${zproInstanceId}:2003`,
      client,
    });
    expect(result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["kanban_move_card"]),
    );
    const moveTool = result.tools.find((t) => t.name === "kanban_move_card");
    expect(moveTool?.description).toContain("Vendas");
    expect(pipelinesCalled).toBe(1);
  });

  test("NATIVE: kanban pipeline resolution failure preserves the CONFIGURED pipelineId instead of nulling it", async () => {
    __resetZproCrmCaches();
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Native kanban agent (pipeline throws)",
        systemPrompt: "You are a helpful assistant.",
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "NATIVE",
        enabledTools: ["kanban_move_card"],
        knowledgeBaseIds: [],
      },
    });
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2004,
        status: "open",
        contactId: 45,
        contactNumber: "5511900000045",
        contactName: "Cliente Kanban Falho",
        agentActive: true,
      },
    });
    // client.listPipelines THROWS (not just "returns a list missing the id") — the case
    // resolveZproPipelineId's own doc comment (crm.ts) promises is safe, but only tools.ts's outer
    // catch actually controls what happens to params.pipelineId when the call itself fails.
    const client = {
      listPipelines: async () => {
        throw new Error("network blip");
      },
    } as unknown as ZproClient;

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 2004,
      threadId: `zpro:${tenantId}:${zproInstanceId}:2004`,
      client,
      pipelineId: 16, // explicitly configured — must survive the throw, not become null
    });
    const moveTool = result.tools.find((t) => t.name === "kanban_move_card");
    expect(moveTool?.description).not.toContain(
      "no CRM pipeline is configured",
    );
    const out = await moveTool?.invoke({ targetStep: "Fechado" });
    // Configured-but-unresolved degrades to "unknown stage" (an empty stage list), NOT the
    // "no CRM pipeline is configured" message a nulled pipelineId would have produced.
    expect(String(out)).toContain("Unknown stage");
    expect(String(out)).not.toContain("no CRM pipeline is configured");
  });

  test("NATIVE: route_to_queue granted resolves the known-queues list; when omitted, it is skipped (no extra network call)", async () => {
    __resetZproCrmCaches();
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Native queue agent",
        systemPrompt: "You are a helpful assistant.",
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "NATIVE",
        enabledTools: ["route_to_queue"],
        knowledgeBaseIds: [],
      },
    });
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2005,
        status: "open",
        contactId: 46,
        contactNumber: "5511900000046",
        contactName: "Cliente Fila",
        agentActive: true,
      },
    });
    let queuesCalled = 0;
    const client = {
      listQueues: async () => {
        queuesCalled++;
        return [{ id: 9, queue: "Financeiro" }];
      },
    } as unknown as ZproClient;

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 2005,
      threadId: `zpro:${tenantId}:${zproInstanceId}:2005`,
      client,
    });
    const queueTool = result.tools.find((t) => t.name === "route_to_queue");
    expect(queueTool?.description).toContain("Financeiro");
    expect(queuesCalled).toBe(1);
  });

  test("NATIVE: get_contact_info resolves the CURRENT queue/tags from the mirror against the catalogs, plus extraInfo from the event", async () => {
    __resetZproCrmCaches();
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Native contact-info agent",
        systemPrompt: "You are a helpful assistant.",
      },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agent.id,
        source: "NATIVE",
        enabledTools: ["get_contact_info"],
        knowledgeBaseIds: [],
      },
    });
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2006,
        status: "open",
        contactId: 47,
        contactNumber: "5511900000047",
        contactName: "Cliente Info",
        agentActive: true,
        queueId: 9,
        contactTags: [{ id: 3, name: "vip" }],
      },
    });
    const client = {
      listQueues: async () => [{ id: 9, queue: "Financeiro" }],
      listTags: async () => [{ id: 3, tag: "vip" }],
    } as unknown as ZproClient;

    const result = await loadZproAgentTools({
      base: appDb,
      tenantId,
      agentId: agent.id,
      zproInstanceId,
      ticketId: 2006,
      threadId: `zpro:${tenantId}:${zproInstanceId}:2006`,
      client,
      contactExtraInfo: [{ name: "orcamento", value: "5000" }],
    });
    const infoTool = result.tools.find((t) => t.name === "get_contact_info");
    const out = String(await infoTool?.invoke({}));
    expect(out).toContain("Queue: Financeiro");
    expect(out).toContain("Tags: vip");
    expect(out).toContain("orcamento: 5000");
  });
});
