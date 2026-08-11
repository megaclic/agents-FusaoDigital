// src/api/v1/zpro.controller.ts
// Receptor público do webhook global do Z-PRO. Sem HMAC — o Z-PRO não assina webhooks; sem auth
// de sessão — é uma URL pública que o Z-PRO chama para TODAS as instâncias do servidor. O
// whatsappId do payload resolve a instância (e, por ela, o tenant): o tenant é desconhecido até
// esse ponto, então a resolução roda como super-admin (mirrors resolveBotByRouteToken em
// chatwoot/webhook.ts); a partir daí, todo acesso ao banco é tenant-scoped via runScopedOn.
// Ack rápido (<5s) + dispatch assíncrono, igual ao padrão chatwoot.

import { Elysia } from "elysia";
import {
  broadcastZproAgentToggled,
  broadcastZproMessage,
} from "@/api/features/realtime/realtime.service";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { doc } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn } from "@/lib/tenancy";
import type { FlowContext } from "@/modules/flowlog/service";
import { ZproClient } from "@/modules/zpro/client";
import { sysCtx } from "@/modules/zpro/ctx";
import { deactivateAgent } from "@/modules/zpro/handoff";
import { mirrorZproContact, mirrorZproMessage } from "@/modules/zpro/mirror";
import { extractMedia, extractWhatsappId } from "@/modules/zpro/parse";
import { runZproAgentTurn, zproThreadId } from "@/modules/zpro/runtime";
import { resolveZproSttConfig, transcribeZproAudio } from "@/modules/zpro/stt";
import type {
  ResolvedZproInstance,
  ZproWebhookPayload,
} from "@/modules/zpro/types";
import { handleZproWebhook } from "@/modules/zpro/webhook";

