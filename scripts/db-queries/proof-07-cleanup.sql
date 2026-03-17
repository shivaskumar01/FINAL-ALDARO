-- Proof 07: Cleanup Durability — DB query pack
-- Run with: psql "$DATABASE_URL" -f scripts/db-queries/proof-07-cleanup.sql

\echo '=== Stale CREATING (>15 min) ==='
SELECT id, status, "updatedAt", "proxmoxNode", "proxmoxVmid"
FROM workspaces
WHERE status = 'CREATING' AND "updatedAt" < NOW() - INTERVAL '15 minutes';

\echo '=== Stale TERMINATING (>10 min) ==='
SELECT w.id, w.status, w."updatedAt",
  (SELECT COUNT(*) FROM workspace_cleanup_jobs j WHERE j."workspaceId" = w.id AND j.status NOT IN ('DONE', 'FAILED')) AS active_jobs
FROM workspaces w
WHERE w.status = 'TERMINATING' AND w."updatedAt" < NOW() - INTERVAL '10 minutes';

\echo '=== RUNNING_ASSIGNED without RUNNING session ==='
SELECT w.id, w."assignedUserId"
FROM workspaces w
LEFT JOIN usage_sessions s ON s."workspaceId" = w.id AND s.status = 'RUNNING'
WHERE w.status = 'RUNNING_ASSIGNED' AND s.id IS NULL;

\echo '=== ENDED sessions without outbox (billing leak) ==='
SELECT s.id, s."workspaceId", s."billedCents"
FROM usage_sessions s
LEFT JOIN workspace_meter_event_outbox o ON o."usageSessionId" = s.id
WHERE s.status = 'ENDED' AND o.id IS NULL;

\echo '=== GPU stuck ALLOCATED with terminal workspace ==='
SELECT g.id, g.status, g."currentWorkspaceId", w.status AS ws_status
FROM fleet_gpus g
JOIN workspaces w ON w.id = g."currentWorkspaceId"
WHERE g.status = 'ALLOCATED' AND w.status IN ('TERMINATED', 'FAILED');

\echo '=== Orphan endpoints (active for terminal workspace) ==='
SELECT e.id, e."workspaceId", e."sshPort", e."jupyterPort"
FROM workspace_endpoints e
LEFT JOIN workspaces w ON w.id = e."workspaceId"
WHERE e."releasedAt" IS NULL AND (w.id IS NULL OR w.status IN ('TERMINATED', 'FAILED'));

\echo '=== Dead-letter cleanup jobs ==='
SELECT j.id, j."workspaceId", j."attemptCount", j."lastErrorCode", j."lastErrorMessage"
FROM workspace_cleanup_jobs j
WHERE j.status = 'FAILED';

\echo '=== Cleanup job backlog ==='
SELECT status, COUNT(*), AVG("attemptCount")::int AS avg_attempts
FROM workspace_cleanup_jobs
GROUP BY status;
