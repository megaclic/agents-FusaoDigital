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
// Mesmo padrão do cache de idempotência em webhook.ts: Map em memória + TTL via setTimeout. O Map
// mora no globalThis (mesmo padrão dos workers singleton, ver debounce/worker.ts) — NÃO um simples
// module-level `const` — porque `bun --hot` (dev) recarrega este módulo a cada edição em QUALQUER
// arquivo que o importe transitivamente, o que reexecutaria `new Map()` e apagaria toda marca
// pendente. Isso já causou uma auto-desativação real em produção... quer dizer, em dev: um
// `markAgentSending` chamado bem antes de um hot-reload no meio da janela de TTL perde a marca, o
// eco da própria resposta do agente é lido como intervenção humana (mirror.ts), e o handler de
// auto-handoff (zpro.controller.ts) desativa o agente sozinho. globalThis sobrevive ao reload; em
// produção (sem --hot, processo único) o efeito é idêntico a um `const` module-level normal.

import { ZPRO_AGENT_ECHO_TTL_MS } from "./constants";

const PENDING_KEY = Symbol.for("secv4.zpro.agent-echo.pending");

function pending(): Map<string, ReturnType<typeof setTimeout>> {
  const g = globalThis as unknown as Record<
    symbol,
    Map<string, ReturnType<typeof setTimeout>>
  >;
  g[PENDING_KEY] ??= new Map();
  return g[PENDING_KEY];
}

function key(zproInstanceId: bigint, ticketId: number): string {
  return `${zproInstanceId}:${ticketId}`;
}

/** Chamado pelo runtime logo antes de enviar a resposta do agente para este ticket. */
export function markAgentSending(
  zproInstanceId: bigint,
  ticketId: number,
): void {
  const k = key(zproInstanceId, ticketId);
  const map = pending();
  const existing = map.get(k);
  if (existing) clearTimeout(existing);
  map.set(
    k,
    setTimeout(() => map.delete(k), ZPRO_AGENT_ECHO_TTL_MS),
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
  return pending().has(key(zproInstanceId, ticketId));
}
