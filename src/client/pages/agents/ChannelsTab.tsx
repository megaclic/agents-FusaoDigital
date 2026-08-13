import { Inbox as InboxIcon, Loader2, MessageSquare } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  type ConfirmPayload,
  DataBoundary,
  EmptyState,
  InboxRow,
  Skeleton,
  Switch,
  useModalController,
  useToast,
} from "@/client/components";
import { ServiceLogo } from "@/client/components/icons/ServiceLogo";
import { api } from "@/client/lib/api";

type DeploymentData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.deployment.get>
>["data"];
type Instance = NonNullable<DeploymentData>["accounts"][number];
type InboxesData = Awaited<
  ReturnType<typeof api.api.v1.chatwoot.inboxes.get>
>["data"];
type Inbox = NonNullable<InboxesData>["inboxes"][number];
type AgentsData = Awaited<ReturnType<typeof api.api.v1.agents.get>>["data"];
type AgentLite = NonNullable<AgentsData>["agents"][number];
type ZproInstancesData = Awaited<
  ReturnType<typeof api.api.v1.zpro.instances.get>
>["data"];
type ZproInstanceDto = NonNullable<ZproInstancesData>["instances"][number];

// Agent editor "Channels" tab: bind/unbind THIS agent to inboxes from the agent's side. Mirrors the
// Channels page but with a per-inbox switch instead of an agent picker, and acts IMMEDIATELY (no
// Save button — like the Playground tab) since binding has side effects on Chatwoot (it provisions +
// connects/disconnects the persona bot via the same PATCH /inboxes/:id endpoint).
export function ChannelsTab({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const navigate = useNavigate();
  const confirm = useModalController<ConfirmPayload>();

  const [instances, setInstances] = useState<Instance[]>([]);
  const [baseUrl, setBaseUrl] = useState("");
  const [inboxes, setInboxes] = useState<Inbox[]>([]);
  const [agents, setAgents] = useState<AgentLite[]>([]);
  const [botStatus, setBotStatus] = useState<
    Record<string, "active" | "missing">
  >({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState<string | null>(null);

  const loadBotStatus = useCallback(async () => {
    try {
      const { data } = await api.api.v1.chatwoot.inboxes["bot-status"].get();
      if (data) setBotStatus({ ...data.statuses });
    } catch {
      // ignore — leave statuses unverified
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const [dep, inb, ag] = await Promise.all([
        api.api.v1.chatwoot.deployment.get(),
        api.api.v1.chatwoot.inboxes.get(),
        api.api.v1.agents.get({ query: { pageSize: 100 } }),
      ]);
      if (dep.error || !dep.data) {
        setError(true);
        return;
      }
      setInstances([...dep.data.accounts]);
      setBaseUrl(dep.data.deployment?.baseUrl ?? "");
      if (inb.data) setInboxes([...inb.data.inboxes]);
      if (ag.data) setAgents([...ag.data.agents]);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
    void loadBotStatus();
  }, [loadBotStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  // Persist a binding (agentId = this agent to bind, null to unbind). Non-optimistic: local state
  // changes only on success; on failure the switch reverts because it reads from `inboxes`.
  async function setBinding(inboxId: string, nextAgentId: string | null) {
    setPending(inboxId);
    try {
      const { error: err } = await api.api.v1.chatwoot
        .inboxes({ id: inboxId })
        .patch({ agentId: nextAgentId });
      if (err) throw err;
      setInboxes((prev) =>
        prev.map((i) =>
          i.id === inboxId ? { ...i, agentId: nextAgentId } : i,
        ),
      );
      setBotStatus((prev) => {
        const next = { ...prev };
        if (nextAgentId) next[inboxId] = "active";
        else delete next[inboxId];
        return next;
      });
      showToast(t("channels.bound", "Inbox updated."), "success");
    } catch {
      showToast(
        t("channels.bindError", "Could not update the inbox."),
        "error",
      );
    } finally {
      setPending(null);
    }
  }

  function onToggle(ib: Inbox, next: boolean) {
    if (!next) {
      void setBinding(ib.id, null);
      return;
    }
    // Connecting to an inbox already owned by another agent steals it — confirm first.
    if (ib.agentId !== null && ib.agentId !== agentId) {
      const owner =
        agents.find((a) => a.id === ib.agentId)?.name ??
        t("editor.channels.otherAgent", "another agent");
      confirm.open({
        title: t("editor.channels.reassignTitle", "Reassign inbox"),
        message: t(
          "editor.channels.reassignBody",
          '"{{inbox}}" is currently answered by "{{owner}}". Reassign it to "{{agent}}"?',
          { inbox: ib.name, owner, agent: agentName },
        ),
        confirmLabel: t("editor.channels.reassignConfirm", "Reassign"),
        onConfirm: () => setBinding(ib.id, agentId),
      });
      return;
    }
    void setBinding(ib.id, agentId);
  }

  async function reconnectBot(inboxId: string) {
    setReconnecting(inboxId);
    try {
      const { error: err } = await api.api.v1.chatwoot
        .inboxes({ id: inboxId })
        .reconnect.post();
      if (err) throw err;
      setBotStatus((prev) => ({ ...prev, [inboxId]: "active" }));
      showToast(t("channels.reconnected", "Bot reconnected."), "success");
    } catch {
      showToast(
        t("channels.reconnectError", "Could not reconnect the bot."),
        "error",
      );
    } finally {
      setReconnecting(null);
    }
  }

  const accountLabel = (inst: Instance) =>
    inst.accountName ??
    t("channels.account", "Account {{id}}", { id: inst.accountId });
  const inboxesByInstance = instances
    .map((inst) => ({
      inst,
      items: inboxes.filter((ib) => ib.chatwootInstanceId === inst.id),
    }))
    .filter((g) => g.items.length > 0)
    .sort(
      (a, b) =>
        accountLabel(a.inst).localeCompare(accountLabel(b.inst), undefined, {
          sensitivity: "base",
        }) || a.inst.accountId - b.inst.accountId,
    );
  const showInstanceHeaders = inboxesByInstance.length > 1;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <h2 className="flex items-center gap-2 font-medium text-text-primary">
          <InboxIcon className="h-4 w-4 text-accent" aria-hidden="true" />
          {t("editor.channels.title", "Inboxes")}
        </h2>
        <p className="mt-0.5 text-text-muted text-xs">
          {t(
            "editor.channels.desc",
            "Connect this agent to the inboxes it should answer. Changes apply immediately on Chatwoot.",
          )}
        </p>
      </div>

      <DataBoundary loading={loading} error={error} onRetry={load}>
        {instances.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={InboxIcon}
              title={t("editor.channels.noInstance", "No Chatwoot connected")}
              description={t(
                "editor.channels.noInstanceDesc",
                "Connect a Chatwoot instance under Channels, then come back to bind this agent to its inboxes.",
              )}
              action={
                <Button onClick={() => navigate("/channels")}>
                  {t("editor.channels.goToChannels", "Go to Channels")}
                </Button>
              }
            />
          </Card>
        ) : inboxesByInstance.length === 0 ? (
          <Card className="p-0">
            <EmptyState
              icon={InboxIcon}
              title={t("editor.channels.empty", "No inboxes available")}
              description={t(
                "editor.channels.emptyDesc",
                "Sync this Chatwoot instance's inboxes under Channels first.",
              )}
            />
          </Card>
        ) : (
          inboxesByInstance.map(({ inst, items }) => {
            const disconnected = inst.disconnectedAt !== null;
            return (
              <div key={inst.id} className="flex flex-col gap-1.5">
                {showInstanceHeaders && (
                  <div className="flex items-center gap-1.5 px-1 text-text-muted text-xs">
                    <ServiceLogo
                      service="chatwoot"
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className="truncate">{accountLabel(inst)}</span>
                    {disconnected && (
                      <Badge variant="warning">
                        {t("channels.disconnectedBadge", "Disconnected")}
                      </Badge>
                    )}
                  </div>
                )}
                <Card className="p-0">
                  <ul>
                    {items.map((ib) => {
                      const mine = ib.agentId === agentId;
                      const otherOwner =
                        ib.agentId !== null && ib.agentId !== agentId
                          ? (agents.find((a) => a.id === ib.agentId)?.name ??
                            t("editor.channels.otherAgent", "another agent"))
                          : null;
                      return (
                        <InboxRow
                          key={ib.id}
                          name={ib.name}
                          chatwootInboxId={ib.chatwootInboxId}
                          channelType={ib.channelType}
                          instanceBaseUrl={baseUrl}
                          instanceAccountId={inst.accountId}
                          status={
                            disconnected || ib.agentId === null
                              ? "none"
                              : botStatus[ib.id] === "missing"
                                ? "missing"
                                : "active"
                          }
                          reconnecting={reconnecting === ib.id}
                          onReconnect={() => reconnectBot(ib.id)}
                        >
                          {disconnected ? (
                            <span className="shrink-0 text-text-muted text-xs">
                              {t(
                                "channels.accountDisconnectedOff",
                                "Account disconnected",
                              )}
                            </span>
                          ) : (
                            <>
                              {otherOwner && (
                                <span className="text-text-muted text-xs">
                                  {t(
                                    "editor.channels.ownedBy",
                                    "Answered by {{name}}",
                                    { name: otherOwner },
                                  )}
                                </span>
                              )}
                              {pending === ib.id ? (
                                <Loader2
                                  className="h-5 w-5 animate-spin text-text-muted"
                                  aria-hidden="true"
                                />
                              ) : (
                                <Switch
                                  checked={mine}
                                  onCheckedChange={(next) => onToggle(ib, next)}
                                  aria-label={t(
                                    "editor.channels.toggleAria",
                                    "Answer {{inbox}} with this agent",
                                    { inbox: ib.name },
                                  )}
                                />
                              )}
                            </>
                          )}
                        </InboxRow>
                      );
                    })}
                  </ul>
                </Card>
              </div>
            );
          })
        )}
      </DataBoundary>

      <ZproInstancesForAgent agentId={agentId} />

      <ConfirmDialog modal={confirm} />
    </div>
  );
}

// Z-PRO (WhatsApp) binding: a simpler mirror of the Chatwoot section above — one switch per
// instance, no picker (an instance answers through at most one agent). Renders nothing when the
// tenant has no Z-PRO instance at all, so agents that never touch WhatsApp stay uncluttered.
function ZproInstancesForAgent({ agentId }: { agentId: string }) {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const [instances, setInstances] = useState<ZproInstanceDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const { data } = await api.api.v1.zpro.instances.get();
      if (data) setInstances([...data.instances]);
      else setError(true);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(instance: ZproInstanceDto) {
    const isBound = instance.agentBindings.some((b) => b.agentId === agentId);
    setPending(instance.id);
    try {
      const { error: err } = await api.api.v1.zpro
        .instances({ id: instance.id })
        .bind.post({ agentId: isBound ? null : agentId });
      if (err) throw err;
      setInstances((prev) =>
        prev.map((i) =>
          i.id === instance.id
            ? {
                ...i,
                agentBindings: isBound ? [] : [{ agentId, agentName: "" }],
              }
            : i,
        ),
      );
      showToast(t("zpro.bound", "Instance updated."), "success");
    } catch {
      showToast(t("zpro.bindError", "Could not bind the agent."), "error");
    } finally {
      setPending(null);
    }
  }

  // A confirmed-empty tenant (no error, no instances) hides the whole section — matches the pattern
  // used elsewhere for tenants that don't use Z-PRO. A FAILED fetch must NOT hide it the same way:
  // that previously looked identical to "no Z-PRO here" with zero indication anything went wrong.
  if (!loading && !error && instances.length === 0) return null;

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 font-medium text-text-primary">
        <MessageSquare className="h-4 w-4 text-accent" aria-hidden="true" />
        {t("zpro.title", "Z-PRO (WhatsApp)")}
      </h2>
      <DataBoundary
        loading={loading}
        error={error}
        onRetry={load}
        skeleton={
          <Card className="flex items-center justify-between gap-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-6 w-11" />
          </Card>
        }
      >
        <Card className="p-0">
          <ul>
            {instances.map((inst) => {
              const mine = inst.agentBindings.some(
                (b) => b.agentId === agentId,
              );
              return (
                <li
                  key={inst.id}
                  className="flex items-center justify-between gap-4 border-border border-b px-4 py-3 last:border-b-0"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium text-sm text-text-primary">
                      {inst.instanceName}
                    </span>
                    <span className="text-text-muted text-xs">
                      {inst.baseUrl}
                    </span>
                  </div>
                  {pending === inst.id ? (
                    <Loader2
                      className="h-5 w-5 animate-spin text-text-muted"
                      aria-hidden="true"
                    />
                  ) : (
                    <Switch
                      checked={mine}
                      onCheckedChange={() => void toggle(inst)}
                      aria-label={t(
                        "zpro.toggleBinding",
                        "Answer {{instance}} with this agent",
                        { instance: inst.instanceName },
                      )}
                    />
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      </DataBoundary>
    </section>
  );
}
