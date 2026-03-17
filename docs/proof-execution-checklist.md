# Proof Execution Checklist

Run in order. Each proof requires staging to be operational (preflight passing).

---

## Proof 1: Staging Readiness

**Preconditions**: All env files populated, services deployed, seed data loaded.

**Scenario**: Run `node scripts/preflight-check.js` against staging.

**Expected result**: Exit 0, zero failures.

**Evidence to capture**:
- Full preflight stdout
- Exit code
- Timestamp

**Pass/fail rule**: All checks pass. Zero failures. Warnings acceptable if documented.

---

## Proof 2: Billing Parity

**Preconditions**:
- Staging operational
- Test customer has `stripeCustomerId` set to real Stripe test customer
- Stripe test customer has valid payment method
- Stripe account has `gpu_seconds` meter configured
- At least 1 free GPU of test customer's requested type

**Scenario**:
1. Login as test customer, obtain session cookie
2. POST `/workspaces/launch` with `gpu_type: "RTX_5090"`, unique `idempotency_key`
3. Poll workspace status until `RUNNING_ASSIGNED`
4. Record `startedAt` timestamp from workspace record
5. Wait a controlled duration (e.g. 120 seconds)
6. POST `/workspaces/:id/terminate`
7. Poll until workspace status is `TERMINATED`
8. Query `usage_sessions` for this workspace
9. Query `workspace_meter_event_outbox` for this usage session
10. Wait for meter event status to reach `SENT`
11. Query Stripe API for meter event with matching identifier
12. Compare: `usage_session.totalSeconds` vs actual wallclock duration vs Stripe meter value

**Expected result**:
- Usage session exists with status `ENDED`
- `totalSeconds` matches wallclock within 5 seconds
- `billedCents` = ceil(totalSeconds * pricePerHourCents / 3600)
- Meter outbox status = `SENT`
- Stripe meter event exists with matching `value` = totalSeconds
- No orphan resources after termination

**Evidence to capture**:
- Workspace record (id, status, startedAt, terminatedAt)
- Usage session record (id, startTime, endTime, totalSeconds, billedSeconds, billedCents, status)
- Meter outbox record (id, valueSeconds, status, stripeMeterEventId, sentAt)
- Stripe meter event (from Stripe API or Dashboard)
- Wallclock timestamps (launch request time, terminate request time)
- `node scripts/verify-billing-parity.js --workspace <id>` output

**Pass/fail rule**:
- PASS: totalSeconds matches wallclock (+/- 5s), billedCents matches formula exactly, Stripe meter value matches totalSeconds, meter outbox is SENT
- FAIL: any mismatch, any missing record, meter outbox stuck in PENDING/RETRY/FAILED

---

## Proof 3: Terminate Outage Recovery

**Preconditions**:
- Staging operational
- One workspace in `RUNNING_ASSIGNED` state
- Gateway process accessible for controlled shutdown

**Scenario**:
1. Confirm workspace is RUNNING_ASSIGNED with active usage session
2. Stop the gateway process (kill or `systemctl stop`)
3. POST `/workspaces/:id/terminate` from client
4. Record client response (status code, body)
5. Verify: no stack trace, no internal detail in response
6. Verify: workspace transitions to TERMINATING
7. Verify: WorkspaceCleanupJob created with status PENDING
8. Check cleanup job retry behavior while gateway is down (should retry, not crash)
9. Restart gateway
10. Wait for cleanup job to complete
11. Verify: workspace reaches TERMINATED
12. Verify: usage session is ENDED with correct billing
13. Verify: GPU is FREE, ports released

**Expected result**:
- Client gets 202 with `{"ok":true,"status":"TERMINATING","queued":true}`
- No stack trace or internal detail in any client response
- Cleanup job retries with backoff while gateway is down
- After gateway restart, cleanup completes
- Workspace reaches TERMINATED
- Usage session closes correctly
- GPU freed, ports released

**Evidence to capture**:
- Client response (raw HTTP status + body)
- Workspace status transitions with timestamps
- Cleanup job record (attemptCount, lastErrorCode, status transitions)
- Usage session final state
- GPU allocation state
- Port allocation state
- Gateway downtime window

**Pass/fail rule**:
- PASS: safe client response, automatic recovery after gateway restart, correct billing, no leaked resources
- FAIL: stack trace in client response, workspace stuck, billing continues after termination, GPU or port leaked

---

## Proof 4: Last-GPU Contention

**Preconditions**:
- Staging operational
- Exactly 1 free GPU of test type (e.g. RTX_5090)
- Other GPUs of that type are ALLOCATED or do not exist
- Two authenticated test sessions (can be same user if maxActiveWorkspaces >= 2, or two users)

**Scenario**:
1. Verify: exactly 1 free RTX_5090 GPU
2. Send two concurrent POST `/workspaces/launch` requests (different idempotency keys)
3. Record timestamps and responses for both
4. Wait for both to resolve
5. Query: workspace count, GPU allocation count, fleet GPU states

**Expected result**:
- One request succeeds (workspace created, GPU allocated)
- One request fails cleanly (400/429 with NO_GPU_AVAILABLE or MAX_WORKSPACES_REACHED, or workspace created but reaches FAILED with NO_GPU_AVAILABLE)
- Exactly 1 GPU allocated
- No double allocation
- No ghost workspace in non-terminal state from the failed request
- Fleet GPU inventory is consistent (1 allocated, 0 free of that type)

