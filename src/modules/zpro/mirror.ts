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
import { encryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn, type ScopedDb } from "@/lib/tenancy";
import { emitOutbound } from "@/modules/webhooks/outbound/service";
import { wasAgentSending } from "./agent-echo";
import { ZPRO_METHOD_CONTACT, ZPRO_METHOD_MESSAGE } from "./constants";
import { sysCtx } from "./ctx";
import {
  extractMedia,
  extractMessageBody,
  extractQuotedText,
  parseContactExtraInfo,
  parseContactTags,
} from "./parse";
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

// Fleet events — Z-PRO analog of chatwoot/mirror.ts's emitMirrorEvent trio (conversation.created/
// status_changed/handoff). Best-effort like the Chatwoot original: a fan-out failure never breaks
// the mirror write, it only enqueues rows the worker drains later, so a failure here is swallowed
// and logged, never thrown.
//
// `handoff` has no Chatwoot-shaped assignee-type edge to detect on Z-PRO (no User/AgentBot
// distinction here) — the closest real signal is `agentActive` (ticket.n8nStatus) going true→false,
// which is exactly what deactivateAgent (handoff.ts) flips when handoff_to_human/resolve_conversation
// hand the ticket off. A conversation created already-inactive does not fire it: there is no PRIOR
// active state for it to have left.
async function emitZproMirrorEvent(
  base: PrismaClient,
  tenantId: bigint,
  before: { status: string; agentActive: boolean } | null,
  after: { conversationId: bigint; status: string; agentActive: boolean },
): Promise<void> {
  const emit = async (
    event:
      | "conversation.created"
      | "conversation.status_changed"
      | "conversation.handoff",
    data: Record<string, unknown>,
  ) => {
    try {
      await runScopedOn(base, sysCtx(tenantId), (db: ScopedDb) =>
        emitOutbound(db, tenantId, event, data),
      );
    } catch (err) {
      logger.warn(
        "zpro: outbound emit failed (event=%s): %s",
        event,
        err instanceof Error ? err.message : String(err),
      );
    }
  };
  const conversationId = String(after.conversationId);
  if (before === null) {
    await emit("conversation.created", {
      conversation_id: conversationId,
      status: after.status,
    });
    return;
  }
  if (after.status !== before.status) {
    await emit("conversation.status_changed", {
      conversation_id: conversationId,
      status: after.status,
      previous_status: before.status,
    });
  }
  if (before.agentActive && !after.agentActive) {
    await emit("conversation.handoff", { conversation_id: conversationId });
  }
}

async function resolveSenderType(
  payload: ZproWebhookPayload,
  tenantId: bigint,
  zproInstanceId: bigint,
  base: PrismaClient,
): Promise<ZproSenderTypeValue> {
  const fromMe = payload.msg?.fromMe ?? false;
  if (!fromMe) return "CLIENT";
  // ticket.userId é o atendente ATRIBUÍDO ao ticket (sticky), não o autor desta mensagem — uma vez
  // atribuído a um humano, ficaria assim para sempre e classificaria toda resposta do agente IA como
  // HUMAN. Checar primeiro se ESTA mensagem é o eco de um envio nosso (ver agent-echo.ts) resolve
  // isso: só cai no heurístico ticket.userId quando não fomos nós que enviamos.
  const ticket = payload.ticket;
  if (
    ticket &&
    (await wasAgentSending(tenantId, zproInstanceId, ticket.id, base))
  )
    return "AGENT";
  const userId = ticket?.userId;
  // fromMe + userId preenchido = atendente humano interveio; fromMe + sem userId = agente IA.
  return userId !== null && userId !== undefined ? "HUMAN" : "AGENT";
}

export interface MirrorZproMessageResult {
  conversationId: bigint;
  // The mirrored ZproMessage's own PK — feeds debounce arming (src/modules/zpro/debounce.ts's
  // armDebounce lastMessageId, the burst's high-water mark) so a flush abandoned by the
  // agent-inactive gate can still advance the watermark without re-querying.
  messageDbId: bigint;
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

