// src/modules/zpro/agent-echo.ts
// Sinaliza, para mirror.ts, que uma mensagem fromMe recém-chegada no webhook é o eco da resposta
// que O NOSSO PRÓPRIO runtime acabou de enviar — e não uma intervenção humana via painel Z-PRO.
//
// Por quê: ticket.userId é o atendente ATRIBUÍDO ao ticket (sticky — some com atribuição do painel,
// não com quem enviou esta mensagem específica). Uma vez que um ticket tenha um humano atribuído,
// toda mensagem enviada pelo agente IA via runZproAgentTurn passaria a ser classificada como HUMAN.
// Como somos a ÚNICA origem de mensagens AGENT (respostas humanas vêm sempre do painel Z-PRO, nunca
// do nosso código), marcamos aqui — ANTES de enviar — que um eco fromMe é esperado para este ticket
// nos próximos segundos, e mirror.ts confere essa marca antes de cair no heurístico ticket.userId.
//
// Mesmo padrão do cache de idempotência em webhook.ts: Map em memória + TTL via setTimeout.

import { ZPRO_AGENT_ECHO_TTL_MS } from "./constants";

const _pending = new Map<string, ReturnType<typeof setTimeout>>();

function key(zproInstanceId: bigint, ticketId: number): string {
  return `${zproInstanceId}:${ticketId}`;
}

/** Chamado pelo runtime logo antes de enviar a resposta do agente para este ticket. */
export function markAgentSending(
  zproInstanceId: bigint,
  ticketId: number,
): void {
  const k = key(zproInstanceId, ticketId);
  const existing = _pending.get(k);
  if (existing) clearTimeout(existing);
  _pending.set(
    k,
    setTimeout(() => _pending.delete(k), ZPRO_AGENT_ECHO_TTL_MS),
  );
}

/**
 * Consultado por mirror.ts ao classificar uma mensagem fromMe. Não consome a marca (um envio com
 * múltiplos balões gera múltiplos ecos dentro da mesma janela) — expira sozinha via TTL.
 */
export function wasAgentSending(
  zproInstanceId: bigint,
  ticketId: number,
): boolean {
  return _pending.has(key(zproInstanceId, ticketId));
}
