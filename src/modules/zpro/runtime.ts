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
import {
  type FallbackConfig,
  hasModelFallback,
  readModelFallbackConfig,
  resolveFallbackModel,
} from "@/graph/fallback-settings";
import {
  buildAgentGraph,
  type FallbackModel,
  lastAssistantText,
} from "@/graph/graph";
import {
  clearTurnInFlight,
  isTurnInFlight,
  markTurnInFlight,
} from "@/graph/inflight";
import {
  PRIMARY_MAX_RETRIES,
  PRIMARY_TIMEOUT_MS,
} from "@/graph/model-fallback";
import {
  createChatModel,
  type ModelConfig,
  parseModelConfig,
  type ResolvedModelConfig,
} from "@/graph/models";
import {
  FOLLOWUP_SKIP_SENTINEL,
  isNudgeSilent,
  OUTSIDE_WINDOW_NOTE_PREFIX,
} from "@/graph/nudge";
import {
  buildLangfuseHandler,
  buildToolTraceMetadata,
  type LangfuseConfig,
  resolveLangfuseConfig,
} from "@/graph/observability";
import { readMaxDistance } from "@/graph/prepare";
import {
  buildPromptVars,
  composeSystemPrompt,
  interpolatePromptVars,
} from "@/graph/prompt";
import { type AuditedSection, buildPromptAudit } from "@/graph/prompt-audit";
import { DEFAULT_TIMEZONE } from "@/graph/time";
import { ToolFlowLogger } from "@/graph/tool-flowlog";
import type { NativeToolName } from "@/graph/tools/catalog";
import {
  applyToolPreconditions,
  preconditionFlowEvent,
  unmatchedPreconditionEvent,
} from "@/graph/tools/precondition";
import { UsageCapture } from "@/graph/usage";
import { runScopedOn } from "@/lib/tenancy";
import { readLimitsConfig } from "@/modules/agents/limits";
import { readToolGuidance } from "@/modules/agents/tool-guidance";
import {
  type PreconditionState,
  readToolPreconditions,
  type ToolPrecondition,
} from "@/modules/agents/tool-preconditions";
import {
  type AttributeContextConfig,
  attributeBagsFrom,
  buildAttributeContextSection,
  isAttributeContextEmpty,
  readAttributeContextConfig,
} from "@/modules/chatwoot/attributes";
import { resolveVariantOverride } from "@/modules/experiments/service";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { readObservabilityConfig } from "@/modules/flowlog/settings";
import {
  type GuardrailsConfig,
  readGuardrailsConfig,
} from "@/modules/guardrails/settings";
import {
  type HandoffConfig,
  readHandoffConfig,
} from "@/modules/handoff/settings";
import {
  readSendImageConfig,
  type SendImageConfig,
} from "@/modules/images/settings";
import {
  buildTemplatePayload,
  proactiveSendMode,
  readServiceWindowConfig,
  type ServiceWindowConfig,
} from "@/modules/service-window/service";
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
import { readZproCrmConfig, type ZproCrmConfig } from "./crm";
import { sysCtx } from "./ctx";
import { makeZproGuardrailRunner } from "./guardrails";
import { deactivateAgent } from "./handoff";
import {
  sendTextReply,
  sendZproTemplate,
  startTypingHeartbeat,
} from "./messages";
import type { TurnState } from "./native-tools";
import { withMediaFallback, withQuotedPrefix } from "./parse";
import { deliverZproReply } from "./split";
import { ZproAgentStatusReporter } from "./status";
import { scheduleZproStatusCheck } from "./status-reconcile";
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
  instance: {
    baseUrl: string;
    apiId: string;
    bearerToken: string;
    isOfficialWaba: boolean;
  };
  companyName: string | null;
  ttsConfig: TtsConfig;
  splitConfig: SplitConfig;
  maxDistance: number | null;
  guardrails: GuardrailsConfig;
  guardrailsApiKey: string;
  guardrailsCredentialBaseUrl: string | null;
  // The second provider behind this agent's own (agent.settings.modelFallback — issue #143), same
  // generic resolveFallbackModel/hasModelFallback Chatwoot's buildModelAndGraph uses. Resolved
  // eagerly here so runLoadedZproTurn never has to touch the DB again for it.
  modelFallback: FallbackConfig;
  modelFallbackApiKey: string;
  modelFallbackCredentialBaseUrl: string | null;
  // WhatsApp 24h window/HSM gate for PROACTIVE sends only (nudges — see runZproAgentNudge). Never
  // applied to the reactive turn tail below (always in-window by construction). See
  // docs/service-window.md.
  serviceWindowConfig: ServiceWindowConfig;
  // Native-tool config: whether handoff_to_human posts a summary note (Agent.transferWithSummary
  // column, shared with Chatwoot), operator guidance per tool (agent.settings.toolGuidance, same
  // generic reader Chatwoot uses), and the CRM pipeline kanban_move_card/update_kanban_task operate
  // on (agent.settings.zproCrm — Z-PRO's own, see src/modules/zpro/crm.ts).
  transferWithSummary: boolean;
  toolGuidance: Partial<Record<NativeToolName, string>>;
  crmConfig: ZproCrmConfig;
  // Handoff targeting (route | pinned | agent_choice) — shared config with Chatwoot
  // (src/modules/handoff/settings.ts), but "pinned"/"agent_choice" target a QUEUE here
  // (targetQueueId) instead of a Chatwoot agent/team (targetAgentId/targetTeamId, ignored on this
  // channel). See src/modules/zpro/native-tools.ts's handoffTool.
  handoffConfig: HandoffConfig;
  // send_image's host allowlist (agent.settings.sendImage — upstream #76 parity, channel-agnostic,
  // same config Chatwoot's version reads). See docs/zpro.md's "send_image" section.
  sendImageConfig: SendImageConfig;
  // Whether a tool call's arguments/result are logged as sent (true) or just their shape (false,
  // default — the documented, PII-free contract for ExecutionLog.detail). Same
  // agent.settings.observability.logToolValues key + reader Chatwoot's ToolFlowLogger wiring uses
  // (src/graph/prepare.ts) — see docs/zpro.md's "Tool-call flowlog" section.
  logToolValues: boolean;
  // Whether the operator's own debug window is open right now (agent.settings.observability.
  // fullDetail/fullDetailUntil — the same resolved flag Chatwoot's FlowContext carries), which lifts
  // the 2,000-character cut on ExecutionLog.detail for the whole turn. Read alongside logToolValues,
  // from the same readObservabilityConfig call, and threaded onto every FlowContext this module
  // builds (both the direct turn and the debounce flush).
  fullDetail: boolean;
  // Operator-selected custom-attribute keys to append as a prompt block (agent.settings.
  // attributeContext — same reader/shape Chatwoot's turn uses, src/modules/chatwoot/attributes.ts,
  // despite the module name: the builder itself is channel-agnostic, it just takes bags in). Z-PRO
  // only ever fills the "contact" scope (ZproConversation.contactExtraInfo) — "conversation"/"task"
  // stay empty, there being no Z-PRO analog of Chatwoot's own conversation/kanban-task attributes.
  attributeContext: AttributeContextConfig;
  // Operator-declared per-tool guard rules (agent.settings.toolPreconditions, issue #378 — same
  // reader/shape Chatwoot's turn uses, src/modules/agents/tool-preconditions.ts). The wrap/evaluate
  // machinery (applyToolPreconditions/guardedTool, src/graph/tools/precondition.ts) is fully
  // channel-agnostic; only the STATE loader is per-channel — Z-PRO's reads ZproConversation.
  // contactExtraInfo (the local mirror) for `contact` scope and always answers empty for
  // `conversation` (no Chatwoot custom_attributes analog). A rule set via set_custom_attribute
  // earlier in the SAME turn is not visible to a guarded call later in that turn: the tool writes
  // live to Z-PRO's API, the mirror only catches up on the next webhook — a disclosed, bounded gap,
  // not a silent one (see docs/zpro.md).
  toolPreconditions: Record<string, ToolPrecondition>;
  // Per-TENANT Langfuse config (Tenant.settings.langfuse + a vault key pair — src/graph/
  // observability.ts's resolveLangfuseConfig, fully channel-agnostic). null when tracing is off/
  // unconfigured for this tenant. See docs/zpro.md's "Langfuse tracing" section.
  langfuseCfg: LangfuseConfig | null;
  // Per-turn tool-call cap + history-token ceiling (agent.settings.limits — same reader/shape
  // src/graph/prepare.ts's Chatwoot path uses). Z-PRO calls buildAgentGraph directly rather than
  // through buildModelAndGraph, so both have to be threaded through by hand below.
  limits: ReturnType<typeof readLimitsConfig>;
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
      select: {
        baseUrl: true,
        apiId: true,
        bearerToken: true,
        isOfficialWaba: true,
      },
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
        transferWithSummary: true,
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

    // The fallback provider's own credential. Same fail-open shape as guardrails above: without a
    // key the fallback is simply not built, so the turn behaves exactly as an agent with none
    // configured — mirrors src/graph/prepare.ts's loadAgentConfig exactly.
    const modelFallback = readModelFallbackConfig(agent.settings);
    let modelFallbackApiKey = "";
    let modelFallbackCredentialBaseUrl: string | null = null;
    if (hasModelFallback(modelFallback) && modelFallback.credentialRef) {
      const fEntry = await tryResolveVaultEntry<string>(
        db,
        modelFallback.credentialRef,
      );
      if (fEntry) {
        modelFallbackApiKey = fEntry.secret;
        modelFallbackCredentialBaseUrl = fEntry.baseUrl;
      } else {
        logger.warn(
          "zpro: agent %s model fallback credentialRef %s did not resolve — there is nothing behind the provider",
          String(agent.id),
          modelFallback.credentialRef,
        );
      }
    }

    // Nome da empresa para a variável {{nome_empresa}} — mesma fonte que prepare.ts usa para o
    // Chatwoot (tenant.name sob RLS).
    const tenant = await db.tenant.findFirst({ select: { name: true } });
    // Per-tenant, channel-agnostic — same reader src/graph/prepare.ts's Chatwoot path uses.
    const langfuseCfg = await resolveLangfuseConfig(db, tenantId);
    // ONE call, like prepare.ts's own `obs` — two reads of the same settings bag could disagree
    // about `fullDetail` across the (rare) instant its window closes between them.
    const obs = readObservabilityConfig(agent.settings);

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
      sendImageConfig: readSendImageConfig(agent.settings),
      logToolValues: obs.logToolValues,
      fullDetail: obs.fullDetail,
      attributeContext: readAttributeContextConfig(agent.settings),
      toolPreconditions: readToolPreconditions(agent.settings),
      langfuseCfg,
      guardrails,
      guardrailsApiKey,
      guardrailsCredentialBaseUrl,
      modelFallback,
      modelFallbackApiKey,
      modelFallbackCredentialBaseUrl,
      transferWithSummary: agent.transferWithSummary,
      toolGuidance: readToolGuidance(agent.settings),
      crmConfig: readZproCrmConfig(agent.settings),
      handoffConfig: readHandoffConfig(agent.settings),
      serviceWindowConfig: readServiceWindowConfig(agent.settings),
      limits: readLimitsConfig(agent.settings),
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
  // Set ONLY by a PROACTIVE caller (runZproAgentNudge) — never by the reactive webhook/debounce
  // paths, which are always in-window by construction. When present, the main text reply is gated
  // by proactiveSendMode(loaded.serviceWindowConfig, lastInboundAt, now, loaded.instance.
  // isOfficialWaba) instead of always going out free-form: outside the window on a WABA-official
  // instance it sends an approved template (or, with none configured, an explained private note)
  // and SKIPS TTS entirely (a template/note is text-only). See docs/service-window.md.
  proactive?: { lastInboundAt: Date | null };
}

