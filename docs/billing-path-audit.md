# Billing Path Audit

**Proof level**: L0 (code review only). No billing transaction exercised against Stripe.

---

## Billing Lifecycle Overview

```
Workspace RUNNING_ASSIGNED
    │
    ▼
UsageSession created (status: RUNNING, pricePerHourCents from GpuSku)
    │
    ▼ (workspace terminates)
    │
UsageSession closed (status: ENDED, totalSeconds/billedCents calculated)
    │
    ▼
WorkspaceMeterEventOutbox created (status: PENDING)
    │
    ▼ (worker metering tick, every 15s)
    │
Stripe POST /v1/billing/meter_events (gpu_seconds, identifier=sessionId)
    │
    ▼
Outbox marked SENT, UsageSession gets stripeMeterEventId
```

---

## Step 1: UsageSession Creation

**File**: `apps/api/src/services/workspaceService.ts:306-320`

**When**: After workspace assigned to user (both warm pool and cold launch), during `assignWarmWorkspace()` at line 223.

**Fields set**:
| Field | Value | Source |
|---|---|---|
| userId | Customer ID | Request |
| workspaceId | Workspace FK | Assignment |
| gpuType | GPU type string | Workspace |
| startTime | `new Date()` | Clock |
| status | `'RUNNING'` | Hardcoded |
| pricePerHourCents | From GpuSku lookup | `gpuSku.findUnique({ where: { key: gpuType } })` |

**Transaction boundary**: **NOT in transaction**. Workspace status update is transactional (lines 198-217), but `startUsageSession` is called outside at line 223.

**Gap**: If `startUsageSession` fails after workspace is `RUNNING_ASSIGNED`, orphaned workspace with no billing session. Also: missing GpuSku → `pricePerHourCents = 0` → $0 billing with no error.

---

## Step 2: UsageSession Closure

Two paths close sessions:

### Path A: Worker Cleanup (primary)
**File**: `worker/src/jobs/workspace-cleanup.ts:70-96`

Called by `processCleanupJob()` during workspace termination cleanup.

### Path B: API Direct
**File**: `apps/api/src/services/workspaceService.ts:378-402`

Called by `endUsageSession()` in API-initiated termination.

**Both paths calculate**:
```
totalSeconds = Math.ceil((endTime - startTime) / 1000)
billedCents  = Math.ceil((totalSeconds * pricePerHourCents) / 3600)
```

**Fields updated**:
| Field | Value |
|---|---|
| endTime | `new Date()` |
| totalSeconds | Ceiling of elapsed seconds |
| billedSeconds | Same as totalSeconds |
| billedCents | Ceiling of (seconds × rate / 3600) |
| status | `'ENDED'` |

**Transaction boundary**: **NOT in transaction**. Session update and meter enqueue are separate calls.

**Gap**: If session update succeeds but `enqueueWorkspaceMeterEvent()` fails, session is ENDED but no meter event queued → billing lost.

---

## Step 3: Meter Event Outbox Enqueue

**File**: `apps/api/src/services/workspaceService.ts:404-423`

```typescript
await prisma.workspaceMeterEventOutbox.upsert({
  where: { usageSessionId: sessionId },
  update: { valueSeconds: totalSeconds, status: 'PENDING', ... },
  create: { usageSessionId: sessionId, userId, workspaceId, valueSeconds: totalSeconds, status: 'PENDING', ... },
});
```

**Idempotent**: Uses `upsert` by `usageSessionId` (unique constraint). Safe for retries.

**Default event name**: `'gpu_seconds'` (hardcoded in schema default).

**Max attempts**: 20 (schema default).

---

## Step 4: Stripe Meter Event Emission

**File**: `worker/src/jobs/workspace-metering.ts:26-141`

**Schedule**: Every 15 seconds, processes up to 20 PENDING/RETRY events.

### Emission Flow

1. Pre-update outbox to `RETRY`, increment `attemptCount`
2. Look up user's `stripeCustomerId`
3. POST to `https://api.stripe.com/v1/billing/meter_events` with:
   - `event_name`: `'gpu_seconds'`
   - `identifier`: `usageSessionId` (serves as Stripe idempotency key)
   - `timestamp`: current epoch seconds
   - `payload[value]`: totalSeconds
   - `payload[stripe_customer_id]`: Stripe customer ID
