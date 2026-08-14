-- AlterTable
ALTER TABLE "zpro_conversations" ADD COLUMN     "contact_tags" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "queue_id" INTEGER;
