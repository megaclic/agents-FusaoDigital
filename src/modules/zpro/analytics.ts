// src/modules/zpro/analytics.ts
// Funnel metrics for the "FusaoChatBot CRM" dashboard section — the Z-PRO (WhatsApp) equivalent of
// the Chatwoot automation funnel in src/modules/analytics/service.ts. Only relevant for tenants that
// have at least one ZproInstance configured; the caller is responsible for gating the section's
// visibility (most tenants don't use this integration).
//
// All aggregation runs against the `db: ScopedDb` passed in by the caller (already inside a scoped
// tx with the tenancy GUC set) so RLS fences every read to the tenant — never construct a manual
// tenantId filter here.

import type { ScopedDb } from "@/lib/tenancy";

export interface ZproFunnelMetrics {
  conversations: number;
  agentHandled: number;
  humanEscalated: number;
  resolved: number;
  // AI usage for this channel, straight from LlmUsage (never Langfuse — Z-PRO has no tracing yet,
  // see docs/zpro.md). Deliberately NOT folded into the Chatwoot-facing getKpis/getTimeseries
  // conversation counts in src/modules/analytics/service.ts: those feed a cost-per-conversation
  // ratio sourced from Langfuse cost (Chatwoot-only today), and Z-PRO conversations would dilute
  // that denominator without contributing to the numerator, silently understating the figure.
  promptTokens: number;
  completionTokens: number;
  calls: number;
}

// NOTE: conversations/agentHandled/humanEscalated/resolved reflect the CURRENT state of each
// conversation, not its history — ZproConversation has no audit trail, so a conversation that was
// agent-handled and later escalated to a human only counts toward `humanEscalated`, never both.
// This is a known, accepted limitation (mirrors the underlying Z-PRO ticket model), not a bug to
// fix here.
export async function getZproFunnelMetrics(
  db: ScopedDb,
  since: Date,
): Promise<ZproFunnelMetrics> {
  const where = { createdAt: { gte: since } };

  const [conversations, agentHandled, humanEscalated, resolved, usage] =
    await Promise.all([
      db.zproConversation.count({ where }),
      db.zproConversation.count({ where: { ...where, agentActive: true } }),
      db.zproConversation.count({
        where: { ...where, humanUserId: { not: null } },
      }),
      db.zproConversation.count({ where: { ...where, status: "closed" } }),
      db.llmUsage.aggregate({
        where: { ...where, zproConversationId: { not: null }, source: "inbox" },
        _sum: { promptTokens: true, completionTokens: true },
        _count: { _all: true },
      }),
    ]);

  return {
    conversations,
    agentHandled,
    humanEscalated,
    resolved,
    promptTokens: usage._sum.promptTokens ?? 0,
    completionTokens: usage._sum.completionTokens ?? 0,
    calls: usage._count._all,
  };
}
