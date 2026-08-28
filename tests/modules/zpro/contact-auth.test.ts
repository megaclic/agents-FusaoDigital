import { describe, expect, test } from "bun:test";
import {
  CONTACT_AUTH_DEFAULTS,
  type ContactAuthConfig,
} from "@/modules/contact-auth/settings";
import type { InjectableCredential } from "@/modules/vault/injectable";
import { authorizeZproContact } from "@/modules/zpro/contact-auth";

// authorizeZproContact is the Z-PRO analog of contact-auth/service.ts's authorizeContact, minus the
// stored-grant (`mode: "once"`) reuse machinery — see the module header for why that half is
// deliberately not ported. What IS reused unmodified (checkContactAuthorization,
// classifyAuthorizationResponse, singleFlight) is already pinned by tests/modules/contact-auth-*;
// this file only pins the orchestration this module adds: identity resolution from a phone/
// identifier pair instead of a Contact row, and everything downstream of that.

function cfg(over: Partial<ContactAuthConfig> = {}): ContactAuthConfig {
  return {
    ...CONTACT_AUTH_DEFAULTS,
    enabled: true,
    url: "https://ops.example.com/authorize",
    ...over,
  };
}

const okFetch = (body: string, status = 200) =>
  (async () => new Response(body, { status })) as unknown as typeof fetch;

// Bypasses the real DNS/SSRF check so a fake hostname reaches fetchImpl instead of failing as
// invalid_url — same helper contact-auth-check.test.ts uses.
const okUrl = async (u: string) => new URL(u);

