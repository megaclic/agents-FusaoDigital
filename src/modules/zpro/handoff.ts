// src/modules/zpro/handoff.ts
// Controla a ativação e desativação do agente num ticket.
// Usa o flag n8nStatus do Z-PRO como gate.

import type { ZproClient } from "./client";

/**
 * Ativa o agente no ticket. Chame isso quando um ticket novo
 * precisar ser atendido pelo FusaoDigital agents.
 */
export async function activateAgent(
  client: ZproClient,
  ticketId: number,
): Promise<void> {
  await client.updateTicketInfo(ticketId, { n8nStatus: true });
}

/**
 * Desativa o agente no ticket. Chame isso quando:
 * - Um atendente humano assumir (handoff)
 * - O agente encerrar o atendimento
 * - O ticket for fechado pelo agente
 */
export async function deactivateAgent(
  client: ZproClient,
  ticketId: number,
  opts?: { closeTicket?: boolean },
): Promise<void> {
  await client.updateTicketInfo(ticketId, {
    n8nStatus: false,
    status: opts?.closeTicket ? "closed" : undefined,
  });
}
