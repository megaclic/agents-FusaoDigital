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
