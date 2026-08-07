-- CreateEnum
CREATE TYPE "ZproSenderType" AS ENUM ('CLIENT', 'AGENT', 'HUMAN');

-- CreateTable
CREATE TABLE "zpro_conversations" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "zpro_instance_id" BIGINT NOT NULL,
    "ticket_id" INTEGER NOT NULL,
    "ticket_protocol" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "contact_id" INTEGER NOT NULL,
    "contact_number" TEXT NOT NULL,
    "contact_name" TEXT NOT NULL,
    "agent_active" BOOLEAN NOT NULL DEFAULT false,
    "human_user_id" INTEGER,
    "last_message_at" TIMESTAMP(3),
    "last_message_body" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zpro_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zpro_messages" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "conversation_id" BIGINT NOT NULL,
    "message_id" TEXT NOT NULL,
    "sender_type" "ZproSenderType" NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "message_type" TEXT NOT NULL,
    "media_url" TEXT,
    "media_caption" TEXT,
    "media_file_name" TEXT,
    "from_me" BOOLEAN NOT NULL,
    "timestamp" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "zpro_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zpro_conversations_tenant_id_idx" ON "zpro_conversations"("tenant_id");

-- CreateIndex
CREATE INDEX "zpro_conversations_tenant_id_status_idx" ON "zpro_conversations"("tenant_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "zpro_conversations_zpro_instance_id_ticket_id_key" ON "zpro_conversations"("zpro_instance_id", "ticket_id");

-- CreateIndex
CREATE INDEX "zpro_messages_tenant_id_idx" ON "zpro_messages"("tenant_id");

-- CreateIndex
CREATE INDEX "zpro_messages_conversation_id_timestamp_idx" ON "zpro_messages"("conversation_id", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "zpro_messages_conversation_id_message_id_key" ON "zpro_messages"("conversation_id", "message_id");

-- AddForeignKey
ALTER TABLE "zpro_conversations" ADD CONSTRAINT "zpro_conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_conversations" ADD CONSTRAINT "zpro_conversations_zpro_instance_id_fkey" FOREIGN KEY ("zpro_instance_id") REFERENCES "zpro_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_messages" ADD CONSTRAINT "zpro_messages_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_messages" ADD CONSTRAINT "zpro_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "zpro_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security ──
-- Same tenant_isolation policy as every other tenant-scoped table (see the baseline migration).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['zpro_conversations','zpro_messages'];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (
          current_setting('app.is_super_admin', true) = 'on'
          OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
        )
        WITH CHECK (
          current_setting('app.is_super_admin', true) = 'on'
          OR tenant_id = nullif(current_setting('app.tenant_id', true), '')::bigint
        )
    $f$, t);
  END LOOP;
END $$;
