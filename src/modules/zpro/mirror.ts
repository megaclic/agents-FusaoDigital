// src/modules/zpro/mirror.ts
// Persiste TODAS as mensagens de um ticket Z-PRO no banco local (cliente, agente IA e humano),
// independente do gate do agente (normalize.ts descarta silenciosamente fromMe/n8nStatus=false/
// grupo/botStopped — este módulo roda ANTES desse gate, no payload bruto). É a fonte de verdade
// do inbox do painel (ZproConversationsPage/ZproConversationDetailPage).

import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import {
  broadcastZproMessage,
  type ZproSenderTypeValue,
} from "@/api/features/realtime/realtime.service";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn } from "@/lib/tenancy";
import { ZPRO_METHOD_MESSAGE } from "./constants";
import { sysCtx } from "./ctx";
import { extractMedia, extractMessageBody } from "./parse";
import type { ZproWebhookPayload } from "./types";

// Z-PRO redelivers the same webhook payload concurrently (network retry) often enough that two
// requests for the identical ticket/message can race past the upsert's existence check and both
// attempt the INSERT branch — one wins, the other hits the unique index (P2002). Both sides of that
// specific race carry IDENTICAL data (same retried payload), so it's always safe to prefer the
// winner's row over erroring out. NOT a general-purpose "ignore any conflict" — a genuine collision
// between two DIFFERENT messages/tickets on the same key would also match this and be swallowed,
// but the schema's uniqueness guarantees make that case unreachable here.
function isUniqueViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

function resolveSenderType(payload: ZproWebhookPayload): ZproSenderTypeValue {
  const fromMe = payload.msg?.fromMe ?? false;
  if (!fromMe) return "CLIENT";
  const userId = payload.ticket?.userId;
  // fromMe + userId preenchido = atendente humano interveio; fromMe + sem userId = agente IA.
  return userId !== null && userId !== undefined ? "HUMAN" : "AGENT";
}

export interface MirrorZproMessageResult {
  conversationId: bigint;
  isHumanIntervention: boolean;
}

export async function mirrorZproMessage(
  payload: ZproWebhookPayload,
  tenantId: bigint,
  zproInstanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<MirrorZproMessageResult | null> {
  if (payload.method !== ZPRO_METHOD_MESSAGE) return null;
  const msg = payload.msg;
  const ticket = payload.ticket;
  if (!msg || !ticket) return null;

  const senderType = resolveSenderType(payload);
  const isHumanIntervention = senderType === "HUMAN";
  const body = extractMessageBody(msg);
  const media = extractMedia(msg.data?.message);
  const lastMessageAt = new Date(msg.timestamp);

  let conversation: { id: bigint };
  try {
    conversation = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproConversation.upsert({
        where: {
          zproInstanceId_ticketId: { zproInstanceId, ticketId: ticket.id },
        },
        create: {
          tenantId,
          zproInstanceId,
          ticketId: ticket.id,
          ticketProtocol: ticket.protocol,
          status: ticket.status,
          contactId: ticket.contact.id,
          contactNumber: ticket.contact.number,
          contactName: ticket.contact.name ?? ticket.contact.number,
          agentActive: ticket.n8nStatus,
          humanUserId: ticket.userId,
          lastMessageAt,
          lastMessageBody: body,
        },
        update: {
          status: ticket.status,
          agentActive: ticket.n8nStatus,
          humanUserId: ticket.userId,
          lastMessageAt,
          lastMessageBody: body,
        },
        select: { id: true },
      }),
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost the concurrent-redelivery race on (zproInstanceId, ticketId): the other request already
    // wrote the same ticket data. Adopt its row instead of erroring — there's no "our" data to lose.
    logger.debug(
      { ticketId: ticket.id, messageId: msg.id },
      "zpro:mirror: lost conversation upsert race (duplicate Z-PRO redelivery), adopting winner",
    );
    conversation = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproConversation.findUniqueOrThrow({
        where: {
          zproInstanceId_ticketId: { zproInstanceId, ticketId: ticket.id },
        },
        select: { id: true },
      }),
    );
  }

  // Idempotente por messageId: uma redelivery sequencial hit a unique index e é um no-op via
  // `update: {}`; uma redelivery CONCORRENTE pode colidir como P2002 antes disso (ver
  // isUniqueViolation) — mesma mensagem, então ignorar é seguro.
  try {
    await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproMessage.upsert({
        where: {
          conversationId_messageId: {
            conversationId: conversation.id,
            messageId: msg.id,
          },
        },
        create: {
          tenantId,
          conversationId: conversation.id,
          messageId: msg.id,
          senderType,
          body,
          messageType: msg.type ?? "conversation",
          mediaUrl: media.mediaUrl,
          mediaCaption: media.mediaCaption,
          mediaFileName: media.mediaFileName,
          fromMe: msg.fromMe,
          timestamp: BigInt(msg.timestamp),
        },
        update: {},
      }),
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    logger.debug(
      { conversationId: conversation.id.toString(), messageId: msg.id },
      "zpro:mirror: lost message upsert race (duplicate Z-PRO redelivery), skipping",
    );
  }

  // Best-effort: nunca bloqueia o pipeline principal (ver broadcastZproMessage/publish).
  broadcastZproMessage(tenantId, {
    conversationId: String(conversation.id),
    ticketId: ticket.id,
    senderType,
  });

  return { conversationId: conversation.id, isHumanIntervention };
}
