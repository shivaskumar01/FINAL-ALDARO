# Proof 04: Last-GPU Contention

**Proves that two concurrent launch requests for the last available GPU produce exactly one winner and one clean loser, with no double allocation, no ghost workspaces, and consistent inventory.**

---

## Objective

With exactly 1 free GPU, fire two simultaneous launch requests. Exactly one gets the GPU. The other fails cleanly. Fleet inventory is consistent afterward. No double-allocation, no ghost workspaces stuck in non-terminal state.

---

## Preconditions

| # | Requirement | How to verify |
|---|---|---|
| 1 | Proof 01 passed | Staging readiness green |
| 2 | Exactly 1 free RTX_5090 GPU | Query below shows count=1 |
| 3 | Two authenticated test sessions | Two separate cookie files, same or different users |
| 4 | No active workspaces from prior tests | `SELECT COUNT(*) FROM workspaces WHERE status NOT IN ('TERMINATED','FAILED')` = 0 |

---

## Commands

```bash
DATE=$(date +%Y-%m-%d)
DIR="exports/proofs/$DATE/04-last-gpu-contention"
mkdir -p "$DIR"

# === SETUP: Ensure exactly 1 free GPU ===

# 1. Check current GPU state
psql "$DATABASE_URL" -c "SELECT id, \"gpuType\", status, \"currentWorkspaceId\" FROM fleet_gpus WHERE \"gpuType\" = 'RTX_5090' ORDER BY status;" | tee "$DIR/pre-gpu-state.txt"

# 2. If more than 1 free, temporarily lock extras
# psql "$DATABASE_URL" -c "UPDATE fleet_gpus SET status = 'MAINTENANCE' WHERE id IN (SELECT id FROM fleet_gpus WHERE \"gpuType\" = 'RTX_5090' AND status = 'FREE' OFFSET 1);"

# 3. Confirm exactly 1 free
FREE_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM fleet_gpus WHERE \"gpuType\" = 'RTX_5090' AND status = 'FREE';" | tr -d ' ')
echo "FREE_RTX_5090=$FREE_COUNT" | tee "$DIR/free-gpu-count.txt"
if [ "$FREE_COUNT" != "1" ]; then echo "ABORT: Need exactly 1 free GPU, have $FREE_COUNT"; exit 1; fi

# === SETUP: Two authenticated sessions ===

# 4a. Login user A
curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://staging.aldaro.ai" \
  -d '{"email":"test-user-a@aldaro.ai","password":"TEST_PASSWORD"}' \
  -c cookies-a.txt -v 2>&1 | tee "$DIR/login-a.txt"

CSRF_A=$(grep -i 'x-csrf-token' "$DIR/login-a.txt" | awk '{print $NF}' | tr -d '\r')

# 4b. Login user B (or same user if maxActiveWorkspaces >= 2)
curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://staging.aldaro.ai" \
  -d '{"email":"test-user-b@aldaro.ai","password":"TEST_PASSWORD"}' \
  -c cookies-b.txt -v 2>&1 | tee "$DIR/login-b.txt"

CSRF_B=$(grep -i 'x-csrf-token' "$DIR/login-b.txt" | awk '{print $NF}' | tr -d '\r')

# === CONCURRENT LAUNCH ===

# 5. Fire both requests simultaneously
RACE_START=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
echo "RACE_START=$RACE_START" | tee "$DIR/timeline.txt"

curl -s -X POST http://localhost:4000/workspaces/launch \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF_A" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies-a.txt \
  -d '{"gpu_type":"RTX_5090","idempotency_key":"contention-A-001"}' \
  -w "\nHTTP_CODE:%{http_code}\n" \
  -o "$DIR/response-a.json" &
PID_A=$!

curl -s -X POST http://localhost:4000/workspaces/launch \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF_B" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies-b.txt \
  -d '{"gpu_type":"RTX_5090","idempotency_key":"contention-B-001"}' \
  -w "\nHTTP_CODE:%{http_code}\n" \
  -o "$DIR/response-b.json" &
PID_B=$!

wait $PID_A $PID_B

RACE_END=$(date -u +%Y-%m-%dT%H:%M:%S.%NZ)
echo "RACE_END=$RACE_END" >> "$DIR/timeline.txt"

# 6. Capture responses
echo "=== Response A ===" | tee "$DIR/responses.txt"
cat "$DIR/response-a.json" >> "$DIR/responses.txt"
echo "" >> "$DIR/responses.txt"
echo "=== Response B ===" >> "$DIR/responses.txt"
cat "$DIR/response-b.json" >> "$DIR/responses.txt"

# === WAIT FOR RESOLUTION ===

# 7. Wait for both to resolve (worker needs time for cold provision or failure)
echo "Waiting 60s for resolution..."
sleep 60

# === EVIDENCE CAPTURE ===

# 8. Post-test workspaces
psql "$DATABASE_URL" -c "
SELECT id, status, \"gpuType\", \"assignedUserId\", \"lastErrorCode\", \"createdAt\"
FROM workspaces
WHERE status NOT IN ('TERMINATED', 'FAILED')
   OR \"createdAt\" > NOW() - INTERVAL '5 minutes'
ORDER BY \"createdAt\" DESC;
" | tee "$DIR/post-workspaces.txt"

# 9. Post-test GPU state
psql "$DATABASE_URL" -c "
SELECT id, \"gpuType\", status, \"currentWorkspaceId\"
FROM fleet_gpus
WHERE \"gpuType\" = 'RTX_5090';
" | tee "$DIR/post-gpu-state.txt"

# 10. GPU allocation records
psql "$DATABASE_URL" -c "
SELECT id, \"workspaceId\", \"gpuId\", \"releasedAt\", \"createdAt\"
FROM workspace_gpu_allocations
WHERE \"createdAt\" > NOW() - INTERVAL '5 minutes'
ORDER BY \"createdAt\";
" | tee "$DIR/post-gpu-allocations.txt"

# 11. Launch operation records
psql "$DATABASE_URL" -c "
SELECT id, \"userId\", \"operationKey\", \"workspaceId\", status, \"lastErrorCode\"
FROM workspace_launch_operations
WHERE \"operationKey\" LIKE 'contention-%'
ORDER BY \"createdAt\";
" | tee "$DIR/post-launch-operations.txt"

# 12. Ghost workspace check: non-terminal workspaces that shouldn't exist
psql "$DATABASE_URL" -c "
SELECT id, status, \"assignedUserId\", \"lastErrorCode\"
FROM workspaces
WHERE status NOT IN ('TERMINATED', 'FAILED', 'RUNNING_ASSIGNED', 'WARM_AVAILABLE')
  AND \"createdAt\" > NOW() - INTERVAL '5 minutes';
" | tee "$DIR/ghost-check.txt"

# 13. Double allocation check
psql "$DATABASE_URL" -c "
SELECT \"gpuType\", status, COUNT(*)
FROM fleet_gpus
WHERE \"gpuType\" = 'RTX_5090'
GROUP BY \"gpuType\", status;
" | tee "$DIR/allocation-count.txt"
```

