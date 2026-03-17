-- Precheck: Find any existing violations of the one-RUNNING-session-per-workspace constraint.
-- Run BEFORE applying the migration. If this returns rows, resolve them first.
--
-- Usage: psql "$DATABASE_URL" -f scripts/db-queries/precheck-one-running-session.sql

\echo '=== Precheck: Duplicate RUNNING sessions per workspace ==='

-- Find workspaces with more than one RUNNING session
SELECT "workspaceId", COUNT(*) AS running_count
FROM usage_sessions
WHERE status = 'RUNNING'
GROUP BY "workspaceId"
HAVING COUNT(*) > 1;

\echo '=== Detail: All RUNNING sessions for violating workspaces ==='

SELECT s.id, s."workspaceId", s."userId", s."startTime", s."pricePerHourCents"
FROM usage_sessions s
WHERE s.status = 'RUNNING'
  AND s."workspaceId" IN (
    SELECT "workspaceId"
    FROM usage_sessions
    WHERE status = 'RUNNING'
    GROUP BY "workspaceId"
    HAVING COUNT(*) > 1
  )
ORDER BY s."workspaceId", s."startTime";

\echo '=== Cleanup: Keep newest RUNNING session per workspace, close older duplicates ==='
\echo '(Dry run - uncomment UPDATE to execute)'

-- To fix violations: keep the newest RUNNING session, close all older ones.
-- Uncomment the UPDATE below to apply:
--
-- WITH ranked AS (
--   SELECT id, "workspaceId",
--     ROW_NUMBER() OVER (PARTITION BY "workspaceId" ORDER BY "startTime" DESC) AS rn
--   FROM usage_sessions
--   WHERE status = 'RUNNING'
-- )
-- UPDATE usage_sessions
-- SET status = 'ENDED',
--     "endTime" = NOW(),
--     "totalSeconds" = CEIL(EXTRACT(EPOCH FROM NOW() - "startTime")),
--     "billedCents" = CEIL(CEIL(EXTRACT(EPOCH FROM NOW() - "startTime")) * "pricePerHourCents" / 3600)
-- WHERE id IN (SELECT id FROM ranked WHERE rn > 1);

\echo '=== End Precheck ==='
