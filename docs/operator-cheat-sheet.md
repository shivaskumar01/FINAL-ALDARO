# Operator Cheat Sheet

Quick reference for running the Aldaro proof pack and diagnosing issues.

---

## One-Command Sequences

```bash
# Validate environment
scripts/validate-env.sh

# Full preflight (env + services + fleet + clean state)
scripts/preflight-live-proof.sh

# Run a single proof
scripts/run-proof.sh 02

# Run all proofs in order
scripts/run-proof.sh all

# Package evidence for review
scripts/package-proof-evidence.sh

# Check clean state
psql "$DATABASE_URL" -f scripts/db-queries/clean-state-check.sql

# Check billing invariants
psql "$DATABASE_URL" -f scripts/billing-state-inspection.sql

# Check cleanup durability
psql "$DATABASE_URL" -f scripts/db-queries/proof-07-cleanup.sql
```

---

## Common Diagnostic Queries

```sql
-- What's running right now?
SELECT id, status, "gpuType", "assignedUserId", "updatedAt"
FROM workspaces WHERE status NOT IN ('TERMINATED', 'FAILED');

-- Any stuck GPUs?
SELECT g.id, g.status, g."currentWorkspaceId", w.status AS ws_status
FROM fleet_gpus g
LEFT JOIN workspaces w ON g."currentWorkspaceId" = w.id
WHERE g.status != 'FREE';

-- Billing backlog?
SELECT status, COUNT(*), MIN("createdAt") AS oldest
FROM workspace_meter_event_outbox
WHERE status IN ('PENDING', 'RETRY')
GROUP BY status;

-- Cleanup job backlog?
SELECT status, COUNT(*), AVG("attemptCount")::int
FROM workspace_cleanup_jobs
GROUP BY status;

-- Recent incidents?
SELECT id, type, severity, status, message, "createdAt"
FROM incidents ORDER BY "createdAt" DESC LIMIT 10;
```

---

## Emergency Procedures

### Force-terminate a stuck workspace
```sql
-- 1. Close any RUNNING sessions
UPDATE usage_sessions SET status = 'ENDED', "endTime" = NOW(),
  "totalSeconds" = CEIL(EXTRACT(EPOCH FROM NOW() - "startTime")),
  "billedCents" = CEIL(CEIL(EXTRACT(EPOCH FROM NOW() - "startTime")) * "pricePerHourCents" / 3600)
WHERE "workspaceId" = 'WS_ID' AND status = 'RUNNING';

-- 2. Release GPU
UPDATE fleet_gpus SET status = 'FREE', "currentWorkspaceId" = NULL
WHERE "currentWorkspaceId" = 'WS_ID';

-- 3. Release endpoint
UPDATE workspace_endpoints SET "releasedAt" = NOW()
WHERE "workspaceId" = 'WS_ID' AND "releasedAt" IS NULL;

-- 4. Set terminal status
UPDATE workspaces SET status = 'TERMINATED', "terminatedAt" = NOW()
WHERE id = 'WS_ID';
```

### Free all stuck GPUs
```sql
UPDATE fleet_gpus SET status = 'FREE', "currentWorkspaceId" = NULL
WHERE status = 'ALLOCATED'
  AND "currentWorkspaceId" IN (
    SELECT id FROM workspaces WHERE status IN ('TERMINATED', 'FAILED')
  );
```

### Reset all stale state (nuclear option)
```sql
-- Only use if staging is in an unrecoverable state
UPDATE workspaces SET status = 'FAILED', "failedAt" = NOW()
WHERE status NOT IN ('TERMINATED', 'FAILED', 'WARM_AVAILABLE');

UPDATE fleet_gpus SET status = 'FREE', "currentWorkspaceId" = NULL
WHERE status != 'FREE';

UPDATE workspace_endpoints SET "releasedAt" = NOW()
WHERE "releasedAt" IS NULL;

UPDATE usage_sessions SET status = 'ENDED', "endTime" = NOW()
WHERE status = 'RUNNING';
```

---

## Proof Execution Order

1. **01, Staging Readiness** (gate)
2. **02, Billing Parity**
3. **03, Terminate Outage Recovery**
4. **04, Last-GPU Contention**
5. **07, Cleanup Durability**
6. **06, Stack Leakage**
7. **05, Restore Drill** (last, stops services)

---

## Key Files

| What | Where |
|---|---|
| Launch readiness index | `docs/launch-readiness-index.md` |
| Current blockers | `docs/current-launch-blockers.md` |
| Go/no-go table | `docs/go-no-go-evidence-table.md` |
| Proof sheets | `docs/proofs/01-07*.md` |
| Proof runner | `scripts/run-proof.sh` |
| Evidence capture | `scripts/capture-proof-evidence.sh` |
| Env validator | `scripts/validate-env.sh` |
| Preflight | `scripts/preflight-live-proof.sh` |
| Billing queries | `scripts/billing-state-inspection.sql` |
| Cleanup queries | `scripts/db-queries/proof-07-cleanup.sql` |
| Clean state check | `scripts/db-queries/clean-state-check.sql` |
