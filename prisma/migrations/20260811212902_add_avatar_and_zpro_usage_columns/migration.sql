-- AlterTable
ALTER TABLE "contacts" ADD COLUMN     "avatar_url" TEXT;

-- AlterTable
ALTER TABLE "llm_usage" ADD COLUMN     "zpro_conversation_id" BIGINT;

-- AlterTable
ALTER TABLE "zpro_conversations" ADD COLUMN     "avatar_url" TEXT;

-- CreateIndex
CREATE INDEX "llm_usage_tenant_id_zpro_conversation_id_idx" ON "llm_usage"("tenant_id", "zpro_conversation_id");
