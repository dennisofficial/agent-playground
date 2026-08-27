-- CreateTable
CREATE TABLE "Turn" (
    "runId" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "steps" INTEGER NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "cacheReadTokens" INTEGER NOT NULL,
    "cacheWriteTokens" INTEGER NOT NULL,
    "startedAt" TEXT NOT NULL,
    "endedAt" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL,
    CONSTRAINT "Turn_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Turn_branchId_startedAt_idx" ON "Turn"("branchId", "startedAt");
