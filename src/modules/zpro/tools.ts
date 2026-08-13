// src/modules/zpro/tools.ts
// Ferramentas concedidas ao agente vinculado a uma instância Z-PRO. Reaproveita a MESMA cadeia
// genérica que o Chatwoot usa (src/graph/tools/assemble.ts's loadToolSelections + cada builder de
// fonte — buildToolpackTools, buildRagTools, buildHttpTools, loadMcpToolsForAgent), sem tocar em
// nada Chatwoot-specific: nenhuma dessas peças exige um ChatwootClient ou uma linha Conversation/
// Inbox mirror. As tools nativas de CONVERSA (handoff/nota/atributo/etiqueta/resolver/funil CRM/
// pular resposta) são a implementação PARALELA em native-tools.ts (não a de native.ts, que é
// hard-coded pra ChatwootClient) — ver o cabeçalho daquele arquivo para o mapeamento completo.
// react_to_message não tem análogo (API Z-PRO sem endpoint de reação) e nunca é construída aqui.
// set_voice_preference é tratada à parte em tts.ts (Contact.voiceReply não existe no Z-PRO).
//
// contactDbId (ToolpackCtx/RagToolCtx) usa ZproConversation.id como stamp de isolamento por cliente
// — Z-PRO não tem uma tabela Contact equivalente à do Chatwoot (única por número de telefone); a
// entidade mais próxima é ZproConversation, única por (zproInstanceId, ticketId). Trade-off aceito:
// um número que abrir um ticket novo depois ganha um id novo e "perde" visibilidade dos
// agendamentos/dados feitos no ticket anterior. O stamp é só uma string opaca de controle de
// acesso — não precisa ser um "Contact" de verdade (ver docs/zpro.md).

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import config from "@/config";
import {
  resolveBusinessHoursById,
  resolveInjectableCredential,
} from "@/graph/prepare";
import { buildHttpTools, loadToolSelections } from "@/graph/tools/assemble";
import type { NativeToolName } from "@/graph/tools/catalog";
import { loadMcpToolsForAgent } from "@/graph/tools/mcp";
import { buildNativeTools, utilityNativeAllow } from "@/graph/tools/native";
import { buildRagTools } from "@/graph/tools/rag";
import { runScopedOn } from "@/lib/tenancy";
import {
  cancelAppointmentReminders,
  enqueueAppointmentReminders,
} from "@/modules/appointments/reminders";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { buildToolpackTools } from "@/modules/integrations/toolpacks";
import type { ZproClient } from "./client";
import {
  loadZproStages,
  loadZproTags,
  resolveZproPipelineId,
  type ZproKanbanContext,
} from "./crm";
import { sysCtx } from "./ctx";
import { buildZproNativeTools, type TurnState } from "./native-tools";

export interface ZproAgentTools {
  tools: StructuredToolInterface[];
  // Resolved here regardless of whether any tool needed it (also feeds UsageCapture's
  // zproConversationId and the TTS voice-preference tool in runtime.ts) — one lookup shared by
  // several consumers.
  conversationId: bigint | null;
  // Whether search_knowledge was granted — the caller composes the grounding directive onto the
  // system prompt when true (see src/graph/prompt.ts's composeSystemPrompt, same as Chatwoot).
  grounded: boolean;
}

export interface LoadZproAgentToolsParams {
  base: PrismaClient;
  tenantId: bigint;
  agentId: bigint;
  zproInstanceId: bigint;
  ticketId: number;
  threadId: string;
  // The live client + native-tool context, built by runtime.ts (already has the client + guardrail
  // model ready). Optional so tests / call sites that only need RAG/HTTP/MCP/INTEGRATION can omit it
  // — native conversation tools are then simply not built.
  client?: ZproClient;
  turnState?: TurnState;
  transferWithSummary?: boolean;
  toolInstructions?: Partial<Record<NativeToolName, string>>;
  // agent.settings.zproCrm.pipelineId (src/modules/zpro/crm.ts's readZproCrmConfig) — null ⇒
  // auto-detect the tenant's sole pipeline.
  pipelineId?: number | null;
  // Flow telemetry context for THIS turn — when present, a native tool's side-effect failure (e.g.
  // the deal upsert inside kanban_move_card) is surfaced as a flowlog `tool` warn.
  flow?: FlowContext;
  // Optional RAG grounding threshold (agent.settings.grounding.maxDistance, resolved by the
  // caller via src/graph/prepare.ts's readMaxDistance — reads the same settings bag runtime.ts
  // already loaded). Undefined ⇒ no distance filtering (recall preserved), a valid default.
  maxDistance?: number | null;
  // {{placeholder}} context for custom HTTP tools (fixed fields, headers, URL, raw body) — mirrors
  // Chatwoot's httpToolContext. Omitted keys are simply unavailable to interpolate.
  contactName?: string | null;
  contactNumber?: string | null;
  companyName?: string | null;
}

