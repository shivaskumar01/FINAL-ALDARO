-- Phase 11: Support Ticketing & One-Click Refunds
-- Phase 12: Budget Alerts (Chargeback Prevention)

-- Support Tickets
CREATE TABLE "support_tickets" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "workspaceId" TEXT,
  "usageSessionId" TEXT,
  "subject" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'OPEN',
  "priority" TEXT NOT NULL DEFAULT 'NORMAL',
  "category" TEXT,
  "assignedToId" TEXT,
  "refundedCents" INTEGER,
  "refundedAt" DATETIME,
  "resolvedAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "support_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "support_tickets_userId_idx" ON "support_tickets"("userId");
CREATE INDEX "support_tickets_status_idx" ON "support_tickets"("status");
CREATE INDEX "support_tickets_status_createdAt_idx" ON "support_tickets"("status", "createdAt");
CREATE INDEX "support_tickets_assignedToId_idx" ON "support_tickets"("assignedToId");

-- Ticket Messages
CREATE TABLE "ticket_messages" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ticketId" TEXT NOT NULL,
  "authorId" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "isInternal" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ticket_messages_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "support_tickets" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "ticket_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "ticket_messages_ticketId_idx" ON "ticket_messages"("ticketId");

-- Budget fields on User
ALTER TABLE "users" ADD COLUMN "monthlySoftLimitCents" INTEGER;
ALTER TABLE "users" ADD COLUMN "hardLimitAction" TEXT NOT NULL DEFAULT 'ALERT';
ALTER TABLE "users" ADD COLUMN "lastBudgetAlertAt" DATETIME;

-- Budget fields on Organization
ALTER TABLE "organizations" ADD COLUMN "monthlySoftLimitCents" INTEGER;
ALTER TABLE "organizations" ADD COLUMN "hardLimitAction" TEXT NOT NULL DEFAULT 'ALERT';
ALTER TABLE "organizations" ADD COLUMN "lastBudgetAlertAt" DATETIME;

-- Budget Alerts log
CREATE TABLE "budget_alerts" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "mtdSpendCents" INTEGER NOT NULL,
  "limitCents" INTEGER NOT NULL,
  "thresholdPct" INTEGER NOT NULL,
  "action" TEXT NOT NULL,
  "notifiedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "workspacesTerminated" INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX "budget_alerts_userId_idx" ON "budget_alerts"("userId");
CREATE INDEX "budget_alerts_notifiedAt_idx" ON "budget_alerts"("notifiedAt");
