-- AlterTable (SQLite: add columns to users)
ALTER TABLE "users" ADD COLUMN "customerAccessStatus" TEXT NOT NULL DEFAULT 'PENDING_REVIEW';
ALTER TABLE "users" ADD COLUMN "customerAccessUpdatedAt" DATETIME;
ALTER TABLE "users" ADD COLUMN "customerAccessUpdatedById" TEXT;
ALTER TABLE "users" ADD COLUMN "customerAccessReason" TEXT;

-- Backfill: existing customers (have workspaces or usage) get APPROVED
UPDATE "users" SET "customerAccessStatus" = 'APPROVED', "customerAccessUpdatedAt" = datetime('now')
WHERE "id" IN (SELECT DISTINCT "assignedUserId" FROM "workspaces" WHERE "assignedUserId" IS NOT NULL)
   OR "id" IN (SELECT DISTINCT "userId" FROM "usage_sessions");

-- CreateTable CustomerApplication
CREATE TABLE "customer_applications" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submittedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" DATETIME,
    "reviewedById" TEXT,
    "decision" TEXT,
    "decisionReason" TEXT,
    "internalNotes" TEXT,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "company" TEXT,
    "useCase" TEXT,
    "expectedGpuTypes" TEXT,
    "expectedHoursPerWeek" INTEGER,
    "regionPreference" TEXT,
    "website" TEXT,
    "referralSource" TEXT,
    CONSTRAINT "customer_applications_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "customer_applications_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "customer_applications_userId_idx" ON "customer_applications"("userId");
CREATE INDEX "customer_applications_decision_submittedAt_idx" ON "customer_applications"("decision", "submittedAt");
CREATE INDEX "customer_applications_reviewedAt_idx" ON "customer_applications"("reviewedAt");

-- CreateTable EmailOutbox
CREATE TABLE "email_outbox" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "toEmail" TEXT NOT NULL,
    "userId" TEXT,
    "applicationId" TEXT,
    "subject" TEXT NOT NULL,
    "bodyText" TEXT NOT NULL,
    "bodyHtml" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" DATETIME,
    "sentAt" DATETIME,
    "providerMessageId" TEXT,
    "dedupeKey" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "email_outbox_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "customer_applications" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "email_outbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "email_outbox_dedupeKey_key" ON "email_outbox"("dedupeKey");
CREATE INDEX "email_outbox_status_idx" ON "email_outbox"("status");
CREATE INDEX "email_outbox_type_idx" ON "email_outbox"("type");