---

## Pass/Fail Rules

| # | Check | PASS | FAIL |
|---|---|---|---|
| 1 | One winner | Exactly 1 request returns 200/201 with workspace | Both return success |
| 2 | One clean loser | Other request returns 4xx with `NO_GPU_AVAILABLE` or `MAX_WORKSPACES_REACHED`, or workspace reaches FAILED | Error 500 or unhandled |
| 3 | No double allocation | Exactly 1 GPU is ALLOCATED for RTX_5090 | 2 GPUs allocated or same GPU allocated twice |
| 4 | No ghost workspace | 0 workspaces in CREATING/ASSIGNING that are >60s old | Stuck intermediate state |
| 5 | Inventory consistent | Sum of ALLOCATED + FREE = total RTX_5090 GPUs | Mismatch |
| 6 | Idempotency keys work | Launch operations table has 2 rows, one with workspace, one with error | Missing or corrupt |

**Overall**: ALL checks must pass.

---

## False-Pass Warnings

| Scenario | Why it looks like a pass but isn't |
|---|---|
| Requests not actually concurrent | One finishes before the other starts — no real contention. Check timestamps: `RACE_START` to `RACE_END` should be <1s |
| Loser fails at quota check | If same user with maxActiveWorkspaces=1, second request is rejected before reaching GPU selection — you tested quota, not GPU contention. Use two different users. |
| Warm pool assignment (not cold) | If a WARM_AVAILABLE workspace exists, the race happens at warm assignment, not GPU allocation — different code path. Ensure no warm pool workspaces exist. |
| Worker hasn't processed yet | Both requests create CREATING workspaces, worker hasn't picked either up — wait longer or check worker tick |
| GPU selection is `findFirst` without lock | Current code uses `findFirst` without `FOR UPDATE` — both requests may select the same GPU but only one `$transaction` succeeds. This is the expected behavior but should be documented as a serialization point. |

