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

function stub(rec: { sent: string[]; presence: string[] }) {
  return {
    sendText: async (_number: string, body: string) => {
      rec.sent.push(body);
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
    const rec = { sent: [] as string[], presence: [] as string[] };
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
    const rec = { sent: [] as string[], presence: [] as string[] };
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
});
