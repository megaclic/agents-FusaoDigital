// src/modules/zpro/types.ts
// Tipos baseados nos payloads reais capturados em 06/08/2026 via webhook global Z-PRO v4.
// Canal de teste: Evolution API (type: "evo"). Campos validados para texto, áudio,
// imagem e documentMessage.

export interface ZproWebhookPayload {
  method: "message" | "contact-create-update" | string;
  // Presente quando method === "message"
  msg?: ZproMsgTop;
  ticket?: ZproTicket;
  whatsapp?: ZproWhatsapp;
  user?: ZproUser;
  tenant?: ZproTenant;
  // Presente quando method === "contact-create-update"
  contact?: ZproContact;
}

export interface ZproMsgTop {
  event: string; // "messages.upsert"
  instance: string; // ex: "TesteSindSeg"
  fromMe: boolean;
  id: string; // messageId único
  body: string | null; // texto para "conversation"; null para mídias
  type: ZproMessageType; // tipo primário da mensagem
  timestamp: number; // unix ms
  from: string; // número do remetente, ex: "5511963529979"
  read: boolean;
  ack: number;
  data?: ZproMsgData;
  destination?: string;
  date_time?: string;
  sender?: string;
  server_url?: string;
  apikey?: string;
}

export interface ZproMsgData {
  key?: {
    remoteJid?: string;
    remoteJidAlt?: string;
    fromMe?: boolean;
    id?: string;
    participant?: string;
  };
  pushName?: string;
  status?: string;
  message?: ZproMsgContent;
  messageType?: string;
  messageTimestamp?: number;
  instanceId?: string;
  source?: string;
  contextInfo?: unknown;
}

export interface ZproMsgContent {
  // Texto puro
  conversation?: string;
  // Texto rico
  extendedTextMessage?: {
    text?: string;
    contextInfo?: unknown;
  };
  // Áudio (ptt ou gravado)
  audioMessage?: {
    url?: string;
    mimetype?: string;
    seconds?: number;
    ptt?: boolean;
    directPath?: string;
    mediaKeyTimestamp?: unknown;
  };
  // Imagem
  imageMessage?: {
    url?: string;
    mimetype?: string;
    caption?: string;
    height?: number;
    width?: number;
    directPath?: string;
  };
  // Vídeo
  videoMessage?: {
    url?: string;
    mimetype?: string;
    caption?: string;
    seconds?: number;
    directPath?: string;
  };
  // Documento (inclui imagens enviadas via "Documento" no WhatsApp Web)
  documentMessage?: {
    url?: string;
    mimetype?: string;
    title?: string;
    fileName?: string;
    caption?: string; // texto enviado junto ao documento
    directPath?: string;
  };
  // Sticker
  stickerMessage?: {
    url?: string;
    mimetype?: string;
    directPath?: string;
  };
  // Metadados de contexto (presente em todos os tipos)
  messageContextInfo?: unknown;
}

export type ZproMessageType =
  | "conversation"
  | "extendedTextMessage"
  | "audioMessage"
  | "pttMessage"
  | "imageMessage"
  | "videoMessage"
  | "documentMessage"
  | "stickerMessage"
  | string;

export interface ZproTicket {
  id: number;
  protocol: string;
  status: "open" | "pending" | "closed" | string;
  channel: string; // "evo" | "baileys" | "waba" | "uazapi"
  contactId: number;
  whatsappId: number;
  tenantId: number;
  userId: number | null; // atendente humano atribuído
  queueId: number | null;
  // Flags de bot — gate do agente
  n8nStatus: boolean; // true = agente ativo neste ticket
  chatgptStatus: boolean;
  typebotStatus: boolean;
  difyStatus: boolean;
  dialogflowStatus: boolean;
  claudeStatus: boolean;
  geminiStatus: boolean;
  deepseekStatus: boolean;
  qwenStatus: boolean;
  grokStatus: boolean;
  ollamaStatus: boolean;
  lmStatus: boolean;
  // Estado
  botStopped: boolean;
  isGroup: boolean;
  unreadMessages: number;
  lastMessage: string | null;
  contextVariables: Record<string, unknown>;
  contact: ZproContact;
  // Campos opcionais relevantes
  n8nUrl: string | null;
  threadId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ZproContact {
  id: number;
  name: string;
  number: string;
  lid?: string | null;
  email?: string | null;
  profilePicUrl?: string | null;
  pushname?: string | null;
  isGroup: boolean;
  blocked: boolean;
  chatbotBlocked: boolean;
  tenantId: number;
  extraInfo: Array<{ name: string; value: string }>;
  tags: unknown[];
  wallets?: unknown[];
}

export interface ZproWhatsapp {
  id: number;
  name: string;
  type: string; // "evo" | "baileys" | "waba" | "uazapi"
  status: string; // "CONNECTED" | "DISCONNECTED"
  tenantId: number;
  tokenAPI?: string;
  chatFlowId?: string | null;
  wabaId?: string;
}

// ZproInstance já resolvido no banco pelo controller, usado por normalizeZproWebhook como
// fallback de identidade de canal quando o payload não traz `whatsapp` na raiz (alguns canais do
// webhook global só mandam `ticket.whatsappId`). channelType fica de fora: a tabela ZproInstance
// não guarda o tipo de canal (evo/baileys/waba/...), então esse campo cai para `ticket.channel`.
export interface ResolvedZproInstance {
  id: number;
  name: string;
  channelType?: string;
}

export interface ZproUser {
  id: number;
  name: string;
  isOnline: boolean;
  businessHours?: unknown[];
}

export interface ZproTenant {
  id: number;
  useUserBusinessHours: string;
}

// Evento normalizado — o que o LangGraph recebe do módulo zpro
// A contact tag reference as stored on ZproConversation.contactTags (mirror.ts's parseContactTags)
// — contact.tags's raw shape is UNCONFIRMED, so either half can be null; the missing half is
// resolved against the tags catalog (crm.ts's loadZproTags) at read time.
export interface ZproContactTagRef {
  id: number | null;
  name: string | null;
}

export interface NormalizedZproEvent {
  // Identificação da mensagem
  messageId: string;
  threadId: string; // ticket.id como string → thread_id do LangGraph
  tenantId: number;
  // Canal
  instanceId: number; // whatsapp.id
  instanceName: string; // whatsapp.name
  channelType: string; // "evo" | "baileys" | "waba"
  apiId: string; // ApiID para montar chamadas à API Z-PRO (configurado por instância)
  // Contato
  contactId: number;
  contactNumber: string;
  contactName: string;
  extraInfo: Array<{ name: string; value: string }>;
  // Mensagem
  messageType: ZproMessageType;
  body: string; // texto puro; vazio string para mídias sem caption
  mediaUrl?: string; // URL da mídia quando aplicável
  mediaCaption?: string; // caption/texto junto à mídia
  mediaMimetype?: string;
  mediaFileName?: string;
  fromMe: boolean;
  timestamp: number;
  // Contexto do ticket
  ticketStatus: string;
  agentActive: boolean; // n8nStatus === true
  hasHumanAssigned: boolean; // userId !== null
}
