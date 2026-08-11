# Z-PRO ("FusaoChatBot CRM") integration

A second, separate WhatsApp/CRM channel alongside the Chatwoot integration — a full vertical slice (Prisma models → public webhook receiver → normalize/mirror → agent runtime → admin + read REST → React pages → i18n) under `src/modules/zpro/*`. User-facing text calls it "FusaoChatBot CRM"; routes, table names (`zpro_*`), and internal identifiers keep the `zpro`/`Zpro` spelling — the rebrand is UI-only.

Independent of `src/modules/chatwoot/*` end to end: separate Prisma models, separate webhook mount, separate runtime (`runZproAgentTurn`, not `runAgentTurn`), separate checkpointer thread namespace. The two integrations never share code paths.

## Module map

- `types.ts` — raw webhook payload shapes (built from real captured payloads, 2026-08-06) + `NormalizedZproEvent`, the shape the runtime consumes.
- `constants.ts` — method/type-group literals, the agent gate flag name (`n8nStatus`), presence states, and the two in-memory TTLs (`ZPRO_IDEMPOTENCY_TTL_MS` for webhook dedup, `ZPRO_AGENT_ECHO_TTL_MS` for sender-type classification — see below).
- `parse.ts` — shared payload extraction (`extractMedia`, `extractMessageBody`, `extractWhatsappId`, `extractInstanceName`), used by both `normalize.ts` and `mirror.ts` so the two don't duplicate parsing.
- `normalize.ts` — `normalizeZproWebhook`: the **agent gate**. Returns `null` (drop) for non-message events, `fromMe` messages, groups, `botStopped`, `n8nStatus: false`, or an unresolvable channel identity. Only events that pass this gate reach `runZproAgentTurn`.
- `mirror.ts` — `mirrorZproMessage`: persists **every** message (client/agent/human), independent of the agent gate — the source of truth for `ZproConversationsPage`/`ZproConversationDetailPage`. Tolerates a concurrent-webhook-redelivery P2002 race on both the conversation and message upserts (see the file's own comments; covered by `tests/modules/zpro/mirror.test.ts`). Also exports `mirrorZproContact`: handles `contact-create-update` payloads, updating name/`avatarUrl`/number on every existing `ZproConversation` for that contact (no message is created). See "Contact identification" below.
- `agent-echo.ts` — `markAgentSending`/`wasAgentSending`: see "Sender-type classification" below.
- `stt.ts` — `resolveZproSttConfig`/`transcribeZproAudio`: audio transcription for the Z-PRO channel. See "Audio transcription (STT)" below.
- `runtime.ts` — `runZproAgentTurn`: the minimal agent turn. CAS-claims the `ZproWebhookDelivery` row (`PENDING`→`PROCESSING`), resolves the bound agent + model credential, interpolates prompt variables, loads any granted INTEGRATION tools (`tools.ts`), invokes the graph with a `UsageCapture` callback (`src/graph/usage.ts`, see "AI usage capture" below), replies via `ZproClient`, marks the delivery `PROCESSED`/`FAILED`.
- `tools.ts` — `loadZproIntegrationTools`: reuses the Chatwoot path's generic `AgentToolSelection → IntegrationInstance → toolpack` chain (`src/graph/tools/assemble.ts`'s `loadToolSelections` + `src/modules/integrations/toolpacks`'s `buildToolpackTools`) with zero Chatwoot coupling. Returns `{ tools, conversationId }` — the `ZproConversation.id` lookup is shared with `runtime.ts`'s usage capture (one lookup, two consumers). See "INTEGRATION tools" below.
- `analytics.ts` — `getZproFunnelMetrics`: current-state funnel counts (conversations/agent-handled/human-escalated/resolved) plus AI-usage totals (`promptTokens`/`completionTokens`/`calls`, from `LlmUsage.zproConversationId`) for the Dashboard's "FusaoChatBot CRM" section.
- `client.ts` — `ZproClient`, a ~90-method REST wrapper over the external Z-PRO v4 API (`{baseUrl}/v2/api/external/{apiId}/...`, Bearer auth). Most methods are unused today (built ahead of the UI that will call them); `listChannels()` backs the instance-modal probe (see below). See [`docs/zpro-api-reference.md`](zpro-api-reference.md) for the vendor's full API spec and the Google Calendar vs. Agendamentos distinction.
- `messages.ts` — reply-side helpers (`sendTyping`, `sendTextReply` — splits on blank lines into balloons — `sendVoiceReply`, `sendMediaReply`, `saveContactMemory`). Only `sendTyping`/`sendTextReply` are wired into `runtime.ts` today.
- `handoff.ts` — `activateAgent`/`deactivateAgent` (toggle `ticket.n8nStatus` via the external API), used by the manual toggle endpoint and by the webhook's auto-handoff-on-human-intervention.
- `ctx.ts` — `sysCtx(tenantId)`: the canonical `TenantContext` for system-driven (non-request) DB access once the tenant is already known (webhook post-resolution, mirror, runtime). Contrast with `asSuperAdminOn`, used only pre-tenant-resolution in the webhook controller.
- `zpro-webhook-mount.ts` — the single global webhook path (`/api/v1/zpro/webhook`) and `zproWebhookUrl()` helper. Z-PRO has **one webhook per server**, not per-instance — no route token, unlike Chatwoot.

## Message flow

```
Z-PRO panel → POST /v1/zpro/webhook (public, no HMAC — Z-PRO doesn't sign)
  → resolve ZproInstance by whatsappId (tenant unknown yet → asSuperAdminOn, audited)
  → mirrorZproMessage (ALL messages, RLS-scoped once tenant is known)
  → mirrorZproContact (contact-create-update only — name/avatar refresh, best-effort)
  → eager STT (inbound voice notes only — transcribe, write back to ZproMessage.body, re-broadcast)
  → auto-handoff: human sent this message while agent was still active → deactivateAgent, never re-activates automatically
  → handleZproWebhook (in-memory idempotency by messageId, TTL cache)
    → normalizeZproWebhook (agent gate)
    → ZproWebhookDelivery upsert (idempotency ledger, PENDING)
    → runZproAgentTurn — detached, ack already sent (<5s)
```

`runZproAgentTurn` CAS-claims the delivery row, loads the bound agent + resolves its model credential, interpolates the system prompt, invokes the LangGraph checkpointed graph (thread `zpro:<tenantId>:<zproInstanceId>:<ticketId>` — its own namespace, never collides with a Chatwoot thread) with a `UsageCapture` callback, sends the reply via `ZproClient.sendText`, and marks the delivery `PROCESSED` or `FAILED`. A `turnId` is generated once in the controller (before the STT step) and threaded through to the turn, so a voice note's `stt` flowlog stage and its `generate` stage land on the same `/logs` row.

## Sender-type classification (`ZproSenderType`: CLIENT | AGENT | HUMAN)

`mirror.ts`'s `resolveSenderType` used to trust `ticket.userId` (the ticket's **assigned** attendant — sticky, set once and never cleared) as a proxy for "who authored this message." That is wrong: once any ticket has a human assignee, every later AI-sent message was misclassified `HUMAN` — confirmed against real data (`{{nome_contato}}`-containing, unmistakably AI-generated replies stored as `HUMAN`).

