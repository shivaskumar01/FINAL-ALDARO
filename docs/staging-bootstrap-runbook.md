# Staging Bootstrap Runbook

Step-by-step guide to bring staging from zero to preflight-passing.

## Prerequisites

### Infrastructure Required
- [ ] Proxmox host with IOMMU enabled and GPUs available for passthrough
- [ ] PostgreSQL 15+ instance accessible from staging host
- [ ] Node.js 18+ on staging host
- [ ] Network: staging host can reach Proxmox API (port 8006) and Postgres (port 5432)
- [ ] Network: gateway host can reach tenant VM internal IPs
- [ ] VM template(s) prepared on Proxmox (see PREFLIGHT_CHECKLIST.md section 2)

### Accounts Required
- [ ] Proxmox API token created (Datacenter > Permissions > API Tokens)
- [ ] Stripe test-mode account with customer, payment method, and `gpu_seconds` meter
- [ ] DNS or /etc/hosts entries for staging services (or use IP:port directly)

---

## Phase 1: Database

### 1.1 Create Postgres database

```bash
psql -h <db-host> -U postgres -c "CREATE USER aldaro WITH PASSWORD '<strong-password>';"
psql -h <db-host> -U postgres -c "CREATE DATABASE aldaro_staging OWNER aldaro;"
psql -h <db-host> -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE aldaro_staging TO aldaro;"
```

### 1.2 Create staging Prisma schema

```bash
cd packages/db
cp prisma/schema.prisma prisma/schema.staging.prisma
```

Edit `prisma/schema.staging.prisma`:
```diff
 datasource db {
-  provider = "sqlite"
+  provider = "postgresql"
   url      = env("DATABASE_URL")
 }
```

### 1.3 Push schema to Postgres

```bash
export DATABASE_URL="postgresql://aldaro:<password>@<db-host>:5432/aldaro_staging"
npx prisma db push --schema prisma/schema.staging.prisma
npx prisma generate --schema prisma/schema.staging.prisma
```

### 1.4 Verify database

```bash
psql -h <db-host> -U aldaro -d aldaro_staging -c "\dt"
# Should list all tables: users, workspaces, fleet_nodes, fleet_gpus, etc.
```

---

## Phase 2: Secrets

### 2.1 Generate all secrets

```bash
echo "JWT_ACCESS_SECRET=$(openssl rand -base64 48)"
echo "JWT_REFRESH_SECRET=$(openssl rand -base64 48)"
echo "ALDARO_AGENT_SHARED_SECRET=$(openssl rand -hex 32)"
echo "GATEWAY_SERVICE_SECRET=$(openssl rand -hex 32)"
```

### 2.2 Collect external credentials

- Proxmox: `PROXMOX_API_URL`, `PROXMOX_API_TOKEN_ID`, `PROXMOX_API_TOKEN_SECRET`
- Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PUBLISHABLE_KEY`

### 2.3 Create env files

Create `.env` files for each service using templates from `docs/staging-env-templates.md`.

Verify cross-service consistency:
```bash
# These must be identical across services:
# GATEWAY_SERVICE_SECRET: API, Worker, Gateway
# ALDARO_AGENT_SHARED_SECRET: API, Worker
# DATABASE_URL: API, Worker
# JWT_ACCESS_SECRET: API, Web
```

---

## Phase 3: Seed Data

### 3.1 Seed fleet inventory

Use the seed spec from `docs/staging-fleet-seed-spec.md`.

Either run a seed script or insert directly:

```bash
# Option A: Use seed script (when staging seed script exists)
DATABASE_URL="postgresql://..." npx tsx packages/db/prisma/seed-staging.ts

# Option B: Insert via Prisma Studio
DATABASE_URL="postgresql://..." npx prisma studio --schema packages/db/prisma/schema.staging.prisma
```

### 3.2 Verify seed data

```bash
psql -h <db-host> -U aldaro -d aldaro_staging <<'SQL'
SELECT name, status FROM fleet_nodes;
SELECT gpu_type, pci_address, status FROM fleet_gpus;
SELECT name, template_vmid, gpu_type FROM vm_templates;
SELECT key, price_per_hour_cents FROM gpu_skus;
SELECT email, role, customer_access_status FROM users;
SQL
```

All should return expected rows per the seed spec.

---

## Phase 4: Start Services

Start order matters. Database must be up first, then services in this order:

### 4.1 Gateway

```bash
cd apps/gateway
# Load env
export $(cat .env | grep -v '^#' | xargs)
npx tsx src/index.ts
# Or for production: node dist/index.js
```

Verify:
```bash
curl http://gateway-host:5001/health
# Expected: {"status":"OK","allocations":0,"portsUsed":0}
```

### 4.2 API

```bash
cd apps/api
export $(cat .env | grep -v '^#' | xargs)
npx tsx src/index.ts
```

Verify:
```bash
curl http://api-host:4000/health
# Expected: {"status":"OK"}

