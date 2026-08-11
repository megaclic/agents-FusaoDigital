// src/client/pages/ZproConversationDetailPage.tsx
// Detalhe de uma conversa Z-PRO: histórico de mensagens + botão de ativar/desativar o agente.
// Espelha a estrutura de ConversationDetailPage.tsx (Chatwoot), simplificada (sem paginação de
// histórico, sem proxy de mídia — mensagens de mídia sem legenda mostram um rótulo pelo
// messageType em vez do player/imagem embutido).

import { ArrowLeft, Bot, User } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataBoundary,
  PageContainer,
  Skeleton,
  useToast,
} from "@/client/components";
import { useTenantEvents } from "@/client/hooks/useTenantEvents";
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

function MessageBubble({
  m,
  contactName,
}: {
  m: ZproMessageItem;
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
        <p className="whitespace-pre-wrap text-sm">
          {m.body ||
            (MEDIA_TYPE_KEYS.has(mediaType)
              ? // biome-ignore lint/plugin/no-dynamic-i18n-key: media type keys extracted via magic comments above MEDIA_TYPE_KEYS
                t(`zpro.conversations.mediaType.${mediaType}`, mediaType)
              : mediaType)}
        </p>
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
  const scrollRef = useRef<HTMLDivElement>(null);
  // Sticky-to-bottom: true until the operator scrolls up to read older messages, so a background
  // refresh (realtime or polling) doesn't yank them back down while they're reading history.
  const stickToBottom = useRef(true);

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

  // Auto-scroll on mount (initial load) and whenever the message list changes (realtime arrival),
  // but only while the operator hasn't scrolled up to read history (see onMessagesScroll above).
  // biome-ignore lint/correctness/useExhaustiveDependencies: messages is the scroll trigger, not a read.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

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
  });

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
                  </p>
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
                      contactName={conv.contactName || conv.contactNumber}
                    />
                  ))}
                </div>
              </DataBoundary>
            </div>
          </>
        )}
      </DataBoundary>
    </PageContainer>
  );
}
