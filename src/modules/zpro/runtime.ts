// src/modules/zpro/runtime.ts
// Entry point do agente para eventos Z-PRO. Espelha o essencial de src/graph/runtime.ts
// (runAgentTurn) adaptado para o canal Z-PRO — mas SEM reusar loadAgentConfig/buildToolset/
// buildCallbacks/buildModelAndGraph diretamente: essas funções são estruturalmente acopladas ao
// Chatwoot (exigem uma linha Conversation/Inbox mirror + um ChatwootClient para montar as tools
// nativas). Z-PRO não tem esse mirror. Em vez disso, esta Fase 2 monta um turno mínimo (sem
// tools) reaproveitando as peças do motor que SÃO genéricas: parseModelConfig/createChatModel,
// tryResolveVaultEntry, getCheckpointer, buildAgentGraph/lastAssistantText, markTurnInFlight/
// clearTurnInFlight e o flowlog (emitFlowEvent/withFlowStage). Tools (RAG/HTTP/MCP) ficam para
// uma fase seguinte, quando o binding tiver sua própria UI de configuração.
//
// - Sem Chatwoot: sem inboxId, sem assigneeType, sem AgentBot token.
// - ThreadId derivado do ticket.id Z-PRO: `zpro:<tenantId>:<zproInstanceId>:<ticketId>`.
// - Reply via ZproClient (helpers de src/modules/zpro/messages.ts) em vez de ChatwootClient.
// - Idempotência via ZproWebhookDelivery: um claim CAS PENDING→PROCESSING aqui (mirror do tx1 de
//   processChatwootDelivery), e PROCESSED/FAILED ao final — todo acesso à tabela é tenant-scoped
//   via runScopedOn (o tenantId já é conhecido neste ponto, então não há motivo para bypass RLS).

import { HumanMessage } from "@langchain/core/messages";
import type { PrismaClient } from "@/../generated/prisma/client";
import { decryptJson } from "@/api/lib/crypto";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { getCheckpointer } from "@/graph/checkpointer";
import { buildAgentGraph, lastAssistantText } from "@/graph/graph";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "@/graph/inflight";
import {
  createChatModel,
  type ModelConfig,
  parseModelConfig,
} from "@/graph/models";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { type FlowContext, withFlowStage } from "@/modules/flowlog/service";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import { ZproClient } from "./client";
import { sendTextReply, sendTyping } from "./messages";
import type { NormalizedZproEvent } from "./types";

function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}

// Chave canônica do thread do checkpointer para um ticket Z-PRO. Mirrors chatwootThreadId's
// tenant+instance prefix (application-level tenant fence for the checkpointer), com um segmento
// literal "zpro" para nunca colidir com uma thread key do Chatwoot.
export function zproThreadId(
  tenantId: bigint,
  zproInstanceId: bigint,
  ticketId: string,
): string {
  return `zpro:${tenantId}:${zproInstanceId}:${ticketId}`;
}

export interface RunZproTurnParams {
  tenantId: bigint;
  zproInstanceId: bigint;
  deliveryRowId: bigint;
  event: NormalizedZproEvent;
  base?: PrismaClient;
}

export type RunZproTurnOutcome =
  | "replied"
  | "empty"
  | "no-agent"
  | "skipped"
  | "error";

interface LoadedZproAgent {
  agentId: bigint;
  systemPrompt: string;
  mc: ModelConfig;
  apiKey: string;
  credentialBaseUrl: string | null;
  instance: { baseUrl: string; apiId: string; bearerToken: string };
}

// Scoped read (no network): resolve the binding's Agent + its model credential. Returns null when
// unbound, disabled, or the model credential does not resolve — the caller treats all of these as
// "no-agent" (nothing to run yet; expected before the Fase 3 UI exists to create the binding).
async function loadZproAgent(
  base: PrismaClient,
  tenantId: bigint,
  zproInstanceId: bigint,
): Promise<LoadedZproAgent | null> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const binding = await db.zproAgentBinding.findFirst({
      where: { tenantId, zproInstanceId },
      select: { agentId: true },
    });
    if (!binding) return null;

    const instance = await db.zproInstance.findUnique({
      where: { id: zproInstanceId },
      select: { baseUrl: true, apiId: true, bearerToken: true },
    });
    if (!instance) return null;

    const agent = await db.agent.findUnique({
      where: { id: binding.agentId },
      select: {
        id: true,
        systemPrompt: true,
        modelConfig: true,
        enabled: true,
      },
    });
    if (!agent?.enabled) return null;

    const mc = parseModelConfig(agent.modelConfig);
    let apiKey = "";
    let credentialBaseUrl: string | null = null;
    if (mc.credentialRef) {
      const entry = await tryResolveVaultEntry<string>(db, mc.credentialRef);
      if (!entry) {
        logger.warn(
          "zpro: agent %s model credentialRef %s did not resolve — the agent cannot reply until it is fixed",
          String(agent.id),
          mc.credentialRef,
        );
        return null;
      }
      apiKey = entry.secret;
      credentialBaseUrl = entry.baseUrl;
    }

    return {
      agentId: agent.id,
      systemPrompt: agent.systemPrompt,
      mc,
      apiKey,
      credentialBaseUrl,
      instance,
    };
  });
}

