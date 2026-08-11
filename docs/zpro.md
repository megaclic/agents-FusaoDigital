# Z-PRO ("FusaoChatBot CRM") integration

A second, separate WhatsApp/CRM channel alongside the Chatwoot integration — a full vertical slice (Prisma models → public webhook receiver → normalize/mirror → agent runtime → admin + read REST → React pages → i18n) under `src/modules/zpro/*`. User-facing text calls it "FusaoChatBot CRM"; routes, table names (`zpro_*`), and internal identifiers keep the `zpro`/`Zpro` spelling — the rebrand is UI-only.

Independent of `src/modules/chatwoot/*` end to end: separate Prisma models, separate webhook mount, separate runtime (`runZproAgentTurn`, not `runAgentTurn`), separate checkpointer thread namespace. The two integrations never share code paths.

## Module map

- `types.ts` — raw webhook payload shapes (built from real captured payloads, 2026-08-06) + `NormalizedZproEvent`, the shape the runtime consumes.
- `constants.ts` — method/type-group literals, the agent gate flag name (`n8nStatus`), presence states, and the two in-memory TTLs (`ZPRO_IDEMPOTENCY_TTL_MS` for webhook dedup, `ZPRO_AGENT_ECHO_TTL_MS` for sender-type classification — see below).
- `parse.ts` — shared payload extraction (`extractMedia`, `extractMessageBody`, `extractWhatsappId`, `extractInstanceName`), used by both `normalize.ts` and `mirror.ts` so the two don't duplicate parsing.
- `normalize.ts` — `normalizeZproWebhook`: the **agent gate**. Returns `null` (drop) for non-message events, `fromMe` messages, groups, `botStopped`, `n8nStatus: false`, or an unresolvable channel identity. Only events that pass this gate reach `runZproAgentTurn`.
- `mirror.ts` — `mirrorZproMessage`: persists **every** message (client/agent/human), independent of the agent gate — the source of truth for `ZproConversationsPage`/`ZproConversationDetailPage`. Tolerates a concurrent-webhook-redelivery P2002 race on both the conversation and message upserts (see the file's own comments; covered by `tests/modules/zpro/mirror.test.ts`).
- `agent-echo.ts` — `markAgentSending`/`wasAgentSending`: see "Sender-type classification" below.
- `runtime.ts` — `runZproAgentTurn`: the minimal agent turn (no tools yet). CAS-claims the `ZproWebhookDelivery` row (`PENDING`→`PROCESSING`), resolves the bound agent + model credential, interpolates prompt variables, invokes the graph, replies via `ZproClient`, marks the delivery `PROCESSED`/`FAILED`.
- `analytics.ts` — `getZproFunnelMetrics`: current-state funnel counts (conversations/agent-handled/human-escalated/resolved) for the Dashboard's "FusaoChatBot CRM" section.
- `client.ts` — `ZproClient`, a ~90-method REST wrapper over the external Z-PRO v4 API (`{baseUrl}/v2/api/external/{apiId}/...`, Bearer auth). Most methods are unused today (built ahead of the UI that will call them); `listChannels()` backs the instance-modal probe (see below).
- `messages.ts` — reply-side helpers (`sendTyping`, `sendTextReply` — splits on blank lines into balloons — `sendVoiceReply`, `sendMediaReply`, `saveContactMemory`). Only `sendTyping`/`sendTextReply` are wired into `runtime.ts` today.
- `handoff.ts` — `activateAgent`/`deactivateAgent` (toggle `ticket.n8nStatus` via the external API), used by the manual toggle endpoint and by the webhook's auto-handoff-on-human-intervention.
- `ctx.ts` — `sysCtx(tenantId)`: the canonical `TenantContext` for system-driven (non-request) DB access once the tenant is already known (webhook post-resolution, mirror, runtime). Contrast with `asSuperAdminOn`, used only pre-tenant-resolution in the webhook controller.
- `zpro-webhook-mount.ts` — the single global webhook path (`/api/v1/zpro/webhook`) and `zproWebhookUrl()` helper. Z-PRO has **one webhook per server**, not per-instance — no route token, unlike Chatwoot.

## Message flow

```
Z-PRO panel → POST /v1/zpro/webhook (public, no HMAC — Z-PRO doesn't sign)
  → resolve ZproInstance by whatsappId (tenant unknown yet → asSuperAdminOn, audited)
  → mirrorZproMessage (ALL messages, RLS-scoped once tenant is known)
  → auto-handoff: human sent this message while agent was still active → deactivateAgent, never re-activates automatically
  → handleZproWebhook (in-memory idempotency by messageId, TTL cache)
    → normalizeZproWebhook (agent gate)
    → ZproWebhookDelivery upsert (idempotency ledger, PENDING)
    → runZproAgentTurn — detached, ack already sent (<5s)
```

`runZproAgentTurn` CAS-claims the delivery row, loads the bound agent + resolves its model credential, interpolates the system prompt, invokes the LangGraph checkpointed graph (thread `zpro:<tenantId>:<zproInstanceId>:<ticketId>` — its own namespace, never collides with a Chatwoot thread), sends the reply via `ZproClient.sendText`, and marks the delivery `PROCESSED` or `FAILED`.

## Sender-type classification (`ZproSenderType`: CLIENT | AGENT | HUMAN)

`mirror.ts`'s `resolveSenderType` used to trust `ticket.userId` (the ticket's **assigned** attendant — sticky, set once and never cleared) as a proxy for "who authored this message." That is wrong: once any ticket has a human assignee, every later AI-sent message was misclassified `HUMAN` — confirmed against real data (`{{nome_contato}}`-containing, unmistakably AI-generated replies stored as `HUMAN`).

