import { unlink } from "node:fs/promises";
import type { PrismaClient } from "@/../generated/prisma/client";
import basePrisma from "@/api/lib/prisma";
import { isValidColorToken, sanitizeBranding } from "@/lib/branding";
import { AppError } from "@/lib/errors";
import { asSuperAdminOn, type TenantContext } from "@/lib/tenancy";
import { auditMutationOn } from "@/modules/audit/service";
import {
  ALLOWED_ASSET_FORMATS,
  ALLOWED_ASSET_TYPES,
  ASSET_MAX_BYTES,
  type AssetKind,
  type AssetVariant,
  assetPath,
  type ColorUpdate,
  EXT_BY_TYPE,
  type GlobalBrandingDto,
  getGlobalBranding,
  keyColumn,
  SINGLETON_ID,
  sanitizeBrandName,
  sanitizeRepoUrl,
  sanitizeSiteUrl,
  sanitizeSupportEmail,
} from "./branding.service";

// Branding mutation implementation for this fork (FusaoDigital agents): white-label editing is NOT
// gated behind a Pro edition here — SUPER_ADMIN can write colors/name/footer-links/logo/favicon
// directly. Reads (getGlobalBranding/readBrandingAsset) stay public and live in branding.service.
// Writes go through `asSuperAdminOn` rather than `runScopedOn`: AppBranding is a GLOBAL singleton row
// (id = SINGLETON_ID), not tenant data, so there is no tenant to scope the transaction to — but the
// audit row still needs the fleet role's RLS bypass to insert a `tenant_id IS NULL` row. `ctx` is
// used only to attribute that row to the SUPER_ADMIN who made the change (`auditMutationOn`, pinning
// tenantId null so the change is never filed under whichever tenant the actor happened to have
// selected in the console).

export async function updateBrandingColors(
  ctx: TenantContext,
  input: ColorUpdate,
  base: PrismaClient = basePrisma,
): Promise<GlobalBrandingDto> {
  if (Object.keys(input).length === 0) {
    throw new AppError(
      "No updatable fields provided",
      400,
      "errors.noUpdatableFields",
    );
  }

  const data: Record<string, unknown> = {};

  if ("brandName" in input) {
    data.brandName = sanitizeBrandName(input.brandName);
  }

  if ("colorMode" in input) {
    if (input.colorMode !== "SIMPLE" && input.colorMode !== "ADVANCED") {
      throw new AppError("Invalid color mode", 400, "errors.invalidColorMode");
    }
    data.colorMode = input.colorMode;
  }

  if ("brandColor" in input) {
    if (input.brandColor === null) {
      data.brandColor = null;
    } else if (!isValidColorToken(input.brandColor)) {
      throw new AppError(
        "Invalid color value",
        400,
        "errors.invalidColorToken",
      );
    } else {
      data.brandColor = input.brandColor.trim();
    }
  }

  // NOTE: tokensLight/tokensDark drop unknown keys/invalid values silently (sanitizeBranding's
  // existing contract, shared with the read-side toDto) rather than throwing — the dedicated
  // ADVANCED-mode editor UI is a follow-up; for now malformed entries are just discarded.
  if ("tokensLight" in input)
    data.tokensLight = sanitizeBranding(input.tokensLight);
  if ("tokensDark" in input)
    data.tokensDark = sanitizeBranding(input.tokensDark);

  if ("siteUrl" in input) {
    if (input.siteUrl === null) {
      data.siteUrl = null;
    } else {
      const sanitized = sanitizeSiteUrl(input.siteUrl);
      if (sanitized === null) {
        throw new AppError("Invalid website URL", 400, "errors.invalidSiteUrl");
      }
      data.siteUrl = sanitized;
    }
  }

  if ("repoUrl" in input) {
    if (input.repoUrl === null) {
      data.repoUrl = null;
    } else {
      const sanitized = sanitizeRepoUrl(input.repoUrl);
      if (sanitized === null) {
        throw new AppError("Invalid repo URL", 400, "errors.invalidRepoUrl");
      }
      data.repoUrl = sanitized;
    }
  }

  if ("supportEmail" in input) {
    if (input.supportEmail === null) {
      data.supportEmail = null;
    } else {
      const sanitized = sanitizeSupportEmail(input.supportEmail);
      if (sanitized === null) {
        throw new AppError(
          "Invalid support e-mail",
          400,
          "errors.invalidSupportEmail",
        );
      }
      data.supportEmail = sanitized;
    }
  }

  if ("hideGithubLink" in input) data.hideGithubLink = input.hideGithubLink;

  data.updatedAt = new Date();

  await asSuperAdminOn(base, async (db) => {
    await db.appBranding.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, ...data },
      update: data,
    });
    await auditMutationOn(db, ctx, null, {
      action: "branding.colors_set",
      target: "branding:colors",
      after: data,
    });
  });

  return getGlobalBranding();
}

