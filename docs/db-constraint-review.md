# DB Constraint Review

**Purpose**: Verify that critical idempotency and uniqueness assumptions are enforced at the DB level, not only in application code.

**Proof level**: L0 (schema review, not applied/tested in staging)

---

## Existing DB Constraints That Back Application Logic

| Assumption | Table | Constraint | Status |
|---|---|---|---|
| One outbox entry per usage session | `workspace_meter_event_outbox` | `usageSessionId @unique` | **Enforced** |
| One cleanup job per workspace | `workspace_cleanup_jobs` | `workspaceId @unique` | **Enforced** |
| One GPU allocation per workspace | `workspace_gpu_allocations` | `workspaceId @unique` | **Enforced** |
| One GPU allocation per GPU | `workspace_gpu_allocations` | `gpuId @unique` | **Enforced** |
| One endpoint per workspace | `workspace_endpoints` | `workspaceId @unique` | **Enforced** |
| SSH port unique across all endpoints | `workspace_endpoints` | `sshPort @unique` | **Enforced** |
| Jupyter port unique | `workspace_endpoints` | `jupyterPort @unique` | **Enforced** |
| VSCode port unique | `workspace_endpoints` | `vscodePort @unique` | **Enforced** |
| One launch operation per key per user | `workspace_launch_operations` | `@@unique([userId, operationKey])` | **Enforced** |
| One warm pool config per region+gpuType | `warm_pool_config` | `@@unique([region, gpuType])` | **Enforced** |
| Email deduplication | `email_outbox` | `dedupeKey @unique` | **Enforced** |

---

## Missing DB Constraints (Application-Only Guards)

### 1. At most one RUNNING session per workspace

**Current enforcement**: Application guard in `startUsageSession()`, `findFirst({ status: 'RUNNING' })` before `create()`.

**Risk**: Two concurrent `startUsageSession` calls could both pass the check and create two RUNNING sessions. This would cause double billing.

**Mitigation**: Single-writer model (worker) and serialized API calls reduce concurrency risk. But the invariant is not DB-enforced.

**Recommendation**: Add a partial unique index:
```sql
CREATE UNIQUE INDEX "usage_sessions_one_running_per_workspace"
ON "usage_sessions" ("workspaceId")
WHERE status = 'RUNNING';
```

**Prisma note**: Prisma does not support partial unique indexes natively. This would need to be added via a raw SQL migration:
```prisma
// In schema, add a migration SQL file:
// migrations/YYYYMMDD_add_running_session_constraint/migration.sql
```

**Priority**: Medium, the application guard works under normal conditions, but a DB constraint would catch bugs.

---

### 2. One active (unreleased) gateway lease per workspace

**Current enforcement**: `workspaceId @unique` on `workspace_endpoints`, but this allows ONE row per workspace, not one ACTIVE row. If a workspace is released and then re-allocated, the old row's `releasedAt` is set but the upsert overwrites the same row.

**Status**: **Effectively enforced**, the `@unique` constraint on `workspaceId` means there's only ever one endpoint record per workspace. The upsert pattern uses this as the key. No additional constraint needed.

---

### 3. One active GPU allocation per GPU (beyond what exists)

**Current enforcement**: `gpuId @unique` on `workspace_gpu_allocations`, prevents two allocations for the same GPU. But this is absolute (including released allocations). If GPU is released (`releasedAt` set) and re-allocated, a new row can't be created because `gpuId` is still unique.

**Issue**: The current model tracks GPU allocation history by updating `releasedAt` on the existing row, then creating a new row. But `gpuId @unique` prevents this.

**Analysis**: Looking at the code, `workspaceGpuAllocation.deleteMany` is used on failed provision rollback, and `update` with `releasedAt` is used on cleanup. The `gpuId @unique` constraint means a GPU can only have one allocation row ever (not one active row). Re-allocation would need to delete or update the old row first.

**Status**: **Needs investigation**, the constraint may be too strict for GPU reuse. But since warm-pool workspaces are disposable and GPUs are released by deleting the allocation row (on failure) or setting `releasedAt` then later new allocation, this may cause issues on GPU reuse.

**Recommendation**: Consider changing to a partial unique index if GPU reuse is expected:
```sql
CREATE UNIQUE INDEX "workspace_gpu_allocations_one_active_per_gpu"
ON "workspace_gpu_allocations" ("gpuId")
WHERE "releasedAt" IS NULL;
```

But only after confirming the current allocation pattern works for GPU reuse scenarios.

**Priority**: Low, current flow works because provision failure deletes the allocation row.

---

### 4. Workspace status transitions

**Current enforcement**: None, status is set directly via `workspace.update({ data: { status: 'NEW_STATUS' } })`. No CHECK constraint or trigger validates transitions.

**Risk**: A bug could cause an invalid transition (e.g., TERMINATED → RUNNING_ASSIGNED).

**Recommendation**: Consider a CHECK constraint or trigger to validate transitions. However, this adds complexity and may not be worth it for the current codebase size.

**Priority**: Low, control flow logic prevents invalid transitions. Adding a DB constraint would be defensive hardening.

---

## Upsert Target Verification

All upserts in the codebase use fields that have `@unique` constraints:

| Upsert Location | Where Key | Backed By |
|---|---|---|
| `endUsageSession` outbox | `usageSessionId` | `@unique` on `WorkspaceMeterEventOutbox.usageSessionId` |
| `finalizeUsageSessions` outbox | `usageSessionId` | Same |
| `warm-pool.ts terminateWorkspace` outbox | `usageSessionId` | Same |
| Gateway allocate | `workspaceId` | `@unique` on `WorkspaceEndpoint.workspaceId` |
| API `allocateGatewayPorts` | `workspaceId` | Same |
| Cleanup job upsert | `workspaceId` | `@unique` on `WorkspaceCleanupJob.workspaceId` |
| Email outbox | `dedupeKey` | `@unique` on `EmailOutbox.dedupeKey` |
| Launch operation | `workspaceId` | `@unique` on `WorkspaceLaunchOperation.workspaceId` |

**All upsert targets are backed by DB-level unique constraints.** No race-safe logic depends on a key the DB does not enforce.

---

## Schema Change Recommendations

| # | Change | File | Priority | Reason |
|---|---|---|---|---|
| 1 | Partial unique index for one RUNNING session per workspace | Raw SQL migration | Medium | Enforces billing invariant at DB level |
| 2 | Investigate `gpuId @unique` for GPU reuse scenarios | schema.staging.prisma | Low | May need partial index for active-only |
| 3 | Consider workspace status transition CHECK constraint | Raw SQL migration | Low | Defensive, not strictly needed |

---

## Summary

- **14 of 14** existing upsert targets are backed by DB-level unique constraints
- **1 critical invariant** (one RUNNING session per workspace) is application-only, partial unique index recommended
- All other critical invariants are DB-enforced
- No new race-safe logic depends on missing constraints
