-- CreateIndex
CREATE INDEX "zpro_conversations_tenant_id_last_message_at_idx" ON "zpro_conversations"("tenant_id", "last_message_at");
