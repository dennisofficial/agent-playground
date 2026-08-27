DROP INDEX "Branch_parentBranchId_idx";
DROP INDEX "Branch_updatedAt_idx";
DROP INDEX "Event_branchId_type_idx";
DROP INDEX "Event_branchId_seq_key";
DROP INDEX "Event_branchId_contextSlot_contextKey_contextDigest_key";
DROP INDEX "Turn_branchId_startedAt_idx";

ALTER TABLE "Branch" RENAME TO "Thread";
ALTER TABLE "Thread" RENAME COLUMN "parentBranchId" TO "parentThreadId";
ALTER TABLE "Event" RENAME COLUMN "branchId" TO "threadId";
ALTER TABLE "Turn" RENAME COLUMN "branchId" TO "threadId";

CREATE INDEX "Thread_updatedAt_idx" ON "Thread"("updatedAt");
CREATE INDEX "Thread_parentThreadId_idx" ON "Thread"("parentThreadId");
CREATE INDEX "Event_threadId_type_idx" ON "Event"("threadId", "type");
CREATE UNIQUE INDEX "Event_threadId_seq_key" ON "Event"("threadId", "seq");
CREATE UNIQUE INDEX "Event_threadId_contextSlot_contextKey_contextDigest_key" ON "Event"("threadId", "contextSlot", "contextKey", "contextDigest");
CREATE INDEX "Turn_threadId_startedAt_idx" ON "Turn"("threadId", "startedAt");
