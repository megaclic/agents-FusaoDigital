// src/modules/zpro/normalize.ts
// Converte o payload bruto do webhook Z-PRO para NormalizedZproEvent.
// Retorna null quando o evento não deve ser processado pelo agente.
// Baseado em payloads reais capturados em 06/08/2026.

import { ZPRO_METHOD_MESSAGE } from "./constants";
import {
  extractInstanceName,
  extractMedia,
  extractMessageBody,
  extractWhatsappId,
} from "./parse";
import type {
  NormalizedZproEvent,
  ResolvedZproInstance,
  ZproMessageType,
  ZproWebhookPayload,
} from "./types";

/**
 * Normaliza o payload do webhook Z-PRO.
 *
 * Retorna null (evento descartado) quando:
 * - method !== "message"
 * - msg.fromMe === true (mensagem enviada pelo atendente)
 * - ticket.isGroup === true
 * - ticket.botStopped === true
 * - ticket.n8nStatus === false (gate do agente desligado)
 * - msg/ticket ausentes, ou nenhuma fonte resolve um instanceId
 *
 * A identidade do canal (instanceId/instanceName/channelType) nem sempre vem no payload — alguns
 * canais do webhook global só trazem `ticket.whatsappId`, sem `whatsapp` na raiz. Prioridade:
 * 1) `payload.whatsapp` (fonte mais rica: id/name/type)
 * 2) `resolvedInstance` — o ZproInstance já resolvido pelo controller a partir do banco
 * 3) extração best-effort do payload cru (`extractWhatsappId`/`extractInstanceName`) e
 *    `ticket.channel` como channelType
 *
 * @param payload          Payload bruto recebido no POST
 * @param apiId            ApiID da instância Z-PRO configurada no FusaoDigital agents
 * @param resolvedInstance Instância já resolvida no banco pelo controller (fallback quando o
 *                          payload não traz `whatsapp` na raiz)
 */
export function normalizeZproWebhook(
  payload: ZproWebhookPayload,
  apiId: string,
  resolvedInstance?: ResolvedZproInstance,
): NormalizedZproEvent | null {
  // Filtra eventos que não são mensagem
  if (payload.method !== ZPRO_METHOD_MESSAGE) return null;

  const msg = payload.msg;
  const ticket = payload.ticket;

  if (!msg || !ticket) return null;

  // Ignora mensagens enviadas pelo atendente
  if (msg.fromMe) return null;

  // Ignora grupos
  if (ticket.isGroup) return null;

  // Respeita flag de parada do bot
  if (ticket.botStopped) return null;

  // Gate central: só age quando o agente está ativo no ticket
  if (!ticket.n8nStatus) return null;

  const whatsapp = payload.whatsapp;
  const instanceId =
    whatsapp?.id ?? resolvedInstance?.id ?? extractWhatsappId(payload);
  if (instanceId == null) return null;
  const instanceName =
    whatsapp?.name ?? resolvedInstance?.name ?? extractInstanceName(payload);
  const channelType =
    whatsapp?.type ?? resolvedInstance?.channelType ?? ticket.channel;

  const contact = ticket.contact;
  const messageType = (msg.type ?? "conversation") as ZproMessageType;
  const msgContent = msg.data?.message;
  const body = extractMessageBody(msg);
  const media = extractMedia(msgContent);

  return {
    messageId: msg.id,
    threadId: String(ticket.id),
    tenantId: ticket.tenantId,
    instanceId,
    instanceName,
    channelType,
    apiId,
    contactId: contact.id,
    contactNumber: contact.number,
    contactName: contact.name || contact.pushname || contact.number,
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
