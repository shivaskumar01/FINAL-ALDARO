-- Workload recommender request log
CREATE TABLE IF NOT EXISTS "workload_recommendation_requests" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "userId" TEXT,
  "inputText" TEXT NOT NULL,
  "parsedJson" TEXT,
  "recommendationsJson" TEXT,
  "chosenGpuType" TEXT,
  "chosenTemplateId" TEXT,
  "latencyMs" INTEGER,
  "errorCode" TEXT,
  CONSTRAINT "workload_recommendation_requests_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "workload_recommendation_requests_createdAt_idx" ON "workload_recommendation_requests"("createdAt");
CREATE INDEX IF NOT EXISTS "workload_recommendation_requests_userId_idx" ON "workload_recommendation_requests"("userId");

-- Fleet daily aggregates
CREATE TABLE IF NOT EXISTS "fleet_daily_aggs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "date" DATETIME NOT NULL,
  "gpuType" TEXT NOT NULL,
  "gpuCount" INTEGER NOT NULL DEFAULT 0,
  "gpuHoursAvailable" REAL NOT NULL DEFAULT 0,
  "gpuHoursUsed" REAL NOT NULL DEFAULT 0,
  "utilizationPct" REAL NOT NULL DEFAULT 0,
  "revenueUsd" REAL NOT NULL DEFAULT 0,
  "sessionsCount" INTEGER NOT NULL DEFAULT 0,
  "uniqueCustomers" INTEGER NOT NULL DEFAULT 0,
  "newSignups" INTEGER NOT NULL DEFAULT 0,
  "newApprovals" INTEGER NOT NULL DEFAULT 0,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "fleet_daily_aggs_date_gpuType_key" ON "fleet_daily_aggs"("date", "gpuType");
CREATE INDEX IF NOT EXISTS "fleet_daily_aggs_date_idx" ON "fleet_daily_aggs"("date");
CREATE INDEX IF NOT EXISTS "fleet_daily_aggs_gpuType_idx" ON "fleet_daily_aggs"("gpuType");

-- Pricing suggestions (drafts only)
CREATE TABLE IF NOT EXISTS "pricing_suggestions" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "gpuType" TEXT NOT NULL,
  "currentRate" REAL NOT NULL,
  "suggestedRate" REAL NOT NULL,
  "reason" TEXT NOT NULL,
  "inputsJson" TEXT,
  "status" TEXT NOT NULL DEFAULT 'NEW',
  "appliedByUserId" TEXT,
  "appliedAt" DATETIME,
  CONSTRAINT "pricing_suggestions_appliedByUserId_fkey"
    FOREIGN KEY ("appliedByUserId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "pricing_suggestions_createdAt_idx" ON "pricing_suggestions"("createdAt");
CREATE INDEX IF NOT EXISTS "pricing_suggestions_gpuType_idx" ON "pricing_suggestions"("gpuType");
CREATE INDEX IF NOT EXISTS "pricing_suggestions_status_idx" ON "pricing_suggestions"("status");

