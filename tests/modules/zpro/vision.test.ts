// tests/modules/zpro/vision.test.ts
// DB-backed: mirrors tests/modules/zpro/stt.test.ts's structure for the Z-PRO vision path —
// resolveZproVisionConfig resolves the bound agent's config via ZproAgentBinding (not
// Inbox.agentId), and extractZproFile downloads the raw WhatsApp CDN url (anti-SSRF checked)
// instead of an authenticated Chatwoot attachment.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { VisionConfig } from "@/modules/vision/settings";
import {
  extractZproFile,
  resolveZproVisionConfig,
} from "@/modules/zpro/vision";

// Mirrors the encrypt-then-package half of the WhatsApp media protocol (see media-crypto.ts /
// media-crypto.test.ts) so these tests can produce a fixture that extractZproFile's decryption
// step is expected to unwrap.
function encryptWhatsappImageForTest(plaintext: Buffer) {
  const mediaKey = randomBytes(32);
  const expanded = Buffer.from(
    hkdfSync(
      "sha256",
      mediaKey,
      Buffer.alloc(0),
      Buffer.from("WhatsApp Image Keys"),
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
let visionKeyId = 0n;

const DESCRIPTION = "uma nota fiscal de R$150,00 emitida em 10/08/2026";
// A real, always-resolvable domain — extractZproFile anti-SSRF-checks the URL for real (DNS
// lookup) before the injected fetchImpl ever runs, unlike Chatwoot's stubbed-client test.
const IMAGE_URL = "https://example.com/photo.jpg";

// The same fetchImpl serves BOTH calls extractZproFile makes: the raw media download (must return
// the real bytes' content-type, since visionKindForMime classifies off the DOWNLOADED type, not
// the WhatsApp payload's mediaMimetype — mirrors Chatwoot's own re-derivation from the real
// response) and the provider's chat-completions call. Routed by URL.
function visionFetch(mimeType: string, content: string): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href =
      typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
    if (href.includes("/chat/completions")) {
      return new Response(
        JSON.stringify({ choices: [{ message: { content } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": mimeType },
    });
  }) as unknown as typeof fetch;
}

describe.skipIf(!dbUp)("zpro vision", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproVision", slug: `zpro-vision-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 92,
        instanceName: "ZproVisionInstance",
      },
    });
    zproInstanceId = inst.id;
    const visionKey = await suDb.vaultEntry.create({
      data: { tenantId, name: "vision-key", secret: encryptJson("sk-vision") },
      select: { id: true },
    });
    visionKeyId = visionKey.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente Z-PRO",
        systemPrompt: "x",
        settings: {
          vision: {
            enabled: true,
            provider: "openai",
            credentialRef: `vault:${visionKeyId}`,
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

  test("resolveZproVisionConfig returns the bound agent's enabled config", async () => {
    const cfg = await resolveZproVisionConfig(tenantId, zproInstanceId, appDb);
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.provider).toBe("openai");
    expect(cfg?.credentialRef).toBe(`vault:${visionKeyId}`);
  });

  test("resolveZproVisionConfig returns null for an unbound instance", async () => {
    expect(
      await resolveZproVisionConfig(tenantId, 9_999_999n, appDb),
    ).toBeNull();
  });

  test("extractZproFile downloads (anti-SSRF checked) and extracts an image", async () => {
    const cfg = (await resolveZproVisionConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as VisionConfig;
    const result = await extractZproFile({
      tenantId,
      mediaUrl: IMAGE_URL,
      mediaMimetype: "image/jpeg",
      cfg,
      base: appDb,
      deps: { fetchImpl: visionFetch("image/jpeg", DESCRIPTION) },
    });
    expect(result?.kind).toBe("image");
    expect(result?.text).toBe(DESCRIPTION);
  });

  test("extractZproFile returns null when no credential is configured", async () => {
    const result = await extractZproFile({
      tenantId,
      mediaUrl: IMAGE_URL,
      mediaMimetype: "image/jpeg",
      cfg: {
        enabled: true,
        provider: "openai",
        model: "",
        credentialRef: null,
        baseURL: null,
        extractionPrompt: "describe this",
      },
      base: appDb,
      deps: { fetchImpl: visionFetch("image/jpeg", DESCRIPTION) },
    });
    expect(result).toBeNull();
  });

  test("extractZproFile blocks a private/loopback media url (anti-SSRF)", async () => {
    const cfg = (await resolveZproVisionConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as VisionConfig;
    const result = await extractZproFile({
      tenantId,
      mediaUrl: "https://127.0.0.1/photo.jpg",
      mediaMimetype: "image/jpeg",
      cfg,
      base: appDb,
      deps: { fetchImpl: visionFetch("image/jpeg", DESCRIPTION) },
    });
    expect(result).toBeNull();
  });

  test("extractZproFile decrypts the WhatsApp media before extracting", async () => {
    const cfg = (await resolveZproVisionConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as VisionConfig;
    const plaintext = Buffer.from([0xff, 0xd8, 0xff, 1, 2, 3]); // fake jpeg-ish bytes
    const { packaged, mediaKeyBase64 } = encryptWhatsappImageForTest(plaintext);
    let sentToProvider: Buffer | null = null;
    const fetchImpl = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const href =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("/chat/completions")) {
        const body = JSON.parse(String(init?.body)) as {
          messages: Array<{
            content: Array<{ image_url?: { url: string } }>;
          }>;
        };
        const dataUri = body.messages[0]?.content.find((c) => c.image_url)
          ?.image_url?.url;
        const b64 = dataUri?.split(",")[1] ?? "";
        sentToProvider = Buffer.from(b64, "base64");
        return new Response(
          JSON.stringify({ choices: [{ message: { content: DESCRIPTION } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // The media-download leg: WhatsApp's CDN serves the ENCRYPTED bytes under a generic
      // transport content-type, unrelated to the real (plaintext) mimetype.
      return new Response(new Uint8Array(packaged), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;

    const result = await extractZproFile({
      tenantId,
      mediaUrl: IMAGE_URL,
      mediaMimetype: "image/jpeg",
      mediaKey: mediaKeyBase64,
      mediaType: "image",
      cfg,
      base: appDb,
      deps: { fetchImpl },
    });

    expect(result?.kind).toBe("image");
    expect(result?.text).toBe(DESCRIPTION);
    expect(sentToProvider).not.toBeNull();
    expect((sentToProvider as unknown as Buffer).equals(plaintext)).toBe(true);
  });

  test("extractZproFile returns null (never calls the provider) when the mediaKey is wrong", async () => {
    const cfg = (await resolveZproVisionConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as VisionConfig;
    const { packaged } = encryptWhatsappImageForTest(Buffer.from("hello"));
    let providerCalled = false;
    const fetchImpl = (async (url: string | URL | Request) => {
      const href =
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      if (href.includes("/chat/completions")) {
        providerCalled = true;
        return new Response(
          JSON.stringify({ choices: [{ message: { content: DESCRIPTION } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(new Uint8Array(packaged), {
        status: 200,
        headers: { "content-type": "application/octet-stream" },
      });
    }) as unknown as typeof fetch;

    const result = await extractZproFile({
      tenantId,
      mediaUrl: IMAGE_URL,
      mediaMimetype: "image/jpeg",
      mediaKey: randomBytes(32).toString("base64"), // wrong key — MAC won't match
      mediaType: "image",
      cfg,
      base: appDb,
      deps: { fetchImpl },
    });

    expect(result).toBeNull();
    expect(providerCalled).toBe(false);
  });

  test("an unsupported mime (e.g. svg) is skipped, not sent to the provider", async () => {
    const cfg = (await resolveZproVisionConfig(
      tenantId,
      zproInstanceId,
      appDb,
    )) as VisionConfig;
    const result = await extractZproFile({
      tenantId,
      mediaUrl: IMAGE_URL,
      mediaMimetype: "image/svg+xml",
      cfg,
      base: appDb,
      deps: { fetchImpl: visionFetch("image/svg+xml", DESCRIPTION) },
    });
    expect(result).toBeNull();
  });
});
