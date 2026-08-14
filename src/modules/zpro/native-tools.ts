// src/modules/zpro/native-tools.ts
// Z-PRO backing for the conversation-scoped NATIVE tools (src/graph/tools/catalog.ts's
// CONVERSATION_NATIVE_TOOL_NAMES). Chatwoot's implementations (src/graph/tools/native.ts) are ALL
// hard-typed to ChatwootClient (kanban board/step/task, Chatwoot labels, Chatwoot custom-attribute
// definitions, Chatwoot agents/teams) — none of that is reusable here, so this is a parallel
// implementation over ZproClient, mapped onto Z-PRO's own primitives:
//
//   handoff_to_human    → deactivateAgent (n8nStatus:false) + an optional note + an optional
//                         customer message. "route" semantics ONLY: Chatwoot's pinned/agent_choice
//                         targeting (agent.settings.handoff.targetAgentId/targetTeamId) are Chatwoot
//                         USER ids — applying them to a Z-PRO ticket's `userId` would silently
//                         assign the WRONG person (a cross-system id collision, same class of risk
//                         already avoided for LlmUsage.zproConversationId — see docs/zpro.md). A
//                         Z-PRO `listUsers` + a dedicated target picker is future work if ever needed.
//   private_note        → ZproClient.createNote (ticket-level, visible to human attendants only).
//   set_custom_attribute → ZproClient.updateContactExtraInfo (CONTACT scope only — Z-PRO has no
//                         conversation/ticket-level custom-field API). Read-merge-write: the
//                         endpoint's replace-vs-merge semantics are unconfirmed (no example response
//                         in the vendor's Postman collection), so we always read first and resend the
//                         full array, never trusting a server-side merge.
//   assign_label         → Z-PRO tags (addTag/addTagContact), which are id-based unlike Chatwoot's
//                         free-string labels — resolved by name against listTags at turn prep
//                         (src/modules/zpro/tools.ts), auto-CREATING a new tag on a miss so the
//                         model can tag freely (mirrors Chatwoot's effective behavior, where posting
//                         an unknown label string auto-creates it server-side).
//   resolve_conversation → deactivateAgent(..., {closeTicket:true}). Deferred via TurnState exactly
//                         like Chatwoot (see src/modules/zpro/runtime.ts's applyDeferredZproResolve):
//                         toggling mid-turn would make the next webhook mirror read our own resolve
//                         as a human takeover and discard the reply.
//   kanban_move_card,
//   update_kanban_task   → the CRM Pipeline → Stage → Opportunity funnel (src/modules/zpro/crm.ts),
//                         NOT Z-PRO's simpler per-CONTACT "kanban carteira" (updateContactKanban) —
//                         chosen because it is the only Z-PRO concept with card-like fields (name/
//                         value/status/responsible/closing date) and per-conversation granularity is
//                         achievable by linking one Opportunity per ZproConversation. Z-PRO has no
//                         per-id GET for an Opportunity, so the "current stage" is OUR OWN mirror
//                         (ZproConversation.opportunity*), refreshed on every successful write —
//                         documented as a known, best-effort limitation (docs/zpro.md). The linked
//                         Opportunity is created LAZILY on first tool use in a conversation (Z-PRO,
//                         unlike Chatwoot, has no operator-driven "attach an existing card" UI).
//   skip_reply            → identical to Chatwoot's (pure — never touches a client).
//   route_to_queue        → ZproClient.updateQueue (move the ticket to another department/queue).
//                         Z-PRO-ONLY, the inverse asymmetry of react_to_message below: no Chatwoot
//                         concept of "fila" exists (the closest analog, handoff_to_human's
//                         targetTeamId, already covers routing on that channel), so this is never
//                         built in src/graph/tools/native.ts. Unlike assign_label, resolution is
//                         FAIL-CLOSED (no auto-create): a queue is operator-managed structure, not a
//                         free-form tag, so an unrecognized name is reported back to the model
//                         instead of silently creating a new department.
//
// react_to_message has NO analog: the external Z-PRO API exposes no message-reaction endpoint at
// all (confirmed against the full vendor Postman collection, docs/zpro-api-reference.md). It is
// simply never built here — src/modules/zpro/tools.ts's native-tool allowlist intersection means a
// grant for it (inherited from a dual Chatwoot+Z-PRO agent) silently has no effect on Z-PRO turns,
// same as any other tool this file doesn't implement.

