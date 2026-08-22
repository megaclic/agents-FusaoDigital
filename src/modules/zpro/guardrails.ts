// src/modules/zpro/guardrails.ts
// Input/output content moderation for the Z-PRO channel — reuses the fully generic guardrails
// engine (src/modules/guardrails/{analyze,settings}.ts, the same one Chatwoot uses) with zero
// Chatwoot coupling. The only Z-PRO-specific piece is the trip note: ZproClient.createNote in
// place of Chatwoot's client.sendPrivateNote.

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { verdictAskMode } from "@/graph/model-config";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { analyzeGuardrail } from "@/modules/guardrails/analyze";
import type { GuardrailsConfig } from "@/modules/guardrails/settings";
import type { ZproClient } from "./client";

export type GuardrailOutcome = { reply: string | null } | null;
export type RunGuardrail = (
  direction: "input" | "output",
  text: string,
) => Promise<GuardrailOutcome>;

// `model` is null when guardrails are disabled or the credential didn't resolve — the returned
// runner then always no-ops (fail-open, mirrors src/graph/runtime.ts's own guard).
export function makeZproGuardrailRunner(params: {
  gr: GuardrailsConfig;
  model: BaseChatModel | null;
  systemPrompt: string;
  flow: FlowContext;
  client: ZproClient;
  ticketId: number;
  // The customer's own raw inbound text for THIS turn — passed through as `customerMessage` on the
  // output-direction call so a "generate a safe replacement" verdict rewrites the ASSISTANT's reply,
  // never the customer's own message (mirrors src/graph/runtime.ts's own call).
  customerText: string;
}): RunGuardrail {
  const { gr, model, systemPrompt, flow, client, ticketId, customerText } =
    params;
  return async (direction, text) => {
    const dir = gr[direction];
    if (!model || !dir.enabled) return null;
    const verdict = await analyzeGuardrail(
      model,
      {
        direction,
        text,
        checks: dir.checks,
        competitors: gr.competitors,
        customPolicy: gr.customPolicy,
        systemPrompt: direction === "output" ? systemPrompt : undefined,
        customerMessage: direction === "output" ? customerText : undefined,
        generationPrompt:
          dir.action === "generated" ? dir.generationPrompt : undefined,
      },
      // Constrained where the endpoint implements it, in the dialect it speaks — same rule as
      // src/graph/runtime.ts's own call (issue #131).
      verdictAskMode(gr.provider),
    );
    if (!verdict.violated) return null;
    emitFlowEvent(flow, {
      stage: "guardrail",
      status: "ok",
      level: "warn",
      detail: {
        direction,
        action: dir.action,
        categories: verdict.categories,
        rationale: verdict.rationale,
      },
    });
    await client
      .createNote(
        ticketId,
        `Guardrail (${direction}): ${verdict.categories.join(", ") || "policy"} — ${dir.action}. ${verdict.rationale}`,
      )
      .catch(() => {});
    if (dir.action === "silent") return { reply: null };
    return {
      reply:
        dir.action === "generated"
          ? (verdict.suggestedReply ?? dir.templateMessage)
          : dir.templateMessage,
    };
  };
}
