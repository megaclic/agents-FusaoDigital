import { Palette, Trash2, Upload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router";
import {
  Button,
  Card,
  FilterPills,
  FormField,
  Input,
  Skeleton,
  SwitchField,
  useToast,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { useBranding } from "@/client/contexts/BrandingContext";
import { api } from "@/client/lib/api";

// Branding tab: white-label editor for the GLOBAL identity (name, colors, footer links, logo,
// favicon). Unlike upstream fazer.ai agents, this fork does NOT gate branding writes behind a Pro
// edition (see branding.admin.service.ts) — the form below talks directly to
// PATCH /v1/branding + PUT/DELETE /v1/branding/asset/:kind/:variant. `useBranding()` is the same
// context the Sidebar footer reads from, so calling `refresh()` after a save/upload/remove
// propagates immediately without a page reload.

type AssetKind = "logo" | "favicon";
type AssetVariant = "dark" | "light";
type ColorMode = "SIMPLE" | "ADVANCED";

const ASSET_COMBOS: { kind: AssetKind; variant: AssetVariant }[] = [
  { kind: "logo", variant: "dark" },
  { kind: "logo", variant: "light" },
  { kind: "favicon", variant: "dark" },
  { kind: "favicon", variant: "light" },
];

const DEFAULT_BRAND_COLOR = "#4f46e5";
const ASSET_ACCEPT =
  "image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon";

function comboKey(kind: AssetKind, variant: AssetVariant): string {
  return `${kind}-${variant}`;
}

export function AdminBrandingPage() {
  const { t } = useTranslation();
  const { user } = useAuth();
  const { showToast } = useToast();
  const { config, ready, refresh } = useBranding();

  const [brandName, setBrandName] = useState("");
  const [colorMode, setColorMode] = useState<ColorMode>("SIMPLE");
  const [brandColor, setBrandColor] = useState(DEFAULT_BRAND_COLOR);
  const [siteUrl, setSiteUrl] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [hideGithubLink, setHideGithubLink] = useState(false);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<Record<string, boolean>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // Sync local draft from the resolved config whenever it (re)loads.
  useEffect(() => {
    if (!config) return;
    setBrandName(config.brandName ?? "");
    setColorMode(config.colorMode);
    setBrandColor(config.brandColor ?? DEFAULT_BRAND_COLOR);
    setSiteUrl(config.siteUrl ?? "");
    setSupportEmail(config.supportEmail ?? "");
    setHideGithubLink(config.hideGithubLink);
  }, [config]);

  // Identity is fleet-global; a tenant admin has no business here.
  if (user && user.role !== "SUPER_ADMIN") {
    return <Navigate to="/admin/users" replace />;
  }

  async function handleSave() {
    setSaving(true);
    try {
      const { error } = await api.api.v1.branding.patch({
        brandName: brandName.trim() ? brandName.trim() : null,
        colorMode,
        brandColor: brandColor.trim() ? brandColor.trim() : null,
        siteUrl: siteUrl.trim() ? siteUrl.trim() : null,
        supportEmail: supportEmail.trim() ? supportEmail.trim() : null,
        hideGithubLink,
      });
      if (error) {
        showToast(
          t("branding.savedError", "Failed to save branding settings."),
          "error",
        );
        return;
      }
      await refresh();
      showToast(t("branding.savedOk", "Branding settings saved."), "success");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpload(kind: AssetKind, variant: AssetVariant, file: File) {
    const key = comboKey(kind, variant);
    setUploading((prev) => ({ ...prev, [key]: true }));
    try {
      const { error } = await api.api.v1.branding
        .asset({ kind })({ variant })
        .put({ file });
      if (error) {
        showToast(t("branding.uploadError", "Failed to upload the file."), "error");
        return;
      }
      await refresh();
    } finally {
      setUploading((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function handleRemove(kind: AssetKind, variant: AssetVariant) {
    const { error } = await api.api.v1.branding
      .asset({ kind })({ variant })
      .delete();
    if (error) {
      showToast(t("branding.uploadError", "Failed to upload the file."), "error");
      return;
    }
    await refresh();
  }

  return (
    <div className="space-y-6 pt-2">
      <header className="flex items-center gap-3">
        <Palette className="h-6 w-6 text-accent" aria-hidden="true" />
        <div>
          <h1 className="font-semibold text-text-primary text-xl">
            {t("branding.title", "Branding")}
          </h1>
          <p className="mt-0.5 text-sm text-text-muted">
            {t(
              "branding.subtitle",
              "Customize the app's global appearance (name, colors, logo, favicon).",
            )}
          </p>
        </div>
      </header>

      {!ready ? (
        <div role="status" className="space-y-4">
          <span className="sr-only">{t("common.loading", "Loading…")}</span>
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <Card className="space-y-4">
            <h2 className="font-medium text-sm text-text-primary">
              {t("branding.identityTitle", "Identity")}
            </h2>
            <FormField
              label={t("branding.brandName", "Brand name")}
              hint={t(
                "branding.brandNameHint",
                "Shown in the browser tab title and the login page footer.",
              )}
            >
              <Input
                value={brandName}
                onChange={(e) => setBrandName(e.target.value)}
                placeholder="FusaoDigital agents"
                maxLength={64}
              />
            </FormField>
          </Card>

          <Card className="space-y-4">
            <h2 className="font-medium text-sm text-text-primary">
              {t("branding.colorsTitle", "Colors")}
            </h2>
            <FormField label={t("branding.colorMode", "Color mode")} group>
              <FilterPills
                items={[
                  { key: "SIMPLE", label: t("branding.colorModeSimple", "Simple") },
                  {
                    key: "ADVANCED",
                    label: t("branding.colorModeAdvanced", "Advanced"),
                  },
                ]}
                value={colorMode}
                onChange={(key) => setColorMode(key as ColorMode)}
                aria-label={t("branding.colorMode", "Color mode")}
              />
            </FormField>
            {colorMode === "SIMPLE" ? (
              <FormField label={t("branding.brandColor", "Brand color")}>
                <div className="flex items-center gap-3">
                  <input
                    type="color"
                    value={brandColor}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="h-9 w-14 cursor-pointer rounded border border-border bg-bg-tertiary"
                    aria-label={t("branding.brandColor", "Brand color")}
                  />
                  <Input
                    value={brandColor}
                    onChange={(e) => setBrandColor(e.target.value)}
                    className="max-w-40"
                  />
                </div>
              </FormField>
            ) : (
              // TODO: dedicated ADVANCED-mode editor for tokensLight/tokensDark (per-theme token
              // maps) and a live color preview. For now ADVANCED mode is accepted by the API but
              // has no UI here.
              <p className="text-sm text-text-muted">
                {t(
                  "branding.colorModeAdvancedComingSoon",
                  "The advanced per-theme token editor is coming soon.",
                )}
              </p>
            )}
          </Card>

          <Card className="space-y-4">
            <h2 className="font-medium text-sm text-text-primary">
              {t("branding.footerTitle", "Sidebar footer")}
            </h2>
            <FormField label={t("branding.siteUrl", "Website URL")}>
              <Input
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="https://fusaodigital.com.br"
              />
            </FormField>
            <FormField label={t("branding.supportEmail", "Support e-mail")}>
              <Input
                value={supportEmail}
                onChange={(e) => setSupportEmail(e.target.value)}
                placeholder="contato@fusaodigital.com.br"
              />
            </FormField>
            <SwitchField
              checked={hideGithubLink}
              onCheckedChange={setHideGithubLink}
              label={t("branding.hideGithubLink", "Hide GitHub link")}
            />
          </Card>

          <Card className="space-y-4">
            <h2 className="font-medium text-sm text-text-primary">
              {t("branding.assetsTitle", "Logo and favicon")}
            </h2>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {ASSET_COMBOS.map(({ kind, variant }) => {
                const key = comboKey(kind, variant);
                const exists =
                  kind === "logo"
                    ? (config?.logo[variant] ?? false)
                    : (config?.favicon[variant] ?? false);
                const kindLabel =
                  kind === "logo"
                    ? t("branding.logoLabel", "Logo")
                    : t("branding.faviconLabel", "Favicon");
                const variantLabel =
                  variant === "dark"
                    ? t("branding.darkVariant", "Dark")
                    : t("branding.lightVariant", "Light");
                return (
                  <div
                    key={key}
                    className="flex items-center gap-3 rounded-lg border border-border p-3"
                  >
                    <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-bg-tertiary">
                      {exists && config ? (
                        <img
                          src={`/api/v1/branding/asset/${kind}/${variant}?v=${config.version}`}
                          alt=""
                          className="h-full w-full object-contain"
                        />
                      ) : (
                        <Palette
                          className="h-5 w-5 text-text-muted"
                          aria-hidden="true"
                        />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm text-text-primary">
                        {`${kindLabel} · ${variantLabel}`}
                      </p>
                      <input
                        ref={(el) => {
                          fileInputRefs.current[key] = el;
                        }}
                        type="file"
                        accept={ASSET_ACCEPT}
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = "";
                          if (file) void handleUpload(kind, variant, file);
                        }}
                      />
                      <div className="mt-1.5 flex items-center gap-2">
                        <Button
                          variant="secondary"
                          size="sm"
                          loading={uploading[key]}
                          onClick={() => fileInputRefs.current[key]?.click()}
                        >
                          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("branding.upload", "Upload")}
                        </Button>
                        <Button
                          variant="secondary"
                          size="sm"
                          disabled={!exists}
                          onClick={() => handleRemove(kind, variant)}
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          {t("branding.remove", "Remove")}
                        </Button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          <div className="flex justify-end">
            <Button onClick={handleSave} loading={saving}>
              {t("branding.save", "Save")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
