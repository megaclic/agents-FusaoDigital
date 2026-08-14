// tests/modules/zpro/parse.test.ts
// Pure unit tests for resolveZproInstanceCandidate — the disambiguation guard added after finding
// that whatsappId is unique only PER TENANT (@@unique([tenantId, whatsappId])): two independent
// Z-PRO installs across different tenants can report the same whatsappId, and picking the wrong
// candidate would silently mirror one tenant's conversations into another's.

import { describe, expect, test } from "bun:test";
import {
  parseContactTags,
  resolveZproInstanceCandidate,
} from "@/modules/zpro/parse";

interface Candidate {
  id: number;
  apiId: string;
}

describe("resolveZproInstanceCandidate", () => {
  test("zero candidates → null", () => {
    expect(resolveZproInstanceCandidate<Candidate>([], undefined)).toBeNull();
  });

  test("a single candidate is returned as-is, even without an apikey (the common case)", () => {
    const only = { id: 1, apiId: "abc" };
    expect(resolveZproInstanceCandidate([only], undefined)).toBe(only);
  });

  test("multiple candidates + no apikey → null (never guess)", () => {
    const candidates = [
      { id: 1, apiId: "abc" },
      { id: 2, apiId: "def" },
    ];
    expect(resolveZproInstanceCandidate(candidates, undefined)).toBeNull();
  });

  test("multiple candidates + apikey matching exactly one apiId → that candidate", () => {
    const match = { id: 2, apiId: "def" };
    const candidates = [{ id: 1, apiId: "abc" }, match];
    expect(resolveZproInstanceCandidate(candidates, "def")).toBe(match);
  });

  test("multiple candidates + apikey matching NONE → null (never guess)", () => {
    const candidates = [
      { id: 1, apiId: "abc" },
      { id: 2, apiId: "def" },
    ];
    expect(resolveZproInstanceCandidate(candidates, "ghi")).toBeNull();
  });

  test("multiple candidates + apikey matching MORE than one (duplicate apiId) → null (never guess)", () => {
    const candidates = [
      { id: 1, apiId: "abc" },
      { id: 2, apiId: "abc" },
    ];
    expect(resolveZproInstanceCandidate(candidates, "abc")).toBeNull();
  });
});

// contact.tags's shape is unconfirmed (no example response in the vendor's Postman collection) —
// parseContactTags must tolerate every plausible shape without throwing, per mirror.ts's use of it
// on every inbound webhook.
describe("parseContactTags", () => {
  test("not an array → []", () => {
    expect(parseContactTags(undefined)).toEqual([]);
    expect(parseContactTags(null)).toEqual([]);
    expect(parseContactTags("vip")).toEqual([]);
    expect(parseContactTags({ id: 1, name: "vip" })).toEqual([]);
  });

  test("array of {id,name} objects", () => {
    expect(
      parseContactTags([
        { id: 1, name: "vip" },
        { id: 2, name: "lead" },
      ]),
    ).toEqual([
      { id: 1, name: "vip" },
      { id: 2, name: "lead" },
    ]);
  });

  test("array of bare positive integer ids → name null", () => {
    expect(parseContactTags([1, 2])).toEqual([
      { id: 1, name: null },
      { id: 2, name: null },
    ]);
  });

  test("array of bare non-empty strings → id null", () => {
    expect(parseContactTags(["vip", "lead"])).toEqual([
      { id: null, name: "vip" },
      { id: null, name: "lead" },
    ]);
  });

  test("drops entries with neither a usable id nor name, never throws", () => {
    expect(
      parseContactTags([
        { id: 1, name: "vip" },
        { foo: "bar" },
        0,
        -1,
        "",
        "  ",
        null,
        undefined,
        true,
      ]),
    ).toEqual([{ id: 1, name: "vip" }]);
  });

  test("trims whitespace on string names", () => {
    expect(parseContactTags(["  vip  "])).toEqual([{ id: null, name: "vip" }]);
    expect(parseContactTags([{ id: 1, name: "  vip  " }])).toEqual([
      { id: 1, name: "vip" },
    ]);
  });

  test("mixed shapes in the same array", () => {
    expect(parseContactTags([1, "vip", { id: 2, name: "lead" }])).toEqual([
      { id: 1, name: null },
      { id: null, name: "vip" },
      { id: 2, name: "lead" },
    ]);
  });
});
