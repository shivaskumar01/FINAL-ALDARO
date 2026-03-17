# Proof 02: Billing Parity

**Proves the billing pipeline produces exact, auditable results from workspace launch to Stripe meter event.**

---

## Objective

End-to-end: wallclock duration = usage session `totalSeconds` = outbox `valueSeconds` = Stripe meter event value. `billedCents` = ceil(totalSeconds × pricePerHourCents / 3600). No orphan sessions, no missing outbox entries, no duplicate meter events.

---

## Preconditions

| # | Requirement | How to verify |
|---|---|---|
| 1 | Proof 01 passed | All staging readiness checks green |
| 2 | Test customer exists with `stripeCustomerId` | `psql -c "SELECT id, email, \"stripeCustomerId\" FROM users WHERE email = 'integration-test@aldaro.ai';"` |
| 3 | Stripe test customer has payment method | Stripe Dashboard → Customers → test customer → Payment methods |
| 4 | Stripe `gpu_seconds` meter configured | Stripe Dashboard → Billing → Meters → `gpu_seconds` exists |
| 5 | At least 1 FREE RTX_5090 GPU | `psql -c "SELECT COUNT(*) FROM fleet_gpus WHERE \"gpuType\" = 'RTX_5090' AND status = 'FREE';"` returns ≥ 1 |
| 6 | GPU SKU pricing is non-zero | `psql -c "SELECT key, \"pricePerHourCents\" FROM gpu_skus WHERE key = 'RTX_5090';"` returns > 0 |
| 7 | Worker running with metering tick active | Worker log shows tick activity |

---

## Commands

