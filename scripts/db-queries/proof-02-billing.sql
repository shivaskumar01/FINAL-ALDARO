-- Proof 02: Billing Parity — DB query pack
-- Run with: psql "$DATABASE_URL" -f scripts/db-queries/proof-02-billing.sql -v ws_id='WORKSPACE_ID'

\echo '=== Usage Session ==='
SELECT id, "workspaceId", "userId", "startTime", "endTime",
       "totalSeconds", "billedSeconds", "billedCents", status,
       "pricePerHourCents", "gpuType"
FROM usage_sessions WHERE "workspaceId" = :'ws_id';

\echo '=== Meter Outbox ==='
SELECT o.id, o."usageSessionId", o."valueSeconds", o.status,
       o."stripeMeterEventId", o."sentAt", o."attemptCount",
       o."lastErrorCode", o."lastErrorMessage"
FROM workspace_meter_event_outbox o
JOIN usage_sessions s ON o."usageSessionId" = s.id
WHERE s."workspaceId" = :'ws_id';

\echo '=== Billing Math Check ==='
SELECT id, "totalSeconds", "billedCents", "pricePerHourCents",
  CEIL("totalSeconds" * "pricePerHourCents" / 3600.0) AS expected_billed_cents,
  CASE WHEN "billedCents" = CEIL("totalSeconds" * "pricePerHourCents" / 3600.0) THEN 'MATCH' ELSE 'MISMATCH' END AS billing_check
FROM usage_sessions WHERE "workspaceId" = :'ws_id';

\echo '=== Orphan Check ==='
SELECT 'allocated_gpus' AS check, COUNT(*) FROM fleet_gpus WHERE status = 'ALLOCATED' AND "currentWorkspaceId" = :'ws_id'
UNION ALL
SELECT 'unreleased_endpoints', COUNT(*) FROM workspace_endpoints WHERE "workspaceId" = :'ws_id' AND "releasedAt" IS NULL
UNION ALL
SELECT 'running_sessions', COUNT(*) FROM usage_sessions WHERE "workspaceId" = :'ws_id' AND status = 'RUNNING';

\echo '=== Duplicate Outbox Check ==='
SELECT "usageSessionId", COUNT(*) AS cnt
FROM workspace_meter_event_outbox
WHERE "usageSessionId" IN (SELECT id FROM usage_sessions WHERE "workspaceId" = :'ws_id')
GROUP BY "usageSessionId"
HAVING COUNT(*) > 1;
