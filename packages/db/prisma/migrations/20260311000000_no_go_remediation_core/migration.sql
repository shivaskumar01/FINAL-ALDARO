-- Workspaces: idempotency and cleanup metadata
ALTER TABLE "workspaces" ADD COLUMN "launchOperationKey" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "cleanupAttemptCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "workspaces" ADD COLUMN "cleanupLastAttemptAt" DATETIME;
ALTER TABLE "workspaces" ADD COLUMN "cleanupNextRetryAt" DATETIME;
ALTER TABLE "workspaces" ADD COLUMN "cleanupLastErrorCode" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "cleanupLastErrorMessage" TEXT;

CREATE INDEX IF NOT EXISTS "workspaces_status_cleanupNextRetryAt_idx"
  ON "workspaces"("status", "cleanupNextRetryAt");

-- Launch idempotency operations
CREATE TABLE IF NOT EXISTS "workspace_launch_operations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "operationKey" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "workspaceId" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PROCESSING',
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "workspace_launch_operations_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_launch_operations_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_launch_operations_userId_operationKey_key"
  ON "workspace_launch_operations"("userId", "operationKey");
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_launch_operations_workspaceId_key"
  ON "workspace_launch_operations"("workspaceId");
CREATE INDEX IF NOT EXISTS "workspace_launch_operations_status_updatedAt_idx"
  ON "workspace_launch_operations"("status", "updatedAt");

-- Cleanup queue for resilient async termination/reconciliation
CREATE TABLE IF NOT EXISTS "workspace_cleanup_jobs" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "workspaceId" TEXT NOT NULL,
  "reasonCode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 20,
  "lastAttemptAt" DATETIME,
  "nextAttemptAt" DATETIME,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" DATETIME,
  CONSTRAINT "workspace_cleanup_jobs_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_cleanup_jobs_workspaceId_key"
  ON "workspace_cleanup_jobs"("workspaceId");
CREATE INDEX IF NOT EXISTS "workspace_cleanup_jobs_status_nextAttemptAt_idx"
  ON "workspace_cleanup_jobs"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "workspace_cleanup_jobs_status_updatedAt_idx"
  ON "workspace_cleanup_jobs"("status", "updatedAt");

-- Meter event outbox for resilient Stripe metering emission
CREATE TABLE IF NOT EXISTS "workspace_meter_event_outbox" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "usageSessionId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "eventName" TEXT NOT NULL DEFAULT 'gpu_seconds',
  "valueSeconds" INTEGER NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 20,
  "lastAttemptAt" DATETIME,
  "nextAttemptAt" DATETIME,
  "stripeMeterEventId" TEXT,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sentAt" DATETIME,
  CONSTRAINT "workspace_meter_event_outbox_usageSessionId_fkey"
    FOREIGN KEY ("usageSessionId") REFERENCES "usage_sessions" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_meter_event_outbox_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "workspace_meter_event_outbox_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "workspace_meter_event_outbox_usageSessionId_key"
  ON "workspace_meter_event_outbox"("usageSessionId");
CREATE INDEX IF NOT EXISTS "workspace_meter_event_outbox_status_nextAttemptAt_idx"
  ON "workspace_meter_event_outbox"("status", "nextAttemptAt");
CREATE INDEX IF NOT EXISTS "workspace_meter_event_outbox_userId_createdAt_idx"
  ON "workspace_meter_event_outbox"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "workspace_meter_event_outbox_workspaceId_createdAt_idx"
  ON "workspace_meter_event_outbox"("workspaceId", "createdAt");
