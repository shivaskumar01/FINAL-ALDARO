# Proof 07: Cleanup Durability

**Proves that the worker's cleanup and reconciliation systems automatically resolve stale state without manual intervention: stuck workspaces, leaked GPUs, orphan ports, billing leaks, and stale CREATING/TERMINATING records.**

---

## Objective

Inject 5 stale-state scenarios into the database. Do NOT manually clean anything. Wait for the worker to resolve all of them automatically. Verify every resource is properly freed, every session is closed, and billing is correct.

---

## Preconditions

| # | Requirement | How to verify |
|---|---|---|
| 1 | Proof 01 passed | Staging readiness green |
| 2 | Clean starting state | All verification queries return 0 stale rows |
| 3 | Worker running with leader lock | Worker log shows tick activity |
| 4 | Gateway running | Health check returns OK |

---

## Stale-State Seed Data

These map to `docs/cleanup-durability-matrix.md` scenarios 1-6.

```sql
-- Run against staging database.
-- Uses a dedicated test user to avoid FK issues.

-- 0. Create test user (if not exists)
INSERT INTO users (id, email, role, "passwordHash", "fullName", "maxActiveWorkspaces")
VALUES (gen_random_uuid(), 'cleanup-proof-user@aldaro.ai', 'CUSTOMER', 'not-a-real-hash', 'Cleanup Proof User', 3)
ON CONFLICT (email) DO NOTHING;

-- Get the test user ID
-- \set CLEANUP_USER_ID (SELECT id FROM users WHERE email = 'cleanup-proof-user@aldaro.ai')
```

---

## Commands

