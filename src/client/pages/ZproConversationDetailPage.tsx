// src/client/pages/ZproConversationDetailPage.tsx
// Detalhe de uma conversa Z-PRO: histórico de mensagens + botão de ativar/desativar o agente.
// Espelha a estrutura de ConversationDetailPage.tsx (Chatwoot): mensagens de mídia com mediaUrl
// renderizam o player/imagem embutido via proxy same-origin (/messages/:messageId/media); a
// legenda/transcrição (body) aparece abaixo quando presente. O indicador "IA está trabalhando"
// (ZproAgentActivityIndicator) espelha o AgentActivityIndicator do Chatwoot, alimentado pelo
// evento realtime zpro-agent-activity (ZproAgentStatusReporter, src/modules/zpro/status.ts).

import { ArrowLeft, Bot, Paperclip, User } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataBoundary,
  MediaAudio,
  MediaImage,
  PageContainer,
  Skeleton,
  useToast,
} from "@/client/components";
import {
  type AgentActivityStage,
  useTenantEvents,
} from "@/client/hooks/useTenantEvents";
import { api } from "@/client/lib/api";
import { cn } from "@/client/lib/utils";

// Types derived from the Eden treaty — never hand-declared (see docs/eden-treaty.md).
type ConversationResp = Awaited<
  ReturnType<ReturnType<typeof api.api.v1.zpro.conversations>["get"]>
>;
type ZproConversationDetail = NonNullable<
  ConversationResp["data"]
>["conversation"];

type MessagesResp = Awaited<
  ReturnType<
    ReturnType<typeof api.api.v1.zpro.conversations>["messages"]["get"]
  >
>;
type ZproMessageItem = NonNullable<MessagesResp["data"]>["messages"][number];

type BadgeVariant = "primary" | "secondary" | "success" | "warning" | "info";

// t('zpro.conversations.status.open', 'Open')
// t('zpro.conversations.status.pending', 'Pending')
// t('zpro.conversations.status.closed', 'Closed')
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  open: "info",
  pending: "warning",
  closed: "secondary",
};

// t('zpro.conversations.mediaType.audioMessage', 'Audio message')
// t('zpro.conversations.mediaType.pttMessage', 'Audio message')
// t('zpro.conversations.mediaType.imageMessage', 'Image')
// t('zpro.conversations.mediaType.videoMessage', 'Video')
// t('zpro.conversations.mediaType.documentMessage', 'Document')
// t('zpro.conversations.mediaType.stickerMessage', 'Sticker')
const MEDIA_TYPE_KEYS = new Set([
  "audioMessage",
  "pttMessage",
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "stickerMessage",
]);

// One media message, proxied through our origin (/conversations/:id/messages/:messageId/media) so it
// renders under a strict CSP. Audio/images render inline; anything else is a link that opens the
// proxied bytes. WhatsApp media URLs can expire — a 404 from the proxy surfaces via MediaAudio/
// MediaImage's own failed state (useMediaObjectUrl), never a broken layout.
function ZproMessageMedia({
  convId,
  m,
}: {
  convId: string;
  m: ZproMessageItem;
}) {
  const { t } = useTranslation();
  if (!m.mediaUrl) return null;
  const src = `/api/v1/zpro/conversations/${convId}/messages/${m.id}/media`;
  if (m.messageType === "audioMessage" || m.messageType === "pttMessage") {
    return <MediaAudio src={src} />;
  }
  if (m.messageType === "imageMessage" || m.messageType === "stickerMessage") {
    return <MediaImage src={src} className="max-h-60" />;
  }
  return (
    <a
      href={src}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1.5 text-sm underline"
    >
      <Paperclip className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {m.mediaFileName || t("conversation.attachment", "Attachment")}
    </a>
  );
}