Fix: `runtime.ts` calls `markAgentSending(zproInstanceId, ticketId)` right before sending the reply. `mirror.ts` checks `wasAgentSending(...)` **first** when classifying a `fromMe` message — if true, it's `AGENT` regardless of `ticket.userId`; otherwise it falls back to the `ticket.userId` heuristic (genuinely means HUMAN in that case, since we're the only source of AGENT-authored messages — human replies always come from the Z-PRO panel, never through our code). The marker is a short-TTL (`ZPRO_AGENT_ECHO_TTL_MS`, 30s) in-memory `Map`, same pattern as the webhook idempotency cache — covers multi-balloon replies + webhook round-trip lag, expires on its own.

## Template variables

The system prompt is interpolated via the same canonical, sanitized resolver the Chatwoot path uses (`src/graph/prompt.ts`: `buildPromptVars` + `interpolatePromptVars`, called from `prepare.ts` for Chatwoot) — `runtime.ts` calls it directly before building the graph. Resolves `{{nome_contato}}`/`{{primeiro_nome}}` (from `ticket.contact.name`), `{{telefone_contato}}` (`ticket.contact.number`), `{{canal}}` (`ev.channelType`), `{{nome_empresa}}` (`Tenant.name`), `{{nome_agente}}` (`Agent.name`), plus all the time variables (`{{hora_atual}}`, `{{data_atual}}`, …). No grounding directive is appended — Z-PRO has no RAG/tools yet, so it's always ungrounded.

