// src/modules/zpro/vision.ts
// Vision (extração de imagem/documento) para o canal Z-PRO — espelha o padrão eager de
// src/modules/vision/service.ts (Chatwoot, o agente "vê" a mídia antes de responder), com as
// mesmas duas diferenças estruturais que stt.ts já estabeleceu: (1) o download é a URL crua da
// mídia do WhatsApp já presente no payload do webhook (não um attachment autenticado via
// ChatwootClient) — passa por assertSafeOutboundUrl (anti-SSRF); (2) não há write-back pro
// Chatwoot — o texto extraído é escrito direto no ZproMessage.body já criado pelo mirror, que é a
// fonte de verdade da UI do inbox Z-PRO (ver docs/zpro.md). agent.settings.vision é lido pelo mesmo
// readVisionConfig genérico do Chatwoot — a config não é por canal.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn } from "@/lib/tenancy";
import { emitFlowEvent, type FlowContext } from "@/modules/flowlog/service";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import { visionAcceptsDocuments } from "@/modules/vision/document-support";
import {
  getVisionProvider,
  type VisionKind,
  type VisionResult,
  visionKindForMime,
} from "@/modules/vision/providers";
import { extractWithRetry } from "@/modules/vision/service";
import { readVisionConfig, type VisionConfig } from "@/modules/vision/settings";
import { sysCtx } from "./ctx";
import { decryptWhatsappMedia, type WhatsappMediaType } from "./media-crypto";

// Resolves the vision config for the agent bound to this Z-PRO instance (scoped read, no network).
// null when unbound, disabled, or vision off — the caller then leaves the media undescribed.
export async function resolveZproVisionConfig(
  tenantId: bigint,
  zproInstanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<VisionConfig | null> {
  const cfg = await runScopedOn(base, sysCtx(tenantId), async (db) => {
    const binding = await db.zproAgentBinding.findFirst({
      where: { tenantId, zproInstanceId },
      select: { agentId: true },
    });
    if (!binding) return null;
    const agent = await db.agent.findUnique({
      where: { id: binding.agentId },
      select: { enabled: true, settings: true },
    });
    if (!agent?.enabled) return null;
    return readVisionConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

export interface ExtractZproFileParams {
  tenantId: bigint;
  mediaUrl: string;
  mediaMimetype: string | null;
  cfg: VisionConfig;
  base?: PrismaClient;
  deps?: {
    fetchImpl?: typeof fetch;
    // Injectable so the retry battery does not actually wait out the backoff in tests.
    sleep?: (ms: number) => Promise<void>;
  };
  // Optional execution-flow context: when present, the extraction is logged as a `vision` stage
  // (visible in /logs), same contract as the Chatwoot path.
  flow?: FlowContext;
  // base64 WhatsApp media key + the ORIGINAL WhatsApp message type (parse.ts's extractMedia) — the
  // downloaded blob is WhatsApp's own end-to-end-encrypted CDN link, not the plain file (see
  // media-crypto.ts). `mediaType` must be the WhatsApp message type (image/document), not the
  // vision `kind` computed below from the mimetype — those can disagree (e.g. an image sent "as
  // document" is still HKDF-keyed as "WhatsApp Document Keys"). Optional and defensive: a payload
  // that somehow lacks either falls back to the pre-decryption behavior.
  mediaKey?: string;
  mediaType?: WhatsappMediaType;
}

export interface ExtractZproFileResult {
  kind: VisionKind;
  text: string;
}

// Downloads (anti-SSRF checked) and extracts an image/PDF the customer sent. Returns the
// extraction, or null when vision is not runnable (no key / misconfigured / unsupported mime) or
// yields nothing. Best-effort: NEVER throws — a download/provider failure is logged (+ flowlogged
// when `flow` is present) and treated the same as "no extraction", so the webhook ack is never
// stranded on a provider hiccup.
export async function extractZproFile(
  params: ExtractZproFileParams,
): Promise<ExtractZproFileResult | null> {
  const { cfg } = params;
  const base = params.base ?? basePrisma;

  const skip = (reason: string): null => {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "vision",
        level: "warn",
        status: "skipped",
        provider: cfg.provider,
        detail: { reason },
      });
    }
    return null;
  };

  const provider = getVisionProvider(cfg.provider);
  if (!provider) {
    logger.warn("zpro:vision: unknown provider %s", cfg.provider);
    return skip("unknown_provider");
  }
  if (!cfg.credentialRef) {
    logger.warn("zpro:vision: no credentialRef configured — skipping");
    return skip("no_credential");
  }
  const entry = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
    logger.warn(
      "zpro:vision: credential %s not found in the vault — skipping",
      cfg.credentialRef,
    );
    return skip("credential_not_found");
  }

  const fetchImpl = params.deps?.fetchImpl ?? fetch;
  let bytes: ArrayBuffer;
  let contentType: string | null;
  try {
    const url = await assertSafeOutboundUrl(params.mediaUrl);
    const res = await fetchImpl(url);
    if (!res.ok)
      throw new Error(`media download failed with status ${res.status}`);
    bytes = await res.arrayBuffer();
    contentType = res.headers.get("content-type");
  } catch (err) {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "vision",
        level: "warn",
        status: "error",
        provider: cfg.provider,
        detail: { step: "download" },
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    logger.warn(
      "zpro:vision: media download failed: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // The downloaded blob is WhatsApp's own encrypted CDN payload, not the plain file the response
  // Content-Type header would suggest — decrypt before classifying/handing anything to the
  // provider. On failure, never fall back to feeding still-encrypted bytes downstream.
  if (params.mediaKey && params.mediaType) {
    try {
      bytes = decryptWhatsappMedia(bytes, params.mediaKey, params.mediaType);
      // Once decrypted, the CDN's Content-Type (of the *encrypted* transport) is no longer
      // meaningful — trust the mimetype WhatsApp reported on the original message instead.
      contentType = params.mediaMimetype;
    } catch (err) {
      if (params.flow) {
        emitFlowEvent(params.flow, {
          stage: "vision",
          level: "warn",
          status: "error",
          provider: cfg.provider,
          detail: { step: "decrypt" },
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      logger.warn(
        "zpro:vision: media decryption failed: %s",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  const kind = visionKindForMime(contentType ?? params.mediaMimetype);
  if (!kind) return skip("unsupported_mime");
  const baseURL = entry.baseUrl ?? cfg.baseURL;
  if (kind === "document" && !visionAcceptsDocuments(cfg.provider, baseURL))
    return skip("document_not_supported");

  let extracted: VisionResult;
  try {
    extracted = await extractWithRetry({
      provider,
      providerName: cfg.provider,
      model: cfg.model || provider.defaultModel,
      flow: params.flow,
      sleep: params.deps?.sleep,
      req: {
        bytes,
        mimeType:
          contentType ?? params.mediaMimetype ?? "application/octet-stream",
        kind,
        prompt: cfg.extractionPrompt,
        model: cfg.model || provider.defaultModel,
        apiKey: entry.secret,
        baseURL,
        fetchImpl,
      },
    });
  } catch (err) {
    logger.warn(
      "zpro:vision: extraction failed: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  const text = extracted.text;
  const trimmed = text.trim();
  return trimmed ? { kind, text: trimmed } : null;
}
