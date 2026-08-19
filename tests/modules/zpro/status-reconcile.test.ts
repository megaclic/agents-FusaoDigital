// tests/modules/zpro/status-reconcile.test.ts
// Pure/injectable-enqueue tests only, mirroring tests/modules/scheduled-messages.test.ts's coverage
// of scheduleMessage. zproStatusCheckHandler is intentionally NOT invoked here — it makes a real
// ZproClient.showTicketById call, and no zpro runtime test in this codebase hits the live API (see
// tests/modules/zpro/nudge.test.ts's own note on the same boundary).

import { describe, expect, test } from "bun:test";
import type { enqueueJob } from "@/modules/scheduler/service";
import { scheduleZproStatusCheck } from "@/modules/zpro/status-reconcile";

function fakeEnqueue() {
  const calls: Array<Parameters<typeof enqueueJob>[0]> = [];
  const fn = (async (p: Parameters<typeof enqueueJob>[0]) => {
    calls.push(p);
    return 1n;
  }) as typeof enqueueJob;
  return { fn, calls };
}

describe("scheduleZproStatusCheck", () => {
  test("enqueues a ZPRO_STATUS_CHECK job with runAt = now + 3 minutes", async () => {
    const { fn, calls } = fakeEnqueue();
    await scheduleZproStatusCheck(
      {
        tenantId: 1n,
        zproInstanceId: 2n,
        ticketId: 6826,
        now: new Date("2026-06-24T00:00:00-03:00"),
      },
      fn,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe("ZPRO_STATUS_CHECK");
    expect(calls[0]?.runAt.toISOString()).toBe(
      new Date("2026-06-24T00:03:00-03:00").toISOString(),
    );
    expect(calls[0]?.payload).toMatchObject({
      zproInstanceId: "2",
      ticketId: 6826,
    });
  });

  test("dedupeKey is stable per (instance, ticket) — a re-arm reuses the same row instead of stacking", async () => {
    const { fn, calls } = fakeEnqueue();
    await scheduleZproStatusCheck(
      { tenantId: 1n, zproInstanceId: 2n, ticketId: 6826 },
      fn,
    );
    await scheduleZproStatusCheck(
      { tenantId: 1n, zproInstanceId: 2n, ticketId: 6826 },
      fn,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]?.dedupeKey).toBe(calls[1]?.dedupeKey);
    expect(calls[0]?.dedupeKey).toBe("zpro-status-check:2:6826");
  });

  test("different tickets get different dedupeKeys", async () => {
    const { fn, calls } = fakeEnqueue();
    await scheduleZproStatusCheck(
      { tenantId: 1n, zproInstanceId: 2n, ticketId: 6826 },
      fn,
    );
    await scheduleZproStatusCheck(
      { tenantId: 1n, zproInstanceId: 2n, ticketId: 6827 },
      fn,
    );
    expect(calls[0]?.dedupeKey).not.toBe(calls[1]?.dedupeKey);
  });
});
