import { describe, expect, test } from "bun:test";
import { isServerNavigation } from "@/client/pages/LoginPage";

// NOTE: After login, a destination handled by the SERVER (the MCP OAuth authorize endpoint, where the MCP
// client's browser flow resumes) needs a real browser navigation; a SPA route goes through
// react-router. Getting this backwards either dead-ends the OAuth flow on an empty SPA path or
// full-reloads the app on every ordinary login. The allowlist is deliberately one exact path: a
// broad "/api/" prefix would let a crafted ?redirect= aim the post-login navigation at any endpoint.
describe("isServerNavigation", () => {
  test("the MCP authorize path, bare and with a query", () => {
    expect(isServerNavigation("/api/v1/mcp/oauth/authorize")).toBe(true);
    expect(
      isServerNavigation("/api/v1/mcp/oauth/authorize?client_id=abc&state=s"),
    ).toBe(true);
  });

  test("SPA routes stay with react-router", () => {
    expect(isServerNavigation("/")).toBe(false);
    expect(isServerNavigation("/conversations")).toBe(false);
    expect(isServerNavigation("/oauth/consent?req=123")).toBe(false);
  });

  test("no other API path is a browser-navigation target", () => {
    expect(isServerNavigation("/api/v1/agents")).toBe(false);
    expect(isServerNavigation("/api/v1/mcp/oauth/token")).toBe(false);
    // NOTE: Prefix lookalikes must not slip through the startsWith check.
    expect(isServerNavigation("/api/v1/mcp/oauth/authorized")).toBe(false);
    expect(isServerNavigation("/api/v1/mcp/oauth/authorize-evil?x=1")).toBe(
      false,
    );
  });
});
