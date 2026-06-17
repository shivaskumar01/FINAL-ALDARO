# Worker Failure Matrix

**Proof level**: L0 (code review only). Failure paths not exercised except warm-pool CREATING → FAILED (L1).

---

## Failure Scenario Table

| Job | Failure Point | External Dep | Consequence | Recovery Mechanism | Remediated? | Verified? |
|---|---|---|---|---|---|---|
| warm-pool | Find free GPU | Database | Workspace stuck in CREATING | Stale sweeper (>15 min) |, | No |
| warm-pool | Clone VM (Proxmox timeout) | Proxmox | Orphan VM in Proxmox; workspace FAILED | GPU rollback + VM delete in catch |, | Partial (L1) |
| warm-pool | Attach GPU passthrough | Proxmox | VM exists, no GPU; workspace FAILED; GPU rolled back | GPU rollback + VM delete in catch |, | Partial (L1) |
| warm-pool | Start VM | Proxmox | VM configured, never boots; workspace FAILED | GPU rollback + VM delete in catch |, | Partial (L1) |
| warm-pool | GPU alloc + allocation record | Database | GPU ALLOCATED but no allocation record | **REMEDIATED**: atomic $transaction for GPU alloc + allocation create | L0 |
| warm-pool | Agent timeout (>5 min) | Agent/VM | Workspace stuck in WAITING_FOR_AGENT | **REMEDIATED**: sets TERMINATING + enqueues cleanup job (was: FAILED then inline terminate) | L0 |
| warm-pool | Cleanup on provision failure | Proxmox | Console error only; VM persists if delete fails | Best-effort VM delete in catch, orphan if Proxmox unreachable | No |
| warm-pool | terminateWorkspace session close | Database | Session ENDED but no outbox entry (billing leak) | **REMEDIATED**: atomic $transaction for session close + outbox upsert with P2025 guard | L0 |
| workspace-cleanup | Release gateway ports | Gateway | Job retries with backoff; on dead-letter, ports leak | Exponential backoff; incident created |, | Partial |
| workspace-cleanup | Stop/delete VM | Proxmox | Job retries; on dead-letter, VM persists | Exponential backoff; incident created |, | Partial |
| workspace-cleanup | Release GPU | Database | GPU shows ALLOCATED forever | Incident detection auto-fix (checkStuckGpus) |, | Partial |
| workspace-cleanup | Release endpoint ports | Database | Port lease not cleared | Gateway reconcileLeases on startup | **REMEDIATED** (gateway durability) | L1 |
| workspace-cleanup | Finalize usage session | Database | Session stays RUNNING; meter event never enqueued | **REMEDIATED**: atomic session close + outbox in $transaction | L1 (tested) |
| idle-termination | Scan RUNNING workspaces | Database | Workspace not queued | Re-evaluated next tick (1 min delay) |, | Partial |
| idle-termination | Enqueue cleanup job | Database | Transaction fails; workspace stays RUNNING | Manual intervention |, | No |
| metering | Fetch Stripe customer ID | Database | User missing; event FAILED immediately | Dead-letter; incident created |, | Partial |
| metering | Emit meter event to Stripe | Stripe API | Backoff up to 900s; on exhaustion, FAILED | Exponential backoff; incident created |, | Partial |
| metering | Update event status after Stripe success | Database | DB commit fails; duplicate Stripe emission possible | **REMEDIATED**: attemptCount moved into success/failure update | L0 |
| email-outbox | Send email | Email provider | FAILED after 5 immediate attempts | No backoff; provider not implemented |, | No |
| email-outbox | Update email status | Database | Stuck in SENDING state if crash mid-send | Manual reset required |, | No |
| event-retention | Aggregate events | Database | 7–30 day cohort not rolled up | Retried next day |, | Partial |
| event-retention | Delete old events | Database | Old events remain; DB bloat | Retried next day |, | Partial |
| fleet-daily-agg | Query sessions/GPUs | Database | Agg record missing or stale | Backfill retried daily |, | Partial |

---

## Provisioning Phase State Machine

