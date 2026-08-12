-- AlterTable
ALTER TABLE "EngineSession" ADD COLUMN "engineConfig" JSONB;

-- AlterTable
ALTER TABLE "Job" ADD COLUMN "branch" TEXT;
ALTER TABLE "Job" ADD COLUMN "workspacePath" TEXT;
