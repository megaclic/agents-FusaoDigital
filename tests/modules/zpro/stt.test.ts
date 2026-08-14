// tests/modules/zpro/stt.test.ts
// DB-backed: mirrors tests/modules/stt.test.ts (Chatwoot) for the Z-PRO path — resolveZproSttConfig
// resolves the bound agent's config via ZproAgentBinding (not Inbox.agentId), and
// transcribeZproAudio downloads the raw WhatsApp CDN url (anti-SSRF checked) instead of an
// authenticated Chatwoot attachment.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { SttConfig } from "@/modules/stt/settings";
import { resolveZproSttConfig, transcribeZproAudio } from "@/modules/zpro/stt";

// Mirrors the encrypt-then-package half of the WhatsApp media protocol (see media-crypto.ts /
// media-crypto.test.ts) so these tests can produce a fixture that transcribeZproAudio's
// decryption step is expected to unwrap.
function encryptWhatsappAudioForTest(plaintext: Buffer) {
  const mediaKey = randomBytes(32);
  const expanded = Buffer.from(
    hkdfSync(
      "sha256",
      mediaKey,
      Buffer.alloc(0),
      Buffer.from("WhatsApp Audio Keys"),
      112,
    ),
  );
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);
  const cipher = createCipheriv("aes-256-cbc", cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const mac = createHmac("sha256", macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
    .subarray(0, 10);
  return {
    packaged: Buffer.concat([ciphertext, mac]),
    mediaKeyBase64: mediaKey.toString("base64"),
  };
}

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
let sttKeyId = 0n;

const TRANSCRIPT = "olá, gostaria de agendar uma consulta";
// A real, always-resolvable domain — transcribeZproAudio anti-SSRF-checks the URL for real (DNS
// lookup) before the injected fetchImpl ever runs, unlike Chatwoot's stubbed-client test.
const AUDIO_URL = "https://example.com/audio.ogg";

function sttFetch(text: string) {
  return (async () =>
    new Response(JSON.stringify({ text }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe.skipIf(!dbUp)("zpro stt", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproStt", slug: `zpro-stt-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 89,
        instanceName: "ZproSttInstance",
      },
    });
    zproInstanceId = inst.id;
    const sttKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "stt-key", secret: encryptJson("sk-stt") },
      select: { id: true },
    });
    sttKeyId = sttKey.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente Z-PRO",
        systemPrompt: "x",
        settings: {
          stt: {
            enabled: true,
            provider: "openai",
            credentialRef: `vault:${sttKeyId}`,
          },
        },
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
        "zpro_agent_bindings",
        "agents",
        "vault_entries",
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

  test("resolveZproSttConfig returns the bound agent's enabled config", async () => {
    const cfg = await resolveZproSttConfig(tenantId, zproInstanceId, appDb);
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.provider).toBe("openai");
    expect(cfg?.credentialRef).toBe(`vault:${sttKeyId}`);
  });

  test("resolveZproSttConfig returns null for an unbound instance", async () => {
    expect(await resolveZproSttConfig(tenantId, 9_999_999n, appDb)).toBeNull();
  });

  test("transcribeZproAudio downloads (anti-SSRF checked) and transcribes", async () => {
    const cfg = (await resolveZproSttConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as SttConfig;
    const text = await transcribeZproAudio({
      tenantId,
      mediaUrl: AUDIO_URL,
      mediaMimetype: "audio/ogg; codecs=opus",
      cfg,
      base: appDb,
      deps: { fetchImpl: sttFetch(TRANSCRIPT) },
    });
    expect(text).toBe(TRANSCRIPT);
  });

  test("transcribeZproAudio returns null when no credential is configured", async () => {
    const text = await transcribeZproAudio({
      tenantId,
      mediaUrl: AUDIO_URL,
      mediaMimetype: "audio/ogg",
      cfg: {
        enabled: true,
        provider: "openai",
        model: "",
        language: "pt",
        credentialRef: null,
        baseURL: null,
      },
      base: appDb,
      deps: { fetchImpl: sttFetch(TRANSCRIPT) },
    });
    expect(text).toBeNull();
  });

  test("transcribeZproAudio blocks a private/loopback media url (anti-SSRF)", async () => {
    const cfg = (await resolveZproSttConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as SttConfig;
    const text = await transcribeZproAudio({
      tenantId,
      mediaUrl: "https://127.0.0.1/audio.ogg",
      mediaMimetype: "audio/ogg",
      cfg,
      base: appDb,
      deps: { fetchImpl: sttFetch(TRANSCRIPT) },
    });
    expect(text).toBeNull();
  });

  test("transcribeZproAudio decrypts the WhatsApp media before transcribing", async () => {
    const cfg = (await resolveZproSttConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as SttConfig;
    const plaintext = Buffer.from("not-really-ogg-opus-bytes");
    const { packaged, mediaKeyBase64 } = encryptWhatsappAudioForTest(plaintext);
    let sentToProvider: Buffer | null = null;
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const href =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("/audio/transcriptions")) {
        const form = init?.body as FormData;
        const file = form.get("file") as Blob;
        sentToProvider = Buffer.from(await file.arrayBuffer());
        return new Response(JSON.stringify({ text: TRANSCRIPT }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      // The media-download leg: WhatsApp's CDN serves the ENCRYPTED bytes under a generic
      // transport content-type, unrelated to the real (plaintext) mimetype.
      return new Response(new Uint8Array(packaged), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;

    const text = await transcribeZproAudio({
      tenantId,
      mediaUrl: AUDIO_URL,
      mediaMimetype: "audio/ogg; codecs=opus",
      mediaKey: mediaKeyBase64,
      cfg,
      base: appDb,
      deps: { fetchImpl },
    });

    expect(text).toBe(TRANSCRIPT);
    expect(sentToProvider).not.toBeNull();
    expect((sentToProvider as unknown as Buffer).toString("utf-8")).toBe(
      plaintext.toString("utf-8"),
    );
  });

  test("transcribeZproAudio returns null (never calls the provider) when the mediaKey is wrong", async () => {
    const cfg = (await resolveZproSttConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as SttConfig;
    const { packaged } = encryptWhatsappAudioForTest(Buffer.from("hello"));
    let providerCalled = false;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("/audio/transcriptions")) {
        providerCalled = true;
        return new Response(JSON.stringify({ text: TRANSCRIPT }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(new Uint8Array(packaged), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;

    const text = await transcribeZproAudio({
      tenantId,
      mediaUrl: AUDIO_URL,
      mediaMimetype: "audio/ogg",
      mediaKey: randomBytes(32).toString("base64"), // wrong key — MAC won't match
      cfg,
      base: appDb,
      deps: { fetchImpl },
    });

    expect(text).toBeNull();
    expect(providerCalled).toBe(false);
  });

  test("the Amara.org hallucination is dropped", async () => {
    const cfg = (await resolveZproSttConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as SttConfig;
    const text = await transcribeZproAudio({
      tenantId,
      mediaUrl: AUDIO_URL,
      mediaMimetype: "audio/ogg",
      cfg,
      base: appDb,
      deps: { fetchImpl: sttFetch("Legendas pela comunidade Amara.org") },
    });
    expect(text).toBeNull();
  });
});
