// tests/modules/zpro/parse.test.ts
// Pure unit tests for resolveZproInstanceCandidate — the disambiguation guard added after finding
// that whatsappId is unique only PER TENANT (@@unique([tenantId, whatsappId])): two independent
// Z-PRO installs across different tenants can report the same whatsappId, and picking the wrong
// candidate would silently mirror one tenant's conversations into another's.

import { describe, expect, test } from "bun:test";
import { resolveZproInstanceCandidate } from "@/modules/zpro/parse";

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
