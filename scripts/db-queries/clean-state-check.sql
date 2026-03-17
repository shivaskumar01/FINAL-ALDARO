-- Clean state verification — run before and after proof execution.
-- All counts should be 0 for a clean environment.

\echo '=== Clean State Check ==='

\echo '1. Non-terminal workspaces'
SELECT status, COUNT(*) FROM workspaces WHERE status NOT IN ('TERMINATED', 'FAILED') GROUP BY status;

\echo '2. Non-free GPUs'
SELECT status, COUNT(*) FROM fleet_gpus WHERE status != 'FREE' GROUP BY status;

\echo '3. Unreleased endpoints'
SELECT COUNT(*) AS unreleased_endpoints FROM workspace_endpoints WHERE "releasedAt" IS NULL;

\echo '4. RUNNING usage sessions'
SELECT COUNT(*) AS running_sessions FROM usage_sessions WHERE status = 'RUNNING';

\echo '5. Pending cleanup jobs'
SELECT status, COUNT(*) FROM workspace_cleanup_jobs WHERE status NOT IN ('DONE', 'FAILED') GROUP BY status;

\echo '6. Stale CREATING (>15 min)'
SELECT COUNT(*) AS stale_creating FROM workspaces WHERE status = 'CREATING' AND "updatedAt" < NOW() - INTERVAL '15 minutes';

\echo '7. Stale TERMINATING (>10 min)'
SELECT COUNT(*) AS stale_terminating FROM workspaces WHERE status = 'TERMINATING' AND "updatedAt" < NOW() - INTERVAL '10 minutes';

\echo '8. ENDED sessions without outbox'
SELECT COUNT(*) AS billing_leak FROM usage_sessions s LEFT JOIN workspace_meter_event_outbox o ON o."usageSessionId" = s.id WHERE s.status = 'ENDED' AND o.id IS NULL;

\echo '9. GPU allocated to terminal workspace'
SELECT COUNT(*) AS stuck_gpus FROM fleet_gpus g JOIN workspaces w ON w.id = g."currentWorkspaceId" WHERE g.status = 'ALLOCATED' AND w.status IN ('TERMINATED', 'FAILED');

\echo '=== End Clean State Check ==='
