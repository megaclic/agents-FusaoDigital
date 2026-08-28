// src/modules/zpro/nudge.ts
// Z-PRO analog of src/graph/nudge.ts's runAgentNudge — proactive system-turn injection into an
// EXISTING ticket (today, only Google Calendar appointment reminders — src/modules/appointments/
// reminders.ts — trigger this; the rest of the nudge/follow-up/service-window subsystem stays
// Chatwoot-only, see docs/zpro.md's "Known, accepted gaps").
//
// Unlike Chatwoot's nudge (which builds its own minimal model/graph, bypassing guardrails/tools/
// split/TTS), this reuses runtime.ts's runLoadedZproTurn — the SAME shared turn tail the debounce
// flush already reuses for a synthetic (non-webhook) event, coalescing several ZproMessage rows into
// one `text` (see debounce.ts). A reminder is the same shape of problem (no real triggering
// ZproMessage, just a `text` to run a turn on) — reusing it also means the "ask for confirmation"
// reminder step gets real tool-calling (calendar_confirm_appointment) for free, which a hand-rolled
// minimal invoke path would not have.
//
// Trade-off accepted: the nudge text also passes through runLoadedZproTurn's INPUT guardrail (skipped
// entirely by Chatwoot's nudge). Harmless for the fixed nudge templates in practice — renderNudge's
// fenced-data wrapping already treats embedded fields (e.g. an event summary) as semi-trusted, so
// running the same screening Chatwoot's nudge does not is an extra safety margin, not a regression.
//
// No service-window/HSM equivalent exists for Z-PRO — every send is freeform (ZproClient.sendText via
// deliverZproReply, same as a normal reply); see docs/service-window.md and docs/zpro.md.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { type AgentNudge, renderNudge } from "@/graph/nudge";
import { runScopedOn } from "@/lib/tenancy";
import { contactAuthFlowEvent } from "@/modules/contact-auth/service";
import { emitFlowEvent } from "@/modules/flowlog/service";
import { authorizeZproContact } from "./contact-auth";
import { sysCtx } from "./ctx";
import { parseZproThreadId } from "./debounce";
import { parseContactExtraInfo } from "./parse";
import { loadZproAgent, runLoadedZproTurn } from "./runtime";
import type { NormalizedZproEvent } from "./types";

export type RunZproAgentNudgeOutcome =
  | "messaged"
  // The WhatsApp 24h window was closed on a WABA-official instance: delivered as an approved
  // template, or (no template configured) as an explained private note — see docs/service-window.md.
  | "templated"
  | "noted-window"
  | "silent"
  | "human-owned"
  | "no-conversation"
  | "no-agent";

export interface RunZproAgentNudgeParams {
  tenantId: bigint;
  // zpro:<tenantId>:<zproInstanceId>:<ticketId> (runtime.ts's zproThreadId). A Chatwoot-shaped
  // threadId (no "zpro" segment) never parses here — the caller (appointmentReminderHandler)
  // branches BEFORE calling this, same as debounceFlushHandler branches on threadId shape.
  threadId: string;
  nudge: AgentNudge;
  base?: PrismaClient;
}

