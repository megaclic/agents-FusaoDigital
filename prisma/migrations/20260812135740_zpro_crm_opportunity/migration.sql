-- AlterTable
ALTER TABLE "zpro_conversations" ADD COLUMN     "opportunity_id" INTEGER,
ADD COLUMN     "opportunity_pipeline_id" INTEGER,
ADD COLUMN     "opportunity_stage_id" INTEGER,
ADD COLUMN     "opportunity_stage_name" TEXT;