function MessageBubble({
  m,
  convId,
  contactName,
}: {
  m: ZproMessageItem;
  convId: string;
  contactName: string;
}) {
  const { t, i18n } = useTranslation();
  const when = new Date(Number(m.timestamp)).toLocaleString(i18n.language);
  const outgoing = m.senderType !== "CLIENT";
  const mediaType = m.messageType;
  return (
    <div className={cn("flex", outgoing ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[80%] rounded-2xl px-3 py-2",
          outgoing
            ? "bg-accent text-accent-foreground"
            : "bg-bg-tertiary text-text-primary",
        )}
      >
        <p
          className={cn(
            "mb-0.5 flex items-center gap-1 font-medium text-xs",
            outgoing ? "text-accent-foreground/80" : "text-text-muted",
          )}
        >
          {m.senderType === "HUMAN" ? (
            <>
              <User className="h-3 w-3" aria-hidden="true" />
              {t("zpro.conversations.assignee.human", "Human")}
            </>
          ) : m.senderType === "AGENT" ? (
            <>
              <Bot className="h-3 w-3" aria-hidden="true" />
              {t("zpro.conversations.assignee.ai", "AI")}
            </>
          ) : (
            <>
              <User className="h-3 w-3" aria-hidden="true" />
              {contactName}
            </>
          )}
        </p>
        {m.mediaUrl && (
          <div className="mb-1">
            <ZproMessageMedia convId={convId} m={m} />
          </div>
        )}
        {(m.body || !m.mediaUrl) && (
          <p className="whitespace-pre-wrap text-sm">
            {m.body ||
              (MEDIA_TYPE_KEYS.has(mediaType)
                ? // biome-ignore lint/plugin/no-dynamic-i18n-key: media type keys extracted via magic comments above MEDIA_TYPE_KEYS
                  t(`zpro.conversations.mediaType.${mediaType}`, mediaType)
                : mediaType)}
          </p>
        )}
        <p
          className={cn(
            "mt-1 text-[11px]",
            outgoing ? "text-accent-foreground/70" : "text-text-muted",
          )}
        >
          {when}
        </p>
      </div>
    </div>
  );
}

// Safety net: a live indicator that never received its "finished" event (socket dropped mid-turn)
// self-clears after this long — mirrors ConversationDetailPage.tsx's ACTIVITY_STUCK_MS.
const ZPRO_ACTIVITY_STUCK_MS = 30_000;

// The friendly label for the native tools Z-PRO actually builds (native-tools.ts's
// buildZproNativeTools — same tool names Chatwoot's ToolFlowLogger/UI use, so the SAME translated
// strings apply). Only the tools ConversationDetailPage.tsx already maps get a dedicated label;
// everything else (assign_label, kanban_move_card, update_kanban_task, set_voice_preference) falls
// back to prettyToolName, exactly like Chatwoot's own unmapped tools do.
function prettyToolName(name: string): string {
  const words = name.replace(/_+/g, " ").trim();
  if (!words) return name;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function useZproToolLabel(tool: string | null): string | null {
  const { t } = useTranslation();
  switch (tool) {
    case "handoff_to_human":
      return t("conversation.activity.handoff", "Transferring to a human");
    case "private_note":
      return t("conversation.activity.note", "Writing an internal note");
    case "set_custom_attribute":
      return t("conversation.activity.attr", "Updating details");
    case "resolve_conversation":
      return t("conversation.activity.resolve", "Wrapping up the conversation");
    case "skip_reply":
      return t("conversation.activity.skip", "Decided not to respond");
    default:
      return null;
  }
}

type ZproActivityStage = AgentActivityStage | "delivering";
type ZproActivityState = {
  stage: ZproActivityStage | null;
  tool: string | null;
  runAt?: string | null;
} | null;

// The transient "agent is working" indicator — mirrors ConversationDetailPage.tsx's
// AgentActivityIndicator (same visual language, channel-neutral conversation.activity.* keys).
function ZproAgentActivityIndicator({
  activity,
}: {
  activity: ZproActivityState;
}) {
  const { t } = useTranslation();
  const toolLabel = useZproToolLabel(
    activity?.stage === "tool" ? activity.tool : null,
  );
  const [remaining, setRemaining] = useState<number | null>(null);
  const runAt =
    activity?.stage === "debounce" ? (activity.runAt ?? null) : null;
  useEffect(() => {
    if (!runAt) {
      setRemaining(null);
      return;
    }
    const target = Date.parse(runAt);
    const tick = () =>
      setRemaining(Math.max(0, Math.round((target - Date.now()) / 1000)));
    tick();
    const iv = setInterval(tick, 1000);
    return () => clearInterval(iv);
  }, [runAt]);

  if (!activity) return null;
  let label: string;
  if (activity.stage === "tool") {
    label =
      toolLabel ??
      (activity.tool
        ? prettyToolName(activity.tool)
        : t("conversation.activity.tool", "Using a tool"));
  } else if (activity.stage === "debounce") {
    label =
      remaining != null && remaining > 0
        ? t(
            "conversation.activity.debounceCountdown",
            "Waiting for more messages · ~{{seconds}}s",
            { seconds: remaining },
          )
        : t("conversation.activity.debounce", "Waiting for more messages");
  } else if (activity.stage === "delivering") {
    label = t("conversation.activity.delivering", "Delivering the reply");
  } else {
    label = t("conversation.activity.thinking", "Thinking");
  }
  return (
    <div className="flex justify-start" aria-live="polite">
      <div className="flex max-w-[80%] items-center gap-2 rounded-2xl bg-bg-tertiary px-3 py-2 text-sm text-text-secondary">
        <Bot className="h-4 w-4 shrink-0 text-accent" aria-hidden="true" />
        <span>{label}</span>
        <span className="flex items-center gap-0.5" aria-hidden="true">
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:150ms]" />
          <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-text-muted [animation-delay:300ms]" />
        </span>
      </div>
    </div>
  );
}

