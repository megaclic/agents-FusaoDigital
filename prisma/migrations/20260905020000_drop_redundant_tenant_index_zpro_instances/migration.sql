-- Same rule as issue #373's eighteen (see 20260826230000_drop_redundant_tenant_index_agent_threads),
-- caught late because ZproInstance does not exist upstream: `@@index([tenantId])` beside
-- `@@unique([tenantId, whatsappId])`, and a unique btree serves the prefix exactly like a plain one.
--
-- IF EXISTS, because a concurrent drop that is cancelled can leave the index marked invalid and the
-- file is marked rolled back and run again.
DROP INDEX CONCURRENTLY IF EXISTS "zpro_instances_tenant_id_idx";
