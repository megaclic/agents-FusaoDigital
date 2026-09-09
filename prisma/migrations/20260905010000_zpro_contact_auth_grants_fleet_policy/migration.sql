-- 20260828105317_zpro_gap_parity created "zpro_contact_auth_grants" with only a tenant_isolation
-- policy, and one still carrying the PRE-split predicate (`current_setting('app.is_super_admin')
-- = 'on' OR tenant_id = ...`) that 20260827000000_rls_split_tenant_and_fleet_policies retired
-- everywhere else the day before — this table's own migration branched ahead of that rewrite and
-- was never carried forward. Two gaps tests/lib/rls-policy-shape.test.ts's checks caught: the
-- missing fleet_super_admin policy (same minimal addition 20260902130000_inbox_observers made for
-- a table in the same spot) and a tenant policy still naming the old GUC (`is_super_admin` has
-- granted nothing since #382 — see .claude/rules/prisma.md). Replaced with the tenant predicate
-- ALONE, same as every other table, so the planner can turn it into an index condition and the
-- fleet role's separate policy is what carries cross-tenant reads now.
DROP POLICY tenant_isolation ON "zpro_contact_auth_grants";
CREATE POLICY tenant_isolation ON "zpro_contact_auth_grants"
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint);
DO $$ BEGIN EXECUTE format(
  'CREATE POLICY fleet_super_admin ON "zpro_contact_auth_grants" TO %I USING (true) WITH CHECK (true)',
  public.fazerai_fleet_role()); END $$;
