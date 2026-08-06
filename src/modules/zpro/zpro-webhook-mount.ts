// src/modules/zpro/zpro-webhook-mount.ts
// Espelho de src/modules/chatwoot/webhook-mount.ts para o canal Z-PRO.
// Constante única que evita drift entre o controller e qualquer lugar que precise derivar a
// URL de webhook para configurar no painel do Z-PRO (Z-PRO usa um webhook GLOBAL por servidor,
// não um por-instância — não há routeToken aqui, ao contrário do Chatwoot).
export const ZPRO_WEBHOOK_MOUNT = "/api/v1/zpro/webhook";

export function zproWebhookUrl(publicUrl: string): string {
  return `${publicUrl.replace(/\/+$/, "")}${ZPRO_WEBHOOK_MOUNT}`;
}
