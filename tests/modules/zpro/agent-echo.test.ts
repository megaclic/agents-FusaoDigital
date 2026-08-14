// tests/modules/zpro/agent-echo.test.ts
// Pure unit tests for markAgentSending/wasAgentSending — including the globalThis-singleton
// storage itself, which is what makes the pending marker survive a `bun --hot` module reload
// (a real incident: a hot-reload mid-window wiped a plain module-level Map, the agent's own reply
// echo got misclassified as human intervention, and the auto-handoff handler deactivated the
// agent). A test that only exercises the two functions wouldn't catch a regression back to a
// plain `const _pending = new Map()` — it would still pass. Asserting the globalThis key directly
// is what pins the fix.

import { describe, expect, test } from "bun:test";
import { markAgentSending, wasAgentSending } from "@/modules/zpro/agent-echo";

describe("agent-echo", () => {
  test("wasAgentSending is false for a never-marked ticket", () => {
    expect(wasAgentSending(999_001n, 1)).toBe(false);
  });

  test("markAgentSending then wasAgentSending on the SAME instance+ticket → true", () => {
    markAgentSending(999_002n, 42);
    expect(wasAgentSending(999_002n, 42)).toBe(true);
  });

  test("a different ticket or instance is NOT marked (keyed by both)", () => {
    markAgentSending(999_003n, 1);
    expect(wasAgentSending(999_003n, 2)).toBe(false);
    expect(wasAgentSending(999_004n, 1)).toBe(false);
  });

  test("the marker does not get consumed by a read (multi-balloon echoes)", () => {
    markAgentSending(999_005n, 7);
    expect(wasAgentSending(999_005n, 7)).toBe(true);
    expect(wasAgentSending(999_005n, 7)).toBe(true);
  });

  test("re-marking the same ticket resets the timer without throwing", () => {
    markAgentSending(999_006n, 3);
    markAgentSending(999_006n, 3);
    expect(wasAgentSending(999_006n, 3)).toBe(true);
  });

  test("the pending map is stored on globalThis (survives a bun --hot module reload)", () => {
    markAgentSending(999_007n, 5);
    const g = globalThis as unknown as Record<symbol, Map<string, unknown>>;
    const holder = g[Symbol.for("secv4.zpro.agent-echo.pending")];
    expect(holder).toBeInstanceOf(Map);
    expect(holder?.has("999007:5")).toBe(true);
  });
});
