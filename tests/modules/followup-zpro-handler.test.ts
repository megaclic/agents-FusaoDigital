// tests/modules/followup-zpro-handler.test.ts
// Z-PRO analog of followup-handler.test.ts, scoped to the pre-nudge GATES (episode/cadence/business-
// hours/appointment/in-flight/bot-ownership/redirect-exclusion) — the sweep's SQL eligibility, and
// followUpHandler's Z-PRO branch (zproFollowUpStep) up to (but never past) the runZproAgentNudge
// call. Mirrors nudge.test.ts's own philosophy: "no zpro runtime test in this codebase invokes the
// live LLM graph" — runZproAgentNudge → runLoadedZproTurn calls createChatModel directly (no
// injectable deps), so every case here returns BEFORE that call is reached.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { type Prisma, PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { clearTurnInFlight, markTurnInFlight } from "@/graph/inflight";
import {
  followUpHandler,
  registerFollowUpHandlers,
} from "@/modules/followups/handlers";
import type { ClaimedJob } from "@/modules/scheduler/service";
import { getJobHandler } from "@/modules/scheduler/worker";

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;
let zproInstanceId = 0n;
let agentId = 0n;

function threadOf(ticketId: number) {
  return `zpro:${tenantId}:${zproInstanceId}:${ticketId}`;
}

function jobFor(ticketId: number, stepIndex?: number): ClaimedJob {
  return {
    id: 1n,
    tenantId,
    kind: "FOLLOWUP",
    payload:
      stepIndex === undefined
        ? { threadId: threadOf(ticketId) }
        : { threadId: threadOf(ticketId), stepIndex },
    attempts: 0,
  };
}

async function setAgentSettings(settings: Prisma.InputJsonObject) {
  await suDb.agent.update({ where: { id: agentId }, data: { settings } });
}

async function seedTicket(
  ticketId: number,
  over: {
    lastMessageAt?: Date;
    lastInboundAt?: Date | null;
    lastFollowUpAt?: Date | null;
    status?: string;
    agentActive?: boolean;
  } = {},
) {
  const lastMessageAt = over.lastMessageAt ?? new Date(Date.now() - 2 * 60_000);
  await suDb.zproConversation.upsert({
    where: { zproInstanceId_ticketId: { zproInstanceId, ticketId } },
    create: {
      tenantId,
      zproInstanceId,
      ticketId,
      status: over.status ?? "open",
      contactId: ticketId,
      contactNumber: `55119${String(ticketId).padStart(8, "0")}`,
      contactName: "Cliente",
      agentActive: over.agentActive ?? true,
      lastMessageAt,
      lastInboundAt:
        over.lastInboundAt !== undefined
          ? over.lastInboundAt
          : new Date(Date.now() - 3 * 60_000),
      lastFollowUpAt:
        over.lastFollowUpAt !== undefined ? over.lastFollowUpAt : null,
    },
    update: {
      status: over.status ?? "open",
      agentActive: over.agentActive ?? true,
      lastMessageAt,
      lastInboundAt:
        over.lastInboundAt !== undefined
          ? over.lastInboundAt
          : new Date(Date.now() - 3 * 60_000),
      lastFollowUpAt:
        over.lastFollowUpAt !== undefined ? over.lastFollowUpAt : null,
    },
  });
}

async function lastFollowUpOf(ticketId: number): Promise<Date | null> {
  const row = await suDb.zproConversation.findFirstOrThrow({
    where: { tenantId, zproInstanceId, ticketId },
    select: { lastFollowUpAt: true },
  });
  return row.lastFollowUpAt;
}

