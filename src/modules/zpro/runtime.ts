// src/modules/zpro/runtime.ts
// Entry point do agente para eventos Z-PRO. Espelha o essencial de src/graph/runtime.ts
// (runAgentTurn/runLoadedTurn) adaptado para o canal Z-PRO — mas SEM reusar loadAgentConfig/
// buildToolset/buildCallbacks/buildModelAndGraph diretamente: essas funções são estruturalmente
// acopladas ao Chatwoot (exigem uma linha Conversation/Inbox mirror + um ChatwootClient para montar
// as tools nativas). Z-PRO não tem esse mirror. Em vez disso, este módulo monta o turno reaproveitando
// as peças do motor que SÃO genéricas: parseModelConfig/createChatModel, tryResolveVaultEntry,
// getCheckpointer, buildAgentGraph/lastAssistantText, o flowlog (emitFlowEvent/withFlowStage),
// guardrails (input/output), TTS/STT/vision e as ferramentas RAG/HTTP/MCP/INTEGRATION + as 2 tools
// nativas utilitárias (tools.ts).
//
// runLoadedZproTurn é a cauda COMPARTILHADA (build→invoke→recheck→post), reusada por dois
// chamadores: runZproAgentTurn (caminho direto, via webhook) e flushZproDebounceJob
// (src/modules/zpro/debounce.ts, via SchedulerJob) — mesma separação que Chatwoot's runLoadedTurn
// vs. o flush do debounce. O que falta ainda (tools nativas de conversa — handoff/labels/kanban/...)
// está documentado em docs/zpro.md's "Known, accepted gaps".
//
// - Sem Chatwoot: sem inboxId, sem assigneeType, sem AgentBot token.
// - ThreadId derivado do ticket.id Z-PRO: `zpro:<tenantId>:<zproInstanceId>:<ticketId>`.
// - Reply via ZproClient (helpers de src/modules/zpro/messages.ts) em vez de ChatwootClient.
// - Idempotência do caminho direto via ZproWebhookDelivery: um claim CAS PENDING→PROCESSING aqui
//   (mirror do tx1 de processChatwootDelivery), e PROCESSED/FAILED ao final — todo acesso à tabela é
//   tenant-scoped via runScopedOn (o tenantId já é conhecido neste ponto, então não há motivo para
//   bypass RLS). O caminho de debounce usa seu próprio watermark CAS (ver debounce.ts) — nenhum dos
//   dois caminhos usa isTurnInFlight do outro: o SchedulerJob (uma linha por thread, claim FOR UPDATE
//   SKIP LOCKED) já serializa flushes; isTurnInFlight aqui só protege o caminho direto contra duas
//   mensagens quase-simultâneas do MESMO ticket disparando o grafo concorrentemente quando o agente
//   tem debounce desligado.

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
import { readMaxDistance } from "@/graph/prepare";
import {
  buildPromptVars,
  composeSystemPrompt,
  interpolatePromptVars,
} from "@/graph/prompt";
import { DEFAULT_TIMEZONE } from "@/graph/time";
import { UsageCapture } from "@/graph/usage";
import { runScopedOn } from "@/lib/tenancy";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import {
  type GuardrailsConfig,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";
import { readSplitConfig, type SplitConfig } from "@/modules/split/service";
import { llmNormalizeForSpeech } from "@/modules/tts/normalize";
import { synthesizeReply } from "@/modules/tts/service";
import {
  readTtsConfig,
  shouldReplyWithAudio,
  type TtsConfig,
} from "@/modules/tts/settings";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import { markAgentSending } from "./agent-echo";
import { ZproClient } from "./client";
import { sysCtx } from "./ctx";
import { makeZproGuardrailRunner } from "./guardrails";
import { sendTextReply, sendTyping } from "./messages";
import { deliverZproReply } from "./split";
import { loadZproAgentTools } from "./tools";
import { buildSetVoicePreferenceTool, sendZproVoiceReply } from "./tts";
import type { NormalizedZproEvent } from "./types";

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
  // Correlates this turn's flowlog stages with a `stt`/`vision` stage the controller may have
  // already emitted (eager extraction runs before dispatch — see zpro.controller.ts). Falls back
  // to a fresh id when absent, same as before this param existed.
  turnId?: string;
}

