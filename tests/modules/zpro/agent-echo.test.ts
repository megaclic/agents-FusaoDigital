// tests/modules/zpro/agent-echo.test.ts
// DB-backed: markAgentSending/wasAgentSending are backed by ZproConversation.agentSendingUntil,
// not an in-memory Map — chosen after TWO live failures the same day with in-memory approaches
// (a plain module-level Map wiped by a `bun --hot` reload; then a globalThis singleton, which
// survives hot-reload but not a full process restart). A DB column survives both. These tests
// mirror mirror.test.ts's fixture pattern (a real ZproConversation row is required — the marker
// is scoped to an existing conversation, same as production: a reply is only ever sent after the
// inbound message that created the conversation was already mirrored).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { markAgentSending, wasAgentSending } from "@/modules/zpro/agent-echo";

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
let nextTicketId = 80_000;

async function makeConversation(): Promise<number> {
  const ticketId = nextTicketId++;
  await suDb.zproConversation.create({
    data: {
      tenantId,
      zproInstanceId,
      ticketId,
      contactId: 1,
      contactNumber: "5511900000000",
      contactName: "Fixture Contact",
    },
  });
  return ticketId;
}

describe.skipIf(!dbUp)("agent-echo", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproAgentEcho", slug: `zpro-agent-echo-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 93,
        instanceName: "ZproAgentEchoInstance",
      },
    });
    zproInstanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of ["zpro_conversations", "zpro_instances"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("wasAgentSending is false for a conversation that was never marked", async () => {
    const ticketId = await makeConversation();
    expect(
      await wasAgentSending(tenantId, zproInstanceId, ticketId, appDb),
    ).toBe(false);
  });

  test("markAgentSending then wasAgentSending on the SAME ticket → true", async () => {
    const ticketId = await makeConversation();
    await markAgentSending(tenantId, zproInstanceId, ticketId, appDb);
    expect(
      await wasAgentSending(tenantId, zproInstanceId, ticketId, appDb),
    ).toBe(true);
  });

  test("a different ticket or instance is NOT marked (keyed by both)", async () => {
    const ticketId = await makeConversation();
    const otherInstance = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_2",
        bearerToken: encryptJson("test-token"),
        whatsappId: 94,
        instanceName: "OtherInstance",
      },
    });
    await markAgentSending(tenantId, zproInstanceId, ticketId, appDb);
    expect(
      await wasAgentSending(tenantId, otherInstance.id, ticketId, appDb),
    ).toBe(false);
  });

  test("the marker is not consumed by a read (multi-balloon echoes)", async () => {
    const ticketId = await makeConversation();
    await markAgentSending(tenantId, zproInstanceId, ticketId, appDb);
    expect(
      await wasAgentSending(tenantId, zproInstanceId, ticketId, appDb),
    ).toBe(true);
    expect(
      await wasAgentSending(tenantId, zproInstanceId, ticketId, appDb),
    ).toBe(true);
  });

  test("re-marking the same ticket refreshes the deadline without throwing", async () => {
    const ticketId = await makeConversation();
    await markAgentSending(tenantId, zproInstanceId, ticketId, appDb);
    await markAgentSending(tenantId, zproInstanceId, ticketId, appDb);
    expect(
      await wasAgentSending(tenantId, zproInstanceId, ticketId, appDb),
    ).toBe(true);
  });

  test("an already-expired agentSendingUntil reads as false", async () => {
    const ticketId = await makeConversation();
    await suDb.zproConversation.updateMany({
      where: { zproInstanceId, ticketId },
      data: { agentSendingUntil: new Date(Date.now() - 1000) },
    });
    expect(
      await wasAgentSending(tenantId, zproInstanceId, ticketId, appDb),
    ).toBe(false);
  });

  test("marking a ticket with no ZproConversation row is a safe no-op", async () => {
    const nonExistentTicketId = 999_999;
    await markAgentSending(
      tenantId,
      zproInstanceId,
      nonExistentTicketId,
      appDb,
    );
    expect(
      await wasAgentSending(
        tenantId,
        zproInstanceId,
        nonExistentTicketId,
        appDb,
      ),
    ).toBe(false);
  });
});
