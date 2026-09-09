-- Same rule as issue #373's eighteen (see 20260826230000_drop_redundant_tenant_index_agent_threads),
-- caught late because ZproAgentBinding does not exist upstream: `@@index([tenantId])` beside
-- `@@unique([tenantId, zproInstanceId, agentId])`, and a unique btree serves the prefix exactly like
-- a plain one.
DROP INDEX CONCURRENTLY IF EXISTS "zpro_agent_bindings_tenant_id_idx";
