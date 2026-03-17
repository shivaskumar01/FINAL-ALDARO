# Cleanup Durability Matrix

**Proof level**: L0 (code review). No scenarios exercised in a real environment yet.

---

## Purpose

Maps every stale/orphan state a workspace can reach, what the sweeper or cleanup job does about it, and what resources leak if cleanup itself fails.

---

## Stale-State Scenarios

### 1. CREATING stuck >15 minutes

**How it happens**: Worker begins provisioning (GPU alloc, VM clone, boot) but crashes or Proxmox hangs mid-flow. Workspace stays CREATING with no further progress.

| Resource | Current state | Sweeper action | Cleanup job action | Leak if cleanup exhausts |
|---|---|---|---|---|
| Workspace | status=CREATING, updatedAt stale | Sets TERMINATING, enqueues cleanup job | Runs standard cleanup path | Stuck in TERMINATING until incident |
| FleetGpu | ALLOCATED, currentWorkspaceId set | — | Released to FREE | GPU locked permanently |
| VM (Proxmox) | May exist partially | — | stopVm + deleteVm (best-effort) | Orphan VM on Proxmox node |
| WorkspaceGpuAllocation | Exists, no releasedAt | — | releasedAt set | Stale allocation record |
| WorkspaceEndpoint | May not exist | — | releasedAt set (if exists) | No leak (never created) |
| UsageSession | May not exist | — | Finalized (if exists) | Possible leaked RUNNING session |
| Gateway ports | May not be allocated | — | Release call (if allocated) | Port leak in gateway |

**Verification query**:
```sql
SELECT id, status, "updatedAt", "proxmoxNode", "proxmoxVmid"
FROM workspaces
WHERE status = 'CREATING' AND "updatedAt" < NOW() - INTERVAL '15 minutes';
```

---

### 2. TERMINATING stuck >10 minutes (no cleanup job)

**How it happens**: API sets TERMINATING and enqueues a cleanup job, but the job row is lost (DB error between status update and job insert — not transactional today) or the job itself is missing.

| Resource | Current state | Sweeper action | Cleanup job action | Leak if cleanup exhausts |
|---|---|---|---|---|
| Workspace | status=TERMINATING | Upserts cleanup job (re-creates if missing) | Runs standard cleanup path | Stuck until incident |
| FleetGpu | ALLOCATED | — | Released to FREE | GPU locked |
| VM | Running or stopped | — | stopVm + deleteVm | Orphan VM |
| WorkspaceEndpoint | Active | — | releasedAt set | Port leak |
| UsageSession | RUNNING | — | Finalized atomically | Billing leak (RUNNING forever) |
| MeterOutbox | Not yet created | — | Created via session finalize | Revenue leak |

**Verification query**:
```sql
SELECT w.id, w.status, w."updatedAt",
  (SELECT COUNT(*) FROM workspace_cleanup_jobs j WHERE j."workspaceId" = w.id AND j.status NOT IN ('DONE', 'FAILED')) AS active_jobs
FROM workspaces w
WHERE w.status = 'TERMINATING' AND w."updatedAt" < NOW() - INTERVAL '10 minutes';
```

---

### 3. RUNNING_ASSIGNED with no active usage session

**How it happens**: `startUsageSession` fails after workspace reaches RUNNING_ASSIGNED (Prisma error, GpuSku not found returns $0 but session is still created — unless the create itself fails).

| Resource | State | Expected sweeper action | Actual sweeper action | Gap |
|---|---|---|---|---|
| UsageSession | Missing | Should exist for billing | None — no sweeper checks for this | **Gap: unbilled running workspace** |

**Mitigation**: The idle-termination tick could cross-check: for every RUNNING_ASSIGNED workspace, verify a RUNNING UsageSession exists. If not, create one or flag an incident.

**Verification query**:
```sql
SELECT w.id, w."assignedUserId"
FROM workspaces w
LEFT JOIN usage_sessions s ON s."workspaceId" = w.id AND s.status = 'RUNNING'
WHERE w.status = 'RUNNING_ASSIGNED' AND s.id IS NULL;
```

---

### 4. ENDED session with no meter outbox entry

