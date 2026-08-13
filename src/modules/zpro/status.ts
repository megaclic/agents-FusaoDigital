import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { Serialized } from "@langchain/core/load/serializable";
import {
  type AgentActivityStage,
  broadcastZproAgentActivity,
} from "@/api/features/realtime/realtime.service";

// Z-PRO analogue of src/graph/status.ts's AgentStatusReporter — same LangChain callback handler
// contract, keyed on ZproConversation.id instead of Conversation.id (a DIFFERENT sequence, never
// conflate the two — see docs/zpro.md's LlmUsage.zproConversationId discipline). See that file's
// header comment for the full rationale (transient, metadata-only, non-throwing, fire-and-forget).

export interface ZproStatusTarget {
  tenantId: bigint;
  zproConversationId: bigint | null;
}

export class ZproAgentStatusReporter extends BaseCallbackHandler {
  name = "secv4-zpro-agent-status";

  private readonly tenantId: bigint;
  private readonly zproConversationId: bigint | null;

  constructor(target: ZproStatusTarget) {
    super();
    this.tenantId = target.tenantId;
    this.zproConversationId = target.zproConversationId;
  }

  private emit(
    phase: "started" | "step" | "finished",
    stage: AgentActivityStage | null,
    tool: string | null = null,
    extra?: { balloons?: number | null },
  ): void {
    if (this.zproConversationId == null) return;
    broadcastZproAgentActivity(this.tenantId, {
      conversationId: this.zproConversationId.toString(),
      phase,
      stage,
      tool,
      balloons: extra?.balloons ?? null,
    });
  }

  started(): void {
    this.emit("started", "thinking");
  }

  finished(balloons?: number | null): void {
    this.emit("finished", null, null, { balloons });
  }

  override handleChatModelStart(): void {
    this.emit("step", "thinking");
  }

  override handleLLMStart(): void {
    this.emit("step", "thinking");
  }

  override handleToolStart(
    _tool: Serialized,
    _input: string,
    _runId: string,
    _parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    runName?: string,
  ): void {
    this.emit("step", "tool", runName && runName.length > 0 ? runName : null);
  }
}
