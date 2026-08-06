// src/api/v1/zpro-admin.controller.ts
// CRUD de instâncias Z-PRO e bindings agente↔instância (per-tenant). TENANT_ADMIN. SEPARATE from
// the public webhook receiver controller (same /v1/zpro prefix; no path overlap: /instances* +
// /webhook-url here vs /webhook there, mirrors chatwootController/chatwootAdminController).
// bearerToken is write-only — never returned in any response.

import { Elysia, t } from "elysia";
import { Prisma } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { doc, errors } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import config from "@/config";
import {
  AppError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { zproWebhookUrl } from "@/modules/zpro/zpro-webhook-mount";

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

// Normalizes to origin only (scheme + host + port) — an operator pasting the FULL Z-PRO API URL
// (e.g. https://api.fusaobotcrm.com.br/v2/api/external/UUID, copied straight from the Z-PRO panel)
// would otherwise get that path baked into ZproClient.endpoint(), which already appends
// /v2/api/external/<apiId> itself; the duplicated path 404s silently. An unparseable value is
// returned trimmed but unchanged — it isn't a valid absolute URL either way, so ZproClient's own
// fetch calls will fail loudly on it rather than us guessing at a fix.
function sanitizeZproBaseUrl(raw: string): string {
  try {
    return new URL(raw.trim()).origin;
  } catch {
    return raw.trim();
  }
}

const INSTANCE_SELECT = {
  id: true,
  baseUrl: true,
  apiId: true,
  whatsappId: true,
  instanceName: true,
  disconnectedAt: true,
  createdAt: true,
  agentBindings: {
    select: { agentId: true, agent: { select: { name: true } } },
  },
} as const;

type InstanceRow = {
  id: bigint;
  baseUrl: string;
  apiId: string;
  whatsappId: number;
  instanceName: string;
  disconnectedAt: Date | null;
  createdAt: Date;
  agentBindings: Array<{ agentId: bigint; agent: { name: string } }>;
};

// DTO de saída de uma instância — bearerToken nunca é incluído.
function instanceToDto(row: InstanceRow) {
  return {
    id: String(row.id),
    baseUrl: row.baseUrl,
    apiId: row.apiId,
    whatsappId: row.whatsappId,
    instanceName: row.instanceName,
    active: row.disconnectedAt === null,
    createdAt: row.createdAt.toISOString(),
    agentBindings: row.agentBindings.map((b) => ({
      agentId: String(b.agentId),
      agentName: b.agent.name,
    })),
  };
}

export const zproAdminController = new Elysia({
  prefix: "/v1/zpro",
  tags: ["Channels"],
})
  .use(tenancyPlugin)
  .get(
    "/instances",
    async ({ tenantContext }) => {
      const ctx = ctxOrThrow(tenantContext);
      const tenantId = ctx.tenantId as bigint;
      const rows = await runScopedOn(basePrisma, ctx, (db) =>
        db.zproInstance.findMany({
          where: { tenantId },
          select: INSTANCE_SELECT,
          orderBy: { createdAt: "asc" },
        }),
      );
      return { instances: rows.map(instanceToDto) };
    },
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "List Z-PRO instances",
        "Lists all Z-PRO instances for the tenant.",
      ),
      response: errors(401, 403),
    },
  )
  .post(
    "/instances",
    async ({ tenantContext, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const tenantId = ctx.tenantId as bigint;
      const row = await runScopedOn(basePrisma, ctx, async (db) => {
        // (tenantId, whatsappId) is unconditionally unique (not partial on disconnectedAt), so a
        // prior soft-disconnected instance at this whatsappId is revived in place instead of
        // attempting a `create` that would hit the constraint. This is also what makes "disconnect,
        // then add again with fresh credentials" (the only edit path in this phase) actually work.
        const existing = await db.zproInstance.findUnique({
          where: {
            tenantId_whatsappId: { tenantId, whatsappId: body.whatsappId },
          },
          select: { id: true, disconnectedAt: true },
        });
        if (existing && existing.disconnectedAt === null) {
          throw new ConflictError(
            "whatsappId already in use by an active instance",
            "errors.zproWhatsappIdInUse",
          );
        }
        const data = {
          tenantId,
          baseUrl: sanitizeZproBaseUrl(body.baseUrl),
          apiId: body.apiId,
          bearerToken: encryptJson(body.bearerToken),
          whatsappId: body.whatsappId,
          instanceName: body.instanceName,
          disconnectedAt: null,
        };
        return existing
          ? db.zproInstance.update({
              where: { id: existing.id },
              data,
              select: INSTANCE_SELECT,
            })
          : db.zproInstance.create({ data, select: INSTANCE_SELECT });
      });
      return { instance: instanceToDto(row) };
    },
    {
      requireRole: "TENANT_ADMIN",
      body: t.Object({
        baseUrl: t.String({
          minLength: 1,
          description: "Z-PRO base URL, e.g. https://api.fusaobotcrm.com.br",
        }),
        apiId: t.String({ minLength: 1, description: "Z-PRO ApiID." }),
        bearerToken: t.String({
          minLength: 1,
          description:
            "Z-PRO API bearer token; encrypted at rest, never returned.",
        }),
        whatsappId: t.Integer({
          description: "whatsapp.id from the Z-PRO webhook payload.",
        }),
        instanceName: t.String({
          minLength: 1,
          description: "Display name for the instance.",
        }),
      }),
      detail: doc(
        "Create Z-PRO instance",
        "Registers a new Z-PRO instance for the tenant (or revives a matching soft-disconnected one).",
      ),
      response: errors(400, 401, 403, 409),
    },
  )
  .patch(
    "/instances/:id",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = BigInt(params.id);
      const row = await runScopedOn(basePrisma, ctx, async (db) => {
        const existing = await db.zproInstance.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!existing) {
          throw new NotFoundError(
            "zpro instance not found",
            "errors.zproInstanceNotFound",
          );
        }
        const data: Prisma.ZproInstanceUpdateInput = {};
        if (body.baseUrl !== undefined)
          data.baseUrl = sanitizeZproBaseUrl(body.baseUrl);
        if (body.apiId !== undefined) data.apiId = body.apiId;
        if (body.bearerToken !== undefined) {
          data.bearerToken = encryptJson(body.bearerToken);
        }
        if (body.instanceName !== undefined)
          data.instanceName = body.instanceName;
        if (body.whatsappId !== undefined) data.whatsappId = body.whatsappId;
        try {
          return await db.zproInstance.update({
            where: { id },
            data,
            select: INSTANCE_SELECT,
          });
        } catch (err) {
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            err.code === "P2002"
          ) {
            throw new ConflictError(
              "whatsappId already in use by another instance",
              "errors.zproWhatsappIdInUse",
            );
          }
          throw err;
        }
      });
      return { instance: instanceToDto(row) };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Z-PRO instance id (BigInt string)." }),
      }),
      body: t.Object({
        baseUrl: t.Optional(t.String({ minLength: 1 })),
        apiId: t.Optional(t.String({ minLength: 1 })),
        bearerToken: t.Optional(t.String({ minLength: 1 })),
        instanceName: t.Optional(t.String({ minLength: 1 })),
        whatsappId: t.Optional(t.Integer()),
      }),
      detail: doc(
        "Update Z-PRO instance",
        "Updates credentials or name of a Z-PRO instance.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .delete(
    "/instances/:id",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = BigInt(params.id);
      await runScopedOn(basePrisma, ctx, async (db) => {
        const existing = await db.zproInstance.findUnique({
          where: { id },
          select: { id: true },
        });
        if (!existing) {
          throw new NotFoundError(
            "zpro instance not found",
            "errors.zproInstanceNotFound",
          );
        }
        await db.zproInstance.update({
          where: { id },
          data: { disconnectedAt: new Date() },
        });
        // A disconnected instance never triggers a turn again (the webhook resolves by an ACTIVE
        // whatsappId), but a stale binding would silently re-attach if the same whatsappId is
        // revived later via POST /instances — clear it now, mirroring softDisconnectChatwootInstance.
        await db.zproAgentBinding.deleteMany({ where: { zproInstanceId: id } });
      });
      return { success: true };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Z-PRO instance id (BigInt string)." }),
      }),
      detail: doc(
        "Disconnect Z-PRO instance",
        "Soft-disconnects the instance and clears its agent binding (keeps history).",
      ),
      response: errors(400, 401, 403, 404),
    },
  )
  .post(
    "/instances/:id/bind",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const tenantId = ctx.tenantId as bigint;
      const id = BigInt(params.id);
      const row = await runScopedOn(basePrisma, ctx, async (db) => {
        const instance = await db.zproInstance.findUnique({
          where: { id },
          select: { id: true, disconnectedAt: true },
        });
        if (!instance) {
          throw new NotFoundError(
            "zpro instance not found",
            "errors.zproInstanceNotFound",
          );
        }
        if (body.agentId === null) {
          await db.zproAgentBinding.deleteMany({
            where: { zproInstanceId: id, tenantId },
          });
        } else {
          if (instance.disconnectedAt !== null) {
            throw new AppError(
              "this instance is disconnected; reconnect it before assigning an agent",
              409,
              "errors.zproInstanceDisconnected",
            );
          }
          const agentId = BigInt(body.agentId);
          const agent = await db.agent.findUnique({
            where: { id: agentId },
            select: { id: true },
          });
          if (!agent) {
            throw new NotFoundError("agent not found", "errors.agentNotFound");
          }
          // One agent per instance: replace rather than stack, so exactly one binding exists — the
          // runtime's loadZproAgent picks the first (only) match.
          await db.zproAgentBinding.deleteMany({
            where: { zproInstanceId: id, tenantId },
          });
          await db.zproAgentBinding.create({
            data: { tenantId, zproInstanceId: id, agentId },
          });
        }
        return db.zproInstance.findUniqueOrThrow({
          where: { id },
          select: INSTANCE_SELECT,
        });
      });
      return { instance: instanceToDto(row) };
    },
    {
      requireRole: "TENANT_ADMIN",
      params: t.Object({
        id: t.String({ description: "Z-PRO instance id (BigInt string)." }),
      }),
      body: t.Object({
        agentId: t.Union([t.String(), t.Null()], {
          description: "Agent id (BigInt string) to bind, or null to unbind.",
        }),
      }),
      detail: doc(
        "Bind agent to Z-PRO instance",
        "Links or unlinks an agent to a Z-PRO instance.",
      ),
      response: errors(400, 401, 403, 404, 409),
    },
  )
  .get(
    "/webhook-url",
    () => ({ webhookUrl: zproWebhookUrl(config.publicUrl) }),
    {
      requireRole: "TENANT_ADMIN",
      detail: doc(
        "Z-PRO webhook URL",
        "Returns the webhook URL to configure in the Z-PRO panel.",
      ),
      response: errors(401, 403),
    },
  );
