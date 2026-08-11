// NOTE: Dynamic Client Registration (RFC 7591) helpers. DCR is OPEN by default (close it with
// MCP_DCR_ENABLED=false); a redirect_uri must still pass a strict allowlist: an EXACT https URL
// (no wildcard, no fragment), or an http loopback for native/dev clients (RFC 8252). /authorize
// later matches the registered URI exactly, so a permissive value here would be an open-redirect
// vector.

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

// Returns null when every URI is acceptable, or a human-readable reason for the first bad one.
export function validateRedirectUris(uris: string[]): string | null {
  if (!uris.length) return "at least one redirect_uri is required";
  for (const raw of uris) {
    if (raw.includes("*")) {
      return `redirect_uri must not contain a wildcard: ${raw}`;
    }
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return `invalid redirect_uri: ${raw}`;
    }
    if (url.hash) return `redirect_uri must not contain a fragment: ${raw}`;
    const loopback = LOOPBACK_HOSTS.has(url.hostname);
    if (url.protocol === "https:") continue;
    if (url.protocol === "http:" && loopback) continue;
    return `redirect_uri must be https (http allowed only for loopback): ${raw}`;
  }
  return null;
}
