// src/api/v1/zpro-conversations.controller.ts
// Leitura do inbox espelhado do Z-PRO (mirror.ts) + toggle manual do agente por ticket. Read-only
// e a ação de toggle são `requireAuth: true` (qualquer papel autenticado, não só TENANT_ADMIN) —
// mesmo nível de acesso das rotas equivalentes do Chatwoot (/v1/conversations, .../handoff,
// .../return): o atendente (AGENT) do tenant do cliente precisa ver e operar essas conversas, RLS
// já restringe ao próprio tenant. SEPARATE from zproController (webhook público) e
// zproAdminController (CRUD de instâncias/bindings, TENANT_ADMIN) — mesmo prefixo /v1/zpro, sem
// sobreposição de path.

// translate('errors.zproConversationNotFound', 'Z-PRO conversation not found')

import { Elysia, t } from "elysia";
import { broadcastZproAgentToggled } from "@/api/features/realtime/realtime.service";
import { decryptJson } from "@/api/lib/crypto";
import { doc, errors } from "@/api/lib/openapi";
import basePrisma from "@/api/lib/prisma";
import { tenancyPlugin } from "@/api/middlewares/tenancy";
import {
  ForbiddenError,
  NotFoundError,
  TenantTargetRequiredError,
} from "@/lib/errors";
import { assertSafeOutboundUrl } from "@/lib/ssrf";
import { runScopedOn, type TenantContext } from "@/lib/tenancy";
import { getZproFunnelMetrics } from "@/modules/zpro/analytics";
import { ZproClient } from "@/modules/zpro/client";
import { activateAgent, deactivateAgent } from "@/modules/zpro/handoff";

function ctxOrThrow(ctx: TenantContext | null): TenantContext {
  if (!ctx) throw new ForbiddenError();
  if (ctx.tenantId === null) throw new TenantTargetRequiredError();
  return ctx;
}

const DEFAULT_LIMIT = 30;
const MAX_LIMIT = 100;

function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT);
}

function parseCursor(cursor: string | undefined): bigint | null {
  if (!cursor) return null;
  try {
    return BigInt(cursor);
  } catch {
    return null;
  }
}

const CONVERSATION_SELECT = {
  id: true,
  ticketId: true,
  ticketProtocol: true,
  status: true,
  contactNumber: true,
  contactName: true,
  avatarUrl: true,
  agentActive: true,
  humanUserId: true,
  lastMessageAt: true,
  lastMessageBody: true,
  zproInstanceId: true,
  zproInstance: { select: { instanceName: true } },
} as const;

type ConversationRow = {
  id: bigint;
  ticketId: number;
  ticketProtocol: string | null;
  status: string;
  contactNumber: string;
  contactName: string;
  avatarUrl: string | null;
  agentActive: boolean;
  humanUserId: number | null;
  lastMessageAt: Date | null;
  lastMessageBody: string | null;
  zproInstanceId: bigint;
  zproInstance: { instanceName: string };
};

function conversationToDto(row: ConversationRow) {
  return {
    id: String(row.id),
    ticketId: row.ticketId,
    ticketProtocol: row.ticketProtocol,
    status: row.status,
    contactNumber: row.contactNumber,
    contactName: row.contactName,
    avatarUrl: row.avatarUrl,
    agentActive: row.agentActive,
    humanUserId: row.humanUserId,
    lastMessageAt: row.lastMessageAt ? row.lastMessageAt.toISOString() : null,
    lastMessageBody: row.lastMessageBody,
    instanceId: String(row.zproInstanceId),
    instanceName: row.zproInstance.instanceName,
  };
}

const MESSAGE_SELECT = {
  id: true,
  messageId: true,
  senderType: true,
  body: true,
  messageType: true,
  mediaUrl: true,
  mediaCaption: true,
  mediaFileName: true,
  fromMe: true,
  timestamp: true,
  createdAt: true,
} as const;

type MessageRow = {
  id: bigint;
  messageId: string;
  senderType: "CLIENT" | "AGENT" | "HUMAN";
  body: string;
  messageType: string;
  mediaUrl: string | null;
  mediaCaption: string | null;
  mediaFileName: string | null;
  fromMe: boolean;
  timestamp: bigint;
  createdAt: Date;
};

