// tests/modules/zpro/runtime-documents.test.ts
// deliverZproPendingDocument: Z-PRO's delivery half of the shared document tool
// (src/graph/tools/documents.ts queues on TurnState.pendingAttachments exactly like Chatwoot's, but
// this side sends via ZproClient.sendBase64 — no public URL to host the PDF behind, unlike
// send_image's sendMediaUrl). Covers the revocation recheck (DB-backed, real IssuedDocument rows —
// this is the one part of the port that is genuinely new rather than a copy of already-tested logic)
// and the send success/failure paths (no network: ZproClient duck-typed and cast, same convention as
// tests/modules/zpro/tts.test.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import type { FlowContext } from "@/modules/flowlog/service";
import type { ZproClient } from "@/modules/zpro/client";
import type { TurnState } from "@/modules/zpro/native-tools";
import { deliverZproPendingDocument } from "@/modules/zpro/runtime";

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;

function freshTurnState(): TurnState {
  return {
    resolveRequested: false,
    pendingAttachments: [],
    documentsInFlight: 0,
    imagesInFlight: 0,
    attachmentsSeq: 0,
  };
}

const flow: FlowContext = {
  tenantId: 0n,
  turnId: "t1",
  source: "inbox",
  threadId: "zpro:0:1:1",
  base: appDb,
};

describe.skipIf(!dbUp)("deliverZproPendingDocument", () => {
  beforeAll(async () => {
    const t = await suDb.tenant.create({
      data: {
        name: "ZproDocDelivery",
        slug: `zpro-doc-delivery-${process.pid}`,
      },
    });
    tenantId = t.id;
    flow.tenantId = tenantId;
  });

  afterAll(async () => {
    if (tenantId) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM issued_documents WHERE tenant_id = ${tenantId}`,
      );
      await suDb.tenant.delete({ where: { id: tenantId } });
    }
    await su?.$disconnect();
    await app?.$disconnect();
  });

  test("nothing queued: no-op, no client call", async () => {
    const calls: unknown[] = [];
    const client = {
      sendBase64: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    } as unknown as ZproClient;
    const turnState = freshTurnState();

    const result = await deliverZproPendingDocument(
      client,
      "5511999999999",
      turnState,
      flow,
      { tenantId, base: appDb },
    );
    expect(result).toEqual({ sent: false, failed: false });
    expect(calls).toHaveLength(0);
  });

  test("a queued document with no documentId (unbound, e.g. a proactive nudge) sends unconditionally", async () => {
    const calls: unknown[] = [];
    const client = {
      sendBase64: async (
        number: string,
        base64Data: string,
        mimeType: string,
        fileName: string,
        body?: string,
      ) => {
        calls.push([number, base64Data, mimeType, fileName, body]);
        return {};
      },
    } as unknown as ZproClient;
    const turnState = freshTurnState();
    turnState.pendingAttachments.push({
      bytes: new TextEncoder().encode("pdf-bytes").buffer,
      mime: "application/pdf",
      fileName: "orcamento.pdf",
      order: 0,
      tool: "send_orcamento",
      kind: "document",
    });

    const result = await deliverZproPendingDocument(
      client,
      "5511999999999",
      turnState,
      flow,
      { tenantId, base: appDb },
    );
    expect(result).toEqual({ sent: true, failed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual([
      "5511999999999",
      Buffer.from("pdf-bytes").toString("base64"),
      "application/pdf",
      "orcamento.pdf",
      undefined,
    ]);
    // The queue is drained regardless of outcome — a second delivery call must not resend.
    expect(turnState.pendingAttachments).toHaveLength(0);
  });

  test("a revoked document is skipped: not sent, not failed, no client call", async () => {
    const doc = await suDb.issuedDocument.create({
      data: {
        tenantId,
        title: "Orçamento",
        idempotencyKey: `test-revoked-${Date.now()}`,
        revoked: true,
      },
    });
    const calls: unknown[] = [];
    const client = {
      sendBase64: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    } as unknown as ZproClient;
    const turnState = freshTurnState();
    turnState.pendingAttachments.push({
      bytes: new ArrayBuffer(4),
      mime: "application/pdf",
      fileName: "revoked.pdf",
      order: 0,
      tool: "send_orcamento",
      kind: "document",
      documentId: doc.id,
    });

    const result = await deliverZproPendingDocument(
      client,
      "5511999999999",
      turnState,
      flow,
      { tenantId, base: appDb },
    );
    expect(result).toEqual({ sent: false, failed: false });
    expect(calls).toHaveLength(0);
  });

  test("a live (not revoked) document with a documentId is sent", async () => {
    const doc = await suDb.issuedDocument.create({
      data: {
        tenantId,
        title: "Orçamento",
        idempotencyKey: `test-live-${Date.now()}`,
        revoked: false,
      },
    });
    const calls: unknown[] = [];
    const client = {
      sendBase64: async (...args: unknown[]) => {
        calls.push(args);
        return {};
      },
    } as unknown as ZproClient;
    const turnState = freshTurnState();
    turnState.pendingAttachments.push({
      bytes: new ArrayBuffer(4),
      mime: "application/pdf",
      fileName: "live.pdf",
      order: 0,
      tool: "send_orcamento",
      kind: "document",
      documentId: doc.id,
    });

    const result = await deliverZproPendingDocument(
      client,
      "5511999999999",
      turnState,
      flow,
      { tenantId, base: appDb },
    );
    expect(result).toEqual({ sent: true, failed: false });
    expect(calls).toHaveLength(1);
  });

  test("a client send failure is reported as failed, not thrown", async () => {
    const client = {
      sendBase64: async () => {
        throw new Error("network blip");
      },
    } as unknown as ZproClient;
    const turnState = freshTurnState();
    turnState.pendingAttachments.push({
      bytes: new ArrayBuffer(4),
      mime: "application/pdf",
      fileName: "boom.pdf",
      order: 0,
      tool: "send_orcamento",
      kind: "document",
    });

    const result = await deliverZproPendingDocument(
      client,
      "5511999999999",
      turnState,
      flow,
      { tenantId, base: appDb },
    );
    expect(result).toEqual({ sent: false, failed: true });
  });
});