export async function runZproAgentTurn(
  params: RunZproTurnParams,
): Promise<RunZproTurnOutcome> {
  const { tenantId, zproInstanceId, deliveryRowId, event: ev } = params;
  const base = params.base ?? basePrisma;

  // CAS claim: PENDING → PROCESSING. A re-entry that finds a non-PENDING row (already claimed by
  // a concurrent dispatch, or already terminal) skips — mirrors processChatwootDelivery's tx1.
  const claimed = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproWebhookDelivery.updateMany({
      where: { id: deliveryRowId, status: "PENDING" },
      data: { status: "PROCESSING" },
    }),
  );
  if (claimed.count === 0) return "skipped";

  const markDelivery = async (
    status: "PROCESSED" | "FAILED",
  ): Promise<void> => {
    try {
      await runScopedOn(base, sysCtx(tenantId), (db) =>
        db.zproWebhookDelivery.update({
          where: { id: deliveryRowId },
          data:
            status === "PROCESSED"
              ? { status, processedAt: new Date() }
              : { status, attempts: { increment: 1 } },
        }),
      );
    } catch (err) {
      logger.warn(
        "zpro: failed to update delivery %s status to %s: %s",
        String(deliveryRowId),
        status,
        err instanceof Error ? err.message : String(err),
      );
    }
  };

  // Texto da mensagem: body direto para texto, mediaCaption para mídias. Sem tools de mídia nesta
  // fase, uma mídia sem caption não tem o que oferecer ao modelo — reconhece a entrega e sai.
  const text = ev.body || ev.mediaCaption || "";
  if (!text) {
    await markDelivery("PROCESSED");
    return "skipped";
  }

  const threadId = zproThreadId(tenantId, zproInstanceId, ev.threadId);

  const loaded = await loadZproAgent(base, tenantId, zproInstanceId);
  if (!loaded) {
    logger.warn(
      "zpro:runtime: no usable agent binding for instance %s",
      String(zproInstanceId),
    );
    await markDelivery("FAILED");
    return "no-agent";
  }

  // Another delivery for the SAME ticket is already running this turn (no debounce yet in this
  // phase, so two near-simultaneous messages each get their own delivery row). Acknowledge this
  // delivery without a reply rather than invoking the graph twice concurrently on one thread.
  if (isTurnInFlight(threadId)) {
    await markDelivery("PROCESSED");
    return "skipped";
  }

  const client = new ZproClient(
    loaded.instance.baseUrl,
    loaded.instance.apiId,
    decryptJson<string>(loaded.instance.bearerToken),
  );

  const flow: FlowContext = {
    tenantId,
    turnId: crypto.randomUUID(),
    source: "inbox",
    agentId: loaded.agentId,
    threadId,
    base,
  };

  markTurnInFlight(threadId);
  try {
    await sendTyping(client, ev).catch(() => {});

    const model = createChatModel({
      ...loaded.mc,
      apiKey: loaded.apiKey,
      baseURL: loaded.credentialBaseUrl ?? loaded.mc.baseURL,
    });
    const checkpointer = await getCheckpointer();
    const graph = buildAgentGraph({
      model,
      systemPrompt: loaded.systemPrompt,
      checkpointer,
    });

    const result = await withFlowStage(
      flow,
      "generate",
      { provider: loaded.mc.provider, model: loaded.mc.model },
      () =>
        graph.invoke(
          { messages: [new HumanMessage(text)] },
          { configurable: { thread_id: threadId } },
        ),
    );

    const reply = lastAssistantText(result.messages).trim();
    if (!reply) {
      await markDelivery("PROCESSED");
      return "empty";
    }

    await sendTextReply(client, ev, reply);
    logger.info(
      "zpro agent replied: thread=%s ticket=%s len=%d",
      threadId,
      ev.threadId,
      reply.length,
    );
    await markDelivery("PROCESSED");
    return "replied";
  } catch (err) {
    logger.error(
      { err, threadId, ticketId: ev.threadId },
      "zpro:runtime:turn-error",
    );
    await markDelivery("FAILED");
    return "error";
  } finally {
    clearTurnInFlight(threadId);
  }
}
