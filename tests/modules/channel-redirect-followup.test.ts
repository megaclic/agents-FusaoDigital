import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  armRedirectChatFollowUp,
  chatFollowupNudge,
  minutesFromNow,
  parseRedirectFollowUpPayload,
  resolveZproSibling,
} from "@/modules/channel-redirect/followup";
import { CHANNEL_REDIRECT_DEFAULTS } from "@/modules/channel-redirect/service";
import type { enqueueJob } from "@/modules/scheduler/service";

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

describe("parseRedirectFollowUpPayload", () => {
  test("valid chat-stage payload", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: "9",
        entryInboxId: 7,
      }),
    ).toEqual({
      stage: "chat",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: 7,
      entryZproInstanceId: null,
    });
  });

  test("valid whatsapp-stage payload with a null entryInboxId", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "whatsapp",
        widgetThreadId: "1:2:3",
        agentId: "9",
      }),
    ).toEqual({
      stage: "whatsapp",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: null,
      entryZproInstanceId: null,
    });
  });

  test("valid closing-stage payload", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "closing",
        widgetThreadId: "1:2:3",
        agentId: "9",
        entryInboxId: 7,
      }),
    ).toEqual({
      stage: "closing",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: 7,
      entryZproInstanceId: null,
    });
  });

  test("valid payload with an entryZproInstanceId and no entryInboxId (Z-PRO-only entry)", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "whatsapp",
        widgetThreadId: "1:2:3",
        agentId: "9",
        entryZproInstanceId: 5,
      }),
    ).toEqual({
      stage: "whatsapp",
      widgetThreadId: "1:2:3",
      agentId: "9",
      entryInboxId: null,
      entryZproInstanceId: 5,
    });
  });

  test("rejects a missing/invalid stage", () => {
    expect(
      parseRedirectFollowUpPayload({
        stage: "bogus",
        widgetThreadId: "1:2:3",
        agentId: "9",
      }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({ widgetThreadId: "1:2:3", agentId: "9" }),
    ).toBeNull();
  });

  test("rejects a missing widgetThreadId or agentId", () => {
    expect(
      parseRedirectFollowUpPayload({ stage: "chat", agentId: "9" }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
      }),
    ).toBeNull();
    expect(
      parseRedirectFollowUpPayload({
        stage: "chat",
        widgetThreadId: "1:2:3",
        agentId: 9, // wrong type (must be a string)
      }),
    ).toBeNull();
  });
});

describe("nudge builders", () => {
  test("chatFollowupNudge carries the redirect source + kind + instructions", () => {
    const n = chatFollowupNudge("Pergunte se ainda precisa de ajuda.");
    expect(n.source).toBe("channel-redirect");
    expect(n.kind).toBe("chat-followup");
    expect(n.instructions).toBe("Pergunte se ainda precisa de ajuda.");
  });
});

describe("minutesFromNow", () => {
  test("adds N minutes to the given instant", () => {
    const now = new Date("2026-07-05T12:00:00Z");
    expect(minutesFromNow(60, now).toISOString()).toBe(
      "2026-07-05T13:00:00.000Z",
    );
    expect(minutesFromNow(0, now).toISOString()).toBe(now.toISOString());
  });
});