describe.skipIf(!dbUp)(
  "followUpHandler — Z-PRO branch (pre-nudge gates)",
  () => {
    beforeAll(async () => {
      const t = await suDb.tenant.create({
        data: { name: "FUZ", slug: `fuz-${process.pid}` },
      });
      tenantId = t.id;
      const inst = await suDb.zproInstance.create({
        data: {
          tenantId,
          baseUrl: "https://api.fusaobotcrm.com.br",
          apiId: "TEST_API_ID",
          bearerToken: encryptJson("test-token"),
          whatsappId: 771,
          instanceName: "FollowUpZproInstance",
        },
      });
      zproInstanceId = inst.id;
      const agent = await suDb.agent.create({
        data: {
          tenantId,
          name: "Atendente Z-PRO FollowUp",
          systemPrompt: "x",
          followUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
          modelConfig: { provider: "openai", model: "gpt-4o-mini" },
          settings: {
            followUp: {
              enabled: true,
              steps: [
                { delayValue: 1, delayUnit: "minutes", instructions: "" },
              ],
            },
          },
        },
      });
      agentId = agent.id;
      await suDb.zproAgentBinding.create({
        data: { tenantId, zproInstanceId, agentId },
      });
      registerFollowUpHandlers();
    });

    afterAll(async () => {
      if (tenantId) {
        for (const table of [
          "scheduler_jobs",
          "zpro_conversations",
          "zpro_agent_bindings",
          "agents",
          "zpro_instances",
        ]) {
          await suDb.$executeRawUnsafe(
            `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
          );
        }
        await suDb.$executeRawUnsafe(
          `DELETE FROM tenants WHERE id = ${tenantId}`,
        );
      }
      await suDb.$disconnect();
      await appDb.$disconnect();
    });

    test("(a) does NOT re-fire when lastFollowUpAt >= lastInboundAt (no fresh episode)", async () => {
      const now = new Date();
      const inboundBefore = new Date(now.getTime() - 10 * 60_000);
      const followedUp = new Date(now.getTime() - 5 * 60_000);
      await seedTicket(2001, {
        lastInboundAt: inboundBefore,
        lastFollowUpAt: followedUp,
      });
      const result = await followUpHandler(jobFor(2001), appDb);
      expect(result).toEqual({ outcome: "done" });
      const wm = await lastFollowUpOf(2001);
      expect(wm?.getTime()).toBe(followedUp.getTime());
    });

    test("(b) step 0 is skipped when the episode began BEFORE follow-up was armed for the agent", async () => {
      await suDb.agent.update({
        where: { id: agentId },
        data: { followUpArmedAt: new Date() }, // armed just now
      });
      try {
        await seedTicket(2002, {
          lastInboundAt: new Date(Date.now() - 20 * 60_000), // before the (re)arm
          lastFollowUpAt: null,
        });
        const result = await followUpHandler(jobFor(2002), appDb);
        expect(result).toEqual({ outcome: "done" });
        expect(await lastFollowUpOf(2002)).toBeNull();
      } finally {
        await suDb.agent.update({
          where: { id: agentId },
          data: { followUpArmedAt: new Date(Date.now() - 30 * 86_400_000) },
        });
      }
    });

    test("(c) a later step is dropped when the client spoke since the last step (episode ended)", async () => {
      await setAgentSettings({
        followUp: {
          enabled: true,
          steps: [
            { delayValue: 1, delayUnit: "minutes", instructions: "" },
            { delayValue: 1, delayUnit: "days", instructions: "" },
          ],
        },
      });
      const now = Date.now();
      await seedTicket(2003, {
        lastFollowUpAt: new Date(now - 5 * 60_000),
        lastInboundAt: new Date(now - 2 * 60_000), // spoke AFTER the last follow-up
      });
      const result = await followUpHandler(jobFor(2003, 1), appDb);
      expect(result).toEqual({ outcome: "done" });
    });

    test("(d) cadence not yet due → reschedules precisely instead of nudging early", async () => {
      await setAgentSettings({
        followUp: {
          enabled: true,
          steps: [{ delayValue: 30, delayUnit: "minutes", instructions: "" }],
        },
      });
      await seedTicket(2004, {
        lastMessageAt: new Date(Date.now() - 5 * 60_000), // only 5 of 30 minutes elapsed
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      const result = await followUpHandler(jobFor(2004), appDb);
      expect(result.outcome).toBe("reschedule");
      expect(await lastFollowUpOf(2004)).toBeNull();
    });

    test("(e) bot-ownership gate: a human-owned ticket (agentActive=false) is never nudged", async () => {
      await setAgentSettings({
        followUp: {
          enabled: true,
          steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
        },
      });
      await seedTicket(2005, {
        agentActive: false,
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      const result = await followUpHandler(jobFor(2005), appDb);
      expect(result).toEqual({ outcome: "done" });
      expect(await lastFollowUpOf(2005)).toBeNull();
    });

    test("(f) bot-ownership gate: a closed ticket is never nudged", async () => {
      await seedTicket(2006, {
        status: "closed",
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      const result = await followUpHandler(jobFor(2006), appDb);
      expect(result).toEqual({ outcome: "done" });
      expect(await lastFollowUpOf(2006)).toBeNull();
    });

    test("(g) backs off (reschedules) instead of nudging while a turn is in flight", async () => {
      await seedTicket(2007, {
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      markTurnInFlight(threadOf(2007));
      try {
        const result = await followUpHandler(jobFor(2007), appDb);
        expect(result.outcome).toBe("reschedule");
        expect(await lastFollowUpOf(2007)).toBeNull();
      } finally {
        clearTurnInFlight(threadOf(2007));
      }
    });

    test("(h) follow-up is paused while a pending appointment reminder exists for this ticket", async () => {
      await seedTicket(2008, {
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      await suDb.schedulerJob.create({
        data: {
          tenantId,
          kind: "APPOINTMENT_REMINDER",
          dedupeKey: "reminder:ev_zh:1",
          status: "PENDING",
          runAt: new Date(Date.now() + 60 * 60_000),
          payload: { threadId: threadOf(2008), eventId: "ev_zh" },
        },
      });
      const result = await followUpHandler(jobFor(2008), appDb);
      expect(result.outcome).toBe("reschedule");
      expect(await lastFollowUpOf(2008)).toBeNull();
    });

    test("(i) a Z-PRO ticket managed by a channelRedirect entry (defense in depth) is skipped", async () => {
      await setAgentSettings({
        followUp: {
          enabled: true,
          steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
        },
        channelRedirect: {
          enabled: true,
          entryZproInstanceId: Number(zproInstanceId),
        },
      });
      try {
        await seedTicket(2009, {
          lastInboundAt: new Date(Date.now() - 5 * 60_000),
          lastFollowUpAt: null,
        });
        const result = await followUpHandler(jobFor(2009), appDb);
        expect(result).toEqual({ outcome: "done" });
        expect(await lastFollowUpOf(2009)).toBeNull();
      } finally {
        await setAgentSettings({
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
          },
        });
      }
    });

    test("(j) an agent with follow-up disabled never enqueues a step (no-op, done)", async () => {
      await setAgentSettings({ followUp: { enabled: false, steps: [] } });
      try {
        await seedTicket(2010, {
          lastInboundAt: new Date(Date.now() - 5 * 60_000),
          lastFollowUpAt: null,
        });
        const result = await followUpHandler(jobFor(2010), appDb);
        expect(result).toEqual({ outcome: "done" });
      } finally {
        await setAgentSettings({
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
          },
        });
      }
    });
  },
);

describe.skipIf(!dbUp)("FOLLOWUP_SWEEP — Z-PRO eligibility", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: { name: "FUZS", slug: `fuzs-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_SWEEP",
        bearerToken: encryptJson("test-token"),
        whatsappId: 772,
        instanceName: "FollowUpZproSweepInstance",
      },
    });
    zproInstanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente Z-PRO Sweep",
        systemPrompt: "x",
        followUpArmedAt: new Date(Date.now() - 30 * 86_400_000),
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: {
          followUp: {
            enabled: true,
            steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
          },
        },
      },
    });
    agentId = agent.id;
    await suDb.zproAgentBinding.create({
      data: { tenantId, zproInstanceId, agentId },
    });
    registerFollowUpHandlers();
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "scheduler_jobs",
        "zpro_conversations",
        "zpro_agent_bindings",
        "agents",
        "zpro_instances",
      ]) {
        await suDb.$executeRawUnsafe(
          `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
        );
      }
      await suDb.$executeRawUnsafe(
        `DELETE FROM tenants WHERE id = ${tenantId}`,
      );
    }
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  async function runSweep() {
    const sweep = getJobHandler("FOLLOWUP_SWEEP");
    expect(sweep).toBeDefined();
    await sweep?.(
      { id: 1n, tenantId, kind: "FOLLOWUP_SWEEP", payload: {}, attempts: 0 },
      appDb,
    );
  }

  async function hasEnqueued(ticketId: number): Promise<boolean> {
    const row = await suDb.schedulerJob.findFirst({
      where: {
        tenantId,
        kind: "FOLLOWUP",
        dedupeKey: `followup:${threadOf(ticketId)}`,
      },
    });
    return row !== null;
  }

  test("enqueues a bot-owned, inactive Z-PRO ticket", async () => {
    await seedTicket(3001, {
      lastMessageAt: new Date(Date.now() - 5 * 60_000),
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await runSweep();
    expect(await hasEnqueued(3001)).toBe(true);
  });

  test("skips a human-owned ticket (agentActive=false)", async () => {
    await seedTicket(3002, {
      agentActive: false,
      lastMessageAt: new Date(Date.now() - 5 * 60_000),
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await runSweep();
    expect(await hasEnqueued(3002)).toBe(false);
  });

  test("skips a closed ticket", async () => {
    await seedTicket(3003, {
      status: "closed",
      lastMessageAt: new Date(Date.now() - 5 * 60_000),
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await runSweep();
    expect(await hasEnqueued(3003)).toBe(false);
  });

  test("skips a ticket managed by a channelRedirect entering through this instance", async () => {
    await setAgentSettings({
      followUp: {
        enabled: true,
        steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
      },
      channelRedirect: {
        enabled: true,
        entryZproInstanceId: Number(zproInstanceId),
      },
    });
    try {
      await seedTicket(3004, {
        lastMessageAt: new Date(Date.now() - 5 * 60_000),
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      await runSweep();
      expect(await hasEnqueued(3004)).toBe(false);
    } finally {
      await setAgentSettings({
        followUp: {
          enabled: true,
          steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
        },
      });
    }
  });

  test("skips a ticket with a live (pending) appointment reminder", async () => {
    await seedTicket(3005, {
      lastMessageAt: new Date(Date.now() - 5 * 60_000),
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_sw:1",
        status: "PENDING",
        runAt: new Date(Date.now() + 60 * 60_000),
        payload: { threadId: threadOf(3005), eventId: "ev_sw" },
      },
    });
    await runSweep();
    expect(await hasEnqueued(3005)).toBe(false);
  });

  test("resumes once the appointment reminder has passed (DONE, past start)", async () => {
    await seedTicket(3006, {
      lastMessageAt: new Date(Date.now() - 5 * 60_000),
      lastInboundAt: new Date(Date.now() - 5 * 60_000),
      lastFollowUpAt: null,
    });
    await suDb.schedulerJob.create({
      data: {
        tenantId,
        kind: "APPOINTMENT_REMINDER",
        dedupeKey: "reminder:ev_sw2:1",
        status: "DONE",
        runAt: new Date(Date.now() - 3 * 3_600_000),
        payload: {
          threadId: threadOf(3006),
          eventId: "ev_sw2",
          startISO: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        },
      },
    });
    await runSweep();
    expect(await hasEnqueued(3006)).toBe(true);
  });

  test("skips a ticket that hasn't reached the agent's configured delay yet", async () => {
    await setAgentSettings({
      followUp: {
        enabled: true,
        steps: [{ delayValue: 30, delayUnit: "minutes", instructions: "" }],
      },
    });
    try {
      await seedTicket(3007, {
        lastMessageAt: new Date(Date.now() - 5 * 60_000),
        lastInboundAt: new Date(Date.now() - 5 * 60_000),
        lastFollowUpAt: null,
      });
      await runSweep();
      expect(await hasEnqueued(3007)).toBe(false);
    } finally {
      await setAgentSettings({
        followUp: {
          enabled: true,
          steps: [{ delayValue: 1, delayUnit: "minutes", instructions: "" }],
        },
      });
    }
  });
});
