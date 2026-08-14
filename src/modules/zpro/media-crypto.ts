// src/modules/zpro/media-crypto.ts
// Decripta mídia inbound do WhatsApp (protocolo multi-device do próprio WhatsApp, não algo do
// Z-PRO/Evolution API) — confirmado via diagnóstico ao vivo que o payload do webhook Z-PRO traz
// `mediaKey`/`fileEncSha256`/`directPath` no objeto da mensagem, e a mediaUrl aponta pro CDN
// criptografado da própria WhatsApp (mmg.whatsapp.net/…/….enc). Sem decriptar aqui, stt.ts/vision.ts
// mandavam bytes cifrados pro provedor (OpenAI etc.) e todo áudio/imagem falhava (STT: "openai 400").
//
// Protocolo (estável há anos, documentado por sigalor/whatsapp-web-reveng e implementado por
// Baileys/whatsapp-web.js): HKDF-SHA256 sem salt expande a `mediaKey` (32 bytes, já em base64 no
// payload) em 112 bytes — iv(16) | cipherKey(32) | macKey(32) | refKey(32, não usado aqui). O
// blob baixado é `ciphertext || hmac[0:10]`; valida o MAC antes de decriptar (evita decriptar lixo
// silenciosamente com uma chave errada) e então AES-256-CBC(cipherKey, iv) sobre o ciphertext.
import { createDecipheriv, createHmac, hkdfSync } from "node:crypto";

const HKDF_INFO_BY_MEDIA_TYPE = {
  audio: "WhatsApp Audio Keys",
  image: "WhatsApp Image Keys",
  video: "WhatsApp Video Keys",
  document: "WhatsApp Document Keys",
} as const;

export type WhatsappMediaType = keyof typeof HKDF_INFO_BY_MEDIA_TYPE;

const EXPANDED_KEY_LENGTH = 112;
const MAC_LENGTH = 10;

// Throws on a malformed key or a MAC mismatch (wrong key / corrupted download) — callers treat
// this the same as any other download/provider failure (log + degrade, never crash the webhook).
// Returns a plain ArrayBuffer (not Buffer/Uint8Array) so callers can hand it straight to the same
// STT/vision provider APIs that already accept the pre-decryption download's ArrayBuffer.
export function decryptWhatsappMedia(
  encrypted: ArrayBuffer,
  mediaKeyBase64: string,
  mediaType: WhatsappMediaType,
): ArrayBuffer {
  const mediaKey = Buffer.from(mediaKeyBase64, "base64");
  if (mediaKey.length !== 32) {
    throw new Error(`unexpected WhatsApp mediaKey length: ${mediaKey.length}`);
  }

  const expanded = Buffer.from(
    hkdfSync(
      "sha256",
      mediaKey,
      Buffer.alloc(0),
      Buffer.from(HKDF_INFO_BY_MEDIA_TYPE[mediaType]),
      EXPANDED_KEY_LENGTH,
    ),
  );
  const iv = expanded.subarray(0, 16);
  const cipherKey = expanded.subarray(16, 48);
  const macKey = expanded.subarray(48, 80);

  const file = Buffer.from(encrypted);
  if (file.length <= MAC_LENGTH) {
    throw new Error("encrypted media too short to contain a trailing MAC");
  }
  const ciphertext = file.subarray(0, file.length - MAC_LENGTH);
  const mac = file.subarray(file.length - MAC_LENGTH);

  const expectedMac = createHmac("sha256", macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
    .subarray(0, MAC_LENGTH);
  if (!expectedMac.equals(mac)) {
    throw new Error(
      "WhatsApp media MAC verification failed (wrong mediaKey or corrupted download)",
    );
  }

  const decipher = createDecipheriv("aes-256-cbc", cipherKey, iv);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.buffer.slice(
    plaintext.byteOffset,
    plaintext.byteOffset + plaintext.byteLength,
  ) as ArrayBuffer;
}
