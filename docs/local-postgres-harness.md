# Local Postgres Harness

Guide for using local PostgreSQL as a staging-like validation environment.

---

## What This Harness Simulates

| Capability | Simulated? | Notes |
|---|---|---|
| Postgres schema and data model | Yes | Same schema as staging |
| Advisory locks (worker leader) | Yes | Postgres-specific, verified locally |
| Prisma ORM behavior on Postgres | Yes | Generates Postgres-native queries |
| Transaction boundaries | Yes | Same isolation as staging |
| Multi-service stack | Partially | API + worker + gateway can all run, but external calls fail |
| Proxmox provisioning | No | Fails at API boundary |
| Stripe billing | No | Fails at API boundary |
| Gateway port allocation | Yes (local) | In-memory, single-process |
| Network conditions | No | All localhost |

---

## Setup

### Prerequisites
- PostgreSQL 15+ running locally
- npm dependencies installed
- `schema.staging.prisma` exists (Postgres provider)

### Quick Start

```bash
# One-command reset (drops DB, applies schema, seeds)
./scripts/reset-local-postgres.sh
```

### Manual Setup

```bash
# 1. Install Postgres
brew install postgresql@15
brew services start postgresql@15

# 2. Create user and database
createuser aldaro -s 2>/dev/null
createdb aldaro_staging -O aldaro 2>/dev/null

# 3. Apply schema
DATABASE_URL="postgresql://aldaro:aldaro_staging_local@localhost:5432/aldaro_staging" \
  npx prisma db push --schema packages/db/prisma/schema.staging.prisma

# 4. Generate client
DATABASE_URL="postgresql://aldaro:aldaro_staging_local@localhost:5432/aldaro_staging" \
  npx prisma generate --schema packages/db/prisma/schema.staging.prisma

# 5. Seed
DATABASE_URL="postgresql://aldaro:aldaro_staging_local@localhost:5432/aldaro_staging" \
  npx tsx packages/db/prisma/seed.ts
```

---

## DB Engine Differences: SQLite vs Postgres

### Known Differences

| Behavior | SQLite | Postgres | Impact |
|---|---|---|---|
| Advisory locks | Not available | `pg_try_advisory_lock` | Worker cannot run on SQLite |
| Column names in raw SQL | camelCase (same) | camelCase (Prisma default) | Must quote: `"gpuType"` not `gpu_type` |
| Decimal type | Stored as text | `numeric(65,30)` | Sorting/comparison may differ |
| BigInt serialization | Text | `bigint` | `Artifact.bytes` field |
| Transaction isolation | Serializable (WAL) | Read Committed (default) | Race conditions may differ |
| LIKE operator | Case-insensitive | Case-sensitive | Use `ILIKE` on Postgres |
| Boolean type | Integer (0/1) | Boolean | Prisma abstracts this |
| Timestamp precision | Text | `timestamp(3)` | Microsecond precision differs |
| Auto-increment | `AUTOINCREMENT` | `SERIAL` | Prisma abstracts this |

### Raw SQL Sites (Postgres-Specific)

All raw SQL is in the worker. These are Postgres-only:

| File | Query | Purpose |
|---|---|---|
| `worker/src/index.ts` | `$queryRaw: SELECT pg_try_advisory_lock(...)` | Leader election |
| `worker/src/index.ts` | `$queryRaw: SELECT pg_advisory_unlock(...)` | Leader release |

No other `$queryRaw` or `$executeRaw` calls exist in the codebase (to be confirmed by worker audit agent).

### camelCase Column Names

Prisma generates Postgres columns in camelCase (matching the schema model fields). Table names use `@@map` to snake_case. When writing raw SQL against Postgres:

```sql
-- WRONG (snake_case columns)
SELECT gpu_type, status FROM fleet_gpus;

-- CORRECT (camelCase, quoted)
SELECT "gpuType", status FROM fleet_gpus;
```

---

## Seed Idempotency

The current `seed.ts` script uses `upsert` for some records and `create` for others.

| Table | Idempotent? | Notes |
|---|---|---|
| Users | Likely (upsert by email) | Needs verification |
| Fleet Nodes | Likely (upsert by name) | Needs verification |
| Fleet GPUs | Unknown | May fail on duplicate PCI address |
| VM Templates | Unknown | May fail on duplicate name |
| GPU SKUs | Likely (upsert by key) | Needs verification |
| Warm Pool Config | Unknown | May fail on duplicate region+gpuType |

