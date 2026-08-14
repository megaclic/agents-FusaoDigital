// tests/modules/zpro/media-crypto.test.ts
// Pure unit tests for decryptWhatsappMedia (no DB, no network) — validates the protocol
// implementation (HKDF-SHA256 + AES-256-CBC + HMAC-SHA256 MAC, RFC framing shared with
// Baileys/whatsapp-web-reveng) against locally-encrypted fixtures, since we have no captured real
// WhatsApp media to test against.

import { describe, expect, test } from "bun:test";
import { createCipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import {
  decryptWhatsappMedia,
  type WhatsappMediaType,
} from "@/modules/zpro/media-crypto";

const HKDF_INFO: Record<WhatsappMediaType, string> = {
  audio: "WhatsApp Audio Keys",
  image: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  document: "WhatsApp Document Keys",
};

// Mirrors the encrypt-then-package half of the protocol (what WhatsApp's own client does) so the
// decrypt half under test can be validated end to end against a known plaintext.
function encryptWhatsappMediaForTest(
  plaintext: Buffer,
  mediaKey: Buffer,
  mediaType: WhatsappMediaType,
): { packaged: ArrayBuffer; mediaKeyBase64: string } {
  const expanded = Buffer.from(
    hkdfSync(
      "sha256",
      mediaKey,
      Buffer.alloc(0),
      Buffer.from(HKDF_INFO[mediaType]),
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
  const packagedBuf = Buffer.concat([ciphertext, mac]);
  return {
    packaged: packagedBuf.buffer.slice(
      packagedBuf.byteOffset,
      packagedBuf.byteOffset + packagedBuf.byteLength,
    ) as ArrayBuffer,
    mediaKeyBase64: mediaKey.toString("base64"),
  };
}

describe("decryptWhatsappMedia", () => {
  test("round-trips a known plaintext for every media type", () => {
    for (const mediaType of Object.keys(HKDF_INFO) as WhatsappMediaType[]) {
      const mediaKey = randomBytes(32);
      const plaintext = Buffer.from(`fake ${mediaType} payload bytes`);
      const { packaged, mediaKeyBase64 } = encryptWhatsappMediaForTest(
        plaintext,
        mediaKey,
        mediaType,
      );
      const result = decryptWhatsappMedia(packaged, mediaKeyBase64, mediaType);
      expect(Buffer.from(result).toString("utf-8")).toBe(
        plaintext.toString("utf-8"),
      );
    }
  });

  test("throws on the wrong mediaKey (MAC verification fails)", () => {
    const mediaKey = randomBytes(32);
    const plaintext = Buffer.from("hello audio");
    const { packaged } = encryptWhatsappMediaForTest(
      plaintext,
      mediaKey,
      "audio",
    );
    expect(() =>
      decryptWhatsappMedia(
        packaged,
        randomBytes(32).toString("base64"),
        "audio",
      ),
    ).toThrow(/MAC verification failed/);
  });

  test("throws when the mediaKey base64 doesn't decode to 32 bytes", () => {
    const packaged = new ArrayBuffer(32);
    expect(() =>
      decryptWhatsappMedia(
        packaged,
        Buffer.from("too-short").toString("base64"),
        "audio",
      ),
    ).toThrow(/mediaKey length/);
  });

  test("throws when the payload is too short to contain a MAC", () => {
    const mediaKey = randomBytes(32);
    expect(() =>
      decryptWhatsappMedia(
        new ArrayBuffer(5),
        mediaKey.toString("base64"),
        "audio",
      ),
    ).toThrow(/too short/);
  });

  test("using the wrong media type (wrong HKDF info) fails the MAC check", () => {
    const mediaKey = randomBytes(32);
    const plaintext = Buffer.from("hello image");
    const { packaged, mediaKeyBase64 } = encryptWhatsappMediaForTest(
      plaintext,
      mediaKey,
      "image",
    );
    expect(() =>
      decryptWhatsappMedia(packaged, mediaKeyBase64, "document"),
    ).toThrow(/MAC verification failed/);
  });
});
