// tests/modules/zpro/debounce.test.ts
// parseZproThreadId (pure) + resolveZproDebounceConfig (DB-backed, mirrors resolveZproSttConfig's
// test) + flushZproDebounceJob's GATE/DATA logic: no-conversation, agent-inactive gate (advances
// the watermark from the payload's lastMessageId, mirrors Chatwoot's issue #8 fix), no-pending-burst,
// and an all-empty-body burst. Deliberately does NOT exercise the happy path that reaches
// runLoadedZproTurn (posts a real reply) — that function calls createChatModel directly (no
// injectable deps, unlike Chatwoot's runLoadedTurn), and no zpro runtime test in this codebase
// invokes the live LLM graph; the watermark/supersede/gate mechanics tested here are the actual
// correctness-critical surface (duplicate-reply prevention), independent of what the model says.

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import type { ClaimedJob } from "@/modules/scheduler/service";
import {
  flushZproDebounceJob,
  parseZproThreadId,
  resolveZproDebounceConfig,
} from "@/modules/zpro/debounce";
import { burnSchedulerJobId } from "../../utils/scheduler";

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

describe("parseZproThreadId", () => {
  test("parses the zpro:<tenantId>:<instanceId>:<ticketId> shape", () => {
    expect(parseZproThreadId("zpro:1:2:3")).toEqual({
      tenantId: 1n,
      zproInstanceId: 2n,
      ticketId: 3,
    });
  });
  test("rejects a Chatwoot-shaped threadId (3 parts, no zpro prefix)", () => {
    expect(parseZproThreadId("1:2:3")).toBeNull();
  });
  test("rejects garbage", () => {
    expect(parseZproThreadId("not-a-thread-id")).toBeNull();
    expect(parseZproThreadId("zpro:abc:2:3")).toBeNull();
    expect(parseZproThreadId("zpro:1:2:not-a-number")).toBeNull();
  });
});

let tenantId = 0n;
let zproInstanceId = 0n;
let agentId = 0n;
let phantomJobId = 0n;

