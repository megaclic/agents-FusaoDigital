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

  private async get<T = unknown>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): Promise<T> {
    const url = new URL(this.endpoint(path));
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`ZproClient GET ${path} ${res.status}: ${text}`);
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

  /** Remove uma tag do ticket. */
  async removeTag(ticketId: number, tagId: number) {
    return this.post("removeTag", { ticketId, tagId });
  }

  /** Adiciona tag ao contato diretamente. */
  async addTagContact(
    contactId: number,
    tagId: number,
    validateNumber?: boolean,
  ) {
    return this.post("addTagContact", { contactId, tagId, validateNumber });
  }

  /** Remove tag(s) do contato por número. */
  async removeTagContact(
    number: string,
    tagIds: number[],
    validateNumber?: boolean,
  ) {
    return this.post("removeTagContact", { number, tagIds, validateNumber });
  }

  /** Cria nota interna no ticket (visível para atendentes). */
  async createNote(ticketId: number, notes: string, userId?: number) {
    return this.post("createNotes", {
      notes,
      ticketId,
      userId,
      idFront: crypto.randomUUID(),
    });
  }

  /** Lista notas do ticket. */
  async listNotes(ticketId: number) {
    return this.get("listNotes", { ticketId });
  }

  /** Atualiza nota existente. */
  async updateNote(noteId: number, notes: string) {
    return this.post("updateNote", { noteId, notes });
  }

  /** Cria ticket por webmail/canal. */
  async createTicket(data: {
    body: string;
    email?: string;
    channelId: number;
    externalKey?: string;
    userId?: number;
    status?: string;
    name?: string;
    firstName?: string;
    lastName?: string;
  }) {
    return this.post("createTicket", data);
  }

  /** Info completa do ticket por número. */
  async showTicket(number: string) {
    return this.post("showticket", { number });
  }

  /** Mostra todos os tickets de um número. */
  async showAllTicket(number: string) {
    return this.post("showallticket", { number });
  }

  /** Muda o canal de um ticket. */
  async updateTicketChannel(
    ticketId: number,
    whatsappId: number,
    channel: string,
  ) {
    return this.post("updateTicketChannel", { ticketId, whatsappId, channel });
  }

  /** Pausa um ticket. */
  async pauseTicket(ticketId: number, pauseReason?: string) {
    return this.post(`ticket/pause/start/${ticketId}`, { pauseReason });
  }

  /** Encerra pausa de um ticket. */
  async unpauseTicket(ticketId: number) {
    return this.post(`ticket/pause/end/${ticketId}`, {});
  }

  /** Logs de pausa de um ticket. */
  async listPauseLogs(ticketId: number) {
    return this.get(`ticket/pause/logs/${ticketId}`);
  }

  /** Envia avaliação para o cliente. */
  async sendEvaluation(
    ticketId: number,
    body: string,
    opts?: { externalKey?: string; force?: boolean },
  ) {
    return this.post("sendEvaluation", { ticketId, body, ...opts });
  }

  /** Cria link de compartilhamento do ticket. */
  async createTicketShare(ticketId: number, inviteUrl: string) {
    return this.post("ticket/share", { ticketId, inviteUrl });
  }

  /** Obtém link de compartilhamento. */
  async getTicketShare(ticketId: number) {
    return this.get(`ticket/share/${ticketId}`);
  }

  /** Lista tickets com filtros. */
  async listTickets(opts?: {
    pageNumber?: number;
    status?: string;
    searchParam?: string;
    queuesIds?: string;
    whatsappIds?: string;
  }) {
    return this.get("listTickets", opts);
  }

  // ── Kanban e tags (gestão) ───────────────────────────────────────────────

  /** Lista colunas do kanban configuradas. */
  async listKanban() {
    return this.get("listKanban");
  }

  /** Cria nova coluna kanban. */
  async createKanban(name: string) {
    return this.post("createKanban", { name });
  }

  /** Atualiza coluna kanban. */
  async updateKanban(id: number, name: string) {
    return this.post(`updateKanban/${id}`, { name });
  }

  /** Deleta coluna kanban. */
  async deleteKanban(id: number) {
    return this.post(`deleteKanban/${id}`, {});
  }

  /** Lista tags configuradas. */
  async listTags(isActive?: boolean) {
    return this.get("listTags", { isActive });
  }

  /** Cria tag. */
  async createTag(tag: string, color: string, isActive?: boolean) {
    return this.post("createTag", { tag, color, isActive });
  }

  /** Atualiza tag. */
  async updateTag(id: number, tag: string, color: string) {
    return this.post(`updateTagData/${id}`, { tag, color });
  }

  /** Deleta tag. */
  async deleteTag(id: number) {
    return this.post(`deleteTag/${id}`, {});
  }

  /** Lista motivos de fechamento. */
  async listReasons() {
    return this.get("listReasons");
  }

  /** Cria motivo de fechamento. */
  async createReason(name: string) {
    return this.post("createReason", { name });
  }

  /** Atualiza motivo de fechamento. */
  async updateReason(id: number, name: string) {
    return this.post(`updateReason/${id}`, { name });
  }

  /** Deleta motivo de fechamento. */
  async deleteReason(id: number) {
    return this.post(`deleteReason/${id}`, {});
  }

  /** Lista filas. */
  async listQueues() {
    return this.get("listQueues");
  }

  /** Cria fila. */
  async createQueue(queue: string, isActive?: boolean) {
    return this.post("createQueueData", { queue, isActive });
  }

  /** Atualiza fila (distinto de updateQueue, que move um ticket de fila). */
  async updateQueue2(id: number, queue: string, isActive?: boolean) {
    return this.post(`updateQueueData/${id}`, { queue, isActive });
  }

  /** Deleta fila. */
  async deleteQueue(id: number) {
    return this.post(`deleteQueueData/${id}`, {});
  }

  // ── Contatos (complemento) ───────────────────────────────────────────────

  /** Busca contatos com filtros. */
  async searchContacts(
    searchParam: string,
    opts?: { page?: number; limit?: number; tagId?: number },
  ) {
    return this.post("contacts/search", { searchParam, ...opts });
  }

  /** Lista contatos com paginação. */
  async listContacts(opts?: {
    pageNumber?: number;
    searchParam?: string;
    walletId?: number;
    tagId?: number;
  }) {
    return this.get("listContacts", opts);
  }

  /** Busca contato por número. */
  async showContact(number: string, validateNumber?: boolean) {
    return this.post("showcontact", { number, validateNumber });
  }

  /** Cria contato. */
  async createContact(data: {
    name?: string;
    number: string;
    email?: string;
    cpf?: string;
    firstName?: string;
    lastName?: string;
    businessName?: string;
    birthdayDate?: string;
    externalKey?: string;
    validateNumber?: boolean;
  }) {
    return this.post("createContact", data);
  }

  /** Atualiza contato. */
  async updateContact(data: {
    number: string;
    name?: string;
    email?: string;
    cpf?: string;
    firstName?: string;
    lastName?: string;
    businessName?: string;
    birthdayDate?: string;
    kanban?: number;
    externalKey?: string;
    validateNumber?: boolean;
  }) {
    return this.post("updateContact", data);
  }

  /** Busca extraInfo do contato. */
  async getContactExtraInfo(contactId: number) {
    return this.get("getContactExtraInfo", { contactId });
  }

  /** Atualiza carteira do contato. */
  async updateContactWallet(contactId: number, walletId: number) {
    return this.post("updateContactWallet", { contactId, walletId });
  }

  /** Bloqueia/desbloqueia contato. */
  async blockContact(contactId: number, blocked: boolean) {
    return this.post("blockContact", { contactId, blocked });
  }

  // ── Mensagens interativas — Baileys ──────────────────────────────────────

  /** Envia botões de resposta rápida. */
  async sendQuickReply(
    ticketId: number,
    body: string,
    buttons: string[],
    footer?: string,
  ) {
    return this.post("sendInteractive/baileys/quickReply", {
      ticketId,
      body,
      footer,
      buttons: buttons.map((buttonText, index) => ({
        buttonId: String(index + 1),
        buttonText,
      })),
    });
  }

  /** Envia lista de seleção única. */
  async sendSingleSelect(
    ticketId: number,
    body: string,
    list: Array<{
      title: string;
      rows: Array<{ rowId: string; title: string; description?: string }>;
    }>,
    footer?: string,
  ) {
    return this.post("sendInteractive/baileys/singleSelect", {
      ticketId,
      body,
      footer,
      list,
    });
  }

  /** Envia botão PIX. */
  async sendPixButton(
    ticketId: number,
    pixType: string,
    pixKey: string,
    pixName: string,
    bodyText: string,
  ) {
    return this.post("sendInteractive/baileys/pixButton", {
      ticketId,
      pixType,
      pixKey,
      pixName,
      bodyText,
    });
  }

  /** Envia botão CTA com link. */
  async sendCtaUrl(
    ticketId: number,
    body: string,
    displayText: string,
    url: string,
    footer?: string,
  ) {
    return this.post("sendInteractive/baileys/ctaUrl", {
      ticketId,
      body,
      footer,
      displayText,
      url,
    });
  }

  /** Envia botão CTA de copiar código. */
  async sendCtaCopy(
    ticketId: number,
    body: string,
    displayText: string,
    copyCode: string,
    footer?: string,
  ) {
    return this.post("sendInteractive/baileys/ctaCopy", {
      ticketId,
      body,
      footer,
      displayText,
      copyCode,
    });
  }

  /** Envia botão CTA de ligar. */
  async sendCtaCall(
    ticketId: number,
    body: string,
    displayText: string,
    phoneNumber: string,
    footer?: string,
  ) {
    return this.post("sendInteractive/baileys/ctaCall", {
      ticketId,
      body,
      footer,
      displayText,
      phoneNumber,
    });
  }

  // ── Mensagens interativas — WABA ─────────────────────────────────────────

  /** Envia botões WABA (até 3). */
  async sendButtonWABA(
    number: string,
    message: string,
    buttons: string[],
    ticketId?: number,
  ) {
    const [button1, button2, button3] = buttons;
    return this.post("sendButtonWABA", {
      number,
      message,
      button1,
      button2,
      button3,
      ticketId,
    });
  }

  /** Envia lista WABA com seções. */
  async sendListWABA(
    number: string,
    data: {
      header?: string;
      body: string;
      footer?: string;
      button_text: string;
      sections: Array<{
        title: string;
        rows: Array<{ id: string; title: string; description?: string }>;
      }>;
      ticketId?: number;
    },
  ) {
    return this.post("sendListWABA", { number, ...data });
  }

  // ── Mensagens avançadas ──────────────────────────────────────────────────

  /** Busca mensagens no histórico do ticket por texto. */
  async searchMessages(
    ticketId: number,
    searchParam: string,
    opts?: { page?: number; limit?: number },
  ) {
    return this.get("searchMessages", { ticketId, searchParam, ...opts });
  }

  /** Envia localização. */
  async sendLocation(
    number: string,
    latitude: number,
    longitude: number,
    name?: string,
    address?: string,
    ticketId?: number,
    externalKey?: string,
  ) {
    return this.post("sendLocation", {
      number,
      latitude,
      longitude,
      name,
      address,
      ticketId,
      externalKey,
    });
  }

  /** Envia cartão de contato (vcard). */
  async sendVcard(
    number: string,
    contact: string,
    ticketId?: number,
    externalKey?: string,
  ) {
    return this.post("sendVcard", { number, contact, ticketId, externalKey });
  }

  // ── Templates WABA ────────────────────────────────────────────────────────

  /** Envia template WABA (HSM). */
  async sendTemplateWABA(data: {
    number: string;
    templateId: string;
    components?: unknown[];
  }) {
    return this.post("template", data);
  }

  /** Envia template WABA com body variável. */
  async sendTemplateWABABody(data: {
    number: string;
    templateName: string;
    languageCode: string;
    components?: unknown[];
  }) {
    return this.post("templateBody", data);
  }

  /** Envia template de marketing. */
  async sendTemplateMarketing(data: {
    number: string;
    templateName: string;
    languageCode: string;
    components?: unknown[];
  }) {
    return this.post("templateMarketingBody", data);
  }

  // ── Agendamentos e lembretes ─────────────────────────────────────────────

  /** Cria agendamento (ex: consulta, reunião). */
  async createAppointment(data: {
    title: string;
    description?: string;
    contactId: number;
    contactName: string;
    contactPhone: string;
    whatsappId: number;
    startAt: string;
    endAt: string;
    status?: string;
    notes?: string;
  }) {
    return this.post("appointment/create", data);
  }

  /** Lista agendamentos. */
  async listAppointments(opts?: {
    page?: number;
    limit?: number;
    status?: string;
    startFrom?: string;
    startTo?: string;
    search?: string;
  }) {
    return this.get("appointment/list", opts);
  }

  /** Busca agendamento por id. */
  async showAppointment(id: number) {
    return this.get(`appointment/show/${id}`);
  }

  /** Atualiza agendamento. */
  async updateAppointment(
    id: number,
    data: Parameters<ZproClient["createAppointment"]>[0],
  ) {
    return this.post(`appointment/update/${id}`, data);
  }

  /** Deleta agendamento. */
  async deleteAppointment(id: number) {
    return this.post(`appointment/delete/${id}`, {});
  }

  /** Cria lembrete recorrente. */
  async createReminder(data: {
    name: string;
    description?: string;
    hoursBeforeEvent: number;
    messageType: string;
    messageContent: string;
    whatsappId: number;
    active?: boolean;
  }) {
    return this.post("scheduleReminder/create", data);
  }

  /** Lista lembretes. */
  async listReminders() {
    return this.get("scheduleReminder/list");
  }

  /** Liga/desliga lembrete. */
  async toggleReminder(id: number) {
    return this.post(`scheduleReminder/toggle/${id}`, {});
  }

  /** Deleta lembrete. */
  async deleteReminder(id: number) {
    return this.post(`scheduleReminder/delete/${id}`, {});
  }

  // ── Oportunidades / CRM ──────────────────────────────────────────────────

  /** Cria oportunidade no funil de vendas. */
  async createOpportunity(data: {
    number: string;
    contactName?: string;
    email?: string;
    name: string;
    value?: number;
    status?: string;
    pipelineId: number;
    stageId: number;
    responsibleId?: number;
    closingForecast?: string;
    description?: string;
    validateNumber?: boolean;
  }) {
    return this.post("createOpportunity", data);
  }

  /** Atualiza oportunidade. */
  async updateOpportunity(
    opportunityId: number,
    data: Omit<
      Parameters<ZproClient["createOpportunity"]>[0],
      "number" | "validateNumber"
    >,
  ) {
    return this.post("updateOpportunity", { opportunityId, ...data });
  }

  /** Remove oportunidade. */
  async deleteOpportunity(opportunityId: number) {
    return this.post("deleteOpportunity", { opportunityId });
  }

  /** Lista oportunidades. */
  async listOpportunities(opts?: {
    page?: number;
    limit?: number;
    status?: string;
    pipelineId?: number;
  }) {
    return this.get("listOpportunities", opts);
  }

  /** Lista pipelines (funis). */
  async listPipelines() {
    return this.get("pipeline/list");
  }

  /** Busca pipeline por id. */
  async showPipeline(id: number) {
    return this.get(`pipeline/show/${id}`);
  }

  /** Cria pipeline. */
  async createPipeline(name: string) {
    return this.post("pipeline/create", { name });
  }

  /** Atualiza pipeline. */
  async updatePipeline(id: number, name: string) {
    return this.post(`pipeline/update/${id}`, { name });
  }

  /** Deleta pipeline. */
  async deletePipeline(id: number) {
    return this.post(`pipeline/delete/${id}`, {});
  }

  /** Lista etapas (stages) de funil. */
  async listStages() {
    return this.get("stage/list");
  }

  /** Busca etapa por id. */
  async showStage(id: number) {
    return this.get(`stage/show/${id}`);
  }

  /** Cria etapa de funil. */
  async createStage(data: {
    name: string;
    pipelineId: number;
    order?: number;
  }) {
    return this.post("stage/create", data);
  }

  /** Atualiza etapa de funil. */
  async updateStage(
    id: number,
    data: { name?: string; pipelineId?: number; order?: number },
  ) {
    return this.post(`stage/update/${id}`, data);
  }

  /** Deleta etapa de funil. */
  async deleteStage(id: number) {
    return this.post(`stage/delete/${id}`, {});
  }

  // ── Listagens e utilitários ──────────────────────────────────────────────

  /** Canais conectados. */
  async listChannels() {
    return this.get("listChannels");
  }

  /** Sessões ativas. */
  async listSessions() {
    return this.get("listSessions");
  }

  /** Info de canal por id. */
  async showChannelById(id: number) {
    return this.post("showChannelById", { id });
  }

  /** Auto-respostas configuradas. */
  async listAutoReplies() {
    return this.get("listAutoReplies");
  }

  /** Fluxos de chatbot. */
  async listChatFlows() {
    return this.get("listChatFlows");
  }

  /** Respostas rápidas. */
  async listFastReplies() {
    return this.get("listFastReplies");
  }

  /** Busca mensagem por messageId (rastrear status). */
  async getMessageByMessageId(messageId: string) {
    return this.get("getMessageByMessageId", { messageId });
  }
}
