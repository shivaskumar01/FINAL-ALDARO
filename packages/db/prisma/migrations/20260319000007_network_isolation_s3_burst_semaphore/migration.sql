-- Phase 13: Network Isolation, S3 Object Storage, Clone Semaphore, Hybrid Burst

-- Workspace: VLAN + S3 fields
ALTER TABLE "workspaces" ADD COLUMN "vlanTag" INTEGER;
ALTER TABLE "workspaces" ADD COLUMN "s3BucketName" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "s3AccessKeyId" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "s3SecretAccessKeyEnc" TEXT;

-- Burst Nodes
CREATE TABLE "burst_nodes" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "provider" TEXT NOT NULL,
  "providerInstanceId" TEXT,
  "region" TEXT NOT NULL DEFAULT 'US',
  "gpuType" TEXT NOT NULL,
  "gpuCount" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'PROVISIONING',
  "proxmoxNodeName" TEXT,
  "hourlyRateCents" INTEGER NOT NULL DEFAULT 0,
  "triggerReason" TEXT,
  "provisionedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "joinedAt" DATETIME,
  "drainingAt" DATETIME,
  "terminatedAt" DATETIME,
  "lastErrorCode" TEXT,
  "lastErrorMessage" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "burst_nodes_providerInstanceId_key" ON "burst_nodes"("providerInstanceId");
CREATE INDEX "burst_nodes_status_idx" ON "burst_nodes"("status");
CREATE INDEX "burst_nodes_provider_status_idx" ON "burst_nodes"("provider", "status");

-- Clone Semaphore
CREATE TABLE "clone_semaphores" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "proxmoxNode" TEXT NOT NULL,
  "workspaceId" TEXT NOT NULL,
  "acquiredAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" DATETIME
);

CREATE UNIQUE INDEX "clone_semaphores_workspaceId_key" ON "clone_semaphores"("workspaceId");
CREATE INDEX "clone_semaphores_proxmoxNode_releasedAt_idx" ON "clone_semaphores"("proxmoxNode", "releasedAt");
