-- Billing State Inspection Queries
-- Run against the Postgres database to audit billing state at any point.
-- All queries use quoted camelCase column names (Prisma convention on Postgres).

-- 1. Active sessions (should only exist for RUNNING_ASSIGNED workspaces)
SELECT
  us.id AS session_id,
  us."workspaceId",
  us."userId",
  us."gpuType",
  us."pricePerHourCents",
  us."startTime",
  EXTRACT(EPOCH FROM (NOW() - us."startTime"))::int AS running_seconds,
  w.status AS workspace_status
FROM usage_sessions us
JOIN workspaces w ON us."workspaceId" = w.id
WHERE us.status = 'RUNNING'
ORDER BY us."startTime" ASC;

-- 2. Ended sessions with NO meter event enqueued (billing leak)
SELECT
  us.id AS session_id,
  us."workspaceId",
  us."userId",
  us."totalSeconds",
  us."billedCents",
  us."endTime",
  us.status AS session_status
FROM usage_sessions us
LEFT JOIN workspace_meter_event_outbox o ON o."usageSessionId" = us.id
WHERE us.status = 'ENDED'
  AND o.id IS NULL
ORDER BY us."endTime" DESC;

-- 3. Enqueued but not yet emitted (pending/retry backlog)
SELECT
  o.id AS outbox_id,
  o."usageSessionId",
  o."userId",
  o."valueSeconds",
  o.status AS outbox_status,
  o."attemptCount",
  o."maxAttempts",
  o."nextAttemptAt",
  o."lastErrorCode",
  o."createdAt"
FROM workspace_meter_event_outbox o
WHERE o.status IN ('PENDING', 'RETRY')
ORDER BY o."createdAt" ASC;

-- 4. Emitted but not reconciled (sent, check Stripe side manually)
SELECT
  o.id AS outbox_id,
  o."usageSessionId",
  o."userId",
  o."valueSeconds",
  o."stripeMeterEventId",
  o."sentAt",
  us."stripeMeterEventId" AS session_stripe_id,
  CASE WHEN o."stripeMeterEventId" = us."stripeMeterEventId" THEN 'MATCH' ELSE 'MISMATCH' END AS reconcile_status
FROM workspace_meter_event_outbox o
JOIN usage_sessions us ON o."usageSessionId" = us.id
WHERE o.status = 'SENT'
ORDER BY o."sentAt" DESC;

-- 5. Failed meter events (dead-lettered, need operator attention)
SELECT
  o.id AS outbox_id,
  o."usageSessionId",
  o."userId",
  o."valueSeconds",
  o."attemptCount",
  o."lastErrorCode",
  o."lastErrorMessage",
  o."createdAt",
  o."updatedAt"
FROM workspace_meter_event_outbox o
WHERE o.status = 'FAILED'
ORDER BY o."updatedAt" DESC;

-- 6. Orphan sessions: RUNNING session on a TERMINATED/FAILED workspace (should be zero)
SELECT
  us.id AS session_id,
  us."workspaceId",
  us."userId",
  us."startTime",
  w.status AS workspace_status,
  w."terminatedAt"
FROM usage_sessions us
JOIN workspaces w ON us."workspaceId" = w.id
WHERE us.status = 'RUNNING'
  AND w.status IN ('TERMINATED', 'FAILED')
ORDER BY us."startTime" ASC;

-- 7. Duplicate outbox entries per session (should be zero — unique constraint enforces)
SELECT
  "usageSessionId",
  COUNT(*) AS outbox_count
FROM workspace_meter_event_outbox
GROUP BY "usageSessionId"
HAVING COUNT(*) > 1;

-- 8. Summary dashboard
SELECT
  'active_sessions' AS metric, COUNT(*)::text AS value
  FROM usage_sessions WHERE status = 'RUNNING'
UNION ALL
SELECT
  'ended_no_outbox', COUNT(*)::text
  FROM usage_sessions us
  LEFT JOIN workspace_meter_event_outbox o ON o."usageSessionId" = us.id
  WHERE us.status = 'ENDED' AND o.id IS NULL
UNION ALL
SELECT
  'outbox_pending', COUNT(*)::text
  FROM workspace_meter_event_outbox WHERE status = 'PENDING'
UNION ALL
SELECT
  'outbox_retry', COUNT(*)::text
  FROM workspace_meter_event_outbox WHERE status = 'RETRY'
UNION ALL
SELECT
  'outbox_sent', COUNT(*)::text
  FROM workspace_meter_event_outbox WHERE status = 'SENT'
UNION ALL
SELECT
  'outbox_failed', COUNT(*)::text
  FROM workspace_meter_event_outbox WHERE status = 'FAILED'
UNION ALL
SELECT
  'orphan_running_on_terminal', COUNT(*)::text
  FROM usage_sessions us
  JOIN workspaces w ON us."workspaceId" = w.id
  WHERE us.status = 'RUNNING' AND w.status IN ('TERMINATED', 'FAILED');
