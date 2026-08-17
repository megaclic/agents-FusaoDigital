// src/modules/zpro/parse.ts
// Extração de corpo de texto e mídia de uma mensagem Z-PRO. Compartilhado entre normalize.ts (gate
// do agente, só roda para eventos que passam no gate) e mirror.ts (espelho de TODAS as mensagens,
// inclusive as que o gate descarta), para não duplicar a mesma lógica de parsing duas vezes.

import type { WhatsappMediaType } from "./media-crypto";
import type {
  ZproContactTagRef,
  ZproMsgContent,
  ZproMsgData,
  ZproMsgTop,
  ZproWebhookPayload,
} from "./types";

export interface MediaExtracted {
  mediaUrl?: string;
  mediaCaption?: string;
  mediaMimetype?: string;
  mediaFileName?: string;
  // base64 WhatsApp media key + which WhatsApp message type it came from — both needed by
  // media-crypto.ts's decryptWhatsappMedia (the HKDF info string is type-specific). Absent means
  // either the content has no media, or (defensively) a payload shape without the field.
  mediaKey?: string;
  mediaType?: WhatsappMediaType;
}

// `mediaKey`'s wire shape is UNCONFIRMED and has already changed once: the protocol calls for a
// base64 string, but a live capture (2026-08-14) showed a plain array-like object instead
// (`{"0":n,"1":n,...,"31":n}` — a Buffer/Uint8Array serialized without its `.toJSON()`, so it lost
// its array-ness over the wire). Accepts either shape (plus a real byte array, for good measure)
// and normalizes to base64 for media-crypto.ts. Returns undefined — never throws — on anything
// else, so a THIRD future shape degrades to "can't decrypt" instead of crashing the webhook.
export function parseMediaKey(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.trim()) return raw;
  if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) {
    return Buffer.from(raw as number[]).toString("base64");
  }
  if (raw && typeof raw === "object") {
    const values = Object.values(raw as Record<string, unknown>);
    if (values.length > 0 && values.every((n) => typeof n === "number")) {
      return Buffer.from(values as number[]).toString("base64");
    }
  }
  return undefined;
}

// Maps ZproMessage.messageType (persisted verbatim from msg.type — "audioMessage"/"pttMessage"/
// "imageMessage"/etc.) back to a WhatsappMediaType, for callers that only have the stored
// messageType on hand (the /media proxy reads a persisted row, not a live webhook content object,
// so it can't use extractMedia's `content.audioMessage`-shaped branching directly).
export function whatsappMediaTypeForMessageType(
  messageType: string,
): WhatsappMediaType | null {
  switch (messageType) {
    case "audioMessage":
    case "pttMessage":
      return "audio";
    case "imageMessage":
      return "image";
    case "videoMessage":
      return "video";
    case "documentMessage":
      return "document";
    default:
      return null;
  }
}

export function extractMedia(
  content: ZproMsgContent | undefined,
): MediaExtracted {
  if (!content) return {};

  if (content.audioMessage) {
    return {
      mediaUrl: content.audioMessage.url,
      mediaMimetype: content.audioMessage.mimetype,
      mediaKey: parseMediaKey(content.audioMessage.mediaKey),
      mediaType: "audio",
    };
  }
  if (content.imageMessage) {
    return {
      mediaUrl: content.imageMessage.url,
      mediaCaption: content.imageMessage.caption,
      mediaMimetype: content.imageMessage.mimetype,
      mediaKey: parseMediaKey(content.imageMessage.mediaKey),
      mediaType: "image",
    };
  }
  if (content.videoMessage) {
    return {
      mediaUrl: content.videoMessage.url,
      mediaCaption: content.videoMessage.caption,
      mediaMimetype: content.videoMessage.mimetype,
      mediaKey: parseMediaKey(content.videoMessage.mediaKey),
      mediaType: "video",
    };
  }
  if (content.documentMessage) {
    return {
      mediaUrl: content.documentMessage.url,
      mediaCaption: content.documentMessage.caption, // texto enviado junto
      mediaMimetype: content.documentMessage.mimetype,
      mediaFileName:
        content.documentMessage.fileName ?? content.documentMessage.title,
      mediaKey: parseMediaKey(content.documentMessage.mediaKey),
      mediaType: "document",
    };
  }
  if (content.stickerMessage) {
    // Sem mediaKey no tipo — nada hoje decripta sticker (extractMedia's caller for STT/vision
    // never matches stickerMessage), então não há necessidade de fiar isso ainda.
    return {
      mediaUrl: content.stickerMessage.url,
      mediaMimetype: content.stickerMessage.mimetype,
    };
  }
  return {};
}

