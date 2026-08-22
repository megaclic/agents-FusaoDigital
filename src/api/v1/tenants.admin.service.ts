import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  TENANT_SELECT,
  type TenantCreate,
  type TenantDto,
  type TenantUpdate,
  toDto,
} from "./tenants.service";

// Tenant mutation service. Create and delete provision/deprovision a tenant in the fleet — there is
// no tenant scope to run them under (create: the row doesn't exist yet; delete: SUPER_ADMIN only, by
// route contract) — so both are asSuperAdminOn, gated by an explicit role check since they run
// outside any route guard when called directly (MCP, tests). Update follows the same
// SUPER_ADMIN-vs-scoped split as tenants.service's getTenant/listTenants: a SUPER_ADMIN can rename
// any tenant (asSuperAdminOn), while a TENANT_ADMIN can only rename its own (runScopedOn — RLS keys
// the tenants policy on id = app.tenant_id, so a cross-tenant id resolves to 0 rows updated → P2025 →
// NotFoundError, never leaking whether the id exists). The single tenant created at /setup is
// unaffected by any of this.

function isUniqueSlugViolation(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
}

function isNotFound(err: unknown): boolean {
  return (
    err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2025"
  );
}

export async function createTenant(
  ctx: TenantContext,
  input: TenantCreate,
  base: PrismaClient = basePrisma,
): Promise<TenantDto> {
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
  try {
    const tenant = await asSuperAdminOn(base, (db) =>
      db.tenant.create({
        data: { name: input.name, slug: input.slug },
        select: TENANT_SELECT,
      }),
    );
    return toDto(tenant);
  } catch (err) {
    if (isUniqueSlugViolation(err)) {
      throw new ConflictError(
        "This slug is already in use",
        "errors.tenantSlugInUse",
      );
    }
    throw err;
  }
}

export async function updateTenant(
  ctx: TenantContext,
  id: bigint,
  patch: TenantUpdate,
  base: PrismaClient = basePrisma,
): Promise<TenantDto> {
  try {
    const tenant =
      ctx.role === "SUPER_ADMIN"
        ? await asSuperAdminOn(base, (db) =>
            db.tenant.update({
              where: { id },
              data: patch,
              select: TENANT_SELECT,
            }),
          )
        : await runScopedOn(base, ctx, (db) =>
            db.tenant.update({
              where: { id },
              data: patch,
              select: TENANT_SELECT,
            }),
          );
    return toDto(tenant);
  } catch (err) {
    if (isNotFound(err)) {
      throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
    }
    throw err;
  }
}

export async function deleteTenant(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  if (ctx.role !== "SUPER_ADMIN") throw new ForbiddenError();
  try {
    await asSuperAdminOn(base, (db) => db.tenant.delete({ where: { id } }));
  } catch (err) {
    if (isNotFound(err)) {
      throw new NotFoundError("Tenant not found", "errors.tenantNotFound");
    }
    throw err;
  }
}