describe.skipIf(!dbUp)("zpro debounce (DB-backed)", () => {
  beforeAll(async () => {
    phantomJobId = await burnSchedulerJobId(suDb);
    const t = await suDb.tenant.create({
      data: { name: "ZproDebounce", slug: `zpro-debounce-${process.pid}` },
    });
    tenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 93,
        instanceName: "ZproDebounceInstance",
      },
    });
    zproInstanceId = inst.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente Z-PRO",
        systemPrompt: "x",
        modelConfig: { provider: "openai", model: "gpt-4o-mini" },
        settings: { debounce: { enabled: true, windowSeconds: 15 } },
      },
    });
    agentId = agent.id;
    await suDb.zproAgentBinding.create({
      data: { tenantId, zproInstanceId, agentId },
    });
  });

  afterAll(async () => {
    if (tenantId) {
      for (const table of [
        "zpro_messages",
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

  test("resolveZproDebounceConfig returns the bound agent's enabled config", async () => {
    const cfg = await resolveZproDebounceConfig(
      tenantId,
      zproInstanceId,
      appDb,
    );
    expect(cfg?.enabled).toBe(true);
    expect(cfg?.windowSeconds).toBe(15);
  });

  test("resolveZproDebounceConfig returns null for an unbound instance", async () => {
    expect(
      await resolveZproDebounceConfig(tenantId, 9_999_999n, appDb),
    ).toBeNull();
  });

  function job(
    threadId: string,
    payload: Record<string, unknown> = {},
  ): ClaimedJob {
    return {
      id: phantomJobId,
      tenantId,
      kind: "DEBOUNCE",
      payload: { threadId, ...payload },
      attempts: 0,
      claimSeq: 1,
    };
  }

  test("no matching ZproConversation → done, no crash", async () => {
    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:777777`),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });
  });

  test("agent-inactive gate: advances the watermark from the payload's lastMessageId, no crash", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2001,
        status: "pending",
        contactId: 1,
        contactNumber: "5511900000001",
        contactName: "Cliente Gate",
        agentActive: false, // human owns it
      },
    });
    const msg = await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-gate-1",
        senderType: "CLIENT",
        body: "oi",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:2001`, {
        lastMessageId: Number(msg.id),
      }),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    const updated = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastHandledMessageId: true },
    });
    expect(updated.lastHandledMessageId).toBe(msg.id);
  });

  test("no pending burst (watermark already covers every CLIENT message) → done, watermark unchanged", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2002,
        status: "open",
        contactId: 2,
        contactNumber: "5511900000002",
        contactName: "Cliente Sem Burst",
        agentActive: true,
      },
    });
    const msg = await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-nb-1",
        senderType: "CLIENT",
        body: "oi",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });
    await suDb.zproConversation.update({
      where: { id: conv.id },
      data: { lastHandledMessageId: msg.id },
    });

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:2002`),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    const updated = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastHandledMessageId: true },
    });
    expect(updated.lastHandledMessageId).toBe(msg.id);
  });

  test("no agent bound → done, no crash", async () => {
    const otherInst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID_2",
        bearerToken: encryptJson("test-token"),
        whatsappId: 94,
        instanceName: "ZproDebounceInstanceUnbound",
      },
    });
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId: otherInst.id,
        ticketId: 2003,
        status: "open",
        contactId: 3,
        contactNumber: "5511900000003",
        contactName: "Cliente Sem Agente",
        agentActive: true,
      },
    });
    await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-na-1",
        senderType: "CLIENT",
        body: "oi",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${otherInst.id}:2003`),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_messages WHERE conversation_id = ${conv.id}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_conversations WHERE id = ${conv.id}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_instances WHERE id = ${otherInst.id}`,
    );
  });

  // withMediaFallback (parse.ts) now covers "uncaptioned media with no STT/vision extraction" —
  // it degrades to a marker (e.g. "<mensagem de áudio não audível...>"), not silence, so a burst
  // like that reaches runLoadedZproTurn for real instead of stopping here (see parse.test.ts's
  // withMediaFallback suite for the marker coverage; a live turn is outside this file's testing
  // boundary — no zpro runtime test invokes the live LLM graph). The one case that still has
  // truly nothing to answer is a "conversation" (plain text) message that arrived empty.
  test("a burst with only genuinely empty text (not media) advances the watermark without crashing", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 2004,
        status: "open",
        contactId: 4,
        contactNumber: "5511900000004",
        contactName: "Cliente Mídia Sem Texto",
        agentActive: true,
      },
    });
    const msg = await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-empty-1",
        senderType: "CLIENT",
        body: "", // an empty-text webhook artifact — withMediaFallback has no marker for this type
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:2004`),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    const updated = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastHandledMessageId: true },
    });
    expect(updated.lastHandledMessageId).toBe(msg.id);
  });

  // Spend ceiling (docs/spend-ceiling.md, issue #390/#491) — the flush's own gate, past the
  // empty-text short-circuit above so the two can never disagree about whether there is a burst to
  // refuse. ZproClient hits the network, so these two stub globalThis.fetch, mirroring the
  // established pattern in tests/modules/zpro/failure.test.ts.
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function monthStart(): Date {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  async function setCeiling(
    patch: Record<string, string | number | boolean | null>,
  ) {
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: { spendCeiling: patch } },
    });
  }

  async function spend(usd: number) {
    await suDb.spendCostSnapshot.upsert({
      where: {
        tenantId_source_monthStart: {
          tenantId,
          source: "inbox",
          monthStart: monthStart(),
        },
      },
      create: {
        tenantId,
        source: "inbox",
        monthStart: monthStart(),
        costUsd: usd,
        polledAt: new Date(),
      },
      update: { costUsd: usd, polledAt: new Date() },
    });
  }

  const OVER_COPY = "Estamos sem atendimento automático agora.";

  test("over the ceiling: drops the burst, sends the operator's sentence, hands off, notes why — and marks the agent-sending flag BEFORE the customer send", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 5001,
        status: "open",
        contactId: 20,
        contactNumber: "5511900000020",
        contactName: "Cliente Teto",
        agentActive: true,
      },
    });
    const msg = await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-ceiling-1",
        senderType: "CLIENT",
        body: "socorro, preciso de ajuda",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });
    await setCeiling({
      enabled: true,
      monthlyInboxUsd: 10,
      overCeilingMessage: OVER_COPY,
    });
    await spend(50);

    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    // The instant markAgentSending's write is observable from the SAME connection the flush uses —
    // if the send is captured before the write committed, this reads null (proving the ordering
    // this test exists to pin, rather than merely that the mark happened at some point).
    let agentSendingAtSendTime: Date | null | undefined;
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      const path = String(url);
      const body = init?.body
        ? (JSON.parse(String(init.body)) as Record<string, unknown>)
        : {};
      calls.push({ path, body });
      if (!path.endsWith("createNotes") && !path.endsWith("updateticketinfo")) {
        // suDb (superuser), not appDb: a bare read on the RLS-enforced runtime role with no tenant
        // GUC set would silently return zero rows here (docs/tenancy.md) and always read null,
        // which would make this assertion pass on a build that got the ordering wrong.
        const row = await suDb.zproConversation.findUnique({
          where: { id: conv.id },
          select: { agentSendingUntil: true },
        });
        agentSendingAtSendTime = row?.agentSendingUntil ?? null;
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:5001`, {
        lastMessageId: Number(msg.id),
      }),
      base: appDb,
    });
    expect(result).toEqual({ outcome: "done" });

    // markAgentSending committed before the send reached the network — never null/undefined, and
    // in the future relative to when the call fired.
    expect(agentSendingAtSendTime).not.toBeNull();
    expect(agentSendingAtSendTime).not.toBeUndefined();
    expect((agentSendingAtSendTime as Date).getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );

    const sendCall = calls.find(
      (c) =>
        !c.path.endsWith("createNotes") && !c.path.endsWith("updateticketinfo"),
    );
    expect(sendCall?.body.body).toBe(OVER_COPY);

    const handoffCall = calls.find((c) => c.path.endsWith("updateticketinfo"));
    expect(handoffCall?.body.n8nStatus).toBe(false);
    // NOT {closeTicket: true} — this opens the ticket, it does not resolve it.
    expect(handoffCall?.body.status).toBeUndefined();

    const noteCall = calls.find((c) => c.path.endsWith("createNotes"));
    expect(String(noteCall?.body.notes)).toContain("50");
    expect(String(noteCall?.body.notes)).toContain("10");

    // The burst is handled either way: the watermark advances past what this flush saw.
    const updated = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastHandledMessageId: true },
    });
    expect(updated.lastHandledMessageId).toBe(msg.id);

    await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: {} },
    });
  });

  // Under the ceiling the gate still ASKS (the read is unconditional whenever the burst is
  // non-empty and the earlier attempt has not already answered it) — it simply has nothing to
  // refuse. Contact-auth's own network-free "error" outcome (no URL configured) is what stops the
  // flush here, cleanly, before it would otherwise reach a real turn (out of this file's testing
  // boundary — see the module header); it is not standing in for the ceiling, which already let
  // the burst through.
  test("under the ceiling: the gate reads the snapshot once and does not refuse", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 5003,
        status: "open",
        contactId: 22,
        contactNumber: "5511900000022",
        contactName: "Cliente Sob Teto",
        agentActive: true,
      },
    });
    await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-under-1",
        senderType: "CLIENT",
        body: "oi",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });
    // contactAuth enabled with no URL ⇒ an immediate, network-free "error" outcome (the same
    // fail-closed refusal contact-auth already takes on its own), used here only to stop the flush
    // cleanly BEFORE a real model invocation — out of this file's testing boundary — so the
    // assertion is not confounded by that unrelated gate.
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          debounce: { enabled: true, windowSeconds: 15 },
          contactAuth: { enabled: true },
        },
      },
    });
    await setCeiling({ enabled: true, monthlyInboxUsd: 1_000_000 });
    await spend(10);

    let snapshotReads = 0;
    const watchedDb = appDb.$extends({
      query: {
        spendCostSnapshot: {
          async findUnique({ args, query }) {
            snapshotReads += 1;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:5003`),
      base: watchedDb,
    });
    expect(result).toEqual({ outcome: "done" });
    // The read ran (the gate asked), and it did not refuse — contact-auth's own network-free
    // "error" outcome is what actually stopped this flush before a real turn.
    expect(snapshotReads).toBe(1);

    await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: {} },
    });
    await suDb.agent.update({
      where: { id: agentId },
      data: { settings: { debounce: { enabled: true, windowSeconds: 15 } } },
    });
  });

  // ALREADY ANSWERED ⇒ the ceiling READ is skipped entirely, not just the refusal (mirrors
  // src/modules/debounce/handler.ts's own `alreadyAnswered`): a retried attempt at this exact job
  // can have posted and advanced the watermark past the arm-time payload's own last id before
  // dying. Proven by watching the snapshot table rather than by letting the burst reach a real turn
  // (out of this file's testing boundary — see the module header): contact-auth (network-free, see
  // above) is what actually stops this flush, and the point of the test is that it does so WITHOUT
  // the ceiling ever having been read, even though the tenant is far over budget.
  test("already answered: the ceiling read is skipped when an earlier attempt's watermark already covers the arm-time payload", async () => {
    const conv = await suDb.zproConversation.create({
      data: {
        tenantId,
        zproInstanceId,
        ticketId: 5002,
        status: "open",
        contactId: 21,
        contactNumber: "5511900000021",
        contactName: "Cliente Retry",
        agentActive: true,
      },
    });
    const m1 = await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-retry-1",
        senderType: "CLIENT",
        body: "oi",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });
    // A newer message the earlier attempt did NOT answer, so the burst is non-empty — the empty-text
    // short-circuit must not be what stops this flush; the "already answered" skip has to be.
    await suDb.zproMessage.create({
      data: {
        tenantId,
        conversationId: conv.id,
        messageId: "m-retry-2",
        senderType: "CLIENT",
        body: "tudo bem?",
        messageType: "conversation",
        fromMe: false,
        timestamp: BigInt(Date.now()),
      },
    });
    // The earlier attempt's own watermark write: already at or past m1, the arm-time payload's own
    // last id.
    await suDb.zproConversation.update({
      where: { id: conv.id },
      data: { lastHandledMessageId: m1.id },
    });
    await suDb.agent.update({
      where: { id: agentId },
      data: {
        settings: {
          debounce: { enabled: true, windowSeconds: 15 },
          contactAuth: { enabled: true },
        },
      },
    });
    await setCeiling({ enabled: true, monthlyInboxUsd: 1 });
    await spend(999);

    let snapshotReads = 0;
    const watchedDb = appDb.$extends({
      query: {
        spendCostSnapshot: {
          async findUnique({ args, query }) {
            snapshotReads += 1;
            return query(args);
          },
        },
      },
    }) as unknown as PrismaClient;

    const result = await flushZproDebounceJob({
      job: job(`zpro:${tenantId}:${zproInstanceId}:5002`, {
        lastMessageId: Number(m1.id),
      }),
      base: watchedDb,
    });
    expect(result).toEqual({ outcome: "done" });
    // The snapshot table was never read — if it had been, the tenant is 999x over a $1 ceiling and
    // would have been refused, with its own network calls, before contact-auth ever ran.
    expect(snapshotReads).toBe(0);

    // Dropped via contact-auth's own arm-time watermark advance (m1) — not the burst's own target
    // (m2), which would be the watermark had the ceiling (or contact-auth) let the flush proceed to
    // select and answer the burst for real.
    const updated = await suDb.zproConversation.findUniqueOrThrow({
      where: { id: conv.id },
      select: { lastHandledMessageId: true },
    });
    expect(updated.lastHandledMessageId).toBe(m1.id);

    await suDb.spendCostSnapshot.deleteMany({ where: { tenantId } });
    await suDb.tenant.update({
      where: { id: tenantId },
      data: { settings: {} },
    });
    await suDb.agent.update({
      where: { id: agentId },
      data: { settings: { debounce: { enabled: true, windowSeconds: 15 } } },
    });
  });
});