export type RunZproTurnOutcome =
  | "replied"
  | "empty"
  | "no-agent"
  | "skipped"
  | "blocked"
  | "taken-over"
  | "error";

export interface LoadedZproAgent {
  agentId: bigint;
  agentName: string;
  systemPrompt: string;
  mc: ModelConfig;
  apiKey: string;
  credentialBaseUrl: string | null;
  instance: { baseUrl: string; apiId: string; bearerToken: string };
  companyName: string | null;
  ttsConfig: TtsConfig;
  splitConfig: SplitConfig;
  maxDistance: number | null;
  guardrails: GuardrailsConfig;
  guardrailsApiKey: string;
  guardrailsCredentialBaseUrl: string | null;
}

// Scoped read (no network): resolve the binding's Agent + its model credential. Returns null when
// unbound, disabled, or the model credential does not resolve — the caller treats all of these as
// "no-agent" (nothing to run yet; expected before the binding has been created). Exported: reused
// by the debounce flush (src/modules/zpro/debounce.ts), which resolves the same agent outside any
// specific webhook delivery.
export async function loadZproAgent(
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
        name: true,
        systemPrompt: true,
        modelConfig: true,
        settings: true,
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

    // Guardrails agent's own credential (a separate model) — mirrors src/graph/prepare.ts exactly.
    // Resolved only when enabled; a missing/unresolvable credential leaves the key empty and the
    // runtime skips analysis (fail-open, logged).
    const guardrails = readGuardrailsConfig(agent.settings);
    let guardrailsApiKey = "";
    let guardrailsCredentialBaseUrl: string | null = null;
    if (guardrails.enabled && guardrails.credentialRef) {
      const gEntry = await tryResolveVaultEntry<string>(
        db,
        guardrails.credentialRef,
      );
      if (gEntry) {
        guardrailsApiKey = gEntry.secret;
        guardrailsCredentialBaseUrl = gEntry.baseUrl;
      } else {
        logger.warn(
          "zpro: agent %s guardrails credentialRef %s did not resolve — guardrails analysis is skipped",
          String(agent.id),
          guardrails.credentialRef,
        );
      }
    }

    // Nome da empresa para a variável {{nome_empresa}} — mesma fonte que prepare.ts usa para o
    // Chatwoot (tenant.name sob RLS).
    const tenant = await db.tenant.findFirst({ select: { name: true } });

    return {
      agentId: agent.id,
      agentName: agent.name,
      systemPrompt: agent.systemPrompt,
      mc,
      apiKey,
      credentialBaseUrl,
      instance,
      companyName: tenant?.name ?? null,
      ttsConfig: readTtsConfig(agent.settings),
      splitConfig: readSplitConfig(agent.settings),
      maxDistance: readMaxDistance(agent.settings),
      guardrails,
      guardrailsApiKey,
      guardrailsCredentialBaseUrl,
    };
  });
}

export interface RunLoadedZproTurnParams {
  loaded: LoadedZproAgent;
  tenantId: bigint;
  zproInstanceId: bigint;
  // contactName/contactNumber/channelType/messageId/threadId feed prompt vars + the send helpers'
  // externalKey uniqueness. `body`/`mediaCaption` are IGNORED — `text` below is authoritative (the
  // debounce flush feeds a coalesced multi-message string that has no single backing ZproMessage).
  event: NormalizedZproEvent;
  text: string;
  turnId: string;
  userSentAudio: boolean;
  base: PrismaClient;
  // Debounce supersede gate: called right before a reply is actually posted (the input-guardrail
  // reply OR the main reply), and again has no other call site — a single check covers every exit
  // that posts. false ⇒ drop this reply ("superseded"; the re-armed flush answers the full burst).
  // Absent ⇒ always post (the direct webhook path, no concurrent burst to compete with).
  shouldPost?: () => Promise<boolean>;
}

export type RunLoadedZproTurnOutcome =
  | "posted"
  | "empty"
  | "blocked"
  | "superseded"
  | "taken-over";

