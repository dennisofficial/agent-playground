-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Account" (
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
    "extraUsageAllowed" BOOLEAN NOT NULL DEFAULT false,
    "fastMode" BOOLEAN NOT NULL DEFAULT false,
    "extraUsageEnabled" BOOLEAN,
    "extraUsageUtil" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO "new_Account" ("accountEmail", "createdAt", "engine", "expiresAt", "fiveHourResetsAt", "fiveHourUtil", "id", "label", "lastRefreshedAt", "materialEnc", "sevenDayResetsAt", "sevenDayUtil", "status", "subscriptionType", "usageFetchedAt") SELECT "accountEmail", "createdAt", "engine", "expiresAt", "fiveHourResetsAt", "fiveHourUtil", "id", "label", "lastRefreshedAt", "materialEnc", "sevenDayResetsAt", "sevenDayUtil", "status", "subscriptionType", "usageFetchedAt" FROM "Account";
DROP TABLE "Account";
ALTER TABLE "new_Account" RENAME TO "Account";
CREATE UNIQUE INDEX "Account_engine_accountEmail_key" ON "Account"("engine", "accountEmail");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
