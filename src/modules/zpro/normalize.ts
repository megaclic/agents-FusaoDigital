// src/modules/zpro/normalize.ts
// Converte o payload bruto do webhook Z-PRO para NormalizedZproEvent.
// Retorna null quando o evento não deve ser processado pelo agente.
// Baseado em payloads reais capturados em 06/08/2026.

import { ZPRO_METHOD_MESSAGE } from "./constants";
import type {
  NormalizedZproEvent,
  ZproMessageType,
  ZproMsgContent,
  ZproWebhookPayload,
} from "./types";

interface MediaExtracted {
  mediaUrl?: string;
  mediaCaption?: string;
  mediaMimetype?: string;
  mediaFileName?: string;
}

function extractMedia(content: ZproMsgContent | undefined): MediaExtracted {
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

/**
 * Normaliza o payload do webhook Z-PRO.
 *
 * Retorna null (evento descartado) quando:
 * - method !== "message"
 * - msg.fromMe === true (mensagem enviada pelo atendente)
 * - ticket.isGroup === true
 * - ticket.botStopped === true
 * - ticket.n8nStatus === false (gate do agente desligado)
 * - campos obrigatórios ausentes
 *
 * @param payload   Payload bruto recebido no POST
 * @param apiId     ApiID da instância Z-PRO configurada no FusaoDigital agents
 */
export function normalizeZproWebhook(
  payload: ZproWebhookPayload,
  apiId: string,
): NormalizedZproEvent | null {
  // Filtra eventos que não são mensagem
  if (payload.method !== ZPRO_METHOD_MESSAGE) return null;

  const msg = payload.msg;
  const ticket = payload.ticket;
  const whatsapp = payload.whatsapp;

  if (!msg || !ticket || !whatsapp) return null;

  // Ignora mensagens enviadas pelo atendente
  if (msg.fromMe) return null;

  // Ignora grupos
  if (ticket.isGroup) return null;

  // Respeita flag de parada do bot
  if (ticket.botStopped) return null;

  // Gate central: só age quando o agente está ativo no ticket
  if (!ticket.n8nStatus) return null;

  const contact = ticket.contact;
  const messageType = (msg.type ?? "conversation") as ZproMessageType;
  const msgContent = msg.data?.message;

  // Texto principal: body para conversation, extendedTextMessage.text para rich text,
  // ou caption da mídia como fallback, ou string vazia
  const body =
    msg.body ??
    msgContent?.extendedTextMessage?.text ??
    msgContent?.imageMessage?.caption ??
    msgContent?.videoMessage?.caption ??
    msgContent?.documentMessage?.caption ??
    "";

  const media = extractMedia(msgContent);

  return {
    messageId: msg.id,
    threadId: String(ticket.id),
    tenantId: ticket.tenantId,
    instanceId: whatsapp.id,
    instanceName: whatsapp.name,
    channelType: whatsapp.type,
    apiId,
    contactId: contact.id,
    contactNumber: contact.number,
    contactName: contact.name ?? contact.pushname ?? contact.number,
    extraInfo: contact.extraInfo ?? [],
    messageType,
    body,
    ...media,
    fromMe: msg.fromMe,
    timestamp: msg.timestamp,
    ticketStatus: ticket.status,
    agentActive: ticket.n8nStatus,
    hasHumanAssigned: ticket.userId !== null,
  };
}
