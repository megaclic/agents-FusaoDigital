import { unlink } from "node:fs/promises";
import prisma from "@/api/lib/prisma";
import { isValidColorToken, sanitizeBranding } from "@/lib/branding";
import { AppError } from "@/lib/errors";
import {
  ALLOWED_ASSET_TYPES,
  ASSET_MAX_BYTES,
  type AssetKind,
  type AssetVariant,
  type ColorUpdate,
  EXT_BY_TYPE,
  type GlobalBrandingDto,
  SINGLETON_ID,
  assetPath,
  getGlobalBranding,
  keyColumn,
  sanitizeBrandName,
  sanitizeSiteUrl,
  sanitizeSupportEmail,
} from "./branding.service";

// Branding mutation implementation for this fork (FusaoDigital agents): unlike upstream fazer.ai
// agents, white-label editing is NOT gated behind a Pro edition here — SUPER_ADMIN can write
// colors/name/footer-links/logo/favicon directly. Reads (getGlobalBranding/readBrandingAsset) stay
// public and live in branding.service. Writes go through the base (non-scoped) prisma client since
// AppBranding is a GLOBAL singleton row (id = SINGLETON_ID), not tenant data.

export async function updateBrandingColors(
  input: ColorUpdate,
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
  if ("tokensLight" in input) data.tokensLight = sanitizeBranding(input.tokensLight);
  if ("tokensDark" in input) data.tokensDark = sanitizeBranding(input.tokensDark);

  if ("siteUrl" in input) {
    if (input.siteUrl === null) {
      data.siteUrl = null;
    } else {
      const sanitized = sanitizeSiteUrl(input.siteUrl);
      if (sanitized === null) {
        throw new AppError(
          "Invalid website URL",
          400,
          "errors.invalidSiteUrl",
        );
      }
      data.siteUrl = sanitized;
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

  await prisma.appBranding.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, ...data },
    update: data,
  });

  return getGlobalBranding();
}

export async function setBrandingAsset(
  kind: AssetKind,
  variant: AssetVariant,
  file: {
    type: string;
    size: number;
    arrayBuffer: () => Promise<ArrayBuffer>;
  },
): Promise<GlobalBrandingDto> {
  if (!ALLOWED_ASSET_TYPES.includes(file.type)) {
    throw new AppError(
      "Unsupported image type",
      400,
      "errors.unsupportedImageType",
    );
  }
  if (file.size > ASSET_MAX_BYTES[kind]) {
    throw new AppError("Image is too large", 400, "errors.imageTooLarge");
  }

  const column = keyColumn(kind, variant);
  const existing = await prisma.appBranding.findUnique({
    where: { id: SINGLETON_ID },
  });
  const oldFilename = existing ? (existing[column] as string | null) : null;

  const ext = EXT_BY_TYPE[file.type];
  const filename = `${kind}-${variant}-${Date.now()}.${ext}`;
  await Bun.write(assetPath(filename), await file.arrayBuffer());

  await prisma.appBranding.upsert({
    where: { id: SINGLETON_ID },
    create: { id: SINGLETON_ID, [column]: filename },
    update: { [column]: filename, updatedAt: new Date() },
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
  kind: AssetKind,
  variant: AssetVariant,
): Promise<GlobalBrandingDto> {
  const column = keyColumn(kind, variant);
  const existing = await prisma.appBranding.findUnique({
    where: { id: SINGLETON_ID },
  });
  const filename = existing ? (existing[column] as string | null) : null;

  if (filename) {
    try {
      await unlink(assetPath(filename));
    } catch {
      // ignore
    }
  }

  if (existing) {
    await prisma.appBranding.update({
      where: { id: SINGLETON_ID },
      data: { [column]: null, updatedAt: new Date() },
    });
  }

  return getGlobalBranding();
}
