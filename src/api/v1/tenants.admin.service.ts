import { Prisma, type PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { asSuperAdminOn, runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  assertTenantCreatable,
  assertTenantUpdatable,
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
  // Asked here too, not only by the MCP preview (write-fleet.ts's tenantCreate): a REST body
  // already carries this shape (Elysia's `t.Object` schema refuses an empty name/slug before the
  // controller is even reached), but MCP's apply path calls straight into this function with
  // nothing upstream re-checking it, so the core has to be the one place both transports agree.
  const data = assertTenantCreatable(input);
  try {
    const tenant = await asSuperAdminOn(base, (db) =>
      db.tenant.create({
        data: { name: data.name, slug: data.slug },
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
  // Same reasoning as createTenant above: the REST body schema already refuses an empty name, but
  // MCP's apply path (write.ts's tenantUpdate) reaches straight here, so the core re-asks it.
  const data = assertTenantUpdatable(patch);
  try {
    const tenant =
      ctx.role === "SUPER_ADMIN"
        ? await asSuperAdminOn(base, (db) =>
            db.tenant.update({
              where: { id },
              data,
              select: TENANT_SELECT,
            }),
          )
        : await runScopedOn(base, ctx, (db) =>
            db.tenant.update({
              where: { id },
              data,
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
