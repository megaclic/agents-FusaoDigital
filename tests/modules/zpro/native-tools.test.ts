// tests/modules/zpro/native-tools.test.ts
// buildZproNativeTools: the Z-PRO-specific implementation of the 8 conversation-scoped NATIVE tools
// (handoff/note/attribute/label/resolve/funnel-move/funnel-update/skip), backed by ZproClient in
// place of Chatwoot's client (src/graph/tools/native.ts). Most tools here never touch the DB
// (they call the Z-PRO API only) so those cases run with a duck-typed ZproClient stub, no network/DB
// — same pattern as tests/modules/zpro/split.test.ts. kanban_move_card/update_kanban_task DO persist
// a snapshot onto ZproConversation, so those run DB-backed, mirroring tests/modules/zpro/tts.test.ts.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ZproClient } from "@/modules/zpro/client";
import { __resetZproCrmCaches } from "@/modules/zpro/crm";
import {
  buildZproNativeTools,
  type ZproToolCtx,
} from "@/modules/zpro/native-tools";

function baseCtx(overrides: Partial<ZproToolCtx> = {}): ZproToolCtx {
  return {
    client: {} as ZproClient,
    ticketId: 42,
    contactId: 7,
    contactNumber: "5511900000001",
    contactName: "Cliente Teste",
    tenantId: 1n,
    base: {} as PrismaClient,
    conversationDbId: 1n,
    ...overrides,
  };
}