export type RunLoadedZproTurnOutcome =
  | "posted"
  // The two PROACTIVE-only outcomes below — never returned on the reactive/debounce paths (no
  // `proactive` param there, so `mode` is always "freeform").
  | "posted-template"
  | "posted-note-window"
  | "empty"
  | "blocked"
  | "superseded"
  | "taken-over";

// Applies a deferred resolve_conversation intent AFTER the reply is delivered — mirrors
// src/graph/runtime.ts's applyDeferredResolve exactly (see its comment for the full invariant):
// toggling mid-turn would make the next webhook mirror read our own resolve as a human takeover and
// discard the reply. Best-effort, never throws: the reply is already out, so a failed toggle only
// leaves the ticket open (flow warn pages the operator).
//
// Also patches the LOCAL ZproConversation mirror (status/agentActive) — unlike Chatwoot (where the
// conversation list can read live), our Z-PRO inbox UI is built entirely from this mirror
// (mirrorZproMessage's "source of truth for the inbox UI"), and mirror.ts only ever writes
// status/agentActive from an INBOUND webhook's ticket.status/n8nStatus. An outbound close we trigger
// ourselves never loops back through a webhook, so without this the ticket stays "pending"/
// agentActive:true in our own UI forever — confirmed live 2026-08-18: the real Z-PRO ticket was
// genuinely closed, but our list kept showing it open with the IA badge on.
// Z-PRO's own PreconditionState reader (see LoadedZproAgent.toolPreconditions above). Reads the
// LOCAL mirror, never a live Z-PRO call — same rule preconditionStateLoader follows for Chatwoot's
// tables — so `conversation` scope always answers empty (no Chatwoot custom_attributes analog) and
// `contact` scope answers whatever the last webhook mirrored, which may lag a set_custom_attribute
// call made earlier in THIS same turn (see the field comment).
function zproPreconditionStateLoader(args: {
  base: PrismaClient;
  tenantId: bigint;
  conversationId: bigint | null;
}): () => Promise<PreconditionState> {
  const { base, tenantId, conversationId } = args;
  return async () => {
    if (conversationId === null) {
      return { conversationAttributes: {}, contactAttributes: {} };
    }
    const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproConversation.findUnique({
        where: { id: conversationId },
        select: { contactExtraInfo: true },
      }),
    );
    const bag = conv?.contactExtraInfo;
    return {
      conversationAttributes: {},
      contactAttributes:
        bag && typeof bag === "object" && !Array.isArray(bag)
          ? (bag as Record<string, unknown>)
          : {},
    };
  };
}

