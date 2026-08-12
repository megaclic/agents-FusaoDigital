// src/modules/zpro/tools.ts
// Ferramentas concedidas ao agente vinculado a uma instância Z-PRO. Reaproveita a MESMA cadeia
// genérica que o Chatwoot usa (src/graph/tools/assemble.ts's loadToolSelections + cada builder de
// fonte — buildToolpackTools, buildRagTools, buildHttpTools, loadMcpToolsForAgent), sem tocar em
// nada Chatwoot-specific: nenhuma dessas peças exige um ChatwootClient ou uma linha Conversation/
// Inbox mirror. NATIVE fica de fora EXCETO as tools utilitárias (calculator/get_current_time —
// UTILITY_NATIVE_TOOL_NAMES, sem dependência de client/conversa, mesmo allowlist que o playground
// usa) — as demais tools nativas (handoff/labels/kanban/react_to_message/skip_reply/...) exigem
// infraestrutura Chatwoot-specific que o Z-PRO não tem (ver docs/zpro.md). set_voice_preference é
// tratada à parte em tts.ts — sua contraparte NATIVA (Contact.voiceReply) não se aplica ao Z-PRO.
//
// contactDbId (ToolpackCtx/RagToolCtx) usa ZproConversation.id como stamp de isolamento por cliente
// — Z-PRO não tem uma tabela Contact equivalente à do Chatwoot (única por número de telefone); a
// entidade mais próxima é ZproConversation, única por (zproInstanceId, ticketId). Trade-off aceito:
// um número que abrir um ticket novo depois ganha um id novo e "perde" visibilidade dos
// agendamentos/dados feitos no ticket anterior. O stamp é só uma string opaca de controle de
// acesso — não precisa ser um "Contact" de verdade (ver docs/zpro.md).

import type { StructuredToolInterface } from "@langchain/core/tools";
import type { PrismaClient } from "@/../generated/prisma/client";
import config from "@/config";
import { resolveInjectableCredential } from "@/graph/prepare";
import { buildHttpTools, loadToolSelections } from "@/graph/tools/assemble";
import { loadMcpToolsForAgent } from "@/graph/tools/mcp";
import { buildNativeTools, utilityNativeAllow } from "@/graph/tools/native";
import { buildRagTools } from "@/graph/tools/rag";
import { runScopedOn } from "@/lib/tenancy";
import type { ChatwootClient } from "@/modules/chatwoot/client";
import { buildToolpackTools } from "@/modules/integrations/toolpacks";
import { sysCtx } from "./ctx";

export interface ZproAgentTools {
  tools: StructuredToolInterface[];
  // Resolved here regardless of whether any tool needed it (also feeds UsageCapture's
  // zproConversationId and the TTS voice-preference tool in runtime.ts) — one lookup shared by
  // several consumers.
  conversationId: bigint | null;
  // Whether search_knowledge was granted — the caller composes the grounding directive onto the
  // system prompt when true (see src/graph/prompt.ts's composeSystemPrompt, same as Chatwoot).
  grounded: boolean;
}

export interface LoadZproAgentToolsParams {
  base: PrismaClient;
  tenantId: bigint;
  agentId: bigint;
  zproInstanceId: bigint;
  ticketId: number;
  threadId: string;
  // Optional RAG grounding threshold (agent.settings.grounding.maxDistance, resolved by the
  // caller via src/graph/prepare.ts's readMaxDistance — reads the same settings bag runtime.ts
  // already loaded). Undefined ⇒ no distance filtering (recall preserved), a valid default.
  maxDistance?: number | null;
  // {{placeholder}} context for custom HTTP tools (fixed fields, headers, URL, raw body) — mirrors
  // Chatwoot's httpToolContext. Omitted keys are simply unavailable to interpolate.
  contactName?: string | null;
  contactNumber?: string | null;
  companyName?: string | null;
}

export async function loadZproAgentTools(
  params: LoadZproAgentToolsParams,
): Promise<ZproAgentTools> {
  const { base, tenantId, agentId, zproInstanceId, ticketId, threadId } =
    params;

  // Scoped DB read only (no network) — mirrors src/graph/prepare.ts's own tx boundary: MCP
  // connect/discover and the toolpack/RAG/HTTP tool builds happen AFTER this closes.
  const { conversationId, selections } = await runScopedOn(
    base,
    sysCtx(tenantId),
    async (db) => {
      const conversation = await db.zproConversation.findUnique({
        where: { zproInstanceId_ticketId: { zproInstanceId, ticketId } },
        select: { id: true },
      });
      const selections = await loadToolSelections(db, agentId);
      return { conversationId: conversation?.id ?? null, selections };
    },
  );

  const resolveCredential = (ref: string) =>
    resolveInjectableCredential(base, tenantId, ref);

  const toolpackTools =
    selections.integrationSelections.length > 0
      ? buildToolpackTools(selections.integrationSelections, {
          tenantId,
          base,
          threadId,
          contactDbId: conversationId,
          resolveCredential,
        })
      : [];

  const ragTools = buildRagTools(
    {
      tenantId,
      base,
      knowledgeBaseIds: selections.ragConfig?.knowledgeBaseIds ?? [],
      knowledgeBases: selections.ragConfig?.knowledgeBases,
      threadId,
      maxDistance: params.maxDistance ?? selections.ragConfig?.maxDistance,
    },
    selections.ragConfig?.tools,
  );

  const httpTools = buildHttpTools(selections.httpToolDefs, {
    resolveCredential,
    // Same tie to the SSRF dev-escape as Chatwoot (src/graph/prepare.ts): prod stays https-only,
    // dev (SSRF_ALLOW_PRIVATE_TARGETS on by default) allows an operator's local HTTP tool to work.
    allowHttp: config.ssrf.allowPrivateTargets,
    context: {
      ticket_id: String(ticketId),
      ...(params.contactName ? { contact_name: params.contactName } : {}),
      ...(params.contactNumber ? { contact_phone: params.contactNumber } : {}),
      ...(params.companyName ? { company_name: params.companyName } : {}),
    },
  });

  // The only network call in this function — deliberately OUTSIDE the scoped read above.
  const mcpTools = await loadMcpToolsForAgent(
    tenantId,
    selections.mcpSelections,
    {
      refreshCredential: (t, ref) => resolveInjectableCredential(base, t, ref),
    },
  );

  // Utility-only NATIVE tools (calculator, get_current_time) — same allowlist + fake-client
  // pattern the playground uses for context-free tools (src/modules/playground/service.ts):
  // `client: {} as ChatwootClient` is never touched by either tool's implementation.
  const utilityTools = buildNativeTools(
    { client: {} as ChatwootClient, conversationId: 0, tenantId, base },
    utilityNativeAllow(),
  );

  return {
    tools: [
      ...toolpackTools,
      ...ragTools,
      ...httpTools,
      ...mcpTools,
      ...utilityTools,
    ],
    conversationId,
    grounded: !!selections.ragConfig?.tools.includes("search_knowledge"),
  };
}