curl http://api-host:4000/api/public/gpu-skus
# Expected: RTX_5090 and A100_80GB in response
```

### 4.3 Worker

```bash
cd worker
export $(cat .env | grep -v '^#' | xargs)
npx tsx src/index.ts
```

Verify in logs:
```
Aldaro Worker Service Started
Proxmox connection validated
Acquired leader lock (fencing token: ...)
```

### 4.4 Web (optional for proof runs)

```bash
cd apps/web
# Ensure .env.local points at staging API
npm run build && npm run start
```

---

## Phase 5: Preflight

### 5.1 Run preflight check

```bash
cd /path/to/repo
export DATABASE_URL="postgresql://..."
export PROXMOX_API_URL="https://..."
export PROXMOX_API_TOKEN_ID="..."
export PROXMOX_API_TOKEN_SECRET="..."
export GATEWAY_SERVICE_SECRET="..."
export ALDARO_AGENT_SHARED_SECRET="..."
export JWT_ACCESS_SECRET="..."
export JWT_REFRESH_SECRET="..."
export API_URL="http://api-host:4000"
export GATEWAY_URL="http://gateway-host:5001"

node scripts/preflight-check.js
```

### 5.2 Expected passing checks

- [x] Required env vars: all present
- [x] Secret strength: all >= 32 chars
- [x] No default secrets
- [x] Proxmox API reachable: N node(s)
- [x] Template readiness: templates found
- [x] Free GPUs available: >= 5 (or >= 2 minimum for basic tests)
- [x] GPU PCI addresses: all configured
- [x] Database connection: OK
- [x] Fleet nodes: N active
- [x] No orphan resources
- [x] API health: OK
- [x] Gateway health: OK
- [x] Worker process: 1 instance
- [x] Test user ready

### 5.3 If preflight fails

Fix each failure before proceeding. Common issues:
- Missing env var: check .env file and exports
- Proxmox unreachable: check network, firewall, token permissions
- No free GPUs: verify seed data and that no orphan allocations exist
- Orphan resources: run `node scripts/verify-cleanup.js` and resolve

---

## Phase 6: Staging Ready Verification

When preflight passes with zero failures, staging is operationally ready.

Final checklist:
- [ ] Preflight exits 0
- [ ] API health returns OK
- [ ] Gateway health returns OK
- [ ] Worker acquired leader lock
- [ ] Worker warm pool tick runs without error
- [ ] Proxmox API returns nodes
- [ ] At least 2 free GPUs of same type
- [ ] Template VM verified on Proxmox
- [ ] Test customer exists with Stripe ID
- [ ] No orphan resources

**"Staging ready" means**: preflight passes, all three services healthy, fleet inventory seeded, and the proof sequence can begin.

---

## Troubleshooting

### Worker fails with "pg_try_advisory_lock"
DATABASE_URL is pointing at SQLite. Must be Postgres for worker.

### API fails with "ECONNREFUSED" on gateway calls
Gateway not running or GATEWAY_INTERNAL_URL is wrong.

### Proxmox "401 Unauthorized"
Token format must be `PVEAPIToken=user@realm!tokenname=secret-uuid`. Check for typos.

### Prisma "schema drift"
Run `npx prisma db push --schema prisma/schema.staging.prisma` to sync.

### Port 5001 in use (macOS)
AirPlay Receiver uses 5001. Disable in System Preferences > General > AirDrop & Handoff, or use `GATEWAY_PORT=5051`.

### Prisma column names are camelCase in Postgres
When querying tables directly via `psql`, column names are camelCase (e.g., `"gpuType"`, `"customerAccessStatus"`), not snake_case. Prisma uses `@@map` for table names but not column names. Always quote camelCase column names in raw SQL.

---

## Local Validation Status (2026-03-12)

The following phases have been validated locally (macOS, PostgreSQL 15.17):

- [x] **Phase 1**: Database created, schema pushed (37 tables), Prisma client generated
- [x] **Phase 3**: Seed data loaded (2 nodes, 2 GPUs, 2 templates, 2 SKUs, 3 users)
- [x] **Phase 4 (Worker only)**: Worker starts, acquires advisory lock, schedules ticks, reaches Proxmox boundary
- [ ] **Phase 2**: Secrets, placeholder values used locally, real secrets needed for staging
- [ ] **Phase 4 (Gateway)**: Not started against staging yet
- [ ] **Phase 4 (API)**: Not started against Postgres yet (runs locally on SQLite)
- [ ] **Phase 5**: Preflight cannot pass without real Proxmox, gateway, and API connectivity
- [ ] **Phase 6**: Blocked on real infrastructure

The remaining hard boundary is real infrastructure connectivity (Proxmox, Stripe, DNS).
Full local evidence: `docs/local-proof-postgres-worker-2026-03-12.md`