export async function runZproAgentNudge(
  params: RunZproAgentNudgeParams,
): Promise<RunZproAgentNudgeOutcome> {
  const base = params.base ?? basePrisma;
  const parsed = parseZproThreadId(params.threadId);
  if (!parsed || parsed.tenantId !== params.tenantId) return "no-conversation";
  const { tenantId, zproInstanceId, ticketId } = parsed;

  const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproConversation.findUnique({
      where: { zproInstanceId_ticketId: { zproInstanceId, ticketId } },
      select: {
        id: true,
        agentActive: true,
        contactId: true,
        contactName: true,
        contactNumber: true,
        contactExtraInfo: true,
        lastInboundAt: true,
      },
    }),
  );
  if (!conv) return "no-conversation";
  // A human owns the conversation — never inject a proactive customer-facing message. Chatwoot's
  // nudge posts a private note in this case; Z-PRO stays simpler by design: skip the reminder
  // entirely (a human is already engaged, so an automated attendance reminder is redundant, not
  // missing) rather than posting a note there too.
  if (!conv.agentActive) return "human-owned";

  const loaded = await loadZproAgent(base, tenantId, zproInstanceId);
  if (!loaded) return "no-agent";

  // The contact-authorization gate applies to proactive sends too (docs/contact-auth.md): a
  // follow-up is a turn the agent starts, and a contact the reactive gate would refuse must not be
  // reached out to either. Denied/error/no-identity all end as "silent" — no note downgrade the way
  // the webhook path has one, since the nudge's own text was written FOR the customer, not for an
  // operator. Unlike Chatwoot's nudge, Z-PRO's has no deterministic "post actions" (labels/resolve)
  // to still apply on a refusal — there is nothing else this caller owes.
  if (loaded.contactAuthConfig.enabled) {
    const identifier =
      parseContactExtraInfo(conv.contactExtraInfo).identifier?.trim() || null;
    const auth = await authorizeZproContact({
      tenantId,
      agentId: loaded.agentId,
      contactNumber: conv.contactNumber,
      contactName: conv.contactName,
      identifier,
      ticketId,
      // A nudge has no live webhook payload to read a channel from — same degradation the
      // synthetic event below already accepts for {{canal}}.
      channelType: null,
      // A nudge is a turn the agent starts: there is no customer message to forward.
      messageText: null,
      // Its own asking: it carries no message text, so it must never join (or be joined by) the
      // flight of an incoming message that does.
      requestKey: "nudge",
      cfg: loaded.contactAuthConfig,
      base,
    });
    emitFlowEvent(
      {
        tenantId,
        turnId: crypto.randomUUID(),
        source: "inbox",
        agentId: loaded.agentId,
        threadId: params.threadId,
        base,
        fullDetail: loaded.fullDetail,
      },
      contactAuthFlowEvent(auth),
    );
    if (auth.outcome !== "allowed") {
      logger.info(
        "zpro nudge: contact not authorized (conv=%s outcome=%s), skipping",
        String(conv.id),
        auth.outcome,
      );
      return "silent";
    }
    // Allowed, and up to `timeoutMs` may have gone by inside somebody else's endpoint — re-check
    // ownership before proceeding: a human could have taken the ticket during the wait.
    const stillOurs = await runScopedOn(base, sysCtx(tenantId), (db) =>
      db.zproConversation.findUnique({
        where: { id: conv.id },
        select: { agentActive: true },
      }),
    );
    if (!stillOurs?.agentActive) {
      logger.info(
        "zpro nudge: a human took the ticket during the authorization call (conv=%s)",
        String(conv.id),
      );
      return "human-owned";
    }
  }

  const text = renderNudge(params.nudge, true);
  const event: NormalizedZproEvent = {
    messageId: `nudge-${crypto.randomUUID()}`,
    threadId: String(ticketId),
    tenantId: Number(tenantId),
    instanceId: Number(zproInstanceId),
    instanceName: "",
    channelType: "",
    apiId: loaded.instance.apiId,
    contactId: conv.contactId,
    contactNumber: conv.contactNumber,
    contactName: conv.contactName,
    extraInfo: [],
    messageType: "conversation",
    body: "",
    fromMe: false,
    timestamp: Date.now(),
    ticketStatus: "open",
    agentActive: true,
    hasHumanAssigned: false,
  };

  const outcome = await runLoadedZproTurn({
    loaded,
    tenantId,
    zproInstanceId,
    event,
    text,
    turnId: crypto.randomUUID(),
    userSentAudio: false,
    base,
    // Proactive: gates the reply through the WhatsApp 24h window (loaded.serviceWindowConfig +
    // instance.isOfficialWaba) instead of always sending free-form — see docs/service-window.md.
    proactive: { lastInboundAt: conv.lastInboundAt },
  });
  logger.info(
    "zpro nudge: outcome=%s ticket=%s source=%s",
    outcome,
    String(ticketId),
    params.nudge.source,
  );
  switch (outcome) {
    case "posted":
      return "messaged";
    case "posted-template":
      return "templated";
    case "posted-note-window":
      return "noted-window";
    case "taken-over":
      return "human-owned";
    default:
      return "silent";
  }
}
