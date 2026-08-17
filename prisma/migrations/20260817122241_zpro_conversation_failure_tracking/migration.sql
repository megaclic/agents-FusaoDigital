-- AlterTable
ALTER TABLE "zpro_conversations" ADD COLUMN     "failure_notice_sent_at" TIMESTAMP(3),
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "last_error_at" TIMESTAMP(3);
