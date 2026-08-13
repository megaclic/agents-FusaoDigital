// src/modules/zpro/messages.ts
// Helpers de alto nível para o LangGraph enviar respostas via Z-PRO.

import type { TemplatePayload } from "@/modules/service-window/service";
import type { ZproClient } from "./client";
import { ZPRO_PRESENCE_TYPING } from "./constants";
import type { NormalizedZproEvent } from "./types";

/** Envia indicador de "digitando..." antes de responder. */
export async function sendTyping(
  client: ZproClient,
  event: NormalizedZproEvent,
): Promise<void> {
  await client.sendPresence(Number(event.threadId), ZPRO_PRESENCE_TYPING);
}

/**
 * Envia resposta de texto com split em múltiplos balões.
 * Divide por \n\n para simular mensagens separadas (humanização básica).
 * Usa validateNumber: false pois o número já vem validado do ticket.
 */
export async function sendTextReply(
  client: ZproClient,
  event: NormalizedZproEvent,
  text: string,
  opts?: { isClosed?: boolean },
): Promise<void> {
  const parts = text
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const chunks = parts.length > 0 ? parts : [text];

  for (let i = 0; i < chunks.length; i++) {
    await client.sendText(event.contactNumber, chunks[i] as string, {
      externalKey: `reply-${event.messageId}-${i}-${Date.now()}`,
      validateNumber: false,
      isClosed: i === chunks.length - 1 ? opts?.isClosed : undefined,
    });
  }
}

/** Envia arquivo de áudio como mensagem de voz. */
export async function sendVoiceReply(
  client: ZproClient,
  event: NormalizedZproEvent,
  audioBase64: string,
): Promise<void> {
  await client.sendVoice(event.contactNumber, audioBase64, {
    externalKey: `voice-${event.messageId}-${Date.now()}`,
  });
}

/** Envia imagem ou documento via URL pública. */
export async function sendMediaReply(
  client: ZproClient,
  event: NormalizedZproEvent,
  mediaUrl: string,
  caption?: string,
): Promise<void> {
  await client.sendMediaUrl(event.contactNumber, mediaUrl, caption, {
    externalKey: `media-${event.messageId}-${Date.now()}`,
    validateNumber: false,
  });
}

/**
 * Envia um template WABA aprovado (HSM) com os parâmetros do corpo já interpolados — usado apenas
 * para o envio PROATIVO gated pela janela de 24h (ZproInstance.isOfficialWaba), ver
 * docs/service-window.md. `components` segue o shape padrão da Cloud API da Meta (BODY-only,
 * OPEN-VALIDATION: nunca confirmado contra uma instância real, mesmo nível de confiança que
 * processed_params no lado Chatwoot).
 */
export async function sendZproTemplate(
  client: ZproClient,
  number: string,
  payload: TemplatePayload,
): Promise<void> {
  const params = Object.keys(payload.processedParams.body)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => payload.processedParams.body[k] as string);
  await client.sendTemplateWABABody({
    number,
    templateName: payload.name,
    languageCode: payload.language,
    components:
      params.length > 0
        ? [
            {
              type: "body",
              parameters: params.map((text) => ({ type: "text", text })),
            },
          ]
        : undefined,
  });
}

/**
 * Persiste memória do contato no extraInfo do Z-PRO.
 * Chave/valor arbitrários que ficam visíveis para atendentes humanos
 * e disponíveis na próxima conversa.
 */
export async function saveContactMemory(
  client: ZproClient,
  contactId: number,
  memory: Array<{ name: string; value: string }>,
): Promise<void> {
  await client.updateContactExtraInfo(contactId, memory);
}