  const senderType = await resolveSenderType(
    payload,
    tenantId,
    zproInstanceId,
    base,
  );
  const isHumanIntervention = senderType === "HUMAN";
  const body = extractMessageBody(msg);
  const media = extractMedia(msg.data?.message);
  const quotedText = extractQuotedText(msg) ?? null;
  const lastMessageAt = new Date(msg.timestamp);
  // CLIENT-only anchor for the generic follow-up sweep (isNewFollowUpEpisode), distinct from
  // lastMessageAt (any sender) — mirrors Conversation.lastInboundAt (chatwoot/mirror.ts).
  const lastInboundAt = senderType === "CLIENT" ? lastMessageAt : undefined;
  // ticket.queueId + ticket.contact.tags arrive on EVERY message webhook (confirmed on real
  // captured payloads, see types.ts's header) — previously received and discarded. Mirrored here so
  // route_to_queue/assign_label's "what does this ticket/contact already have" question is
  // answerable without a live API call (get_contact_info, the conversation detail page).
  const contactTags = parseContactTags(
    ticket.contact.tags,
  ) as unknown as Prisma.InputJsonValue;
  // Same cadence as contactTags above (arrives on every message webhook) — backs the
  // attribute-context prompt block and tool-precondition state, see parseContactExtraInfo.
  const contactExtraInfo = parseContactExtraInfo(
    ticket.contact.extraInfo,
  ) as unknown as Prisma.InputJsonValue;

