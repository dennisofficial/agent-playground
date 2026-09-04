-- CreateTable
CREATE TABLE "PerfSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "pid" INTEGER NOT NULL,
    "bootedAt" TEXT NOT NULL,
    "workspace" TEXT,
    "startedAt" TEXT NOT NULL,
    "endedAt" TEXT NOT NULL,
    "cpuUserMs" INTEGER NOT NULL,
    "cpuSysMs" INTEGER NOT NULL,
    "lagP50Ms" REAL NOT NULL,
    "lagP95Ms" REAL NOT NULL,
    "lagMaxMs" REAL NOT NULL,
    "rssMb" INTEGER NOT NULL,
    "heapMb" INTEGER NOT NULL,
    "turnActive" BOOLEAN NOT NULL,
    "counters" TEXT NOT NULL
);

-- CreateIndex
CREATE INDEX "PerfSample_pid_startedAt_idx" ON "PerfSample"("pid", "startedAt");

-- CreateIndex
CREATE INDEX "PerfSample_startedAt_idx" ON "PerfSample"("startedAt");
