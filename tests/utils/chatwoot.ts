import type { PrismaClient } from "@/../generated/prisma/client";
import { normalizeChatwootBaseUrl } from "@/modules/chatwoot/management";

export interface SeedChatwootInstanceArgs {
  tenantId: bigint;
  accountId: number;
  // baseUrl + adminToken now live on the parent ChatwootDeployment. Stored as-is: tests pass either a
  // raw marker ("enc") or a real encryptJson(...) blob, depending on whether they decrypt it.
  baseUrl?: string;
  adminToken?: string;
  accountName?: string | null;
  disconnectedAt?: Date | null;
  id?: bigint;
}

// NOTE: `chatwoot_instances (server_key, account_id)` is unique GLOBALLY, not per tenant, and the
// server key is derived from this base URL. Fixtures across the suite reuse a handful of literals
// ("https://chat.example.com", "https://cw.example"), so two suites running at once against the
// shared test database — two worktrees, or a rerun started before the first finished — collide on
// P2002 in whichever file seeds second. The failure surfaces far from its cause and reads like a
// logic bug in code nobody touched.
//
// Stamping the pid into the PATH (not the host) makes concurrent runs disjoint while preserving
// what fixtures actually rely on: two callers passing the same base URL still land on the same
// server key, and different base URLs stay different. Applying it here rather than at the ~37 call
// sites means a new test cannot forget it.
export function withRunNamespace(rawBaseUrl: string): string {
  try {
    const u = new URL(rawBaseUrl);
    u.pathname = `${u.pathname.replace(/\/+$/, "")}/p${process.pid}`;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return `${rawBaseUrl.replace(/\/+$/, "")}/p${process.pid}`;
  }
}

// Seed a Chatwoot account (ChatwootInstance) for a tenant in tests, auto-provisioning the parent
// ChatwootDeployment (one per tenant: base URL + shared token). Reuses the deployment when the tenant
// already has one (tenant_id is UNIQUE), mirroring the production "one deployment, N accounts" model.
// Returns the created instance row. Pass the same db handle the test uses (super-admin or scoped).
export async function seedChatwootInstance(
  db: PrismaClient,
  args: SeedChatwootInstanceArgs,
) {
  const baseUrl = withRunNamespace(args.baseUrl ?? "https://chat.test.local");
  const adminToken = args.adminToken ?? "enc";
  const deployment = await db.chatwootDeployment.upsert({
    where: { tenantId: args.tenantId },
    create: { tenantId: args.tenantId, baseUrl, adminToken },
    update: {},
    select: { id: true },
  });
  return db.chatwootInstance.create({
    data: {
      ...(args.id !== undefined ? { id: args.id } : {}),
      tenantId: args.tenantId,
      deploymentId: deployment.id,
      accountId: args.accountId,
      serverKey: normalizeChatwootBaseUrl(baseUrl),
      accountName: args.accountName ?? null,
      disconnectedAt: args.disconnectedAt ?? null,
    },
  });
}