import type { StructuredToolInterface } from "@langchain/core/tools";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import type { NativeToolName } from "@/graph/tools/catalog";
import { toolFailure } from "@/graph/tools/failure";
import { simulatedTool } from "@/graph/tools/native";
import { runScopedOn } from "@/lib/tenancy";
import { xmlAttr, xmlEscape } from "@/lib/xml";
import type { SideEffectErrorReporter } from "@/modules/integrations/toolpacks";
import type { ZproClient } from "./client";
import {
  matchZproStage,
  type ZproKanbanContext,
  type ZproPipeline,
} from "./crm";
import { sysCtx } from "./ctx";
import { deactivateAgent } from "./handoff";
import { buildSetVoicePreferenceTool } from "./tts";

const DEFAULT_TAG_COLOR = "#6b7280";

// Mutable per-turn state shared with runLoadedZproTurn (deferred resolve). Structural twin of
// src/graph/tools/native.ts's TurnState — kept separate on purpose (no cross-import), same rationale
// as src/graph/prepare.ts's own structural mirror of it.
export interface TurnState {
  resolveRequested: boolean;
}

export interface ZproToolCtx {
  client: ZproClient;
  ticketId: number;
  // Canonical checkpointer/scheduler thread id (runtime.ts's zproThreadId) + the instance it belongs
  // to — needed by schedule_message to enqueue a SCHEDULED_MESSAGE job dispatchable later without a
  // live turn. Always present from loadZproAgentTools (runtime.ts's only real caller); optional here
  // only so hand-built ctx in tests can omit it.
  threadId?: string;
  zproInstanceId?: bigint;
  contactId: number;
  contactNumber: string;
  contactName: string | null;
  tenantId: bigint;
  base: PrismaClient;
  conversationDbId: bigint;
  // Absent ⇒ resolve_conversation applies immediately (legacy/no-turn-context shape); only
  // runLoadedZproTurn passes it, mirroring Chatwoot's ToolCtx.turnState.
  turnState?: TurnState;
  // Per-agent toggle (default ON when undefined): mirrors ToolCtx.transferWithSummary.
  transferWithSummary?: boolean;
  toolInstructions?: Partial<Record<NativeToolName, string>>;
  // Known tags (id+name), resolved once at turn prep — lets assign_label suggest existing tags AND
  // resolve a name to an id without a network call inside the tool body.
  knownTags?: ZproPipeline[];
  // Known queues (id+name), same resolve-once pattern as knownTags — lets route_to_queue suggest
  // existing queues AND resolve a name to an id without a network call inside the tool body.
  knownQueues?: ZproPipeline[];
  // This conversation's CRM deal context (see crm.ts). Absent ⇒ kanban_move_card/update_kanban_task
  // were not granted this turn (their resolve is skipped to avoid the extra network calls).
  kanban?: ZproKanbanContext;
  onSideEffectError?: SideEffectErrorReporter;
}

function withOperatorNote(
  base: string,
  ctx: ZproToolCtx,
  name: NativeToolName,
  context?: string,
): string {
  const note = ctx.toolInstructions?.[name]?.trim();
  const parts = [base];
  if (note) parts.push(`Operator guidance: ${note}`);
  if (context?.trim()) parts.push(context.trim());
  return parts.join("\n\n");
}

function extractId(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const candidates = [o.id, o.opportunityId, o.tagId];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isInteger(c) && c > 0) return c;
  }
  const nested = o.data ?? o.payload;
  if (nested && typeof nested === "object") return extractId(nested);
  return null;
}

function unwrapExtraInfoList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.extraInfo)) return o.extraInfo;
    if (Array.isArray(o.data)) return o.data;
  }
  return [];
}