function messageToDto(row: MessageRow) {
  return {
    id: String(row.id),
    messageId: row.messageId,
    senderType: row.senderType,
    body: row.body,
    messageType: row.messageType,
    mediaUrl: row.mediaUrl,
    mediaCaption: row.mediaCaption,
    mediaFileName: row.mediaFileName,
    fromMe: row.fromMe,
    timestamp: row.timestamp.toString(),
    createdAt: row.createdAt.toISOString(),
  };
}

export const zproConversationsController = new Elysia({
  prefix: "/v1/zpro",
  tags: ["Channels"],
})
  .use(tenancyPlugin)
  .get(
    "/conversations",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const take = clampLimit(query.limit ? Number(query.limit) : undefined);
      const cursorId = parseCursor(query.cursor);
      const rows = await runScopedOn(basePrisma, ctx, (db) =>
        db.zproConversation.findMany({
          where: {
            ...(query.status ? { status: query.status } : {}),
            ...(query.agentActive !== undefined
              ? { agentActive: query.agentActive === "true" }
              : {}),
            ...(query.instanceId
              ? { zproInstanceId: BigInt(query.instanceId) }
              : {}),
          },
          // lastMessageAt is the canonical recency signal (nulls sort last); id breaks ties.
          orderBy: [
            { lastMessageAt: { sort: "desc", nulls: "last" } },
            { id: "desc" },
          ],
          take,
          // Keyset: seek past the cursor row in the ordering above (id is unique → a stable anchor).
          ...(cursorId != null ? { cursor: { id: cursorId }, skip: 1 } : {}),
          select: CONVERSATION_SELECT,
        }),
      );
      const nextCursor =
        rows.length === take ? (rows.at(-1)?.id.toString() ?? null) : null;
      return { conversations: rows.map(conversationToDto), nextCursor };
    },
    {
      requireAuth: true,
      query: t.Object({
        status: t.Optional(
          t.String({
            description: "Filter by ticket status (open|pending|closed).",
          }),
        ),
        agentActive: t.Optional(
          t.String({
            description:
              '"true"|"false" — filter by whether the AI agent is active on the ticket.',
          }),
        ),
        instanceId: t.Optional(
          t.String({
            description: "Z-PRO instance id (BigInt string) to filter by.",
          }),
        ),
        limit: t.Optional(
          t.String({ description: "Max conversations to return." }),
        ),
        cursor: t.Optional(
          t.String({
            description:
              "Keyset cursor: the id of the last item from the previous page.",
          }),
        ),
      }),
      detail: doc(
        "List Z-PRO conversations",
        "Lists mirrored Z-PRO conversations (newest first) for the tenant, optionally filtered by status, agent state or instance.",
      ),
      response: errors(400, 401),
    },
  )
  // Registered BEFORE /conversations/:id so the literal "analytics" segment can never be swallowed
  // by the :id param route (both would otherwise match /conversations/analytics/... equally well).
  .get(
    "/conversations/analytics/funnel",
    async ({ tenantContext, query }) => {
      const ctx = ctxOrThrow(tenantContext);
      const since = query.since
        ? new Date(query.since)
        : new Date(Date.now() - 30 * 86_400_000);
      const metrics = await runScopedOn(basePrisma, ctx, (db) =>
        getZproFunnelMetrics(db, since),
      );
      return { funnel: metrics };
    },
    {
      requireAuth: true,
      query: t.Object({
        since: t.Optional(
          t.String({
            description:
              "ISO date string; conversations created on/after this instant are counted. Defaults to 30 days ago.",
          }),
        ),
      }),
      detail: doc(
        "Z-PRO funnel metrics",
        "Returns FusaoChatBot CRM (Z-PRO) funnel counts for the tenant since the given date: total conversations, agent-handled, escalated to human, and resolved.",
      ),
      response: errors(400, 401),
    },
  )
  .get(
    "/conversations/:id",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = BigInt(params.id);
      const row = await runScopedOn(basePrisma, ctx, (db) =>
        db.zproConversation.findUnique({
          where: { id },
          select: CONVERSATION_SELECT,
        }),
      );
      if (!row) {
        throw new NotFoundError(
          "zpro conversation not found",
          "errors.zproConversationNotFound",
        );
      }
      return { conversation: conversationToDto(row) };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({ description: "Z-PRO conversation id (BigInt string)." }),
      }),
      detail: doc(
        "Get Z-PRO conversation",
        "Returns a single mirrored Z-PRO conversation by primary key.",
      ),
      response: errors(400, 401, 404),
    },
  )
  // Same CSP constraint as the Chatwoot avatar proxy (img-src is 'self' only) — no caller-supplied
  // url, just the conversation id; the URL fetched is always the one we already stored server-side
  // from a trusted Z-PRO webhook (contact-create-update), still anti-SSRF-checked defensively.
  .get(
    "/conversations/:id/avatar",
    async ({ tenantContext, params, set }) => {
      const ctx = ctxOrThrow(tenantContext);
      const row = await runScopedOn(basePrisma, ctx, (db) =>
        db.zproConversation.findUnique({
          where: { id: BigInt(params.id) },
          select: { avatarUrl: true },
        }),
      );
      if (!row?.avatarUrl) {
        set.status = 404;
        return { error: "Not Found" };
      }
      const url = await assertSafeOutboundUrl(row.avatarUrl);
      const res = await fetch(url);
      if (!res.ok) {
        set.status = 404;
        return { error: "Not Found" };
      }
      return new Response(await res.arrayBuffer(), {
        headers: {
          "content-type":
            res.headers.get("content-type") ?? "application/octet-stream",
          "cache-control": "private, max-age=3600",
        },
      });
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({ description: "Z-PRO conversation id (BigInt string)." }),
      }),
      detail: doc(
        "Stream the Z-PRO contact's avatar",
        "Proxies the contact's mirrored WhatsApp profile photo through our origin for CSP-clean rendering. 404 when no avatar is on file.",
      ),
      response: errors(400, 401, 404),
    },
  )
  // Separate from the metadata above so a slow/large thread doesn't block the header.
  .get(
    "/conversations/:id/messages",
    async ({ tenantContext, params }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = BigInt(params.id);
      const conversation = await runScopedOn(basePrisma, ctx, (db) =>
        db.zproConversation.findUnique({
          where: { id },
          select: { id: true },
        }),
      );
      if (!conversation) {
        throw new NotFoundError(
          "zpro conversation not found",
          "errors.zproConversationNotFound",
        );
      }
      const messages = await runScopedOn(basePrisma, ctx, (db) =>
        db.zproMessage.findMany({
          where: { conversationId: id },
          orderBy: { timestamp: "asc" },
          take: 200,
          select: MESSAGE_SELECT,
        }),
      );
      return { messages: messages.map(messageToDto) };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({ description: "Z-PRO conversation id (BigInt string)." }),
      }),
      detail: doc(
        "List Z-PRO messages",
        "Lists mirrored messages for a Z-PRO conversation (oldest first).",
      ),
      response: errors(400, 401, 404),
    },
  )
  .post(
    "/conversations/:id/toggle-agent",
    async ({ tenantContext, params, body }) => {
      const ctx = ctxOrThrow(tenantContext);
      const id = BigInt(params.id);
      const conv = await runScopedOn(basePrisma, ctx, (db) =>
        db.zproConversation.findUnique({
          where: { id },
          select: {
            ticketId: true,
            zproInstance: {
              select: { baseUrl: true, apiId: true, bearerToken: true },
            },
          },
        }),
      );
      if (!conv) {
        throw new NotFoundError(
          "zpro conversation not found",
          "errors.zproConversationNotFound",
        );
      }

      const client = new ZproClient(
        conv.zproInstance.baseUrl,
        conv.zproInstance.apiId,
        decryptJson<string>(conv.zproInstance.bearerToken),
      );

      if (body.agentActive) {
        await activateAgent(client, conv.ticketId);
      } else {
        await deactivateAgent(client, conv.ticketId);
      }

      await runScopedOn(basePrisma, ctx, (db) =>
        db.zproConversation.update({
          where: { id },
          data: { agentActive: body.agentActive },
        }),
      );

      broadcastZproAgentToggled(ctx.tenantId as bigint, {
        conversationId: String(id),
        ticketId: conv.ticketId,
        agentActive: body.agentActive,
      });

      return { success: true, agentActive: body.agentActive };
    },
    {
      requireAuth: true,
      params: t.Object({
        id: t.String({ description: "Z-PRO conversation id (BigInt string)." }),
      }),
      body: t.Object({
        agentActive: t.Boolean({
          description:
            "true to activate the AI agent on this ticket, false to hand off to a human.",
        }),
      }),
      detail: doc(
        "Toggle Z-PRO agent",
        "Activates or deactivates the AI agent (n8nStatus) for a Z-PRO conversation.",
      ),
      response: errors(400, 401, 404),
    },
  );
