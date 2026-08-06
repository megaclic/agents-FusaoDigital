-- CreateTable
CREATE TABLE "zpro_instances" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "base_url" TEXT NOT NULL,
    "api_id" TEXT NOT NULL,
    "bearer_token" TEXT NOT NULL,
    "whatsapp_id" INTEGER NOT NULL,
    "instance_name" TEXT NOT NULL,
    "disconnected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zpro_instances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zpro_webhook_deliveries" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "zpro_instance_id" BIGINT NOT NULL,
    "message_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "status" "InboundDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "zpro_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "zpro_agent_bindings" (
    "id" BIGSERIAL NOT NULL,
    "tenant_id" BIGINT NOT NULL,
    "zpro_instance_id" BIGINT NOT NULL,
    "agent_id" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "zpro_agent_bindings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "zpro_instances_tenant_id_idx" ON "zpro_instances"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "zpro_instances_tenant_id_whatsapp_id_key" ON "zpro_instances"("tenant_id", "whatsapp_id");

-- CreateIndex
CREATE INDEX "zpro_webhook_deliveries_tenant_id_idx" ON "zpro_webhook_deliveries"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "zpro_webhook_deliveries_zpro_instance_id_message_id_key" ON "zpro_webhook_deliveries"("zpro_instance_id", "message_id");

-- CreateIndex
CREATE INDEX "zpro_agent_bindings_tenant_id_idx" ON "zpro_agent_bindings"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "zpro_agent_bindings_tenant_id_zpro_instance_id_agent_id_key" ON "zpro_agent_bindings"("tenant_id", "zpro_instance_id", "agent_id");

-- AddForeignKey
ALTER TABLE "zpro_instances" ADD CONSTRAINT "zpro_instances_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_webhook_deliveries" ADD CONSTRAINT "zpro_webhook_deliveries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_webhook_deliveries" ADD CONSTRAINT "zpro_webhook_deliveries_zpro_instance_id_fkey" FOREIGN KEY ("zpro_instance_id") REFERENCES "zpro_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_agent_bindings" ADD CONSTRAINT "zpro_agent_bindings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_agent_bindings" ADD CONSTRAINT "zpro_agent_bindings_zpro_instance_id_fkey" FOREIGN KEY ("zpro_instance_id") REFERENCES "zpro_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "zpro_agent_bindings" ADD CONSTRAINT "zpro_agent_bindings_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "agents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ── Row-Level Security ──
-- Same tenant_isolation policy as every other tenant-scoped table (see the baseline migration).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY['zpro_instances','zpro_webhook_deliveries','zpro_agent_bindings'];
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
