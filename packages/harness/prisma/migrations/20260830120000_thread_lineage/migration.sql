-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Thread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT,
    "head" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "parentThreadId" TEXT,
    "forkSeq" INTEGER,
    "forkMode" TEXT,
    "spawnerThreadId" TEXT,
    "agentType" TEXT,
    "workspace" TEXT,
    "repo" TEXT,
    CONSTRAINT "Thread_parentThreadId_fkey" FOREIGN KEY ("parentThreadId") REFERENCES "Thread" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION,
    CONSTRAINT "Thread_spawnerThreadId_fkey" FOREIGN KEY ("spawnerThreadId") REFERENCES "Thread" ("id") ON DELETE RESTRICT ON UPDATE NO ACTION
);
INSERT INTO "new_Thread" ("createdAt", "forkMode", "forkSeq", "head", "id", "parentThreadId", "repo", "title", "updatedAt", "workspace") SELECT "createdAt", "forkMode", "forkSeq", "head", "id", "parentThreadId", "repo", "title", "updatedAt", "workspace" FROM "Thread";
DROP TABLE "Thread";
ALTER TABLE "new_Thread" RENAME TO "Thread";
CREATE INDEX "Thread_updatedAt_idx" ON "Thread"("updatedAt");
CREATE INDEX "Thread_parentThreadId_idx" ON "Thread"("parentThreadId");
CREATE INDEX "Thread_spawnerThreadId_idx" ON "Thread"("spawnerThreadId");
CREATE INDEX "Thread_workspace_updatedAt_idx" ON "Thread"("workspace", "updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
