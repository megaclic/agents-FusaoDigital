// tests/modules/zpro/nudge.test.ts
// runZproAgentNudge's GATE logic (thread parse/tenant fence, no-conversation, human-owned skip,
// no-agent) — deliberately does NOT exercise the happy path that reaches runLoadedZproTurn (posts a
// real reply): that function calls createChatModel directly (no injectable deps), and no zpro
// runtime test in this codebase invokes the live LLM graph. Mirrors debounce.test.ts's philosophy.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runZproAgentNudge } from "@/modules/zpro/nudge";

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
let agentId = 0n;

describe.skipIf(!dbUp)("runZproAgentNudge (DB-backed)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproNudge", slug: `zpro-nudge-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 95,
        instanceName: "ZproNudgeInstance",
      },
    });
    zproInstanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente Z-PRO Nudge",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
      },
    });
    agentId = agent.id;
    await suDb.zproAgentBinding.create({
      data: { tenantId, zproInstanceId, agentId },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "zpro_conversations",
        "zpro_agent_bindings",
        "agents",
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

  test("a Chatwoot-shaped threadId (no zpro prefix) → no-conversation", async () => {
    const outcome = await runZproAgentNudge({
      tenantId,
      threadId: `${tenantId}:1:2`,
      nudge: { source: "appointment_reminder", summary: "x" },
      base: appDb,
    });
    expect(outcome).toBe("no-conversation");
  });

  test("a threadId whose tenant segment doesn't match the caller's tenantId → no-conversation", async () => {
    const outcome = await runZproAgentNudge({
      tenantId,
      threadId: `zpro:${tenantId + 999n}:${zproInstanceId}:1`,
      nudge: { source: "appointment_reminder", summary: "x" },
      base: appDb,
    });
    expect(outcome).toBe("no-conversation");
  });

  test("no matching ZproConversation → no-conversation", async () => {
    const outcome = await runZproAgentNudge({
      tenantId,
      threadId: `zpro:${tenantId}:${zproInstanceId}:888888`,
      nudge: { source: "appointment_reminder", summary: "x" },
      base: appDb,
    });
    expect(outcome).toBe("no-conversation");
  });

  test("a human-owned conversation (agentActive=false) → human-owned, never invokes the graph", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 3001,
        status: "pending",
        contactId: 1,
        contactNumber: "5511900000011",
        contactName: "Cliente Humano",
        agentActive: false,
      },
    });
    const outcome = await runZproAgentNudge({
      tenantId,
      threadId: `zpro:${tenantId}:${zproInstanceId}:3001`,
      nudge: { source: "appointment_reminder", summary: "lembrete" },
      base: appDb,
    });
    expect(outcome).toBe("human-owned");
    // Untouched — the gate must return before ever writing to the conversation.
    const row = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { agentActive: true },
    });
    expect(row.agentActive).toBe(false);
  });

  test("agent-active but the Z-PRO instance has no bound agent → no-agent", async () => {
    const otherInst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_2",
        bearerToken: encryptJson("test-token"),
        whatsappId: 96,
        instanceName: "ZproNudgeInstanceUnbound",
      },
    });
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId: otherInst.id,
        ticketId: 3002,
        status: "open",
        contactId: 2,
        contactNumber: "5511900000012",
        contactName: "Cliente Sem Agente",
        agentActive: true,
      },
    });

    const outcome = await runZproAgentNudge({
      tenantId,
      threadId: `zpro:${tenantId}:${otherInst.id}:3002`,
      nudge: { source: "appointment_reminder", summary: "lembrete" },
      base: appDb,
    });
    expect(outcome).toBe("no-agent");

    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_conversations WHERE zpro_instance_id = ${otherInst.id}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_instances WHERE id = ${otherInst.id}`,
    );
  });
});