**Evidence to capture**:
- Pre-test GPU inventory state
- Both request payloads and timestamps
- Both responses (status code, body)
- Post-test workspace records
- Post-test GPU allocation records
- Post-test fleet GPU states
- `node scripts/verify-cleanup.js` output

**Pass/fail rule**:
- PASS: one winner, one clean loser, no double allocation, no ghost state, inventory correct
- FAIL: double allocation, both succeed, ghost workspace, inconsistent inventory

---

## Proof 5: Restore Drill

**Preconditions**:
- Staging operational with Postgres
- Known data in staging DB (users, workspaces, usage sessions, fleet data)
- Access to `pg_dump` and target restore environment

**Scenario**:
1. Take Postgres backup: `pg_dump -Fc aldaro_staging > staging-backup.dump`
2. Record row counts for critical tables
3. Create fresh database: `createdb aldaro_staging_restore`
4. Restore: `pg_restore -d aldaro_staging_restore staging-backup.dump`
5. Point services at restored DB
6. Start API, verify health
7. Start worker, verify leader lock acquired
8. Login as test user, verify session works
9. Query workspace history, verify data present
10. Compare critical table row counts with pre-backup counts

**Expected result**:
- Restore completes without error
- API boots and health returns OK
- Worker acquires leader lock
- Auth works (login, session)
- Data integrity: row counts match
- Lifecycle smoke: can query workspaces, fleet state is consistent

**Evidence to capture**:
- Backup file metadata (size, timestamp)
- Pre-backup table row counts
- Restore command output
- Post-restore table row counts
- API health response
- Worker log showing leader lock acquired
- Auth smoke (login response)
- Sample data comparison (users, workspaces, fleet)

**Pass/fail rule**:
- PASS: restore succeeds, services boot, data matches, auth works, lifecycle smoke passes
- FAIL: restore error, data loss, service won't boot, auth broken

---

## Proof 6: Client-Facing Stack Leakage

**Preconditions**:
- Staging API running in production mode (`NODE_ENV=production`)

**Scenario**: Hit each failure path and capture the raw client response.

| # | Path | Trigger | Expected Response |
|---|---|---|---|
| 1 | Terminate failure | POST `/workspaces/:id/terminate` with gateway down | 202 with queued:true, no stack |
| 2 | CORS rejection | POST `/auth/login` with `Origin: https://evil.example` | Blocked or empty body, no stack |
| 3 | Rate limit | Hammer `/auth/forgot-password` > 100x in 1 min | 429 with `RATE_LIMITED`, no stack |
| 4 | CSRF failure | POST `/workspaces/launch` with cookie but no x-csrf-token | 403 with `CSRF_TOKEN_INVALID`, no stack |
| 5 | Cross-tenant | GET `/workspaces/:other-users-workspace-id` as wrong user | 404 with `WORKSPACE_NOT_FOUND`, no stack |
| 6 | Bad JSON body | POST `/workspaces/launch` with malformed JSON | 400, no stack |
| 7 | Unknown route | GET `/api/nonexistent` | 404, no stack |

For each: capture full HTTP response (status, headers, body). Grep body for:
- Stack trace patterns: `at `, `node_modules`, `Error:`, `.ts:`, `.js:`
- Internal hostnames, IPs, file paths, connection strings
- Module names, Prisma errors, Proxmox URLs

**Expected result**: Zero leakage across all paths.

**Evidence to capture**:
- Raw response body for each test case
- Grep results for leak patterns
- Pass/fail per test case

**Pass/fail rule**:
- PASS: no internal detail in any client response across all 7 paths
- FAIL: any stack trace, internal hostname, file path, or connection detail in any response

---

## Proof 7: Cleanup Durability

**Preconditions**:
- Staging operational
- Clean starting state (no orphan resources)

**Scenario**:
1. Create artificial stale state:
   a. Insert workspace with status `CREATING`, `updatedAt` = 20 minutes ago
   b. Insert workspace with status `TERMINATING`, `updatedAt` = 15 minutes ago
   c. Insert FleetGpu with status `ALLOCATED`, pointing to a TERMINATED workspace
   d. Insert WorkspaceEndpoint with `releasedAt = null`, pointing to a TERMINATED workspace
2. Do NOT manually clean anything
3. Wait for worker cleanup tick to run (< 60 seconds)
4. Query state after 2-3 cleanup cycles

**Expected result**:
- Stale CREATING workspace: transitions to TERMINATING, then cleanup job runs, reaches TERMINATED or FAILED
- Stale TERMINATING workspace: cleanup job created and processed
- Stuck GPU: auto-released to FREE by incident detection
- Leaked port: auto-released by incident detection
- No manual intervention required

**Evidence to capture**:
- Inserted stale records (IDs, initial states, timestamps)
- Worker logs showing cleanup/reconciliation activity
- Final state of each record
- `node scripts/verify-cleanup.js` output after reconciliation
- Time from injection to resolution

**Pass/fail rule**:
- PASS: all injected stale states resolved automatically, verify-cleanup passes, no manual intervention
- FAIL: any stale state persists after 5 minutes, manual intervention required, verify-cleanup still shows issues