function parseExtraInfo(raw: unknown): Array<{ name: string; value: string }> {
  const out: Array<{ name: string; value: string }> = [];
  for (const item of unwrapExtraInfoList(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    if (typeof o.name === "string" && typeof o.value === "string") {
      out.push({ name: o.name, value: o.value });
    }
  }
  return out;
}

// ── handoff_to_human ────────────────────────────────────────────────────────

function handoffTool(ctx: ZproToolCtx) {
  const baseDescription =
    "Escalate the conversation to a human agent. Optionally include a short summary posted as an internal note before the handoff. Use when the customer needs human help or asks for it. Before transferring, set `customerMessage` to a brief reply to the customer (e.g. that a human will continue) so they are not left without an answer.";
  return tool(
    async ({
      reason,
      customerMessage,
    }: {
      reason?: string;
      customerMessage?: string;
    }) => {
      if (customerMessage?.trim()) {
        try {
          await ctx.client.sendText(ctx.contactNumber, customerMessage.trim(), {
            validateNumber: false,
            externalKey: `handoff-${ctx.ticketId}-${Date.now()}`,
          });
        } catch (e) {
          logger.warn(
            "zpro handoff customer message failed (ticket=%s): %s",
            String(ctx.ticketId),
            e instanceof Error ? e.message : String(e),
          );
          ctx.onSideEffectError?.({
            tool: "handoff_to_human",
            phase: "customer_message",
            err: e,
          });
        }
      }
      if (reason && ctx.transferWithSummary !== false) {
        try {
          await ctx.client.createNote(ctx.ticketId, reason);
        } catch (e) {
          logger.warn(
            "zpro handoff note failed (ticket=%s): %s",
            String(ctx.ticketId),
            e instanceof Error ? e.message : String(e),
          );
          ctx.onSideEffectError?.({
            tool: "handoff_to_human",
            phase: "note",
            err: e,
          });
        }
      }
      await deactivateAgent(ctx.client, ctx.ticketId);
      return "Handed off to a human. The bot will stay silent now.";
    },
    {
      name: "handoff_to_human",
      description: withOperatorNote(baseDescription, ctx, "handoff_to_human"),
      schema: z.object({
        reason: z
          .string()
          .optional()
          .describe("Short private-note summary for the human taking over."),
        customerMessage: z
          .string()
          .optional()
          .describe(
            "A short message to the CUSTOMER, sent before the transfer (e.g. that a human will continue). Strongly recommended so they are not left without a reply.",
          ),
      }),
    },
  );
}

// ── private_note ────────────────────────────────────────────────────────────

function privateNoteTool(ctx: ZproToolCtx) {
  return tool(
    async ({ content }: { content: string }) => {
      await ctx.client.createNote(ctx.ticketId, content);
      return "Private note posted (visible to human attendants, not the customer).";
    },
    {
      name: "private_note",
      description: withOperatorNote(
        "Leave an internal note for the human team (NOT visible to the customer). Use it to record context a human will need later — a special request, a caveat, something to follow up on. To escalate to a human right now, use handoff_to_human instead.",
        ctx,
        "private_note",
      ),
      schema: z.object({ content: z.string().min(1) }),
    },
  );
}

// ── set_custom_attribute (contact scope only — see module header) ──────────

function setCustomAttributeTool(ctx: ZproToolCtx) {
  const baseDescription =
    "Set a custom attribute (memory) on the contact — a key/value pair that persists across conversations and is visible to human attendants in the Z-PRO panel.";
  return tool(
    async ({ key, value }: { key: string; value: string }) => {
      const k = key.trim();
      if (!k) return "No attribute key provided.";
      let current: Array<{ name: string; value: string }>;
      try {
        current = parseExtraInfo(
          await ctx.client.getContactExtraInfo(ctx.contactId),
        );
      } catch (e) {
        // Fail CLOSED: this write always resends the FULL attribute array (no partial-update API on
        // Z-PRO's side), so proceeding with current=[] on a read failure would silently erase every
        // other attribute already stored for this contact. Abort before ever calling
        // updateContactExtraInfo rather than risk that destructive overwrite.
        logger.warn(
          "zpro set_custom_attribute: read failed (contact=%s): %s",
          String(ctx.contactId),
          e instanceof Error ? e.message : String(e),
        );
        return "Could not set the attribute: failed to read the contact's existing attributes first, so writing now would have erased them. Try again.";
      }
      const next = [...current.filter((f) => f.name !== k), { name: k, value }];
      await ctx.client.updateContactExtraInfo(ctx.contactId, next);
      return `Contact attribute ${k} set.`;
    },
    {
      name: "set_custom_attribute",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "set_custom_attribute",
      ),
      schema: z.object({ key: z.string().min(1), value: z.string() }),
    },
  );
}

