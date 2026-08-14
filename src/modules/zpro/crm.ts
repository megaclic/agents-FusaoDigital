// src/modules/zpro/crm.ts
// CRM Pipeline/Stage/Opportunity resolution for the Z-PRO kanban_move_card / update_kanban_task
// native tools (src/modules/zpro/native-tools.ts). Z-PRO's external API has no per-id GET for an
// Opportunity, so — unlike Chatwoot's src/modules/chatwoot/kanban.ts, which re-fetches the linked
// card fresh every turn — the "current stage" here is OUR OWN mirror (ZproConversation.opportunity*),
// updated on every successful move/update. Best-effort: it can drift if the deal is edited directly
// in the Z-PRO panel. Documented as a known, accepted limitation (docs/zpro.md).
//
// Response shapes are UNCONFIRMED (the vendor's Postman collection ships no example responses for
// pipeline/list, stage/list or listTags), so every parser here is defensive: accepts a bare array or
// a common wrapper key, and drops any entry missing a positive integer id / non-empty name rather
// than throwing. A shape drift degrades to an empty list (the tool then reports "not configured" /
// "unknown step"), never a crash.

import { readToolInstructions } from "@/modules/handoff/settings";
import type { ZproClient } from "./client";
import type { ZproContactTagRef } from "./types";

export interface ZproCrmConfig {
  // The CRM Pipeline (funnel) kanban_move_card / update_kanban_task operate on. null ⇒ auto-detect:
  // resolveZproPipelineId picks the tenant's SOLE pipeline when there is exactly one, else the tools
  // report "not configured" (ambiguous — multiple pipelines exist, an explicit id is required).
  pipelineId: number | null;
  // Operator-authored funnel guidance, appended to kanban_move_card's description. Mirrors
  // src/modules/kanban/settings.ts's KanbanConfig.instructions (same shape, own settings key so a
  // dual-channel agent can carry independent guidance per channel if ever needed).
  instructions: string | null;
}

export const ZPRO_CRM_DEFAULTS: ZproCrmConfig = {
  pipelineId: null,
  instructions: null,
};

function posInt(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

export function readZproCrmConfig(settings: unknown): ZproCrmConfig {
  const s =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>).zproCrm
      : undefined;
  if (!s || typeof s !== "object") return { ...ZPRO_CRM_DEFAULTS };
  const bag = s as Record<string, unknown>;
  return {
    pipelineId: posInt(bag.pipelineId),
    instructions: readToolInstructions(bag.instructions),
  };
}

export interface ZproPipeline {
  id: number;
  name: string;
}

export interface ZproStage {
  id: number;
  name: string;
}

// This conversation's linked CRM deal, resolved at turn prep (src/modules/zpro/tools.ts): the
// configured/auto-detected pipeline + its stages (for kanban_move_card's target-name matching), and
// OUR mirrored snapshot of the linked Opportunity (id/title/current stage — null when none linked
// yet; kanban_move_card / update_kanban_task create one lazily on first use).
export interface ZproKanbanContext {
  pipelineId: number | null;
  pipelineName: string | null;
  stages: ZproStage[];
  opportunityId: number | null;
  opportunityTitle: string | null;
  currentStageId: number | null;
  currentStageName: string | null;
}

// Accepts a bare array or a common wrapper key ({data:[]}/{payload:[]}/{rows:[]}) — see module header.
function unwrapZproList(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.payload)) return o.payload;
    if (Array.isArray(o.rows)) return o.rows;
  }
  return [];
}

function parseIdNamePairs(raw: unknown): { id: number; name: string }[] {
  const out: { id: number; name: string }[] = [];
  for (const item of unwrapZproList(raw)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = posInt(o.id);
    const name = typeof o.name === "string" ? o.name.trim() : "";
    if (id != null && name) out.push({ id, name });
  }
  return out;
}

// Pipelines/stages change rarely → cache per tenant+instance, mirrors chatwoot/kanban.ts's board-
// steps TTL cache. Tags churn more (operators add ad-hoc tags), but a 60s window is still a reasonable
// staleness bound for a model-facing "known values" hint (a miss still auto-creates, see native-tools).
const CRM_TTL_MS = 60_000;
const pipelinesCache = new Map<
  string,
  { value: ZproPipeline[]; expires: number }
>();
const stagesCache = new Map<string, { value: ZproStage[]; expires: number }>();
const tagsCache = new Map<string, { value: ZproPipeline[]; expires: number }>();

async function loadPipelines(
  client: ZproClient,
  cacheKey: string,
  now: number,
): Promise<ZproPipeline[]> {
  const hit = pipelinesCache.get(cacheKey);
  if (hit && hit.expires > now) return hit.value;
  const value = parseIdNamePairs(await client.listPipelines());
  pipelinesCache.set(cacheKey, { value, expires: now + CRM_TTL_MS });
  return value;
}

