/*
  Warnings:

  - You are about to drop the `ThreadGroup` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the column `status` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the column `groupId` on the `Thread` table. All the data in the column will be lost.
  - Added the required column `phaseId` to the `Thread` table without a default value. This is not possible if the table is not empty.

*/
-- DropIndex
DROP INDEX "ThreadGroup_jobId_ordinal_key";

-- DropTable
PRAGMA foreign_keys=off;
DROP TABLE "ThreadGroup";
PRAGMA foreign_keys=on;

-- CreateTable
CREATE TABLE "Phase" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "ordinal" INTEGER NOT NULL,
    CONSTRAINT "Phase_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "activeThreadId" TEXT,
    "archivedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Job" ("activeThreadId", "createdAt", "id", "projectId", "title", "updatedAt") SELECT "activeThreadId", "createdAt", "id", "projectId", "title", "updatedAt" FROM "Job";
DROP TABLE "Job";
ALTER TABLE "new_Job" RENAME TO "Job";
CREATE TABLE "new_Thread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "phaseId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "activeSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    CONSTRAINT "Thread_phaseId_fkey" FOREIGN KEY ("phaseId") REFERENCES "Phase" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Thread" ("activeSessionId", "closedAt", "createdAt", "id", "role", "status") SELECT "activeSessionId", "closedAt", "createdAt", "id", "role", "status" FROM "Thread";
DROP TABLE "Thread";
ALTER TABLE "new_Thread" RENAME TO "Thread";
CREATE INDEX "Thread_phaseId_idx" ON "Thread"("phaseId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Phase_jobId_ordinal_key" ON "Phase"("jobId", "ordinal");
