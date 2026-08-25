/*
  Warnings:

  - You are about to drop the column `lockedBy` on the `EngineSession` table. All the data in the column will be lost.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_EngineSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "engineConfig" JSONB,
    "engineSessionId" TEXT,
    "seededFromId" TEXT,
    "handoff" TEXT,
    "endReason" TEXT,
    "contextPercent" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "EngineSession_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngineSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_EngineSession" ("accountId", "contextPercent", "createdAt", "endReason", "endedAt", "engine", "engineConfig", "engineSessionId", "handoff", "id", "model", "ordinal", "seededFromId", "threadId") SELECT "accountId", "contextPercent", "createdAt", "endReason", "endedAt", "engine", "engineConfig", "engineSessionId", "handoff", "id", "model", "ordinal", "seededFromId", "threadId" FROM "EngineSession";
DROP TABLE "EngineSession";
ALTER TABLE "new_EngineSession" RENAME TO "EngineSession";
CREATE INDEX "EngineSession_accountId_idx" ON "EngineSession"("accountId");
CREATE UNIQUE INDEX "EngineSession_threadId_ordinal_key" ON "EngineSession"("threadId", "ordinal");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
