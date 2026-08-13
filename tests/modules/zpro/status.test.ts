import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { Serialized } from "@langchain/core/load/serializable";
import { setPublisher, TOPICS } from "@/api/features/realtime/realtime.service";
import { ZproAgentStatusReporter } from "@/modules/zpro/status";

// Z-PRO analog of tests/graph/status.test.ts — same reporter contract, keyed on
// ZproConversation.id instead of Conversation.id.

interface PublishCall {
  topic: string;
  data: string;
}

function newRecorder() {
  const calls: PublishCall[] = [];
  const fn = mock((topic: string, data: string) => {
    calls.push({ topic, data });
  });
  return { fn, calls };
}

const TOOL = {} as Serialized;

describe("ZproAgentStatusReporter", () => {
  let recorder: ReturnType<typeof newRecorder>;

  beforeEach(() => {
    recorder = newRecorder();
    setPublisher(recorder.fn);
  });

  afterEach(() => {
    setPublisher(() => undefined);
  });

  function decoded() {
    return recorder.calls.map((c) => ({
      topic: c.topic,
      event: JSON.parse(c.data),
    }));
  }

  test("started/finished envelope rides the per-tenant topic with the ZproConversation row id", () => {
    const r = new ZproAgentStatusReporter({
      tenantId: BigInt(7),
      zproConversationId: BigInt(42),
    });
    r.started();
    r.finished();

    const out = decoded();
    expect(out).toHaveLength(2);
    expect(out[0]?.topic).toBe(TOPICS.tenant(BigInt(7)));
    expect(out[0]?.event).toMatchObject({
      type: "zpro-agent-activity",
      tenantId: "7",
      conversationId: "42",
      phase: "started",
      stage: "thinking",
      tool: null,
    });
    expect(out[1]?.event).toMatchObject({
      phase: "finished",
      stage: null,
      tool: null,
    });
  });

  test("finished carries the balloons count (multi-balloon split delivery)", () => {
    const r = new ZproAgentStatusReporter({
      tenantId: BigInt(1),
      zproConversationId: BigInt(9),
    });
    r.finished(3);

    expect(decoded()[0]?.event).toMatchObject({
      phase: "finished",
      balloons: 3,
    });
  });

  test("model start → thinking step", () => {
    const r = new ZproAgentStatusReporter({
      tenantId: BigInt(1),
      zproConversationId: BigInt(9),
    });
    r.handleChatModelStart();
    r.handleLLMStart();

    const out = decoded();
    expect(out).toHaveLength(2);
    for (const o of out) {
      expect(o.event).toMatchObject({ phase: "step", stage: "thinking" });
    }
  });

  test("tool start → tool step carrying the tool's runName", () => {
    const r = new ZproAgentStatusReporter({
      tenantId: BigInt(1),
      zproConversationId: BigInt(9),
    });
    r.handleToolStart(
      TOOL,
      "input",
      "run-1",
      undefined,
      undefined,
      undefined,
      "kanban_move_card",
    );

    const out = decoded();
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toMatchObject({
      phase: "step",
      stage: "tool",
      tool: "kanban_move_card",
    });
  });

  test("tool start without a runName falls back to a generic (null) tool", () => {
    const r = new ZproAgentStatusReporter({
      tenantId: BigInt(1),
      zproConversationId: BigInt(9),
    });
    r.handleToolStart(TOOL, "input", "run-2");

    expect(decoded()[0]?.event).toMatchObject({
      phase: "step",
      stage: "tool",
      tool: null,
    });
  });

  test("no mirror row id → the reporter is a no-op (nothing to key the UI on)", () => {
    const r = new ZproAgentStatusReporter({
      tenantId: BigInt(1),
      zproConversationId: null,
    });
    r.started();
    r.handleChatModelStart();
    r.handleToolStart(
      TOOL,
      "input",
      "run-3",
      undefined,
      undefined,
      undefined,
      "handoff_to_human",
    );
    r.finished();

    expect(recorder.calls).toHaveLength(0);
  });
});