```bash
DATE=$(date +%Y-%m-%d)
DIR="exports/proofs/$DATE/02-billing-parity"
mkdir -p "$DIR"

# === PRE-STATE CAPTURE ===

# 1. Capture GPU SKU pricing (needed for manual calculation)
psql "$DATABASE_URL" -c "SELECT key, \"pricePerHourCents\" FROM gpu_skus WHERE key = 'RTX_5090';" | tee "$DIR/gpu-sku-pricing.txt"

# 2. Login as test customer
curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://staging.aldaro.ai" \
  -d '{"email":"integration-test@aldaro.ai","password":"TEST_PASSWORD"}' \
  -c cookies.txt -v 2>&1 | tee "$DIR/login-response.txt"

# Extract CSRF token from response headers
CSRF_TOKEN=$(grep -i 'x-csrf-token' "$DIR/login-response.txt" | awk '{print $NF}' | tr -d '\r')

# === LAUNCH ===

# 3. Record wallclock start
LAUNCH_WALLCLOCK=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "LAUNCH_WALLCLOCK=$LAUNCH_WALLCLOCK" | tee "$DIR/wallclock.txt"

# 4. Launch workspace
curl -s -X POST http://localhost:4000/workspaces/launch \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF_TOKEN" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt \
  -d '{"gpu_type":"RTX_5090","idempotency_key":"billing-proof-001"}' \
  -v 2>&1 | tee "$DIR/launch-response.txt"

# Extract workspace ID from response
WORKSPACE_ID=$(cat "$DIR/launch-response.txt" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "WORKSPACE_ID=$WORKSPACE_ID" >> "$DIR/wallclock.txt"

# 5. Poll until RUNNING_ASSIGNED (max 5 min)
for i in $(seq 1 30); do
  STATUS=$(curl -s http://localhost:4000/workspaces/$WORKSPACE_ID \
    -H "Origin: https://staging.aldaro.ai" \
    -b cookies.txt | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "$(date -u +%H:%M:%S) status=$STATUS"
  if [ "$STATUS" = "RUNNING_ASSIGNED" ]; then break; fi
  if [ "$STATUS" = "FAILED" ]; then echo "FATAL: Workspace FAILED" && break; fi
  sleep 10
done

# === CONTROLLED USAGE PERIOD ===

# 6. Wait exactly 120 seconds
echo "Waiting 120 seconds for billing accumulation..."
sleep 120

# === TERMINATE ===

# 7. Record wallclock before terminate
TERMINATE_WALLCLOCK=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "TERMINATE_WALLCLOCK=$TERMINATE_WALLCLOCK" >> "$DIR/wallclock.txt"

# 8. Terminate workspace
curl -s -X POST http://localhost:4000/workspaces/$WORKSPACE_ID/terminate \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF_TOKEN" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt \
  -v 2>&1 | tee "$DIR/terminate-response.txt"

# 9. Poll until TERMINATED (max 3 min)
for i in $(seq 1 18); do
  STATUS=$(curl -s http://localhost:4000/workspaces/$WORKSPACE_ID \
    -H "Origin: https://staging.aldaro.ai" \
    -b cookies.txt | grep -o '"status":"[^"]*"' | head -1 | cut -d'"' -f4)
  echo "$(date -u +%H:%M:%S) status=$STATUS"
  if [ "$STATUS" = "TERMINATED" ]; then break; fi
  sleep 10
done

# === WAIT FOR METERING ===

# 10. Wait for worker metering tick (max 90 seconds)
echo "Waiting for metering tick..."
sleep 90

# === EVIDENCE CAPTURE ===

# 11. Workspace record
psql "$DATABASE_URL" -c "
SELECT id, status, \"startedAt\", \"terminatedAt\", \"gpuType\",
       \"assignedUserId\", \"terminationReason\"
FROM workspaces WHERE id = '$WORKSPACE_ID';
" | tee "$DIR/workspace-record.txt"

# 12. Usage session record
psql "$DATABASE_URL" -c "
SELECT id, \"workspaceId\", \"userId\", \"startTime\", \"endTime\",
       \"totalSeconds\", \"billedSeconds\", \"billedCents\", status,
       \"pricePerHourCents\", \"gpuType\"
FROM usage_sessions WHERE \"workspaceId\" = '$WORKSPACE_ID';
" | tee "$DIR/usage-session.txt"

# 13. Meter outbox record
psql "$DATABASE_URL" -c "
SELECT o.id, o.\"usageSessionId\", o.\"valueSeconds\", o.status,
       o.\"stripeMeterEventId\", o.\"sentAt\", o.\"attemptCount\",
       o.\"lastErrorCode\", o.\"lastErrorMessage\"
FROM workspace_meter_event_outbox o
JOIN usage_sessions s ON o.\"usageSessionId\" = s.id
WHERE s.\"workspaceId\" = '$WORKSPACE_ID';
" | tee "$DIR/meter-outbox.txt"

# 14. Billing invariant checks (from billing-state-inspection.sql)
psql "$DATABASE_URL" -f scripts/billing-state-inspection.sql | tee "$DIR/billing-invariant-check.txt"

# 15. Orphan resource check
psql "$DATABASE_URL" -c "
SELECT 'allocated_gpus' AS check, COUNT(*) FROM fleet_gpus WHERE status = 'ALLOCATED' AND \"currentWorkspaceId\" = '$WORKSPACE_ID'
UNION ALL
SELECT 'unreleased_endpoints', COUNT(*) FROM workspace_endpoints WHERE \"workspaceId\" = '$WORKSPACE_ID' AND \"releasedAt\" IS NULL
UNION ALL
SELECT 'running_sessions', COUNT(*) FROM usage_sessions WHERE \"workspaceId\" = '$WORKSPACE_ID' AND status = 'RUNNING';
" | tee "$DIR/orphan-check.txt"

# 16. Wallclock comparison
echo "" >> "$DIR/wallclock.txt"
echo "=== MANUAL VERIFICATION ===" >> "$DIR/wallclock.txt"
echo "Expected totalSeconds: ~120 (±5s)" >> "$DIR/wallclock.txt"
echo "Expected billedCents: ceil(totalSeconds * pricePerHourCents / 3600)" >> "$DIR/wallclock.txt"
cat "$DIR/wallclock.txt"
```

---

## Pass/Fail Rules

