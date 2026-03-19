-- CreateTable
CREATE TABLE "image_registry_credentials" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Default Registry',
    "registryUrl" TEXT NOT NULL,
    "registryType" TEXT NOT NULL DEFAULT 'DOCKER_HUB',
    "username" TEXT,
    "encryptedToken" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "lastVerifiedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "image_registry_credentials_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- AlterTable: Add custom image fields to workspaces
ALTER TABLE "workspaces" ADD COLUMN "customImageRepo" TEXT;
ALTER TABLE "workspaces" ADD COLUMN "customImageTag" TEXT DEFAULT 'latest';
ALTER TABLE "workspaces" ADD COLUMN "registryCredentialId" TEXT REFERENCES "image_registry_credentials" ("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "image_registry_credentials_userId_idx" ON "image_registry_credentials"("userId");
