// The Z-PRO / FusaoChatBot CRM panel hands operators the FULL API URL (origin +
// /v2/api/external/<apiId>), not the bare origin — every ZproClient call hardcodes that same
// /v2/api/external/<apiId> path (src/modules/zpro/client.ts). Parsing it here lets the "add
// instance" form auto-fill the ApiID from a single pasted URL instead of requiring the operator
// to split it into two fields by hand.
export function extractZproCredentialsFromUrl(
  raw: string,
): { baseUrl: string; apiId: string } | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const match = url.pathname.match(/\/v2\/api\/external\/([^/]+)/);
  if (!match) return null;
  const apiId = match[1];
  if (!apiId) return null;
  return { baseUrl: url.origin, apiId };
}
