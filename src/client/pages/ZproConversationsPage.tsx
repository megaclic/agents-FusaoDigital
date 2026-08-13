// src/client/pages/ZproConversationsPage.tsx
// Inbox de conversas Z-PRO. Espelha ConversationsPage.tsx (Chatwoot) com dados do mirror local
// (src/modules/zpro/mirror.ts). Atualiza em tempo real via useTenantEvents (mesmo canal por
// tenant da página Chatwoot, eventos zpro-message/zpro-agent-toggled).

import { Bot, ChevronRight, MessagesSquare, Search, User } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataBoundary,
  type FilterPillItem,
  FilterPills,
  PageContainer,
  Skeleton,
} from "@/client/components";
import { useTenantEvents } from "@/client/hooks/useTenantEvents";
import { api } from "@/client/lib/api";

// Types derived from the Eden treaty — never hand-declared (see docs/eden-treaty.md).
type ZproConversationsData = Awaited<
  ReturnType<typeof api.api.v1.zpro.conversations.get>
>["data"];
type ZproConversation =
  NonNullable<ZproConversationsData>["conversations"][number];

type BadgeVariant = "primary" | "secondary" | "success" | "warning" | "info";

// t('zpro.conversations.status.open', 'Open')
// t('zpro.conversations.status.pending', 'Pending')
// t('zpro.conversations.status.closed', 'Closed')
const STATUS_VARIANT: Record<string, BadgeVariant> = {
  open: "info",
  pending: "warning",
  closed: "secondary",
};

// The four filter pills map to two different backend query dimensions (status vs agentActive).
type FilterKey = "" | "agent" | "human" | "closed";

function filterToQuery(filter: FilterKey): {
  status?: string;
  agentActive?: string;
} {
  if (filter === "agent") return { agentActive: "true" };
  if (filter === "human") return { agentActive: "false" };
  if (filter === "closed") return { status: "closed" };
  return {};
}

function previewText(
  c: ZproConversation,
  t: (key: string, def: string) => string,
): string {
  if (c.lastMessageBody) return c.lastMessageBody;
  return t("zpro.conversations.mediaPreview", "[Media message]");
}

function ZproConversationRow({ c }: { c: ZproConversation }) {
  const { t, i18n } = useTranslation();
  const when = c.lastMessageAt
    ? new Date(c.lastMessageAt).toLocaleString(i18n.language)
    : null;
  return (
    <li>
      <Link
        to={`/zpro/conversations/${c.id}`}
        className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 transition-colors hover:bg-bg-hover"
      >
        <div className="flex min-w-0 items-center gap-3">
          <Avatar
            name={c.contactName || c.contactNumber}
            src={
              c.avatarUrl ? `/api/v1/zpro/conversations/${c.id}/avatar` : null
            }
            size="sm"
          />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-text-primary">
                {c.contactName || c.contactNumber}
              </span>
              <Badge variant={STATUS_VARIANT[c.status] ?? "secondary"}>
                {/* biome-ignore lint/plugin/no-dynamic-i18n-key: status keys extracted via magic comments above STATUS_VARIANT */}
                {t(`zpro.conversations.status.${c.status}`, c.status)}
              </Badge>
            </div>
            <p className="mt-0.5 truncate text-text-muted text-xs">
              {previewText(c, t)}
              {when ? ` · ${when}` : ""}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-text-secondary text-xs">
          {c.agentActive ? (
            <>
              <Bot className="h-3.5 w-3.5 text-accent" aria-hidden="true" />
              {t("zpro.conversations.assignee.ai", "AI")}
            </>
          ) : (
            <>
              <User className="h-3.5 w-3.5" aria-hidden="true" />
              {t("zpro.conversations.assignee.human", "Human")}
            </>
          )}
          <ChevronRight
            className="h-4 w-4 text-text-muted"
            aria-hidden="true"
          />
        </div>
      </Link>
    </li>
  );
}

// NOTE: Static keys so the skeleton rows don't key off the array index.
const CONV_SKELETON_KEYS = [
  "zconv-0",
  "zconv-1",
  "zconv-2",
  "zconv-3",
  "zconv-4",
];

