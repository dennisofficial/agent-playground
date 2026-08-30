-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "workspace" TEXT;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "repo" TEXT;

-- CreateIndex
CREATE INDEX "Thread_workspace_updatedAt_idx" ON "Thread"("workspace", "updatedAt");