// ── assign_label (Z-PRO tags) ───────────────────────────────────────────────

function existingLabelsXml(names: string[]): string {
  if (names.length === 0) return "";
  const CAP = 40;
  const els = names
    .slice(0, CAP)
    .map((l) => `  <label>${xmlEscape(l)}</label>`);
  if (names.length > CAP) els.push(`  <more count="${names.length - CAP}"/>`);
  return `<existing_labels>\n${els.join("\n")}\n</existing_labels>`;
}

// Resolve a label name to a tag id against the known (pre-listed) tags, case-insensitive; auto-
// creates a new tag on a miss (mirrors Chatwoot's effective behavior, where posting an unknown label
// string auto-creates it server-side). Exported so the generic follow-up's deterministic assignLabels
// post-action (src/modules/followups/handlers.ts) can reuse the exact same resolve-or-create logic
// instead of re-implementing it against ZproClient.
export async function resolveOrCreateZproTagId(
  client: ZproClient,
  label: string,
  known: ZproPipeline[] = [],
): Promise<number | null> {
  const clean = label.trim();
  if (!clean) return null;
  const existing = known.find(
    (t) => t.name.toLowerCase() === clean.toLowerCase(),
  )?.id;
  if (existing != null) return existing;
  try {
    return extractId(await client.createTag(clean, DEFAULT_TAG_COLOR, true));
  } catch (e) {
    logger.warn(
      "zpro: createTag failed (%s): %s",
      clean,
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

function assignLabelTool(ctx: ZproToolCtx) {
  const known = ctx.knownTags ?? [];
  const labelsXml = existingLabelsXml(known.map((t) => t.name));
  const baseDescription = `Add a label (tag) to categorize the conversation or the contact. Use scope to choose (default 'conversation'). ${
    labelsXml
      ? "Prefer an EXISTING label from `<existing_labels>` below; a new one is created automatically if none matches."
      : "A new label is created automatically if it doesn't exist yet."
  }`;
  return tool(
    async ({
      label,
      scope,
    }: {
      label: string;
      scope?: "conversation" | "contact";
    }) => {
      const clean = label.trim();
      if (!clean) return "No label provided.";
      const tagId = await resolveOrCreateZproTagId(ctx.client, clean, known);
      if (tagId == null) {
        return `Could not create the label "${clean}".`;
      }
      if (scope === "contact") {
        await ctx.client.addTagContact(ctx.contactId, tagId);
        return `Label "${clean}" added to the contact.`;
      }
      await ctx.client.addTag(ctx.ticketId, tagId);
      return `Label "${clean}" added to the conversation.`;
    },
    {
      name: "assign_label",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "assign_label",
        labelsXml,
      ),
      schema: z.object({
        label: z
          .string()
          .min(1)
          .describe("The label/tag to add, e.g. 'vip' or 'orçamento'."),
        scope: z
          .enum(["conversation", "contact"])
          .optional()
          .describe("Where to add it: 'conversation' (default) or 'contact'."),
      }),
    },
  );
}

// ── route_to_queue (Z-PRO-only — no Chatwoot analog; see native.ts's handoff
// targetTeamId for the closest Chatwoot equivalent) ────────────────────────

function existingQueuesXml(names: string[]): string {
  if (names.length === 0) return "";
  const els = names.map((q) => `  <queue>${xmlEscape(q)}</queue>`);
  return `<available_queues>\n${els.join("\n")}\n</available_queues>`;
}

function routeToQueueTool(ctx: ZproToolCtx) {
  const known = ctx.knownQueues ?? [];
  const queuesXml = existingQueuesXml(known.map((q) => q.name));
  const baseDescription =
    known.length > 0
      ? "Route this conversation to a department/queue. Pass the target queue's name as `queue`, picking one from `<available_queues>` below."
      : "Route this conversation to a department/queue. Not available right now: no queues are configured for this instance.";
  return tool(
    async ({ queue }: { queue: string }) => {
      const clean = queue.trim();
      if (!clean) return "No queue provided.";
      // Fail closed, unlike assign_label: a queue is operator-managed structure (a department), not a
      // free-form tag, so an unrecognized name must not silently create one.
      const match = known.find(
        (q) => q.name.toLowerCase() === clean.toLowerCase(),
      );
      if (!match) {
        return known.length > 0
          ? `Queue "${clean}" not found. Available: ${known.map((q) => q.name).join(", ")}.`
          : `Queue "${clean}" not found. No queues are configured for this instance.`;
      }
      try {
        await ctx.client.updateQueue(ctx.ticketId, match.id);
      } catch (e) {
        logger.warn(
          "zpro route_to_queue failed (ticket=%s): %s",
          String(ctx.ticketId),
          e instanceof Error ? e.message : String(e),
        );
        ctx.onSideEffectError?.({
          tool: "route_to_queue",
          phase: "update_queue",
          err: e,
        });
        return toolFailure("Could not route to that queue.");
      }
      return `Routed to the "${match.name}" queue.`;
    },
    {
      name: "route_to_queue",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "route_to_queue",
        queuesXml,
      ),
      schema: z.object({
        queue: z
          .string()
          .min(1)
          .describe("The target queue/department name, exactly as listed."),
      }),
    },
  );
}

// ── resolve_conversation ────────────────────────────────────────────────────

function resolveConversationTool(ctx: ZproToolCtx) {
  const deferred = ctx.turnState !== undefined;
  return tool(
    async () => {
      const ts = ctx.turnState;
      if (ts) {
        ts.resolveRequested = true;
        return "Resolve scheduled: the conversation will be marked resolved after your final reply in this turn is delivered.";
      }
      await deactivateAgent(ctx.client, ctx.ticketId, { closeTicket: true });
      return "Conversation resolved.";
    },
    {
      name: "resolve_conversation",
      description: deferred
        ? "Mark the conversation as resolved when the customer's request is fully handled. The status change is applied automatically after your final reply this turn is delivered — write any closing confirmation as your normal reply."
        : "Mark the conversation as resolved when the customer's request is fully handled.",
      schema: z.object({}),
    },
  );
}

// ── kanban_move_card / update_kanban_task (CRM Pipeline/Stage/Opportunity) ─

function kanbanContextXml(k: ZproKanbanContext): string {
  const lines: string[] = [
    `<kanban_card${xmlAttr("board", k.pipelineName || undefined)}>`,
  ];
  if (k.currentStageName) {
    lines.push(
      `  <current_step>${xmlEscape(k.currentStageName)}</current_step>`,
    );
  }
  if (k.stages.length > 0) {
    lines.push("  <available_steps>");
    for (const s of k.stages) {
      lines.push(`    <step>${xmlEscape(s.name)}</step>`);
    }
    lines.push("  </available_steps>");
  }
  lines.push("</kanban_card>");
  return lines.join("\n");
}

// Creates the linked Opportunity on first use, or updates the existing one. Always resends `name`
// (required by the Z-PRO API on every write, see module header) from the patch or the last known
// title, and persists the resulting snapshot onto ZproConversation (best-effort mirror; see crm.ts).
async function upsertOpportunity(
  ctx: ZproToolCtx,
  k: ZproKanbanContext,
  pipelineId: number,
  patch: {
    stageId?: number;
    name?: string;
    description?: string;
    value?: number;
    status?: "open" | "win" | "lose";
    closingForecast?: string;
  },
): Promise<{ stageId: number; stageName: string }> {
  const stageId = patch.stageId ?? k.currentStageId ?? k.stages[0]?.id;
  if (stageId == null) {
    throw new Error("no stage available in this pipeline");
  }
  const stageName =
    k.stages.find((s) => s.id === stageId)?.name ?? k.currentStageName ?? "";
  const title =
    patch.name ?? k.opportunityTitle ?? ctx.contactName ?? ctx.contactNumber;
  let opportunityId = k.opportunityId;
  if (opportunityId == null) {
    const created = await ctx.client.createOpportunity({
      number: ctx.contactNumber,
      contactName: ctx.contactName ?? undefined,
      name: title,
      pipelineId,
      stageId,
      status: patch.status ?? "open",
      value: patch.value,
      description: patch.description,
      closingForecast: patch.closingForecast,
      validateNumber: false,
    });
    const id = extractId(created);
    if (id == null)
      throw new Error("createOpportunity: unexpected response shape");
    opportunityId = id;
  } else {
    await ctx.client.updateOpportunity(opportunityId, {
      name: title,
      pipelineId,
      stageId,
      status: patch.status,
      value: patch.value,
      description: patch.description,
      closingForecast: patch.closingForecast,
    });
  }
  const id = opportunityId;
  await runScopedOn(ctx.base, sysCtx(ctx.tenantId), (db) =>
    db.zproConversation.update({
      where: { id: ctx.conversationDbId },
      data: {
        opportunityId: id,
        opportunityPipelineId: pipelineId,
        opportunityStageId: stageId,
        opportunityStageName: stageName,
        opportunityTitle: title,
      },
    }),
  );
  return { stageId, stageName };
}

function kanbanMoveTool(ctx: ZproToolCtx) {
  const k = ctx.kanban;
  const configured = !!k && k.pipelineId != null;
  const baseDescription = configured
    ? `Move this conversation's deal to another stage of the${k?.pipelineName ? ` "${k.pipelineName}"` : ""} CRM pipeline. Pass the target stage's name as \`targetStep\`, picking one from \`<available_steps>\` below.`
    : "Move this conversation's deal to another CRM pipeline stage. Not available right now: no CRM pipeline is configured for this agent (or more than one exists and none was chosen — ask the operator to set agent.settings.zproCrm.pipelineId).";
  const contextXml = configured && k ? kanbanContextXml(k) : undefined;
  return tool(
    async ({ targetStep }: { targetStep: string }) => {
      if (!k || k.pipelineId == null) {
        return "No CRM pipeline is configured, so there is nothing to move.";
      }
      const stage = matchZproStage(k.stages, targetStep);
      if (!stage) {
        return `Unknown stage "${targetStep}". Available: ${k.stages
          .map((s) => s.name)
          .join(", ")}.`;
      }
      if (k.opportunityId != null && stage.id === k.currentStageId) {
        return `The deal is already in "${stage.name}".`;
      }
      try {
        await upsertOpportunity(ctx, k, k.pipelineId, { stageId: stage.id });
      } catch (e) {
        logger.warn(
          "zpro kanban_move_card failed (ticket=%s): %s",
          String(ctx.ticketId),
          e instanceof Error ? e.message : String(e),
        );
        ctx.onSideEffectError?.({
          tool: "kanban_move_card",
          phase: "upsert_opportunity",
          err: e,
        });
        return toolFailure("Could not move the deal.");
      }
      return `Moved the deal to "${stage.name}".`;
    },
    {
      name: "kanban_move_card",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "kanban_move_card",
        contextXml,
      ),
      schema: z.object({
        targetStep: z
          .string()
          .min(1)
          .describe("The pipeline stage to move the deal to, by name."),
      }),
    },
  );
}

