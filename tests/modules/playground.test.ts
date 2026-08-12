import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import { MemorySaver } from "@langchain/langgraph";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { loadAgentConfig } from "@/graph/prepare";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  listPlaygroundTools,
  runPlaygroundAudioTurn,
  runPlaygroundFollowup,
  runPlaygroundTurn,
  toPlaygroundInvokeError,
} from "@/modules/playground/service";

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
let agentOk = 0n;
let agentNoKey = 0n;
let agentDisabled = 0n;
let agentTools = 0n;
let agentZpro = 0n;
let llmRef = "";

const REPLY = "Oi! Sou o agente de teste.";
const fakeModel = () => new FakeListChatModel({ responses: [REPLY] });
const deps = () => ({ makeModel: fakeModel, checkpointer: new MemorySaver() });
function ctx(t: bigint): TenantContext {
  return { tenantId: t, userId: null, role: "TENANT_ADMIN" };
}

describe.skipIf(!dbUp)("playground", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "PG", slug: `pg-${process.pid}` },
    });
    tenantId = t.id;
    const mc = (ref: string) => ({
      provider: "openai",
      model: "gpt-4o-mini",
      credentialRef: ref,
    });
    const llmKeyId = (
      await suDb.vaultEntry.create({
        data: { tenantId, name: "llm-key", secret: encryptJson("sk-test") },
        select: { id: true },
      })
    ).id;
    llmRef = `vault:${llmKeyId}`;
    agentOk = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Ok",
          systemPrompt: "x",
          modelConfig: mc(`vault:${llmKeyId}`),
        },
      })
    ).id;
    agentNoKey = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "NoKey",
          systemPrompt: "x",
          modelConfig: mc("vault:999999999"),
        },
      })
    ).id;
    agentDisabled = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Disabled",
          systemPrompt: "x",
          enabled: false,
          modelConfig: mc(`vault:${llmKeyId}`),
        },
      })
    ).id;
    // An agent with a mix of tool sources, to exercise listPlaygroundTools categorization.
    agentTools = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "Tools",
          systemPrompt: "x",
          modelConfig: mc(`vault:${llmKeyId}`),
        },
      })
    ).id;
    const td = await suDb.toolDefinition.create({
      data: {
        tenantId,
        name: "get_weather",
        label: "Get weather",
        urlTemplate: "https://api.example.com/weather",
        allowedHosts: ["api.example.com"],
      },
    });
    const kb = await suDb.knowledgeBase.create({
      data: { tenantId, name: "KB" },
    });
    await suDb.agentToolSelection.createMany({
      data: [
        // Native allowlist: one conversation tool (simulated) + one utility tool (runs real).
        {
          tenantId,
          agentId: agentTools,
          source: "NATIVE",
          enabledTools: ["handoff_to_human", "calculator"],
          knowledgeBaseIds: [],
        },
        {
          tenantId,
          agentId: agentTools,
          source: "HTTP",
          toolDefinitionId: td.id,
          enabledTools: [],
          knowledgeBaseIds: [],
        },
        {
          tenantId,
          agentId: agentTools,
          source: "RAG",
          enabledTools: ["search_knowledge"],
          knowledgeBaseIds: [kb.id],
        },
      ],
    });

    // An agent bound ONLY to a Z-PRO instance (no Chatwoot Inbox) — exercises the channel-aware
    // native-tool builder (resolvePlaygroundChannel / buildSimulatedZproNativeTools).
    agentZpro = (
      await suDb.agent.create({
        data: {
          tenantId,
          name: "ZproBound",
          systemPrompt: "x",
          modelConfig: mc(`vault:${llmKeyId}`),
        },
      })
    ).id;
    const zproInstance = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.example.com",
        apiId: "test-api-id",
        bearerToken: encryptJson("token"),
        whatsappId: 1,
        instanceName: "Test",
      },
    });
    await suDb.zproAgentBinding.create({
      data: { tenantId, zproInstanceId: zproInstance.id, agentId: agentZpro },
    });
    await suDb.agentToolSelection.create({
      data: {
        tenantId,
        agentId: agentZpro,
        source: "NATIVE",
        enabledTools: [
          "handoff_to_human",
          "resolve_conversation",
          "kanban_move_card",
          "react_to_message",
          "calculator",
        ],
        knowledgeBaseIds: [],
      },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "llm_usage",
        "agent_tool_selections",
        "zpro_agent_bindings",
        "zpro_instances",
        "tool_definitions",
        "knowledge_bases",
        "agents",
        "vault_entries",
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

  test("a turn returns the reply and a tenant+agent-fenced thread id", async () => {
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentOk,
      message: "oi",
      base: appDb,
      deps: deps(),
    });
    expect(r.reply).toBe(REPLY);
    expect(r.threadId.startsWith(`${tenantId}:playground:${agentOk}:`)).toBe(
      true,
    );
  });

  test("a forged threadId (real conversation shape) is rejected → fresh thread", async () => {
    const forged = `${tenantId}:5:900`; // tenant:instance:conv — NOT a playground thread
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentOk,
      message: "oi",
      threadId: forged,
      base: appDb,
      deps: deps(),
    });
    expect(r.threadId).not.toBe(forged);
    expect(r.threadId.startsWith(`${tenantId}:playground:${agentOk}:`)).toBe(
      true,
    );
  });

  test("a thread from a DIFFERENT agent is rejected → fresh thread", async () => {
    const otherAgentThread = `${tenantId}:playground:${agentDisabled}:abc`;
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentOk,
      message: "oi",
      threadId: otherAgentThread,
      base: appDb,
      deps: deps(),
    });
    expect(r.threadId).not.toBe(otherAgentThread);
    expect(r.threadId.startsWith(`${tenantId}:playground:${agentOk}:`)).toBe(
      true,
    );
  });

  test("works on a DISABLED agent (test before going live)", async () => {
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentDisabled,
      message: "oi",
      base: appDb,
      deps: deps(),
    });
    expect(r.reply).toBe(REPLY);
  });

  test("throws when the agent has no runnable model credential", async () => {
    await expect(
      runPlaygroundTurn({
        tenantId,
        agentId: agentNoKey,
        message: "oi",
        base: appDb,
        deps: deps(),
      }),
    ).rejects.toThrow();
  });

  test("a live draft override runs the draft model and never persists", async () => {
    // agentNoKey's SAVED model points at a missing credential; the draft override supplies a
    // working one, so the turn runs — proving the override replaces the saved config.
    const r = await runPlaygroundTurn({
      tenantId,
      agentId: agentNoKey,
      message: "oi",
      overrides: {
        systemPrompt: "draft prompt",
        modelConfig: {
          provider: "openai",
          model: "gpt-4o-mini",
          credentialRef: llmRef,
        },
      },
      base: appDb,
      deps: deps(),
    });
    expect(r.reply).toBe(REPLY);
    // Not persisted: the saved row is untouched (still the broken key + original prompt).
    const row = await suDb.agent.findUnique({
      where: { id: agentNoKey },
      select: { systemPrompt: true, modelConfig: true },
    });
    expect(row?.systemPrompt).toBe("x");
    expect(
      (row?.modelConfig as { credentialRef?: string } | undefined)
        ?.credentialRef,
    ).toBe("vault:999999999");
  });

  test("a follow-up returns the proactive reply (not silent) on a fenced thread", async () => {
    const r = await runPlaygroundFollowup({
      tenantId,
      agentId: agentOk,
      base: appDb,
      deps: deps(),
    });
    expect(r.reply).toBe(REPLY);
    expect(r.silent).toBe(false);
    expect(r.threadId.startsWith(`${tenantId}:playground:${agentOk}:`)).toBe(
      true,
    );
  });

  test("a follow-up with an empty model reply is reported as silent", async () => {
    const r = await runPlaygroundFollowup({
      tenantId,
      agentId: agentOk,
      base: appDb,
      deps: {
        makeModel: () => new FakeListChatModel({ responses: [""] }),
        checkpointer: new MemorySaver(),
      },
    });
    expect(r.reply).toBe("");
    expect(r.silent).toBe(true);
  });

  test("listPlaygroundTools classifies native/utility/http/rag and marks simulated", async () => {
    const tools = await listPlaygroundTools({
      tenantId,
      agentId: agentTools,
      base: appDb,
    });
    const byName = new Map(tools.map((tl) => [tl.name, tl]));
    // Conversation native → auto-simulated.
    expect(byName.get("handoff_to_human")).toMatchObject({
      category: "native",
      simulated: true,
      risk: "low",
    });
    // Utility native → runs real.
    expect(byName.get("calculator")).toMatchObject({
      category: "utility",
      simulated: false,
    });
    // Custom HTTP tool.
    expect(byName.get("get_weather")).toMatchObject({
      category: "http",
      simulated: false,
    });
    // RAG search tool.
    expect(byName.get("search_knowledge")).toMatchObject({
      category: "knowledge",
      simulated: false,
    });
    // The native allowlist excluded the other conversation tools.
    expect(byName.has("resolve_conversation")).toBe(false);
  });

  test("listPlaygroundTools simulates the Z-PRO native-tool flavor for a Z-PRO-bound agent", async () => {
    const tools = await listPlaygroundTools({
      tenantId,
      agentId: agentZpro,
      base: appDb,
    });
    const byName = new Map(tools.map((tl) => [tl.name, tl]));
    // Granted, Z-PRO-backed conversation tools show up, simulated.
    expect(byName.get("handoff_to_human")).toMatchObject({
      category: "native",
      simulated: true,
    });
    expect(byName.get("kanban_move_card")).toMatchObject({
      category: "native",
      simulated: true,
    });
    // react_to_message has no Z-PRO analog — never built, even though it was granted.
    expect(byName.has("react_to_message")).toBe(false);
    // Utility tools still run for real, unaffected by channel.
    expect(byName.get("calculator")).toMatchObject({
      category: "utility",
      simulated: false,
    });
  });

  test("listPlaygroundTools throws when the agent has no runnable model", async () => {
    await expect(
      listPlaygroundTools({ tenantId, agentId: agentNoKey, base: appDb }),
    ).rejects.toThrow();
  });

  test("promptVars override flows into the interpolated system prompt", async () => {
    const loaded = await runScopedOn(appDb, ctx(tenantId), (db) =>
      loadAgentConfig(
        db,
        {
          tenantId,
          instanceId: 0n,
          conversationId: 0,
          agentId: agentOk,
          threadId: `${tenantId}:playground:${agentOk}:t`,
        },
        {
          overrides: {
            systemPrompt: "Olá {{nome_contato}} da {{nome_empresa}}",
            promptVars: { nome_contato: "Maria", nome_empresa: "Acme" },
          },
        },
      ),
    );
    expect(loaded?.systemPrompt).toContain("Maria");
    expect(loaded?.systemPrompt).toContain("Acme");
  });

  test("promptNow override drives the time variables (in the agent timezone)", async () => {
    const loaded = await runScopedOn(appDb, ctx(tenantId), (db) =>
      loadAgentConfig(
        db,
        {
          tenantId,
          instanceId: 0n,
          conversationId: 0,
          agentId: agentOk,
          threadId: `${tenantId}:playground:${agentOk}:t`,
        },
        {
          overrides: {
            systemPrompt: "Agora são {{hora_atual}} de {{data_atual}}",
            // Wall-clock in the agent's tz (default America/Sao_Paulo, fixed UTC-3): the time
            // variables must read back exactly this, regardless of the host's timezone.
            promptNow: "2026-03-10T23:00",
          },
        },
      ),
    );
    expect(loaded?.systemPrompt).toContain("23:00");
    expect(loaded?.systemPrompt).toContain("10/03/2026");
  });
});