async function applyDeferredZproResolve(
  client: ZproClient,
  ticketId: number,
  turnState: TurnState,
  flow: FlowContext,
  mirror: { tenantId: bigint; zproInstanceId: bigint; base: PrismaClient },
): Promise<void> {
  if (!turnState.resolveRequested) return;
  turnState.resolveRequested = false;
  try {
    await deactivateAgent(client, ticketId, { closeTicket: true });
    await runScopedOn(mirror.base, sysCtx(mirror.tenantId), (db) =>
      db.zproConversation.updateMany({
        where: { zproInstanceId: mirror.zproInstanceId, ticketId },
        data: { status: "closed", agentActive: false },
      }),
    );
    // Belt-and-suspenders: the close above sometimes doesn't stick on Z-PRO's side (confirmed live
    // 2026-08-18 — our log reported success, the real ticket stayed "pending"). A one-shot check 3
    // minutes out catches that case and re-syncs the mirror either way.
    await scheduleZproStatusCheck({
      tenantId: mirror.tenantId,
      zproInstanceId: mirror.zproInstanceId,
      ticketId,
      base: mirror.base,
    }).catch(() => {});
    emitFlowEvent(flow, {
      stage: "handoff",
      status: "ok",
      detail: { outcome: "resolved" },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(
      "zpro deferred resolve failed (ticket=%s): %s",
      String(ticketId),
      msg,
    );
    emitFlowEvent(flow, {
      stage: "handoff",
      level: "warn",
      status: "error",
      detail: { outcome: "resolved" },
      errorMessage: msg,
    });
  }
}

export interface ZproAttachmentDelivery {
  // Something reached the customer.
  sent: boolean;
  // It was attempted and did not get through (not a revocation, not "nothing queued").
  failed: boolean;
}

// Z-PRO analog of src/graph/runtime.ts's deliverPendingAttachments, sized to what this side actually
// queues: only DOCUMENT ever lands in TurnState.pendingAttachments here (send_image sends immediately
// inside its own tool call — see native-tools.ts's header), and buildDocumentTools's own
// documentsInFlight ceiling caps the queue at one entry per turn, so this delivers a single item
// rather than looping/sorting a batch the way Chatwoot's version has to.
export async function deliverZproPendingDocument(
  client: ZproClient,
  contactNumber: string,
  turnState: TurnState,
  flow: FlowContext,
  document: { tenantId: bigint; base: PrismaClient },
): Promise<ZproAttachmentDelivery> {
  const queued = turnState.pendingAttachments.splice(0);
  const file = queued[0];
  if (!file) return { sent: false, failed: false };
  // Same revocation recheck as Chatwoot's delivery loop, and for the identical reason: the tool
  // queues BYTES, which cannot say whether the row is still deliverable, and an operator can revoke
  // in the seconds between the tool call and this loop running.
  if (file.documentId) {
    const live = await runScopedOn(
      document.base,
      sysCtx(document.tenantId),
      (db) =>
        db.issuedDocument.findUnique({
          where: { id: file.documentId as bigint },
          select: { revoked: true },
        }),
    ).catch((e: unknown) => {
      logger.warn(
        "zpro document %s: revocation recheck failed before delivery — not sending: %s",
        String(file.documentId),
        e instanceof Error ? e.message : String(e),
      );
      return null;
    });
    if (live?.revoked !== false) {
      const revoked = live?.revoked === true;
      emitFlowEvent(flow, {
        stage: "tool",
        ...(revoked
          ? {
              status: "skipped" as const,
              detail: { tool: file.tool, outcome: "revoked_before_delivery" },
            }
          : {
              level: "warn" as const,
              status: "error" as const,
              detail: { tool: file.tool, outcome: "revocation_unknown" },
              errorMessage:
                "could not confirm whether this document was revoked; it was not sent",
            }),
      });
      return { sent: false, failed: !revoked };
    }
  }
  try {
    // sendBase64 is the generic Z-PRO file endpoint (confirmed live via tts.ts's sendZproVoiceReply —
    // sendMediaUrl needs a public URL we would otherwise have to host the PDF behind).
    await client.sendBase64(
      contactNumber,
      Buffer.from(file.bytes).toString("base64"),
      file.mime,
      file.fileName,
      file.caption,
    );
    emitFlowEvent(flow, {
      stage: "tool",
      status: "ok",
      detail: { tool: file.tool, outcome: "sent" },
    });
    return { sent: true, failed: false };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn("zpro %s delivery failed: %s", file.tool, msg);
    emitFlowEvent(flow, {
      stage: "tool",
      level: "warn",
      status: "error",
      detail: { tool: file.tool, outcome: "failed" },
      errorMessage: msg,
    });
    return { sent: false, failed: true };
  }
}

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
    fullDetail: loaded.fullDetail,
  };

  // Keeps "digitando..." alive for the WHOLE turn (guardrails + generation + tool calls can run
  // well past WhatsApp's own presence timeout, which reverted the old one-shot signal within a
  // few seconds — the reported "aparece e some" flicker). Stopped in the outer finally at the
  // bottom of this function, on every exit path (posted/blocked/taken-over/superseded/empty/thrown).
  const stopTyping = startTypingHeartbeat(client, ticketId, undefined, flow);
  try {
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
      customerText: text,
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
        await markAgentSending(tenantId, zproInstanceId, ticketId, base);
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

    // The second provider behind this agent's own (issue #143) — same resolution
    // src/graph/prepare.ts's buildFallbackModel uses, just sourced from LoadedZproAgent instead of
    // AgentConfig. Absent for every agent that configured none (which stays every agent's default
    // behavior: unbounded retries, no second attempt).
    const fallback = ((): FallbackModel | undefined => {
      if (!hasModelFallback(loaded.modelFallback)) return undefined;
      const unavailable = (reason: string): undefined => {
        logger.warn(
          "zpro: agent %s a model fallback is configured but cannot run (%s), so the provider has nothing behind it",
          String(loaded.agentId),
          reason,
        );
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider: loaded.modelFallback.provider ?? undefined,
          model: loaded.modelFallback.model ?? undefined,
          detail: { fallbackUnavailable: reason },
        });
        return undefined;
      };
      const resolved = resolveFallbackModel(
        loaded.modelFallback,
        {
          provider: loaded.mc.provider,
          model: loaded.mc.model,
          baseURL: loaded.credentialBaseUrl ?? loaded.mc.baseURL,
        },
        { ownCredentialBaseURL: loaded.modelFallbackCredentialBaseUrl },
      );
      if (!resolved.runnable)
        return unavailable(resolved.reason ?? "not_runnable");
      const own = resolved.credential === "own";
      if (own && !loaded.modelFallbackApiKey)
        return unavailable("credential_not_found");
      const fmc: ResolvedModelConfig = {
        provider: resolved.provider as ModelConfig["provider"],
        model: resolved.model,
        apiKey:
          resolved.credential === "own"
            ? loaded.modelFallbackApiKey
            : resolved.credential === "agent"
              ? loaded.apiKey
              : "",
        baseURL: resolved.baseURL ?? undefined,
        temperature: loaded.mc.temperature,
        ...(resolved.provider === loaded.mc.provider &&
        loaded.mc.reasoningEffort
          ? { reasoningEffort: loaded.mc.reasoningEffort }
          : {}),
        maxRetries: PRIMARY_MAX_RETRIES,
        timeoutMs: PRIMARY_TIMEOUT_MS,
      };
      try {
        return {
          model: createChatModel(fmc),
          provider: fmc.provider,
          modelId: fmc.model,
        };
      } catch (err) {
        logger.warn(
          { err, agentId: String(loaded.agentId) },
          "zpro: model fallback config is not runnable",
        );
        return undefined;
      }
    })();
    const model = createChatModel({
      ...loaded.mc,
      apiKey: loaded.apiKey,
      baseURL: loaded.credentialBaseUrl ?? loaded.mc.baseURL,
      // Bounded ONLY when something was actually built behind it — an agent with no fallback keeps
      // the unbounded default retry/wait, byte for byte (see src/graph/model-fallback.ts).
      ...(fallback
        ? { maxRetries: PRIMARY_MAX_RETRIES, timeoutMs: PRIMARY_TIMEOUT_MS }
        : {}),
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
    // Mutable per-turn state shared with the native tools (deferred resolve intent) — mirrors
    // src/graph/runtime.ts's own turnState exactly.
    const turnState: TurnState = {
      resolveRequested: false,
      pendingAttachments: [],
      documentsInFlight: 0,
      imagesInFlight: 0,
      attachmentsSeq: 0,
    };
    // Operator guidance per tool (agent.settings.toolGuidance), plus the handoff transfer guidance
    // (agent.settings.handoff.instructions) and the CRM funnel guidance (agent.settings.zproCrm.
    // instructions) folded onto handoff_to_human/kanban_move_card specifically — mirrors
    // src/graph/prepare.ts's exact merge (its own grouped configs win over the flat map for those
    // two tools). NOTE: this fold was missing until 2026-08-18 — handoffConfig.instructions reached
    // ctx.handoffCfg (routing still worked) but never ctx.toolInstructions, so the model never saw
    // the operator's queue-selection guidance in the tool description, only in `agent_choice`'s bare
    // <available_queues> list.
    const toolInstructions: Partial<Record<NativeToolName, string>> = {
      ...loaded.toolGuidance,
    };
    if (loaded.handoffConfig.instructions) {
      toolInstructions.handoff_to_human = loaded.handoffConfig.instructions;
    }
    if (loaded.crmConfig.instructions) {
      toolInstructions.kanban_move_card = loaded.crmConfig.instructions;
    }
    const {
      tools: agentTools,
      conversationId,
      grounded,
      contactExtraInfoBag,
    } = await loadZproAgentTools({
      base,
      tenantId,
      agentId: loaded.agentId,
      zproInstanceId,
      ticketId,
      threadId,
      client,
      turnState,
      transferWithSummary: loaded.transferWithSummary,
      toolInstructions,
      handoffConfig: loaded.handoffConfig,
      pipelineId: loaded.crmConfig.pipelineId,
      flow,
      maxDistance: loaded.maxDistance,
      contactName: ev.contactName,
      contactNumber: ev.contactNumber,
      companyName: loaded.companyName,
      contactExtraInfo: ev.extraInfo,
      sendImage: loaded.sendImageConfig,
    });
    const tools = [...agentTools];
    // Resolve {{nome_contato}}, {{primeiro_nome}}, {{telefone_contato}}, {{canal}}, {{nome_empresa}},
    // {{nome_agente}} e as variáveis de hora/data — mesmo interpolador sanitizado (proteção contra
    // prompt injection) que o Chatwoot usa via prepare.ts.
    const handoffGranted = agentTools.some(
      (t) => t.name === "handoff_to_human",
    );
    // A/B: an active experiment for this agent may override the system prompt for this thread —
    // same primitive src/graph/prepare.ts's Chatwoot turn asks (resolveVariantOverride is already
    // fully channel-agnostic: tenantId/agentId/threadId only, no Chatwoot coupling anywhere in it).
    const promptOverride = await runScopedOn(base, sysCtx(tenantId), (db) =>
      resolveVariantOverride(db, {
        tenantId,
        agentId: loaded.agentId,
        threadId,
      }),
    );
    const promptTemplate = composeSystemPrompt(
      promptOverride ?? loaded.systemPrompt,
      { grounded, handoffGranted },
    );
    const promptVars = buildPromptVars({
      contactName: ev.contactName,
      contactPhone: ev.contactNumber,
      inboxName: ev.channelType,
      companyName: loaded.companyName,
      agentName: loaded.agentName,
    });
    const promptOpts = { timezone: DEFAULT_TIMEZONE, now: new Date() };
    const renderedPrompt = interpolatePromptVars(
      promptTemplate,
      promptVars,
      promptOpts,
    );
    // Same block Chatwoot's turn prep appends (src/modules/chatwoot/attributes.ts), CONTACT scope
    // only — Z-PRO's mirrored bag (ticket.contact.extraInfo) has no conversation- or task-scope
    // analogue (no Chatwoot custom_attributes, no Kanban Pro card). Absent selection ⇒ no block.
    const attributeSection = !isAttributeContextEmpty(loaded.attributeContext)
      ? buildAttributeContextSection(
          attributeBagsFrom({ contactAttributes: contactExtraInfoBag }),
          loaded.attributeContext,
          undefined,
          agentTools.some((t) => t.name === "set_custom_attribute"),
        )
      : null;
    const systemPrompt = attributeSection
      ? `${renderedPrompt}\n\n${attributeSection}`
      : renderedPrompt;
    // Redacted twin of the prompt above, for the flow-log's `generate` line (see
    // src/graph/prompt-audit.ts). Z-PRO had zero wiring for this: the RAW resolved prompt — real
    // contact name/phone, and now every exposed attribute value — was what the Logs page showed for
    // every Z-PRO turn.
    const auditedSections: AuditedSection[] = attributeSection
      ? [
          {
            label: "atributos",
            keys: loaded.attributeContext.contact.map((k) => `contact:${k}`),
            text: attributeSection,
          },
        ]
      : [];
    const systemPromptAudit = buildPromptAudit({
      template: promptTemplate,
      vars: promptVars,
      opts: promptOpts,
      sections: auditedSections,
    });
    // set_voice_preference (TTS "preference" mode only — no point exposing it when the agent always
    // replies in text/mirror): unlike the other native tools (built inside loadZproAgentTools, gated
    // by the SAME grant UI Chatwoot uses), this one needs currentVoiceReply (resolved below, after
    // the tools call) so it is wired directly here rather than through buildZproNativeTools.
    // voiceReplyNow further down re-reads it AFTER the invoke so a preference set THIS turn still
    // governs THIS reply.
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
    // Precondition seam (issue #378) — one map keyed by tool NAME reaches every source already
    // merged into `tools` above, same six-line shape src/graph/prepare.ts uses. An agent with no
    // rules configured gets the same array back, untouched.
    const guardedTools = applyToolPreconditions(
      tools,
      loaded.toolPreconditions,
      zproPreconditionStateLoader({ base, tenantId, conversationId }),
      (info) => emitFlowEvent(flow, preconditionFlowEvent(info)),
      (unmatched) => {
        emitFlowEvent(flow, unmatchedPreconditionEvent(unmatched));
        logger.warn(
          "zpro agent %s: precondition(s) on tool(s) not in this turn's toolset (%s) — the tool is NOT guarded",
          String(loaded.agentId),
          unmatched.join(", "),
        );
      },
    );
    const graph = buildAgentGraph({
      model,
      systemPrompt,
      checkpointer,
      tools: guardedTools,
      primary: { provider: loaded.mc.provider, model: loaded.mc.model },
      fallback,
      // Mirrors src/graph/runtime.ts's onModelRetry wiring (upstream #68): a turn recovered from a
      // provider answering 200 with no completion must not read like a clean one, or the fault rate
      // is invisible. Z-PRO calls buildAgentGraph directly (not through prepare.ts's
      // buildModelAndGraph), so this needs its own wiring rather than inheriting Chatwoot's.
      onModelRetry: ({ attempt }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider: loaded.mc.provider,
          model: loaded.mc.model,
          detail: { retriedEmptyResponse: attempt },
        }),
      // A fallback that ANSWERS produces a successful turn, so this is the operator's one signal that
      // a provider they are paying for is not taking their traffic — mirrors src/graph/runtime.ts.
      onModelFallback: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          provider,
          model,
          detail: { fallbackFrom: loaded.mc.provider, fallbackReason: reason },
        }),
      // Attribution, not a second alarm (see src/graph/runtime.ts's own comment on this line): the
      // `generate` stage's own error already carries the alert, this just says WHICH model died.
      onModelFallbackFailed: ({ provider, model, reason }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "info",
          status: "error",
          provider,
          model,
          detail: { fallbackFailed: reason },
        }),
      // Same reason as onModelRetry above: buildAgentGraph is called directly here, so the per-turn
      // tool-call cap and history-token ceiling (agent.settings.limits) need their own wiring rather
      // than inheriting Chatwoot's buildModelAndGraph plumbing (src/graph/prepare.ts).
      maxToolCalls: loaded.limits.maxToolCalls,
      onToolLimit: ({ maxToolCalls, toolCalls }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "warn",
          status: "ok",
          detail: { toolLimitHit: maxToolCalls, toolCalls },
        }),
      maxHistoryTokens: loaded.limits.maxHistoryTokens,
      onHistoryTrim: ({ kept, dropped, tokens }) =>
        emitFlowEvent(flow, {
          stage: "generate",
          level: "info",
          status: "ok",
          detail: {
            historyKept: kept,
            historyDropped: dropped,
            historyTokens: tokens,
          },
        }),
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
    // Logs each tool call (name/status/duration) under this turn's flow group — mirrors
    // src/graph/runtime.ts's exact wiring. Fully channel-agnostic (no Chatwoot coupling in
    // ToolFlowLogger itself), so this was only ever a missing CALL, not a missing capability.
    const toolLogger = new ToolFlowLogger(flow, {
      logValues: loaded.logToolValues,
      tools: guardedTools,
    });
    // Per-tenant Langfuse trace (mirrors src/graph/prepare.ts's buildCallbacks — buildLangfuseHandler
    // itself has no Chatwoot coupling, so this was only ever a missing CALL, same as ToolFlowLogger
    // above). null when the tenant hasn't configured Langfuse; conversationId here is Z-PRO's own
    // ZproConversation.id — a display-only trace metadata field, not a foreign key, so reusing the
    // same field name across channels carries none of LlmUsage's cross-system collision risk.
    const toolTrace = buildToolTraceMetadata(
      guardedTools,
      loaded.langfuseCfg?.debug,
    );
    const langfuse = buildLangfuseHandler(loaded.langfuseCfg, {
      tenantId,
      threadId,
      conversationId,
      agentId: loaded.agentId,
      userId: loaded.langfuseCfg?.tenantSlug,
      turnId,
      source: "inbox",
      ...toolTrace,
    });

    // The live "agent is working" indicator on the per-tenant realtime channel — Z-PRO analogue of
    // src/graph/runtime.ts's AgentStatusReporter wiring. `started` here (conversationId is only known
    // once tools have loaded, unlike Chatwoot where it's known upfront) through a GUARANTEED
    // `finished` in the finally below (every exit — posted, empty, taken-over, superseded, or thrown
    // — clears it).
    const status = new ZproAgentStatusReporter({
      tenantId,
      zproConversationId: conversationId,
    });
    status.started();
    let deliveredBalloons: number | null = null;
    try {
      const result = await withFlowStage(
        flow,
        "generate",
        {
          provider: loaded.mc.provider,
          model: loaded.mc.model,
          // The prompt the agent was given THIS turn, audited — mirrors src/graph/runtime.ts's own
          // wiring (item 15 / docs/logs.md). See prompt-audit.ts for the redaction rule.
          detail: { systemPrompt: systemPromptAudit },
        },
        () =>
          graph.invoke(
            { messages: [new HumanMessage(text)] },
            {
              configurable: { thread_id: threadId },
              callbacks: langfuse
                ? [usageCapture, status, toolLogger, langfuse]
                : [usageCapture, status, toolLogger],
            },
          ),
      );

      let reply = lastAssistantText(result.messages).trim();

      // Proactive nudges (runZproAgentNudge, e.g. the inactivity follow-up sweep) instruct the
      // model to reply with the exact FOLLOWUP_SKIP_SENTINEL token when no message is warranted.
      // Chatwoot's own nudge path (src/graph/nudge.ts's runAgentNudge) detects/strips this BEFORE
      // ever posting; this shared turn tail has no such check by default (a normal customer turn
      // never rationally emits this token, since nothing prompts it to outside a nudge), so it's
      // applied only when this turn IS a nudge. Missing this let a literal "[[SKIP]]" reach a real
      // customer (confirmed live 2026-08-18) whenever the model chose silence on a follow-up.
      if (params.proactive) {
        reply = isNudgeSilent(reply)
          ? ""
          : reply.split(FOLLOWUP_SKIP_SENTINEL).join("").trim();
      }

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
      if (params.shouldPost && !(await params.shouldPost()))
        return "superseded";

      // OUTPUT guardrail: screen the model's reply BEFORE delivery — together with anything a queued
      // document tool wrote (field values / line-item descriptions the customer reads on the PDF, via
      // PendingAttachment.screenText). Runs even when `reply` is empty and a document is queued (a
      // document-only turn is a legitimate shape and its text still needs screening); `screened` is
      // "" and the call is skipped when there is truly nothing on either side, same as before this
      // composite existed. Mirrors src/graph/runtime.ts's own placement, ahead of the empty-reply
      // branch below (a violation must drop the queued document too, not just the reply).
      const modelWritten = turnState.pendingAttachments
        .map((a) => a.screenText?.trim())
        .filter((c): c is string => !!c);
      const screened = [reply, ...modelWritten].filter(Boolean).join("\n");
      const outGuard = screened ? await runGuardrail("output", screened) : null;
      if (outGuard) {
        if (outGuard.reply === null) {
          turnState.pendingAttachments.length = 0;
          return "blocked";
        }
        reply = outGuard.reply;
      }

      // Empty reply: nothing to post as TEXT, but a queued document + a deferred resolve intent are
      // still legitimate shapes — mirrors src/graph/runtime.ts's exact placement, AFTER the recheck
      // and the supersede gate (resolving under a takeover/superseded turn would be wrong). Ported
      // from Chatwoot's own "empty reply, attachment still applies" handling, missing here before:
      // a document tool call with no accompanying text used to lose the PDF silently and report
      // "empty" on a turn that DID answer the customer.
      if (!reply) {
        const { sent } = await deliverZproPendingDocument(
          client,
          ev.contactNumber,
          turnState,
          flow,
          { tenantId, base },
        );
        await applyDeferredZproResolve(client, ticketId, turnState, flow, {
          tenantId,
          zproInstanceId,
          base,
        });
        return sent ? "posted" : "empty";
      }

      // The document lands before the text reply that talks about it, same ordering Chatwoot's
      // runtime uses. Best-effort: a delivery failure here does not block the text reply below —
      // losing the customer's answer over a PDF would be the worse outcome.
      await deliverZproPendingDocument(
        client,
        ev.contactNumber,
        turnState,
        flow,
        {
          tenantId,
          base,
        },
      );

      // PROACTIVE-only WhatsApp 24h window gate (runZproAgentNudge sets `proactive`; the reactive
      // webhook/debounce paths never do, so `mode` is always "freeform" there). Outside the window on
      // a WABA-official instance: an approved template if configured, else an explained private note —
      // text-only, so this branch SKIPS the TTS/text delivery below entirely on either sub-outcome.
      if (params.proactive) {
        const mode = proactiveSendMode(
          loaded.serviceWindowConfig,
          params.proactive.lastInboundAt,
          new Date(),
          loaded.instance.isOfficialWaba,
        );
        if (mode === "template") {
          const payload = buildTemplatePayload(
            loaded.serviceWindowConfig,
            null,
          );
          if (payload) {
            await markAgentSending(tenantId, zproInstanceId, ticketId, base);
            await sendZproTemplate(client, ev.contactNumber, payload);
            logger.info(
              "zpro agent replied (template, outside 24h window): thread=%s ticket=%s template=%s",
              threadId,
              ev.threadId,
              payload.name,
            );
            await applyDeferredZproResolve(client, ticketId, turnState, flow, {
              tenantId,
              zproInstanceId,
              base,
            });
            return "posted-template";
          }
          // No template configured → fall through to the explained note below (never a free-form
          // send WhatsApp/the WABA provider would reject).
        }
        if (mode !== "freeform") {
          await client.createNote(
            ticketId,
            `${OUTSIDE_WINDOW_NOTE_PREFIX}${reply}`,
          );
          logger.info(
            "zpro agent noted (outside 24h window, no template): thread=%s ticket=%s",
            threadId,
            ev.threadId,
          );
          await applyDeferredZproResolve(client, ticketId, turnState, flow, {
            tenantId,
            zproInstanceId,
            base,
          });
          return "posted-note-window";
        }
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
            await markAgentSending(tenantId, zproInstanceId, ticketId, base);
            // Separate stage line from the "tts" synthesis one above — a throw here (the actual
            // Z-PRO API call to deliver the voice note) was previously invisible in /logs, only a
            // stdout-only logger.warn on the way to the text fallback below. withFlowStage's
            // errorLevel:"warn" matches that recovered-by-fallback severity.
            await withFlowStage(
              flow,
              "tts",
              { detail: { step: "send" }, errorLevel: "warn" },
              () =>
                sendZproVoiceReply(client, ev, tts, turnState.resolveRequested),
            );
            logger.info(
              "zpro agent replied (audio): thread=%s ticket=%s len=%d",
              threadId,
              ev.threadId,
              reply.length,
            );
            deliveredBalloons = 1;
            await applyDeferredZproResolve(client, ticketId, turnState, flow, {
              tenantId,
              zproInstanceId,
              base,
            });
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
      await markAgentSending(tenantId, zproInstanceId, ticketId, base);
      const balloons = await deliverZproReply(
        client,
        ev,
        reply,
        loaded.splitConfig,
        undefined,
        flow,
        turnState.resolveRequested,
      );
      logger.info(
        "zpro agent replied: thread=%s ticket=%s len=%d balloons=%d",
        threadId,
        ev.threadId,
        reply.length,
        balloons,
      );
      deliveredBalloons = balloons;
      await applyDeferredZproResolve(client, ticketId, turnState, flow, {
        tenantId,
        zproInstanceId,
        base,
      });
      return "posted";
    } finally {
      status.finished(deliveredBalloons);
    }
  } finally {
    stopTyping();
  }
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
  // sem extração (STT/vision) ganha um marcador de fallback (withMediaFallback, mirrors Chatwoot's
  // render.ts) em vez de ficar muda — sem isso o turno era silenciosamente descartado e o cliente
  // não recebia resposta nem erro visível (KNOWN GAP, ver docs/zpro.md). Uma resposta a uma
  // mensagem específica (WhatsApp reply) ganha o prefixo "<em resposta a: ...>" — sem isso o
  // agente vê só o texto novo e perde de vista a pergunta original sendo retomada.
  const text = withQuotedPrefix(
    withMediaFallback(ev.body || ev.mediaCaption || "", ev.messageType),
    ev.quotedText,
  );
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
    // "posted-template"/"posted-note-window" are unreachable on this path (no `proactive` param is
    // ever passed here — only runZproAgentNudge sets it), but map them defensively for exhaustiveness.
    return outcome === "posted" ||
      outcome === "posted-template" ||
      outcome === "posted-note-window"
      ? "replied"
      : outcome;
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