function updateKanbanTaskTool(ctx: ZproToolCtx) {
  const k = ctx.kanban;
  const configured = !!k && k.pipelineId != null;
  const baseDescription = configured
    ? "Update this conversation's CRM deal: its title, description, monetary value, status (open/win/lose) and/or expected closing date. Provide ONLY the fields you want to change."
    : "Update this conversation's CRM deal. Not available right now: no CRM pipeline is configured for this agent.";
  const contextXml =
    configured && k && k.opportunityId != null
      ? `<current_card>\n  <title>${xmlEscape(k.opportunityTitle ?? "")}</title>\n</current_card>`
      : undefined;
  return tool(
    async (input: {
      title?: string;
      description?: string;
      value?: number;
      status?: "open" | "win" | "lose";
      closingForecast?: string;
    }) => {
      if (!k || k.pipelineId == null) {
        return "No CRM pipeline is configured, so there is nothing to update.";
      }
      const patch: {
        name?: string;
        description?: string;
        value?: number;
        status?: "open" | "win" | "lose";
        closingForecast?: string;
      } = {};
      if (input.title !== undefined) patch.name = input.title;
      if (input.description !== undefined)
        patch.description = input.description;
      if (input.value !== undefined) patch.value = input.value;
      if (input.status !== undefined) patch.status = input.status;
      if (input.closingForecast !== undefined)
        patch.closingForecast = input.closingForecast;
      if (Object.keys(patch).length === 0) {
        return "No fields provided. Set at least one of title, description, value, status or closingForecast.";
      }
      try {
        await upsertOpportunity(ctx, k, k.pipelineId, patch);
      } catch (e) {
        logger.warn(
          "zpro update_kanban_task failed (ticket=%s): %s",
          String(ctx.ticketId),
          e instanceof Error ? e.message : String(e),
        );
        ctx.onSideEffectError?.({
          tool: "update_kanban_task",
          phase: "upsert_opportunity",
          err: e,
        });
        return toolFailure("Could not update the deal.");
      }
      return `Updated the deal (${Object.keys(patch).join(", ")}).`;
    },
    {
      name: "update_kanban_task",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "update_kanban_task",
        contextXml,
      ),
      schema: z.object({
        title: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("New deal title."),
        description: z
          .string()
          .max(5000)
          .optional()
          .describe("New deal description."),
        value: z
          .number()
          .nonnegative()
          .optional()
          .describe("Deal monetary value."),
        status: z
          .enum(["open", "win", "lose"])
          .optional()
          .describe("Deal outcome status."),
        closingForecast: z
          .string()
          .optional()
          .describe('Expected closing date, ISO 8601 (e.g. "2026-06-20").'),
      }),
    },
  );
}