**How it happens**: Pre-remediation code closed session and outbox enqueue in separate calls. After remediation, this is atomic — but old data may have orphaned sessions.

| Resource | State | Expected | Actual | Gap |
|---|---|---|---|---|
| UsageSession | ENDED | Should have a MeterOutbox row | May be missing for pre-fix sessions | **Gap: revenue leak for historical sessions** |

**Verification query**:
```sql
SELECT s.id, s."workspaceId", s."billedCents"
FROM usage_sessions s
LEFT JOIN workspace_meter_event_outbox o ON o."usageSessionId" = s.id
WHERE s.status = 'ENDED' AND o.id IS NULL;
```

**Backfill action**: For any rows returned, manually create PENDING outbox entries.

---

### 5. GPU stuck in ALLOCATED with TERMINATED/FAILED workspace

**How it happens**: Cleanup job releases GPU but crashes between GPU update and workspace status update, or cleanup exhausts retries before reaching GPU release step.

| Resource | State | Sweeper action | Gap |
|---|---|---|---|
| FleetGpu | ALLOCATED, currentWorkspaceId → terminated WS | `checkStuckGpus` in worker tick releases it | **Partial**: only if `checkStuckGpus` exists and runs |

**Verification query**:
```sql
SELECT g.id, g.status, g."currentWorkspaceId", w.status AS ws_status
FROM fleet_gpus g
JOIN workspaces w ON w.id = g."currentWorkspaceId"
WHERE g.status = 'ALLOCATED' AND w.status IN ('TERMINATED', 'FAILED');
```

---

### 6. WorkspaceEndpoint active with no matching workspace (or terminated workspace)

**How it happens**: Gateway allocates ports and writes DB, but workspace is terminated without the cleanup job reaching the endpoint release step.

| Resource | State | Sweeper action | Gap |
|---|---|---|---|
| WorkspaceEndpoint | releasedAt IS NULL | Gateway reconcileLeases on startup cleans stale | Only works on gateway restart; no periodic sweep |

**Verification query**:
```sql
SELECT e.id, e."workspaceId", e."sshPort", e."jupyterPort"
FROM workspace_endpoints e
LEFT JOIN workspaces w ON w.id = e."workspaceId"
WHERE e."releasedAt" IS NULL AND (w.id IS NULL OR w.status IN ('TERMINATED', 'FAILED'));
```

---

### 7. Cleanup job in FAILED (dead-letter) state

**How it happens**: Cleanup job exhausts `maxAttempts` (default 20). Workspace stays TERMINATING, resources may be partially released.

| Resource | State | Action taken | Gap |
|---|---|---|---|
| Incident | Created with severity HIGH | Alerts operator | No automated external alert (Slack/PagerDuty) yet |
| Workspace | TERMINATING forever | None | Requires manual resolution |
| All sub-resources | Partially released | Depends on which step failed | Manual audit needed per workspace |

**Verification query**:
```sql
SELECT j.id, j."workspaceId", j."attemptCount", j."lastErrorCode", j."lastErrorMessage"
FROM workspace_cleanup_jobs j
WHERE j.status = 'FAILED';
```

---

### 8. Concurrent terminate requests for same workspace

**How it happens**: User clicks terminate twice rapidly, or API + idle-termination worker both fire at the same time.

| Risk | Mitigation | Status |
|---|---|---|
| Double cleanup job | `workspaceCleanupJob` has `@unique` on `workspaceId` — upsert prevents duplicates | **Mitigated** |
| Double session close | `WHERE status: 'RUNNING'` + P2025 catch prevents double-close | **Mitigated** (post-remediation) |
| Double GPU release | Second release sees GPU already FREE — no-op in code | **Mitigated** |
| Double Proxmox delete | `doesNotExist` error caught and swallowed | **Mitigated** |

---

## Cleanup Step Ordering & Partial Failure

The cleanup job runs steps sequentially. If it fails mid-way, earlier steps are already committed. On retry, those steps are idempotent:

| Step | Order | Idempotent on retry? | Notes |
|---|---|---|---|
| Finalize usage sessions | 1 | Yes | WHERE status: 'RUNNING' + P2025 catch |
| Release gateway ports | 2 | Yes | Gateway release is idempotent |
| Stop VM | 3 | Yes | Already-stopped VM returns success |
| Delete VM | 4 | Yes | "does not exist" error swallowed |
| Release GPU | 5 | Yes | Could fail if GPU already FREE (needs guard) |
| Release endpoints | 6 | Yes | updateMany is idempotent |
| Set TERMINATED | 7 | Yes | Final status write |

**Gap in step 5**: `fleetGpu.update` at line 192 sets `status: 'FREE'` unconditionally. If GPU is already FREE (from a prior partial cleanup), this succeeds harmlessly. But if the GPU record doesn't exist (deleted node), it would throw. This is unlikely but not guarded.

---

## Summary of Gaps Found

| # | Gap | Severity | Type | Remediation |
|---|---|---|---|---|
| G1 | No check for RUNNING_ASSIGNED workspace missing UsageSession | Medium | Code issue | Add cross-check in idle-termination tick |
| G2 | Historical ENDED sessions may lack outbox entries (pre-fix) | Low | Local-only untested | One-time backfill query |
| G3 | No periodic sweep for stale WorkspaceEndpoints (only gateway restart) | Low | Code issue | Add endpoint sweep to worker tick |
| G4 | Dead-letter incidents have no external alert integration | Medium | Real-infra-only | Wire incidents to Slack/PagerDuty |
| G5 | GPU release in cleanup not guarded against missing GPU record | Low | Code issue | Add try-catch around GPU release |
| G6 | Terminate handler + cleanup job creation not atomic | Medium | Code issue | Already wrapped in $transaction in workspaceService.ts:terminate |

---

## Local Verification Evidence (2026-03-13)

### Scenarios Exercised

| Scenario | Initial State | Action | Final State | Verified |
|---|---|---|---|---|
| Stale CREATING (>15 min) | CREATING, updatedAt 20 min ago | Sweeper logic | TERMINATING + cleanup job PENDING | **Yes** |
| Stale TERMINATING (>10 min, no job) | TERMINATING, updatedAt 15 min ago | Sweeper logic | Cleanup job PENDING enqueued | **Yes** |
| TERMINATING with RUNNING session | TERMINATING + 1 RUNNING session (2hrs, $1.50/hr) | finalizeUsageSessions | Session ENDED (billedCents=1354) + outbox PENDING | **Yes** |
| TERMINATED with orphan endpoint | TERMINATED + endpoint (releasedAt NULL) | reconcileLeases pattern | Endpoint released (releasedAt set) | **Yes** |

### Post-Exercise State

| Check | Expected | Actual |
|---|---|---|
| RUNNING sessions on cleanup-test workspaces | 0 | **0** |
| Orphan endpoints on terminal workspaces | 0 | **0** |
| Cleanup jobs created | 3 (one per non-terminal workspace) | **3** |
| ENDED sessions with outbox entry | 1 | **1** (session 90e22174, billedCents=1354) |
| Billing leak (ENDED without outbox) | 0 | **0** |

### Scenarios NOT Exercised (require real infrastructure)

| Scenario | Why |
|---|---|
| Worker restart during cleanup job | Needs running worker with Proxmox connection |
| Repeated sweeper pass (second pass is no-op) | Exercised in concept (upsert is idempotent) but not with real worker tick |
| Cleanup job FAILED → incident creation | Needs cleanup job to exhaust retries against real Proxmox |
| GPU stuck in ALLOCATED with TERMINATED workspace | Needs real GPU allocation data |
| Concurrent terminate + cleanup race | Tested in billing tests (P2025 safe), but not full cleanup job race |

---

## Recommended Verification Sequence (staging)

1. Run all verification queries above against staging DB
2. Confirm zero results for queries 1, 2, 3, 5, 6 (no stale state)
3. Confirm query 4 returns zero (no billing leak)
4. Confirm query 7 returns zero (no dead-letter jobs)
5. Force-fail a cleanup job and verify incident is created
6. Force a stale CREATING workspace and verify sweeper picks it up within 15 min
7. Force concurrent terminate and verify no duplicate cleanup jobs