## Contact identification (name + avatar)

`ticket.contact.profilePicUrl` arrives on the Z-PRO `contact-create-update` webhook method (a separate payload shape from `message`, gated by `ZPRO_METHOD_CONTACT` in `constants.ts`). `mirrorZproContact` (`mirror.ts`) handles it: `updateMany` on every `ZproConversation` matching `(zproInstanceId, contactId)`, refreshing `contactName`/`contactNumber`/`avatarUrl` — no message is created, and it no-ops (zero rows affected, no error) if the contact has no conversation yet. Called from `zpro.controller.ts` right after `mirrorZproMessage`, wrapped in try/catch (best-effort, never blocks the webhook ack).

**OPEN-VALIDATION**: only the `message` method's payload shape has a real captured sample (`types.ts`, 2026-08-06); `contact-create-update` carrying `whatsapp.id` at the payload root (needed to resolve the instance before `mirrorZproContact` ever runs) is assumed, not confirmed. If a real capture shows otherwise, `extractWhatsappId` will reject the payload earlier (`outcome: "skipped:no-whatsapp-id"`) and this code path never executes — no crash, just silent no-op. Confirm against a live payload and tighten once available.

`avatarUrl` is a plain nullable column on `ZproConversation` (and, for the Chatwoot side, on `Contact` — populated from `sender.thumbnail` in `normalize.ts`/`mirror.ts`). The frontend never renders the raw external URL directly (CSP `img-src` only allows same-origin/data/blob) — both `GET /v1/conversations/:id/avatar` and `GET /v1/zpro/conversations/:id/avatar` proxy it through `assertSafeOutboundUrl` (anti-SSRF) + a plain `fetch`, same pattern as the existing Chatwoot attachment proxy. The shared `<Avatar>` component (`src/client/components/Avatar.tsx`) hits these endpoints and falls back to initials on load failure.

## Audio transcription (STT)

Mirrors the Chatwoot "eager STT at message arrival" pattern (`docs/stt.md`): transcription runs in the webhook controller (`zpro.controller.ts`, step "1c"), independent of the agent gate, so a human operator sees the transcript even on turns the agent gate would otherwise drop (`n8nStatus: false`, `botStopped`, etc.) — and independent of whether an agent is even bound to the instance.