// ── skip_reply (identical to Chatwoot's — pure, never touches a client) ────

function skipReplyTool(_ctx: ZproToolCtx) {
  return tool(
    async ({ reason }: { reason?: string }) => {
      return reason
        ? `Acknowledged: not replying this turn (${reason}). Produce no message now.`
        : "Acknowledged: not replying this turn. Produce no message now.";
    },
    {
      name: "skip_reply",
      description:
        "Decide NOT to send any reply this turn. Use ONLY when a reply would add nothing — e.g. the customer sent just an acknowledgement ('ok', 'blz', 'obrigado') or a bare emoji. After calling this, output NO reply text (end your turn). The decision is recorded in the conversation timeline.",
      schema: z.object({
        reason: z
          .string()
          .optional()
          .describe(
            "Short reason for not replying (e.g. \"customer only sent 'ok'\").",
          ),
      }),
    },
  );
}

// allowed = undefined → all 8 tools; otherwise only the named subset (fail-closed, mirrors
// src/graph/tools/native.ts's buildNativeTools). react_to_message is never built (see module header).
export function buildZproNativeTools(
  ctx: ZproToolCtx,
  allowed?: Iterable<string>,
): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [
    handoffTool(ctx),
    privateNoteTool(ctx),
    setCustomAttributeTool(ctx),
    assignLabelTool(ctx),
    resolveConversationTool(ctx),
    kanbanMoveTool(ctx),
    updateKanbanTaskTool(ctx),
    routeToQueueTool(ctx),
    skipReplyTool(ctx),
  ];
  if (!allowed) return all;
  const allow = new Set(allowed);
  return all.filter((t) => allow.has(t.name));
}