export async function setBrandingAsset(
  ctx: TenantContext,
  kind: AssetKind,
  variant: AssetVariant,
  file: {
    type: string;
    size: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  },
  base: PrismaClient = basePrisma,
): Promise<GlobalBrandingDto> {
  if (!ALLOWED_ASSET_TYPES.includes(file.type)) {
    throw new AppError(
      `Unsupported image type. Allowed: ${ALLOWED_ASSET_FORMATS}`,
      400,
      "errors.unsupportedImageType",
      { allowed: ALLOWED_ASSET_FORMATS },
    );
  }
  if (file.size > ASSET_MAX_BYTES[kind]) {
    throw new AppError("Image is too large", 400, "errors.imageTooLarge");
  }

  const column = keyColumn(kind, variant);
  const ext = EXT_BY_TYPE[file.type];
  const filename = `${kind}-${variant}-${Date.now()}.${ext}`;
  const bytes = await file.arrayBuffer();

  let oldFilename: string | null = null;
  await asSuperAdminOn(base, async (db) => {
    const existing = await db.appBranding.findUnique({
      where: { id: SINGLETON_ID },
    });
    oldFilename = existing ? (existing[column] as string | null) : null;

    await Bun.write(assetPath(filename), bytes);

    await db.appBranding.upsert({
      where: { id: SINGLETON_ID },
      create: { id: SINGLETON_ID, [column]: filename },
      update: { [column]: filename, updatedAt: new Date() },
    });
    await auditMutationOn(db, ctx, null, {
      action: "branding.asset_set",
      target: `branding:asset:${kind}:${variant}`,
      after: { filename },
    });
  });

  // Best-effort cleanup, AFTER the new file is durably written: an orphaned old file on disk is
  // harmless, losing the new upload because a stray delete failed is not.
  if (oldFilename && oldFilename !== filename) {
    try {
      await unlink(assetPath(oldFilename));
    } catch {
      // ignore
    }
  }

  return getGlobalBranding();
}

export async function clearBrandingAsset(
  ctx: TenantContext,
  kind: AssetKind,
  variant: AssetVariant,
  base: PrismaClient = basePrisma,
): Promise<GlobalBrandingDto> {
  const column = keyColumn(kind, variant);
  let filename: string | null = null;

  await asSuperAdminOn(base, async (db) => {
    const existing = await db.appBranding.findUnique({
      where: { id: SINGLETON_ID },
    });
    filename = existing ? (existing[column] as string | null) : null;

    if (existing) {
      await db.appBranding.update({
        where: { id: SINGLETON_ID },
        data: { [column]: null, updatedAt: new Date() },
      });
    }
    await auditMutationOn(db, ctx, null, {
      action: "branding.asset_clear",
      target: `branding:asset:${kind}:${variant}`,
    });
  });

  if (filename) {
    try {
      await unlink(assetPath(filename));
    } catch {
      // ignore
    }
  }

  return getGlobalBranding();
}
