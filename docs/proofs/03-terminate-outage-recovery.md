# Proof 03: Terminate Outage Recovery

**Proves the system recovers gracefully when the gateway is down during terminate: safe client response, automatic cleanup retry, correct billing after recovery.**

---

## Objective

When a user terminates a workspace while the gateway is unreachable:
1. Client gets a safe 202 response (no stack trace, no internal detail)
2. Workspace transitions to TERMINATING
3. Cleanup job retries with exponential backoff
4. After gateway restart, cleanup completes automatically
5. Usage session closes with correct billing
6. All resources freed (GPU, ports, VM)

---

## Preconditions

| # | Requirement | How to verify |
|---|---|---|
| 1 | Proof 01 passed | Staging readiness green |
| 2 | One workspace in RUNNING_ASSIGNED | Launch a workspace via Proof 02 flow, stop before terminate |
| 3 | Active usage session for that workspace | `psql -c "SELECT id, status FROM usage_sessions WHERE \"workspaceId\" = 'WS_ID' AND status = 'RUNNING';"` |
| 4 | Gateway process accessible for controlled kill | `lsof -i :5001` shows gateway PID |
| 5 | Worker running with cleanup tick active | Worker log shows tick activity |

---

## Commands

```bash
DATE=$(date +%Y-%m-%d)
DIR="exports/proofs/$DATE/03-terminate-outage-recovery"
mkdir -p "$DIR"

# === SETUP: Confirm running workspace ===

WORKSPACE_ID="<from proof 02 or manual launch>"

# 1. Confirm RUNNING_ASSIGNED
psql "$DATABASE_URL" -c "SELECT id, status FROM workspaces WHERE id = '$WORKSPACE_ID';" | tee "$DIR/pre-state-workspace.txt"

# 2. Confirm active usage session
psql "$DATABASE_URL" -c "SELECT id, status, \"startTime\", \"pricePerHourCents\" FROM usage_sessions WHERE \"workspaceId\" = '$WORKSPACE_ID' AND status = 'RUNNING';" | tee "$DIR/pre-state-session.txt"

# 3. Capture pre-state GPU
psql "$DATABASE_URL" -c "SELECT id, status, \"currentWorkspaceId\" FROM fleet_gpus WHERE \"currentWorkspaceId\" = '$WORKSPACE_ID';" | tee "$DIR/pre-state-gpu.txt"

# === INJECT FAILURE: Kill gateway ===

# 4. Record gateway down time
GATEWAY_DOWN=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "GATEWAY_DOWN=$GATEWAY_DOWN" | tee "$DIR/timeline.txt"

# 5. Kill gateway
kill $(lsof -ti :5001)
echo "Gateway killed at $GATEWAY_DOWN"

# 6. Verify gateway is dead
sleep 2
curl -s http://localhost:5001/health && echo "FAIL: gateway still alive" || echo "OK: gateway is down"

# === TERMINATE REQUEST (gateway down) ===

# 7. Send terminate
curl -s -X POST http://localhost:4000/workspaces/$WORKSPACE_ID/terminate \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF_TOKEN" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt \
  -v 2>&1 | tee "$DIR/terminate-response.txt"

# 8. Verify response is safe (no stack traces)
echo "=== LEAK SCAN ===" | tee "$DIR/terminate-leak-scan.txt"
grep -nE "at |node_modules|\.ts:|\.js:|prisma|Prisma|proxmox|10\.[0-9]+\.|192\.168\.|/Users/|/home/|postgresql://" "$DIR/terminate-response.txt" >> "$DIR/terminate-leak-scan.txt" || echo "CLEAN" >> "$DIR/terminate-leak-scan.txt"

# 9. Verify workspace is TERMINATING
psql "$DATABASE_URL" -c "SELECT id, status, \"terminationReason\" FROM workspaces WHERE id = '$WORKSPACE_ID';" | tee "$DIR/post-terminate-workspace.txt"

# 10. Verify cleanup job was created
psql "$DATABASE_URL" -c "SELECT id, status, \"attemptCount\", \"reasonCode\", \"nextAttemptAt\" FROM workspace_cleanup_jobs WHERE \"workspaceId\" = '$WORKSPACE_ID';" | tee "$DIR/cleanup-job-created.txt"

# === OBSERVE RETRY BEHAVIOR (gateway still down) ===

# 11. Wait for 2-3 retry cycles
echo "Waiting 120s for retry cycles..."
sleep 120

# 12. Check cleanup job retries
psql "$DATABASE_URL" -c "SELECT status, \"attemptCount\", \"lastErrorCode\", \"lastErrorMessage\", \"nextAttemptAt\" FROM workspace_cleanup_jobs WHERE \"workspaceId\" = '$WORKSPACE_ID';" | tee "$DIR/cleanup-job-retrying.txt"

# Verify: attemptCount > 0, status still PENDING or RETRY, lastErrorCode is not empty

# 13. Capture worker logs during outage
# (depends on how worker logs — adjust path)
grep -A5 "cleanup.*$WORKSPACE_ID\|$WORKSPACE_ID.*cleanup\|$WORKSPACE_ID.*error\|$WORKSPACE_ID.*retry" /tmp/worker.log | tail -50 > "$DIR/worker-logs-during-outage.txt"

# === RECOVERY: Restart gateway ===

# 14. Record gateway restart time
GATEWAY_UP=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "GATEWAY_UP=$GATEWAY_UP" >> "$DIR/timeline.txt"

# 15. Restart gateway
cd apps/gateway && GATEWAY_PORT=5001 npx tsx src/index.ts &
sleep 3

# 16. Verify gateway is healthy
curl -s http://localhost:5001/health | tee "$DIR/gateway-recovered.json"

# === WAIT FOR CLEANUP COMPLETION ===

# 17. Wait for cleanup to complete (max 120s)
echo "Waiting for cleanup completion..."
for i in $(seq 1 12); do
  JOB_STATUS=$(psql "$DATABASE_URL" -t -c "SELECT status FROM workspace_cleanup_jobs WHERE \"workspaceId\" = '$WORKSPACE_ID';" | tr -d ' ')
  WS_STATUS=$(psql "$DATABASE_URL" -t -c "SELECT status FROM workspaces WHERE id = '$WORKSPACE_ID';" | tr -d ' ')
  echo "$(date -u +%H:%M:%S) job=$JOB_STATUS workspace=$WS_STATUS"
  if [ "$WS_STATUS" = "TERMINATED" ]; then break; fi
  sleep 10
done

# === FINAL STATE CAPTURE ===

# 18. Workspace final state
psql "$DATABASE_URL" -c "SELECT id, status, \"terminatedAt\", \"terminationReason\" FROM workspaces WHERE id = '$WORKSPACE_ID';" | tee "$DIR/final-workspace.txt"

# 19. Usage session final state
psql "$DATABASE_URL" -c "SELECT id, status, \"startTime\", \"endTime\", \"totalSeconds\", \"billedCents\", \"pricePerHourCents\" FROM usage_sessions WHERE \"workspaceId\" = '$WORKSPACE_ID';" | tee "$DIR/final-session.txt"

# 20. GPU state
psql "$DATABASE_URL" -c "SELECT id, status, \"currentWorkspaceId\" FROM fleet_gpus WHERE \"currentWorkspaceId\" = '$WORKSPACE_ID' OR (status = 'ALLOCATED');" | tee "$DIR/final-gpu.txt"

# 21. Endpoint state
psql "$DATABASE_URL" -c "SELECT id, \"workspaceId\", \"releasedAt\" FROM workspace_endpoints WHERE \"workspaceId\" = '$WORKSPACE_ID';" | tee "$DIR/final-endpoint.txt"

# 22. Cleanup job final state
psql "$DATABASE_URL" -c "SELECT id, status, \"attemptCount\", \"lastErrorCode\", \"completedAt\" FROM workspace_cleanup_jobs WHERE \"workspaceId\" = '$WORKSPACE_ID';" | tee "$DIR/final-cleanup-job.txt"

# 23. Outbox state
psql "$DATABASE_URL" -c "SELECT o.id, o.status, o.\"valueSeconds\", o.\"stripeMeterEventId\" FROM workspace_meter_event_outbox o JOIN usage_sessions s ON o.\"usageSessionId\" = s.id WHERE s.\"workspaceId\" = '$WORKSPACE_ID';" | tee "$DIR/final-outbox.txt"
```