function ZproConversationsSkeleton() {
  return (
    <Card className="p-1.5">
      <ul aria-hidden="true" className="flex flex-col gap-0.5">
        {CONV_SKELETON_KEYS.map((key) => (
          <li
            key={key}
            className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-5 w-16" />
              </div>
              <Skeleton className="mt-0.5 h-3 w-56" />
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Skeleton className="h-3.5 w-3.5 rounded-full" />
              <Skeleton className="h-3 w-12" />
              <Skeleton className="h-4 w-4" />
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function ZproConversationsPage() {
  const { t } = useTranslation();
  const [conversations, setConversations] = useState<ZproConversation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [filter, setFilter] = useState<FilterKey>("");
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Debounce the search box so each keystroke doesn't fire a request.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(id);
  }, [search]);

  const fetchConversations = useCallback(async () => {
    const { data, error: err } = await api.api.v1.zpro.conversations.get({
      query: {
        ...filterToQuery(filter),
        ...(debouncedSearch ? { q: debouncedSearch } : {}),
      },
    });
    if (err || !data) {
      setError(true);
      return;
    }
    setError(false);
    setConversations(data.conversations);
    setNextCursor(data.nextCursor);
  }, [filter, debouncedSearch]);

  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const { data, error: err } = await api.api.v1.zpro.conversations.get({
        query: {
          ...filterToQuery(filter),
          ...(debouncedSearch ? { q: debouncedSearch } : {}),
          cursor: nextCursor,
        },
      });
      if (err || !data) return;
      setConversations((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...data.conversations.filter((c) => !seen.has(c.id))];
      });
      setNextCursor(data.nextCursor);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, filter, debouncedSearch]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetchConversations().finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [fetchConversations]);

  // A new/updated message doesn't carry enough metadata to merge in place (deliberately, no PII —
  // see ZproMessageEvent), so coalesce bursts into one lightweight background refetch.
  useTenantEvents({
    onZproMessage: () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => void fetchConversations(), 300);
    },
    onZproAgentToggled: (event) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === event.conversationId
            ? { ...c, agentActive: event.agentActive }
            : c,
        ),
      );
    },
  });

  useEffect(() => {
    const timer = refetchTimer.current;
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <PageContainer className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <MessagesSquare className="h-6 w-6 text-accent" aria-hidden="true" />
          <div>
            <h1 className="font-semibold text-text-primary text-xl">
              {t("zpro.conversations.title", "Z-PRO conversations")}
            </h1>
            <p className="mt-0.5 text-sm text-text-muted">
              {t(
                "zpro.conversations.subtitle",
                "Live WhatsApp conversations mirrored from Z-PRO, with their bot/human status.",
              )}
            </p>
          </div>
        </div>
      </header>

      <div className="relative min-w-0">
        <Search
          className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-text-muted"
          aria-hidden="true"
        />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(
            "zpro.conversations.search",
            "Search by contact or ticket #…",
          )}
          aria-label={t(
            "zpro.conversations.search",
            "Search by contact or ticket #…",
          )}
          className="w-full rounded-lg border border-border bg-bg-tertiary py-2 pr-4 pl-9 text-text-primary placeholder-text-placeholder focus:border-border-focus focus:outline-none"
        />
      </div>

      <FilterPills
        value={filter}
        onChange={(v) => setFilter(v as FilterKey)}
        aria-label={t(
          "zpro.conversations.filterStatus",
          "Filter conversations",
        )}
        items={
          [
            { key: "", label: t("zpro.conversations.filters.all", "All") },
            {
              key: "agent",
              label: t("zpro.conversations.filters.agent", "AI active"),
            },
            {
              key: "human",
              label: t("zpro.conversations.filters.human", "Human"),
            },
            {
              key: "closed",
              label: t("zpro.conversations.filters.closed", "Closed"),
            },
          ] satisfies FilterPillItem[]
        }
      />

      <DataBoundary
        loading={loading}
        error={error}
        isEmpty={conversations.length === 0}
        onRetry={fetchConversations}
        loadingLabel={t("zpro.conversations.loading", "Loading conversations…")}
        errorLabel={t(
          "zpro.conversations.error",
          "Could not load conversations.",
        )}
        skeleton={<ZproConversationsSkeleton />}
        empty={
          <p className="px-4 py-10 text-center text-sm text-text-muted">
            {t("zpro.conversations.empty", "No Z-PRO conversations yet.")}
          </p>
        }
      >
        <div className="flex flex-col gap-3">
          <Card className="p-1.5">
            <ul className="flex flex-col gap-0.5">
              {conversations.map((c) => (
                <ZproConversationRow key={c.id} c={c} />
              ))}
            </ul>
          </Card>
          {nextCursor && (
            <div className="flex justify-center">
              <Button
                variant="secondary"
                size="sm"
                onClick={loadMore}
                loading={loadingMore}
              >
                {t("zpro.conversations.loadMore", "Load more")}
              </Button>
            </div>
          )}
        </div>
      </DataBoundary>
    </PageContainer>
  );
}
