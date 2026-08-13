// tests/modules/zpro/mirror.test.ts
// DB-backed: regression for the AGENT/HUMAN misclassification bug (mirror.ts's resolveSenderType
// used to trust ticket.userId — the ticket's sticky assigned attendant — as if it were the author of
// THIS message. Once a ticket had any human assignee, every later AI-sent message was misclassified
// HUMAN). Also covers mirrorZproMessage's documented tolerance for a concurrent-redelivery P2002.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { markAgentSending } from "@/modules/zpro/agent-echo";
import { mirrorZproMessage } from "@/modules/zpro/mirror";
import type {
  ZproMsgTop,
  ZproTicket,
  ZproWebhookPayload,
} from "@/modules/zpro/types";

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

function baseTicket(id: number, userId: number | null): ZproTicket {
  return {
    id,
    protocol: `proto-${id}`,
    status: "open",
    channel: "evo",
    contactId: 999,
    whatsappId: 87,
    tenantId: Number(tenantId),
    userId,
    queueId: 17,
    n8nStatus: true,
    chatgptStatus: false,
    typebotStatus: false,
    difyStatus: false,
    dialogflowStatus: false,
    claudeStatus: false,
    geminiStatus: false,
    deepseekStatus: false,
    qwenStatus: false,
    grokStatus: false,
    ollamaStatus: false,
    lmStatus: false,
    botStopped: false,
    isGroup: false,
    unreadMessages: 0,
    lastMessage: null,
    contextVariables: {},
    n8nUrl: null,
    threadId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    contact: {
      id: 999,
      name: "Samir Toledo",
      number: "5511963529979",
      isGroup: false,
      blocked: false,
      chatbotBlocked: false,
      tenantId: Number(tenantId),
      extraInfo: [],
      tags: [],
    },
  };
}

function outboundMsg(id: string, body: string): ZproMsgTop {
  return {
    event: "messages.upsert",
    instance: "TesteSindSeg",
    fromMe: true,
    id,
    body,
    type: "conversation",
    timestamp: Date.now(),
    from: "5511963529979",
    read: false,
    ack: 1,
    data: { message: { conversation: body } },
  };
}

function inboundMsg(id: string, body: string): ZproMsgTop {
  return {
    event: "messages.upsert",
    instance: "TesteSindSeg",
    fromMe: false,
    id,
    body,
    type: "conversation",
    timestamp: Date.now(),
    from: "5511963529979",
    read: false,
    ack: 1,
    data: { message: { conversation: body } },
  };
}

function payloadFor(ticket: ZproTicket, msg: ZproMsgTop): ZproWebhookPayload {
  return {
    method: "message",
    msg,
    ticket,
    whatsapp: {
      id: 87,
      name: "TesteSindSeg",
      type: "evo",
      status: "CONNECTED",
      tenantId: Number(tenantId),
    },
  };
}

describe.skipIf(!dbUp)("mirrorZproMessage sender-type classification", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproMirror", slug: `zpro-mirror-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 87,
        instanceName: "TesteSindSeg",
      },
    });
    zproInstanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "zpro_messages",
        "zpro_conversations",
        "zpro_agent_bindings",
        "zpro_instances",
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

  test("ticket.userId set + wasAgentSending true → classifies AGENT", async () => {
    const ticket = baseTicket(9001, 15); // 15 = a human attendant assigned on the ticket
    const msg = outboundMsg(
      "MSG-AGENT-1",
      "Olá, {{nome_contato}}! Como posso ajudá-lo?",
    );
    markAgentSending(zproInstanceId, ticket.id);

    const result = await mirrorZproMessage(
      payloadFor(ticket, msg),
      tenantId,
      zproInstanceId,
      appDb,
    );
    expect(result).not.toBeNull();
    expect(result?.isHumanIntervention).toBe(false);

    const row = await suDb.zproMessage.findFirst({
      where: { conversationId: result?.conversationId, messageId: msg.id },
    });
    expect(row?.senderType).toBe("AGENT");
  });

  test("ticket.userId set + wasAgentSending false → classifies HUMAN (preserved)", async () => {
    const ticket = baseTicket(9002, 15); // fresh ticket id — no markAgentSending call for it
    const msg = outboundMsg(
      "MSG-HUMAN-1",
      "Oi! Já te ajudo por aqui, um momento.",
    );

    const result = await mirrorZproMessage(
      payloadFor(ticket, msg),
      tenantId,
      zproInstanceId,
      appDb,
    );
    expect(result).not.toBeNull();
    expect(result?.isHumanIntervention).toBe(true);

    const row = await suDb.zproMessage.findFirst({
      where: { conversationId: result?.conversationId, messageId: msg.id },
    });
    expect(row?.senderType).toBe("HUMAN");
  });

  test("concurrent redelivery of the same message does not throw and yields exactly one row", async () => {
    const ticket = baseTicket(9003, null);
    const msg = outboundMsg("MSG-RACE-1", "Resposta simultânea");
    const payload = payloadFor(ticket, msg);

    // Two genuinely concurrent calls for the SAME (ticket, messageId) on a brand-new ticket —
    // exercises the documented P2002 tolerance in mirrorZproMessage (isUniqueViolation) whichever
    // side loses the race. The contract under test is the outcome (both resolve, one row survives),
    // not which internal branch fired on a given run.
    const [r1, r2] = await Promise.all([
      mirrorZproMessage(payload, tenantId, zproInstanceId, appDb),
      mirrorZproMessage(payload, tenantId, zproInstanceId, appDb),
    ]);
    expect(r1).not.toBeNull();
    expect(r2).not.toBeNull();
    expect(r1?.conversationId).toBe(r2?.conversationId as bigint);

    const rows = await suDb.zproMessage.findMany({
      where: { conversationId: r1?.conversationId, messageId: msg.id },
    });
    expect(rows.length).toBe(1);
  });

  test("a later message with a DIFFERENT ticket.contact.id refreshes ZproConversation.contactId (contact merge)", async () => {
    const ticket = baseTicket(9004, null);
    const first = await mirrorZproMessage(
      payloadFor(ticket, outboundMsg("MSG-CONTACT-1", "primeira")),
      tenantId,
      zproInstanceId,
      appDb,
    );
    expect(first).not.toBeNull();
    const before = await suDb.zproConversation.findUnique({
      where: { id: first?.conversationId as bigint },
      select: { contactId: true },
    });
    expect(before?.contactId).toBe(999);

    // Same ticket, but the Z-PRO panel merged this contact into a different one — a later message
    // carries the NEW contact.id. The `update` block used to omit contactId entirely, so this went
    // silently stale forever.
    const mergedTicket = {
      ...ticket,
      contact: { ...ticket.contact, id: 4242 },
    };
    const second = await mirrorZproMessage(
      payloadFor(mergedTicket, outboundMsg("MSG-CONTACT-2", "segunda")),
      tenantId,
      zproInstanceId,
      appDb,
    );
    expect(second?.conversationId).toBe(first?.conversationId as bigint);

    const after = await suDb.zproConversation.findUnique({
      where: { id: first?.conversationId as bigint },
      select: { contactId: true },
    });
    expect(after?.contactId).toBe(4242);
  });
});

