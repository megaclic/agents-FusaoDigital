// src/modules/zpro/availability.ts
// Resolves the Availability (Business Hours) schedule for the agent bound to a Z-PRO instance —
// same shape as resolveZproSttConfig/resolveZproVisionConfig/resolveZproDebounceConfig (scoped read
// via ZproAgentBinding, no network). null means "always on" (unbound agent, or no schedule
// configured) — outOfHoursGate (src/modules/business-hours/service.ts, shared with Chatwoot) already
// treats null as never-silence. Reads the WHOLE schedule (windows + date exceptions), not just the
// weekly grid — readSchedule (not the narrower resolveBusinessHoursById) is what keeps a holiday/
// shutdown exception honored by the Z-PRO gate too, matching Chatwoot's own resolveBusinessHours
// closure in graph/prepare.ts's buildToolset.

import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { runScopedOn } from "@/lib/tenancy";
import type { Schedule } from "@/modules/business-hours/hours";
import { readSchedule } from "@/modules/business-hours/service";
import { sysCtx } from "./ctx";

export async function resolveZproAvailability(
  tenantId: bigint,
  zproInstanceId: bigint,
  base: PrismaClient = basePrisma,
): Promise<Schedule | null> {
  const businessHoursId = await runScopedOn(
    base,
    sysCtx(tenantId),
    async (db) => {
      const binding = await db.zproAgentBinding.findFirst({
        where: { tenantId, zproInstanceId },
        select: { agentId: true },
      });
      if (!binding) return null;
      const agent = await db.agent.findUnique({
        where: { id: binding.agentId },
        select: { businessHoursId: true },
      });
      return agent?.businessHoursId ?? null;
    },
  );
  if (businessHoursId === null) return null;
  return readSchedule(sysCtx(tenantId), String(businessHoursId), base);
}
