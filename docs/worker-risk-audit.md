# Worker Risk Audit

**Proof level**: L0 (code review only). No job failures locally exercised except warm-pool CREATING → FAILED.

---

## Executive Summary

The worker manages Aldaro's GPU workspace lifecycle across 7 distinct jobs. It uses a leader-lock pattern (Postgres advisory lock) for single-writer semantics and implements retry/dead-letter patterns for most async operations. Key infrastructure dependency is Proxmox (no external GPU providers). Critical gaps exist around cleanup retries and metering failure recovery.

---

## Job-by-Job Analysis

### 1. warm-pool.ts, Warm Pool Provisioning

**Purpose**: Maintains pool of pre-provisioned warm workspaces; also handles cold launch provisioning.

**What it does**:
- Scales warm pool up/down based on target count per GPU type/region
- Spawns new warm workspaces: find free GPU → clone template → attach GPU passthrough → start VM
- Processes cold launches with same provision flow
- Monitors WAITING_FOR_AGENT workspaces for IP discovery and agent heartbeat
- Terminates workspace on timeout (5 min) or explicit request

**Error handling**:
- Try/catch around clone/GPU attachment in `spawnWarmWorkspace()` and `provisionColdWorkspace()`
- On provision failure: marks workspace FAILED, rolls back GPU allocation, deletes created VM (nested try/catch for cleanup errors)
- Warm pool spawn failures logged but continue iterating (resilient loop)
- No explicit retry; failures remain in DB for stale sweeper or manual intervention

**External dependencies**: Proxmox API (clone, config, start, stop, delete), Database (Prisma)

**Failure consequences**:
| Failure | Consequence |
|---|---|
| Proxmox clone fails | Orphan VM in Proxmox if clone started but tracking failed |
| GPU passthrough fails | VM exists but unusable; GPU rolled back |
| VM start fails | VM cloned/configured but never boots; stuck in CREATING |
| No free GPU | Workspace stays CREATING indefinitely |
| Agent timeout (5 min) | Workspace marked FAILED, cleanup queued |
| Provision cleanup fails | Console error only; VM may persist in Proxmox |

**Risk level**: **HIGH**, Orphan VMs can accumulate; GPU allocation race conditions possible; no cleanup retry for failed provision cleanups.

---

### 2. workspace-cleanup.ts, Terminal Cleanup Queue

**Purpose**: VM deletion, GPU release, billing finalization, gateway port release with retry logic.

**What it does**:
- Enqueues stale workspaces (CREATING >15 min, TERMINATING >10 min) into cleanup queue
- Processes cleanup jobs with exponential backoff: [10s, 30s, 60s, 120s, 300s, 900s]
- Per job: finalize usage sessions → release gateway ports → stop/delete VM → release GPU → release endpoints
- On success: mark job DONE, workspace TERMINATED
- On exhaustion: mark FAILED, create incident (HIGH severity)

**Error handling**:
- Exponential backoff retry (6 levels)
- Dead-letter: failed jobs create incident, stay FAILED (no auto-recovery)
- Best-effort gateway release (retries on failure)
- VM deletion gracefully handles "does not exist" errors

**External dependencies**: Proxmox API (stop, delete), Gateway service (HMAC-signed release), Database (Prisma)

**Failure consequences**:
| Failure | Consequence |
|---|---|
| Gateway port release fails | Job retries; on dead-letter, ports leak indefinitely |
| Proxmox VM delete fails | Job retries; on dead-letter, VM persists |
| Usage session finalization fails | Session stays RUNNING; meter event never enqueued |

**Risk level**: **MEDIUM**, Exponential backoff provides resilience; dead-letter incidents created but may not trigger external alerting.

---

### 3. idle-termination.ts, Idle/Dead-Agent Detection

**Purpose**: Scans RUNNING_ASSIGNED workspaces for termination triggers.

**What it does**:
- Three triggers: dead agent (heartbeat >5 min old), missing agent (no heartbeat after 10 min), idle timeout (GPU utilization <5% for >20 min)
- Enqueues matching workspaces via Prisma transaction (status update + cleanup job creation)

