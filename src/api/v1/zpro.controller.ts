// src/api/v1/zpro.controller.ts
// Receptor público do webhook global do Z-PRO. Sem HMAC — o Z-PRO não assina webhooks; sem auth
// de sessão — é uma URL pública que o Z-PRO chama para TODAS as instâncias do servidor. O
// whatsappId do payload resolve a instância (e, por ela, o tenant): o tenant é desconhecido até
// esse ponto, então a resolução roda como super-admin (mirrors resolveBotByRouteToken em
// chatwoot/webhook.ts); a partir daí, todo acesso ao banco é tenant-scoped via runScopedOn.
// Ack rápido (<5s) + dispatch assíncrono, igual ao padrão chatwoot.

import { Elysia } from "elysia";
import logger from "@/api/lib/logger";
import { doc } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import { runZproAgentTurn } from "@/modules/zpro/runtime";
import type { ZproWebhookPayload } from "@/modules/zpro/types";
import { handleZproWebhook } from "@/modules/zpro/webhook";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

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

    const whatsappId = payload.whatsapp?.id;
    if (!whatsappId) {
      return { ack: true, outcome: "skipped:no-whatsapp-id" };
    }

    // Tenant unknown at this point — resolve the instance as super-admin (audited, bypasses RLS).
    const instance = await asSuperAdminOn(basePrisma, (db) =>
      db.zproInstance.findFirst({
        where: { whatsappId, disconnectedAt: null },
        select: { id: true, tenantId: true, apiId: true },
      }),
    );

    if (!instance) {
      logger.debug({ whatsappId }, "zpro:webhook: no instance found");
      return { ack: true, outcome: "skipped:no-instance" };
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

        // Ack fast: the dispatch runs detached. runZproAgentTurn CAS-claims the row itself, so a
        // re-fired duplicate that raced this same check is still safe.
        void runZproAgentTurn({
          tenantId: instance.tenantId,
          zproInstanceId: instance.id,
          deliveryRowId: delivery.id,
          event,
        }).catch((err) => {
          logger.error(
            "zpro: async dispatch failed (delivery %s): %s",
            String(delivery.id),
            err instanceof Error ? err.message : String(err),
          );
        });
      },
      logger,
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
