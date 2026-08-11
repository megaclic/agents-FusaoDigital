import config from "@/config";
import { MCP_SCOPES } from "./tokens";

// OAuth discovery documents. RFC 8414 (authorization-server) is served at the ISSUER ROOT — MCP
// clients fetch /.well-known/oauth-authorization-server there, so it must return JSON (not the SPA
// catch-all). RFC 9728 (protected-resource) points the client at the authorization server. The
// advertised authorize/token endpoints are live (mcp-oauth.controller.ts); registration_endpoint
// is advertised unless DCR is closed (MCP_DCR_ENABLED=false). Dropping it is what makes Codex and
// Claude Code abort before the login screen, so keep it on for any deployment serving MCP clients.

function baseUrl(): string {
  return config.publicUrl.replace(/\/$/, "");
}

// The OAuth issuer (also the `iss` echoed on every authorization redirect, RFC 9207).
export function issuerUrl(): string {
  return baseUrl();
}

// The canonical resource identifier of our MCP server (RFC 8707 / RFC 9728 `resource`). Every access
// token we mint is bound to this `aud`, and verifyAccessToken enforces it; `/authorize` and `/token`
// reject a `resource` indicator that does not match it. Single source of truth, also reused by
// protectedResourceMetadata below.
export function mcpResourceId(): string {
  return `${baseUrl()}/api/v1/mcp`;
}

export function authServerMetadata() {
  const b = baseUrl();
  return {
    issuer: b,
    authorization_endpoint: `${b}/api/v1/mcp/oauth/authorize`,
    token_endpoint: `${b}/api/v1/mcp/oauth/token`,
    ...(config.mcpDcrEnabled
      ? { registration_endpoint: `${b}/api/v1/mcp/oauth/register` }
      : {}),
    scopes_supported: [...MCP_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // NOTE: we intentionally do NOT advertise `authorization_response_iss_parameter_supported`.
    // We still add `iss` to every authorization response (see authorizeRedirect), so RFC 9207 mix-up
    // defense holds for clients that validate a present `iss` against `issuer` above. Advertising the
    // flag makes rmcp-based clients (OpenAI Codex >= 0.143) set require_issuer=true, but Codex drops
    // the callback `iss` before validation and then rejects login as "missing required issuer"
    // (openai/codex#31573, modelcontextprotocol/rust-sdk#896). Since we always send `iss`, omitting
    // the advertisement costs us nothing and unblocks those clients; revert once Codex is fixed.
  };
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResourceId(),
    authorization_servers: [baseUrl()],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ["header"],
  };
}
