import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import config from "@/config";
import {
  fetchAnnouncements,
  fetchLatestVersion,
} from "@/modules/updates/hubClient";
import { getUpdates, resetUpdatesCache } from "@/modules/updates/service";

const realFetch = globalThis.fetch;
// This fork disables hub communication by default (config.hub.url = "", see config.ts) — getUpdates
// short-circuits to an empty payload with no fetch at all before that is set. Every test here
// exercises the fetch path, so the suite opts back in for its own duration.
const realHubUrl = config.hub.url;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Install a fetch stub that routes by URL. Returns the call counter so tests can assert dedupe.
function stubFetch(route: (url: string) => Response | Promise<Response>): {
  calls: () => number;
} {
  let calls = 0;
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    calls++;
    return route(String(input));
  }) as unknown as typeof fetch;
  return { calls: () => calls };
}

beforeEach(() => {
  config.hub.url = "https://hub.example.test";
  resetUpdatesCache();
});

afterEach(() => {
  config.hub.url = realHubUrl;
  globalThis.fetch = realFetch;
  resetUpdatesCache();
});

const VALID = {
  id: "1",
  level: "INFO",
  dismissible: true,
  content: { en: { body: "hello" } },
  cta: null,
};

describe("fetchAnnouncements validation", () => {
  test("drops entries that would break the console, keeps well-formed ones", async () => {
    stubFetch(() =>
      jsonResponse({
        announcements: [
          VALID,
          { level: "INFO", content: { en: { body: "no id" } } }, // missing id
          { id: "2", level: "LOUD", content: { en: { body: "x" } } }, // unknown level
          { id: "3", level: "INFO", content: { "pt-BR": { body: "oi" } } }, // no en fallback
        ],
      }),
    );

    const res = await fetchAnnouncements("https://hub.test", {
      edition: "pro",
      version: "1.0.0",
    });

    expect(res).toEqual([
      {
        id: "1",
        level: "INFO",
        dismissible: true,
        content: { en: { body: "hello" } },
        cta: null,
      },
    ]);
  });

  test("null (unreachable hub) is distinct from empty (reachable, nothing active)", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    expect(
      await fetchAnnouncements("https://hub.test", {
        edition: "free",
        version: "1.0.0",
      }),
    ).toBeNull();

    stubFetch(() => jsonResponse({ announcements: [] }));
    expect(
      await fetchAnnouncements("https://hub.test", {
        edition: "free",
        version: "1.0.0",
      }),
    ).toEqual([]);
  });
});

describe("fetchLatestVersion validation", () => {
  test("coerces non-string latestVersion/releaseUrl to null (fail-open)", async () => {
    stubFetch(() =>
      jsonResponse({ latestVersion: 123, releaseUrl: { u: "x" } }),
    );
    expect(
      await fetchLatestVersion("https://hub.test/api/latest-version", {
        edition: "pro",
      }),
    ).toEqual({ latestVersion: null, releaseUrl: null });

    stubFetch(() =>
      jsonResponse({
        latestVersion: "1.4.0",
        releaseUrl: "https://x/releases/1.4.0",
      }),
    );
    expect(
      await fetchLatestVersion("https://hub.test/api/latest-version", {
        edition: "pro",
      }),
    ).toEqual({
      latestVersion: "1.4.0",
      releaseUrl: "https://x/releases/1.4.0",
    });
  });

  test("null (unreachable) stays null", async () => {
    stubFetch(() => new Response("", { status: 500 }));
    expect(
      await fetchLatestVersion("https://hub.test/api/latest-version", {
        edition: "free",
      }),
    ).toBeNull();
  });
});

describe("getUpdates fail-open per half", () => {
  test("a failing latest-version fetch does not blank out healthy announcements", async () => {
    stubFetch((url) => {
      if (url.includes("/api/announcements")) {
        return jsonResponse({ announcements: [VALID] });
      }
      return new Response("", { status: 503 }); // latest-version down
    });

    const payload = await getUpdates();

    expect(payload.announcements).toHaveLength(1);
    expect(payload.announcements[0]?.id).toBe("1");
    // The failed half degrades on its own: no update surfaced, but the healthy half still served.
    expect(payload.update.available).toBe(false);
    expect(payload.update.latestVersion).toBeNull();
  });
});

describe("getUpdates single-flight", () => {
  test("concurrent callers after expiry share one hub round-trip", async () => {
    const { calls } = stubFetch((url) => {
      if (url.includes("/api/announcements")) {
        return jsonResponse({ announcements: [] });
      }
      return jsonResponse({ latestVersion: null, releaseUrl: null });
    });

    await Promise.all([getUpdates(), getUpdates(), getUpdates()]);

    // One announcements + one latest-version call, shared by all three callers (not 6).
    expect(calls()).toBe(2);
  });
});