4. On success: `$transaction` marks outbox SENT + updates UsageSession with `stripeMeterEventId`
5. On failure: exponential backoff [10s, 30s, 60s, 120s, 300s, 900s], eventually FAILED after 20 attempts

### Retry Behavior

| Attempt | Backoff | Cumulative |
|---|---|---|
| 1 | 10s | 10s |
| 2 | 30s | 40s |
| 3 | 60s | 100s |
| 4 | 120s | 220s |
| 5 | 300s | 520s |
| 6+ | 900s | 900s per attempt |

Attempts 7-20 repeat at 15-minute intervals. Total time to exhaustion: ~3.5 hours.

### Transaction Boundary

**Success path**: YES, outbox update + session update in `$transaction`.

**Pre-attempt status**: REMEDIATED, `attemptCount` is now incremented inside the success or failure handler, not before the Stripe call. A crash between read and Stripe call no longer wastes an attempt.

---

## Step 5: Billing Routes

**File**: `apps/api/src/routes/billing.ts`

| Route | Method | Purpose | Auth |
|---|---|---|---|
| `/billing/setup-intent` | POST | Create Stripe SetupIntent for card collection | authenticate + requireCustomerApproved + requireReauth |
| `/billing/status` | GET | Return payment status and card presence | authenticate + requireCustomerApproved |
| `/billing/webhook` | POST | Handle Stripe `setup_intent.succeeded` | Stripe signature verification |

### Setup Intent Flow
1. Find or create Stripe customer (by user email)
2. Create SetupIntent with `payment_method_types: ['card']`
3. Return `client_secret` for frontend

**Gap**: If Stripe customer creation succeeds but Prisma update fails, `stripeCustomerId` lost → duplicate Stripe customer on next call.

### Webhook Flow
On `setup_intent.succeeded`:
1. Find user by `stripeCustomerId`
2. Update `paymentStatus` to `'VALID'`, record `stripeDefaultPaymentMethodId`
3. Log security event

---

## Incident Detection

**File**: `worker/src/index.ts:505-519`

Worker auto-detects metering failures:
- Counts `WorkspaceMeterEventOutbox` in FAILED status
- Creates incident: HIGH severity (1-9 failures), CRITICAL (10+)
- Auto-resolves when count reaches 0

---

## Critical Gaps Summary

| # | Gap | Severity | Impact | Remediation Status |
|---|---|---|---|---|
| 1 | UsageSession create not in txn with workspace status | High | Orphaned workspace with no billing | Open, `startUsageSession` now has duplicate-session guard and GpuSku-missing warning, but not yet wrapped in launch txn |
| 2 | Session close and meter enqueue not atomic | High | Session ENDED but billing never emitted | **REMEDIATED**, both API `endUsageSession` and worker `finalizeUsageSessions` now use `$transaction([sessionUpdate, outboxUpsert])` |
| 3 | Pre-update to RETRY before Stripe call | High | Duplicate attempts on crash | **REMEDIATED**, `attemptCount` now incremented inside success/failure handlers, not before Stripe call |
| 4 | Stripe success + txn commit failure | High | Duplicate Stripe emission on retry | Mitigated, Stripe `identifier` field provides deduplication. Outbox upsert by `usageSessionId` prevents DB duplicates. Full proof requires Stripe integration test. |
| 5 | Missing GpuSku → $0 billing silently | Medium | Revenue loss undetected | **REMEDIATED**, `startUsageSession` now logs error when GpuSku not found |
| 6 | Stripe customer creation not atomic with DB save | Medium | Duplicate Stripe customers | Open, requires Stripe integration to fix |
| 7 | Meter event name hardcoded | Medium | Brittle to Stripe config changes | Open, low priority |
| 8 | Missing STRIPE_SECRET_KEY → silent skip | Low | Entire metering silently disabled | Open, incident detection covers this partially |

---

## Remediation Evidence

### Phase 1: Code Changes (2026-03-12)