// The shared turn tail: build → invoke → recheck → post. Reused by runZproAgentTurn (direct) and
// flushZproDebounceJob (debounce). Does NOT touch turn-in-flight bookkeeping or any delivery/
// watermark ledger — that is each caller's own concurrency guard (see the module header).
export async function runLoadedZproTurn(
  params: RunLoadedZproTurnParams,
): Promise<RunLoadedZproTurnOutcome> {
  const {
    loaded,
    tenantId,
    zproInstanceId,
    event: ev,
    text,
    turnId,
    base,
  } = params;
  const threadId = zproThreadId(tenantId, zproInstanceId, ev.threadId);
  const ticketId = Number(ev.threadId);

  const client = new ZproClient(
    loaded.instance.baseUrl,
    loaded.instance.apiId,
    decryptJson<string>(loaded.instance.bearerToken),
  );

  const flow: FlowContext = {
    tenantId,
    turnId,
    source: "inbox",
    agentId: loaded.agentId,
    threadId,
    base,
  };

  await sendTyping(client, ev).catch(() => {});

  // Guardrails (input/output moderation): build the guardrails agent's OWN model (its own
  // resolved credential) once. Fail-open — disabled/unresolved ⇒ runGuardrail always returns
  // null — mirrors src/graph/runtime.ts exactly, just with ZproClient.createNote for the trip
  // note (no Chatwoot private-note equivalent here).
  const guardrailModel =
    loaded.guardrails.enabled && loaded.guardrailsApiKey
      ? createChatModel({
          provider: loaded.guardrails.provider,
          model: loaded.guardrails.model,
          baseURL:
            loaded.guardrailsCredentialBaseUrl ??
            loaded.guardrails.baseURL ??
            undefined,
          apiKey: loaded.guardrailsApiKey,
          temperature: 0,
        })
      : null;
  const runGuardrail = makeZproGuardrailRunner({
    gr: loaded.guardrails,
    model: guardrailModel,
    systemPrompt: loaded.systemPrompt,
    flow,
    client,
    ticketId,
  });

  // INPUT guardrail: screen the customer message BEFORE the agent processes it. A violation
  // either posts the configured template/generated reply (skipping the graph) or stays silent.
  const inGuard = await runGuardrail("input", text);
  if (inGuard) {
    if (inGuard.reply !== null) {
      // The guardrail reply is a post like any other, so it claims the trigger through the same
      // gate: without this, two concurrent flushes that both trip the guardrail could each post.
      if (params.shouldPost && !(await params.shouldPost()))
        return "superseded";
      markAgentSending(zproInstanceId, ticketId);
      await sendTextReply(client, ev, inGuard.reply);
      logger.info(
        "zpro guardrail (input) replied: thread=%s ticket=%s",
        threadId,
        ev.threadId,
      );
      return "posted";
    }
    return "blocked";
  }

  const model = createChatModel({
    ...loaded.mc,
    apiKey: loaded.apiKey,
    baseURL: loaded.credentialBaseUrl ?? loaded.mc.baseURL,
  });
  const checkpointer = await getCheckpointer();
  // Ferramentas concedidas ao agente vinculado a esta instância — RAG/HTTP/MCP/INTEGRATION +
  // as 2 tools nativas utilitárias, mesma tela/aba de concessão do Chatwoot (ToolGrantsEditor),
  // sem gate de canal. Vazio por padrão (agente sem nenhuma tool concedida além das utilitárias)
  // — buildAgentGraph trata `tools` ausente/vazio como hoje (grafo linear, sem ToolNode).
  // conversationId (ZproConversation.id) vem da mesma consulta e alimenta o UsageCapture abaixo —
  // LlmUsage.zproConversationId, NUNCA LlmUsage.conversationId (ver docs/zpro.md: risco de
  // colisão de id com Conversation/Chatwoot). Carregado ANTES do systemPrompt pra `grounded`
  // (search_knowledge concedida) alimentar composeSystemPrompt abaixo, mesma ordem do Chatwoot.
  const {
    tools: agentTools,
    conversationId,
    grounded,
  } = await loadZproAgentTools({
    base,
    tenantId,
    agentId: loaded.agentId,
    zproInstanceId,
    ticketId,
    threadId,
    maxDistance: loaded.maxDistance,
    contactName: ev.contactName,
    contactNumber: ev.contactNumber,
    companyName: loaded.companyName,
  });
  const tools = [...agentTools];
  // Resolve {{nome_contato}}, {{primeiro_nome}}, {{telefone_contato}}, {{canal}}, {{nome_empresa}},
  // {{nome_agente}} e as variáveis de hora/data — mesmo interpolador sanitizado (proteção contra
  // prompt injection) que o Chatwoot usa via prepare.ts.
  const systemPrompt = interpolatePromptVars(
    composeSystemPrompt(loaded.systemPrompt, { grounded }),
    buildPromptVars({
      contactName: ev.contactName,
      contactPhone: ev.contactNumber,
      inboxName: ev.channelType,
      companyName: loaded.companyName,
      agentName: loaded.agentName,
    }),
    { timezone: DEFAULT_TIMEZONE },
  );
  // set_voice_preference (TTS "preference" mode only — no point exposing it when the agent always
  // replies in text/mirror): Z-PRO has no NATIVE tool-grant UI yet, so this is the one native-style
  // tool wired directly here rather than through a picklist. currentVoiceReply feeds the tool's
  // <current_preference> description; voiceReplyNow below re-reads it AFTER the invoke so a
  // preference set THIS turn still governs THIS reply.
  let currentVoiceReply: boolean | null = null;
  if (loaded.ttsConfig.mode === "preference" && conversationId != null) {
    const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproConversation.findUnique({
        where: { id: conversationId },
        select: { voiceReply: true },
      }),
    );
    currentVoiceReply = conv?.voiceReply ?? null;
    tools.push(
      buildSetVoicePreferenceTool({
        tenantId,
        base,
        conversationId,
        currentVoiceReply,
      }),
    );
  }
  const graph = buildAgentGraph({
    model,
    systemPrompt,
    checkpointer,
    tools,
  });

  const usageCapture = new UsageCapture({
    tenantId,
    agentId: loaded.agentId,
    zproConversationId: conversationId,
    threadId,
    model: loaded.mc.model,
    node: "agent",
    source: "inbox",
    base,
  });

  const result = await withFlowStage(
    flow,
    "generate",
    { provider: loaded.mc.provider, model: loaded.mc.model },
    () =>
      graph.invoke(
        { messages: [new HumanMessage(text)] },
        { configurable: { thread_id: threadId }, callbacks: [usageCapture] },
      ),
  );

  let reply = lastAssistantText(result.messages).trim();

  // Re-check AFTER the invoke: did a human take over WHILE the LLM call ran? Mirrors
  // src/graph/runtime.ts's "taken-over" recheck (Chatwoot's assigneeType), keyed here on
  // ZproConversation.agentActive — the same flag the auto-handoff-on-human-intervention gate in
  // zpro.controller.ts flips. Same read also refreshes voiceReply (set_voice_preference may have
  // written it DURING the invoke) so "prefiro texto" takes effect in THIS same turn.
  let voiceReplyNow = currentVoiceReply;
  if (conversationId != null) {
    const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproConversation.findUnique({
        where: { id: conversationId },
        select: { agentActive: true, voiceReply: true },
      }),
    );
    if (conv && !conv.agentActive) {
      emitFlowEvent(flow, {
        stage: "handoff",
        status: "ok",
        detail: { outcome: "taken_over" },
      });
      return "taken-over";
    }
    voiceReplyNow = conv?.voiceReply ?? voiceReplyNow;
  }

  // Last-moment supersede gate (debounce): a newer message arrived mid-turn → drop this reply
  // (the re-armed flush answers the full burst).
  if (params.shouldPost && !(await params.shouldPost())) return "superseded";

  if (!reply) return "empty";

  // OUTPUT guardrail: screen the model's reply BEFORE delivery. A violation either replaces the
  // reply (template / a guardrails-generated safe reply) or suppresses the send entirely.
  const outGuard = await runGuardrail("output", reply);
  if (outGuard) {
    if (outGuard.reply === null) return "blocked";
    reply = outGuard.reply;
  }

  // Reply modality: audio (TTS) per the agent's mode + the customer's modality/preference, else
  // text. TTS is best-effort — any synthesis failure falls back to a text reply.
  const wantAudio = shouldReplyWithAudio(
    loaded.ttsConfig.mode,
    params.userSentAudio,
    voiceReplyNow,
  );
  if (wantAudio) {
    try {
      // Opt-in LLM speech normalization: a temp-0 model from the agent's own model config (no
      // extra credential). Best-effort — synthesizeReply falls back to raw text if it throws.
      let normalizeSpeech: ((t: string) => Promise<string>) | undefined;
      if (loaded.ttsConfig.normalize) {
        const normModel = createChatModel({
          ...loaded.mc,
          apiKey: loaded.apiKey,
          baseURL: loaded.credentialBaseUrl ?? loaded.mc.baseURL,
          temperature: 0,
        });
        normalizeSpeech = (t) => llmNormalizeForSpeech(normModel, t);
      }
      const tts = await synthesizeReply({
        tenantId,
        cfg: loaded.ttsConfig,
        text: reply,
        // Z-PRO is WhatsApp-only (no Instagram-style channel split), so leave channelType unset —
        // pickTtsFormat's default already resolves to Ogg/Opus (the WhatsApp voice-note format).
        channelType: null,
        base,
        deps: { normalizeSpeech },
        flow,
      });
      if (tts) {
        markAgentSending(zproInstanceId, ticketId);
        await sendZproVoiceReply(client, ev, tts);
        logger.info(
          "zpro agent replied (audio): thread=%s ticket=%s len=%d",
          threadId,
          ev.threadId,
          reply.length,
        );
        return "posted";
      }
    } catch (e) {
      logger.warn(
        "zpro tts failed (thread=%s), falling back to text: %s",
        threadId,
        e instanceof Error ? e.message : String(e),
      );
    }
  }

  // Marca ANTES de enviar: um eco fromMe deste ticket, chegando pelo webhook nos próximos
  // segundos, deve ser classificado AGENT por mirror.ts em vez de seguir o heurístico
  // ticket.userId (ver agent-echo.ts). Split + typing pacing por balão (docs/split.md) —
  // deliverZproReply reaproveita os helpers puros do registry compartilhado.
  markAgentSending(zproInstanceId, ticketId);
  const balloons = await deliverZproReply(
    client,
    ev,
    reply,
    loaded.splitConfig,
    undefined,
    flow,
  );
  logger.info(
    "zpro agent replied: thread=%s ticket=%s len=%d balloons=%d",
    threadId,
    ev.threadId,
    reply.length,
    balloons,
  );
  return "posted";
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

  // Texto da mensagem: body direto para texto, mediaCaption para mídias. Uma mídia sem caption e
  // sem extração (STT/vision) não tem o que oferecer ao modelo — reconhece a entrega e sai.
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

  // Another delivery for the SAME ticket is already running this turn — only reachable when the
  // agent has debounce disabled (with it on, the arm/flush cycle is the serialization point, and
  // this direct path is never invoked). Acknowledge this delivery without a reply rather than
  // invoking the graph twice concurrently on one checkpointer thread.
  if (isTurnInFlight(threadId)) {
    await markDelivery("PROCESSED");
    return "skipped";
  }

  markTurnInFlight(threadId);
  try {
    const outcome = await runLoadedZproTurn({
      loaded,
      tenantId,
      zproInstanceId,
      event: ev,
      text,
      turnId: params.turnId ?? crypto.randomUUID(),
      userSentAudio: ev.messageType === "audioMessage",
      base,
    });
    await markDelivery("PROCESSED");
    if (outcome === "superseded") {
      // Unreachable in practice (no shouldPost is passed on this path), kept for exhaustiveness.
      return "empty";
    }
    return outcome === "posted" ? "replied" : outcome;
  } catch (err) {
    logger.error(
      {
        err,
        errMessage: err instanceof Error ? err.message : String(err),
        errStack: err instanceof Error ? err.stack : undefined,
        threadId,
        ticketId: ev.threadId,
      },
      "zpro:runtime:turn-error",
    );
    await markDelivery("FAILED");
    return "error";
  } finally {
    clearTurnInFlight(threadId);
  }
}
