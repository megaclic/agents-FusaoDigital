// tests/modules/zpro/debounce.test.ts
// parseZproThreadId (pure) + resolveZproDebounceConfig (DB-backed, mirrors resolveZproSttConfig's
// test) + flushZproDebounceJob's GATE/DATA logic: no-conversation, agent-inactive gate (advances
// the watermark from the payload's lastMessageId, mirrors Chatwoot's issue #8 fix), no-pending-burst,
// and an all-empty-body burst. Deliberately does NOT exercise the happy path that reaches
// runLoadedZproTurn (posts a real reply) — that function calls createChatModel directly (no
// injectable deps, unlike Chatwoot's runLoadedTurn), and no zpro runtime test in this codebase
// invokes the live LLM graph; the watermark/supersede/gate mechanics tested here are the actual
// correctness-critical surface (duplicate-reply prevention), independent of what the model says.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  flushZproDebounceJob,
  parseZproThreadId,
  resolveZproDebounceConfig,
} from "@/modules/zpro/debounce";

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

describe("parseZproThreadId", () => {
  test("parses the zpro:<tenantId>:<instanceId>:<ticketId> shape", () => {
    expect(parseZproThreadId("zpro:1:2:3")).toEqual({
      tenantId: 1n,
      zproInstanceId: 2n,
      ticketId: 3,
    });
  });
  test("rejects a Chatwoot-shaped threadId (3 parts, no zpro prefix)", () => {
    expect(parseZproThreadId("1:2:3")).toBeNull();
  });
  test("rejects garbage", () => {
    expect(parseZproThreadId("not-a-thread-id")).toBeNull();
    expect(parseZproThreadId("zpro:abc:2:3")).toBeNull();
    expect(parseZproThreadId("zpro:1:2:not-a-number")).toBeNull();
  });
});

let tenantId = 0n;
let zproInstanceId = 0n;
let agentId = 0n;

describe.skipIf(!dbUp)("zpro debounce (DB-backed)", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproDebounce", slug: `zpro-debounce-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 93,
        instanceName: "ZproDebounceInstance",
      },
    });
    zproInstanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente Z-PRO",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: { debounce: { enabled: true, windowSeconds: 15 } },
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
        "zpro_messages",
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

  test("resolveZproDebounceConfig returns the bound agent's enabled config", async () => {
    const cfg = await resolveZproDebounceConfig(
      tenantId,
      zproInstanceId,
      appDb,
    );
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.windowSeconds).toBe(15);
  });

  test("resolveZproDebounceConfig returns null for an unbound instance", async () => {
    expect(
      await resolveZproDebounceConfig(tenantId, 9_999_999n, appDb),
    ).toBeNull();
  });

  function job(
    threadId: string,
    payload: Record<string, unknown> = {},
  ): ClaimedJob {
    return {
      id: 1n,
      tenantId,
      kind: "DEBOUNCE",
      payload: { threadId, ...payload },
      attempts: 0,
    };
  }

  test("no matching ZproConversation → done, no crash", async () => {
    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:777777`),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });
  });

  test("agent-inactive gate: advances the watermark from the payload's lastMessageId, no crash", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2001,
        status: "pending",
        contactId: 1,
        contactNumber: "5511900000001",
        contactName: "Cliente Gate",
        agentActive: false, // human owns it
      },
    });
    const msg = await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-gate-1",
        senderType: "CLIENT",
        body: "oi",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:2001`, {
        lastMessageId: Number(msg.id),
      }),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    const updated = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastHandledMessageId: true },
    });
    expect(updated.lastHandledMessageId).toBe(msg.id);
  });

  test("no pending burst (watermark already covers every CLIENT message) → done, watermark unchanged", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2002,
        status: "open",
        contactId: 2,
        contactNumber: "5511900000002",
        contactName: "Cliente Sem Burst",
        agentActive: true,
      },
    });
    const msg = await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-nb-1",
        senderType: "CLIENT",
        body: "oi",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });
    await suDb.zproConversation.update({
      where: { id: conv.id },
      data: { lastHandledMessageId: msg.id },
    });

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:2002`),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    const updated = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastHandledMessageId: true },
    });
    expect(updated.lastHandledMessageId).toBe(msg.id);
  });

  test("no agent bound → done, no crash", async () => {
    const otherInst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_2",
        bearerToken: encryptJson("test-token"),
        whatsappId: 94,
        instanceName: "ZproDebounceInstanceUnbound",
      },
    });
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId: otherInst.id,
        ticketId: 2003,
        status: "open",
        contactId: 3,
        contactNumber: "5511900000003",
        contactName: "Cliente Sem Agente",
        agentActive: true,
      },
    });
    await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-na-1",
        senderType: "CLIENT",
        body: "oi",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${otherInst.id}:2003`),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_messages WHERE conversation_id = ${conv.id}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_conversations WHERE id = ${conv.id}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_instances WHERE id = ${otherInst.id}`,
    );
  });

  // withMediaFallback (parse.ts) now covers "uncaptioned media with no STT/vision extraction" —
  // it degrades to a marker (e.g. "<mensagem de áudio não audível...>"), not silence, so a burst
  // like that reaches runLoadedZproTurn for real instead of stopping here (see parse.test.ts's
  // withMediaFallback suite for the marker coverage; a live turn is outside this file's testing
  // boundary — no zpro runtime test invokes the live LLM graph). The one case that still has
  // truly nothing to answer is a "conversation" (plain text) message that arrived empty.
  test("a burst with only genuinely empty text (not media) advances the watermark without crashing", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2004,
        status: "open",
        contactId: 4,
        contactNumber: "5511900000004",
        contactName: "Cliente Mídia Sem Texto",
        agentActive: true,
      },
    });
    const msg = await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-empty-1",
        senderType: "CLIENT",
        body: "", // an empty-text webhook artifact — withMediaFallback has no marker for this type
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:2004`),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    const updated = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastHandledMessageId: true },
    });
    expect(updated.lastHandledMessageId).toBe(msg.id);
  });
});