| # | Check | PASS | FAIL |
|---|---|---|---|
| 1 | Usage session exists | Exactly 1 row with status=ENDED | 0 rows or status≠ENDED |
| 2 | Wallclock match | `totalSeconds` within ±5s of wallclock (launch-to-terminate) | Deviation > 5s |
| 3 | Billing math | `billedCents` = ceil(totalSeconds × pricePerHourCents / 3600) exactly | Any mismatch |
| 4 | Outbox exists | Exactly 1 row with status=SENT | Missing, PENDING, RETRY, or FAILED |
| 5 | Outbox value match | `valueSeconds` = session `totalSeconds` | Mismatch |
| 6 | Stripe meter event | `stripeMeterEventId` is non-null, event visible in Stripe Dashboard | Missing or null |
| 7 | No orphan resources | GPU freed, endpoint released, no RUNNING session | Any orphan |
| 8 | No duplicate outbox | billing-state-inspection query 7 returns 0 rows | Any duplicates |
| 9 | No billing leak | billing-state-inspection query 2 (ENDED without outbox) returns 0 | Any leaked sessions |

**Overall**: ALL checks must pass.

---

## False-Pass Warnings

| Scenario | Why it looks like a pass but isn't |
|---|---|
| `pricePerHourCents = 0` | All math works (0 × anything = 0) but customer is never billed — verify GPU SKU pricing pre-test |
| `totalSeconds` = 0 | Session started and ended in same second — terminate happened before usage accumulated |
| Outbox status = SENT but `stripeMeterEventId` is fake | Stripe test mode accepts anything — verify event exists in Stripe Dashboard |
| Only 1 session tested | This proves the happy path once — does NOT prove concurrent races, which need stress tests |
| Worker tick happened to run before terminate | Session was already closed by worker, not by terminate path — both paths are valid but you're testing a different code path than you think |

---

## Billing Invariants Being Tested

These map to `docs/billing-invariants.md`:

| Invariant | How this proof exercises it |
|---|---|
| INV-1: At most one RUNNING session per workspace | Session query returns exactly 1 ENDED row |
| INV-4: Failed provision cannot create billable usage | Workspace must reach RUNNING_ASSIGNED before session exists |
| INV-5: Terminate cannot leave RUNNING session | Post-terminate query shows 0 RUNNING sessions |
| INV-6: Session close + outbox enqueue are atomic | ENDED session has exactly 1 outbox row |

---

## Evidence Artifacts

All saved to `exports/proofs/<date>/02-billing-parity/`:

| File | Contents |
|---|---|
| `gpu-sku-pricing.txt` | RTX_5090 price used for calculation |
| `login-response.txt` | Auth response (verify cookie set) |
| `launch-response.txt` | Workspace creation response |
| `terminate-response.txt` | Terminate response |
| `wallclock.txt` | Launch/terminate timestamps + workspace ID |
| `workspace-record.txt` | Final workspace DB state |
| `usage-session.txt` | Usage session with billing fields |
| `meter-outbox.txt` | Outbox record with Stripe event ID |
| `billing-invariant-check.txt` | Full billing-state-inspection.sql output |
| `orphan-check.txt` | Resource leak check |

---

## Rollback/Cleanup

```bash
# If workspace is stuck, terminate manually
curl -X POST http://localhost:4000/workspaces/$WORKSPACE_ID/terminate \
  -H "Content-Type: application/json" \
  -H "x-csrf-token: $CSRF_TOKEN" \
  -H "Origin: https://staging.aldaro.ai" \
  -b cookies.txt

# Wait and verify cleanup
sleep 60
psql "$DATABASE_URL" -c "SELECT status FROM workspaces WHERE id = '$WORKSPACE_ID';"

# If still stuck: manual cleanup
psql "$DATABASE_URL" -c "
UPDATE workspaces SET status = 'TERMINATED', \"terminatedAt\" = NOW() WHERE id = '$WORKSPACE_ID';
UPDATE fleet_gpus SET status = 'FREE', \"currentWorkspaceId\" = NULL WHERE \"currentWorkspaceId\" = '$WORKSPACE_ID';
UPDATE workspace_endpoints SET \"releasedAt\" = NOW() WHERE \"workspaceId\" = '$WORKSPACE_ID' AND \"releasedAt\" IS NULL;
UPDATE usage_sessions SET status = 'ENDED', \"endTime\" = NOW() WHERE \"workspaceId\" = '$WORKSPACE_ID' AND status = 'RUNNING';
"
```

---

## Launch Impact if Failed

**Critical.** Billing incorrectness means customers are overcharged or undercharged. Cannot launch without exact parity proof.