describe("buildZproNativeTools (no client/DB access)", () => {
  test("returns all 10 tools when unfiltered, and NEVER react_to_message", () => {
    const tools = buildZproNativeTools(baseCtx());
    expect(tools.map((t) => t.name).sort()).toEqual([
      "assign_label",
      "handoff_to_human",
      "kanban_move_card",
      "private_note",
      "resolve_conversation",
      "route_to_queue",
      "schedule_message",
      "set_custom_attribute",
      "skip_reply",
      "update_kanban_task",
    ]);
  });

  test("respects an explicit allowlist (fail-closed)", () => {
    const tools = buildZproNativeTools(baseCtx(), [
      "private_note",
      "skip_reply",
    ]);
    expect(tools.map((t) => t.name).sort()).toEqual([
      "private_note",
      "skip_reply",
    ]);
  });

  test("an allowlist naming react_to_message still never builds it (no analog exists)", () => {
    const tools = buildZproNativeTools(baseCtx(), [
      "react_to_message",
      "skip_reply",
    ]);
    expect(tools.map((t) => t.name)).toEqual(["skip_reply"]);
  });

  test("skip_reply never touches the client", async () => {
    const tools = buildZproNativeTools(baseCtx(), ["skip_reply"]);
    const out = await tools[0]?.invoke({ reason: "só um ok" });
    expect(String(out)).toContain("not replying");
  });

  test("private_note calls createNote and returns a human-only confirmation", async () => {
    const calls: unknown[] = [];
    const client = {
      createNote: async (ticketId: number, notes: string) => {
        calls.push({ ticketId, notes });
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(baseCtx({ client }), ["private_note"]);
    const out = await tools[0]?.invoke({ content: "cliente pediu desconto" });
    expect(calls).toEqual([{ ticketId: 42, notes: "cliente pediu desconto" }]);
    expect(String(out)).toContain("Private note posted");
  });

  test("handoff_to_human: sends the customer message, posts a note (transferWithSummary on), and deactivates the agent", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      sendText: async (number: string, body: string) => {
        calls.push(["sendText", { number, body }]);
        return {};
      },
      createNote: async (ticketId: number, notes: string) => {
        calls.push(["createNote", { ticketId, notes }]);
        return {};
      },
      updateTicketInfo: async (ticketId: number, patch: unknown) => {
        calls.push(["updateTicketInfo", { ticketId, patch }]);
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(
      baseCtx({ client, transferWithSummary: true }),
      ["handoff_to_human"],
    );
    const out = await tools[0]?.invoke({
      reason: "cliente quer negociar",
      customerMessage: "Já te transfiro para um atendente.",
    });
    expect(calls.map((c) => c[0])).toEqual([
      "sendText",
      "createNote",
      "updateTicketInfo",
    ]);
    expect(calls[2]?.[1]).toMatchObject({
      ticketId: 42,
      patch: { n8nStatus: false },
    });
    expect(String(out)).toContain("Handed off to a human");
  });

  test("handoff_to_human: transferWithSummary=false skips the note", async () => {
    const calls: string[] = [];
    const client = {
      sendText: async () => {
        calls.push("sendText");
        return {};
      },
      createNote: async () => {
        calls.push("createNote");
        return {};
      },
      updateTicketInfo: async () => {
        calls.push("updateTicketInfo");
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(
      baseCtx({ client, transferWithSummary: false }),
      ["handoff_to_human"],
    );
    await tools[0]?.invoke({ reason: "motivo" });
    expect(calls).toEqual(["updateTicketInfo"]);
  });

  test("resolve_conversation: immediate mode (no turnState) calls deactivateAgent with closeTicket", async () => {
    const calls: unknown[] = [];
    const client = {
      updateTicketInfo: async (ticketId: number, patch: unknown) => {
        calls.push({ ticketId, patch });
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(baseCtx({ client }), [
      "resolve_conversation",
    ]);
    const out = await tools[0]?.invoke({});
    expect(calls).toEqual([
      { ticketId: 42, patch: { n8nStatus: false, status: "closed" } },
    ]);
    expect(String(out)).toBe("Conversation resolved.");
  });

  test("resolve_conversation: deferred mode (turnState present) only records the intent", async () => {
    const calls: unknown[] = [];
    const client = {
      updateTicketInfo: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    } as unknown as ZproClient;
    const turnState = { resolveRequested: false };
    const tools = buildZproNativeTools(baseCtx({ client, turnState }), [
      "resolve_conversation",
    ]);
    const out = await tools[0]?.invoke({});
    expect(calls).toEqual([]);
    expect(turnState.resolveRequested).toBe(true);
    expect(String(out)).toContain("Resolve scheduled");
  });

  test("set_custom_attribute: read-merge-writes the contact's extraInfo array", async () => {
    const calls: unknown[] = [];
    const client = {
      getContactExtraInfo: async () => [
        { name: "estagio", value: "qualificado" },
      ],
      updateContactExtraInfo: async (contactId: number, extraInfo: unknown) => {
        calls.push({ contactId, extraInfo });
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(baseCtx({ client }), [
      "set_custom_attribute",
    ]);
    const out = await tools[0]?.invoke({ key: "orcamento", value: "5000" });
    expect(calls).toEqual([
      {
        contactId: 7,
        extraInfo: [
          { name: "estagio", value: "qualificado" },
          { name: "orcamento", value: "5000" },
        ],
      },
    ]);
    expect(String(out)).toContain("orcamento set");
  });

  test("set_custom_attribute: overwrites an existing key instead of duplicating it", async () => {
    const client = {
      getContactExtraInfo: async () => [{ name: "orcamento", value: "1000" }],
      updateContactExtraInfo: async (
        _contactId: number,
        extraInfo: Array<{ name: string; value: string }>,
      ) => {
        expect(extraInfo).toEqual([{ name: "orcamento", value: "9000" }]);
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(baseCtx({ client }), [
      "set_custom_attribute",
    ]);
    await tools[0]?.invoke({ key: "orcamento", value: "9000" });
  });

  test("set_custom_attribute: fails CLOSED on a read failure — never overwrites with a partial array", async () => {
    let writeCalled = false;
    const client = {
      getContactExtraInfo: async () => {
        throw new Error("transient 500");
      },
      updateContactExtraInfo: async () => {
        writeCalled = true;
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(baseCtx({ client }), [
      "set_custom_attribute",
    ]);
    const out = await tools[0]?.invoke({ key: "orcamento", value: "9000" });
    expect(writeCalled).toBe(false);
    expect(String(out).toLowerCase()).toContain("failed to read");
  });

  test("assign_label: reuses a known tag id (no createTag call)", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      createTag: async () => {
        calls.push(["createTag", null]);
        return { id: 999 };
      },
      addTag: async (ticketId: number, tagId: number) => {
        calls.push(["addTag", { ticketId, tagId }]);
        return {};
      },
      addTagContact: async (contactId: number, tagId: number) => {
        calls.push(["addTagContact", { contactId, tagId }]);
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(
      baseCtx({ client, knownTags: [{ id: 3, name: "vip" }] }),
      ["assign_label"],
    );
    const out = await tools[0]?.invoke({ label: "VIP" });
    expect(calls).toEqual([["addTag", { ticketId: 42, tagId: 3 }]]);
    expect(String(out)).toContain("added to the conversation");
  });

  test("assign_label: an unknown label auto-creates the tag, then applies it", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      createTag: async (tag: string, color: string, isActive: boolean) => {
        calls.push(["createTag", { tag, color, isActive }]);
        return { id: 77 };
      },
      addTag: async (ticketId: number, tagId: number) => {
        calls.push(["addTag", { ticketId, tagId }]);
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(baseCtx({ client, knownTags: [] }), [
      "assign_label",
    ]);
    await tools[0]?.invoke({ label: "urgente" });
    expect(calls[0]?.[0]).toBe("createTag");
    expect(calls[1]).toEqual(["addTag", { ticketId: 42, tagId: 77 }]);
  });

  test("assign_label: scope='contact' calls addTagContact instead of addTag", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      addTagContact: async (contactId: number, tagId: number) => {
        calls.push(["addTagContact", { contactId, tagId }]);
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(
      baseCtx({ client, knownTags: [{ id: 5, name: "lead" }] }),
      ["assign_label"],
    );
    const out = await tools[0]?.invoke({ label: "lead", scope: "contact" });
    expect(calls).toEqual([["addTagContact", { contactId: 7, tagId: 5 }]]);
    expect(String(out)).toContain("added to the contact");
  });

  test("route_to_queue: routes to a known queue by case-insensitive name match", async () => {
    const calls: unknown[] = [];
    const client = {
      updateQueue: async (ticketId: number, queueId: number) => {
        calls.push({ ticketId, queueId });
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(
      baseCtx({ client, knownQueues: [{ id: 5, name: "Suporte" }] }),
      ["route_to_queue"],
    );
    const out = await tools[0]?.invoke({ queue: "suporte" });
    expect(calls).toEqual([{ ticketId: 42, queueId: 5 }]);
    expect(String(out)).toContain('Routed to the "Suporte" queue');
  });

  test("route_to_queue: fails CLOSED on an unknown queue name — no auto-create, unlike assign_label", async () => {
    let called = false;
    const client = {
      updateQueue: async () => {
        called = true;
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(
      baseCtx({ client, knownQueues: [{ id: 5, name: "Suporte" }] }),
      ["route_to_queue"],
    );
    const out = await tools[0]?.invoke({ queue: "Financeiro" });
    expect(called).toBe(false);
    expect(String(out)).toContain('Queue "Financeiro" not found');
    expect(String(out)).toContain("Suporte");
  });

  test("route_to_queue: no queues configured reports it instead of attempting the call", async () => {
    let called = false;
    const client = {
      updateQueue: async () => {
        called = true;
        return {};
      },
    } as unknown as ZproClient;
    const tools = buildZproNativeTools(baseCtx({ client, knownQueues: [] }), [
      "route_to_queue",
    ]);
    const out = await tools[0]?.invoke({ queue: "Suporte" });
    expect(called).toBe(false);
    expect(String(out)).toContain("No queues are configured");
  });

  test("kanban_move_card / update_kanban_task report 'not configured' when no pipeline is resolved", async () => {
    const tools = buildZproNativeTools(baseCtx({ kanban: undefined }), [
      "kanban_move_card",
      "update_kanban_task",
    ]);
    const move = await tools
      .find((t) => t.name === "kanban_move_card")
      ?.invoke({ targetStep: "Proposta" });
    const update = await tools
      .find((t) => t.name === "update_kanban_task")
      ?.invoke({ title: "Novo título" });
    expect(String(move)).toContain("No CRM pipeline is configured");
    expect(String(update)).toContain("No CRM pipeline is configured");
  });

  test("kanban_move_card: an unknown stage name lists the valid ones", async () => {
    const tools = buildZproNativeTools(
      baseCtx({
        kanban: {
          pipelineId: 16,
          pipelineName: "Vendas",
          stages: [
            { id: 1, name: "Novo" },
            { id: 2, name: "Proposta" },
          ],
          opportunityId: 30,
          opportunityTitle: "Deal",
          currentStageId: 1,
          currentStageName: "Novo",
        },
      }),
      ["kanban_move_card"],
    );
    const out = await tools[0]?.invoke({ targetStep: "Fechado" });
    expect(String(out)).toContain("Unknown stage");
    expect(String(out)).toContain("Novo, Proposta");
  });

  test("kanban_move_card: already in the target stage is a no-op", async () => {
    const tools = buildZproNativeTools(
      baseCtx({
        kanban: {
          pipelineId: 16,
          pipelineName: "Vendas",
          stages: [{ id: 1, name: "Novo" }],
          opportunityId: 30,
          opportunityTitle: "Deal",
          currentStageId: 1,
          currentStageName: "Novo",
        },
      }),
      ["kanban_move_card"],
    );
    const out = await tools[0]?.invoke({ targetStep: "novo" });
    expect(String(out)).toContain("already in");
  });
});

// ── DB-backed: kanban_move_card / update_kanban_task persist the Opportunity snapshot ──────────

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
let conversationId = 0n;

describe.skipIf(!dbUp)(
  "kanban_move_card / update_kanban_task (Opportunity upsert) + schedule_message",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: {
          name: "ZproNativeTools",
          slug: `zpro-native-tools-${process.pid}`,
        },
      });
      tenantId = t.id;
      const inst = await suDb.zproInstance.create({
        data: {
          tenantId,
          baseUrl: "https://api.fusaobotcrm.com.br",
          apiId: "TEST_API_ID",
          bearerToken: encryptJson("test-token"),
          whatsappId: 92,
          instanceName: "ZproNativeToolsInstance",
        },
      });
      zproInstanceId = inst.id;
    });

    beforeEach(async () => {
      __resetZproCrmCaches();
      const conv = await suDb.zproConversation.create({
        data: {
          tenantId,
          zproInstanceId,
          ticketId: Math.floor(Math.random() * 1_000_000),
          status: "open",
          contactId: 7,
          contactNumber: "5511900000001",
          contactName: "Cliente Teste",
          agentActive: true,
        },
      });
      conversationId = conv.id;
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of ["zpro_conversations", "zpro_instances"]) {
          await suDb.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          );
        }
        await suDb.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await su?.$disconnect();
      await app?.$disconnect();
    });

    test("kanban_move_card creates an Opportunity on first use and persists the snapshot", async () => {
      const calls: Array<[string, unknown]> = [];
      const client = {
        createOpportunity: async (data: unknown) => {
          calls.push(["createOpportunity", data]);
          return { id: 501 };
        },
      } as unknown as ZproClient;
      const tools = buildZproNativeTools(
        {
          client,
          ticketId: 1,
          contactId: 7,
          contactNumber: "5511900000001",
          contactName: "Cliente Teste",
          tenantId,
          base: appDb,
          conversationDbId: conversationId,
          kanban: {
            pipelineId: 16,
            pipelineName: "Vendas",
            stages: [
              { id: 1, name: "Novo" },
              { id: 2, name: "Proposta" },
            ],
            opportunityId: null,
            opportunityTitle: null,
            currentStageId: null,
            currentStageName: null,
          },
        },
        ["kanban_move_card"],
      );
      const out = await tools[0]?.invoke({ targetStep: "Proposta" });
      expect(String(out)).toContain('Moved the deal to "Proposta"');
      expect(calls[0]?.[1]).toMatchObject({
        number: "5511900000001",
        pipelineId: 16,
        stageId: 2,
      });
      const row = await suDb.zproConversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: {
          opportunityId: true,
          opportunityPipelineId: true,
          opportunityStageId: true,
          opportunityStageName: true,
        },
      });
      expect(row).toEqual({
        opportunityId: 501,
        opportunityPipelineId: 16,
        opportunityStageId: 2,
        opportunityStageName: "Proposta",
      });
    });

    test("kanban_move_card updates an EXISTING linked Opportunity instead of creating a new one", async () => {
      await suDb.zproConversation.update({
        where: { id: conversationId },
        data: {
          opportunityId: 900,
          opportunityPipelineId: 16,
          opportunityStageId: 1,
          opportunityStageName: "Novo",
          opportunityTitle: "Deal existente",
        },
      });
      const calls: Array<[string, unknown]> = [];
      const client = {
        updateOpportunity: async (opportunityId: number, data: unknown) => {
          calls.push([
            "updateOpportunity",
            { opportunityId, ...(data as object) },
          ]);
          return {};
        },
      } as unknown as ZproClient;
      const tools = buildZproNativeTools(
        {
          client,
          ticketId: 1,
          contactId: 7,
          contactNumber: "5511900000001",
          contactName: "Cliente Teste",
          tenantId,
          base: appDb,
          conversationDbId: conversationId,
          kanban: {
            pipelineId: 16,
            pipelineName: "Vendas",
            stages: [
              { id: 1, name: "Novo" },
              { id: 2, name: "Proposta" },
            ],
            opportunityId: 900,
            opportunityTitle: "Deal existente",
            currentStageId: 1,
            currentStageName: "Novo",
          },
        },
        ["kanban_move_card"],
      );
      await tools[0]?.invoke({ targetStep: "Proposta" });
      expect(calls).toEqual([
        [
          "updateOpportunity",
          {
            opportunityId: 900,
            name: "Deal existente",
            pipelineId: 16,
            stageId: 2,
            status: undefined,
            value: undefined,
            description: undefined,
            closingForecast: undefined,
          },
        ],
      ]);
      const row = await suDb.zproConversation.findUniqueOrThrow({
        where: { id: conversationId },
        select: { opportunityStageId: true, opportunityStageName: true },
      });
      expect(row).toEqual({
        opportunityStageId: 2,
        opportunityStageName: "Proposta",
      });
    });

    test("update_kanban_task patches fields on the existing Opportunity, keeping the title if unset", async () => {
      await suDb.zproConversation.update({
        where: { id: conversationId },
        data: {
          opportunityId: 900,
          opportunityPipelineId: 16,
          opportunityStageId: 1,
          opportunityStageName: "Novo",
          opportunityTitle: "Deal existente",
        },
      });
      const calls: unknown[] = [];
      const client = {
        updateOpportunity: async (opportunityId: number, data: unknown) => {
          calls.push({ opportunityId, ...(data as object) });
          return {};
        },
      } as unknown as ZproClient;
      const tools = buildZproNativeTools(
        {
          client,
          ticketId: 1,
          contactId: 7,
          contactNumber: "5511900000001",
          contactName: "Cliente Teste",
          tenantId,
          base: appDb,
          conversationDbId: conversationId,
          kanban: {
            pipelineId: 16,
            pipelineName: "Vendas",
            stages: [{ id: 1, name: "Novo" }],
            opportunityId: 900,
            opportunityTitle: "Deal existente",
            currentStageId: 1,
            currentStageName: "Novo",
          },
        },
        ["update_kanban_task"],
      );
      const out = await tools[0]?.invoke({ value: 5000, status: "win" });
      expect(String(out)).toContain("Updated the deal");
      expect(calls).toEqual([
        {
          opportunityId: 900,
          name: "Deal existente",
          pipelineId: 16,
          stageId: 1,
          status: "win",
          value: 5000,
          description: undefined,
          closingForecast: undefined,
        },
      ]);
    });

    test("update_kanban_task with no fields provided is a clear no-op", async () => {
      const tools = buildZproNativeTools(
        {
          client: {} as ZproClient,
          ticketId: 1,
          contactId: 7,
          contactNumber: "5511900000001",
          contactName: "Cliente Teste",
          tenantId,
          base: appDb,
          conversationDbId: conversationId,
          kanban: {
            pipelineId: 16,
            pipelineName: "Vendas",
            stages: [{ id: 1, name: "Novo" }],
            opportunityId: null,
            opportunityTitle: null,
            currentStageId: null,
            currentStageName: null,
          },
        },
        ["update_kanban_task"],
      );
      const out = await tools[0]?.invoke({});
      expect(String(out)).toContain("No fields provided");
    });

    test("schedule_message enqueues a SCHEDULED_MESSAGE job with runAt = now + delayMinutes", async () => {
      const threadId = `zpro:${tenantId}:${zproInstanceId}:1`;
      const tools = buildZproNativeTools(
        {
          client: {} as ZproClient,
          ticketId: 1,
          threadId,
          contactId: 7,
          contactNumber: "5511900000001",
          contactName: "Cliente Teste",
          tenantId,
          base: appDb,
          conversationDbId: conversationId,
        },
        ["schedule_message"],
      );
      const before = Date.now();
      const out = await tools[0]?.invoke({
        instructions: "Send a motivational quote and a thumbs-up emoji.",
        delayMinutes: 5,
      });
      expect(String(out)).toContain("Scheduled");
      const row = await suDb.schedulerJob.findFirstOrThrow({
        where: { tenantId, kind: "SCHEDULED_MESSAGE" },
      });
      expect(row.dedupeKey).toContain(threadId);
      expect(row.payload).toMatchObject({
        threadId,
        instructions: "Send a motivational quote and a thumbs-up emoji.",
      });
      const deltaMs = row.runAt.getTime() - before;
      expect(deltaMs).toBeGreaterThan(4 * 60_000);
      expect(deltaMs).toBeLessThan(6 * 60_000);
    });

    test("schedule_message without ctx.threadId reports it instead of throwing", async () => {
      const tools = buildZproNativeTools(
        {
          client: {} as ZproClient,
          ticketId: 1,
          contactId: 7,
          contactNumber: "5511900000001",
          contactName: "Cliente Teste",
          tenantId,
          base: appDb,
          conversationDbId: conversationId,
        },
        ["schedule_message"],
      );
      const out = await tools[0]?.invoke({
        instructions: "x",
        delayMinutes: 5,
      });
      expect(String(out)).toContain("Could not schedule");
    });
  },
);