describe("runPlaygroundAudioTurn guards", () => {
  // The size/type guards run before any DB or STT call, so a fake File exercises them with no DB.
  const fakeFile = (size: number, type: string) =>
    ({ size, type }) as unknown as File;

  test("rejects an oversized audio file", async () => {
    await expect(
      runPlaygroundAudioTurn({
        tenantId: 1n,
        agentId: 1n,
        file: fakeFile(30 * 1024 * 1024, "audio/webm"),
      }),
    ).rejects.toThrow();
  });

  test("rejects a non-audio mime type", async () => {
    await expect(
      runPlaygroundAudioTurn({
        tenantId: 1n,
        agentId: 1n,
        file: fakeFile(1000, "image/png"),
      }),
    ).rejects.toThrow();
  });
});

describe("toPlaygroundInvokeError", () => {
  test("extracts the provider's embedded message from a wrapped HTTP body", () => {
    const e = new Error(
      '404 {"type":"error","error":{"type":"not_found_error","message":"model: gpt-5.4-mini"},"request_id":"req_x"}\n\nTroubleshooting URL: https://docs.langchain.com/...',
    );
    const err = toPlaygroundInvokeError(e);
    expect(err.statusCode).toBe(502);
    expect(err.message).toBe("model invocation failed: model: gpt-5.4-mini");
  });

  test("falls back to the first line when no embedded message exists", () => {
    const e = new Error("connect ECONNREFUSED 127.0.0.1:11434\nstack...");
    const err = toPlaygroundInvokeError(e);
    expect(err.message).toBe(
      "model invocation failed: connect ECONNREFUSED 127.0.0.1:11434",
    );
  });

  test("caps oversized details and handles non-Error values", () => {
    const err = toPlaygroundInvokeError("x".repeat(1000));
    expect(err.message.length).toBeLessThanOrEqual(
      "model invocation failed: ".length + 300,
    );
  });
});