  let conversation: { id: bigint };
  let wonUpsert = true;
  // Read BEFORE the upsert: Prisma's upsert result does not say which branch fired, and the fleet
  // events below (conversation.created/status_changed/handoff) need to know. A SEPARATE scoped
  // transaction from the upsert's own (runScopedOn opens one per call), not one shared statement —
  // two webhook deliveries for the SAME existing ticket racing between this read and the other's
  // write can read a stale `before`, so an occasional status_changed event reports a `previous_status`
  // one hop behind the true prior value. Accepted: this is best-effort telemetry (same as the
  // Chatwoot original), never the row itself, and a `conversation.created` double-fire is still
  // impossible — that path is guarded by `wonUpsert` below, which only a real P2002 sets false.
  // Costs one extra read per message, same trade Chatwoot's own decideConversationWrites machinery
  // avoids by tracking state its own way — Z-PRO's mirror has no such engine, so this is the simple
  // version of the same question.
  const before = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproConversation.findUnique({
      where: {
        zproInstanceId_ticketId: { zproInstanceId, ticketId: ticket.id },
      },
      select: { id: true, status: true, agentActive: true },
    }),
  );
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
          contactName: ticket.contact.name || ticket.contact.number,
          agentActive: ticket.n8nStatus,
          humanUserId: ticket.userId,
          queueId: ticket.queueId,
          contactTags,
          contactExtraInfo,
          lastMessageAt,
          lastMessageBody: body,
          ...(lastInboundAt ? { lastInboundAt } : {}),
          // ticket.contact.profilePicUrl arrives on EVERY message webhook, same as queueId/tags
          // above — previously only mirrorZproContact's dedicated contact-create-update event set
          // this, so a contact whose first interaction was a message (not that event) showed no
          // avatar until/unless it happened to fire later. Captured here too so the photo appears
          // from the FIRST message instead of depending on a second event that may lag or never come.
          ...(ticket.contact.profilePicUrl
            ? { avatarUrl: ticket.contact.profilePicUrl }
            : {}),
        },
        update: {
          status: ticket.status,
          // contactId is refreshed here too (not just on create) — a contact merge/dedup in the
          // Z-PRO panel changes ticket.contact.id going forward, and without this the mirrored id
          // would go stale forever (set_custom_attribute/assign_label contact-scope writes, and
          // mirrorZproContact's updateMany match, would all silently keep targeting the old id).
          contactId: ticket.contact.id,
          contactNumber: ticket.contact.number,
          contactName: ticket.contact.name || ticket.contact.number,
          agentActive: ticket.n8nStatus,
          humanUserId: ticket.userId,
          queueId: ticket.queueId,
          contactTags,
          contactExtraInfo,
          lastMessageAt,
          lastMessageBody: body,
          ...(lastInboundAt ? { lastInboundAt } : {}),
          ...(ticket.contact.profilePicUrl
            ? { avatarUrl: ticket.contact.profilePicUrl }
            : {}),
        },
        select: { id: true },
      }),
    );
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Lost the concurrent-redelivery race on (zproInstanceId, ticketId): the other request already
    // wrote the same ticket data. Adopt its row instead of erroring — there's no "our" data to lose.
    wonUpsert = false;
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

  // Fleet events — Z-PRO analog of chatwoot/mirror.ts's emitMirrorEvent trio, same three events,
  // same allowlisted (ids/status only, no PII) projection. Only on the WINNING upsert: the race-adopt
  // branch above did not write, so its own comparison against `before` would be meaningless — the
  // winner's own call already emitted whatever changed.
  if (wonUpsert) {
    await emitZproMirrorEvent(base, tenantId, before, {
      conversationId: conversation.id,
      status: ticket.status,
      agentActive: ticket.n8nStatus,
    });
  }

  // Idempotente por messageId: uma redelivery sequencial hit a unique index e é um no-op via
  // `update: {}`; uma redelivery CONCORRENTE pode colidir como P2002 antes disso (ver
  // isUniqueViolation) — mesma mensagem, então ignorar é seguro.
  let messageDbId: bigint;
  try {
    const created = await runScopedOn(base, sysCtx(tenantId), (db) =>
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
          // Needed by the /media proxy to serve a PLAYABLE file later — the CDN blob at mediaUrl
          // is WhatsApp's own end-to-end-encrypted media (media-crypto.ts). Encrypted at rest like
          // every other secret in this codebase (encryptJson) since it's a decryption key for
          // private customer media, not just an opaque id.
          mediaKey: media.mediaKey ? encryptJson(media.mediaKey) : null,
          mediaMimetype: media.mediaMimetype ?? null,
          quotedText,
          fromMe: msg.fromMe,
          timestamp: BigInt(msg.timestamp),
        },
        update: {},
        select: { id: true },
      }),
    );
    messageDbId = created.id;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    logger.debug(
      { conversationId: conversation.id.toString(), messageId: msg.id },
      "zpro:mirror: lost message upsert race (duplicate Z-PRO redelivery), skipping",
    );
    const winner = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproMessage.findUniqueOrThrow({
        where: {
          conversationId_messageId: {
            conversationId: conversation.id,
            messageId: msg.id,
          },
        },
        select: { id: true },
      }),
    );
    messageDbId = winner.id;
  }

  // Best-effort: nunca bloqueia o pipeline principal (ver broadcastZproMessage/publish).
  broadcastZproMessage(tenantId, {
    conversationId: String(conversation.id),
    ticketId: ticket.id,
    senderType,
  });

  return { conversationId: conversation.id, messageDbId, isHumanIntervention };
}

// Processa um payload `contact-create-update`: atualiza nome + foto de perfil em toda
// ZproConversation existente desse contato nesta instância (um contato pode ter vários tickets ao
// longo do tempo — contact-create-update não é por ticket). Nenhuma mensagem é criada; se o contato
// ainda não tem nenhuma conversa (nunca mandou mensagem), não há o que atualizar — updateMany
// simplesmente afeta zero linhas, sem erro.
export async function mirrorZproContact(
  payload: ZproWebhookPayload,
  tenantId: bigint,
  zproInstanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  if (payload.method !== ZPRO_METHOD_CONTACT) return;
  const contact = payload.contact;
  if (!contact) return;

  const name = contact.name || contact.number;
  const contactTags = parseContactTags(
    contact.tags,
  ) as unknown as Prisma.InputJsonValue;
  const contactExtraInfo = parseContactExtraInfo(
    contact.extraInfo,
  ) as unknown as Prisma.InputJsonValue;
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproConversation.updateMany({
      where: { zproInstanceId, contactId: contact.id },
      data: {
        contactName: name,
        contactNumber: contact.number,
        contactTags,
        contactExtraInfo,
        ...(contact.profilePicUrl ? { avatarUrl: contact.profilePicUrl } : {}),
      },
    }),
  );
}
