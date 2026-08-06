// src/client/pages/ZproSection.tsx
// Z-PRO (WhatsApp) section within ChannelsPage. Manages ZproInstance rows: add, bind an agent,
// disconnect. Kept in its own component (not inlined into ChannelsPage) so that page stays
// focused on Chatwoot; loads and errors independently of the Chatwoot section above it.

import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import {
  Check,
  ChevronDown,
  ClipboardCopy,
  Edit2,
  Loader2,
  MessageSquare,
  Plug,
  Plus,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  FormField,
  Input,
  Modal,
  ModalCancelButton,
  Skeleton,
  useModalController,
  useToast,
} from "@/client/components";
import { useAuth } from "@/client/contexts/AuthContext";
import { api } from "@/client/lib/api";
import { isAdminRole } from "@/client/lib/roles";
import { cn } from "@/client/lib/utils";

type InstancesData = Awaited<
  ReturnType<typeof api.api.v1.zpro.instances.get>
>["data"];
type InstanceDto = NonNullable<InstancesData>["instances"][number];
type AgentsData = Awaited<ReturnType<typeof api.api.v1.agents.get>>["data"];
type AgentLite = NonNullable<AgentsData>["agents"][number];
type UpdateInstanceBody = Parameters<
  ReturnType<typeof api.api.v1.zpro.instances>["patch"]
>[0];

const pickerItemCls =
  "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-secondary outline-none transition-colors data-[highlighted]:bg-bg-hover data-[highlighted]:text-text-primary";

