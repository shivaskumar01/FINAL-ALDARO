-- Migration: Enforce at most one RUNNING usage session per workspace at the DB level.
--
-- This closes billing invariant INV-1: "At most one RUNNING session per workspace."
-- Previously enforced by application guard only (findFirst + check before create).
-- Now enforced by a partial unique index that permits unlimited ENDED sessions
-- but prevents a second RUNNING session for the same workspace.
--
-- IMPORTANT: Run the precheck query first to find any existing violations.
-- See: scripts/db-queries/precheck-one-running-session.sql

-- Step 1: Create the partial unique index.
-- This allows multiple usage_sessions per workspace (historical ENDED sessions),
-- but only one row can have status = 'RUNNING' for any given workspaceId.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "usage_sessions_one_running_per_workspace"
  ON "usage_sessions" ("workspaceId")
  WHERE status = 'RUNNING';