const MSG_SKELETON_KEYS = ["zmsg-0", "zmsg-1", "zmsg-2", "zmsg-3"];

function MessagesSkeleton() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-3">
      {MSG_SKELETON_KEYS.map((key, i) => (
        <div
          key={key}
          className={cn("flex", i % 2 === 0 ? "justify-start" : "justify-end")}
        >
          <Skeleton className="h-12 w-64 rounded-2xl" />
        </div>
      ))}
    </div>
  );
}

export function ZproConversationDetailPage() {
  const { t } = useTranslation();
  const { showToast } = useToast();
  const { id = "" } = useParams();
  const [conv, setConv] = useState<ZproConversationDetail | null>(null);
  const [metaLoading, setMetaLoading] = useState(true);
  const [metaError, setMetaError] = useState(false);
  const [messages, setMessages] = useState<ZproMessageItem[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(true);
  const [messagesError, setMessagesError] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [activity, setActivity] = useState<ZproActivityState>(null);
  // Safety net to self-clear a live indicator whose "finished" event was lost (socket gap).
  const stuckTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // After "finished" with a multi-balloon split, the indicator stays on "delivering" until this
  // timer elapses (the paced balloons land over the webhook→mirror roundtrip, which lags finish).
  const deliverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sticky-to-bottom: true until the operator scrolls up to read older messages, so a background
  // refresh (realtime or polling) doesn't yank them back down while they're reading history.
  const stickToBottom = useRef(true);

  // Apply an activity label now and (re)arm the stuck-clear safety net — mirrors
  // ConversationDetailPage.tsx's commitActivity.
  const commitActivity = useCallback((next: ZproActivityState) => {
    setActivity(next);
    if (stuckTimer.current) clearTimeout(stuckTimer.current);
    if (next) {
      stuckTimer.current = setTimeout(
        () => setActivity(null),
        ZPRO_ACTIVITY_STUCK_MS,
      );
    } else {
      stuckTimer.current = null;
    }
  }, []);

  const onMessagesScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  const loadMeta = useCallback(
    async (opts?: { background?: boolean }) => {
      const background = opts?.background ?? false;
      if (!background) {
        setMetaLoading(true);
        setMetaError(false);
      }
      try {
        const { data, error: err } = await api.api.v1.zpro
          .conversations({ id })
          .get();
        if (err || !data) {
          if (!background) setMetaError(true);
          return;
        }
        setConv(data.conversation);
      } catch {
        if (!background) setMetaError(true);
      } finally {
        if (!background) setMetaLoading(false);
      }
    },
    [id],
  );

  const loadMessages = useCallback(
    async (opts?: { background?: boolean }) => {
      const background = opts?.background ?? false;
      if (!background) {
        setMessagesLoading(true);
        setMessagesError(false);
      }
      try {
        const { data, error: err } = await api.api.v1.zpro
          .conversations({ id })
          .messages.get();
        if (err || !data) {
          if (!background) setMessagesError(true);
          return;
        }
        setMessages(data.messages);
      } catch {
        if (!background) setMessagesError(true);
      } finally {
        if (!background) setMessagesLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    void loadMeta();
    void loadMessages();
  }, [loadMeta, loadMessages]);

  // Auto-scroll on mount (initial load) and whenever the message list or the activity indicator
  // changes (realtime arrival), but only while the operator hasn't scrolled up to read history
  // (see onMessagesScroll above).
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages/activity are scroll triggers, not reads.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, activity]);

  useTenantEvents({
    onZproMessage: (event) => {
      if (event.conversationId !== id) return;
      void loadMessages({ background: true });
      void loadMeta({ background: true });
    },
    onZproAgentToggled: (event) => {
      if (event.conversationId !== id) return;
      setConv((prev) =>
        prev ? { ...prev, agentActive: event.agentActive } : prev,
      );
    },
    // Drive the "agent is working" indicator from the runtime's live progress — mirrors
    // ConversationDetailPage.tsx's onAgentActivity exactly.
    onZproAgentActivity: (event) => {
      if (event.conversationId !== id) return;
      if (deliverTimer.current) {
        clearTimeout(deliverTimer.current);
        deliverTimer.current = null;
      }
      if (event.phase === "finished") {
        if (event.balloons != null && event.balloons > 1) {
          commitActivity({ stage: "delivering", tool: null });
          deliverTimer.current = setTimeout(
            () => {
              deliverTimer.current = null;
              setActivity(null);
            },
            Math.min(event.balloons * 3000, 12_000),
          );
        } else {
          commitActivity(null);
        }
        return;
      }
      commitActivity({
        stage: event.stage,
        tool: event.tool,
        runAt: event.runAt ?? null,
      });
    },
  });

  // Clear all transient timers on unmount so none fire into a dead component.
  useEffect(() => {
    return () => {
      if (stuckTimer.current) clearTimeout(stuckTimer.current);
      if (deliverTimer.current) clearTimeout(deliverTimer.current);
    };
  }, []);

  const toggleAgent = useCallback(async () => {
    if (!conv) return;
    const nextActive = !conv.agentActive;
    setToggling(true);
    try {
      const { data, error: err } = await api.api.v1.zpro
        .conversations({ id })
        ["toggle-agent"].post({ agentActive: nextActive });
      if (err || !data) {
        showToast(
          t("zpro.conversations.toggleError", "Could not update the agent."),
          "error",
        );
        return;
      }
      setConv((prev) =>
        prev ? { ...prev, agentActive: data.agentActive } : prev,
      );
      showToast(
        data.agentActive
          ? t("zpro.conversations.agentActivated", "AI agent activated.")
          : t("zpro.conversations.agentDeactivated", "AI agent deactivated."),
        "success",
      );
    } catch {
      showToast(
        t("zpro.conversations.toggleError", "Could not update the agent."),
        "error",
      );
    } finally {
      setToggling(false);
    }
  }, [conv, id, showToast, t]);

  const zproStatusKey = `zpro.conversations.status.${conv?.status}`;
  // biome-ignore lint/plugin/no-dynamic-i18n-key: status keys extracted via magic comments in ZproConversationsPage
  const zproStatusLabel = conv ? t(zproStatusKey, conv.status) : "";

  return (
    <PageContainer className="flex h-full min-h-0 flex-col gap-4">
      <Link
        to="/zpro/conversations"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        {t("zpro.conversations.back", "Back to Z-PRO conversations")}
      </Link>

      <DataBoundary
        loading={metaLoading}
        error={metaError || !conv}
        onRetry={loadMeta}
        errorLabel={t(
          "zpro.conversations.metaError",
          "Could not load the conversation.",
        )}
      >
        {conv && (
          <>
            <Card className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <Avatar
                  name={conv.contactName || conv.contactNumber}
                  src={
                    conv.avatarUrl
                      ? `/api/v1/zpro/conversations/${conv.id}/avatar`
                      : null
                  }
                  size="md"
                />
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="truncate font-semibold text-lg text-text-primary">
                      {conv.contactName || conv.contactNumber}
                    </h1>
                    <Badge variant={STATUS_VARIANT[conv.status] ?? "secondary"}>
                      {zproStatusLabel}
                    </Badge>
                  </div>
                  <p className="mt-0.5 text-sm text-text-muted">
                    {conv.contactNumber}
                    {conv.ticketProtocol ? ` · #${conv.ticketProtocol}` : ""}
                    {` · ${conv.instanceName}`}
                    {conv.queueName ? ` · ${conv.queueName}` : ""}
                  </p>
                  {conv.tags.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {conv.tags.map((tag) => (
                        <Badge key={tag} variant="secondary">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              <Button
                variant={conv.agentActive ? "secondary" : "primary"}
                size="sm"
                loading={toggling}
                onClick={toggleAgent}
              >
                {conv.agentActive ? (
                  <>
                    <User className="h-4 w-4" aria-hidden="true" />
                    {t(
                      "zpro.conversations.deactivateAgent",
                      "Deactivate agent",
                    )}
                  </>
                ) : (
                  <>
                    <Bot className="h-4 w-4" aria-hidden="true" />
                    {t("zpro.conversations.activateAgent", "Activate agent")}
                  </>
                )}
              </Button>
            </Card>

            <div
              ref={scrollRef}
              onScroll={onMessagesScroll}
              className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-bg-secondary p-6"
            >
              <DataBoundary
                loading={messagesLoading}
                error={messagesError}
                isEmpty={messages.length === 0}
                onRetry={loadMessages}
                loadingLabel={t(
                  "zpro.conversations.messagesLoading",
                  "Loading messages…",
                )}
                errorLabel={t(
                  "zpro.conversations.messagesError",
                  "Could not load messages.",
                )}
                skeleton={<MessagesSkeleton />}
                empty={
                  <p className="px-4 py-10 text-center text-sm text-text-muted">
                    {t("zpro.conversations.noMessages", "No messages yet.")}
                  </p>
                }
              >
                <div className="flex flex-col gap-3">
                  {messages.map((m) => (
                    <MessageBubble
                      key={m.id}
                      m={m}
                      convId={conv.id}
                      contactName={conv.contactName || conv.contactNumber}
                    />
                  ))}
                  {activity && (
                    <ZproAgentActivityIndicator activity={activity} />
                  )}
                </div>
              </DataBoundary>
            </div>
          </>
        )}
      </DataBoundary>
    </PageContainer>
  );
}
