import { z } from "zod";
import type { Prisma, PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { AppError, NotFoundError } from "@/lib/errors";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import {
  isOpenAt,
  isWindowOrdered,
  parseWindows,
  type WindowSpec,
  windowSpecSchema,
} from "./hours";

// Business-hours schedules (per-tenant). An agent references one via Agent.businessHoursId; the
// follow-up scheduler and out-of-hours behavior use the windows + timezone. API-created rows are
// always source=LOCAL; CHATWOOT_MIRROR rows are written by the inbox sync (a separate path).

export interface BusinessHoursDto {
  id: string;
  name: string;
  timezone: string;
  windows: WindowSpec[];
  source: string;
  createdAt: Date;
  updatedAt: Date;
}

const SELECT = {
  id: true,
  name: true,
  timezone: true,
  windows: true,
  source: true,
  createdAt: true,
  updatedAt: true,
} as const;

function toDto(r: {
  id: bigint;
  name: string;
  timezone: string;
  windows: unknown;
  source: string;
  createdAt: Date;
  updatedAt: Date;
}): BusinessHoursDto {
  return {
    id: String(r.id),
    name: r.name,
    timezone: r.timezone,
    windows: parseWindows(r.windows),
    source: r.source,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

function assertValidTimezone(tz: string): void {
  try {
    // Throws RangeError for an unknown IANA zone.
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new AppError(
      `invalid timezone: ${tz}`,
      400,
      "errors.invalidTimezone",
    );
  }
}

// Reject windows whose end is not strictly after their start: such a window can
// never be open (overnight windows are not supported) and would silently behave
// as a no-op. The editor prevents this client-side; this guards the REST/MCP paths.
function assertValidWindows(windows: WindowSpec[]): void {
  for (const w of windows) {
    if (!isWindowOrdered(w)) {
      throw new AppError(
        `invalid window for day ${w.day}: end (${w.end}) must be after start (${w.start})`,
        400,
        "errors.invalidBusinessHoursWindow",
      );
    }
  }
}

export const businessHoursCreateSchema = z
  .object({
    name: z.string().min(1).max(200),
    timezone: z.string().min(1).max(64).optional(),
    windows: z.array(windowSpecSchema).max(200).optional(),
  })
  .strict();
export type BusinessHoursCreate = z.infer<typeof businessHoursCreateSchema>;

export const businessHoursUpdateSchema = businessHoursCreateSchema
  .partial()
  .strict();
export type BusinessHoursUpdate = z.infer<typeof businessHoursUpdateSchema>;

export async function listBusinessHours(
  ctx: TenantContext,
  base: PrismaClient = basePrisma,
): Promise<BusinessHoursDto[]> {
  const rows = await runScopedOn(base, ctx, (db) =>
    db.businessHours.findMany({ select: SELECT, orderBy: { name: "asc" } }),
  );
  return rows.map(toDto);
}

export async function getBusinessHours(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<BusinessHoursDto> {
  const row = await runScopedOn(base, ctx, (db) =>
    db.businessHours.findUnique({ where: { id }, select: SELECT }),
  );
  if (!row) {
    throw new NotFoundError(
      "business hours not found",
      "errors.businessHoursNotFound",
    );
  }
  return toDto(row);
}

export async function createBusinessHours(
  ctx: TenantContext,
  input: BusinessHoursCreate,
  base: PrismaClient = basePrisma,
): Promise<BusinessHoursDto> {
  if (ctx.tenantId === null) throw new AppError("tenant required", 400);
  const tenantId = ctx.tenantId;
  const data = businessHoursCreateSchema.parse(input);
  if (data.timezone) assertValidTimezone(data.timezone);
  if (data.windows) assertValidWindows(data.windows);
  return runScopedOn(base, ctx, async (db) => {
    const row = await db.businessHours.create({
      data: {
        tenantId,
        name: data.name,
        ...(data.timezone ? { timezone: data.timezone } : {}),
        windows: (data.windows ?? []) as Prisma.InputJsonValue,
        source: "LOCAL",
      },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function updateBusinessHours(
  ctx: TenantContext,
  id: bigint,
  patch: BusinessHoursUpdate,
  base: PrismaClient = basePrisma,
): Promise<BusinessHoursDto> {
  const data = businessHoursUpdateSchema.parse(patch);
  if (data.timezone) assertValidTimezone(data.timezone);
  if (data.windows) assertValidWindows(data.windows);
  return runScopedOn(base, ctx, async (db) => {
    const current = await db.businessHours.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!current) {
      throw new NotFoundError(
        "business hours not found",
        "errors.businessHoursNotFound",
      );
    }
    await db.businessHours.update({
      where: { id },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.timezone !== undefined ? { timezone: data.timezone } : {}),
        ...(data.windows !== undefined
          ? { windows: data.windows as Prisma.InputJsonValue }
          : {}),
      },
    });
    const row = await db.businessHours.findUniqueOrThrow({
      where: { id },
      select: SELECT,
    });
    return toDto(row);
  });
}

export async function deleteBusinessHours(
  ctx: TenantContext,
  id: bigint,
  base: PrismaClient = basePrisma,
): Promise<void> {
  await runScopedOn(base, ctx, async (db) => {
    // Detach any agent pointing here (plain reference, no FK cascade) before removing.
    await db.agent.updateMany({
      where: { businessHoursId: id },
      data: { businessHoursId: null },
    });
    const res = await db.businessHours.deleteMany({ where: { id } });
    if (res.count === 0) {
      throw new NotFoundError(
        "business hours not found",
        "errors.businessHoursNotFound",
      );
    }
  });
}

// Reactive availability decision: the agent's business hours (the "Disponibilidade" schedule) gate
// replies to the customer. Outside the configured window the agent stays SILENT; the operator gets a
// one-shot private note (postNote true only the first time, mirroring the test-mode notice). No
// schedule / empty windows → always on (never silenced). Pure so it is unit-testable. Channel-
// agnostic by design — shared verbatim by both src/modules/chatwoot/webhook.ts and
// src/modules/zpro/* rather than duplicated, since the two channel integrations never import from
// each other directly (see docs/zpro.md's module map).
export function outOfHoursGate(
  hours: { windows: WindowSpec[]; timezone: string } | null,
  now: Date,
  noticeAlreadySent: boolean,
): { silence: boolean; postNote: boolean } {
  if (!hours || hours.windows.length === 0) {
    return { silence: false, postNote: false };
  }
  if (isOpenAt(hours.windows, hours.timezone, now)) {
    return { silence: false, postNote: false };
  }
  return { silence: true, postNote: !noticeAlreadySent };
}
