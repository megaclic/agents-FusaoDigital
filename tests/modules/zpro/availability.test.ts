// tests/modules/zpro/availability.test.ts
// DB-backed: resolveZproAvailability resolves the Availability (Business Hours) schedule of the
// agent bound to a Z-PRO instance via ZproAgentBinding (mirrors resolveZproSttConfig/
// resolveZproVisionConfig/resolveZproDebounceConfig's shape) — the piece that was previously missing
// entirely, so a Z-PRO agent answered around the clock no matter what schedule was configured.

import { afterAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/../generated/prisma/client";
import { encryptJson } from "@/api/lib/crypto";
import { resolveZproAvailability } from "@/modules/zpro/availability";

const appUrl = process.env.TEST_APP_DATABASE_URL;
const suUrl = process.env.MIGRATION_DATABASE_URL;
let dbUp = false;
let su: PrismaClient | undefined;
let app: PrismaClient | undefined;
if (appUrl && suUrl) {
  try {
    su = new PrismaClient({
      adapter: new PrismaPg({ connectionString: suUrl }),
    });
    await su.$queryRaw`SELECT 1`;
    app = new PrismaClient({
      adapter: new PrismaPg({ connectionString: appUrl }),
    });
    await app.$queryRaw`SELECT 1`;
    dbUp = true;
  } catch {
    dbUp = false;
  }
}
const appDb = app as PrismaClient;
const suDb = su as PrismaClient;

let tenantId = 0n;

describe.skipIf(!dbUp)("resolveZproAvailability", () => {
  afterAll(async () => {
    await suDb.$disconnect();
    await appDb.$disconnect();
  });

  test("returns the bound agent's configured Business Hours (windows + timezone)", async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproAvail1", slug: `zpro-avail-1-${process.pid}` },
    });
    tenantId = t.id;
    const bh = await suDb.businessHours.create({
      data: {
        tenantId,
        name: "Expediente",
        timezone: "America/Sao_Paulo",
        windows: [{ day: 1, start: "09:00", end: "18:00" }],
        source: "LOCAL",
      },
    });
    const agent = await suDb.agent.create({
      data: {
        tenantId,
        name: "Atendente Z-PRO",
        systemPrompt: "x",
        businessHoursId: bh.id,
      },
    });
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 91,
        instanceName: "ZproAvailInstance1",
      },
    });
    await suDb.zproAgentBinding.create({
      data: { tenantId, zproInstanceId: inst.id, agentId: agent.id },
    });

    const hours = await resolveZproAvailability(tenantId, inst.id, appDb);
    expect(hours).toEqual({
      windows: [{ day: 1, start: "09:00", end: "18:00" }],
      timezone: "America/Sao_Paulo",
    });

    for (const table of [
      "zpro_agent_bindings",
      "zpro_instances",
      "agents",
      "business_hours",
    ]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${tenantId}`,
      );
    }
    await suDb.$executeRawUnsafe(`DELETE FROM tenants WHERE id = ${tenantId}`);
  });

  test("returns null (always on) when the bound agent has no Business Hours configured", async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproAvail2", slug: `zpro-avail-2-${process.pid}` },
    });
    const localTenantId = t.id;
    const agent = await suDb.agent.create({
      data: {
        tenantId: localTenantId,
        name: "Atendente sem horário",
        systemPrompt: "x",
      },
    });
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId: localTenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 92,
        instanceName: "ZproAvailInstance2",
      },
    });
    await suDb.zproAgentBinding.create({
      data: {
        tenantId: localTenantId,
        zproInstanceId: inst.id,
        agentId: agent.id,
      },
    });

    expect(
      await resolveZproAvailability(localTenantId, inst.id, appDb),
    ).toBeNull();

    for (const table of ["zpro_agent_bindings", "zpro_instances", "agents"]) {
      await suDb.$executeRawUnsafe(
        `DELETE FROM ${table} WHERE tenant_id = ${localTenantId}`,
      );
    }
    await suDb.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = ${localTenantId}`,
    );
  });

  test("returns null for an instance with no bound agent", async () => {
    const t = await suDb.tenant.create({
      data: { name: "ZproAvail3", slug: `zpro-avail-3-${process.pid}` },
    });
    const localTenantId = t.id;
    const inst = await suDb.zproInstance.create({
      data: {
        tenantId: localTenantId,
        baseUrl: "https://api.fusaobotcrm.com.br",
        apiId: "TEST_API_ID",
        bearerToken: encryptJson("test-token"),
        whatsappId: 93,
        instanceName: "ZproAvailInstance3Unbound",
      },
    });

    expect(
      await resolveZproAvailability(localTenantId, inst.id, appDb),
    ).toBeNull();

    await suDb.$executeRawUnsafe(
      `DELETE FROM zpro_instances WHERE tenant_id = ${localTenantId}`,
    );
    await suDb.$executeRawUnsafe(
      `DELETE FROM tenants WHERE id = ${localTenantId}`,
    );
  });
});