// Playground variant: every Z-PRO conversation tool the agent could ever be granted is SIMULATED
// (no real ZproClient call, no ZproConversation write) — mirrors src/graph/tools/native.ts's
// buildSimulatedNativeTools, reusing its channel-agnostic simulatedTool() wrapper. Covers the 8
// tools above PLUS set_voice_preference (built separately in runtime.ts for real turns, gated on
// ttsConfig.mode === "preference" — here it's shown unconditionally, same as Chatwoot's playground,
// since the point is testing the agent's DECISION to call it, not the TTS mode gate). Z-PRO has no
// utility tools of its own to leave un-simulated (calculator/get_current_time are Chatwoot's,
// stubbed the same way in production — see tools.ts — so the caller builds those separately).
export function buildSimulatedZproNativeTools(
  ctx: ZproToolCtx,
  allowed?: Iterable<string>,
): StructuredToolInterface[] {
  const tools = buildZproNativeTools(ctx, allowed).map(simulatedTool);
  const allow = allowed ? new Set(allowed) : null;
  if (!allow || allow.has("set_voice_preference")) {
    tools.push(
      simulatedTool(
        buildSetVoicePreferenceTool({
          tenantId: ctx.tenantId,
          base: ctx.base,
          conversationId: ctx.conversationDbId,
          currentVoiceReply: null,
        }),
      ),
    );
  }
  return tools;
}
