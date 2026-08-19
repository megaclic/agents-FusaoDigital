// tests/modules/zpro/split.test.ts
// deliverZproReply wires the fully generic split helpers (splitReply/typingDelayMs, already
// covered by tests/modules/split.test.ts) into the Z-PRO channel via ZproClient.sendText, in place
// of Chatwoot's client.sendMessage. Unlike Chatwoot's deliverReply, it does NOT toggle presence
// itself — the caller's startTypingHeartbeat (messages.ts) covers the whole turn including this
// delivery, see the module header in src/modules/zpro/split.ts. No network/DB: ZproClient is
// duck-typed and cast, same pattern as tests/modules/zpro/tts.test.ts.

import { describe, expect, test } from "bun:test";
import { SPLIT_DEFAULTS } from "@/modules/split/service";
import type { ZproClient } from "@/modules/zpro/client";
import { deliverZproReply } from "@/modules/zpro/split";
import type { NormalizedZproEvent } from "@/modules/zpro/types";

function event(): NormalizedZproEvent {
  return {
    messageId: "m1",
    threadId: "42",
    tenantId: 1,
    instanceId: 1,
    instanceName: "Instance",
    channelType: "waba",
    apiId: "TEST_API_ID",
    contactId: 1,
    contactNumber: "5511900000001",
    contactName: "Cliente Teste",
    extraInfo: [],
    messageType: "conversation",
    body: "oi",
    fromMe: false,
    timestamp: Date.now(),
    ticketStatus: "open",
    agentActive: true,
    hasHumanAssigned: false,
  };
}

function stub(rec: {
  sent: string[];
  presence: string[];
  isClosed: (boolean | undefined)[];
}) {
  return {
    sendText: async (
      _number: string,
      body: string,
      opts?: { isClosed?: boolean },
    ) => {
      rec.sent.push(body);
      rec.isClosed.push(opts?.isClosed);
      return {};
    },
    sendPresence: async (_ticketId: number, state: string) => {
      rec.presence.push(state);
      return {};
    },
  } as unknown as ZproClient;
}
const noSleep = async () => {};

describe("deliverZproReply", () => {
  test("disabled → a single send, no presence toggles", async () => {
    const rec = {
      sent: [] as string[],
      presence: [] as string[],
      isClosed: [] as (boolean | undefined)[],
    };
    const n = await deliverZproReply(
      stub(rec),
      event(),
      "oi\n\ntudo bem?",
      { ...SPLIT_DEFAULTS, enabled: false },
      noSleep,
    );
    expect(n).toBe(1);
    expect(rec.sent).toEqual(["oi\n\ntudo bem?"]);
    expect(rec.presence).toEqual([]);
  });

  test("enabled → one send per balloon, no presence toggles (the caller's heartbeat owns those)", async () => {
    const rec = {
      sent: [] as string[],
      presence: [] as string[],
      isClosed: [] as (boolean | undefined)[],
    };
    const n = await deliverZproReply(
      stub(rec),
      event(),
      "Olá!\n\nComo vai?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(n).toBe(2);
    expect(rec.sent).toEqual(["Olá!", "Como vai?"]);
    expect(rec.presence).toEqual([]);
  });

  // Regression (2026-08-18): a resolve_conversation intent used to close the ORIGINAL ticketId via
  // a separate updateTicketInfo call, made AFTER this delivery. sendText addresses Z-PRO's
  // send-message endpoint by contact NUMBER, not ticketId — the vendor's own API docs confirm a
  // send can land on a ticket "criado ou reutilizado" (created or reused), so closing the id this
  // turn started on could miss the ticket the reply actually landed on. Passing `isClosed` on the
  // send itself (the LAST balloon only) closes whichever ticket that specific message lands on.
  test("closeTicket=false (default) → no send carries isClosed", async () => {
    const rec = {
      sent: [] as string[],
      presence: [] as string[],
      isClosed: [] as (boolean | undefined)[],
    };
    await deliverZproReply(
      stub(rec),
      event(),
      "Olá!\n\nComo vai?",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
    );
    expect(rec.isClosed).toEqual([undefined, undefined]);
  });

  test("closeTicket=true, split disabled → the single send carries isClosed:true", async () => {
    const rec = {
      sent: [] as string[],
      presence: [] as string[],
      isClosed: [] as (boolean | undefined)[],
    };
    await deliverZproReply(
      stub(rec),
      event(),
      "Disponha!",
      { ...SPLIT_DEFAULTS, enabled: false },
      noSleep,
      undefined,
      true,
    );
    expect(rec.isClosed).toEqual([true]);
  });

  test("closeTicket=true, split enabled → only the LAST balloon carries isClosed:true", async () => {
    const rec = {
      sent: [] as string[],
      presence: [] as string[],
      isClosed: [] as (boolean | undefined)[],
    };
    await deliverZproReply(
      stub(rec),
      event(),
      "Olá!\n\nComo vai?\n\nTchau!",
      { ...SPLIT_DEFAULTS, enabled: true },
      noSleep,
      undefined,
      true,
    );
    expect(rec.sent.length).toBeGreaterThan(1);
    expect(rec.isClosed.slice(0, -1).every((v) => v === undefined)).toBe(true);
    expect(rec.isClosed.at(-1)).toBe(true);
  });
});
