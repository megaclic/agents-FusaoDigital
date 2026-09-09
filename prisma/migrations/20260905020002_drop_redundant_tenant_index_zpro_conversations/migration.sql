-- Same rule as issue #373's eighteen (see 20260826230000_drop_redundant_tenant_index_agent_threads),
-- caught late because ZproConversation does not exist upstream: `@@index([tenantId])` beside two
-- composites that already lead with tenantId (`[tenantId, status]`, `[tenantId, lastMessageAt]`).
DROP INDEX CONCURRENTLY IF EXISTS "zpro_conversations_tenant_id_idx";
