-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "engine" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "accountEmail" TEXT,
    "subscriptionType" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "materialEnc" TEXT NOT NULL,
    "expiresAt" DATETIME,
    "lastRefreshedAt" DATETIME,
    "fiveHourUtil" REAL,
    "fiveHourResetsAt" DATETIME,
    "sevenDayUtil" REAL,
    "sevenDayResetsAt" DATETIME,
    "usageFetchedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "path" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "lastOpenedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "activeThreadId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Job_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ThreadGroup" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "jobId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "ordinal" INTEGER NOT NULL,
    CONSTRAINT "ThreadGroup_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "Job" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Thread" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "activeSessionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" DATETIME,
    CONSTRAINT "Thread_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "ThreadGroup" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "EngineSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "accountId" TEXT NOT NULL,
    "engine" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "engineSessionId" TEXT,
    "seededFromId" TEXT,
    "handoff" TEXT,
    "endReason" TEXT,
    "lockedBy" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    CONSTRAINT "EngineSession_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "EngineSession_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ThreadMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "threadId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ThreadMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "Thread" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ThreadMessage_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "EngineSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_engine_accountEmail_key" ON "Account"("engine", "accountEmail");

-- CreateIndex
CREATE UNIQUE INDEX "Project_path_key" ON "Project"("path");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadGroup_jobId_ordinal_key" ON "ThreadGroup"("jobId", "ordinal");

-- CreateIndex
CREATE INDEX "Thread_groupId_idx" ON "Thread"("groupId");

-- CreateIndex
CREATE INDEX "EngineSession_accountId_idx" ON "EngineSession"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "EngineSession_threadId_ordinal_key" ON "EngineSession"("threadId", "ordinal");

-- CreateIndex
CREATE INDEX "ThreadMessage_sessionId_idx" ON "ThreadMessage"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "ThreadMessage_threadId_ordinal_key" ON "ThreadMessage"("threadId", "ordinal");
