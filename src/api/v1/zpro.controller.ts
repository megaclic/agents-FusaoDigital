// src/api/v1/zpro.controller.ts
// Receptor público do webhook global do Z-PRO. Sem HMAC — o Z-PRO não assina webhooks; sem auth
// de sessão — é uma URL pública que o Z-PRO chama para TODAS as instâncias do servidor. O
// whatsappId do payload resolve a instância (e, por ela, o tenant): o tenant é desconhecido até
// esse ponto, então a resolução roda como super-admin (mirrors resolveBotByRouteToken em
// chatwoot/webhook.ts); a partir daí, todo acesso ao banco é tenant-scoped via runScopedOn.
// Ack rápido (<5s) + dispatch assíncrono, igual ao padrão chatwoot.

import { Elysia } from "elysia";
import {
  broadcastZproAgentActivity,
  broadcastZproAgentToggled,
  broadcastZproMessage,
} from "@/api/features/realtime/realtime.service";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import { doc } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn } from "@/lib/tenancy";
import {
  awayMessageDue,
  readAvailabilityConfig,
  renderAwayMessage,
} from "@/modules/availability/away";
import { outOfHoursGate } from "@/modules/business-hours/service";
import { runZproRedirectGate } from "@/modules/channel-redirect/gate";
import {
  isRedirectEntryZproInstance,
  readChannelRedirectConfig,
} from "@/modules/channel-redirect/service";
import { armDebounce } from "@/modules/debounce/service";
import type { FlowContext } from "@/modules/flowlog/service";
import {
  claimZproAwayMessage,
  releaseZproAwayMessage,
  resolveZproAvailability,
} from "@/modules/zpro/availability";
import { ZproClient } from "@/modules/zpro/client";
import { sysCtx } from "@/modules/zpro/ctx";
import { resolveZproDebounceConfig } from "@/modules/zpro/debounce";
import {
  announceZproFailedTurn,
  clearZproConversationError,
  readZproDirectFence,
  recordZproConversationError,
} from "@/modules/zpro/failure";
import { deactivateAgent } from "@/modules/zpro/handoff";
import { mirrorZproContact, mirrorZproMessage } from "@/modules/zpro/mirror";
import {
  extractMedia,
  extractWhatsappId,
  resolveZproInstanceCandidate,
} from "@/modules/zpro/parse";
import { runZproAgentTurn, zproThreadId } from "@/modules/zpro/runtime";
import { resolveZproSttConfig, transcribeZproAudio } from "@/modules/zpro/stt";
import type {
  ResolvedZproInstance,
  ZproWebhookPayload,
} from "@/modules/zpro/types";
import {
  extractZproFile,
  resolveZproVisionConfig,
} from "@/modules/zpro/vision";
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

    // Tenant unknown at this point — resolve the instance(s) as super-admin (audited, bypasses RLS).
    // whatsappId is unique only PER TENANT (@@unique([tenantId, whatsappId]), see schema comment) —
    // two independent Z-PRO installs across different tenants CAN report the same whatsappId, so a
    // bare findFirst would silently and permanently mirror one tenant's conversations into another's.
    // Disambiguate via msg.apikey (present on the real captured payload, types.ts) against the
    // instance's own apiId (the URL segment) when more than one candidate matches.
    const candidates = await asSuperAdminOn(basePrisma, (db) =>
      db.zproInstance.findMany({
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

    if (candidates.length === 0) {
      logger.debug({ whatsappId }, "zpro:webhook: no instance found");
      return { ack: true, outcome: "skipped:no-instance" };
    }

    const instance = resolveZproInstanceCandidate(
      candidates,
      payload.msg?.apikey,
    );
    if (!instance) {
      logger.error(
        { whatsappId, tenantIds: candidates.map((c) => c.tenantId.toString()) },
        "zpro:webhook: whatsappId collision across tenants — cannot disambiguate via apikey, dropping delivery",
      );
      return { ack: true, outcome: "skipped:ambiguous-instance" };
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
      const media = extractMedia(msg.data?.message);
      if (media.mediaUrl) {
        const sttCfg = await resolveZproSttConfig(
          instance.tenantId,
          instance.id,
        );
        if (sttCfg) {
          sttText = await transcribeZproAudio({
            tenantId: instance.tenantId,
            mediaUrl: media.mediaUrl,
            mediaMimetype: media.mediaMimetype ?? null,
            mediaKey: media.mediaKey,
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

    // 1d. Vision: extração eager de imagem/documento recebidos (inbound, não fromMe) — mesmo
    // padrão "eager at message arrival" do STT acima. audioMessage e imageMessage/documentMessage
    // são mutuamente exclusivos (extractMessageBody/extractMedia já tratam isso), então no máximo
    // um dos dois blocos roda por mensagem.
    let visionText: string | null = null;
    const imageOrDocContent =
      msg?.data?.message?.imageMessage ?? msg?.data?.message?.documentMessage;
    if (mirrored && msg && !msg.fromMe && imageOrDocContent && ticket) {
      const media = extractMedia(msg.data?.message);
      if (media.mediaUrl) {
        const visionCfg = await resolveZproVisionConfig(
          instance.tenantId,
          instance.id,
        );
        if (visionCfg) {
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
          const extracted = await extractZproFile({
            tenantId: instance.tenantId,
            mediaUrl: media.mediaUrl,
            mediaMimetype: media.mediaMimetype ?? null,
            mediaKey: media.mediaKey,
            mediaType: media.mediaType,
            cfg: visionCfg,
            flow,
          });
          if (extracted) {
            visionText = extracted.text;
            const describedBody = extracted.text;
            await runScopedOn(basePrisma, sysCtx(instance.tenantId), (db) =>
              db.zproMessage.update({
                where: {
                  conversationId_messageId: {
                    conversationId: mirrored.conversationId,
                    messageId: msg.id,
                  },
                },
                data: { body: describedBody },
              }),
            );
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
        // Same for a described image/document with no caption (mutually exclusive with sttText —
        // see the comment above step 1d).
        if (sttText && !event.body) event.body = sttText;
        if (visionText && !event.body) event.body = visionText;

        // 1e. Channel redirect: an official-WhatsApp-via-Z-PRO lead gets a fixed no-AI reply
        // pointing at the Chatwoot web widget instead of a real agent turn — same feature as
        // Chatwoot's WhatsApp entry inbox (docs/channel-redirect.md), gated on THIS Z-PRO instance
        // instead of a Chatwoot inbox. Runs BEFORE debounce/the direct turn so a redirected lead's
        // message never reaches the agent. Consumed ("sent"/"silent") marks the delivery PROCESSED
        // and returns; "misconfigured" (feature off, or provisioning incomplete) falls through to
        // the normal flow below so the lead is served on WhatsApp as a fallback rather than
        // dead-ended. The settings lookup is cheap and only runs once per inbound message — the
        // Z-PRO controller has no other pre-resolved agent-settings bundle to piggyback on yet.
        if (mirrored) {
          const binding = await runScopedOn(
            basePrisma,
            sysCtx(instance.tenantId),
            (db) =>
              db.zproAgentBinding.findFirst({
                where: {
                  tenantId: instance.tenantId,
                  zproInstanceId: instance.id,
                },
                select: { agent: { select: { settings: true } } },
              }),
          );
          const redirectCfg = readChannelRedirectConfig(
            binding?.agent.settings,
          );
          if (
            redirectCfg.widgetInboxId !== null &&
            isRedirectEntryZproInstance(redirectCfg, Number(instance.id))
          ) {
            const conv = await runScopedOn(
              basePrisma,
              sysCtx(instance.tenantId),
              (db) =>
                db.zproConversation.findUnique({
                  where: { id: mirrored.conversationId },
                  select: {
                    redirectSentAt: true,
                    redirectCount: true,
                    redirectChatwootContactId: true,
                  },
                }),
            );
            const widgetInbox = conv
              ? await runScopedOn(basePrisma, sysCtx(instance.tenantId), (db) =>
                  db.inbox.findFirst({
                    where: {
                      tenantId: instance.tenantId,
                      chatwootInboxId: redirectCfg.widgetInboxId as number,
                    },
                    select: { chatwootInstanceId: true },
                  }),
                )
              : null;
            if (conv && widgetInbox) {
              const zproClient = new ZproClient(
                instance.baseUrl,
                instance.apiId,
                decryptJson<string>(instance.bearerToken),
              );
              const outcome = await runZproRedirectGate({
                tenantId: instance.tenantId,
                chatwootInstanceId: widgetInbox.chatwootInstanceId,
                ticketId: Number(event.threadId),
                conv: {
                  id: mirrored.conversationId,
                  contactNumber: event.contactNumber,
                  contactName: event.contactName,
                  redirectSentAt: conv.redirectSentAt,
                  redirectCount: conv.redirectCount,
                  redirectChatwootContactId: conv.redirectChatwootContactId,
                },
                cfg: redirectCfg,
                clonedMessage: event.body || null,
                now: new Date(),
                base: basePrisma,
                send: async (text) => {
                  await zproClient.sendText(event.contactNumber, text, {
                    validateNumber: false,
                  });
                },
              });
              if (outcome !== "misconfigured") {
                await runScopedOn(basePrisma, sysCtx(instance.tenantId), (db) =>
                  db.zproWebhookDelivery.update({
                    where: { id: delivery.id },
                    data: { status: "PROCESSED", processedAt: new Date() },
                  }),
                );
                logger.info(
                  "zpro:dispatch redirect-gate outcome=%s delivery=%s",
                  outcome,
                  String(delivery.id),
                );
                return;
              }
            } else {
              // Unlike every other redirect-gate exit above, this fallthrough (no local
              // ZproConversation row yet, or the configured widgetInboxId doesn't match any locally
              // mirrored Inbox — stale config, wrong chatwootInstanceId, inbox deleted) previously left
              // zero trace that redirect was supposed to fire and silently didn't.
              logger.info(
                "zpro:dispatch redirect-gate skipped reason=%s delivery=%s",
                !conv ? "no-conversation" : "widget-inbox-not-found",
                String(delivery.id),
              );
            }
          }
        }

        // 1f. Availability gate: the agent's business hours ("Disponibilidade" schedule) gate
        // REACTIVE replies — same feature Chatwoot already has (chatwoot/webhook.ts), now wired for
        // Z-PRO too: previously a Z-PRO agent answered around the clock no matter what schedule was
        // configured. Runs BEFORE the debounce-arm decision, exactly like the Chatwoot gate, so an
        // out-of-hours message never even arms a coalescing window. reusable outOfHoursGate (shared
        // with Chatwoot, src/modules/business-hours/service.ts) decides; a one-shot private note
        // (ZproConversation.outOfHoursNoticeSentAt watermark, anti-spam) tells the operator why.
        if (mirrored) {
          const availConv = await runScopedOn(
            basePrisma,
            sysCtx(instance.tenantId),
            (db) =>
              db.zproConversation.findUnique({
                where: { id: mirrored.conversationId },
                select: {
                  outOfHoursNoticeSentAt: true,
                  awayMessageSentAt: true,
                },
              }),
          );
          const hours = await resolveZproAvailability(
            instance.tenantId,
            instance.id,
            basePrisma,
          );
          const availability = outOfHoursGate(
            hours,
            new Date(),
            availConv?.outOfHoursNoticeSentAt != null,
          );
          if (availability.silence) {
            // ── The CUSTOMER-facing half (mirrors chatwoot/webhook.ts's #153 wiring): a DISABLED
            //    agent still gets the operator note below, but acquires no voice toward the
            //    customer — same reasoning as the Chatwoot gate. Own settings read (the redirect
            //    gate above already pays one; this step has no bundle to share it with yet). ──
            const now = new Date();
            if (hours) {
              const agentBinding = await runScopedOn(
                basePrisma,
                sysCtx(instance.tenantId),
                (db) =>
                  db.zproAgentBinding.findFirst({
                    where: {
                      tenantId: instance.tenantId,
                      zproInstanceId: instance.id,
                    },
                    select: {
                      agent: { select: { enabled: true, settings: true } },
                    },
                  }),
              );
              const awayCfg = readAvailabilityConfig(
                agentBinding?.agent.settings,
              );
              const away =
                agentBinding?.agent.enabled &&
                awayMessageDue(hours, now, availConv?.awayMessageSentAt ?? null)
                  ? renderAwayMessage({
                      enabled: awayCfg.enabled,
                      copy: awayCfg.awayMessage,
                      schedule: hours,
                      now,
                    })
                  : ({ send: false, reason: "disabled" } as const);
              if (!away.send && away.reason === "no_next_open") {
                logger.warn(
                  "zpro:dispatch away message not sent (conv=%s) — it interpolates the next opening and the schedule never opens",
                  String(mirrored.conversationId),
                );
              }
              if (away.send) {
                const previous = availConv?.awayMessageSentAt ?? null;
                const claimed = await claimZproAwayMessage({
                  tenantId: instance.tenantId,
                  conversationId: mirrored.conversationId,
                  previous,
                  now,
                  base: basePrisma,
                }).catch((err) => {
                  logger.warn(
                    { err },
                    "zpro:dispatch away-message claim failed (conv=%s)",
                    String(mirrored.conversationId),
                  );
                  return false;
                });
                if (claimed) {
                  try {
                    const zproClient = new ZproClient(
                      instance.baseUrl,
                      instance.apiId,
                      decryptJson<string>(instance.bearerToken),
                    );
                    await zproClient.sendText(event.contactNumber, away.text, {
                      validateNumber: false,
                    });
                  } catch (err) {
                    logger.warn(
                      { err },
                      "zpro:dispatch away-message send failed (conv=%s)",
                      String(mirrored.conversationId),
                    );
                    await releaseZproAwayMessage({
                      tenantId: instance.tenantId,
                      conversationId: mirrored.conversationId,
                      previous,
                      claimed: now,
                      base: basePrisma,
                    });
                  }
                }
              }
            }
            if (availability.postNote) {
              try {
                const zproClient = new ZproClient(
                  instance.baseUrl,
                  instance.apiId,
                  decryptJson<string>(instance.bearerToken),
                );
                await zproClient.createNote(
                  Number(event.threadId),
                  "🌙 Mensagem recebida fora do horário de atendimento. O agente não respondeu automaticamente; ele volta a responder no próximo horário disponível.",
                );
              } catch (err) {
                logger.warn(
                  { err, delivery: String(delivery.id) },
                  "zpro:dispatch availability-gate note failed",
                );
              }
              try {
                await runScopedOn(basePrisma, sysCtx(instance.tenantId), (db) =>
                  db.zproConversation.update({
                    where: { id: mirrored.conversationId },
                    data: { outOfHoursNoticeSentAt: new Date() },
                  }),
                );
              } catch (err) {
                logger.warn(
                  { err, delivery: String(delivery.id) },
                  "zpro:dispatch availability-gate notice-flag write failed",
                );
              }
            }
            await runScopedOn(basePrisma, sysCtx(instance.tenantId), (db) =>
              db.zproWebhookDelivery.update({
                where: { id: delivery.id },
                data: { status: "PROCESSED", processedAt: new Date() },
              }),
            );
            logger.info(
              "zpro:dispatch availability-gate silenced delivery=%s",
              String(delivery.id),
            );
            return;
          }
        }

        // Debounce: an incoming message on a debounce-enabled agent re-arms the durable DEBOUNCE
        // job (coalescing window) instead of replying balloon-by-balloon — the fast worker flushes
        // it later (src/modules/zpro/debounce.ts). Arming REPLACES the direct turn (same as
        // Chatwoot's webhook), so on success this delivery is marked PROCESSED without ever
        // calling runZproAgentTurn — the eventual reply is tracked by the watermark, not this
        // ledger row. Best-effort: any arm failure falls back to the direct turn below so the
        // customer is never left unanswered. mirrored.messageDbId seeds the burst's high-water
        // mark (armDebounce's lastMessageId) so a flush abandoned by the agent-inactive gate can
        // still advance the watermark without a query (mirrors Chatwoot's issue #8 fix).
        if (mirrored) {
          try {
            const debounceCfg = await resolveZproDebounceConfig(
              instance.tenantId,
              instance.id,
            );
            if (debounceCfg) {
              const flushAt = await armDebounce({
                tenantId: instance.tenantId,
                threadId: zproThreadId(
                  instance.tenantId,
                  instance.id,
                  event.threadId,
                ),
                agentBotId: null,
                cfg: debounceCfg,
                lastMessageId: Number(mirrored.messageDbId),
              });
              // Live "receiving messages…" indicator while the window coalesces — mirrors Chatwoot's
              // webhook.ts exactly (the flush's turn then takes over with "thinking" and clears on
              // finish). Best-effort, keyed by the ZproConversation row id.
              broadcastZproAgentActivity(instance.tenantId, {
                conversationId: String(mirrored.conversationId),
                phase: "started",
                stage: "debounce",
                tool: null,
                runAt: flushAt.toISOString(),
              });
              await runScopedOn(basePrisma, sysCtx(instance.tenantId), (db) =>
                db.zproWebhookDelivery.update({
                  where: { id: delivery.id },
                  data: { status: "PROCESSED", processedAt: new Date() },
                }),
              );
              logger.info(
                "zpro:dispatch debounced delivery=%s window=%ds",
                String(delivery.id),
                debounceCfg.windowSeconds,
              );
              return;
            }
          } catch (err) {
            logger.warn(
              { err, deliveryId: String(delivery.id) },
              "zpro:webhook: debounce arm failed — falling back to a direct turn",
            );
          }
        }

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
            // Recovered: a successful answer clears any previously surfaced turn error (upstream
            // #86 parity, mirrors chatwoot/webhook.ts's item-6 clear).
            if (outcome === "replied" && mirrored) {
              void clearZproConversationError({
                tenantId: instance.tenantId,
                conversationDbId: mirrored.conversationId,
                base: basePrisma,
              });
            }
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
            // Surface the failure to the operator (sanitized) so they can re-engage, and — when
            // nothing else is coming — say so INSIDE the ticket (upstream #71/#86 parity). There is
            // no retry on this direct path, so the only thing that can still answer is a newer
            // message's own turn — the same local fence the success path would apply.
            if (mirrored) {
              void recordZproConversationError({
                tenantId: instance.tenantId,
                conversationDbId: mirrored.conversationId,
                error: err,
                base: basePrisma,
              });
              const conversationDbId = mirrored.conversationId;
              const triggerMessageDbId = mirrored.messageDbId;
              void announceZproFailedTurn({
                tenantId: instance.tenantId,
                zproInstanceId: instance.id,
                conversationDbId,
                ticketId: Number(event.threadId),
                assess: async () => ({
                  path: "direct",
                  fence: await readZproDirectFence({
                    tenantId: instance.tenantId,
                    conversationDbId,
                    triggerMessageDbId,
                    base: basePrisma,
                  }),
                }),
                error: err,
                base: basePrisma,
              });
            }
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
