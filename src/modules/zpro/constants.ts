// src/modules/zpro/constants.ts

export const ZPRO_METHOD_MESSAGE = "message" as const;
export const ZPRO_METHOD_CONTACT = "contact-create-update" as const;

export const ZPRO_TYPES_TEXT = ["conversation", "extendedTextMessage"] as const;
export const ZPRO_TYPES_AUDIO = ["audioMessage", "pttMessage"] as const;
export const ZPRO_TYPES_IMAGE = ["imageMessage"] as const;
export const ZPRO_TYPES_VIDEO = ["videoMessage"] as const;
export const ZPRO_TYPES_DOCUMENT = ["documentMessage"] as const;
export const ZPRO_TYPES_STICKER = ["stickerMessage"] as const;

export const ZPRO_TYPES_MEDIA = [
  ...ZPRO_TYPES_AUDIO,
  ...ZPRO_TYPES_IMAGE,
  ...ZPRO_TYPES_VIDEO,
  ...ZPRO_TYPES_DOCUMENT,
  ...ZPRO_TYPES_STICKER,
] as const;

// Gate do agente: ticket.n8nStatus === true para agir
export const ZPRO_AGENT_GATE = "n8nStatus" as const;

// Estados de presence para sendPresence
export const ZPRO_PRESENCE_TYPING = "typing" as const;
export const ZPRO_PRESENCE_PAUSED = "paused" as const;

// TTL do cache de idempotência em memória (ms)
export const ZPRO_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;

// TTL da marca "agente está enviando" (agent-echo.ts) — janela em que um eco fromMe do webhook é
// tratado como AGENT em vez de cair no heurístico ticket.userId (que classificaria como HUMAN e
// dispararia o auto-handoff em zpro.controller.ts, desligando o agente sozinho). Cobre múltiplos
// balões (split por \n\n em sendTextReply) + latência de rede/ida-volta do webhook + a variância de
// um turno lento (guardrails + RAG/tool calls antes do envio). 2min dá bastante folga; o custo de
// superestimar é pequeno (uma intervenção humana genuína dentro da janela raramente coincide com o
// segundo exato de uma resposta do agente), enquanto subestimar desliga o agente sozinho.
export const ZPRO_AGENT_ECHO_TTL_MS = 2 * 60 * 1000;
