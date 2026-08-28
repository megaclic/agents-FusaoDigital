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
//   get_contact_info      → PURE read from ctx, no network call at tool-call time. The counterpart
//                         to set_custom_attribute/assign_label's writes, which had no way to be read
//                         back before this: currentQueueName/contactTagNames are resolved once at
//                         turn prep (tools.ts) against the SAME cached catalogs route_to_queue/
//                         assign_label already load; contactExtraInfo is threaded straight from
//                         NormalizedZproEvent.extraInfo (normalize.ts already extracted it from
//                         ticket.contact.extraInfo on every webhook — previously extracted and never
//                         read by anything).
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
//   schedule_message      → scheduleMessage (src/modules/scheduled-messages/service.ts), a bare
//                         scheduler job carrying free-form instructions, delivered via
//                         runZproAgentNudge. Channel-agnostic capability (the Chatwoot twin lives in
//                         src/graph/tools/native.ts) — exists because a delayed-send request used to
//                         be pure hallucination: the model confirmed it in prose with no tool call
//                         behind it, so nothing ever arrived.
//   send_image             → ZproClient.sendMediaUrl (upstream #76 parity), reading the SAME
//                         agent.settings.sendImage.allowedHosts config Chatwoot's version does
//                         (src/modules/images/settings.ts, fully channel-agnostic — no UI change
//                         needed). Deliberately SIMPLER than Chatwoot's: Chatwoot has no "send by
//                         URL" primitive, so it downloads the image itself (byte cap, signature
//                         sniff, a per-turn queue delivered after the graph's gates) before
//                         re-uploading it as an attachment. Z-PRO's sendMediaUrl accepts the
//                         operator-approved URL directly — no download, no re-upload, no queue —
//                         so this sends immediately inside the tool call, same as every other
//                         direct-send native tool here (marks agentSendingUntil first, like
//                         handoff_to_human's customerMessage, to avoid the false-HUMAN echo
//                         misclassification). The trade-off: an image sent this way does NOT pass
//                         through the output guardrail (only its caption would have) — an accepted,
//                         documented gap Chatwoot's own fuller implementation shares (its captions
//                         are screened, the picture itself never is).
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
import { type PendingAttachment, simulatedTool } from "@/graph/tools/native";
import { runScopedOn } from "@/lib/tenancy";
import { xmlAttr, xmlEscape } from "@/lib/xml";
import type { HandoffConfig } from "@/modules/handoff/settings";
import {
  isAllowedImageHost,
  SEND_IMAGE_DEFAULTS,
  SEND_IMAGE_MAX_CAPTION_CHARS,
  type SendImageConfig,
} from "@/modules/images/settings";
import type { SideEffectErrorReporter } from "@/modules/integrations/toolpacks";
import {
  clampDelayMinutes,
  scheduleMessage,
} from "@/modules/scheduled-messages/service";
import { emitOutbound } from "@/modules/webhooks/outbound/service";
import { markAgentSending } from "./agent-echo";
import type { ZproClient } from "./client";
import {
  matchZproStage,
  type ZproKanbanContext,
  type ZproPipeline,
} from "./crm";
import { sysCtx } from "./ctx";
import { deactivateAgent } from "./handoff";
import { scheduleZproStatusCheck } from "./status-reconcile";
import { buildSetVoicePreferenceTool } from "./tts";

const DEFAULT_TAG_COLOR = "#6b7280";

