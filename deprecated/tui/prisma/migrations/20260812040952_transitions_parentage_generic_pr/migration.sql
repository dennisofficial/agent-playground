-- AlterTable
ALTER TABLE "Job" ADD COLUMN "prNumber" INTEGER;

-- AlterTable
ALTER TABLE "Thread" ADD COLUMN "openedByThreadId" TEXT;
ALTER TABLE "Thread" ADD COLUMN "parentThreadId" TEXT;

-- CreateTable
CREATE TABLE "Transition" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "fromPhaseId" TEXT,
    "raisedByThreadId" TEXT,
    "to" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'phase',
    "reason" TEXT NOT NULL,
    "handoff" TEXT,
    "attach" JSONB,
    "raisedBy" TEXT NOT NULL DEFAULT 'agent',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdPhaseId" TEXT,
    "declineReason" TEXT,
    "decidedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Transition_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Transition_jobId_status_idx" ON "Transition"("jobId", "status");
