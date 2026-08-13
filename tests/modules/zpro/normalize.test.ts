// tests/modules/zpro/normalize.test.ts
// Testes do normalizeZproWebhook com fixtures baseados nos payloads reais
// capturados em 06/08/2026.

import { describe, expect, test } from "bun:test";
import { normalizeZproWebhook } from "@/modules/zpro/normalize";
import type {
  ZproMsgTop,
  ZproTicket,
  ZproWebhookPayload,
} from "@/modules/zpro/types";

const API_ID = "TEST_API_ID";

// Mensagem de texto "Oi"
const BASE_MSG: ZproMsgTop = {
  event: "messages.upsert",
  instance: "TesteSindSeg",
  fromMe: false,
  id: "ACD935615705DA3E7F8C240D4E662A15",
  body: "Oi",
  type: "conversation",
  timestamp: 1786022542000,
  from: "5511963529979",
  read: false,
  ack: 1,
  data: {
    message: {
      conversation: "Oi",
    },
  },
};

// Ticket com n8nStatus: true (agente ATIVO)
const BASE_TICKET: ZproTicket = {
  id: 6064,
  protocol: "202625051007026064",
  status: "open",
  channel: "evo",
  contactId: 63733,
  whatsappId: 87,
  tenantId: 7,
  userId: null,
  queueId: 17,
  n8nStatus: true,
  chatgptStatus: false,
  typebotStatus: false,
  difyStatus: false,
  dialogflowStatus: false,
  claudeStatus: false,
  geminiStatus: false,
  deepseekStatus: false,
  qwenStatus: false,
  grokStatus: false,
  ollamaStatus: false,
  lmStatus: false,
  botStopped: false,
  isGroup: false,
  unreadMessages: 2,
  lastMessage: "Oi",
  contextVariables: {},
  n8nUrl: null,
  threadId: null,
  createdAt: "2026-05-25T13:07:02.998Z",
  updatedAt: "2026-08-06T13:22:22.940Z",
  contact: {
    id: 63733,
    name: "Samir Toledo",
    number: "5511963529979",
    isGroup: false,
    blocked: false,
    chatbotBlocked: false,
    tenantId: 7,
    extraInfo: [],
    tags: [],
  },
};

const BASE_FIXTURE: ZproWebhookPayload = {
  method: "message",
  msg: BASE_MSG,
  ticket: BASE_TICKET,
  whatsapp: {
    id: 87,
    name: "TesteSindSeg",
    type: "evo",
    status: "CONNECTED",
    tenantId: 7,
  },
};

