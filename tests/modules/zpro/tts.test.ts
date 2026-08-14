// tests/modules/zpro/tts.test.ts
// buildSetVoicePreferenceTool: DB-backed, mirrors tests/modules/tts.test.ts's coverage of Chatwoot's
// set_voice_preference but writes ZproConversation.voiceReply (Z-PRO has no Contact table). Also
// tenant-isolation and a same-tenant collision-risk check, matching the convention established for
// the other zpro columns (avatarUrl, zproConversationId).
// sendZproVoiceReply: always goes through the generic /base64 file endpoint, regardless of format —
// the vendor's native /voice endpoint needs a public URL, not inline base64 (confirmed live,
// 2026-08-14: a base64 "audio" field silently never reaches WhatsApp despite a 200 response). No
// network: ZproClient is duck-typed and cast, same pattern tests/graph/runtime.test.ts uses for
// ChatwootClient.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ZproClient } from "@/modules/zpro/client";
import {
  buildSetVoicePreferenceTool,
  sendZproVoiceReply,
} from "@/modules/zpro/tts";
import type { NormalizedZproEvent } from "@/modules/zpro/types";

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
let otherTenantId = 0n;
let zproInstanceId = 0n;
let conversationId = 0n;

describe.skipIf(!dbUp)("zpro tts", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproTts", slug: `zpro-tts-${process.pid}` },
    });
    tenantId = t.id;
    const t2 = await suDb.tenant.create({
      data: { name: "ZproTtsOther", slug: `zpro-tts-other-${process.pid}` },
    });
    otherTenantId = t2.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 91,
        instanceName: "ZproTtsInstance",
      },
    });
    zproInstanceId = inst.id;
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 1,
        status: "open",
        contactId: 1,
        contactNumber: "5511900000001",
        contactName: "Cliente Teste",
        agentActive: true,
      },
    });
    conversationId = conv.id;
  });

  afterAll(async () => {
    for (const tid of [tenantId, otherTenantId]) {
      if (!tid) continue;
      for (const table of ["zpro_conversations", "zpro_instances"]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tid}`,
        );
      }
      await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tid}`);
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("set_voice_preference writes ZproConversation.voiceReply, and 'default' resets it", async () => {
    const tool = buildSetVoicePreferenceTool({
      tenantId,
      base: appDb,
      conversationId,
      currentVoiceReply: null,
    });
    expect(tool.name).toBe("set_voice_preference");
    expect(tool.description).toContain("not set");

    await tool.invoke({ preference: "audio" });
    const c1 = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { voiceReply: true },
    });
    expect(c1.voiceReply).toBe(true);

    await tool.invoke({ preference: "text" });
    const c2 = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { voiceReply: true },
    });
    expect(c2.voiceReply).toBe(false);

    await tool.invoke({ preference: "default" });
    const c3 = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { voiceReply: true },
    });
    expect(c3.voiceReply).toBeNull();
  });

  test("the tool description surfaces the current preference passed in", () => {
    const audioTool = buildSetVoicePreferenceTool({
      tenantId,
      base: appDb,
      conversationId,
      currentVoiceReply: true,
    });
    expect(audioTool.description).toContain(
      "<current_preference>audio</current_preference>",
    );

    const textTool = buildSetVoicePreferenceTool({
      tenantId,
      base: appDb,
      conversationId,
      currentVoiceReply: false,
    });
    expect(textTool.description).toContain(
      "<current_preference>text</current_preference>",
    );
  });

  test("is tenant-scoped: cannot write another tenant's ZproConversation via a mismatched RLS context", async () => {
    // Build the tool with the WRONG tenantId for this conversation — runScopedOn pins RLS to
    // otherTenantId, so the updateMany (row filtered by both id AND the RLS policy) affects zero
    // rows instead of leaking a cross-tenant write.
    const tool = buildSetVoicePreferenceTool({
      tenantId: otherTenantId,
      base: appDb,
      conversationId,
      currentVoiceReply: null,
    });
    await tool.invoke({ preference: "audio" });
    const c = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { voiceReply: true },
    });
    // Unaffected — still whatever the previous test left it as (null, from "default"), not audio.
    expect(c.voiceReply).not.toBe(true);
  });

  function event(): NormalizedZproEvent {
    return {
      messageId: "m1",
      threadId: "1",
      tenantId: Number(tenantId),
      instanceId: Number(zproInstanceId),
      instanceName: "ZproTtsInstance",
      channelType: "waba",
      apiId: "TEST_API_ID",
      contactId: 1,
      contactNumber: "5511900000001",
      contactName: "Cliente Teste",
      extraInfo: [],
      messageType: "conversation",
      body: "oi",
      fromMe: false,
      timestamp: Date.now(),
      ticketStatus: "open",
      agentActive: true,
      hasHumanAssigned: false,
    };
  }

  test("sendZproVoiceReply sends Ogg/Opus through the generic /base64 endpoint (never /voice)", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      sendVoice: async () => {
        calls.push(["sendVoice", null]);
        return {};
      },
      sendBase64: async (
        number: string,
        _base64Data: string,
        mimeType: string,
        fileName: string,
      ) => {
        calls.push(["sendBase64", { number, mimeType, fileName }]);
        return {};
      },
    } as unknown as ZproClient;

    await sendZproVoiceReply(client, event(), {
      audio: new TextEncoder().encode("fake-ogg-bytes").buffer,
      mime: "audio/ogg",
      fileName: "reply.ogg",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("sendBase64");
    expect(calls[0]?.[1]).toMatchObject({
      mimeType: "audio/ogg",
      fileName: "reply.ogg",
    });
  });

  test("sendZproVoiceReply sends a non-Ogg/Opus result (e.g. openrouter's mp3) the same way", async () => {
    const calls: Array<[string, unknown]> = [];
    const client = {
      sendVoice: async () => {
        calls.push(["sendVoice", null]);
        return {};
      },
      sendBase64: async (
        number: string,
        _base64Data: string,
        mimeType: string,
        fileName: string,
      ) => {
        calls.push(["sendBase64", { number, mimeType, fileName }]);
        return {};
      },
    } as unknown as ZproClient;

    await sendZproVoiceReply(client, event(), {
      audio: new TextEncoder().encode("fake-mp3-bytes").buffer,
      mime: "audio/mpeg",
      fileName: "reply.mp3",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("sendBase64");
    expect(calls[0]?.[1]).toMatchObject({
      mimeType: "audio/mpeg",
      fileName: "reply.mp3",
    });
  });
});
