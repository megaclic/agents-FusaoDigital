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
}

// NOTE: these reflect the CURRENT state of each conversation, not its history — ZproConversation
// has no audit trail, so a conversation that was agent-handled and later escalated to a human only
// counts toward `humanEscalated`, never both. This is a known, accepted limitation (mirrors the
// underlying Z-PRO ticket model), not a bug to fix here.
export async function getZproFunnelMetrics(
  db: ScopedDb,
  since: Date,
): Promise<ZproFunnelMetrics> {
  const where = { createdAt: { gte: since } };

  const [conversations, agentHandled, humanEscalated, resolved] =
    await Promise.all([
      db.zproConversation.count({ where }),
      db.zproConversation.count({ where: { ...where, agentActive: true } }),
      db.zproConversation.count({
        where: { ...where, humanUserId: { not: null } },
      }),
      db.zproConversation.count({ where: { ...where, status: "closed" } }),
    ]);

  return { conversations, agentHandled, humanEscalated, resolved };
}