describe("normalizeZproWebhook", () => {
  test("processa mensagem de texto com agente ativo", () => {
    const result = normalizeZproWebhook(BASE_FIXTURE, API_ID);
    expect(result).not.toBeNull();
    expect(result?.body).toBe("Oi");
    expect(result?.contactNumber).toBe("5511963529979");
    expect(result?.threadId).toBe("6064");
    expect(result?.messageType).toBe("conversation");
    expect(result?.agentActive).toBe(true);
    expect(result?.hasHumanAssigned).toBe(false);
  });

  test("contactName falls back to pushname/number on an EMPTY string name, not just null/undefined", () => {
    // WhatsApp commonly reports name: "" for a contact that never set a display name — `??` would
    // NOT fall through here (only null/undefined do), silently blanking {{nome_contato}}.
    const emptyName: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      ticket: {
        ...BASE_TICKET,
        contact: { ...BASE_TICKET.contact, name: "", pushname: "Sam" },
      },
    };
    expect(normalizeZproWebhook(emptyName, API_ID)?.contactName).toBe("Sam");

    const emptyNameNoPushname: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      ticket: {
        ...BASE_TICKET,
        contact: { ...BASE_TICKET.contact, name: "", pushname: undefined },
      },
    };
    expect(normalizeZproWebhook(emptyNameNoPushname, API_ID)?.contactName).toBe(
      "5511963529979",
    );
  });

  test("ignora mensagem fromMe (enviada pelo atendente)", () => {
    const p: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      msg: { ...BASE_MSG, fromMe: true },
    };
    expect(normalizeZproWebhook(p, API_ID)).toBeNull();
  });

  test("ignora quando n8nStatus false (agente desativado)", () => {
    const p: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      ticket: { ...BASE_TICKET, n8nStatus: false },
    };
    expect(normalizeZproWebhook(p, API_ID)).toBeNull();
  });

  test("ignora method contact-create-update", () => {
    const p: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      method: "contact-create-update",
    };
    expect(normalizeZproWebhook(p, API_ID)).toBeNull();
  });

  test("ignora quando botStopped true", () => {
    const p: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      ticket: { ...BASE_TICKET, botStopped: true },
    };
    expect(normalizeZproWebhook(p, API_ID)).toBeNull();
  });

  test("ignora mensagem de grupo", () => {
    const p: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      ticket: { ...BASE_TICKET, isGroup: true },
    };
    expect(normalizeZproWebhook(p, API_ID)).toBeNull();
  });

  test("processa audioMessage com mediaUrl", () => {
    const p: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      msg: {
        ...BASE_MSG,
        body: null,
        type: "audioMessage",
        data: {
          message: {
            audioMessage: {
              url: "https://mmg.whatsapp.net/audio.ogg",
              mimetype: "audio/ogg; codecs=opus",
              ptt: true,
            },
          },
        },
      },
    };
    const result = normalizeZproWebhook(p, API_ID);
    expect(result).not.toBeNull();
    expect(result?.messageType).toBe("audioMessage");
    expect(result?.mediaUrl).toBe("https://mmg.whatsapp.net/audio.ogg");
    expect(result?.mediaMimetype).toBe("audio/ogg; codecs=opus");
    expect(result?.body).toBe("");
  });

  test("processa documentMessage com caption e fileName", () => {
    const p: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      msg: {
        ...BASE_MSG,
        body: null,
        type: "documentMessage",
        data: {
          message: {
            documentMessage: {
              url: "https://mmg.whatsapp.net/doc.jpeg",
              mimetype: "image/jpeg",
              fileName: "foto.jpeg",
              caption: "IMAGEM TESTE COM TEXTO",
            },
          },
        },
      },
    };
    const result = normalizeZproWebhook(p, API_ID);
    expect(result).not.toBeNull();
    expect(result?.messageType).toBe("documentMessage");
    expect(result?.mediaCaption).toBe("IMAGEM TESTE COM TEXTO");
    expect(result?.mediaFileName).toBe("foto.jpeg");
    expect(result?.body).toBe("IMAGEM TESTE COM TEXTO");
  });

  test("preenche hasHumanAssigned quando userId presente", () => {
    const p: ZproWebhookPayload = {
      ...BASE_FIXTURE,
      ticket: { ...BASE_TICKET, userId: 15 },
    };
    const result = normalizeZproWebhook(p, API_ID);
    expect(result?.hasHumanAssigned).toBe(true);
  });

  test("resolve instanceId via ticket.whatsappId quando o payload não traz whatsapp na raiz", () => {
    // Alguns canais do webhook global (fora do "evo") só mandam ticket.whatsappId — sem o objeto
    // `whatsapp` na raiz do payload. extractWhatsappId/extractInstanceName devem degradar para
    // ticket.whatsappId/msg.instance/ticket.channel nesse caso.
    const p: ZproWebhookPayload = {
      method: "message",
      msg: BASE_MSG,
      ticket: BASE_TICKET,
    };
    const result = normalizeZproWebhook(p, API_ID);
    expect(result).not.toBeNull();
    expect(result?.instanceId).toBe(BASE_TICKET.whatsappId);
    expect(result?.instanceName).toBe(BASE_MSG.instance);
    expect(result?.channelType).toBe(BASE_TICKET.channel);
  });
});
