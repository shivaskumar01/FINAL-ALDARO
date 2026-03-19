-- CreateTable
CREATE TABLE "exposed_ports" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "internalPort" INTEGER NOT NULL,
    "publicSubdomain" TEXT NOT NULL,
    "publicUrl" TEXT NOT NULL,
    "accessMode" TEXT NOT NULL DEFAULT 'PRIVATE',
    "protocol" TEXT NOT NULL DEFAULT 'HTTP',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" DATETIME,
    CONSTRAINT "exposed_ports_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "workspaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "exposed_ports_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "exposed_ports_publicSubdomain_key" ON "exposed_ports"("publicSubdomain");

-- CreateIndex
CREATE UNIQUE INDEX "exposed_ports_workspaceId_internalPort_key" ON "exposed_ports"("workspaceId", "internalPort");

-- CreateIndex
CREATE INDEX "exposed_ports_workspaceId_idx" ON "exposed_ports"("workspaceId");

-- CreateIndex
CREATE INDEX "exposed_ports_publicSubdomain_idx" ON "exposed_ports"("publicSubdomain");
