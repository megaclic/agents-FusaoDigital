import { describe, expect, test } from "bun:test";
import { setupPrismaMock } from "@/tests/utils/prisma-mock";

// The knowledge controller builds its whole Elysia route graph at import time, which reaches the
// prisma singleton. Mock it so importing the module is side-effect-free.
setupPrismaMock();
const { readerSafeBlock, searchHitDto } = await import(
  "@/api/v1/knowledge.controller"
);

// The regression itself: ChunkHit carries id, knowledgeBaseId AND documentId as bigint, and a fix
// that stringifies only the first two still 500s on the third the moment a real hit comes back —
// `JSON.stringify` throws on ANY bigint anywhere in the tree, not just the ones a caller forgot.
describe("searchHitDto", () => {
  test("every bigint field is a string, and the rest of the hit survives untouched", () => {
    const hit = {
      id: 1n,
      knowledgeBaseId: 2n,
      knowledgeBaseName: "Remuneração",
      documentId: 3n,
      documentTitle: "Salário 2026 SP — Vigilante Líder",
      content: "Hora extra: R$ 23,46",
      metadata: { title: "x" },
      distance: 0.12,
    };
    const dto = searchHitDto(hit);
    expect(dto).toEqual({
      id: "1",
      knowledgeBaseId: "2",
      knowledgeBaseName: "Remuneração",
      documentId: "3",
      documentTitle: "Salário 2026 SP — Vigilante Líder",
      content: "Hora extra: R$ 23,46",
      metadata: { title: "x" },
      distance: 0.12,
    });
    // The actual failure mode: this must not throw.
    expect(() => JSON.stringify(dto)).not.toThrow();
  });
});

// Boundary projection for issue #80. The documents list is `requireAuth` (any role, AGENT included);
// the reindex endpoint that legitimately returns the credential ref for a fill deeplink is
// TENANT_ADMIN. The block object is the same on both, so the difference has to be enforced where it
// crosses.
describe("readerSafeBlock", () => {
  test("no block stays no block", () => {
    expect(readerSafeBlock(null)).toBeNull();
  });

  test("the reason survives", () => {
    expect(readerSafeBlock({ reason: "embedding_not_configured" })).toEqual({
      reason: "embedding_not_configured",
    });
  });

  // The finding itself: a pending or empty credential is exactly the case that carries the ref.
  test("the credential ref and its vault id never cross", () => {
    const out = readerSafeBlock({
      reason: "credential_pending",
      credentialRef: "vault:42",
      vaultId: "42",
    });
    expect(out).toEqual({ reason: "credential_pending" });
    expect(JSON.stringify(out)).not.toContain("42");
  });

  test("the same holds for an empty credential", () => {
    const out = readerSafeBlock({
      reason: "credential_empty",
      credentialRef: "vault:7",
      vaultId: "7",
    });
    expect(Object.keys(out ?? {})).toEqual(["reason"]);
  });
});