---

## Pass/Fail Rules

| # | Check | PASS | FAIL |
|---|---|---|---|
| 1 | Terminate response | HTTP 202 with `{"ok":true,"status":"TERMINATING","queued":true}` | Any other status code or body shape |
| 2 | No stack leakage | Leak scan returns CLEAN | Any match on stack trace patterns |
| 3 | Cleanup job created | Row exists with status=PENDING and reasonCode=manual_terminate | Missing |
| 4 | Retry behavior | `attemptCount` > 0 after gateway outage, `lastErrorCode` non-empty | `attemptCount` stays 0 or worker crashes |
| 5 | Recovery | Workspace reaches TERMINATED after gateway restart | Stuck in TERMINATING |
| 6 | Session closed | Usage session status=ENDED, `billedCents` > 0, math correct | RUNNING or missing |
| 7 | GPU freed | No ALLOCATED GPUs pointing to this workspace | GPU still locked |
| 8 | Endpoint released | `releasedAt` is set | Still NULL |
| 9 | Outbox exists | Status=SENT or PENDING, `valueSeconds` matches session | Missing |

**Overall**: ALL checks must pass.

---

## False-Pass Warnings

| Scenario | Why it looks like a pass but isn't |
|---|---|
| Cleanup completes before gateway restart | API-side `endUsageSession` closed the session + released gateway ports via a different code path — you're not testing the cleanup-job recovery path |
| Session was already ENDED before terminate | Worker's idle-termination or another path closed it — verify session was RUNNING at step 2 |
| `attemptCount` = 0 at step 12 | Cleanup tick interval may be longer than your wait — increase wait time or check worker tick frequency |
| Gateway wasn't actually down | Port 5001 was held open by another process — verify with curl that health fails at step 6 |