```bash
DATE=$(date +%Y-%m-%d)
DIR="exports/proofs/$DATE/07-cleanup-durability"
mkdir -p "$DIR"

CLEANUP_USER_ID=$(psql "$DATABASE_URL" -t -c "SELECT id FROM users WHERE email = 'cleanup-proof-user@aldaro.ai';" | tr -d ' ')
echo "CLEANUP_USER_ID=$CLEANUP_USER_ID" | tee "$DIR/test-user.txt"

# === PRE-STATE: Verify clean ===

psql "$DATABASE_URL" <<'SQL' | tee "$DIR/pre-clean-state.txt"
-- Stale CREATING
SELECT COUNT(*) AS stale_creating FROM workspaces WHERE status = 'CREATING' AND "updatedAt" < NOW() - INTERVAL '15 minutes';
-- Stale TERMINATING
SELECT COUNT(*) AS stale_terminating FROM workspaces WHERE status = 'TERMINATING' AND "updatedAt" < NOW() - INTERVAL '10 minutes';
-- RUNNING sessions on terminal workspaces
SELECT COUNT(*) AS orphan_sessions FROM usage_sessions s JOIN workspaces w ON s."workspaceId" = w.id WHERE s.status = 'RUNNING' AND w.status IN ('TERMINATED', 'FAILED');
-- Orphan endpoints
SELECT COUNT(*) AS orphan_endpoints FROM workspace_endpoints e LEFT JOIN workspaces w ON e."workspaceId" = w.id WHERE e."releasedAt" IS NULL AND (w.id IS NULL OR w.status IN ('TERMINATED', 'FAILED'));
-- ENDED sessions without outbox
SELECT COUNT(*) AS billing_leak FROM usage_sessions s LEFT JOIN workspace_meter_event_outbox o ON o."usageSessionId" = s.id WHERE s.status = 'ENDED' AND o.id IS NULL;
SQL

# === INJECT STALE STATE ===

echo "INJECTION_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)" | tee "$DIR/timeline.txt"

# Scenario 1: Stale CREATING workspace (20 min old)
psql "$DATABASE_URL" -c "
INSERT INTO workspaces (id, status, \"gpuType\", region, \"isWarmPool\", \"createdAt\", \"updatedAt\")
VALUES ('cleanup-proof-creating-001', 'CREATING', 'RTX_5090', 'US', false, NOW() - INTERVAL '20 minutes', NOW() - INTERVAL '20 minutes');
"

# Scenario 2: Stale TERMINATING workspace (15 min old, no cleanup job)
psql "$DATABASE_URL" -c "
INSERT INTO workspaces (id, status, \"gpuType\", region, \"isWarmPool\", \"createdAt\", \"updatedAt\", \"proxmoxNode\", \"proxmoxVmid\")
VALUES ('cleanup-proof-terminating-001', 'TERMINATING', 'RTX_5090', 'US', false, NOW() - INTERVAL '30 minutes', NOW() - INTERVAL '15 minutes', 'pve-node-01', 9999);
"

# Scenario 3: TERMINATING workspace with RUNNING usage session (billing leak test)
psql "$DATABASE_URL" -c "
INSERT INTO workspaces (id, status, \"gpuType\", region, \"isWarmPool\", \"assignedUserId\", \"createdAt\", \"updatedAt\")
VALUES ('cleanup-proof-billing-001', 'TERMINATING', 'RTX_5090', 'US', false, '$CLEANUP_USER_ID', NOW() - INTERVAL '3 hours', NOW() - INTERVAL '5 minutes');
"
psql "$DATABASE_URL" -c "
INSERT INTO usage_sessions (id, \"userId\", \"workspaceId\", \"gpuType\", \"startTime\", status, \"pricePerHourCents\")
VALUES (gen_random_uuid(), '$CLEANUP_USER_ID', 'cleanup-proof-billing-001', 'RTX_5090', NOW() - INTERVAL '2 hours', 'RUNNING', 150);
"
psql "$DATABASE_URL" -c "
INSERT INTO workspace_cleanup_jobs (id, \"workspaceId\", \"reasonCode\", status, \"nextAttemptAt\")
VALUES (gen_random_uuid(), 'cleanup-proof-billing-001', 'test_billing', 'PENDING', NOW());
"

# Scenario 4: TERMINATED workspace with orphan endpoint (port leak)
psql "$DATABASE_URL" -c "
INSERT INTO workspaces (id, status, \"gpuType\", region, \"isWarmPool\", \"terminatedAt\", \"createdAt\", \"updatedAt\")
VALUES ('cleanup-proof-orphan-001', 'TERMINATED', 'RTX_5090', 'US', false, NOW() - INTERVAL '60 minutes', NOW() - INTERVAL '90 minutes', NOW() - INTERVAL '60 minutes');
"
psql "$DATABASE_URL" -c "
INSERT INTO workspace_endpoints (id, \"workspaceId\", \"gatewayHost\", \"sshPort\", \"jupyterPort\", \"vscodePort\", \"allocatedAt\")
VALUES (gen_random_uuid(), 'cleanup-proof-orphan-001', 'localhost', 29001, 29002, 29003, NOW() - INTERVAL '90 minutes');
"

# Scenario 5: GPU stuck ALLOCATED pointing to TERMINATED workspace
# (Only inject if there's a spare free GPU to temporarily lock)
SPARE_GPU_ID=$(psql "$DATABASE_URL" -t -c "SELECT id FROM fleet_gpus WHERE status = 'FREE' AND \"gpuType\" = 'RTX_5090' LIMIT 1;" | tr -d ' ')
if [ -n "$SPARE_GPU_ID" ]; then
  psql "$DATABASE_URL" -c "UPDATE fleet_gpus SET status = 'ALLOCATED', \"currentWorkspaceId\" = 'cleanup-proof-orphan-001' WHERE id = '$SPARE_GPU_ID';"
  echo "STUCK_GPU_ID=$SPARE_GPU_ID" >> "$DIR/timeline.txt"
fi

# Record injected state
psql "$DATABASE_URL" -c "SELECT id, status, \"updatedAt\" FROM workspaces WHERE id LIKE 'cleanup-proof-%' ORDER BY id;" | tee "$DIR/injected-workspaces.txt"
psql "$DATABASE_URL" -c "SELECT id, \"workspaceId\", status FROM usage_sessions WHERE \"workspaceId\" LIKE 'cleanup-proof-%';" | tee "$DIR/injected-sessions.txt"
psql "$DATABASE_URL" -c "SELECT id, \"workspaceId\", \"releasedAt\" FROM workspace_endpoints WHERE \"workspaceId\" LIKE 'cleanup-proof-%';" | tee "$DIR/injected-endpoints.txt"
psql "$DATABASE_URL" -c "SELECT id, status, \"currentWorkspaceId\" FROM fleet_gpus WHERE \"currentWorkspaceId\" LIKE 'cleanup-proof-%';" | tee "$DIR/injected-gpus.txt"

# === WAIT FOR WORKER RESOLUTION ===

echo "Waiting for worker cleanup ticks (5 minutes max)..."
echo "WAIT_START=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$DIR/timeline.txt"

for i in $(seq 1 30); do
  REMAINING=$(psql "$DATABASE_URL" -t -c "
    SELECT COUNT(*) FROM workspaces
    WHERE id LIKE 'cleanup-proof-%'
      AND status NOT IN ('TERMINATED', 'FAILED');
  " | tr -d ' ')
  echo "$(date -u +%H:%M:%S) non-terminal remaining: $REMAINING"
  if [ "$REMAINING" = "0" ]; then
    echo "All cleanup-proof workspaces are terminal."
    break
  fi
  sleep 10
done

echo "RESOLUTION_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$DIR/timeline.txt"

# === POST-CLEANUP EVIDENCE ===

# Final workspace states
psql "$DATABASE_URL" -c "SELECT id, status, \"terminatedAt\", \"lastErrorCode\" FROM workspaces WHERE id LIKE 'cleanup-proof-%' ORDER BY id;" | tee "$DIR/final-workspaces.txt"

# Final session states
psql "$DATABASE_URL" -c "SELECT id, \"workspaceId\", status, \"endTime\", \"totalSeconds\", \"billedCents\" FROM usage_sessions WHERE \"workspaceId\" LIKE 'cleanup-proof-%';" | tee "$DIR/final-sessions.txt"

# Final outbox states (for the billing scenario)
psql "$DATABASE_URL" -c "SELECT o.id, o.\"usageSessionId\", o.\"valueSeconds\", o.status FROM workspace_meter_event_outbox o JOIN usage_sessions s ON o.\"usageSessionId\" = s.id WHERE s.\"workspaceId\" LIKE 'cleanup-proof-%';" | tee "$DIR/final-outbox.txt"

# Final endpoint states
psql "$DATABASE_URL" -c "SELECT id, \"workspaceId\", \"releasedAt\" FROM workspace_endpoints WHERE \"workspaceId\" LIKE 'cleanup-proof-%';" | tee "$DIR/final-endpoints.txt"

# Final GPU states
psql "$DATABASE_URL" -c "SELECT id, status, \"currentWorkspaceId\" FROM fleet_gpus WHERE \"currentWorkspaceId\" LIKE 'cleanup-proof-%';" | tee "$DIR/final-gpus.txt"

# Cleanup job records
psql "$DATABASE_URL" -c "SELECT id, \"workspaceId\", status, \"attemptCount\", \"completedAt\" FROM workspace_cleanup_jobs WHERE \"workspaceId\" LIKE 'cleanup-proof-%' ORDER BY \"workspaceId\";" | tee "$DIR/final-cleanup-jobs.txt"

# Full stale-state recheck
psql "$DATABASE_URL" <<'SQL' | tee "$DIR/post-clean-state.txt"
SELECT COUNT(*) AS stale_creating FROM workspaces WHERE status = 'CREATING' AND "updatedAt" < NOW() - INTERVAL '15 minutes';
SELECT COUNT(*) AS stale_terminating FROM workspaces WHERE status = 'TERMINATING' AND "updatedAt" < NOW() - INTERVAL '10 minutes';
SELECT COUNT(*) AS orphan_sessions FROM usage_sessions s JOIN workspaces w ON s."workspaceId" = w.id WHERE s.status = 'RUNNING' AND w.status IN ('TERMINATED', 'FAILED');
SELECT COUNT(*) AS orphan_endpoints FROM workspace_endpoints e LEFT JOIN workspaces w ON e."workspaceId" = w.id WHERE e."releasedAt" IS NULL AND (w.id IS NULL OR w.status IN ('TERMINATED', 'FAILED'));
SELECT COUNT(*) AS billing_leak FROM usage_sessions s LEFT JOIN workspace_meter_event_outbox o ON o."usageSessionId" = s.id WHERE s.status = 'ENDED' AND o.id IS NULL;
SQL

# Billing math check for scenario 3
psql "$DATABASE_URL" -c "
SELECT id, \"totalSeconds\", \"billedCents\", \"pricePerHourCents\",
  CEIL(\"totalSeconds\" * \"pricePerHourCents\" / 3600.0) AS expected_billed_cents,
  CASE WHEN \"billedCents\" = CEIL(\"totalSeconds\" * \"pricePerHourCents\" / 3600.0) THEN 'MATCH' ELSE 'MISMATCH' END AS billing_check
FROM usage_sessions WHERE \"workspaceId\" = 'cleanup-proof-billing-001';
" | tee "$DIR/billing-math-check.txt"
```

