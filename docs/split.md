# Split + typing (humanized delivery)

Instead of dumping one wall of text, optionally break the agent's reply into several balloons paced with a typing indicator + a proportional delay — the n8n "Quebrar e enviar mensagens" behavior. Per agent, **on by default** (`SPLIT_DEFAULTS.enabled`) — opt-out, not opt-in (the added latency is small and bounded by `maxDelayMs`). Applies to TEXT replies only — an audio reply is a single voice note.

## Module (`src/modules/split/service.ts`)

- `splitReply(text, cfg)` — split on blank lines (paragraphs); any paragraph over `maxChars` is further split on sentence boundaries; the balloon count is capped at `maxChunks` (overflow merged into the last). Always ≥1 non-empty chunk.
- `typingDelayMs(chunk, cfg)` — `words / typingWpm × 60s`, clamped to `[minDelayMs, maxDelayMs]`.
- `deliverReply(client, conversationId, reply, cfg, sleep?)` — the loop the runtime calls for text replies: disabled → one `sendMessage`; enabled → per balloon `toggleTyping(on)` → `sleep(delay)` → `sendMessage`, then a final `toggleTyping(off)`. Typing toggles are **best-effort** (admin token, `.catch` swallows failures — the indicator may be unsupported on a channel; the pacing still applies). `sleep` is injectable (tests pass a no-op).

This file documents the **Chatwoot** channel (`deliverReply`, hard-coded to `ChatwootClient`). The independent **Z-PRO** channel reuses the same pure helpers (`splitReply`/`typingDelayMs`/`readSplitConfig`/`SplitConfig`) but has its own delivery loop, `src/modules/zpro/split.ts`'s `deliverZproReply`, over `ZproClient.sendText`/`sendPresence("typing"|"paused")` instead of `ChatwootClient.sendMessage`/`toggleTyping`. See [`docs/zpro.md`](zpro.md#split--typing-pacing).

`client.toggleTyping(id, on)` = `POST …/conversations/{id}/toggle_typing_status { typing_status }` (admin token — not in the bot allowlist). The runtime threads an injectable `sleep` via `RuntimeDeps`.

## Configuration

Per-agent `agent.settings.split` (`readSplitConfig`): `enabled` (default `false`), `maxChars` (default 600), `typingWpm` (250), `minDelayMs` (800), `maxDelayMs` (8000), `maxChunks` (6). The editor Behavior tab exposes enabled + maxChars + typingWpm + maxDelayMs; min/maxChunks keep defaults. Writable over REST (`PATCH /v1/agents/:id`) + MCP (`agent_settings_get`/`agent_settings_set`, the `split` block) via the settings bag.

## Interaction notes

- The reply text is committed before delivery; a multi-balloon send takes seconds during which a human could take over — acceptable for the single-replica MVP (debounce already coalesced the input side). A future refinement could re-check the assignee between balloons.
- Holds the processing/job a bit longer (within the scheduler reaper window). Typical replies finish well under the stale threshold.

Read before touching `src/modules/split/*`, `client.toggleTyping`, or the text-delivery branch in `runLoadedTurn`.