// Texto principal de uma mensagem: body para "conversation", extendedTextMessage.text para rich
// text, ou caption da mídia como fallback, ou string vazia.
export function extractMessageBody(msg: ZproMsgTop): string {
  const content = msg.data?.message;
  return (
    msg.body ??
    content?.extendedTextMessage?.text ??
    content?.imageMessage?.caption ??
    content?.videoMessage?.caption ??
    content?.documentMessage?.caption ??
    ""
  );
}

const QUOTE_MAX = 200;

// contextInfo (WhatsApp's "reply to a specific message" metadata) location CONFIRMED live
// (2026-08-14, 12 real captures via the ngrok inspector, 100% consistent): it lives at the
// top-level `data.contextInfo`, a SIBLING of `message` — NOT nested under
// extendedTextMessage.contextInfo as the standard Baileys convention would suggest. A reply to
// plain text stays typed "conversation" on this wire format; it is never upgraded to
// "extendedTextMessage" the way vanilla Baileys does. The extendedTextMessage/media-type
// candidates are kept as defensive fallbacks (never observed, but harmless — same posture as
// parseMediaKey/parseContactTags) in case some other channel or a future payload shape differs.
function findContextInfo(
  content: ZproMsgContent | undefined,
  data: ZproMsgData | undefined,
): Record<string, unknown> | undefined {
  const candidates: unknown[] = [
    content?.extendedTextMessage?.contextInfo,
    content?.audioMessage?.contextInfo,
    content?.imageMessage?.contextInfo,
    content?.videoMessage?.contextInfo,
    content?.documentMessage?.contextInfo,
    data?.contextInfo,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate as Record<string, unknown>;
    }
  }
  return undefined;
}

// Same fallback chain as extractMessageBody, PLUS a type marker for uncaptioned media (the quoted
// message is a frozen snapshot embedded in contextInfo — unlike a live inbound message it will
// never get an STT/vision write-back, so "no text" needs its own signal instead of silently
// disappearing from the reply's context).
function describeQuotedContent(content: ZproMsgContent): string {
  const text = (
    content.conversation ??
    content.extendedTextMessage?.text ??
    content.imageMessage?.caption ??
    content.videoMessage?.caption ??
    content.documentMessage?.caption ??
    ""
  ).trim();
  if (text) return text;
  if (content.audioMessage) return "<mensagem de áudio>";
  if (content.imageMessage) return "<imagem>";
  if (content.videoMessage) return "<vídeo>";
  if (content.documentMessage) return "<documento>";
  return "";
}

// Extracts the referenced message's own text/caption when `msg` is a WhatsApp reply — WhatsApp
// embeds the quoted message's content INLINE in contextInfo.quotedMessage (no lookup by stanzaId
// needed, unlike Chatwoot's in_reply_to which points at an id resolved separately).
export function extractQuotedText(msg: ZproMsgTop): string | undefined {
  const ctxInfo = findContextInfo(msg.data?.message, msg.data);
  const quotedMessage = ctxInfo?.quotedMessage;
  if (!quotedMessage || typeof quotedMessage !== "object") return undefined;
  const text = describeQuotedContent(quotedMessage as ZproMsgContent);
  if (!text) return undefined;
  return text.replace(/\s+/g, " ").trim().slice(0, QUOTE_MAX);
}

// Prefixes a message's text with a "replying to: ..." marker when it's a WhatsApp reply — same
// `<em resposta a: "...">` convention chatwoot/render.ts uses for in_reply_to, so both channels
// read identically to the agent. `quotedText` alone (empty body) renders as a marker-only line
// rather than being dropped, so a bare reply to a prior message still carries its context.
export function withQuotedPrefix(
  body: string,
  quotedText: string | null | undefined,
): string {
  if (!quotedText) return body;
  const prefix = `<em resposta a: "${quotedText}">`;
  return body ? `${prefix}\n${body}` : prefix;
}

