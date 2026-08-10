// src/modules/zpro/parse.ts
// Extração de corpo de texto e mídia de uma mensagem Z-PRO. Compartilhado entre normalize.ts (gate
// do agente, só roda para eventos que passam no gate) e mirror.ts (espelho de TODAS as mensagens,
// inclusive as que o gate descarta), para não duplicar a mesma lógica de parsing duas vezes.

import type { ZproMsgContent, ZproMsgTop, ZproWebhookPayload } from "./types";

export interface MediaExtracted {
  mediaUrl?: string;
  mediaCaption?: string;
  mediaMimetype?: string;
  mediaFileName?: string;
}

export function extractMedia(
  content: ZproMsgContent | undefined,
): MediaExtracted {
  if (!content) return {};

  if (content.audioMessage) {
    return {
      mediaUrl: content.audioMessage.url,
      mediaMimetype: content.audioMessage.mimetype,
    };
  }
  if (content.imageMessage) {
    return {
      mediaUrl: content.imageMessage.url,
      mediaCaption: content.imageMessage.caption,
      mediaMimetype: content.imageMessage.mimetype,
    };
  }
  if (content.videoMessage) {
    return {
      mediaUrl: content.videoMessage.url,
      mediaCaption: content.videoMessage.caption,
      mediaMimetype: content.videoMessage.mimetype,
    };
  }
  if (content.documentMessage) {
    return {
      mediaUrl: content.documentMessage.url,
      mediaCaption: content.documentMessage.caption, // texto enviado junto
      mediaMimetype: content.documentMessage.mimetype,
      mediaFileName:
        content.documentMessage.fileName ?? content.documentMessage.title,
    };
  }
  if (content.stickerMessage) {
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
    toWhatsappId(payload.whatsapp?.id) ?? toWhatsappId(payload.ticket?.whatsappId)
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