| File | Change | Purpose |
|---|---|---|
| `workspaceService.ts:endUsageSession` | Wraps session update + outbox upsert in `$transaction([])` + P2025 catch | Atomic billing close, race-safe |
| `workspaceService.ts:startUsageSession` | Duplicate-session guard + GpuSku-missing warning | Prevent orphan sessions |
| `workspace-cleanup.ts:finalizeUsageSessions` | Same `$transaction` + P2025 pattern per session | Atomic billing close + duplicate-safe |
| `workspace-metering.ts:processMeterOutboxEvent` | `attemptCount` increment moved into success/failure handlers | No wasted attempts on crash |
| `warm-pool.ts:terminateWorkspace` | Session close now uses `$transaction` + outbox upsert + P2025 catch | Third close path now consistent |

### Phase 2: Bug Found During Verification (2026-03-13)

**`endUsageSession` missing P2025 catch**: During concurrent-race testing, `endUsageSession` (API path) racing `finalizeUsageSessions` (worker path) caused an unhandled P2025 exception. Fixed by adding the same `try/catch` pattern with P2025 skip. This was a real bug that would have caused 500 errors in production under terminate-cleanup race conditions.

### DB guarantees

- `WorkspaceMeterEventOutbox.usageSessionId` has `@unique` constraint, enforces 1:1 session-to-outbox
- Outbox upsert uses this unique key, safe for duplicate calls (update, not create)
- Session update uses `WHERE status = 'RUNNING'`, second close attempt gets P2025

### Tests (24/24 pass on local Postgres 15.17, 2026-03-13)

| Test Group | Count | What it proves |
|---|---|---|
| **Session Lifecycle** | 8 | Open, close, duplicate, concurrent, failed workspace, terminate path |
| **Atomicity** | 5 | Every ENDED session has outbox, upsert idempotent, worker race, P2025 safety, DB unique constraint |
| **Metering Outbox** | 5 | attemptCount=0 on create, first failure, repeated failure, later success, exhaustion |
| **Billing Invariants** | 6 | One RUNNING per workspace, one outbox per session, calculation, zero-price, interop, terminal cleanup |

### SQL Inspection Results (2026-03-13)

All 8 queries from `scripts/billing-state-inspection.sql` return 0 rows:

| # | Query | Expected | Actual |
|---|---|---|---|
| 1 | Active RUNNING sessions | 0 (no workspaces running) | **0** |
| 2 | ENDED sessions without outbox | 0 (no billing leaks) | **0** |
| 3 | Pending/retry backlog | 0 (no outbox entries) | **0** |
| 4 | Sent but unreconciled | 0 (no Stripe calls made) | **0** |
| 5 | Failed meter events | 0 (no dead-letters) | **0** |
| 6 | Orphan sessions on terminal workspaces | 0 (no leaks) | **0** |
| 7 | Duplicate outbox entries | 0 (unique constraint) | **0** |
| 8 | Summary dashboard | All zeroes | **All zeroes** |

See also: [billing-invariants.md](billing-invariants.md) for the formal invariant definitions.

---

## What This Audit Proves (L1, locally verified)

- Session close + outbox enqueue are atomically tied in all three close paths (API, worker cleanup, warm-pool terminate)
- Duplicate close calls are safe (no error, no duplicate billing), including API-worker race
- Concurrent close calls are safe (P2025 catch), **bug found and fixed during verification**
- `attemptCount` no longer incremented before actual Stripe call attempt
- GpuSku-missing condition is now logged (previously silent)
- DB unique constraint prevents duplicate outbox entries per session
- Zero-price sessions still create outbox entries for tracking
- Outbox retry semantics (increment, RETRY, SENT, FAILED) are correct

## What This Audit Does NOT Prove (requires real infrastructure)

- Any billing transaction actually reaches Stripe
- Pricing calculations are correct for real GPU sessions with real GpuSku seed data
- Outbox retry actually recovers from transient Stripe failures
- Duplicate Stripe customer creation actually occurs
- Incident alerting reaches operators (Slack/PagerDuty)
- Reconciliation between DB and Stripe billing records
- `startUsageSession` failure during launch actually fails the launch (still not in launch txn)
