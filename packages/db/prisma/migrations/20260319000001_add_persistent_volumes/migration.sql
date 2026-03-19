-- CreateTable
CREATE TABLE "persistent_volumes" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT,
    "name" TEXT NOT NULL,
    "sizeGb" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATING',
    "proxmoxNode" TEXT,
    "proxmoxDiskId" TEXT,
    "proxmoxStoragePool" TEXT DEFAULT 'local-lvm',
    "attachedToWorkspaceId" TEXT,
    "lastAttachedAt" DATETIME,
    "lastDetachedAt" DATETIME,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "persistent_volumes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "persistent_volumes_attachedToWorkspaceId_fkey" FOREIGN KEY ("attachedToWorkspaceId") REFERENCES "workspaces" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "persistent_volumes_attachedToWorkspaceId_key" ON "persistent_volumes"("attachedToWorkspaceId");

-- CreateIndex
CREATE INDEX "persistent_volumes_userId_idx" ON "persistent_volumes"("userId");

-- CreateIndex
CREATE INDEX "persistent_volumes_status_idx" ON "persistent_volumes"("status");
