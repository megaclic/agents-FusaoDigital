// src/modules/zpro/client.ts
// Cliente HTTP para a API REST do Z-PRO v4.
// Todos os endpoints usam Bearer token e base path /v2/api/external/{ApiID}/...
// Usa fetch nativo do Bun — sem dependências externas.

export class ZproClient {
  constructor(
    private readonly baseUrl: string, // ex: "https://api.fusaobotcrm.com.br"
    private readonly apiId: string, // ApiID do tenant Z-PRO
    private readonly bearerToken: string,
  ) {}

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.bearerToken}`,
      "Content-Type": "application/json",
    };
  }

  private endpoint(path: string): string {
    // path pode ser "" (raiz) ou "sendPresence", "url", etc.
    const base = `${this.baseUrl}/v2/api/external/${this.apiId}`;
    return path ? `${base}/${path}` : base;
  }

  private async post<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.endpoint(path), {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ZproClient POST ${path} ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  // ── Envio de mensagens ────────────────────────────────────────────────────

  /** Envia texto simples. validateNumber: false recomendado para WABA. */
  async sendText(
    number: string,
    body: string,
    opts?: {
      externalKey?: string;
      isClosed?: boolean;
      validateNumber?: boolean;
    },
  ) {
    return this.post("", { number, body, ...opts });
  }

  /** Envia mídia via URL pública (imagem, vídeo, documento). */
  async sendMediaUrl(
    number: string,
    mediaUrl: string,
    body?: string,
    opts?: {
      externalKey?: string;
      isClosed?: boolean;
      validateNumber?: boolean;
    },
  ) {
    return this.post("url", { number, mediaUrl, body, ...opts });
  }

  /** Envia áudio como mensagem de voz (base64, ogg/opus). */
  async sendVoice(
    number: string,
    audio: string /* base64 */,
    opts?: { externalKey?: string; isClosed?: boolean },
  ) {
    return this.post("voice", { number, audio, ...opts });
  }

  /** Envia mídia via base64 (genérico para qualquer tipo de arquivo). */
  async sendBase64(
    number: string,
    base64Data: string,
    mimeType: string,
    fileName: string,
    body?: string,
    opts?: { isClosed?: boolean; validateNumber?: boolean },
  ) {
    return this.post("base64", {
      number,
      base64Data,
      mimeType,
      fileName,
      body,
      ...opts,
    });
  }

  // ── Humanização ───────────────────────────────────────────────────────────

  /** Indica "digitando..." ou pausa no ticket. */
  async sendPresence(ticketId: number, state: "typing" | "paused") {
    return this.post("sendPresence", { ticketId, state });
  }

  // ── Ticket ────────────────────────────────────────────────────────────────

  /** Atualiza flags e status do ticket. Usado para ativar/desativar agente. */
  async updateTicketInfo(
    ticketId: number,
    patch: {
      n8nStatus?: boolean;
      status?: string;
      userId?: number | null;
      queueId?: string | null;
      typebotStatus?: boolean;
      chatgptStatus?: boolean;
      difyStatus?: boolean;
      dialogflowStatus?: boolean;
    },
  ) {
    return this.post("updateticketinfo", { ticketId, ...patch });
  }

  /** Retorna histórico completo de mensagens do ticket. */
  async getMessages(ticketId: number) {
    return this.post("showAllMessages", { ticket: String(ticketId) });
  }

  /** Retorna informações completas do ticket pelo número (otimizado para chatbot). */
  async showTicketChatbot(number: string) {
    return this.post("showticketchatbot", { number });
  }

  /** Retorna informações do ticket pelo ticketId. */
  async showTicketById(ticketId: number) {
    return this.post("showTicketById", { ticketId: String(ticketId) });
  }

  // ── Contato ───────────────────────────────────────────────────────────────

  /** Atualiza campos extras do contato (memória persistente entre conversas). */
  async updateContactExtraInfo(
    contactId: number,
    extraInfo: Array<{ name: string; value: string }>,
  ) {
    return this.post("updateContactExtraInfo", { contactId, extraInfo });
  }

  /** Move o contato no kanban. */
  async updateContactKanban(contactId: number, kanban: number) {
    return this.post("updateContactKanban", { contactId, kanban });
  }

  /** Adiciona tag ao ticket. */
  async addTag(ticketId: number, tagId: number) {
    return this.post("addTag", { ticketId, tagId });
  }

  /** Move ticket para outra fila. */
  async updateQueue(ticketId: number, queueId: number) {
    return this.post("updatequeue", { ticketId, queueId });
  }
}
