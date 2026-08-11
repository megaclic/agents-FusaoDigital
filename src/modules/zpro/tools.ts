// src/modules/zpro/tools.ts
// Ferramentas INTEGRATION (Google Calendar, Asaas, ...) concedidas ao agente vinculado a uma
// instância Z-PRO. Reaproveita a mesma cadeia genérica que o Chatwoot usa — loadToolSelections
// (src/graph/tools/assemble.ts) → buildToolpackTools (src/modules/integrations/toolpacks) —, sem
// tocar em nada Chatwoot-specific: nenhuma dessas peças exige um ChatwootClient ou uma linha
// Conversation/Inbox mirror. NATIVE/RAG/HTTP/MCP continuam fora de escopo (ver runtime.ts).
//
// contactDbId (ToolpackCtx) usa ZproConversation.id como stamp de isolamento por cliente — Z-PRO
// não tem uma tabela Contact equivalente à do Chatwoot (única por número de telefone); a entidade
// mais próxima é ZproConversation, única por (zproInstanceId, ticketId). Trade-off aceito: um
// número que abrir um ticket novo depois ganha um id novo e "perde" visibilidade dos agendamentos
// feitos no ticket anterior. O stamp é só uma string opaca de controle de acesso — não precisa ser
// um "Contact" de verdade (ver docs/zpro.md).

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import { resolveInjectableCredential } from "@/graph/prepare";
import { loadToolSelections } from "@/graph/tools/assemble";
import { runScopedOn } from "@/lib/tenancy";
import { buildToolpackTools } from "@/modules/integrations/toolpacks";
import { sysCtx } from "./ctx";

export interface ZproIntegrationTools {
  tools: StructuredToolInterface[];
  // Resolved here regardless of whether any tool needed it (also feeds UsageCapture's
  // zproConversationId in runtime.ts) — one lookup shared by both callers instead of two.
  conversationId: bigint | null;
}

export async function loadZproIntegrationTools(
  base: PrismaClient,
  tenantId: bigint,
  agentId: bigint,
  zproInstanceId: bigint,
  ticketId: number,
  threadId: string,
): Promise<ZproIntegrationTools> {
  return runScopedOn(base, sysCtx(tenantId), async (db) => {
    const conversation = await db.zproConversation.findUnique({
      where: { zproInstanceId_ticketId: { zproInstanceId, ticketId } },
      select: { id: true },
    });
    const conversationId = conversation?.id ?? null;

    const selections = await loadToolSelections(db, agentId);
    if (selections.integrationSelections.length === 0) {
      return { tools: [], conversationId };
    }

    const tools = buildToolpackTools(selections.integrationSelections, {
      tenantId,
      base,
      threadId,
      contactDbId: conversationId,
      resolveCredential: (ref) =>
        resolveInjectableCredential(base, tenantId, ref),
    });
    return { tools, conversationId };
  });
}