export async function loadZproStages(
  client: ZproClient,
  pipelineId: number,
  cacheKey: string,
  now: number = Date.now(),
): Promise<ZproStage[]> {
  const key = `${cacheKey}:${pipelineId}`;
  const hit = stagesCache.get(key);
  if (hit && hit.expires > now) return hit.value;
  const value = parseIdNamePairs(await client.listStages({ pipelineId }));
  stagesCache.set(key, { value, expires: now + CRM_TTL_MS });
  return value;
}

export async function loadZproTags(
  client: ZproClient,
  cacheKey: string,
  now: number = Date.now(),
): Promise<ZproPipeline[]> {
  const hit = tagsCache.get(cacheKey);
  if (hit && hit.expires > now) return hit.value;
  const value = parseIdNamePairs(await client.listTags(true));
  tagsCache.set(cacheKey, { value, expires: now + CRM_TTL_MS });
  return value;
}

// Queues (departments/attendants) change rarely — same TTL cache as pipelines/stages/tags.
// listQueues() has no captured real-payload sample either (same open-validation as the others in
// this file), so it goes through the same defensive parseIdNamePairs.
const queuesCache = new Map<
  string,
  { value: ZproPipeline[]; expires: number }
>();

export async function loadZproQueues(
  client: ZproClient,
  cacheKey: string,
  now: number = Date.now(),
): Promise<ZproPipeline[]> {
  const hit = queuesCache.get(cacheKey);
  if (hit && hit.expires > now) return hit.value;
  const value = parseIdNamePairs(await client.listQueues());
  queuesCache.set(cacheKey, { value, expires: now + CRM_TTL_MS });
  return value;
}

// Resolves which pipeline kanban_move_card/update_kanban_task operate on. An explicit configured id
// is trusted as-is (no live validation call — an invalid id surfaces as a tool-level error at
// createOpportunity/updateOpportunity time instead of paying an extra round trip on every turn).
// Otherwise auto-detects: the tenant's SOLE pipeline, or null when there are zero or 2+ (ambiguous —
// the tools then report "not configured", steering the operator to set agent.settings.zproCrm.pipelineId
// explicitly via PATCH /v1/agents/:id).
export async function resolveZproPipelineId(
  client: ZproClient,
  configuredPipelineId: number | null,
  cacheKey: string,
  now: number = Date.now(),
): Promise<ZproPipeline | null> {
  const pipelines = await loadPipelines(client, cacheKey, now);
  if (configuredPipelineId != null) {
    const match = pipelines.find((p) => p.id === configuredPipelineId);
    // Keep the configured id even if it wasn't found in the list (defensive: a listing failure or a
    // shape drift must not silently disable an explicitly-configured pipeline) — just without a name.
    return match ?? { id: configuredPipelineId, name: "" };
  }
  return pipelines.length === 1 ? (pipelines[0] ?? null) : null;
}

// Case-insensitive stage-name → stage match. Pure; null when nothing matches. Mirrors
// chatwoot/kanban.ts's matchKanbanStep.
export function matchZproStage(
  stages: ZproStage[],
  name: string,
): ZproStage | null {
  const lc = name.trim().toLowerCase();
  if (!lc) return null;
  return stages.find((s) => s.name.toLowerCase() === lc) ?? null;
}

// Resolves ONE piece of a queue/tag id+name pair the model can act on. queueId alone (from
// ZproConversation.queueId, mirror.ts) has no name attached — this cross-references the already-
// loaded catalog (loadZproQueues/loadZproTags). Pure; null when nothing matches.
export function resolveQueueName(
  queueId: number | null,
  knownQueues: ZproPipeline[],
): string | null {
  if (queueId == null) return null;
  return knownQueues.find((q) => q.id === queueId)?.name ?? null;
}

// mirror.ts's parseContactTags stores each tag as whichever half of {id,name} the webhook payload
// actually had (shape unconfirmed) — this fills in the missing half against the tags catalog when
// possible, and falls back to "tag #id" only when NEITHER the stored name nor a catalog match is
// available (never silently drops a tag the customer/operator can see in the Z-PRO panel).
export function resolveContactTagNames(
  refs: ZproContactTagRef[],
  knownTags: ZproPipeline[],
): string[] {
  return refs.map((ref) => {
    if (ref.name) return ref.name;
    if (ref.id != null) {
      const match = knownTags.find((t) => t.id === ref.id);
      if (match) return match.name;
      return `tag #${ref.id}`;
    }
    return "?";
  });
}

// Test-only: drop the module caches so cases don't leak TTL state into one another.
export function __resetZproCrmCaches(): void {
  pipelinesCache.clear();
  stagesCache.clear();
  tagsCache.clear();
  queuesCache.clear();
}
