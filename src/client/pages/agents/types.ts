import type { api } from "@/client/lib/api";

// Eden-derived tool-selection view for the agent editor (the dynamic
// /agents/:id/tool-selections route).
type ToolSelectionResp = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.agents>["tool-selections"]["get"]>
>;
export type ToolSelectionView = NonNullable<ToolSelectionResp["data"]>;
export type ToolCatalog = ToolSelectionView["catalog"];

// Mutable working copy of a grant (the GET view returns readonly arrays). Shape
// matches the PUT body (ToolGrantInput); omitted fields default server-side.
export interface GrantState {
  source: "NATIVE" | "RAG" | "HTTP" | "MCP" | "INTEGRATION";
  toolDefinitionId?: string | null;
  mcpServerConnectionId?: string | null;
  integrationInstanceId?: string | null;
  knowledgeBaseIds?: string[];
  enabledTools?: string[];
}

// Derived from the vault treaty response; never hand-mirrored (see docs/eden-treaty.md).
export type VaultEntry = NonNullable<
  Awaited<ReturnType<typeof api.api.v1.vault.get>>["data"]
>["entries"][number];

// Eden-derived business-hours entry for the agent editor.
type HoursData = Awaited<
  ReturnType<(typeof api.api.v1)["business-hours"]["get"]>
>["data"];
export type Hours = NonNullable<HoursData>["businessHours"][number];

// Eden-derived: which transport(s) the edited agent is actually bound to. An Agent row has no
// channel discriminator of its own — used to hide/disable Behavior/Tools/Playground controls that
// have no effect on a Z-PRO-only agent (see docs/zpro.md).
export type ChannelBinding = NonNullable<
  Awaited<
    ReturnType<ReturnType<typeof api.api.v1.agents>["channel-binding"]["get"]>
  >["data"]
>;

// UI-side handoff config (the editor's working copy). `target` encodes the pinned pick as
// "agent:<id>" | "team:<id>" | "" so one <Select> offers both groups; AgentEditorPage splits it
// back into targetAgentId/targetTeamId on save. Lives on the handoff_to_human tool (Tools tab).
export interface HandoffUiState {
  mode: string;
  target: string;
  // The ChatwootInstance id (number) the pinned target was picked from; null unless pinned.
  targetInstanceId: number | null;
  // Z-PRO's own pinned target: a queue (department) id. Independent of target/targetInstanceId
  // (Chatwoot-only) — a dual-bound agent can carry both at once, applied per-channel at runtime.
  targetQueueId: number | null;
  // Operator-authored transfer guidance, appended to the handoff_to_human tool description.
  // Persisted in agent.settings.handoff.instructions.
  instructions: string;
}
