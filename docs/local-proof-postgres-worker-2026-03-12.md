# Local Proof: Postgres-Backed Worker Startup

**Date**: 2026-03-12
**Environment**: macOS (Darwin 25.0.0, aarch64), local only
**Scope**: Worker startup against local Postgres, up to external infrastructure boundary

---

## 1. Postgres Install

- **Version**: PostgreSQL 15.17 (Homebrew) on aarch64-apple-darwin25.2.0
- **User**: `aldaro`
- **Database**: `aldaro_staging`
- **Connection**: `postgresql://aldaro:***@localhost:5432/aldaro_staging`

## 2. Schema Apply

- **Method**: `npx prisma db push --schema packages/db/prisma/schema.staging.prisma`
- **Provider**: `postgresql` (via `schema.staging.prisma` overlay)
- **Result**: 37 tables created successfully
- **Tables verified**: `\dt` returns full table list including workspaces, fleet_nodes, fleet_gpus, vm_templates, gpu_skus, usage_sessions, incidents, workspace_cleanup_jobs, workspace_meter_event_outbox

## 3. Seed Result

- **Method**: `DATABASE_URL="postgresql://..." npx tsx packages/db/prisma/seed.ts`
- **Verified records**:

| Table | Count | Key data |
|---|---|---|
| users | 3 | shivas@aldaro.ai (AUTHOR), integration-test@aldaro.ai (CUSTOMER), test@aldaro.ai (CUSTOMER) |
| fleet_nodes | 2 | pve-node-01 (ACTIVE), pve-node-02 (ACTIVE) |
| fleet_gpus | 2 | RTX_5090 FREE, A100_80GB FREE |
| vm_templates | 2 | aldaro-base-rtx5090-v1 (vmid 9000), aldaro-base-a100-v1 (vmid 9001) |
| gpu_skus | 2 | RTX_5090 ($0.55/hr), A100_80GB ($2.49/hr) |

## 4. Worker Startup Log

```
============================================================
Aldaro Worker Service Started
Worker ID: worker-62afe756
Infrastructure: Aldaro Fleet (Proxmox)
External providers: DISABLED
============================================================
Proxmox connection validated
Attempting to acquire leader lock...
Acquired leader lock (fencing token: ec6ae201...)
Warm pool tick interval: 30000ms
Idle termination tick interval: 60000ms
Incident detection tick interval: 30000ms
```

**Note on "Proxmox connection validated"**: This line means the worker found the required Proxmox env vars and constructed the API client. It does NOT mean a real Proxmox API call succeeded. Real Proxmox connectivity is unproven.

## 5. Advisory Lock Acquisition

- Worker called `pg_try_advisory_lock` via `$queryRaw` against Postgres
- Lock acquired successfully (fencing token generated)
- This is the operation that fails on SQLite, confirming the Postgres path works locally

## 6. Warm-Pool Tick, Clone Boundary

The worker's first warm-pool tick:
1. Found warm pool config: 1x RTX_5090 in US
2. Found free GPU: RTX_5090 on pve-node-01
3. Created workspace record in DB (id: `02e7aea9`, status: CREATING, isWarmPool: true)
4. Allocated GPU (status → ALLOCATED)
5. Created WorkspaceGpuAllocation record
6. Attempted Proxmox clone: `POST /nodes/pve-node-01/qemu/9000/clone`
7. **Failed**: `ENOTFOUND placeholder.local`, expected, no real Proxmox

This is the external infrastructure boundary. Everything before step 6 is locally proven. Step 6 and beyond require real Proxmox.

## 7. Failure Path Behavior

After the clone call failed, the worker's catch block executed:

| Action | Result | Verified |
|---|---|---|
| Workspace status → FAILED | Yes | `status = 'FAILED'`, `failedAt = 2026-03-12 08:34:46` |
| lastErrorCode recorded | Yes | `ENOTFOUND` |
| lastErrorMessage recorded | Yes | `getaddrinfo ENOTFOUND placeholder.local` (truncated to 500 chars) |
| GPU rolled back to FREE | Yes | Both GPUs show `status = 'FREE'`, `failureCount = 0` |
| WorkspaceGpuAllocation deleted | Yes | 0 rows in table |
| VM cleanup attempted | Yes (failed silently, no VM to delete) | Expected |
| Usage session created? | No | 0 rows, correct, no session should exist for a failed provision |
| Incident created? | No | 0 rows, correct, single provision failure doesn't trigger incident |
| Cleanup job created? | No | 0 rows, correct, FAILED workspace doesn't need async cleanup |
| Meter outbox created? | No | 0 rows, correct, no billing for failed workspace |
| Workspace endpoints? | 0 rows | Correct, no ports allocated |

**Assessment**: The warm-pool failure path handled the Proxmox clone error cleanly at the local level. The workspace was marked FAILED with error details, the GPU was rolled back, no orphan records were left. This is locally consistent behavior. Whether this same path handles all real-world failure modes (timeouts, partial clones, network interruptions mid-provision) is still unproven.

## 8. Clean Shutdown

```
Shutting down worker...
Released leader lock
```

- Worker released the advisory lock on SIGTERM
- Process exited cleanly

## 9. Post-Run DB State

| Table | Rows | State |
|---|---|---|
| workspaces | 1 | FAILED (warm-pool attempt) |
| fleet_gpus | 2 | Both FREE |
| workspace_gpu_allocations | 0 | Rolled back |
| workspace_endpoints | 0 | None allocated |
| usage_sessions | 0 | None created |
| incidents | 0 | None created |
| workspace_cleanup_jobs | 0 | None created |
| workspace_meter_event_outbox | 0 | None created |

---

## What This Proves (Local Only)

- Local Postgres is installed and the Prisma schema applies successfully
- Seed data loads correctly into Postgres
- The worker starts against Postgres and acquires the advisory lock
- The leader-lock pattern works locally with Postgres
- Worker tick scheduling (warm pool, idle termination, incident detection) initializes correctly
- Warm-pool logic advances through GPU selection, workspace creation, GPU allocation, and reaches the Proxmox clone call
- The warm-pool failure path rolls back GPU allocation and marks workspace FAILED with error details
- No orphan records are left after a provision failure
- Clean shutdown releases the advisory lock

## What This Does NOT Prove

- Real Proxmox connectivity or VM provisioning
- Real gateway port allocation or release
- Real Stripe meter event emission
- End-to-end workspace lifecycle (create → run → terminate)
- Behavior under real network failures, timeouts, or partial operations
- Billing parity, terminate recovery, contention, or any of the 7 proof scenarios
- Multi-tick behavior (only one tick was observed before shutdown)
- Incident detection or cleanup reconciliation under real failure conditions