---

## Pass/Fail Rules

| # | Scenario | PASS | FAIL |
|---|---|---|---|
| 1 | Stale CREATING (20 min) | Workspace reaches TERMINATING → TERMINATED/FAILED | Still CREATING after 5 min |
| 2 | Stale TERMINATING (no job) | Cleanup job created, workspace reaches TERMINATED | No cleanup job, still TERMINATING |
| 3 | TERMINATING + RUNNING session | Session status=ENDED, billedCents correct, outbox exists | Session still RUNNING or missing outbox |
| 4 | Orphan endpoint | `releasedAt` is set | Still NULL |
| 5 | Stuck GPU | GPU status=FREE, `currentWorkspaceId`=NULL | Still ALLOCATED |
| 6 | Zero stale-state queries | All post-cleanup counts = 0 | Any non-zero |
| 7 | No manual intervention | All resolved by worker tick | Required manual SQL |
| 8 | Resolution time | All scenarios resolved within 5 minutes | >5 min |

**Overall**: ALL checks must pass.

---

## False-Pass Warnings

| Scenario | Why it looks like a pass but isn't |
|---|---|
| Workspace FAILED instead of TERMINATED | FAILED is terminal so counts as "resolved" — but if the failure is a bug, investigate before counting it as pass |
| Session ENDED but billedCents=0 | Math works with $0 pricing — verify `pricePerHourCents` was 150 as injected |
| Outbox exists but status=FAILED | Outbox created but Stripe emission failed — acceptable for local/staging-without-Stripe but note it |
| GPU freed but by manual seed reset | If worker restart or schema migration freed the GPU, not the sweeper — check worker logs for explicit sweep action |
| Worker didn't actually process | Worker might have been down during test — verify worker logs show tick activity during the wait period |
| Endpoint released by gateway restart reconciliation | Gateway restart triggers `reconcileLeases()` which cleans stale endpoints — this is a valid cleanup path but different from worker periodic sweep |

