// tests/modules/scheduled-messages.test.ts
// Pure/injectable-enqueue tests only, mirroring tests/modules/appointment-reminders.test.ts's
// enqueueAppointmentReminders coverage: clampDelayMinutes (pure) and scheduleMessage (injectable
// `enqueue`, no DB/network). scheduledMessageHandler is intentionally NOT invoked here — like
// appointmentReminderHandler, it has no dedicated handler test; exercising it would mean either
// hitting the real runAgentNudge/runZproAgentNudge (which build a live model+graph) or invoking the
// live LLM graph, both out of scope for this test boundary.

import { describe, expect, test } from "bun:test";
import {
  clampDelayMinutes,
  scheduleMessage,
} from "@/modules/scheduled-messages/service";
import type { enqueueJob } from "@/modules/scheduler/service";

describe("clampDelayMinutes", () => {
  test("rounds to the nearest whole minute", () => {
    expect(clampDelayMinutes(5.4)).toBe(5);
    expect(clampDelayMinutes(5.6)).toBe(6);
  });
  test("clamps below 1 up to the minimum", () => {
    expect(clampDelayMinutes(0)).toBe(1);
    expect(clampDelayMinutes(-10)).toBe(1);
  });
  test("clamps above 1440 (24h) down to the maximum", () => {
    expect(clampDelayMinutes(1441)).toBe(1440);
    expect(clampDelayMinutes(999_999)).toBe(1440);
  });
  test("NaN/Infinity fall back to the minimum instead of producing an invalid runAt", () => {
    expect(clampDelayMinutes(Number.NaN)).toBe(1);
    expect(clampDelayMinutes(Number.POSITIVE_INFINITY)).toBe(1);
  });
});

describe("scheduleMessage", () => {
  function fakeEnqueue() {
    const calls: Array<Parameters<typeof enqueueJob>[0]> = [];
    const fn = (async (p: Parameters<typeof enqueueJob>[0]) => {
      calls.push(p);
      return 1n;
    }) as typeof enqueueJob;
    return { fn, calls };
  }

  test("enqueues a SCHEDULED_MESSAGE job with runAt = now + delayMinutes", async () => {
    const { fn, calls } = fakeEnqueue();
    const { runAt } = await scheduleMessage(
      {
        tenantId: 1n,
        threadId: "1:2:3",
        instructions: "Send a motivational quote and a thumbs-up emoji.",
        delayMinutes: 5,
        now: new Date("2026-06-24T00:00:00-03:00"),
      },
      fn,
    );
    expect(runAt.toISOString()).toBe(
      new Date("2026-06-24T00:05:00-03:00").toISOString(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("SCHEDULED_MESSAGE");
    expect(calls[0]?.payload).toMatchObject({
      threadId: "1:2:3",
      instructions: "Send a motivational quote and a thumbs-up emoji.",
    });
  });

  test("delayMinutes is clamped before computing runAt", async () => {
    const { fn, calls } = fakeEnqueue();
    await scheduleMessage(
      {
        tenantId: 1n,
        threadId: "1:2:3",
        instructions: "x",
        delayMinutes: 999_999,
        now: new Date("2026-06-24T00:00:00-03:00"),
      },
      fn,
    );
    expect(calls[0]?.runAt.toISOString()).toBe(
      new Date("2026-06-25T00:00:00-03:00").toISOString(), // clamped to 1440min = 24h
    );
  });

  test("each call gets a distinct dedupeKey — a second request never clobbers a pending one", async () => {
    const { fn, calls } = fakeEnqueue();
    await scheduleMessage(
      { tenantId: 1n, threadId: "1:2:3", instructions: "a", delayMinutes: 5 },
      fn,
    );
    await scheduleMessage(
      { tenantId: 1n, threadId: "1:2:3", instructions: "b", delayMinutes: 10 },
      fn,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.dedupeKey).not.toBe(calls[1]?.dedupeKey);
    expect(calls[0]?.dedupeKey).toContain("1:2:3");
    expect(calls[1]?.dedupeKey).toContain("1:2:3");
  });

  test("instructions are trimmed and length-capped in the payload", async () => {
    const { fn, calls } = fakeEnqueue();
    await scheduleMessage(
      {
        tenantId: 1n,
        threadId: "1:2:3",
        instructions: `  ${"x".repeat(3000)}  `,
        delayMinutes: 5,
      },
      fn,
    );
    const payload = calls[0]?.payload as { instructions: string };
    expect(payload.instructions.length).toBe(2000);
    expect(payload.instructions.startsWith(" ")).toBe(false);
  });
});