describe("armRedirectChatFollowUp", () => {
  function fakeEnqueue() {
    const calls: Array<Parameters<typeof enqueueJob>[0]> = [];
    const fn = (async (p: Parameters<typeof enqueueJob>[0]) => {
      calls.push(p);
      return 1n;
    }) as typeof enqueueJob;
    return { fn, calls };
  }

  const cfg = {
    ...CHANNEL_REDIRECT_DEFAULTS,
    chatFollowupEnabled: true,
    chatFollowupDelayValue: 30,
  };
  const now = new Date("2026-07-05T12:00:00Z");

  test("enqueues a REDIRECT_FOLLOWUP stage=chat job, dedupeKey by widgetThreadId, runAt = now + delay", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        entryZproInstanceId: null,
        cfg,
        now,
      },
      fn,
    );
    expect(armed).toBe(true);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.kind).toBe("REDIRECT_FOLLOWUP");
    expect(call?.dedupeKey).toBe("redirect-followup:1:2:30");
    expect(call?.runAt.toISOString()).toBe("2026-07-05T12:30:00.000Z");
    expect(call?.payload).toEqual({
      stage: "chat",
      widgetThreadId: "1:2:30",
      agentId: "9",
      entryInboxId: 7,
      entryZproInstanceId: null,
    });
  });

  test("carries entryZproInstanceId in the enqueued payload (Z-PRO entry)", async () => {
    const { fn, calls } = fakeEnqueue();
    await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: null,
        entryZproInstanceId: 5,
        cfg,
        now,
      },
      fn,
    );
    expect(calls[0]?.payload).toMatchObject({
      entryInboxId: null,
      entryZproInstanceId: 5,
    });
  });

  test("no-ops only when EVERY follow-up step is disabled", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        entryZproInstanceId: null,
        cfg: {
          ...cfg,
          chatFollowupEnabled: false,
          waFollowupEnabled: false,
          closingEnabled: false,
        },
        now,
      },
      fn,
    );
    expect(armed).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("still arms (at stage chat) when the chat step is off but a later stage is on", async () => {
    const { fn, calls } = fakeEnqueue();
    const armed = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 2n,
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        entryZproInstanceId: null,
        cfg: {
          ...cfg,
          chatFollowupEnabled: false,
          waFollowupEnabled: true,
          closingEnabled: false,
        },
        now,
      },
      fn,
    );
    expect(armed).toBe(true);
    expect(calls[0]?.payload).toMatchObject({ stage: "chat" });
  });

  test("no-ops (defense in depth) when the thread's tenant/instance doesn't match — never enqueues across a tenant fence", async () => {
    const { fn, calls } = fakeEnqueue();
    const wrongTenant = await armRedirectChatFollowUp(
      {
        tenantId: 999n,
        instanceId: 2n,
        widgetThreadId: "1:2:30", // tenant 1, not 999
        agentId: 9n,
        entryInboxId: 7,
        entryZproInstanceId: null,
        cfg,
        now,
      },
      fn,
    );
    const wrongInstance = await armRedirectChatFollowUp(
      {
        tenantId: 1n,
        instanceId: 999n, // thread says instance 2
        widgetThreadId: "1:2:30",
        agentId: 9n,
        entryInboxId: 7,
        entryZproInstanceId: null,
        cfg,
        now,
      },
      fn,
    );
    expect(wrongTenant).toBe(false);
    expect(wrongInstance).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

// DB-backed: resolveZproSibling reverse-maps a widget conversation's Chatwoot contact back to the
// ZproConversation that originally redirected it (the piece sendWhatsAppFollowUp/deliverRedirectClosing
// use to fall back to a Z-PRO delivery when there is no Chatwoot-native WhatsApp sibling).
describe.skipIf(!dbUp)("resolveZproSibling", () => {
  afterAll(async () => {
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function makeWidgetFixture(opts: {
    tenantName: string;
    slug: string;
    chatwootContactId: number | null;
  }) {
    const t = await suDb.tenant.create({
      data: { name: opts.tenantName, slug: opts.slug },
    });
    const tenantId = t.id;
    const deployment = await suDb.chatwootDeployment.create({
      data: {
        tenantId,
        baseUrl: `https://cw-${opts.slug}.example.com`,
        adminToken: encryptJson("admin-token"),
      },
    });
    const instance = await suDb.chatwootInstance.create({
      data: {
        tenantId,
        deploymentId: deployment.id,
        accountId: 1,
        serverKey: `cw-${opts.slug}.example.com`,
      },
    });
    const widgetInbox = await suDb.inbox.create({
      data: {
        tenantId,
        chatwootInstanceId: instance.id,
        chatwootInboxId: 81,
        name: "Web Widget",
      },
    });
    const contact =
      opts.chatwootContactId !== null
        ? await suDb.contact.create({
            data: {
              tenantId,
              chatwootInstanceId: instance.id,
              chatwootContactId: opts.chatwootContactId,
            },
          })
        : null;
    const widgetConv = await suDb.conversation.create({
      data: {
        tenantId,
        chatwootInstanceId: instance.id,
        inboxId: widgetInbox.id,
        contactId: contact?.id ?? null,
        chatwootConversationId: 900,
        status: "pending",
        threadId: `${tenantId}:${instance.id}:900`,
      },
    });
    return { tenantId, chatwootInstanceId: instance.id, widgetConv };
  }

  async function cleanup(tenantId: bigint) {
    for (const table of [
      "zpro_conversations",
      "zpro_instances",
      "conversations",
      "inboxes",
      "contacts",
      "chatwoot_instances",
      "chatwoot_deployments",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
  }

  test("resolves the ZproConversation whose redirectChatwootContactId matches the widget contact, scoped to the configured entry instance", async () => {
    const { tenantId, chatwootInstanceId, widgetConv } =
      await makeWidgetFixture({
        tenantName: "ZproSibling1",
        slug: `zpro-sib-1-${process.pid}`,
        chatwootContactId: 5001,
      });
    const zproInstance = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 501,
        instanceName: "ZproSiblingInstance1",
        isOfficialWaba: true,
      },
    });
    const lastInboundAt = new Date(Date.now() - 5 * 60_000);
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId: zproInstance.id,
        ticketId: 4001,
        contactId: 1,
        contactNumber: "5511999990000",
        contactName: "Lead Um",
        redirectChatwootContactId: 5001,
        lastInboundAt,
      },
    });

    const sibling = await resolveZproSibling(
      tenantId,
      chatwootInstanceId,
      widgetConv.chatwootConversationId,
      Number(zproInstance.id),
      appDb,
    );
    expect(sibling).not.toBeNull();
    expect(sibling?.ticketId).toBe(4001);
    expect(sibling?.contactNumber).toBe("5511999990000");
    expect(sibling?.chatwootContactId).toBe(5001);
    expect(sibling?.instance.apiId).toBe("TEST_API_ID");
    // Parte B (Fase 6): the 24h-window gate reads these two fields off the sibling directly.
    expect(sibling?.instance.isOfficialWaba).toBe(true);
    expect(sibling?.lastInboundAt?.getTime()).toBe(lastInboundAt.getTime());

    await cleanup(tenantId);
  });

  test("returns null when the widget contact was redirected from a DIFFERENT Z-PRO instance than the one configured", async () => {
    const { tenantId, chatwootInstanceId, widgetConv } =
      await makeWidgetFixture({
        tenantName: "ZproSibling2",
        slug: `zpro-sib-2-${process.pid}`,
        chatwootContactId: 5002,
      });
    const zproInstanceA = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_A",
        bearerToken: encryptJson("test-token"),
        whatsappId: 502,
        instanceName: "ZproSiblingInstance2A",
      },
    });
    const zproInstanceB = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_B",
        bearerToken: encryptJson("test-token"),
        whatsappId: 503,
        instanceName: "ZproSiblingInstance2B",
      },
    });
    await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId: zproInstanceA.id,
        ticketId: 4002,
        contactId: 2,
        contactNumber: "5511999990001",
        contactName: "Lead Dois",
        redirectChatwootContactId: 5002,
      },
    });

    // Configured entry is instance B, but the lead was actually redirected from instance A.
    const sibling = await resolveZproSibling(
      tenantId,
      chatwootInstanceId,
      widgetConv.chatwootConversationId,
      Number(zproInstanceB.id),
      appDb,
    );
    expect(sibling).toBeNull();

    await cleanup(tenantId);
  });

  test("returns null when the widget conversation has no linked contact", async () => {
    const { tenantId, chatwootInstanceId, widgetConv } =
      await makeWidgetFixture({
        tenantName: "ZproSibling3",
        slug: `zpro-sib-3-${process.pid}`,
        chatwootContactId: null,
      });
    const zproInstance = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_C",
        bearerToken: encryptJson("test-token"),
        whatsappId: 504,
        instanceName: "ZproSiblingInstance3",
      },
    });

    const sibling = await resolveZproSibling(
      tenantId,
      chatwootInstanceId,
      widgetConv.chatwootConversationId,
      Number(zproInstance.id),
      appDb,
    );
    expect(sibling).toBeNull();

    await cleanup(tenantId);
  });

  test("returns null when no ZproConversation was ever redirected for this widget contact", async () => {
    const { tenantId, chatwootInstanceId, widgetConv } =
      await makeWidgetFixture({
        tenantName: "ZproSibling4",
        slug: `zpro-sib-4-${process.pid}`,
        chatwootContactId: 5004,
      });
    const zproInstance = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_D",
        bearerToken: encryptJson("test-token"),
        whatsappId: 505,
        instanceName: "ZproSiblingInstance4",
      },
    });

    const sibling = await resolveZproSibling(
      tenantId,
      chatwootInstanceId,
      widgetConv.chatwootConversationId,
      Number(zproInstance.id),
      appDb,
    );
    expect(sibling).toBeNull();

    await cleanup(tenantId);
  });
});
