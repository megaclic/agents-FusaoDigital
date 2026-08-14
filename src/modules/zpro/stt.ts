// src/modules/zpro/stt.ts
// STT (transcrição de áudio) para o canal Z-PRO — espelha o padrão "eager STT at message arrival"
// de src/modules/stt/service.ts (Chatwoot, ver docs/stt.md), com duas diferenças estruturais:
// (1) o download da mídia é a URL crua do CDN do WhatsApp já presente no payload do webhook (não um
// attachment autenticado via ChatwootClient) — passa por assertSafeOutboundUrl (anti-SSRF) em vez
// de client.downloadAttachment; (2) não há write-back pro Chatwoot — o texto transcrito é escrito
// direto no ZproMessage.body já criado pelo mirror, que é a fonte de verdade da UI do inbox Z-PRO
// (ver docs/zpro.md). agent.settings.stt é lido pelo mesmo readSttConfig genérico do Chatwoot — a
// config não é por canal.

import type { PrismaClient } from "@/../generated/prisma/client";
import logger from "@/api/lib/logger";
import basePrisma from "@/api/lib/prisma";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn } from "@/lib/tenancy";
import { cleanTranscription } from "@/modules/chatwoot/render";
import {
  emitFlowEvent,
  type FlowContext,
  withFlowStage,
} from "@/modules/flowlog/service";
import { getSttProvider } from "@/modules/stt/providers";
import { readSttConfig, type SttConfig } from "@/modules/stt/settings";
import { tryResolveVaultEntry } from "@/modules/vault/service";
import { sysCtx } from "./ctx";
import { decryptWhatsappMedia } from "./media-crypto";

// Resolves the STT config for the agent bound to this Z-PRO instance (scoped read, no network).
// null when unbound, disabled, or STT off — the caller then leaves audio untranscribed.
export async function resolveZproSttConfig(
  tenantId: bigint,
  zproInstanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<SttConfig | null> {
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
    return readSttConfig(agent.settings);
  });
  if (!cfg?.enabled) return null;
  return cfg;
}

export interface TranscribeZproAudioParams {
  tenantId: bigint;
  mediaUrl: string;
  mediaMimetype: string | null;
  cfg: SttConfig;
  base?: PrismaClient;
  deps?: { fetchImpl?: typeof fetch };
  // Optional execution-flow context: when present, the transcription is logged as an `stt` stage
  // (visible in /logs), same contract as the Chatwoot path.
  flow?: FlowContext;
  // base64 WhatsApp media key (parse.ts's extractMedia) — the downloaded blob is WhatsApp's own
  // end-to-end-encrypted CDN link, not plain audio (see media-crypto.ts). Optional and defensive:
  // a payload that somehow lacks it falls back to the pre-decryption behavior (feed raw bytes to
  // the provider) rather than refusing to even try.
  mediaKey?: string;
}

// Downloads (anti-SSRF checked) and transcribes a WhatsApp voice note. Returns the cleaned
// transcription, or null when STT is not runnable (no key / misconfigured) or yields nothing.
// Best-effort: NEVER throws — a download/provider failure is logged (+ flowlogged when `flow` is
// present) and treated the same as "no transcription", so the webhook ack is never stranded on a
// provider hiccup.
export async function transcribeZproAudio(
  params: TranscribeZproAudioParams,
): Promise<string | null> {
  const { cfg } = params;
  const base = params.base ?? basePrisma;

  const skip = (reason: string): null => {
    if (params.flow) {
      emitFlowEvent(params.flow, {
        stage: "stt",
        level: "warn",
        status: "skipped",
        provider: cfg.provider,
        detail: { reason },
      });
    }
    return null;
  };

  const provider = getSttProvider(cfg.provider);
  if (!provider) {
    logger.warn("zpro:stt: unknown provider %s", cfg.provider);
    return skip("unknown_provider");
  }
  if (!cfg.credentialRef) {
    logger.warn("zpro:stt: no credentialRef configured — skipping");
    return skip("no_credential");
  }
  const entry = await runScopedOn(base, sysCtx(params.tenantId), (db) =>
    tryResolveVaultEntry<string>(db, cfg.credentialRef as string),
  );
  if (!entry) {
    logger.warn(
      "zpro:stt: credential %s not found in the vault — skipping",
      cfg.credentialRef,
    );
    return skip("credential_not_found");
  }
  const effectiveBaseURL = entry.baseUrl ?? cfg.baseURL;
  if (provider.requiresBaseURL && !effectiveBaseURL) {
    logger.warn(
      "zpro:stt: provider %s requires a baseURL — skipping",
      cfg.provider,
    );
    return skip("no_base_url");
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
        stage: "stt",
        level: "warn",
        status: "error",
        provider: cfg.provider,
        detail: { step: "download" },
        errorMessage: err instanceof Error ? err.message : String(err),
      });
    }
    logger.warn(
      "zpro:stt: audio download failed: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }

  // The downloaded blob is WhatsApp's own encrypted CDN payload, not the plain audio the response
  // Content-Type header would suggest — decrypt before handing anything to the provider. On
  // failure (bad key / corrupted download) this is treated the same as a download failure: never
  // fall back to feeding still-encrypted bytes to the provider, that just reproduces the same
  // opaque "400" the diagnostic was chasing.
  if (params.mediaKey) {
    try {
      bytes = decryptWhatsappMedia(bytes, params.mediaKey, "audio");
      // Once decrypted, the CDN's Content-Type (of the *encrypted* transport) is no longer
      // meaningful — trust the mimetype WhatsApp reported on the original message instead.
      contentType = params.mediaMimetype;
    } catch (err) {
      if (params.flow) {
        emitFlowEvent(params.flow, {
          stage: "stt",
          level: "warn",
          status: "error",
          provider: cfg.provider,
          detail: { step: "decrypt" },
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
      logger.warn(
        "zpro:stt: audio decryption failed: %s",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }

  let raw: string;
  try {
    raw = await withFlowStage(
      params.flow,
      "stt",
      { provider: cfg.provider, model: cfg.model || provider.defaultModel },
      () =>
        provider.transcribe({
          audio: bytes,
          mimeType: contentType ?? params.mediaMimetype,
          language: cfg.language,
          model: cfg.model || provider.defaultModel,
          apiKey: entry.secret,
          baseURL: effectiveBaseURL,
          fetchImpl,
        }),
    );
  } catch (err) {
    // withFlowStage already flowlogged the error (when flow is present) — just make it non-fatal.
    logger.warn(
      "zpro:stt: transcription failed: %s",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
  return cleanTranscription(raw) || null;
}