**Recommendation**: Use `./scripts/reset-local-postgres.sh` for a clean reset rather than re-running seed on existing data.

---

## Multi-Service Local Stack

### Start Order
1. **Gateway**: `cd apps/gateway && GATEWAY_PORT=5051 GATEWAY_HOST=localhost GATEWAY_SERVICE_SECRET=dev-secret-32chars npm run dev`
2. **API**: `cd apps/api && DATABASE_URL="postgresql://..." npm run dev`
3. **Worker**: `cd worker && DATABASE_URL="postgresql://..." npm run dev`

### Shared Secrets
These must be identical across services:
- `GATEWAY_SERVICE_SECRET`: API, Worker, Gateway
- `ALDARO_AGENT_SHARED_SECRET`: API, Worker
- `DATABASE_URL`: API, Worker

### What Works
- API health endpoint
- API public endpoints (GPU SKUs)
- Gateway health endpoint
- Gateway allocate/release (with valid HMAC)
- Worker leader lock acquisition
- Worker tick scheduling
- Warm pool tick (up to Proxmox boundary)

### What Fails (Expected)
- Workspace provisioning (no Proxmox)
- Stripe meter emission (no real Stripe keys)
- VM status checks (no VMs exist)
- Agent registration (no agent running)
- End-to-end workspace lifecycle

---

## Transaction Boundaries on Critical Writes

These write paths have transactional implications:

### Launch Operation
- `workspaceService.ts`: Creates WorkspaceLaunchOperation + Workspace in sequence (not a single transaction)
- Risk: Operation created but workspace creation fails → orphan operation record
- Mitigation: Idempotency key prevents duplicate launches

### Warm Pool Provisioning
- `warm-pool.ts`: Creates workspace → allocates GPU → creates allocation → calls Proxmox
- Risk: GPU allocated in DB but Proxmox clone fails → must rollback GPU
- Current handling: catch block rolls back GPU and deletes allocation (locally verified)

### Terminate/Cleanup
- `workspace-cleanup.ts`: Updates workspace status → releases resources → calls gateway/Proxmox
- Risk: Status updated to TERMINATED but gateway release fails → leaked port
- Current handling: Retry with backoff, incident on exhaustion

### Usage Session Closure
- Closes session → calculates billing → creates outbox record
- Risk: Session closed but outbox creation fails → no Stripe emission
- Current handling: Needs verification (billing audit in progress)

---

## Useful DB Inspection Queries

```sql
-- Stale state dashboard
SELECT status, COUNT(*), MIN("updatedAt") as oldest
FROM workspaces
WHERE status NOT IN ('TERMINATED', 'FAILED')
GROUP BY status;

-- GPU allocation consistency
SELECT g."gpuType", g.status, g."currentWorkspaceId",
       w.status as ws_status
FROM fleet_gpus g
LEFT JOIN workspaces w ON g."currentWorkspaceId" = w.id;

-- Cleanup backlog
SELECT status, COUNT(*), AVG("attemptCount")::int as avg_attempts
FROM workspace_cleanup_jobs
GROUP BY status;

-- Metering backlog
SELECT status, COUNT(*), AVG("attemptCount")::int as avg_attempts
FROM workspace_meter_event_outbox
GROUP BY status;

-- Orphan endpoint check
SELECT e.id, e."workspaceId", e."releasedAt", w.status as ws_status
FROM workspace_endpoints e
JOIN workspaces w ON e."workspaceId" = w.id
WHERE e."releasedAt" IS NULL
  AND w.status IN ('TERMINATED', 'FAILED');

-- Usage session integrity
SELECT us.id, us."workspaceId", us.status as session_status,
       w.status as ws_status, us."totalSeconds", us."billedCents"
FROM usage_sessions us
JOIN workspaces w ON us."workspaceId" = w.id
WHERE us.status = 'RUNNING' AND w.status IN ('TERMINATED', 'FAILED');
```

---

## Limitations

This harness validates:
- Schema correctness on Postgres
- Worker startup path through advisory lock
- Transaction behavior on Postgres
- Seed data correctness
- Basic multi-service connectivity

This harness does NOT validate:
- Real VM provisioning
- Real billing emission
- Real gateway port forwarding
- Network failure handling
- Concurrency under load
- Clock skew between services
- Postgres-specific edge cases under production load

All findings from this harness are **L1 (local proof)** per the proof-levels model.
