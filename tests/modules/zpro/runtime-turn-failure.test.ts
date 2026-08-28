// tests/modules/zpro/runtime-turn-failure.test.ts
// runZproAgentTurn's two failure-visibility writes (issue: the terminal-failure-fence sweep found
// both markDelivery("FAILED") sites in this function announcing nowhere — see
// tests/modules/terminal-failure-fence.test.ts's CENSUS entry and the fix in src/modules/zpro/
// runtime.ts). This file covers the no-agent path end to end (fully mockable, no model call
// needed); the turn-exception path's own pieces (recordZproConversationError/
// announceZproFailedTurn/readZproDirectFence) are already covered in isolation by
// tests/modules/zpro/failure.test.ts — this only needs to prove the WIRING, which the no-agent
// case already exercises (same conversationDbId-null guard, same call shape).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { runZproAgentTurn } from "@/modules/zpro/runtime";
import type { NormalizedZproEvent } from "@/modules/zpro/types";
import { flowLogRows } from "../../utils/flowlog";

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

describe.skipIf(!dbUp)("runZproAgentTurn: no-agent path announces", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "ZproTurnFailure",
        slug: `zpro-turn-failure-${process.pid}`,
      },
    });
    tenantId = t.id;
  });

  afterAll(async () => {
    if (tenantId) await suDb.tenant.delete({ where: { id: tenantId } });
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("no ZproAgentBinding for the instance: marks the delivery FAILED and emits a scoped route/warn/skipped flow line", async () => {
    const instance = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://z-pro.example.com",
        apiId: "api-1",
        bearerToken: encryptJson("token"),
        whatsappId: 1001,
        instanceName: "unbound-instance",
      },
    });
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId: instance.id,
        ticketId: 5001,
        contactId: 9001,
        contactNumber: "+5511988887777",
        contactName: "Cliente Sem Agente",
        agentActive: true,
      },
    });
    const delivery = await suDb.zproWebhookDelivery.create({
      data: {
        tenantId,
        zproInstanceId: instance.id,
        messageId: "msg-no-agent-1",
        event: "message",
        status: "PENDING",
      },
    });

    const event: NormalizedZproEvent = {
      messageId: "msg-no-agent-1",
      threadId: String(conv.ticketId),
      tenantId: Number(tenantId),
      instanceId: Number(instance.id),
      instanceName: instance.instanceName,
      channelType: "baileys",
      apiId: instance.apiId,
      contactId: conv.contactId,
      contactNumber: conv.contactNumber,
      contactName: conv.contactName,
      extraInfo: [],
      messageType: "conversation",
      body: "oi, alguém aí?",
      fromMe: false,
      timestamp: Date.now(),
      ticketStatus: "open",
      agentActive: true,
      hasHumanAssigned: false,
    };

    const outcome = await runZproAgentTurn({
      tenantId,
      zproInstanceId: instance.id,
      deliveryRowId: delivery.id,
      event,
      turnId: "turn-no-agent-1",
      conversationDbId: conv.id,
      triggerMessageDbId: null,
      base: appDb,
    });
    expect(outcome).toBe("no-agent");

    const updated = await suDb.zproWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(updated.status).toBe("FAILED");
    expect(updated.attempts).toBe(1);

    const rows = await flowLogRows(suDb, {
      where: { tenantId, turnId: "turn-no-agent-1" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      stage: "route",
      level: "warn",
      status: "skipped",
    });
    expect((rows[0]?.detail as { outcome?: string } | null)?.outcome).toBe(
      "no_agent",
    );
  });

  test("no conversationDbId given: still marks the delivery FAILED, emits nothing (nothing to scope the line to)", async () => {
    const instance = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://z-pro.example.com",
        apiId: "api-2",
        bearerToken: encryptJson("token"),
        whatsappId: 1002,
        instanceName: "unbound-instance-2",
      },
    });
    const delivery = await suDb.zproWebhookDelivery.create({
      data: {
        tenantId,
        zproInstanceId: instance.id,
        messageId: "msg-no-agent-2",
        event: "message",
        status: "PENDING",
      },
    });

    const event: NormalizedZproEvent = {
      messageId: "msg-no-agent-2",
      threadId: "5002",
      tenantId: Number(tenantId),
      instanceId: Number(instance.id),
      instanceName: instance.instanceName,
      channelType: "baileys",
      apiId: instance.apiId,
      contactId: 9002,
      contactNumber: "+5511988880000",
      contactName: "Cliente Sem Mirror",
      extraInfo: [],
      messageType: "conversation",
      body: "oi",
      fromMe: false,
      timestamp: Date.now(),
      ticketStatus: "open",
      agentActive: true,
      hasHumanAssigned: false,
    };

    const outcome = await runZproAgentTurn({
      tenantId,
      zproInstanceId: instance.id,
      deliveryRowId: delivery.id,
      event,
      turnId: "turn-no-agent-2",
      conversationDbId: null,
      triggerMessageDbId: null,
      base: appDb,
    });
    expect(outcome).toBe("no-agent");

    const updated = await suDb.zproWebhookDelivery.findUniqueOrThrow({
      where: { id: delivery.id },
    });
    expect(updated.status).toBe("FAILED");

    const rows = await flowLogRows(suDb, {
      where: { tenantId, turnId: "turn-no-agent-2" },
    });
    expect(rows).toHaveLength(0);
  });
});