// Mirrors chatwoot/render.ts's audio/image/generic-file fallback markers (same Portuguese wording,
// for consistency across channels) — a media message whose STT/vision extraction produced nothing
// must not read as "nothing happened" to the agent. This closes the KNOWN GAP documented in
// docs/zpro.md's "Audio transcription" section: before the WhatsApp media decrypt fix, EVERY voice
// note hit this path (100% silent-drop rate, no reply and no visible error to the customer); now
// it also covers the rarer genuine STT/vision hiccup, plus every OTHER type nothing ever extracts
// from (video/sticker) and images when vision is off/unconfigured. `messageType` is the raw
// ZproMsgTop.type string ("audioMessage"/"pttMessage"/"imageMessage"/…). A "conversation" (plain
// text) message with a genuinely empty body still degrades to "" here — correctly: there is
// nothing to answer, not a failed extraction.
export function withMediaFallback(body: string, messageType: string): string {
  const text = body.trim();
  if (text) return text;
  switch (messageType) {
    case "audioMessage":
    case "pttMessage":
      return "<mensagem de áudio não audível; peça que o cliente reenvie por texto>";
    case "imageMessage":
      return "<usuário enviou uma imagem; peça que envie a informação por texto ou áudio>";
    case "documentMessage":
    case "videoMessage":
    case "stickerMessage":
      return `<usuário enviou um arquivo do tipo '${messageType}'; não foi possível extrair o conteúdo>`;
    default:
      return "";
  }
}

// Nem todo canal do Z-PRO manda `whatsapp` na raiz do payload (confirmado: o canal "evo" manda;
// o webhook global atual, para outros canais, só traz `ticket.whatsappId`). Tenta as fontes em
// ordem de confiabilidade antes de desistir.
function toWhatsappId(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
    return Number(v);
  }
  return null;
}

export function extractWhatsappId(payload: ZproWebhookPayload): number | null {
  return (
    toWhatsappId(payload.whatsapp?.id) ??
    toWhatsappId(payload.ticket?.whatsappId)
  );
}

// Nome de exibição do canal, com a mesma degradação de fontes: `whatsapp` na raiz nem sempre
// existe, então cai para o `instance`/`instanceId` que o próprio `msg` carrega.
export function extractInstanceName(payload: ZproWebhookPayload): string {
  return (
    payload.whatsapp?.name ??
    payload.msg?.instance ??
    payload.msg?.data?.instanceId ??
    "unknown"
  );
}

// whatsappId é único só POR TENANT (@@unique([tenantId, whatsappId]) no schema — duas instalações
// Z-PRO independentes em tenants diferentes podem reportar o mesmo id). Desambigua candidatos via
// msg.apikey (presente no payload real capturado, types.ts) contra o apiId de cada instância (o
// segmento da URL). null significa "não adivinhar" — rotear pro tenant errado vazaria silenciosamente
// a conversa de um cliente pro tenant errado, então o chamador deve descartar a entrega nesse caso.
// contact.tags's shape is UNCONFIRMED (the vendor's Postman collection ships no example response
// for any contact endpoint) — accepts the two most plausible shapes (an array of {id,name}-ish
// objects, or a bare array of ids/names) and keeps whichever of id/name each entry actually has;
// the missing half (if any) is resolved against the tags catalog (crm.ts's loadZproTags) at READ
// time, not here — this function has no network access and must never throw. Degrades to [] on any
// other shape.
export function parseContactTags(raw: unknown): ZproContactTagRef[] {
  if (!Array.isArray(raw)) return [];
  const out: ZproContactTagRef[] = [];
  for (const item of raw) {
    if (typeof item === "number" && Number.isInteger(item) && item > 0) {
      out.push({ id: item, name: null });
      continue;
    }
    if (typeof item === "string" && item.trim()) {
      out.push({ id: null, name: item.trim() });
      continue;
    }
    if (item && typeof item === "object") {
      const o = item as Record<string, unknown>;
      const id =
        typeof o.id === "number" && Number.isInteger(o.id) && o.id > 0
          ? o.id
          : null;
      const name =
        typeof o.name === "string" && o.name.trim() ? o.name.trim() : null;
      if (id != null || name != null) out.push({ id, name });
    }
  }
  return out;
}

export function resolveZproInstanceCandidate<T extends { apiId: string }>(
  candidates: T[],
  apikey: string | undefined,
): T | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;
  if (!apikey) return null;
  const matches = candidates.filter((c) => c.apiId === apikey);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}
