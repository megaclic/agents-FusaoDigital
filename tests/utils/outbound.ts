// Fixture host for every URL that flows through `assertSafeOutboundUrl`.
//
// NOTE: that guard resolves hostnames through `node:dns` before allowing the target, so a fixture
// URL on a real hostname (example.com, discord.com) turns a DATABASE test into one that also needs
// working DNS. It fails offline, behind a restrictive resolver, or on a CI runner without egress —
// intermittently and with a failure that reads like a logic bug. An IP literal takes the `isIP()`
// branch instead: the guard's blocked-range check still runs in full, minus the network call.
//
// 203.0.113.0/24 is TEST-NET-3 (RFC 5737), reserved for documentation and never routed, so it is
// unambiguously a fixture and is not in any of the guard's blocked ranges.
const TEST_NET_3 = "203.0.113";

export function outboundUrl(path = "/", host = 10): string {
  return `https://${TEST_NET_3}.${host}${path.startsWith("/") ? path : `/${path}`}`;
}
