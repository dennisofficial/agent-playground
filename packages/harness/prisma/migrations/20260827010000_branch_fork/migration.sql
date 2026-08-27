-- AlterTable
ALTER TABLE "Branch" ADD COLUMN "parentBranchId" TEXT;

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN "forkSeq" INTEGER;

-- AlterTable
ALTER TABLE "Branch" ADD COLUMN "forkMode" TEXT;

-- CreateIndex
CREATE INDEX "Branch_parentBranchId_idx" ON "Branch"("parentBranchId");
