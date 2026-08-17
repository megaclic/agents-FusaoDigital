// tests/modules/zpro/failure.test.ts
// Z-PRO mirror of tests/modules/failure-note.test.ts (Chatwoot's item 6 + issue #71/#86) — a failed
// agent turn is otherwise invisible, so a silent agent and a broken one look the same. DB-backed,
// same fixture pattern as agent-echo.test.ts: a real ZproConversation/ZproInstance row is required.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import {
  announceZproFailedTurn,
  clearZproConversationError,
  isZproTurnLost,
  readZproDirectFence,
  recordZproConversationError,
} from "@/modules/zpro/failure";

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
let nextTicketId = 90_000;

async function makeConversation(): Promise<bigint> {
  const ticketId = nextTicketId++;
  const conv = await suDb.zproConversation.create({
    data: {
      tenantId,
      zproInstanceId,
      ticketId,
      contactId: 1,
      contactNumber: "5511900000000",
      contactName: "Fixture Contact",
    },
    select: { id: true },
  });
  return conv.id;
}

async function makeClientMessage(conversationId: bigint): Promise<bigint> {
  const msg = await suDb.zproMessage.create({
    data: {
      tenantId,
      conversationId,
      messageId: `msg-${Date.now()}-${Math.random()}`,
      senderType: "CLIENT",
      body: "oi",
      messageType: "conversation",
      fromMe: false,
      timestamp: BigInt(Date.now()),
    },
    select: { id: true },
  });
  return msg.id;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe.skipIf(!dbUp)("zpro failure tracking", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproFailure", slug: `zpro-failure-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 94,
        instanceName: "ZproFailureInstance",
      },
    });
    zproInstanceId = inst.id;
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "zpro_messages",
        "zpro_conversations",
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

  describe("isZproTurnLost", () => {
    test("a job path is lost only once actually dead-lettered", () => {
      expect(isZproTurnLost({ path: "job", deadLettered: true })).toBe(true);
      expect(isZproTurnLost({ path: "job", deadLettered: false })).toBe(false);
    });

    test("a direct path is lost only when the fence reads clear", () => {
      expect(isZproTurnLost({ path: "direct", fence: "clear" })).toBe(true);
      expect(isZproTurnLost({ path: "direct", fence: "superseded" })).toBe(
        false,
      );
      expect(isZproTurnLost({ path: "direct", fence: "unknown" })).toBe(false);
    });
  });

  describe("recordZproConversationError / clearZproConversationError", () => {
    test("records a sanitized error and timestamp, then clears both", async () => {
      const convId = await makeConversation();
      await recordZproConversationError({
        tenantId,
        conversationDbId: convId,
        error: new Error("boom"),
        base: appDb,
      });
      const after1 = await suDb.zproConversation.findUniqueOrThrow({
        where: { id: convId },
        select: { lastError: true, lastErrorAt: true },
      });
      expect(after1.lastError).toContain("boom");
      expect(after1.lastErrorAt).not.toBeNull();

      await clearZproConversationError({
        tenantId,
        conversationDbId: convId,
        base: appDb,
      });
      const after2 = await suDb.zproConversation.findUniqueOrThrow({
        where: { id: convId },
        select: { lastError: true, lastErrorAt: true },
      });
      expect(after2.lastError).toBeNull();
      expect(after2.lastErrorAt).toBeNull();
    });

    test("a nonexistent conversation is a silent no-op, never throws", async () => {
      await expect(
        recordZproConversationError({
          tenantId,
          conversationDbId: 999_999_999n,
          error: new Error("x"),
          base: appDb,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe("readZproDirectFence", () => {
    test("no trigger id → unknown", async () => {
      const convId = await makeConversation();
      expect(
        await readZproDirectFence({
          tenantId,
          conversationDbId: convId,
          triggerMessageDbId: null,
          base: appDb,
        }),
      ).toBe("unknown");
    });

    test("no newer CLIENT message than the trigger → clear", async () => {
      const convId = await makeConversation();
      const triggerId = await makeClientMessage(convId);
      expect(
        await readZproDirectFence({
          tenantId,
          conversationDbId: convId,
          triggerMessageDbId: triggerId,
          base: appDb,
        }),
      ).toBe("clear");
    });

    test("a newer CLIENT message arrived → superseded", async () => {
      const convId = await makeConversation();
      const triggerId = await makeClientMessage(convId);
      await makeClientMessage(convId);
      expect(
        await readZproDirectFence({
          tenantId,
          conversationDbId: convId,
          triggerMessageDbId: triggerId,
          base: appDb,
        }),
      ).toBe("superseded");
    });
  });

  describe("announceZproFailedTurn", () => {
    test("not-lost: assess reports the turn is not definitively lost → no note, no claim", async () => {
      const convId = await makeConversation();
      let fetchCalled = false;
      globalThis.fetch = (async () => {
        fetchCalled = true;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      const result = await announceZproFailedTurn({
        tenantId,
        zproInstanceId,
        conversationDbId: convId,
        ticketId: 1,
        assess: async () => ({ path: "job", deadLettered: false }),
        error: new Error("boom"),
        base: appDb,
      });
      expect(result).toBe("not-lost");
      expect(fetchCalled).toBe(false);
    });

    test("posted: lost + claim succeeds → posts a note via ZproClient.createNote", async () => {
      const convId = await makeConversation();
      const calls: Array<{ url: string; body: unknown }> = [];
      globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      const result = await announceZproFailedTurn({
        tenantId,
        zproInstanceId,
        conversationDbId: convId,
        ticketId: 4242,
        assess: async () => ({ path: "job", deadLettered: true }),
        error: new Error("provider timeout"),
        base: appDb,
      });
      expect(result).toBe("posted");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toContain("createNotes");
      const body = calls[0]?.body as Record<string, unknown>;
      expect(body.ticketId).toBe(4242);
      expect(String(body.notes)).toContain("provider timeout");

      const conv = await suDb.zproConversation.findUniqueOrThrow({
        where: { id: convId },
        select: { failureNoticeSentAt: true },
      });
      expect(conv.failureNoticeSentAt).not.toBeNull();
    });

    test("coalesced: a second announcement within the cooldown posts nothing more", async () => {
      const convId = await makeConversation();
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;
      const params = {
        tenantId,
        zproInstanceId,
        conversationDbId: convId,
        ticketId: 1,
        assess: async () => ({ path: "job" as const, deadLettered: true }),
        error: new Error("x"),
        base: appDb,
      };
      expect(await announceZproFailedTurn(params)).toBe("posted");
      expect(await announceZproFailedTurn(params)).toBe("coalesced");
      expect(calls).toBe(1);
    });

    test("failed: the instance no longer resolves → failed, never throws", async () => {
      const convId = await makeConversation();
      globalThis.fetch = (async () =>
        new Response("{}", { status: 200 })) as unknown as typeof fetch;
      const result = await announceZproFailedTurn({
        tenantId,
        zproInstanceId: 999_999_999n,
        conversationDbId: convId,
        ticketId: 1,
        assess: async () => ({ path: "job", deadLettered: true }),
        error: new Error("x"),
        base: appDb,
      });
      expect(result).toBe("failed");
    });

    test("failed: the post itself throws → failed, never bubbles", async () => {
      const convId = await makeConversation();
      globalThis.fetch = (async () => {
        throw new Error("network down");
      }) as unknown as typeof fetch;
      const result = await announceZproFailedTurn({
        tenantId,
        zproInstanceId,
        conversationDbId: convId,
        ticketId: 1,
        assess: async () => ({ path: "job", deadLettered: true }),
        error: new Error("x"),
        base: appDb,
      });
      expect(result).toBe("failed");
    });
  });
});
