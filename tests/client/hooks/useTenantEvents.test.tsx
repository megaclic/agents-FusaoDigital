import { describe, expect, mock, test } from "bun:test";
import { dispatchTenantEvent } from "@/client/hooks/useTenantEvents";

// Regression test for the realtime dispatch bug: `zpro-message` and
// `zpro-agent-toggled` frames arrived over the WebSocket but the hook's
// dispatch switch had no branch for them, so `onZproMessage`/
// `onZproAgentToggled` were declared in the options type yet never invoked
// (see src/client/hooks/useTenantEvents.ts). This locks in the fix and
// guards the pre-existing branches against the same class of regression.
//
// Tested via the extracted pure `dispatchTenantEvent` function rather than
// rendering the hook: no WebSocket/auth/api mocking needed, and mocking
// `@/client/lib/api` at the module level would leak across test files in the
// same run (bun:test's `mock.module` is process-global, not per-file).

describe("dispatchTenantEvent", () => {
  test("dispatches zpro-message to onZproMessage", () => {
    const onZproMessage = mock();
    dispatchTenantEvent(
      {
        type: "zpro-message",
        at: Date.now(),
        tenantId: "11",
        conversationId: "42",
        ticketId: 7,
        senderType: "CLIENT",
      },
      { onZproMessage },
    );
    expect(onZproMessage).toHaveBeenCalledWith({
      conversationId: "42",
      ticketId: 7,
      senderType: "CLIENT",
    });
  });

  test("dispatches zpro-agent-toggled to onZproAgentToggled", () => {
    const onZproAgentToggled = mock();
    dispatchTenantEvent(
      {
        type: "zpro-agent-toggled",
        at: Date.now(),
        tenantId: "11",
        conversationId: "42",
        ticketId: 7,
        agentActive: false,
      },
      { onZproAgentToggled },
    );
    expect(onZproAgentToggled).toHaveBeenCalledWith({
      conversationId: "42",
      ticketId: 7,
      agentActive: false,
    });
  });

  test("dispatches zpro-agent-activity to onZproAgentActivity", () => {
    const onZproAgentActivity = mock();
    dispatchTenantEvent(
      {
        type: "zpro-agent-activity",
        at: Date.now(),
        tenantId: "11",
        conversationId: "42",
        phase: "step",
        stage: "tool",
        tool: "handoff_to_human",
        runAt: null,
        balloons: null,
      },
      { onZproAgentActivity },
    );
    expect(onZproAgentActivity).toHaveBeenCalledWith({
      conversationId: "42",
      phase: "step",
      stage: "tool",
      tool: "handoff_to_human",
      runAt: null,
      balloons: null,
    });
  });

  test("still dispatches conversation events (no regression on existing branches)", () => {
    const onConversation = mock();
    dispatchTenantEvent(
      {
        type: "conversation",
        at: Date.now(),
        tenantId: "11",
        conversationId: "1",
        status: "open",
        assigneeId: null,
        assigneeType: null,
        lastEventAt: null,
      },
      { onConversation },
    );
    expect(onConversation).toHaveBeenCalledWith({
      conversationId: "1",
      status: "open",
      assigneeId: null,
      assigneeType: null,
      lastEventAt: null,
    });
  });

  test("a handler that wasn't passed is simply not called (no throw)", () => {
    expect(() =>
      dispatchTenantEvent(
        {
          type: "zpro-message",
          at: Date.now(),
          tenantId: "11",
          conversationId: "42",
          ticketId: 7,
          senderType: "AGENT",
        },
        {},
      ),
    ).not.toThrow();
  });
});
