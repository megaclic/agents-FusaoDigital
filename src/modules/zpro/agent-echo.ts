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
// DB-backed (ZproConversation.agentSendingUntil), NÃO um Map em memória — de propósito, depois de
// DUAS falhas ao vivo com abordagens em memória no mesmo dia: um `bun --hot` reload (que reexecuta
// este módulo a cada edição em qualquer arquivo importado transitivamente, apagando um `const` de
// módulo) e, mesmo depois de mover pra um singleton em `globalThis` (sobrevive hot-reload, mas não
// um restart de processo), a marca ainda se perdeu — o processo provavelmente reiniciou entre o
// mark e o eco. Uma coluna sobrevive aos dois. O custo é um round-trip a mais de DB por envio/
// classificação, irrelevante frente aos vários outros round-trips já no caminho de cada turno.

import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn } from "@/lib/tenancy";
import { ZPRO_AGENT_ECHO_TTL_MS } from "./constants";
import { sysCtx } from "./ctx";

/** Chamado pelo runtime logo antes de enviar a resposta do agente para este ticket. */
export async function markAgentSending(
  tenantId: bigint,
  zproInstanceId: bigint,
  ticketId: number,
  base: PrismaClient = basePrisma,
): Promise<void> {
  const until = new Date(Date.now() + ZPRO_AGENT_ECHO_TTL_MS);
  await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproConversation.updateMany({
      where: { zproInstanceId, ticketId },
      data: { agentSendingUntil: until },
    }),
  );
}

/**
 * Consultado por mirror.ts ao classificar uma mensagem fromMe. Não consome a marca (um envio com
 * múltiplos balões gera múltiplos ecos dentro da mesma janela) — expira sozinha por comparação de
 * horário, sem precisar de um "unmark".
 */
export async function wasAgentSending(
  tenantId: bigint,
  zproInstanceId: bigint,
  ticketId: number,
  base: PrismaClient = basePrisma,
): Promise<boolean> {
  const conv = await runScopedOn(base, sysCtx(tenantId), (db) =>
    db.zproConversation.findUnique({
      where: { zproInstanceId_ticketId: { zproInstanceId, ticketId } },
      select: { agentSendingUntil: true },
    }),
  );
  return (conv?.agentSendingUntil?.getTime() ?? 0) > Date.now();
}