describe("authorizeZproContact", () => {
  test("no phone and no identifier → no_identity, never asks the endpoint", async () => {
    let asked = false;
    const result = await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: null,
      contactName: "Cliente",
      identifier: null,
      ticketId: 42,
      channelType: "whatsapp",
      messageText: null,
      requestKey: "inbox",
      cfg: cfg(),
      fetchImpl: (async () => {
        asked = true;
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({
      outcome: "no_identity",
      shared: false,
      reason: "no_identifiers",
    });
    expect(asked).toBe(false);
  });

  test("blank strings are treated as absent, same as null", async () => {
    const result = await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "   ",
      contactName: null,
      identifier: "  ",
      ticketId: 42,
      channelType: null,
      messageText: null,
      requestKey: "inbox",
      cfg: cfg(),
    });
    expect(result.outcome).toBe("no_identity");
  });

  test("phone alone is enough identity to ask", async () => {
    const result = await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "+5511988887777",
      contactName: "Cliente",
      identifier: null,
      ticketId: 42,
      channelType: "whatsapp",
      messageText: null,
      requestKey: "inbox",
      cfg: cfg(),
      assertSafe: okUrl,
      fetchImpl: okFetch('{"authorized":true}'),
    });
    expect(result).toEqual({ outcome: "allowed", status: 200, shared: false });
  });

  test("identifier alone (no phone) is enough identity to ask", async () => {
    const result = await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: null,
      contactName: null,
      identifier: "client-4821",
      ticketId: 42,
      channelType: null,
      messageText: null,
      requestKey: "inbox",
      cfg: cfg(),
      assertSafe: okUrl,
      fetchImpl: okFetch('{"authorized":true}'),
    });
    expect(result.outcome).toBe("allowed");
  });

  test("the request carries the identity under `contact`, never under `message`", async () => {
    let captured: {
      contact: unknown;
      conversation: unknown;
      message?: unknown;
    } | null = null;
    await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "+5511988887777",
      contactName: "Cliente Exemplo",
      identifier: "client-4821",
      ticketId: 987,
      channelType: "whatsapp",
      messageText: "oi",
      requestKey: "msg:1",
      cfg: cfg({ includeMessageText: true }),
      assertSafe: okUrl,
      fetchImpl: (async (_url: unknown, init: RequestInit | undefined) => {
        captured = JSON.parse(String(init?.body));
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(captured as unknown).toEqual({
      contact: {
        phone: "+5511988887777",
        name: "Cliente Exemplo",
        email: null,
        identifier: "client-4821",
        chatwootContactId: null,
      },
      conversation: { id: 987, inboxId: null, channel: "whatsapp" },
      message: { text: "oi" },
    });
  });

  test("401/403/404 → denied, without a body", async () => {
    const result = await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "+5511988887777",
      contactName: null,
      identifier: null,
      ticketId: 1,
      channelType: null,
      messageText: null,
      requestKey: "inbox",
      cfg: cfg(),
      assertSafe: okUrl,
      fetchImpl: (async () =>
        new Response(null, { status: 401 })) as unknown as typeof fetch,
    });
    expect(result).toEqual({ outcome: "denied", status: 401, shared: false });
  });

  test("no url configured → error, not_configured", async () => {
    const result = await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "+5511988887777",
      contactName: null,
      identifier: null,
      ticketId: 1,
      channelType: null,
      messageText: null,
      requestKey: "inbox",
      cfg: cfg({ url: null }),
    });
    expect(result).toEqual({
      outcome: "error",
      reason: "not_configured",
      shared: false,
    });
  });

  test("a credential resolution that hangs past timeoutMs → error, timeout (the gate's own budget, not the resolver's)", async () => {
    const started = Date.now();
    const result = await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "+5511988887777",
      contactName: null,
      identifier: null,
      ticketId: 1,
      channelType: null,
      messageText: null,
      requestKey: "inbox",
      cfg: cfg({ credentialRef: "vault:1", timeoutMs: 1000 }),
      // Never settles — the vault's own ceiling is far longer than the gate's, so without the
      // gate's deadline covering this step the call would hang well past 1000ms.
      resolveCredential: () => new Promise(() => {}),
    });
    expect(result).toEqual({
      outcome: "error",
      reason: "timeout",
      shared: false,
    });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test("a credential kind the vault marks as never-outbound → error, not sent as a Bearer fallback", async () => {
    let asked = false;
    const result = await authorizeZproContact({
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "+5511988887777",
      contactName: null,
      identifier: null,
      ticketId: 1,
      channelType: null,
      messageText: null,
      requestKey: "inbox",
      cfg: cfg({ credentialRef: "vault:1" }),
      resolveCredential: async () =>
        ({
          value: "super-secret-env-var",
          kind: "mcp_env",
          paramName: "API_TOKEN",
        }) satisfies InjectableCredential,
      fetchImpl: (async () => {
        asked = true;
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({
      outcome: "error",
      reason: "credential_not_injectable",
      shared: false,
    });
    expect(asked).toBe(false);
  });

  test("concurrent calls for the same identity+requestKey single-flight into one fetch", async () => {
    let fetchCount = 0;
    const params = {
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "+5511988887777",
      contactName: null,
      identifier: null,
      ticketId: 1,
      channelType: null,
      messageText: null,
      requestKey: "inbox",
      cfg: cfg(),
      assertSafe: okUrl,
      fetchImpl: (async () => {
        fetchCount += 1;
        await new Promise((r) => setTimeout(r, 20));
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch,
    } as const;
    const [a, b] = await Promise.all([
      authorizeZproContact(params),
      authorizeZproContact(params),
    ]);
    expect(fetchCount).toBe(1);
    expect([a.shared, b.shared].sort()).toEqual([false, true]);
    expect(a.outcome).toBe("allowed");
    expect(b.outcome).toBe("allowed");
  });

  test("a different requestKey never shares a flight with another (a nudge must not join an incoming message's ask)", async () => {
    let fetchCount = 0;
    const base = {
      tenantId: 1n,
      agentId: 1n,
      contactNumber: "+5511988887777",
      contactName: null,
      identifier: null,
      ticketId: 1,
      channelType: null,
      messageText: null,
      cfg: cfg(),
      assertSafe: okUrl,
      fetchImpl: (async () => {
        fetchCount += 1;
        return new Response('{"authorized":true}', { status: 200 });
      }) as unknown as typeof fetch,
    };
    await Promise.all([
      authorizeZproContact({ ...base, requestKey: "inbox" }),
      authorizeZproContact({ ...base, requestKey: "nudge" }),
    ]);
    expect(fetchCount).toBe(2);
  });
});