**Error handling**: No explicit try/catch; relies on transaction semantics. Failed transactions leave workspace RUNNING for re-evaluation next tick.

**External dependencies**: Database only (reads heartbeat/utilization, writes cleanup jobs)

**Failure consequences**: Worst case, idle workspace persists longer than timeout (resource waste, not leak).

**Risk level**: **LOW**

---

### 4. workspace-metering.ts, Stripe Billing Emission

**Purpose**: Emits billing meter events to Stripe for usage-based billing.

**What it does**:
- Polls `workspaceMeterEventOutbox` for PENDING/RETRY events
- Per event: fetch user's Stripe customer ID → call Stripe meter events API → mark SENT or FAILED

**Error handling**:
- Exponential backoff [10s, 30s, 60s, 120s, 300s, 900s]
- Dead-letter: events marked FAILED, stay failed
- Graceful handling of missing Stripe customer ID (immediate FAILED)

**External dependencies**: Stripe API (meter events), Database (Prisma)

**Failure consequences**:
| Failure | Consequence |
|---|---|
| Stripe API down | Events backoff, eventually dead-lettered; revenue not recorded |
| Missing Stripe customer ID | Event FAILED immediately |
| DB commit fails after Stripe succeeds | Duplicate emission possible (no idempotency token) |

**Risk level**: **MEDIUM**, No idempotency guard on Stripe calls; dead-letter events may not trigger alerting.

---

### 5. email-outbox.ts, Transactional Emails

**Purpose**: Sends application review emails via SMTP/SES.

**What it does**:
- Polls `emailOutbox` for PENDING emails (attempt count < 5)
- Updates status to SENDING → calls sendEmail() → marks SENT or FAILED

**Error handling**: Try/catch around sendEmail(); max 5 attempts; no backoff.

**External dependencies**: Email provider (SMTP/SES, **NOT IMPLEMENTED**, dev stub only), Database (Prisma)

**Failure consequences**:
| Failure | Consequence |
|---|---|
| Provider unavailable | Email FAILED after 5 immediate attempts (no backoff) |
| Crash between SENDING update and send | Email stuck in SENDING state (orphan) |
| Provider credentials missing | All emails fail immediately |

**Risk level**: **MEDIUM**, Email provider not implemented (production blocker); no backoff logic; SENDING state orphan possible.

---

### 6. event-retention.ts, Event Archival

**Purpose**: Archives old events into daily rollups and deletes events >30 days old.

**Error handling**: None explicit; relies on Prisma transaction semantics. Retried next daily cycle.

**External dependencies**: Database only.

**Risk level**: **LOW**

---

### 7. fleet-daily-agg.ts, Fleet Metrics Aggregation

**Purpose**: Computes daily fleet utilization/revenue metrics for dashboards.

**Error handling**: None explicit; relies on Prisma upsert atomicity. Can be manually rerun.

**External dependencies**: Database only.

**Risk level**: **LOW**

---

## Cross-Job Risk Summary

| Risk | Severity | Jobs Affected |
|---|---|---|
| Orphan VMs in Proxmox | High | warm-pool, workspace-cleanup |
| GPU allocated but never released | High | warm-pool, workspace-cleanup |
| Gateway port leaks | Medium | workspace-cleanup |
| Dead-letter accumulation (no purge/alert) | Medium | workspace-cleanup, metering |
| Stripe double-billing (no idempotency) | Medium | metering |
| Email provider not implemented | Medium | email-outbox |
| Usage session stays RUNNING after terminate | Medium | workspace-cleanup |
| Leader lock, single writer SPOF | Low | All jobs |
| Stale state detection race conditions | Low | warm-pool, workspace-cleanup |

---

## What This Audit Proves (L0)

- All 7 worker jobs identified with their error handling patterns
- Retry/dead-letter patterns documented for cleanup, metering, email
- External dependency map complete (Proxmox, Stripe, Gateway, DB)
- Failure consequences catalogued per job

## What This Audit Does NOT Prove

- Any failure path actually exercised (except warm-pool CREATING → FAILED, which is L1)
- Dead-letter alerting actually works
- Stripe idempotency gap actually causes double-billing
- Orphan VM detection catches all cases
- Email provider works in any environment