export const zproController = new Elysia({
  prefix: "/v1/zpro",
  tags: ["Channels"],
}).post(
  "/webhook",
  async ({ request }) => {
    let payload: ZproWebhookPayload;
    try {
      payload = (await request.json()) as ZproWebhookPayload;
    } catch {
      return { ack: true, outcome: "invalid-json" };
    }

    // Nem todo canal manda `whatsapp` na raiz do payload — alguns só trazem `ticket.whatsappId`.
    const whatsappId = extractWhatsappId(payload);
    if (!whatsappId) {
      return { ack: true, outcome: "skipped:no-whatsapp-id" };
    }

    // Tenant unknown at this point — resolve the instance as super-admin (audited, bypasses RLS).
    const instance = await asSuperAdminOn(basePrisma, (db) =>
      db.zproInstance.findFirst({
        where: { whatsappId, disconnectedAt: null },
        select: {
          id: true,
          tenantId: true,
          apiId: true,
          baseUrl: true,
          bearerToken: true,
          instanceName: true,
        },
      }),
    );

    if (!instance) {
      logger.debug({ whatsappId }, "zpro:webhook: no instance found");
      return { ack: true, outcome: "skipped:no-instance" };
    }

    // Fallback de identidade de canal para normalizeZproWebhook quando o payload não traz
    // `whatsapp` na raiz. `id` aqui é o whatsappId (já validado acima), não o BigInt da linha —
    // NormalizedZproEvent.instanceId é sempre o whatsapp.id. channelType fica de fora: a tabela
    // ZproInstance não guarda o tipo de canal; normalizeZproWebhook cai para `ticket.channel`.
    const resolvedInstance: ResolvedZproInstance = {
      id: whatsappId,
      name: instance.instanceName,
    };

    // 1. Espelha a mensagem no banco local — TODAS as mensagens, mesmo as que o gate do agente
    // (normalizeZproWebhook) descarta (fromMe/n8nStatus=false/grupo/botStopped). Fonte de verdade
    // do inbox do painel (ZproConversationsPage/ZproConversationDetailPage).
    const mirrored = await mirrorZproMessage(
      payload,
      instance.tenantId,
      instance.id,
    );

    // 1b. `contact-create-update`: atualiza nome/foto de perfil em toda ZproConversation existente
    // desse contato (no-op para method !== "contact-create-update", e no-op se o contato ainda não
    // tem nenhuma conversa). Best-effort — nunca bloqueia o ack da mensagem.
    // OPEN-VALIDATION: assume que este payload também traz `whatsapp.id` na raiz (mesmo campo que
    // resolve a instância para "message"), como o tipo declara — sem uma captura real completa de
    // contact-create-update para confirmar (só "message" foi validado, ver types.ts). Se o Z-PRO não
    // mandar `whatsapp` nesse método, extractWhatsappId já rejeitou o payload antes deste ponto
    // (outcome "skipped:no-whatsapp-id") e este código nunca roda — confirmar contra um payload real.
    try {
      await mirrorZproContact(payload, instance.tenantId, instance.id);
    } catch (err) {
      logger.warn({ err, whatsappId }, "zpro:webhook: contact mirror failed");
    }

    const ticket = payload.ticket;

    // 1c. STT: transcrição eager de voice notes recebidos (inbound, não fromMe) — mesmo padrão
    // "eager STT at message arrival" do Chatwoot (docs/stt.md), independente do agent gate
    // (normalizeZproWebhook), pra atendentes humanos também verem o texto no painel, não só o
    // agente. `turnId` é gerado aqui e reaproveitado pelo turno do agente (se houver) pra
    // correlacionar os estágios stt+generate na mesma linha do /logs.
    const turnId = crypto.randomUUID();
    // Fed into the dispatched event's `body` below (the normalized event otherwise has an empty
    // body for a captionless voice note) — declared here so the dispatch callback can read it.
    let sttText: string | null = null;
    const msg = payload.msg;
    const audioContent = msg?.data?.message?.audioMessage;
    if (mirrored && msg && !msg.fromMe && audioContent && ticket) {
      const media = extractMedia(msg.data?.message);
      if (media.mediaUrl) {
        const sttCfg = await resolveZproSttConfig(
          instance.tenantId,
          instance.id,
        );
        if (sttCfg) {
          const flow: FlowContext = {
            tenantId: instance.tenantId,
            turnId,
            source: "inbox",
            threadId: zproThreadId(
              instance.tenantId,
              instance.id,
              String(ticket.id),
            ),
          };
          sttText = await transcribeZproAudio({
            tenantId: instance.tenantId,
            mediaUrl: media.mediaUrl,
            mediaMimetype: media.mediaMimetype ?? null,
            cfg: sttCfg,
            flow,
          });
          if (sttText) {
            const transcribedBody = sttText;
            await runScopedOn(basePrisma, sysCtx(instance.tenantId), (db) =>
              db.zproMessage.update({
                where: {
                  conversationId_messageId: {
                    conversationId: mirrored.conversationId,
                    messageId: msg.id,
                  },
                },
                data: { body: transcribedBody },
              }),
            );
            // Re-broadcast so an operator already viewing the conversation sees the transcript
            // land live instead of only on their next manual refresh (mirrorZproMessage already
            // broadcast once, with the empty body, when the voice note first arrived).
            broadcastZproMessage(instance.tenantId, {
              conversationId: String(mirrored.conversationId),
              ticketId: ticket.id,
              senderType: "CLIENT",
            });
          }
        }
      }
    }

    // 2. Handoff automático: um atendente humano respondeu (fromMe + userId preenchido) enquanto
    // o agente ainda estava marcado ativo no ticket — desativa. Nunca reativa automaticamente;
    // reativação é sempre manual via POST /v1/zpro/conversations/:id/toggle-agent.
    if (mirrored?.isHumanIntervention && ticket?.n8nStatus) {
      try {
        const client = new ZproClient(
          instance.baseUrl,
          instance.apiId,
          decryptJson<string>(instance.bearerToken),
        );
        await deactivateAgent(client, ticket.id);
        await runScopedOn(basePrisma, sysCtx(instance.tenantId), (db) =>
          db.zproConversation.update({
            where: { id: mirrored.conversationId },
            data: { agentActive: false },
          }),
        );
        broadcastZproAgentToggled(instance.tenantId, {
          conversationId: String(mirrored.conversationId),
          ticketId: ticket.id,
          agentActive: false,
        });
      } catch (err) {
        logger.warn(
          { err, ticketId: ticket.id },
          "zpro:webhook: auto-handoff deactivation failed",
        );
      }
    }

    // Usa o apiId da instância persistida (mais seguro que confiar no apiId do payload).
    const result = await handleZproWebhook(
      payload,
      instance.apiId,
      async (event) => {
        // Idempotency ledger, tenant is known now. Re-delivery of the same messageId hits the
        // unique index and returns the existing row (create is a no-op via `update: {}`).
        const delivery = await runScopedOn(
          basePrisma,
          sysCtx(instance.tenantId),
          (db) =>
            db.zproWebhookDelivery.upsert({
              where: {
                zproInstanceId_messageId: {
                  zproInstanceId: instance.id,
                  messageId: event.messageId,
                },
              },
              create: {
                tenantId: instance.tenantId,
                zproInstanceId: instance.id,
                messageId: event.messageId,
                event: event.messageType,
                status: "PENDING",
              },
              update: {},
            }),
        );

        // A genuine re-delivery of a messageId already claimed/terminal — nothing to dispatch.
        if (delivery.status !== "PENDING") return;

        // A transcribed voice note has no text of its own in the normalized event (audio never
        // carries a caption) — feed the transcription in so the agent responds to its content.
        if (sttText && !event.body) event.body = sttText;

        // Ack fast: the dispatch runs detached. runZproAgentTurn CAS-claims the row itself, so a
        // re-fired duplicate that raced this same check is still safe.
        runZproAgentTurn({
          tenantId: instance.tenantId,
          zproInstanceId: instance.id,
          deliveryRowId: delivery.id,
          event,
          turnId,
        })
          .then((outcome) => {
            logger.info(
              "zpro:dispatch outcome delivery=%s outcome=%s",
              String(delivery.id),
              outcome,
            );
          })
          .catch((err) => {
            logger.error(
              {
                err,
                errMessage: err instanceof Error ? err.message : String(err),
                errStack: err instanceof Error ? err.stack : undefined,
                deliveryId: String(delivery.id),
              },
              "zpro:async dispatch failed",
            );
          });
      },
      logger,
      resolvedInstance,
    );

    return { ack: true, outcome: result.reason ?? "queued" };
  },
  {
    detail: {
      ...doc(
        "Z-PRO global webhook",
        "Receptor público do webhook de mensagens do Z-PRO. Sem HMAC — a instância (e o tenant) é resolvida pelo whatsappId do payload. Ack rápido + dispatch assíncrono; idempotência via ZproWebhookDelivery.",
      ),
      security: [],
    },
  },
);
