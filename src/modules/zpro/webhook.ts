// src/modules/zpro/webhook.ts
// Recebe o payload bruto do POST do Z-PRO, aplica idempotência simples,
// normaliza e despacha para o handler do LangGraph.
// Sem HMAC (Z-PRO não assina webhooks no webhook global).

import { ZPRO_IDEMPOTENCY_TTL_MS, ZPRO_METHOD_MESSAGE } from "./constants";
import { normalizeZproWebhook } from "./normalize";
import type {
  NormalizedZproEvent,
  ResolvedZproInstance,
  ZproWebhookPayload,
} from "./types";

// Cache em memória para idempotência. Substituir por Redis/Prisma na Fase 2
// quando o volume justificar ou em cenários multi-instância.
const _seen = new Map<string, ReturnType<typeof setTimeout>>();

function markSeen(messageId: string): boolean {
  if (_seen.has(messageId)) return true;
  const timer = setTimeout(
    () => _seen.delete(messageId),
    ZPRO_IDEMPOTENCY_TTL_MS,
  );
  _seen.set(messageId, timer);
  return false;
}

export type ZproDispatchFn = (event: NormalizedZproEvent) => Promise<void>;

export interface ZproWebhookResult {
  ok: boolean;
  reason?: string;
}

/**
 * Processa um payload recebido do webhook global do Z-PRO.
 *
 * @param payload          Body JSON do POST
 * @param apiId            ApiID da instância configurada (vem do path da rota ou config)
 * @param dispatch         Função que recebe o evento normalizado e aciona o LangGraph
 * @param log              Logger do projeto (opcional; loga em dev)
 * @param resolvedInstance Instância já resolvida no banco pelo controller — repassada para
 *                         normalizeZproWebhook como fallback quando o payload não traz
 *                         `whatsapp` na raiz
 */
export async function handleZproWebhook(
  payload: ZproWebhookPayload,
  apiId: string,
  dispatch: ZproDispatchFn,
  log?: {
    debug: (obj: unknown, msg: string) => void;
    error: (obj: unknown, msg: string) => void;
  },
  resolvedInstance?: ResolvedZproInstance,
): Promise<ZproWebhookResult> {
  log?.debug({ method: payload.method }, "zpro:webhook:received");

  if (payload.method !== ZPRO_METHOD_MESSAGE) {
    return { ok: true, reason: `skipped:method:${payload.method}` };
  }

  const messageId = payload.msg?.id;
  if (!messageId) {
    return { ok: true, reason: "skipped:no-message-id" };
  }

  if (markSeen(messageId)) {
    return { ok: true, reason: "skipped:duplicate" };
  }

  const event = normalizeZproWebhook(payload, apiId, resolvedInstance);
  if (!event) {
    return { ok: true, reason: "skipped:normalize-gate" };
  }

  log?.debug(
    { threadId: event.threadId, type: event.messageType },
    "zpro:webhook:dispatching",
  );

  try {
    await dispatch(event);
    return { ok: true };
  } catch (err) {
    log?.error({ err, messageId }, "zpro:webhook:dispatch-error");
    return { ok: false, reason: "dispatch-error" };
  }
}
