// src/modules/scheduled-messages/service.ts
// Generic "say/do something at time X" timer, usable from EITHER channel via the schedule_message
// native tool (src/graph/tools/native.ts's Chatwoot build + src/modules/zpro/native-tools.ts's
// Z-PRO build). Unlike appointment reminders (src/modules/appointments/reminders.ts, anchored to a
// real Google Calendar event) or follow-up (inactivity-triggered), this is a bare scheduler job
// carrying free-form model instructions — the model promised to do something later with no other
// system backing that commitment. Exists because that promise used to be pure hallucination: the
// model would confirm a delayed send in prose without any tool call behind it (no SchedulerJob ever
// created). Reuses the SAME scheduler + nudge infrastructure as reminders/follow-up
// (runAgentNudge/runZproAgentNudge) so delivery gets guardrails, tools, split/TTS and the 24h service
// window for free — nothing new to get wrong on the delivery side, only the "arm a timer" part.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import { type AgentNudge, parseThreadId, runAgentNudge } from "@/graph/nudge";
import type { RuntimeDeps } from "@/graph/runtime";
import { clipText } from "@/lib/text";
import { type ClaimedJob, enqueueJob } from "@/modules/scheduler/service";
import { type JobResult, registerJobHandler } from "@/modules/scheduler/worker";
import { runZproAgentNudge } from "@/modules/zpro/nudge";

const MIN_DELAY_MINUTES = 1;
// 24h cap: a bare timer with no anchor (unlike a Calendar event) has no natural upper bound, so an
// absurd commitment ("remind me next year") is clamped instead of silently accepted.
const MAX_DELAY_MINUTES = 24 * 60;
const MAX_INSTRUCTIONS_LEN = 2000;

// Pure. Rounds to the nearest whole minute and clamps to [1, 1440]; NaN/Infinity fall back to the
// minimum rather than producing an invalid runAt.
export function clampDelayMinutes(minutes: number): number {
  if (!Number.isFinite(minutes)) return MIN_DELAY_MINUTES;
  return Math.min(
    Math.max(Math.round(minutes), MIN_DELAY_MINUTES),
    MAX_DELAY_MINUTES,
  );
}

export interface ScheduleMessageArgs {
  tenantId: bigint;
  threadId: string;
  instructions: string;
  delayMinutes: number;
  base?: PrismaClient;
  now?: Date;
}

// Enqueues one SCHEDULED_MESSAGE job. Unlike FOLLOWUP's stable per-thread dedupeKey (one row,
// re-armed), the key here is unique PER CALL: the customer may ask for several independent scheduled
// messages in the same conversation, and a later request must never clobber an earlier one still
// pending. `enqueue` is injectable for hermetic tests.
export async function scheduleMessage(
  args: ScheduleMessageArgs,
  enqueue: typeof enqueueJob = enqueueJob,
): Promise<{ id: bigint; runAt: Date }> {
  const now = args.now ?? new Date();
  const delayMinutes = clampDelayMinutes(args.delayMinutes);
  const runAt = new Date(now.getTime() + delayMinutes * 60_000);
  const id = await enqueue({
    tenantId: args.tenantId,
    kind: "SCHEDULED_MESSAGE",
    dedupeKey: `scheduled-message:${args.threadId}:${crypto.randomUUID()}`,
    runAt,
    // Always a fresh unit of work: the dedupeKey is unique per call (see the comment above), so this
    // never actually re-arms an existing row — but the caller still has to answer the question.
    rearm: "new-work",
    payload: {
      threadId: args.threadId,
      instructions: clipText(args.instructions.trim(), MAX_INSTRUCTIONS_LEN),
    },
    base: args.base,
  });
  return { id, runAt };
}

export async function scheduledMessageHandler(
  job: ClaimedJob,
  base: PrismaClient,
  deps?: RuntimeDeps,
): Promise<JobResult> {
  const p = job.payload;
  const threadId = typeof p.threadId === "string" ? p.threadId : null;
  const instructions = typeof p.instructions === "string" ? p.instructions : "";
  if (!threadId || !instructions) return { outcome: "done" };
  const tenantId = job.tenantId;
  // Dispatch by threadId shape, same pattern as appointmentReminderHandler/followUpHandler: a Z-PRO
  // thread (`zpro:<tenantId>:<zproInstanceId>:<ticketId>`) never matches Chatwoot's parseThreadId
  // (3-segment, no "zpro" prefix).
  const isZpro = threadId.startsWith("zpro:");
  if (!isZpro) {
    const parsed = parseThreadId(threadId);
    if (!parsed || parsed.tenantId !== tenantId) return { outcome: "done" };
  }
  const nudge: AgentNudge = {
    source: "scheduled_message",
    kind: "reminder",
    summary: "The customer asked for this at a specific time; deliver it now.",
    instructions,
  };
  if (isZpro) {
    await runZproAgentNudge({ tenantId, threadId, nudge, base });
  } else {
    await runAgentNudge({ tenantId, threadId, nudge, base, deps });
  }
  return { outcome: "done" };
}

let registered = false;
export function registerScheduledMessageHandler(): void {
  if (registered) return;
  registerJobHandler("SCHEDULED_MESSAGE", (job, base) =>
    scheduledMessageHandler(job, base),
  );
  registered = true;
  logger.debug("scheduled-message handler registered");
}