export async function loadZproAgentTools(
  params: LoadZproAgentToolsParams,
): Promise<ZproAgentTools> {
  const { base, tenantId, agentId, zproInstanceId, ticketId, threadId } =
    params;

  // Scoped DB read only (no network) — mirrors src/graph/prepare.ts's own tx boundary: MCP
  // connect/discover and the toolpack/RAG/HTTP/native tool builds happen AFTER this closes.
  const { conversation, selections } = await runScopedOn(
    base,
    sysCtx(tenantId),
    async (db) => {
      const conversation = await db.zproConversation.findUnique({
        where: { zproInstanceId_ticketId: { zproInstanceId, ticketId } },
        select: {
          id: true,
          contactId: true,
          opportunityId: true,
          opportunityPipelineId: true,
          opportunityStageId: true,
          opportunityStageName: true,
          opportunityTitle: true,
        },
      });
      const selections = await loadToolSelections(db, agentId);
      return { conversation, selections };
    },
  );
  const conversationId = conversation?.id ?? null;

  const resolveCredential = (ref: string) =>
    resolveInjectableCredential(base, tenantId, ref);
  const resolveBusinessHours = (id: string) =>
    resolveBusinessHoursById(base, tenantId, id);

  // Hoisted above toolpackTools (native-tools-only in the original port) so the Calendar toolpack's
  // reminder-enqueue failures can also surface here — see scheduleAppointmentReminders below.
  const onSideEffectError = params.flow
    ? (e: {
        tool: string;
        phase: string;
        detail?: Record<string, unknown>;
        err: unknown;
      }) =>
        emitFlowEvent(params.flow as FlowContext, {
          stage: "tool",
          level: "warn",
          status: "error",
          detail: { ...(e.detail ?? {}), tool: e.tool, phase: e.phase },
          errorMessage: e.err instanceof Error ? e.err.message : String(e.err),
        })
    : undefined;

  // Deterministic appointment reminders (mirrors src/graph/prepare.ts's Chatwoot wiring): when the
  // Calendar toolpack books an appointment, arm one scheduler job per configured offset; cancel them
  // on cancel/reschedule. enqueueAppointmentReminders/cancelAppointmentReminders are channel-agnostic
  // (threadId-keyed, never touch Conversation/Inbox) — the mechanism was already reusable, it just
  // wasn't wired into this ToolpackCtx, so a Z-PRO agent's booked appointment silently got no
  // reminders armed. `threadId` here is always the zpro:-shaped one (runtime.ts's zproThreadId), which
  // appointmentReminderHandler now knows how to route back (see runZproAgentNudge in nudge.ts).
  const scheduleAppointmentReminders = async (a: {
    eventId: string;
    calendarId: string;
    startISO: string;
    credentialRef: string | null;
    offsetsHours: number[];
    askConfirmationOnLast: boolean;
    summary: string | null;
    calendarLabel: string | null;
  }) => {
    try {
      await enqueueAppointmentReminders({
        tenantId,
        threadId,
        eventId: a.eventId,
        calendarId: a.calendarId,
        credentialRef: a.credentialRef,
        startISO: a.startISO,
        offsetsHours: a.offsetsHours,
        askConfirmationOnLast: a.askConfirmationOnLast,
        summary: a.summary,
        calendarLabel: a.calendarLabel,
        base,
      });
    } catch (e) {
      logger.warn(
        "zpro appointment reminders enqueue failed: %s",
        e instanceof Error ? e.message : String(e),
      );
      onSideEffectError?.({
        tool: "google_calendar",
        phase: "reminders_enqueue",
        detail: { eventId: a.eventId },
        err: e,
      });
    }
  };
  const cancelAppointmentRemindersFn = async (eventId: string) => {
    try {
      await cancelAppointmentReminders(tenantId, eventId, base);
    } catch (e) {
      logger.warn(
        "zpro appointment reminders cancel failed: %s",
        e instanceof Error ? e.message : String(e),
      );
      onSideEffectError?.({
        tool: "google_calendar",
        phase: "reminders_cancel",
        detail: { eventId },
        err: e,
      });
    }
  };

  const toolpackTools =
    selections.integrationSelections.length > 0
      ? buildToolpackTools(selections.integrationSelections, {
          tenantId,
          base,
          threadId,
          contactDbId: conversationId,
          resolveCredential,
          resolveBusinessHours,
          scheduleAppointmentReminders,
          cancelAppointmentReminders: cancelAppointmentRemindersFn,
          onSideEffectError,
        })
      : [];

  const ragTools = buildRagTools(
    {
      tenantId,
      base,
      knowledgeBaseIds: selections.ragConfig?.knowledgeBaseIds ?? [],
      knowledgeBases: selections.ragConfig?.knowledgeBases,
      threadId,
      maxDistance: params.maxDistance ?? selections.ragConfig?.maxDistance,
    },
    selections.ragConfig?.tools,
  );

  const httpTools = buildHttpTools(selections.httpToolDefs, {
    resolveCredential,
    // Same tie to the SSRF dev-escape as Chatwoot (src/graph/prepare.ts): prod stays https-only,
    // dev (SSRF_ALLOW_PRIVATE_TARGETS on by default) allows an operator's local HTTP tool to work.
    allowHttp: config.ssrf.allowPrivateTargets,
    context: {
      ticket_id: String(ticketId),
      ...(params.contactName ? { contact_name: params.contactName } : {}),
      ...(params.contactNumber ? { contact_phone: params.contactNumber } : {}),
      ...(params.companyName ? { company_name: params.companyName } : {}),
    },
  });

  // The only network call in this function so far — deliberately OUTSIDE the scoped read above.
  const mcpTools = await loadMcpToolsForAgent(
    tenantId,
    selections.mcpSelections,
    {
      refreshCredential: (t, ref) => resolveInjectableCredential(base, t, ref),
    },
  );

  // Utility-only NATIVE tools (calculator, get_current_time), respecting the agent's actual
  // allowlist (undefined ⇒ all utility tools — same permissive default as Chatwoot).
  const utilityTools = buildNativeTools(
    { client: {} as ChatwootClient, conversationId: 0, tenantId, base },
    utilityNativeAllow(selections.nativeToolsAllow),
  );

  // Conversation-scoped NATIVE tools (handoff/note/attribute/label/resolve/funnel/skip), built ONLY
  // when the caller supplied a live client (runtime.ts always does; tests exercising just RAG/HTTP/
  // MCP/INTEGRATION may omit it). Grounds assign_label with the account's known tags and
  // kanban_move_card/update_kanban_task with the resolved CRM pipeline — each ONLY when the
  // respective tool is actually granted (undefined allowlist ⇒ all ⇒ resolve both), so the common
  // case (neither tool granted) pays zero extra network calls.
  let nativeConversationTools: StructuredToolInterface[] = [];
  if (params.client && conversationId != null && conversation) {
    const client = params.client;
    const allow = selections.nativeToolsAllow;
    const cacheKey = `${tenantId}:${zproInstanceId}`;

    const needsTags = !allow || allow.includes("assign_label");
    const knownTags = needsTags
      ? await loadZproTags(client, cacheKey).catch((e) => {
          logger.warn(
            "zpro assign_label: tag list failed (ticket=%s): %s",
            String(ticketId),
            e instanceof Error ? e.message : String(e),
          );
          onSideEffectError?.({
            tool: "assign_label",
            phase: "list_tags",
            err: e,
          });
          return [];
        })
      : undefined;

    const needsKanban =
      !allow ||
      allow.includes("kanban_move_card") ||
      allow.includes("update_kanban_task");
    let kanban: ZproKanbanContext | undefined;
    if (needsKanban) {
      try {
        const pipeline = await resolveZproPipelineId(
          client,
          params.pipelineId ?? null,
          cacheKey,
        );
        const stages =
          pipeline != null
            ? await loadZproStages(client, pipeline.id, cacheKey)
            : [];
        kanban = {
          pipelineId: pipeline?.id ?? null,
          pipelineName: pipeline?.name ?? null,
          stages,
          opportunityId: conversation.opportunityId,
          opportunityTitle: conversation.opportunityTitle,
          currentStageId: conversation.opportunityStageId,
          currentStageName: conversation.opportunityStageName,
        };
      } catch (e) {
        // resolveZproPipelineId's own contract (crm.ts) is "keep the configured id even if a listing
        // call fails — a transient error must not silently disable an explicitly-configured pipeline."
        // That guarantee only covers a SUCCESSFUL list missing the id; listPipelines/listStages
        // THROWING lands here instead, so preserve params.pipelineId ourselves (not null) to actually
        // honor it — an empty `stages` array still degrades gracefully (kanban_move_card reports
        // "unknown stage, available: (none)" rather than "no pipeline configured").
        kanban = {
          pipelineId: params.pipelineId ?? null,
          pipelineName: null,
          stages: [],
          opportunityId: conversation.opportunityId,
          opportunityTitle: conversation.opportunityTitle,
          currentStageId: conversation.opportunityStageId,
          currentStageName: conversation.opportunityStageName,
        };
        logger.warn(
          "zpro kanban pipeline/stage resolution failed (ticket=%s): %s",
          String(ticketId),
          e instanceof Error ? e.message : String(e),
        );
        onSideEffectError?.({
          tool: "kanban_move_card",
          phase: "pipeline_resolve",
          detail: { configuredPipelineId: params.pipelineId ?? null },
          err: e,
        });
      }
    }

    nativeConversationTools = buildZproNativeTools(
      {
        client,
        ticketId,
        contactId: conversation.contactId,
        contactNumber: params.contactNumber ?? "",
        contactName: params.contactName ?? null,
        tenantId,
        base,
        conversationDbId: conversationId,
        turnState: params.turnState,
        transferWithSummary: params.transferWithSummary,
        toolInstructions: params.toolInstructions,
        knownTags,
        kanban,
        onSideEffectError,
      },
      allow,
    );
  }

  return {
    tools: [
      ...nativeConversationTools,
      ...toolpackTools,
      ...ragTools,
      ...httpTools,
      ...mcpTools,
      ...utilityTools,
    ],
    conversationId,
    grounded: !!selections.ragConfig?.tools.includes("search_knowledge"),
  };
}