// Mutable per-turn state shared with runLoadedZproTurn (deferred resolve). Structural twin of
// src/graph/tools/native.ts's TurnState — kept separate on purpose (no cross-import of the type
// itself, though PendingAttachment above is imported since it is already channel-agnostic and a
// second copy of ITS shape would be the very drift this file's separation is meant to avoid), same
// rationale as src/graph/prepare.ts's own structural mirror of it.
export interface TurnState {
  resolveRequested: boolean;
  // The shared document tool (src/graph/tools/documents.ts, built once for both channels — see
  // tools.ts) queues here exactly as it does for Chatwoot; only DOCUMENT ever lands in this queue on
  // the Z-PRO side (send_image sends immediately inside its own tool call instead, see this file's
  // header comment), so runtime.ts's delivery step never needs Chatwoot's multi-item batching.
  pendingAttachments: PendingAttachment[];
  // Same reservation-before-await ceiling as Chatwoot's, and for the identical reason (a batch of
  // tool calls runs under Promise.all, so a check reading only the queue is read by all of them
  // while it is still empty).
  documentsInFlight: number;
  // Present, but never incremented on this side: buildDocumentTools's DocumentToolDeps.turnState is
  // typed as src/graph/tools/native.ts's TurnState (structural, not this file's own), which requires
  // it. send_image's own budget tracking stays local to that immediate-send path and never touches
  // this field.
  imagesInFlight: number;
  attachmentsSeq: number;
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
  // Handoff targeting (route | pinned | agent_choice) — see handoffTool below. Absent ⇒ "route" (no
  // queue routing on handoff, current/legacy behavior).
  handoffCfg?: HandoffConfig;
  // Known tags (id+name), resolved once at turn prep — lets assign_label suggest existing tags AND
  // resolve a name to an id without a network call inside the tool body.
  knownTags?: ZproPipeline[];
  // Known queues (id+name), same resolve-once pattern as knownTags — lets route_to_queue suggest
  // existing queues AND resolve a name to an id without a network call inside the tool body.
  knownQueues?: ZproPipeline[];
  // This conversation's CRM deal context (see crm.ts). Absent ⇒ kanban_move_card/update_kanban_task
  // were not granted this turn (their resolve is skipped to avoid the extra network calls).
  kanban?: ZproKanbanContext;
  // get_contact_info's read-only snapshot, resolved once at turn prep (tools.ts) against the SAME
  // knownQueues/knownTags catalogs route_to_queue/assign_label already load — no extra network call
  // for this tool specifically. currentQueueName is null when the ticket has no queue (or it isn't
  // in the catalog); contactTagNames/contactExtraInfo are [] when the mirror/webhook had none.
  currentQueueName?: string | null;
  contactTagNames?: string[];
  contactExtraInfo?: Array<{ name: string; value: string }>;
  // send_image's host allowlist — same agent.settings.sendImage config Chatwoot's version reads
  // (src/modules/images/settings.ts). Absent ⇒ SEND_IMAGE_DEFAULTS (empty allowlist, refuses every
  // call).
  sendImage?: SendImageConfig;
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
// Targeting mirrors src/graph/tools/native.ts's handoffTool exactly (same HandoffMode), but Z-PRO's
// target is a QUEUE (department) — the only Z-PRO concept close to "who receives the handoff", since
// there is no Chatwoot-style agent/team here. "pinned" applies ctx.handoffCfg.targetQueueId directly
// (an operator-configured id, no catalog needed). "agent_choice" lets the model pass `queue` — a name
// resolved against ctx.knownQueues (same catalog route_to_queue uses), rendered as <available_queues>
// in the description exactly like route_to_queue's own resolution. Routing is best-effort and runs
// AFTER deactivateAgent: a queue-routing failure must never block the handoff itself — getting SOME
// human on the line matters more than getting the RIGHT department.

function handoffTool(ctx: ZproToolCtx) {
  const mode = ctx.handoffCfg?.mode ?? "route";
  const queueChoice = mode === "agent_choice";
  const known = ctx.knownQueues ?? [];
  const queuesXml = queueChoice
    ? existingQueuesXml(known.map((q) => q.name))
    : "";
  const coreDescription = queueChoice
    ? queuesXml
      ? "Escalate the conversation to a human agent. Set `queue` to one of the departments listed in `<available_queues>` below to route there before transferring; omit it to leave the ticket's current queue unchanged."
      : "Escalate the conversation to a human agent. Optionally set `queue` — the name of the department to route to (use one of the names from your instructions); omit it to leave the ticket's current queue unchanged."
    : "Escalate the conversation to a human agent.";
  const baseDescription = `${coreDescription} Optionally include a short summary posted as an internal note before the handoff. Use when the customer needs human help or asks for it. Before transferring, set \`customerMessage\` to a brief reply to the customer (e.g. that a human will continue) so they are not left without an answer.`;
  return tool(
    async ({
      reason,
      customerMessage,
      queue,
    }: {
      reason?: string;
      customerMessage?: string;
      queue?: string;
    }) => {
      if (customerMessage?.trim()) {
        try {
          // Marca ANTES de enviar — este é um send de mensagem pro CLIENTE fora do caminho normal
          // (runtime.ts's deliverZproReply), então o eco fromMe dele não seria reconhecido como
          // nosso sem isto: mirror.ts classificaria a resposta do próprio agente como HUMAN, o que
          // dispara (redundantemente aqui, mas silenciosamente em qualquer tool futura que envie
          // direto sem desativar) o gate de auto-handoff em zpro.controller.ts. Confirmado como uma
          // causa real de auto-desativação ao vivo (2026-08-14): esta era a ÚNICA tool nativa com um
          // client.sendText direto fora de runLoadedZproTurn.
          if (ctx.zproInstanceId) {
            await markAgentSending(
              ctx.tenantId,
              ctx.zproInstanceId,
              ctx.ticketId,
              ctx.base,
            );
          }
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

      let routed = "";
      try {
        if (mode === "pinned" && ctx.handoffCfg?.targetQueueId) {
          await ctx.client.updateQueue(
            ctx.ticketId,
            ctx.handoffCfg.targetQueueId,
          );
          routed = " Routed to the configured queue.";
        } else if (queueChoice && queue?.trim()) {
          const clean = queue.trim();
          const match = known.find(
            (q) => q.name.toLowerCase() === clean.toLowerCase(),
          );
          if (match) {
            await ctx.client.updateQueue(ctx.ticketId, match.id);
            routed = ` Routed to the "${match.name}" queue.`;
          } else {
            await ctx.client.createNote(
              ctx.ticketId,
              `Tentei encaminhar para a fila "${clean}", mas não encontrei nenhuma fila com esse nome. O ticket ficou na fila atual.`,
            );
            routed = ` No queue named "${clean}" was found; left in the current queue.`;
          }
        }
      } catch (e) {
        logger.warn(
          "zpro handoff queue route failed (ticket=%s): %s",
          String(ctx.ticketId),
          e instanceof Error ? e.message : String(e),
        );
        ctx.onSideEffectError?.({
          tool: "handoff_to_human",
          phase: "route_queue",
          err: e,
        });
      }
      // A human closing the ticket afterward from the Z-PRO panel — no message attached — never
      // fires a webhook we'd otherwise learn it from (mirrorZproMessage only runs on
      // method:"message"). One check 3 minutes out catches that and syncs the mirror; see
      // status-reconcile.ts. Best-effort, and only for a real turn (not Playground, where
      // zproInstanceId is absent).
      if (ctx.zproInstanceId) {
        await scheduleZproStatusCheck({
          tenantId: ctx.tenantId,
          zproInstanceId: ctx.zproInstanceId,
          ticketId: ctx.ticketId,
          base: ctx.base,
        }).catch(() => {});
      }
      return `Handed off to a human.${routed} The bot will stay silent now.`;
    },
    {
      name: "handoff_to_human",
      description: withOperatorNote(
        baseDescription,
        ctx,
        "handoff_to_human",
        queuesXml,
      ),
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
        queue: z
          .string()
          .optional()
          .describe(
            "The target queue/department name to route to before transferring, exactly as listed in `<available_queues>` (agent_choice targeting only; ignored otherwise).",
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
        "Leave an internal note for the human team (NOT visible to the customer), for a conversation that is NOT being escalated right now — a special request, a caveat, something to follow up on later. If you ARE handing off to a human right now, do NOT use this tool: call handoff_to_human instead and pass your summary as its `reason` argument, which posts that same summary as a note automatically in the same call that actually transfers.",
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

// ── get_contact_info (read-only — the counterpart to set_custom_attribute/assign_label's writes,
// which had no way to be read back before this) ────────────────────────────

function getContactInfoTool(ctx: ZproToolCtx) {
  return tool(
    async () => {
      const lines: string[] = [];
      lines.push(`Queue: ${ctx.currentQueueName ?? "(none)"}`);
      const tags = ctx.contactTagNames ?? [];
      lines.push(`Tags: ${tags.length > 0 ? tags.join(", ") : "(none)"}`);
      const memory = ctx.contactExtraInfo ?? [];
      if (memory.length > 0) {
        lines.push("Saved memory:");
        for (const m of memory) lines.push(`- ${m.name}: ${m.value}`);
      } else {
        lines.push("Saved memory: (none)");
      }
      return lines.join("\n");
    },
    {
      name: "get_contact_info",
      description:
        "Look up what is already known about this contact/conversation: its current queue/department, its tags, and any saved memory (key/value attributes set earlier via set_custom_attribute or by a human). Use this BEFORE asking the customer for information that might already be on file, or when deciding whether a tag/attribute is already set.",
      schema: z.object({}),
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
      ? "Route this conversation to a department/queue. Pass the target queue's name as `queue`, picking one from `<available_queues>` below. This does NOT hand the conversation off to a human or stop you from replying — you keep answering normally after routing. To actually transfer to a human (e.g. the customer asks to talk to a person), use handoff_to_human instead, which can also route the queue for you in one step."
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
): Promise<{ stageId: number; stageName: string; opportunityId: number }> {
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
  return { stageId, stageName, opportunityId: id };
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
      let moved: { opportunityId: number };
      try {
        moved = await upsertOpportunity(ctx, k, k.pipelineId, {
          stageId: stage.id,
        });
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
      // Best-effort fleet event (ids only — no PII), mirrors graph/tools/native.ts's own emission.
      try {
        await runScopedOn(ctx.base, sysCtx(ctx.tenantId), (db) =>
          emitOutbound(db, ctx.tenantId, "kanban.card_moved", {
            card_id: String(moved.opportunityId),
            to_step: String(stage.id),
            conversation_id: String(ctx.conversationDbId),
          }),
        );
      } catch (err) {
        logger.warn(
          "zpro: outbound emit failed (event=kanban.card_moved): %s",
          err instanceof Error ? err.message : String(err),
        );
        ctx.onSideEffectError?.({
          tool: "kanban_move_card",
          phase: "outbound_emit",
          detail: { event: "kanban.card_moved" },
          err,
        });
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

// ── schedule_message (channel-agnostic — same capability + backing as native.ts's) ────────────────

function scheduleMessageTool(ctx: ZproToolCtx) {
  return tool(
    async ({
      instructions,
      delayMinutes,
    }: {
      instructions: string;
      delayMinutes: number;
    }) => {
      if (!ctx.base || !ctx.threadId) {
        return "Could not schedule the message (no conversation in scope).";
      }
      const delay = clampDelayMinutes(delayMinutes);
      try {
        const { runAt } = await scheduleMessage({
          tenantId: ctx.tenantId,
          threadId: ctx.threadId,
          instructions,
          delayMinutes: delay,
          base: ctx.base,
        });
        return `Scheduled: I will act on this at ${runAt.toISOString()} (in ${delay} minute(s)).`;
      } catch (e) {
        logger.warn(
          "zpro schedule_message failed (ticket=%s): %s",
          String(ctx.ticketId),
          e instanceof Error ? e.message : String(e),
        );
        ctx.onSideEffectError?.({
          tool: "schedule_message",
          phase: "enqueue",
          err: e,
        });
        return toolFailure("Could not schedule the message.");
      }
    },
    {
      name: "schedule_message",
      description:
        "Schedule a one-off message or action to happen later in THIS conversation (e.g. 'remind me in 10 minutes', 'send me a motivational quote in an hour'). `instructions` is a brief for your FUTURE self describing what to do/say when it fires — write it as an instruction, not as the final customer-facing text. Only usable for delays up to 24h. Do NOT promise a delayed send in your reply without calling this tool — an unfulfilled promise is worse than declining.",
      schema: z.object({
        instructions: z
          .string()
          .min(1)
          .describe(
            'Brief for what to do when the timer fires, e.g. "Send a short motivational message and a thumbs-up emoji."',
          ),
        delayMinutes: z
          .number()
          .positive()
          .describe("Minutes from now to wait before acting (max 1440 = 24h)."),
      }),
    },
  );
}

// ── send_image (upstream #76 parity — see the module header for why this is simpler than
// src/graph/tools/native.ts's version: sendMediaUrl needs no download/re-upload/queue) ────

function sendImageRefusal(hostname: string | null, hosts: string[]): string {
  if (hosts.length === 0) {
    return "Não posso enviar imagens: nenhum host foi liberado para esta configuração. Responda com o link em texto.";
  }
  if (hostname === null) {
    return "Essa URL não é válida para envio de imagem. Confira o endereço ou responda com o link em texto.";
  }
  // NOTE: The rejected host is deliberately NOT echoed — same reasoning as
  // src/graph/tools/native.ts's sendImageRefusal (this string is the tool's OUTPUT, stored
  // verbatim in ExecutionLog.detail by ToolFlowLogger; the model already knows which URL it asked
  // for, and the hosts it MAY use are in the tool's own description).
  return "Esse host não está na lista de hosts liberados, então a imagem não foi enviada. Responda com o link em texto.";
}

function sendImageTool(ctx: ZproToolCtx) {
  const cfg = ctx.sendImage ?? SEND_IMAGE_DEFAULTS;
  const hosts = cfg.allowedHosts;
  const baseDescription =
    "Send an IMAGE to the customer as an attachment, given its URL. Use it whenever you have the URL of a picture the customer would rather see than read about (a product photo, a plan, a receipt). The URL must come from data you actually received — another tool's result, the knowledge base, the conversation — never one you compose or guess. Optionally include a short caption. Only the hosts listed below can be reached; anything else is refused, so if the image you have is elsewhere, describe it or send the page link as text instead.";
  const hostsXml = `<imagens-permitidas>${
    hosts.length
      ? hosts.map((h) => `\n  <host>${xmlEscape(h)}</host>`).join("")
      : "\n  <nenhum>Nenhum host liberado: a ferramenta vai recusar qualquer URL até o operador configurar a lista.</nenhum>"
  }\n</imagens-permitidas>`;
  const description = withOperatorNote(
    baseDescription,
    ctx,
    "send_image",
    hostsXml,
  );
  return tool(
    async ({ url, caption }: { url: string; caption?: string }) => {
      let hostname: string | null;
      try {
        hostname = new URL(url).hostname;
      } catch {
        hostname = null;
      }
      if (!hostname || !isAllowedImageHost(hostname, hosts)) {
        return sendImageRefusal(hostname, hosts);
      }
      // Direct send (no turn-end queue — see the module header): mark BEFORE sending, same as
      // handoff_to_human's customerMessage, so the webhook echo of this fromMe message classifies
      // as AGENT instead of a false HUMAN takeover.
      if (ctx.zproInstanceId != null) {
        await markAgentSending(
          ctx.tenantId,
          ctx.zproInstanceId,
          ctx.ticketId,
          ctx.base,
        );
      }
      try {
        await ctx.client.sendMediaUrl(
          ctx.contactNumber,
          url,
          caption?.trim() || undefined,
        );
      } catch (e) {
        logger.warn(
          "zpro send_image failed (ticket=%s): %s",
          String(ctx.ticketId),
          e instanceof Error ? e.message : String(e),
        );
        ctx.onSideEffectError?.({ tool: "send_image", phase: "send", err: e });
        return toolFailure(
          "Não consegui enviar a imagem agora. Responda com o link em texto.",
        );
      }
      return "Imagem enviada ao cliente.";
    },
    {
      name: "send_image",
      description,
      schema: z.object({
        url: z
          .string()
          .min(1)
          .describe(
            "Direct https URL of the image file itself (not the page that shows it). Its host must be one of the allowed ones.",
          ),
        caption: z
          .string()
          .max(SEND_IMAGE_MAX_CAPTION_CHARS)
          .optional()
          .describe(
            "Optional short text delivered with the image, in the customer's language.",
          ),
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

// allowed = undefined → all 11 tools; otherwise only the named subset (fail-closed, mirrors
// src/graph/tools/native.ts's buildNativeTools). react_to_message is never built (see module header).
export function buildZproNativeTools(
  ctx: ZproToolCtx,
  allowed?: Iterable<string>,
): StructuredToolInterface[] {
  const all: StructuredToolInterface[] = [
    handoffTool(ctx),
    privateNoteTool(ctx),
    setCustomAttributeTool(ctx),
    getContactInfoTool(ctx),
    assignLabelTool(ctx),
    resolveConversationTool(ctx),
    kanbanMoveTool(ctx),
    updateKanbanTaskTool(ctx),
    routeToQueueTool(ctx),
    scheduleMessageTool(ctx),
    sendImageTool(ctx),
    skipReplyTool(ctx),
  ];
  if (!allowed) return all;
  const allow = new Set(allowed);
  return all.filter((t) => allow.has(t.name));
}

// Playground variant: every Z-PRO conversation tool the agent could ever be granted is SIMULATED
// (no real ZproClient call, no ZproConversation write) — mirrors src/graph/tools/native.ts's
// buildSimulatedNativeTools, reusing its channel-agnostic simulatedTool() wrapper. Covers the 11
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
