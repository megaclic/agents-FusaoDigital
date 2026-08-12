-- AlterTable
ALTER TABLE "zpro_conversations" ADD COLUMN     "redirect_chatwoot_contact_id" INTEGER,
ADD COLUMN     "redirect_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "redirect_sent_at" TIMESTAMP(3);
