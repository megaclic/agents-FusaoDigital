import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/client/components/Button";
import { Input } from "@/client/components/Input";
import {
  Modal,
  ModalCancelButton,
  type ModalController,
  useOnModalOpen,
} from "@/client/components/Modal";
import { notifyTenantsChanged } from "@/client/lib/activeTenant";
import { api } from "@/client/lib/api";
import type { ApiErrorPayload } from "@/client/lib/types";

// SUPER_ADMIN "create tenant" modal, opened from the header TenantSwitcher and the Admin Tenants
// page. Mirrors tenants.service's tenantCreateSchema (name 1-200 chars, slug DNS/URL-safe).
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const labelCls = "mb-1 block font-medium text-sm text-text-primary";

export function CreateTenantModal({
  modal,
  onCreated,
}: {
  modal: ModalController;
  onCreated: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const isDirty = name.trim() !== "" || slug.trim() !== "";
  const slugValid = slug === "" || SLUG_PATTERN.test(slug);

  useOnModalOpen(modal, () => {
    setName("");
    setSlug("");
    setError("");
  });

  const handleSubmit = async () => {
    setError("");
    setLoading(true);
    try {
      const { data, error: apiError } = await api.api.v1.tenants.post({
        name: name.trim(),
        slug: slug.trim(),
      });
      if (apiError) {
        setError(
          (apiError.value as ApiErrorPayload)?.error ||
            t("tenant.createError", "Erro ao criar tenant"),
        );
        return;
      }
      if (data?.tenant) {
        notifyTenantsChanged();
        onCreated();
        modal.close();
      }
    } catch {
      setError(t("tenant.createError", "Erro ao criar tenant"));
    } finally {
      setLoading(false);
    }
  };

  const canSubmit =
    !loading && name.trim() !== "" && slug.trim() !== "" && slugValid;

  return (
    <Modal
      modal={modal}
      title={t("tenant.createTitle", "Criar novo tenant")}
      size="sm"
      unsavedChanges={isDirty}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSubmit) void handleSubmit();
        }}
      >
        {error && (
          <div className="rounded-lg border border-error bg-error-soft px-4 py-2 text-error text-sm">
            {error}
          </div>
        )}
        <div>
          <label htmlFor="tenant-name" className={labelCls}>
            {t("tenant.nameLabel", "Nome")}
          </label>
          <Input
            id="tenant-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            disabled={loading}
            maxLength={200}
          />
        </div>
        <div>
          <label htmlFor="tenant-slug" className={labelCls}>
            {t("tenant.slugLabel", "Identificador (slug)")}
          </label>
          <Input
            id="tenant-slug"
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase())}
            required
            disabled={loading}
            maxLength={100}
            pattern={SLUG_PATTERN.source}
            error={!slugValid}
            helperText={t(
              "tenant.slugHelp",
              "Apenas letras minúsculas, números e hífens",
            )}
          />
        </div>
        <div className="flex justify-end gap-2">
          <ModalCancelButton disabled={loading} />
          <Button type="submit" loading={loading} disabled={!canSubmit}>
            {t("tenant.create", "Create tenant")}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
