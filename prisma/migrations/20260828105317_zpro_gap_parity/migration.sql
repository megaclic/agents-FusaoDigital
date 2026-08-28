-- AlterTable
ALTER TABLE "zpro_conversations" ADD COLUMN     "away_message_sent_at" TIMESTAMP(3),
ADD COLUMN     "contact_extra_info" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "zpro_contact_auth_grants" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "zpro_instance_id" BIGINT NOT NULL,
    "contact_number" TEXT NOT NULL,
    "identity_hash" TEXT NOT NULL,
    "policy_hash" TEXT NOT NULL,
    "context" JSONB,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zpro_contact_auth_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zpro_contact_auth_grants_agent_id_idx" ON "zpro_contact_auth_grants"("agent_id");

-- CreateIndex
CREATE INDEX "zpro_contact_auth_grants_zpro_instance_id_idx" ON "zpro_contact_auth_grants"("zpro_instance_id");

-- CreateIndex
CREATE UNIQUE INDEX "zpro_contact_auth_grants_tenant_id_agent_id_contact_number_key" ON "zpro_contact_auth_grants"("tenant_id", "agent_id", "contact_number");

-- AddForeignKey
ALTER TABLE "zpro_contact_auth_grants" ADD CONSTRAINT "zpro_contact_auth_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_contact_auth_grants" ADD CONSTRAINT "zpro_contact_auth_grants_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_contact_auth_grants" ADD CONSTRAINT "zpro_contact_auth_grants_zpro_instance_id_fkey" FOREIGN KEY ("zpro_instance_id") REFERENCES "zpro_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RLS: same tenant fence every tenant-scoped table carries (see 20260827000000_init).
ALTER TABLE "zpro_contact_auth_grants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "zpro_contact_auth_grants" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "zpro_contact_auth_grants"
  USING (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  )
  WITH CHECK (
    current_setting('app.is_super_admin', true) = 'on'
    OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
  );
