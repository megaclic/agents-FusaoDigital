// tests/modules/zpro/guardrails.test.ts
// makeZproGuardrailRunner wires the fully generic guardrails engine (analyzeGuardrail,
// already covered by tests/modules/guardrails.test.ts) into the Z-PRO channel. No network/DB: the
// chat model and ZproClient are both duck-typed and cast, same pattern as tests/modules/zpro/tts.test.ts
// and tests/modules/guardrails.test.ts's own fakeModel. This only tests the WIRING (trip note via
// ZproClient.createNote, fail-open when disabled/unresolved, action → return shape), not the
// analysis logic itself.

import { describe, expect, test } from "bun:test";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import type { FlowContext } from "@/modules/flowlog/service";
import { GUARDRAILS_DEFAULTS } from "@/modules/guardrails/settings";
import type { ZproClient } from "@/modules/zpro/client";
import { makeZproGuardrailRunner } from "@/modules/zpro/guardrails";

function fakeModel(content: string): BaseChatModel {
  return { invoke: async () => ({ content }) } as unknown as BaseChatModel;
}

function fakeClient(): { client: ZproClient; notes: Array<[number, string]> } {
  const notes: Array<[number, string]> = [];
  const client = {
    createNote: async (ticketId: number, note: string) => {
      notes.push([ticketId, note]);
      return {};
    },
  } as unknown as ZproClient;
  return { client, notes };
}

const flow: FlowContext = {
  tenantId: 1n,
  turnId: "t1",
  source: "inbox",
  threadId: "zpro:1:1:1",
};

describe("makeZproGuardrailRunner", () => {
  test("fail-open: null model (disabled/unresolved credential) never trips", async () => {
    const { client } = fakeClient();
    const runGuardrail = makeZproGuardrailRunner({
      gr: { ...GUARDRAILS_DEFAULTS, enabled: true },
      model: null,
      systemPrompt: "x",
      flow,
      client,
      ticketId: 1,
    });
    expect(await runGuardrail("input", "anything")).toBeNull();
  });

  test("disabled direction never trips even with a violating model response", async () => {
    const { client } = fakeClient();
    const gr = {
      ...GUARDRAILS_DEFAULTS,
      enabled: true,
      input: { ...GUARDRAILS_DEFAULTS.input, enabled: false },
    };
    const runGuardrail = makeZproGuardrailRunner({
      gr,
      model: fakeModel(
        JSON.stringify({ violated: true, categories: ["toxicity"] }),
      ),
      systemPrompt: "x",
      flow,
      client,
      ticketId: 1,
    });
    expect(await runGuardrail("input", "xingamento")).toBeNull();
  });

  test("a clean verdict (violated: false) returns null and leaves no note", async () => {
    const { client, notes } = fakeClient();
    const runGuardrail = makeZproGuardrailRunner({
      gr: { ...GUARDRAILS_DEFAULTS, enabled: true },
      model: fakeModel(JSON.stringify({ violated: false })),
      systemPrompt: "x",
      flow,
      client,
      ticketId: 42,
    });
    expect(await runGuardrail("input", "oi, tudo bem?")).toBeNull();
    expect(notes).toHaveLength(0);
  });

  test("action 'template' returns the configured template and posts a trip note", async () => {
    const { client, notes } = fakeClient();
    const gr = {
      ...GUARDRAILS_DEFAULTS,
      enabled: true,
      input: {
        ...GUARDRAILS_DEFAULTS.input,
        action: "template" as const,
        templateMessage: "Não posso ajudar com isso.",
      },
    };
    const runGuardrail = makeZproGuardrailRunner({
      gr,
      model: fakeModel(
        JSON.stringify({
          violated: true,
          categories: ["toxicity"],
          rationale: "abusive language",
        }),
      ),
      systemPrompt: "x",
      flow,
      client,
      ticketId: 42,
    });
    const outcome = await runGuardrail("input", "xingamento");
    expect(outcome).toEqual({ reply: "Não posso ajudar com isso." });
    expect(notes).toHaveLength(1);
    expect(notes[0]?.[0]).toBe(42);
    expect(notes[0]?.[1]).toContain("toxicity");
  });

  test("action 'silent' returns { reply: null } (suppress the send)", async () => {
    const { client } = fakeClient();
    const gr = {
      ...GUARDRAILS_DEFAULTS,
      enabled: true,
      output: { ...GUARDRAILS_DEFAULTS.output, action: "silent" as const },
    };
    const runGuardrail = makeZproGuardrailRunner({
      gr,
      model: fakeModel(JSON.stringify({ violated: true, categories: [] })),
      systemPrompt: "x",
      flow,
      client,
      ticketId: 1,
    });
    expect(await runGuardrail("output", "reply text")).toEqual({
      reply: null,
    });
  });

  test("action 'generated' returns the model's suggestedReply, falling back to the template", async () => {
    const { client } = fakeClient();
    const gr = {
      ...GUARDRAILS_DEFAULTS,
      enabled: true,
      output: {
        ...GUARDRAILS_DEFAULTS.output,
        action: "generated" as const,
        templateMessage: "fallback",
      },
    };
    const withSuggestion = makeZproGuardrailRunner({
      gr,
      model: fakeModel(
        JSON.stringify({
          violated: true,
          categories: [],
          suggestedReply: "resposta segura sugerida",
        }),
      ),
      systemPrompt: "x",
      flow,
      client,
      ticketId: 1,
    });
    expect(await withSuggestion("output", "reply")).toEqual({
      reply: "resposta segura sugerida",
    });

    const withoutSuggestion = makeZproGuardrailRunner({
      gr,
      model: fakeModel(JSON.stringify({ violated: true, categories: [] })),
      systemPrompt: "x",
      flow,
      client,
      ticketId: 1,
    });
    expect(await withoutSuggestion("output", "reply")).toEqual({
      reply: "fallback",
    });
  });
});
