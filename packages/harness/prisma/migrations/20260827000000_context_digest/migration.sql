-- AlterTable
ALTER TABLE "Event" ADD COLUMN "contextDigest" TEXT;

-- DropIndex
DROP INDEX "Event_branchId_contextSlot_contextKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "Event_branchId_contextSlot_contextKey_contextDigest_key" ON "Event"("branchId", "contextSlot", "contextKey", "contextDigest");
