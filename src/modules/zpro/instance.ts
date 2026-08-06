// src/modules/zpro/instance.ts
// Tipo de configuração de uma instância Z-PRO vinculada a um agente.
// A persistência (Prisma) será adicionada na Fase 2.

export interface ZproInstanceConfig {
  id: string; // uuid interno do FusaoDigital agents
  tenantId: string; // tenant do FusaoDigital agents
  agentId: string; // agente LangGraph associado
  baseUrl: string; // ex: "https://api.fusaobotcrm.com.br"
  apiId: string; // ApiID do Z-PRO (path param)
  bearerToken: string; // token Bearer da API Z-PRO
  whatsappId: number; // ID do canal no Z-PRO (whatsapp.id do payload)
  active: boolean;
}

/**
 * Monta o ApiID a partir do contexto do webhook.
 * Por enquanto retorna o apiId configurado — na Fase 2 vai buscar do banco
 * com base no whatsappId ou tenantId do payload.
 */
export function resolveApiId(config: ZproInstanceConfig): string {
  return config.apiId;
}
