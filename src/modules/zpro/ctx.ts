// src/modules/zpro/ctx.ts
// TenantContext canônico para acesso ao banco fora de uma requisição autenticada (webhook,
// runtime, mirror): o tenant já é conhecido (resolvido via whatsappId), então usamos
// TENANT_ADMIN como papel do sistema em vez de bypassar RLS com asSuperAdminOn.

import type { TenantContext } from "@/lib/tenancy";

export function sysCtx(tenantId: bigint): TenantContext {
  return { tenantId, userId: null, role: "TENANT_ADMIN" };
}