---

## Cleanup Durability Gaps Being Tested

From `docs/cleanup-durability-matrix.md`:

| Gap | How this proof exercises it |
|---|---|
| G1: Missing session on RUNNING_ASSIGNED | Not directly — would need a different injection |
| G2: Historical ENDED without outbox | Scenario 3 tests forward path; G2 is historical backfill |
| G3: No periodic endpoint sweep | Scenario 4 tests endpoint cleanup via gateway reconcile or worker |
| G5: GPU release not guarded against missing GPU | Scenario 5 tests stuck GPU release |
| G6: Terminate + cleanup not atomic | Scenario 2 tests missing cleanup job for TERMINATING workspace |

---

## Evidence Artifacts

All saved to `exports/proofs/<date>/07-cleanup-durability/`:

| File | Contents |
|---|---|
| `test-user.txt` | Test user ID |
| `pre-clean-state.txt` | Stale-state counts before injection (should be 0) |
| `timeline.txt` | Injection time, wait start/end, resolution time |
| `injected-*.txt` | State of each injected entity |
| `final-workspaces.txt` | Workspace states after cleanup |
| `final-sessions.txt` | Session states after cleanup |
| `final-outbox.txt` | Outbox records |
| `final-endpoints.txt` | Endpoint release status |
| `final-gpus.txt` | GPU allocation status |
| `final-cleanup-jobs.txt` | Cleanup job records |
| `post-clean-state.txt` | Stale-state counts after cleanup (should be 0) |
| `billing-math-check.txt` | Billing calculation verification |

---

## Rollback/Cleanup

```bash
# Remove all test data
psql "$DATABASE_URL" <<'SQL'
DELETE FROM workspace_meter_event_outbox WHERE "usageSessionId" IN (SELECT id FROM usage_sessions WHERE "workspaceId" LIKE 'cleanup-proof-%');
DELETE FROM usage_sessions WHERE "workspaceId" LIKE 'cleanup-proof-%';
DELETE FROM workspace_endpoints WHERE "workspaceId" LIKE 'cleanup-proof-%';
DELETE FROM workspace_cleanup_jobs WHERE "workspaceId" LIKE 'cleanup-proof-%';
DELETE FROM workspace_gpu_allocations WHERE "workspaceId" LIKE 'cleanup-proof-%';
UPDATE fleet_gpus SET status = 'FREE', "currentWorkspaceId" = NULL WHERE "currentWorkspaceId" LIKE 'cleanup-proof-%';
DELETE FROM workspaces WHERE id LIKE 'cleanup-proof-%';
SQL

# Verify clean
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM workspaces WHERE id LIKE 'cleanup-proof-%';"
```

---

## Launch Impact if Failed

**Critical.** Without automatic cleanup, failed provisions and stuck terminates accumulate until GPUs are exhausted. This is an operational availability issue.
