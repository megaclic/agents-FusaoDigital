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

  // Spend ceiling (docs/spend-ceiling.md, issue #390/#491): silent ONLY — no customer copy, no
  // handoff, no note. A nudge has nobody waiting on the other end, so the refusal never touches
  // ZproClient at all, unlike the webhook/debounce gates; there is nothing here to stub fetch for.
  test("an over-ceiling tenant: over-ceiling outcome, nothing sent, the ticket is untouched", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 3003,
        status: "open",
        contactId: 3,
        contactNumber: "5511900000013",
        contactName: "Cliente Teto",
        agentActive: true,
      },
    });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: { spendCeiling: { enabled: true, monthlyInboxUsd: 1 } },
      },
    });
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 999,
        polledAt: new Date(),
      },
      update: { costUsd: 999, polledAt: new Date() },
    });

    const outcome = await runZproAgentNudge({
      tenantId,
      threadId: `zpro:${tenantId}:${zproInstanceId}:3003`,
      nudge: { source: "appointment_reminder", summary: "lembrete" },
      base: appDb,
    });
    expect(outcome).toBe("over-ceiling");

    // Silent means silent: no handoff (agentActive untouched), the same invariant the
    // human-owned-conversation test above pins for a different refusal.
    const row = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { agentActive: true },
    });
    expect(row.agentActive).toBe(true);

    await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: {} },
    });
  });

  // The control: under the ceiling nothing about this gate fires, and the nudge proceeds to the
  // real turn (which this file's own boundary does not exercise — see the module header). Proven
  // the same way debounce.test.ts proves it: by watching whether the snapshot table is read at all,
  // rather than by letting the turn actually reach a model.
  test("under the ceiling the gate reads the snapshot and does not refuse", async () => {
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 3004,
        status: "open",
        contactId: 4,
        contactNumber: "5511900000014",
        contactName: "Cliente Sob Teto",
        agentActive: true,
      },
    });
    // contactAuth enabled with no URL ⇒ an immediate, network-free "error" outcome (the same
    // fail-closed refusal contact-auth already takes on its own), used only to stop the nudge
    // cleanly right after the ceiling gate lets it through — before it would otherwise build a
    // real model and invoke the graph, out of this file's testing boundary (see the module header).
    await suDb.agent.update({
      where: { id: agentId },
      data: { settings: { contactAuth: { enabled: true } } },
    });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: {
        settings: {
          spendCeiling: { enabled: true, monthlyInboxUsd: 1_000_000 },
        },
      },
    });
    const monthStart = new Date(
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    );
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: { tenantId, source: "inbox", monthStart },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart,
        costUsd: 10,
        polledAt: new Date(),
      },
      update: { costUsd: 10, polledAt: new Date() },
    });

    let snapshotReads = 0;
    const watchedDb = appDb.$extends({
      query: {
        spendCostSnapshot: {
          async findUnique({ args, query }) {
            snapshotReads += 1;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const outcome = await runZproAgentNudge({
      tenantId,
      threadId: `zpro:${tenantId}:${zproInstanceId}:3004`,
      nudge: { source: "appointment_reminder", summary: "lembrete" },
      base: watchedDb,
    });
    // The read ran (the gate asked) and it did not refuse — contact-auth's own network-free
    // "error" outcome is what actually stopped this nudge before a real turn.
    expect(outcome).toBe("silent");
    expect(snapshotReads).toBe(1);

    await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: {} },
    });
    await suDb.agent.update({
      where: { id: agentId },
      data: { settings: {} },
    });
  });
});