// Custom value-picker (Radix dropdown), mirroring ChannelsPage's InboxAgentPicker for visual
// consistency. A Z-PRO instance answers through at most one agent (server replaces on bind).
function ZproAgentPicker({
  value,
  agents,
  onChange,
  label,
}: {
  value: string | null;
  agents: AgentLite[];
  onChange: (agentId: string | null) => Promise<void>;
  label: string;
}) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const current = agents.find((a) => a.id === value) ?? null;

  async function select(next: string | null) {
    if (next === value) return;
    setPending(true);
    try {
      await onChange(next);
    } catch {
      // handled by the caller (toast); `value` is unchanged so the trigger reverts on its own
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <button
          type="button"
          disabled={pending}
          aria-label={label}
          className="flex w-56 shrink-0 items-center justify-between gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2 text-sm text-text-primary focus:border-border-focus focus:outline-none disabled:opacity-60"
        >
          <span className={cn("truncate", { "text-text-muted": !current })}>
            {current ? current.name : t("zpro.noAgent", "No agent")}
          </span>
          {pending ? (
            <Loader2
              className="h-4 w-4 shrink-0 animate-spin text-text-muted"
              aria-hidden="true"
            />
          ) : (
            <ChevronDown
              className="h-4 w-4 shrink-0 text-text-muted"
              aria-hidden="true"
            />
          )}
        </button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content
          align="end"
          sideOffset={4}
          className="z-50 max-h-72 w-56 overflow-y-auto rounded-lg border border-border bg-bg-secondary p-1 shadow-lg"
        >
          <DropdownMenuPrimitive.Item
            className={pickerItemCls}
            onSelect={() => void select(null)}
          >
            <span className="flex-1 truncate">
              {t("zpro.noAgent", "No agent")}
            </span>
            {value === null && (
              <Check
                className="h-4 w-4 shrink-0 text-accent"
                aria-hidden="true"
              />
            )}
          </DropdownMenuPrimitive.Item>
          {agents.map((a) => (
            <DropdownMenuPrimitive.Item
              key={a.id}
              className={pickerItemCls}
              onSelect={() => void select(a.id)}
            >
              <span className="flex-1 truncate">{a.name}</span>
              {value === a.id && (
                <Check
                  className="h-4 w-4 shrink-0 text-accent"
                  aria-hidden="true"
                />
              )}
            </DropdownMenuPrimitive.Item>
          ))}
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

const ZPRO_SKELETON_KEYS = ["zpro-0", "zpro-1"];

function ZproSkeleton() {
  return (
    <Card className="p-0">
      <ul>
        {ZPRO_SKELETON_KEYS.map((key) => (
          <li
            key={key}
            className="flex items-center justify-between gap-4 border-border border-b px-4 py-3 last:border-b-0"
          >
            <div className="flex min-w-0 flex-col gap-1.5">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-9 w-56" />
          </li>
        ))}
      </ul>
    </Card>
  );
}

// biome-ignore lint/plugin/require-page-container: not a routed page — renders inside ChannelsPage, which already wraps the tree in <PageContainer>.
export function ZproSection() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { user } = useAuth();
  const isAdmin = isAdminRole(user?.role);

  const [instances, setInstances] = useState<InstanceDto[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const addModal = useModalController();
  const [form, setForm] = useState({
    baseUrl: "",
    apiId: "",
    bearerToken: "",
    whatsappId: "",
    instanceName: "",
  });
  const [saving, setSaving] = useState(false);

  const editModal = useModalController();
  const [editTarget, setEditTarget] = useState<InstanceDto | null>(null);
  const [editForm, setEditForm] = useState({
    baseUrl: "",
    apiId: "",
    bearerToken: "",
    instanceName: "",
    whatsappId: "",
  });
  const [editSaving, setEditSaving] = useState(false);

  const confirm = useModalController<ConfirmPayload>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [inst, ag] = await Promise.all([
        api.api.v1.zpro.instances.get(),
        api.api.v1.agents.get(),
      ]);
      if (inst.error || !inst.data) {
        setError(true);
        return;
      }
      setInstances([...inst.data.instances]);
      if (ag.data) setAgents([...ag.data.agents]);
    } catch {
      setError(true);
      return;
    } finally {
      setLoading(false);
    }
    try {
      const { data } = await api.api.v1.zpro["webhook-url"].get();
      if (data) setWebhookUrl(data.webhookUrl);
    } catch {
      // ignore — the copy bar just stays hidden
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function openAdd() {
    setForm({
      baseUrl: "",
      apiId: "",
      bearerToken: "",
      whatsappId: "",
      instanceName: "",
    });
    addModal.open();
  }

  async function saveInstance() {
    if (
      !form.baseUrl.trim() ||
      !form.apiId.trim() ||
      !form.bearerToken.trim() ||
      !form.whatsappId.trim() ||
      !form.instanceName.trim()
    ) {
      return;
    }
    setSaving(true);
    try {
      const { data, error: err } = await api.api.v1.zpro.instances.post({
        baseUrl: form.baseUrl.trim(),
        apiId: form.apiId.trim(),
        bearerToken: form.bearerToken.trim(),
        whatsappId: Number(form.whatsappId),
        instanceName: form.instanceName.trim(),
      });
      if (err || !data) throw err ?? new Error("no data");
      showToast(t("zpro.instanceAdded", "Z-PRO instance added."), "success");
      addModal.close();
      void load();
    } catch {
      showToast(
        t("zpro.instanceAddError", "Could not add the instance."),
        "error",
      );
    } finally {
      setSaving(false);
    }
  }

  function openEdit(instance: InstanceDto) {
    setEditTarget(instance);
    setEditForm({
      baseUrl: instance.baseUrl,
      apiId: instance.apiId,
      bearerToken: "", // never pre-filled — the backend never returns the stored token
      instanceName: instance.instanceName,
      whatsappId: String(instance.whatsappId),
    });
    editModal.open();
  }

  async function saveEdit() {
    if (!editTarget) return;
    setEditSaving(true);
    try {
      const patch: UpdateInstanceBody = {};
      if (editForm.baseUrl !== editTarget.baseUrl)
        patch.baseUrl = editForm.baseUrl;
      if (editForm.apiId !== editTarget.apiId) patch.apiId = editForm.apiId;
      if (editForm.instanceName !== editTarget.instanceName) {
        patch.instanceName = editForm.instanceName;
      }
      if (editForm.whatsappId !== String(editTarget.whatsappId)) {
        patch.whatsappId = Number(editForm.whatsappId);
      }
      if (editForm.bearerToken.trim())
        patch.bearerToken = editForm.bearerToken.trim();

      if (Object.keys(patch).length === 0) {
        editModal.close();
        return;
      }

      const { error: err } = await api.api.v1.zpro
        .instances({ id: editTarget.id })
        .patch(patch);
      if (err) throw err;
      showToast(t("zpro.instanceUpdated", "Instance updated."), "success");
      editModal.close();
      void load();
    } catch {
      showToast(
        t("zpro.instanceUpdateError", "Could not update the instance."),
        "error",
      );
    } finally {
      setEditSaving(false);
    }
  }

  function openDisconnect(instance: InstanceDto) {
    confirm.open({
      title: t("zpro.disconnectTitle", "Disconnect instance"),
      message: t(
        "zpro.disconnectWarning",
        'This stops "{{name}}" from answering on WhatsApp. History is kept, and it can be reconnected later by adding it again.',
        { name: instance.instanceName },
      ),
      confirmLabel: t("zpro.disconnectAction", "Disconnect"),
      danger: true,
      onConfirm: async () => {
        const { error: err } = await api.api.v1.zpro
          .instances({ id: instance.id })
          .delete();
        if (err) {
          showToast(
            t(
              "zpro.instanceDisconnectError",
              "Could not disconnect the instance.",
            ),
            "error",
          );
          throw err; // keep the dialog open
        }
        showToast(
          t("zpro.instanceDisconnected", "Instance disconnected."),
          "success",
        );
        void load();
      },
    });
  }

  async function copyWebhookUrl() {
    await navigator.clipboard.writeText(webhookUrl);
    showToast(t("zpro.webhookCopied", "Webhook URL copied!"), "success");
  }

  // Non-optimistic: local state updates only on success, rethrows on failure so the picker's
  // spinner stops without changing the displayed value (mirrors ChannelsPage's bindInbox).
  async function bindAgent(instanceId: string, agentId: string | null) {
    const { error: err } = await api.api.v1.zpro
      .instances({ id: instanceId })
      .bind.post({ agentId });
    if (err) {
      showToast(t("zpro.bindError", "Could not bind the agent."), "error");
      throw err;
    }
    const agentName = agentId
      ? (agents.find((a) => a.id === agentId)?.name ?? "")
      : "";
    setInstances((prev) =>
      prev.map((i) =>
        i.id === instanceId
          ? { ...i, agentBindings: agentId ? [{ agentId, agentName }] : [] }
          : i,
      ),
    );
    showToast(t("zpro.bound", "Instance updated."), "success");
  }

  const formValid =
    form.baseUrl.trim() !== "" &&
    form.apiId.trim() !== "" &&
    form.bearerToken.trim() !== "" &&
    form.whatsappId.trim() !== "" &&
    form.instanceName.trim() !== "";
  const formDirty =
    form.baseUrl !== "" ||
    form.apiId !== "" ||
    form.bearerToken !== "" ||
    form.whatsappId !== "" ||
    form.instanceName !== "";
  const editDirty =
    !!editTarget &&
    (editForm.baseUrl !== editTarget.baseUrl ||
      editForm.apiId !== editTarget.apiId ||
      editForm.bearerToken !== "" ||
      editForm.instanceName !== editTarget.instanceName ||
      editForm.whatsappId !== String(editTarget.whatsappId));

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-medium text-text-primary">
            <MessageSquare className="h-4 w-4 text-accent" aria-hidden="true" />
            {t("zpro.title", "Z-PRO (WhatsApp)")}
          </h2>
          <p className="mt-0.5 text-text-muted text-xs">
            {t(
              "zpro.subtitle",
              "Connect a Z-PRO instance and assign an agent to start answering on WhatsApp.",
            )}
          </p>
        </div>
        {isAdmin && (
          <Button size="sm" onClick={openAdd}>
            <Plus className="h-4 w-4" aria-hidden="true" />
            {t("zpro.addInstance", "Add instance")}
          </Button>
        )}
      </div>

      {webhookUrl && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-bg-tertiary px-3 py-2">
          <span className="min-w-0 flex-1 truncate font-mono text-text-muted text-xs">
            {webhookUrl}
          </span>
          <button
            type="button"
            onClick={copyWebhookUrl}
            aria-label={t("zpro.copyWebhookUrl", "Copy webhook URL")}
            className="shrink-0 text-text-muted transition-colors hover:text-text-primary"
          >
            <ClipboardCopy className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
      )}

      <DataBoundary
        loading={loading}
        error={error}
        onRetry={load}
        skeleton={<ZproSkeleton />}
        isEmpty={instances.length === 0}
        empty={
          <EmptyState
            icon={Plug}
            title={t("zpro.noInstances", "No Z-PRO instance")}
            description={
              isAdmin
                ? t(
                    "zpro.noInstancesDesc",
                    "Add a Z-PRO instance and assign an agent to start answering on WhatsApp.",
                  )
                : t(
                    "zpro.noInstancesTenant",
                    "No Z-PRO instance is configured yet. Ask an administrator to add one.",
                  )
            }
          />
        }
      >
        <Card className="overflow-hidden p-0">
          <ul>
            {instances.map((inst) => {
              const bound = inst.agentBindings[0] ?? null;
              return (
                <li
                  key={inst.id}
                  className="flex flex-wrap items-center justify-between gap-3 border-border border-b px-4 py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-text-primary">
                        {inst.instanceName}
                      </span>
                      {inst.active ? (
                        <Badge variant="success">
                          {t("zpro.active", "Active")}
                        </Badge>
                      ) : (
                        <Badge variant="warning">
                          {t("zpro.inactive", "Inactive")}
                        </Badge>
                      )}
                    </div>
                    <span className="truncate text-text-muted text-xs">
                      {t("zpro.instanceMeta", "{{baseUrl}} · ApiID {{apiId}}", {
                        baseUrl: inst.baseUrl,
                        apiId: inst.apiId,
                      })}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {isAdmin ? (
                      <ZproAgentPicker
                        value={bound?.agentId ?? null}
                        agents={agents}
                        label={t("zpro.bindAgent", "Answering agent")}
                        onChange={(agentId) => bindAgent(inst.id, agentId)}
                      />
                    ) : (
                      <span className="text-text-muted text-xs">
                        {bound
                          ? bound.agentName
                          : t("zpro.noAgent", "No agent")}
                      </span>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => openEdit(inst)}
                        aria-label={t("zpro.editInstance", "Edit instance")}
                        className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-bg-hover hover:text-text-primary"
                      >
                        <Edit2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => openDisconnect(inst)}
                        aria-label={t(
                          "zpro.disconnectTitle",
                          "Disconnect instance",
                        )}
                        className="inline-flex shrink-0 items-center justify-center rounded p-1 text-text-muted transition-colors hover:bg-error/10 hover:text-error"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </DataBoundary>

      <Modal
        modal={addModal}
        unsavedChanges={formDirty}
        title={t("zpro.addInstanceTitle", "Add Z-PRO instance")}
        footer={
          <div className="flex justify-end gap-2">
            <ModalCancelButton disabled={saving} />
            <Button
              onClick={saveInstance}
              loading={saving}
              disabled={!formValid}
            >
              {t("common.save", "Save")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            {t(
              "zpro.addInstanceDesc",
              "Enter the Z-PRO instance credentials. The bearer token is stored encrypted.",
            )}
          </p>
          <FormField label={t("zpro.baseUrl", "Z-PRO base URL")} required>
            <Input
              value={form.baseUrl}
              onChange={(e) =>
                setForm((f) => ({ ...f, baseUrl: e.target.value }))
              }
              placeholder="https://api.fusaobotcrm.com.br"
            />
          </FormField>
          <FormField label={t("zpro.apiId", "ApiID")} required>
            <Input
              value={form.apiId}
              onChange={(e) =>
                setForm((f) => ({ ...f, apiId: e.target.value }))
              }
            />
          </FormField>
          <FormField
            label={t("zpro.bearerToken", "Bearer token")}
            required
            description={t(
              "zpro.bearerTokenHint",
              "Stored encrypted, never shown again.",
            )}
          >
            <Input
              type="password"
              showPasswordToggle
              value={form.bearerToken}
              onChange={(e) =>
                setForm((f) => ({ ...f, bearerToken: e.target.value }))
              }
            />
          </FormField>
          <FormField
            label={t("zpro.whatsappId", "WhatsApp ID")}
            required
            description={t(
              "zpro.whatsappIdHint",
              "The whatsapp.id field from the Z-PRO webhook payload.",
            )}
          >
            <Input
              type="number"
              value={form.whatsappId}
              onChange={(e) =>
                setForm((f) => ({ ...f, whatsappId: e.target.value }))
              }
              placeholder="87"
            />
          </FormField>
          <FormField label={t("zpro.instanceName", "Instance name")} required>
            <Input
              value={form.instanceName}
              onChange={(e) =>
                setForm((f) => ({ ...f, instanceName: e.target.value }))
              }
              placeholder="TesteSindSeg"
            />
          </FormField>
        </div>
      </Modal>

      <Modal
        modal={editModal}
        unsavedChanges={editDirty}
        title={t("zpro.editInstanceTitle", "Edit Z-PRO instance")}
        footer={
          <div className="flex justify-end gap-2">
            <ModalCancelButton disabled={editSaving} />
            <Button onClick={saveEdit} loading={editSaving}>
              {t("common.save", "Save")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-muted">
            {t(
              "zpro.editInstanceDesc",
              "Leave the bearer token field empty to keep the current token.",
            )}
          </p>
          <FormField label={t("zpro.baseUrl", "Z-PRO base URL")} required>
            <Input
              value={editForm.baseUrl}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, baseUrl: e.target.value }))
              }
              placeholder="https://api.fusaobotcrm.com.br"
            />
          </FormField>
          <FormField label={t("zpro.apiId", "ApiID")} required>
            <Input
              value={editForm.apiId}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, apiId: e.target.value }))
              }
            />
          </FormField>
          <FormField
            label={t("zpro.bearerToken", "Bearer token")}
            description={t(
              "zpro.editBearerHint",
              "Only fill this in to replace the current token.",
            )}
          >
            <Input
              type="password"
              showPasswordToggle
              value={editForm.bearerToken}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, bearerToken: e.target.value }))
              }
              placeholder={t(
                "zpro.bearerTokenUnchanged",
                "Leave empty to keep",
              )}
            />
          </FormField>
          <FormField label={t("zpro.instanceName", "Instance name")} required>
            <Input
              value={editForm.instanceName}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, instanceName: e.target.value }))
              }
            />
          </FormField>
          <FormField label={t("zpro.whatsappId", "WhatsApp ID")} required>
            <Input
              type="number"
              value={editForm.whatsappId}
              onChange={(e) =>
                setEditForm((f) => ({ ...f, whatsappId: e.target.value }))
              }
            />
          </FormField>
        </div>
      </Modal>

      <ConfirmDialog modal={confirm} />
    </section>
  );
}