```
spawnWarmWorkspace / provisionColdWorkspace:

Phase 1: DB Setup (no external deps)
  ├── Create workspace record (CREATING)
  └── Allocate GPU + allocation record ($transaction) ← REMEDIATED: atomic

Phase 2: Proxmox Operations (external dep: Proxmox)
  ├── Clone VM from template
  ├── Configure GPU passthrough
  ├── Set cloud-init
  └── Start VM → status: WAITING_FOR_AGENT

Phase 3: Agent Registration (external dep: in-VM agent)
  ├── Poll for VM IP
  ├── Poll for agent heartbeat
  └── On heartbeat: WARM_AVAILABLE or RUNNING_ASSIGNED

FAILURE ROLLBACK per phase:
  Phase 2 failure (catch block):
    1. Set workspace FAILED + error details
    2. Release GPU to FREE + clear currentWorkspaceId
    3. Delete allocation record
    4. Best-effort VM delete (may leave orphan)

  Phase 3 timeout (>5 min):
    1. Set workspace TERMINATING + AGENT_TIMEOUT ← REMEDIATED (was: FAILED)
    2. Enqueue WorkspaceCleanupJob ← REMEDIATED (was: inline terminate)
    3. Cleanup job handles: session finalize, gateway release, VM delete, GPU release
```

---

## Rollback Behavior Per Provision Phase

| Phase | Failure | GPU Rollback | VM Cleanup | Session Cleanup | Endpoint Cleanup |
|---|---|---|---|---|---|
| 1: DB setup | GPU alloc fails | Atomic, both or neither | N/A (no VM yet) | N/A | N/A |
| 2: Clone fails | In catch block | In catch block | N/A (no session) | N/A |
| 2: Config fails | In catch block | In catch block | N/A | N/A |
| 2: Boot fails | In catch block | In catch block | N/A | N/A |
| 3: Agent timeout | Via cleanup job | Via cleanup job | Via cleanup job | Via cleanup job |
| 3: IP never found | Via stale sweeper → cleanup job | Via cleanup job | Via cleanup job | Via cleanup job |

---

## Risk Summary by Job

| Job | Risk Level | Key Gap | Status |
|---|---|---|---|
| warm-pool | **Medium** (was High) | Orphan VMs if Proxmox unreachable during rollback | Session close + agent timeout remediated |
| workspace-cleanup | **Medium** | Dead-letter accumulation, port leak on persistent gateway failure | Session finalize + endpoint remediated |
| idle-termination | **Low** | Simple scan; worst case is delayed cleanup |, |
| workspace-metering | **Medium** | No Stripe idempotency key; dead-letter = lost revenue | attemptCount fix applied |
| email-outbox | **Medium** | Provider not implemented; no backoff |, |
| event-retention | **Low** | DB-only; retried daily |, |
| fleet-daily-agg | **Low** | DB-only; manually recomputable |, |

---

## Remediation Summary

| Fix | File | What changed |
|---|---|---|
| Atomic GPU allocation | warm-pool.ts | GPU status + allocation record wrapped in $transaction |
| Agent timeout → cleanup job | warm-pool.ts | Was: FAILED + inline terminate. Now: TERMINATING + enqueue cleanup job |
| Session close atomicity (terminateWorkspace) | warm-pool.ts | Was: session update only. Now: $transaction with session + outbox upsert + P2025 guard |
| Session close atomicity (cleanup job) | workspace-cleanup.ts | Same pattern, done in workstream 1 |
| Metering attemptCount | workspace-metering.ts | Moved increment into success/failure handler, done in workstream 1 |

---

## Unverified Recovery Paths (must be proven in staging)

1. Warm-pool provision cleanup actually deletes orphan VM on Proxmox failure
2. Workspace-cleanup dead-letter incident triggers external alert
3. Metering dead-letter incident triggers external alert
4. Gateway port release retry actually recovers leaked ports
5. Stuck GPU detection (checkStuckGpus) correctly identifies and fixes allocation
6. Email outbox works with real SMTP/SES provider
7. Agent timeout → cleanup job path completes full resource release