---

## Code Paths Being Exercised

| Path | File | Key behavior |
|---|---|---|
| API terminate handler | `workspaceService.ts:343-397` | `$transaction` sets TERMINATING + upserts cleanup job atomically |
| Cleanup job retry | `worker/src/jobs/workspace-cleanup.ts` | Exponential backoff, catches gateway errors, increments attemptCount |
| Session finalization | `workspaceService.ts:404-452` or `warm-pool.ts:604-653` | Atomic `$transaction` with P2025 catch |
| Gateway port release | `gateway/src/index.ts:275-299` | Idempotent `updateMany` + cache cleanup |
| Gateway reconciliation on restart | `gateway/src/index.ts:64-109` | Rebuilds cache from DB, auto-releases stale leases |

---

## Evidence Artifacts

All saved to `exports/proofs/<date>/03-terminate-outage-recovery/`:

| File | Contents |
|---|---|
| `pre-state-*.txt` | Workspace, session, GPU state before test |
| `timeline.txt` | Gateway down/up timestamps |
| `terminate-response.txt` | Raw HTTP response from terminate |
| `terminate-leak-scan.txt` | Leak pattern scan results |
| `post-terminate-workspace.txt` | Workspace after terminate (should be TERMINATING) |
| `cleanup-job-created.txt` | Cleanup job immediately after terminate |
| `cleanup-job-retrying.txt` | Cleanup job during gateway outage |
| `worker-logs-during-outage.txt` | Worker retry logs |
| `gateway-recovered.json` | Gateway health after restart |
| `final-*.txt` | All final state captures |

---

## Rollback/Cleanup

```bash
# If workspace is stuck in TERMINATING after test:
psql "$DATABASE_URL" -c "
UPDATE workspaces SET status = 'TERMINATED', \"terminatedAt\" = NOW() WHERE id = '$WORKSPACE_ID';
UPDATE fleet_gpus SET status = 'FREE', \"currentWorkspaceId\" = NULL WHERE \"currentWorkspaceId\" = '$WORKSPACE_ID';
UPDATE workspace_endpoints SET \"releasedAt\" = NOW() WHERE \"workspaceId\" = '$WORKSPACE_ID' AND \"releasedAt\" IS NULL;
UPDATE usage_sessions SET status = 'ENDED', \"endTime\" = NOW() WHERE \"workspaceId\" = '$WORKSPACE_ID' AND status = 'RUNNING';
"

# Restart gateway if still down
cd apps/gateway && GATEWAY_PORT=5001 npx tsx src/index.ts &
```

---

## Launch Impact if Failed

**Critical.** Gateway outages are realistic in production. If terminate doesn't recover, customers get stuck workspaces and billing continues indefinitely.