// DB-backed: lastInboundAt is the CLIENT-only anchor the generic follow-up sweep uses
// (isNewFollowUpEpisode) — distinct from lastMessageAt (any sender). Regression coverage for the
// Fase 6 follow-up watermark (src/modules/followups/handlers.ts's Z-PRO branch).
describe.skipIf(!dbUp)("mirrorZproMessage lastInboundAt watermark", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "ZproMirrorInbound",
        slug: `zpro-mirror-inbound-${process.pid}`,
      },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 88,
        instanceName: "TesteSindSeg2",
      },
    });
    zproInstanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "zpro_messages",
        "zpro_conversations",
        "zpro_agent_bindings",
        "zpro_instances",
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

  test("a CLIENT message advances lastInboundAt", async () => {
    const ticket = baseTicket(9101, null);
    const result = await mirrorZproMessage(
      payloadFor(ticket, inboundMsg("MSG-IN-1", "Oi, tudo bem?")),
      tenantId,
      zproInstanceId,
      appDb,
    );
    expect(result).not.toBeNull();
    const row = await suDb.zproConversation.findUnique({
      where: { id: result?.conversationId as bigint },
      select: { lastInboundAt: true, lastMessageAt: true },
    });
    expect(row?.lastInboundAt).not.toBeNull();
    expect(row?.lastInboundAt?.getTime()).toBe(row?.lastMessageAt?.getTime());
  });

  test("an AGENT (outbound) message does NOT advance lastInboundAt", async () => {
    const ticket = baseTicket(9102, null);
    const result = await mirrorZproMessage(
      payloadFor(ticket, outboundMsg("MSG-OUT-1", "Claro, como posso ajudar?")),
      tenantId,
      zproInstanceId,
      appDb,
    );
    expect(result).not.toBeNull();
    const row = await suDb.zproConversation.findUnique({
      where: { id: result?.conversationId as bigint },
      select: { lastInboundAt: true, lastMessageAt: true },
    });
    expect(row?.lastInboundAt).toBeNull();
    expect(row?.lastMessageAt).not.toBeNull();
  });

  test("lastInboundAt never regresses on a later AGENT reply", async () => {
    const ticket = baseTicket(9103, null);
    const first = await mirrorZproMessage(
      payloadFor(ticket, inboundMsg("MSG-SEQ-1", "Primeira pergunta")),
      tenantId,
      zproInstanceId,
      appDb,
    );
    const firstRow = await suDb.zproConversation.findUnique({
      where: { id: first?.conversationId as bigint },
      select: { lastInboundAt: true },
    });
    const firstInboundAt = firstRow?.lastInboundAt;
    expect(firstInboundAt).not.toBeNull();

    await mirrorZproMessage(
      payloadFor(ticket, outboundMsg("MSG-SEQ-2", "Resposta do agente")),
      tenantId,
      zproInstanceId,
      appDb,
    );
    const afterAgentRow = await suDb.zproConversation.findUnique({
      where: { id: first?.conversationId as bigint },
      select: { lastInboundAt: true },
    });
    // The agent reply advanced lastMessageAt but must NOT touch lastInboundAt.
    expect(afterAgentRow?.lastInboundAt?.getTime()).toBe(
      firstInboundAt?.getTime(),
    );
  });
});
