-- AlterTable
ALTER TABLE "zpro_conversations" ADD COLUMN     "last_follow_up_at" TIMESTAMP(3),
ADD COLUMN     "last_inbound_at" TIMESTAMP(3);