Fix: `runtime.ts` calls `markAgentSending(zproInstanceId, ticketId)` right before sending the reply. `mirror.ts` checks `wasAgentSending(...)` **first** when classifying a `fromMe` message — if true, it's `AGENT` regardless of `ticket.userId`; otherwise it falls back to the `ticket.userId` heuristic (genuinely means HUMAN in that case, since we're the only source of AGENT-authored messages — human replies always come from the Z-PRO panel, never through our code). The marker is a short-TTL (`ZPRO_AGENT_ECHO_TTL_MS`, 30s) in-memory `Map`, same pattern as the webhook idempotency cache — covers multi-balloon replies + webhook round-trip lag, expires on its own.

## Template variables

The system prompt is interpolated via the same canonical, sanitized resolver the Chatwoot path uses (`src/graph/prompt.ts`: `buildPromptVars` + `interpolatePromptVars`, called from `prepare.ts` for Chatwoot) — `runtime.ts` calls it directly before building the graph. Resolves `{{nome_contato}}`/`{{primeiro_nome}}` (from `ticket.contact.name`), `{{telefone_contato}}` (`ticket.contact.number`), `{{canal}}` (`ev.channelType`), `{{nome_empresa}}` (`Tenant.name`), `{{nome_agente}}` (`Agent.name`), plus all the time variables (`{{hora_atual}}`, `{{data_atual}}`, …). No grounding directive is appended — Z-PRO has no RAG/tools yet, so it's always ungrounded.

## Dashboard funnel

`GET /v1/zpro/conversations/analytics/funnel?since=<ISO>` (`zpro-conversations.controller.ts`, `requireAuth`) → `getZproFunnelMetrics`: `conversations`/`agentHandled`/`humanEscalated`/`resolved` counts on `ZproConversation` within the window. **Reflects current state, not history** — `ZproConversation` has no audit trail, so a conversation that was agent-handled and later escalated only counts toward `humanEscalated`, never both. The Dashboard's "FusaoChatBot CRM" section (`DashboardPage.tsx`) only renders for tenants with at least one `ZproInstance` — resolved once via `GET /v1/zpro/instances`, independent of the date-range control.

## Instance setup: channel probe

`POST /v1/zpro/probe` (`zpro-admin.controller.ts`, `TENANT_ADMIN`, no DB access) tests `{baseUrl, apiId, bearerToken}` against the external API's `listChannels()` and returns `{ok, channels: [{id, name, type, status}]}` — never a 500, any failure or unusable shape returns `{ok: false, channels: []}`. The add-instance modal (`ZproSection.tsx`) is two-phase: enter credentials → probe → pick a channel (auto-resolves `whatsappId`, previously a manually-typed number). A "enter manually instead" escape hatch preserves the original single-phase flow if the probe doesn't work against some deployment.

**Open-validation**: `listChannels()`'s response shape has no captured real-payload sample (unlike the webhook payloads, which come from a real capture) — the mapper in `zpro-admin.controller.ts` is deliberately defensive (tries a few plausible shapes, coerces/defaults fields, drops unusable items). Confirm against a live Z-PRO instance and tighten once available.

## Known, accepted gaps

- **`emitFlowEvent`/`withFlowStage`**: only the `"generate"` stage is spanned (`runtime.ts`); `sendTextReply` and the typing indicator aren't.
- **No Langfuse tracing**: `runtime.ts` builds the model/graph directly, never calls `buildCallbacks`/`buildLangfuseHandler` — no trace is emitted for Z-PRO turns even when Langfuse is configured for the tenant.
- **No `lastInboundAt`**: `ZproConversation` has no equivalent column — Z-PRO conversations are entirely outside the follow-up/nudge/service-window subsystem.
- **`ZproWebhookDelivery.FAILED` is terminal**: `attempts` increments but nothing retries a failed delivery (no reaper exists for either integration, not zpro-specific).
- **No tools yet**: `runtime.ts` builds a bare graph with no RAG/HTTP/MCP/native tools — a deliberate Phase-2 scope limit, not a bug.