- **Config resolution**: `resolveZproSttConfig(tenantId, zproInstanceId, base)` (`stt.ts`) resolves the bound agent via `ZproAgentBinding` (not `Inbox.agentId` — Z-PRO has no inbox concept) then reads the same generic `agent.settings.stt` schema Chatwoot uses (`readSttConfig`, `src/modules/stt/settings.ts`). Same Behavior-tab UI, no Z-PRO-specific config surface.
- **Download**: unlike Chatwoot (which downloads via an authenticated `ChatwootClient` call), Z-PRO's webhook payload carries the raw WhatsApp CDN URL (`message.audioMessage.url`, e.g. `https://mmg.whatsapp.net/...`) directly — `transcribeZproAudio` downloads it with `assertSafeOutboundUrl` (anti-SSRF: blocks private/loopback/CGNAT ranges, forces HTTPS) before an injectable `fetchImpl` runs, then transcribes via the same provider registry Chatwoot uses (`getSttProvider`, `src/modules/stt/providers.ts`) and cleans the result with `cleanTranscription` (`chatwoot/render.ts`, shared — the Amara.org Whisper hallucination filter isn't Chatwoot-specific).
- **Persistence — write-back target differs from Chatwoot**: Chatwoot writes the transcript back to Chatwoot itself (the source of truth there). Z-PRO's inbox UI is sourced from `ZproMessage` (`mirrorZproMessage` already wrote the message with an empty `body` when the voice note first arrived), so the controller updates that same row's `body` in place (keyed by `conversationId_messageId`) and re-broadcasts over the realtime channel so an operator already viewing the conversation sees the transcript land live.
- **Feeds the agent turn**: the transcribed text is also stuffed into the normalized event's `body` right before dispatch (`if (sttText && !event.body) event.body = sttText`) — a voice note with no caption would otherwise have empty `text` in `runtime.ts` and be skipped (`outcome: "skipped"`) before ever reaching the graph.
- **Best-effort, never blocks**: no STT configured, no credential, download failure, or provider error all resolve to `null` — the voice note stays mirrored with an empty body (today's pre-STT behavior), logged via `emitFlowEvent`/`withFlowStage` with `stage: "stt"` (a minimal `FlowContext` is built in the controller specifically for this, since `runtime.ts`'s own `FlowContext` doesn't exist yet at this point in the request).

## AI usage capture (LlmUsage / Dashboard "LLM usage")

`runZproAgentTurn` passes a `UsageCapture` (`src/graph/usage.ts`, the same LangChain callback Chatwoot uses) into `graph.invoke({ ... }, { callbacks: [usageCapture] })`. The row it writes uses a **dedicated `LlmUsage.zproConversationId` column**, never `LlmUsage.conversationId` — `Conversation.id` (Chatwoot) and `ZproConversation.id` (Z-PRO) are independent autoincrement sequences with no FK on either usage column, so reusing one for the other risks silently attributing a Z-PRO turn's tokens to an unrelated Chatwoot conversation of the same numeric id (or vice versa). `inboxId` is always `null` for Z-PRO rows (no inbox concept), which already correctly excludes them from `getInstanceMetrics`'s `byInbox` breakdown.

Because the Dashboard's aggregate "LLM usage" totals/`byAgent`/`byModel`/`bySource` (`getInstanceMetrics`, `src/modules/analytics/service.ts`) sum over `LlmUsage` without filtering by `conversationId`, Z-PRO usage is included there automatically — no extra wiring needed once the callback is attached. The Dashboard's top "Automation funnel" (`getKpis`) and the daily chart's per-conversation denominator (`getTimeseries`) are **deliberately left Chatwoot-only** — both feed a cost-per-conversation ratio sourced from Langfuse, which has no Z-PRO tracing (see "Known, accepted gaps" below); folding Z-PRO conversations into that denominator without matching cost in the numerator would silently understate the figure. Z-PRO's own AI-usage totals are surfaced instead by `getZproFunnelMetrics` (`promptTokens`/`completionTokens`/`calls`, "real" `source: "inbox"` only — same convention as `getKpis`), shown as a "Tokens (in / out)" card in the Dashboard's "FusaoChatBot CRM" section. See the comment above `getKpis` in `src/modules/analytics/service.ts` for the full reasoning.

## Dashboard funnel

`GET /v1/zpro/conversations/analytics/funnel?since=<ISO>` (`zpro-conversations.controller.ts`, `requireAuth`) → `getZproFunnelMetrics`: `conversations`/`agentHandled`/`humanEscalated`/`resolved` counts on `ZproConversation` within the window, plus `promptTokens`/`completionTokens`/`calls` summed from `LlmUsage.zproConversationId` (see "AI usage capture" above). **The conversation-state counts reflect current state, not history** — `ZproConversation` has no audit trail, so a conversation that was agent-handled and later escalated only counts toward `humanEscalated`, never both. The Dashboard's "FusaoChatBot CRM" section (`DashboardPage.tsx`) only renders for tenants with at least one `ZproInstance` — resolved once via `GET /v1/zpro/instances`, independent of the date-range control.

## Instance setup: channel probe

`POST /v1/zpro/probe` (`zpro-admin.controller.ts`, `TENANT_ADMIN`, no DB access) tests `{baseUrl, apiId, bearerToken}` against the external API's `listChannels()` and returns `{ok, channels: [{id, name, type, status}]}` — never a 500, any failure or unusable shape returns `{ok: false, channels: []}`. The add-instance modal (`ZproSection.tsx`) is two-phase: enter credentials → probe → pick a channel (auto-resolves `whatsappId`, previously a manually-typed number). A "enter manually instead" escape hatch preserves the original single-phase flow if the probe doesn't work against some deployment.

**Open-validation**: `listChannels()`'s response shape has no captured real-payload sample (unlike the webhook payloads, which come from a real capture) — the mapper in `zpro-admin.controller.ts` is deliberately defensive (tries a few plausible shapes, coerces/defaults fields, drops unusable items). Confirm against a live Z-PRO instance and tighten once available.

## INTEGRATION tools (Google Calendar, Asaas, ...)

An agent bound to a Z-PRO instance can be granted any tenant-wide INTEGRATION (Google Calendar, Asaas, ...) the exact same way a Chatwoot agent can — same "Add instance"/OAuth screen (Resources → Integrations, `IntegrationEditModal.tsx`, channel-agnostic), same Tools tab grant UI (`ToolGrantsEditor.tsx`, no canal gate). `runZproAgentTurn` calls `loadZproIntegrationTools` (`tools.ts`) before building the graph, which reuses `loadToolSelections`/`buildToolpackTools` as-is — no Chatwoot object required by either.

- **`contactDbId` stamp**: toolpacks that isolate per-customer data (Calendar's `secv4Contact` ownership stamp) need a `ToolpackCtx.contactDbId`. Z-PRO has no `Contact` table (see the schema comment above `ZproConversation`); `tools.ts` uses `ZproConversation.id` instead — correct isolation per ticket, but a phone number that opens a new ticket later gets a new id and "loses" visibility into appointments stamped under the old one. Acceptable for now; revisit if Z-PRO ever gets a stable per-phone-number contact.
- **Toolpacks that need a live Chatwoot handle will fail gracefully, not run**: `ToolpackCtx.chatwoot` (client + conversationId) is never populated for Z-PRO — Google Drive's `send_file` requires it and will error out if granted to a Z-PRO agent (the tool wrapper never throws uncaught, so this is a clear tool-error message to the model, not a crash). Google Calendar and Asaas don't touch `ctx.chatwoot` at all and work as-is.
- **No allowlist by catalogType**: any INTEGRATION granted to a Z-PRO agent is exposed — the grant itself (an explicit operator action) is the security boundary, same philosophy as Chatwoot.

## Known, accepted gaps

- **`emitFlowEvent`/`withFlowStage`**: only `"stt"` (voice notes, controller) and `"generate"` (`runtime.ts`) are spanned; `sendTextReply`, the typing indicator, and INTEGRATION tool calls aren't — a tool call succeeding or failing today leaves no line in `/logs`.
- **No Langfuse tracing**: `runtime.ts` builds the model/graph directly, never calls `buildCallbacks`/`buildLangfuseHandler` — no trace is emitted for Z-PRO turns (including tool calls) even when Langfuse is configured for the tenant. This is also why the Dashboard's cost-per-conversation figure stays Chatwoot-only (see "AI usage capture" above) — there is no Z-PRO cost to attribute.
- **No `lastInboundAt`**: `ZproConversation` has no equivalent column — Z-PRO conversations are entirely outside the follow-up/nudge/service-window subsystem.
- **`ZproWebhookDelivery.FAILED` is terminal**: `attempts` increments but nothing retries a failed delivery (no reaper exists for either integration, not zpro-specific).
- **No NATIVE/RAG/HTTP/MCP tools yet**: only INTEGRATION tools are wired (see above) — a deliberate scope limit, not a bug.