---

## Remediated Code Paths Being Tested

| Path | File:Line | Behavior |
|---|---|---|
| GPU allocation | `warm-pool.ts:157-173` | `$transaction([fleetGpu.update, gpuAllocation.create])` — atomic |
| Cold GPU allocation | `warm-pool.ts:357-373` | Same atomic pattern for cold provisions |
| GPU rollback on failure | `warm-pool.ts:242-261` | GPU freed + allocation deleted on provision failure |
| Launch idempotency | `workspaceService.ts:41-71` | `WorkspaceLaunchOperation` with `@@unique([userId, operationKey])` |

---

## Evidence Artifacts

All saved to `exports/proofs/<date>/04-last-gpu-contention/`:

| File | Contents |
|---|---|
| `pre-gpu-state.txt` | GPU inventory before test |
| `free-gpu-count.txt` | Confirms exactly 1 free |
| `timeline.txt` | Race start/end timestamps |
| `response-a.json` | Request A response |
| `response-b.json` | Request B response |
| `responses.txt` | Both responses combined |
| `post-workspaces.txt` | Workspace state after race |
| `post-gpu-state.txt` | GPU state after race |
| `post-gpu-allocations.txt` | Allocation records |
| `post-launch-operations.txt` | Idempotency records |
| `ghost-check.txt` | Stuck intermediate workspaces (should be 0) |
| `allocation-count.txt` | GPU allocation summary |

---

## Rollback/Cleanup

```bash
# Terminate any test workspaces
for WS_ID in $(psql "$DATABASE_URL" -t -c "SELECT id FROM workspaces WHERE status NOT IN ('TERMINATED','FAILED') AND \"createdAt\" > NOW() - INTERVAL '10 minutes';"); do
  curl -X POST http://localhost:4000/workspaces/$WS_ID/terminate \
    -H "Content-Type: application/json" \
    -H "x-csrf-token: $CSRF_A" \
    -H "Origin: https://staging.aldaro.ai" \
    -b cookies-a.txt
done

# Restore any GPUs put in MAINTENANCE
# psql "$DATABASE_URL" -c "UPDATE fleet_gpus SET status = 'FREE' WHERE status = 'MAINTENANCE' AND \"gpuType\" = 'RTX_5090';"

# Wait for cleanup
sleep 60

# Verify clean state
psql "$DATABASE_URL" -c "SELECT status, COUNT(*) FROM fleet_gpus WHERE \"gpuType\" = 'RTX_5090' GROUP BY status;"
```

---

## Launch Impact if Failed

**Critical.** Double GPU allocation means two customers get the same hardware. This is a data integrity and billing correctness issue.
