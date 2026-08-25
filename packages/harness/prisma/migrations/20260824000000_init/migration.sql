-- CreateTable
CREATE TABLE "Branch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "head" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "Event" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "branchId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "runId" TEXT NOT NULL,
    "parentRunId" TEXT,
    "depth" INTEGER NOT NULL,
    "at" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "contextSlot" TEXT,
    "contextKey" TEXT,
    CONSTRAINT "Event_branchId_fkey" FOREIGN KEY ("branchId") REFERENCES "Branch" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Branch_updatedAt_idx" ON "Branch"("updatedAt");

-- CreateIndex
CREATE INDEX "Event_branchId_type_idx" ON "Event"("branchId", "type");

-- CreateIndex
CREATE UNIQUE INDEX "Event_branchId_seq_key" ON "Event"("branchId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "Event_branchId_contextSlot_contextKey_key" ON "Event"("branchId", "contextSlot", "contextKey");

