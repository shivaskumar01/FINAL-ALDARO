# Local Bootstrap Runbook

Exact steps to go from a clean checkout to a running local development environment.

---

## Minimum Supported Toolchain

| Tool | Minimum Version | Verified With |
|---|---|---|
| Node.js | 18.16.0+ | v18.16.0 |
| npm | 9.x+ | 9.5.1 |
| Python | 3.10+ | 3.12.5 |
| PostgreSQL | 15+ (optional, required for worker) | 15.17 (Homebrew) |
| Prisma | 5.22.0 | 5.22.0 |
| TypeScript | 5.0+ | 5.x (via workspace) |

No `.nvmrc` or `.node-version` file exists. The repo does not enforce a Node version. Node 18 LTS is the practical minimum.

---

## Clean-Room Bootstrap

Assumes: no prior `node_modules`, no database, no `.env` files.

### Step 1: Install Node dependencies

```bash
cd /path/to/aldaro
npm install
```

This uses npm workspaces (configured in root `package.json`). It installs dependencies for:
- Root (tsx, typescript, mocha, chai, ts-node)
- apps/api
- apps/web
- apps/gateway
- worker
- packages/db
- packages/shared

All packages are hoisted to root `node_modules/` with symlinks for workspace packages.

**Verify**: `ls node_modules/.package-lock.json` exists. No `npm ERR!` in output.

### Step 2: Generate Prisma client

```bash
npx prisma generate --schema packages/db/prisma/schema.prisma
```

This generates the Prisma client into `node_modules/@prisma/client/`. Required before any TypeScript service can import `@prisma/db`.

**Verify**: `ls node_modules/.prisma/client/index.js` exists.

### Step 3: Create env files

Each service needs a `.env` file. Templates exist as `.env.example` in:
- `apps/api/.env.example`
- `apps/web/.env.example`
- `apps/gateway/.env.example`
- `worker/.env.example`

```bash
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.example apps/web/.env.local
cp apps/gateway/.env.example apps/gateway/.env
cp worker/.env.example worker/.env
```

Edit each to fill in required values. For local development, minimum viable config:

**apps/api/.env** (minimum for local SQLite):
```bash
NODE_ENV=development
API_PORT=4000
DATABASE_URL="file:/absolute/path/to/packages/db/prisma/dev.db"
JWT_ACCESS_SECRET=dev-only-jwt-access-secret-minimum-32chars
JWT_REFRESH_SECRET=dev-only-jwt-refresh-secret-minimum-32chars
ALDARO_AGENT_SHARED_SECRET=dev-only-agent-shared-secret-min-32chars
GATEWAY_SERVICE_SECRET=dev-only-gateway-secret-minimum-32chars
GATEWAY_INTERNAL_URL=http://localhost:5051
APP_BASE_URL=http://localhost:3000
API_BASE_URL=http://localhost:4000
```

**apps/gateway/.env** (minimum):
```bash
NODE_ENV=development
GATEWAY_PORT=5051
GATEWAY_HOST=localhost
GATEWAY_SERVICE_SECRET=dev-only-gateway-secret-minimum-32chars
```

**Note**: macOS port 5001 conflicts with AirPlay Receiver. Use `GATEWAY_PORT=5051`.

### Step 4: Create local database (SQLite)

```bash
npx prisma db push --schema packages/db/prisma/schema.prisma
```

Creates `packages/db/prisma/dev.db` with all tables.

### Step 5: Seed local database

```bash
cd packages/db
npx prisma db seed
# or: npx tsx prisma/seed.ts
```

Seeds: test users, fleet nodes, GPUs, VM templates, GPU SKUs, warm pool configs.

**Verify**: `npx prisma studio --schema prisma/schema.prisma` opens browser with populated tables.

---

## Service Start Order

Dependencies: Prisma client must be generated first. No inter-service runtime dependency for local dev.

### Gateway (optional for API-only dev)

```bash
npm run dev -w @aldaro/gateway
# or: cd apps/gateway && npm run dev
```

Health check: `curl http://localhost:5051/health`
Expected: `{"status":"OK","allocations":0,"portsUsed":0}`

### API

```bash
npm run dev:api
# or: cd apps/api && npm run dev
```

Health check: `curl http://localhost:4000/health`
Expected: `{"status":"OK"}`

Public endpoint: `curl http://localhost:4000/api/public/gpu-skus`

### Web (Next.js frontend)

```bash
npm run dev:web
# or: cd apps/web && npm run dev
```

Opens at `http://localhost:3000`.

### Worker (requires Postgres — see below)

The worker uses `pg_try_advisory_lock` and **cannot run on SQLite**. For local worker development, you need a local Postgres instance.

```bash
# Install Postgres (macOS)
brew install postgresql@15
brew services start postgresql@15

# Create database
createuser aldaro -s
createdb aldaro_staging -O aldaro

# Apply Postgres schema
DATABASE_URL="postgresql://aldaro@localhost:5432/aldaro_staging" \
  npx prisma db push --schema packages/db/prisma/schema.staging.prisma

# Generate Postgres client
DATABASE_URL="postgresql://aldaro@localhost:5432/aldaro_staging" \
  npx prisma generate --schema packages/db/prisma/schema.staging.prisma

# Seed
DATABASE_URL="postgresql://aldaro@localhost:5432/aldaro_staging" \
  npx tsx packages/db/prisma/seed.ts

# Start worker
cd worker
DATABASE_URL="postgresql://aldaro@localhost:5432/aldaro_staging" \
  PROXMOX_API_URL="https://placeholder:8006" \
  PROXMOX_API_TOKEN_ID="test@pve!staging" \
  PROXMOX_API_TOKEN_SECRET="placeholder" \
  ALDARO_AGENT_SHARED_SECRET="dev-only-agent-shared-secret-min-32chars" \
  GATEWAY_INTERNAL_URL="http://localhost:5051" \
  GATEWAY_SERVICE_SECRET="dev-only-gateway-secret-minimum-32chars" \
  API_BASE_URL="http://localhost:4000" \
  STRIPE_SECRET_KEY="sk_test_placeholder" \
  npm run dev
```

The worker will start, acquire the advisory lock, and schedule ticks. Warm pool ticks will fail at the Proxmox API boundary (expected without real Proxmox).

### Python Agent (runs inside VMs, not locally)

```bash
cd apps/agent
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
```

The agent is designed to run inside provisioned VMs. Local execution is only useful for development/testing of the agent code itself.

### Python CLI

```bash
cd apps/cli
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
aldaro --help
```

---

## Root Script Matrix

| Script | Command | Description | Status |
|---|---|---|---|
| `dev:web` | `npm run dev -w @aldaro/web` | Start web dev server | Works |
| `dev:api` | `npm run dev -w @aldaro/api` | Start API dev server | Works (needs .env) |
| `dev:worker` | `npm run dev -w @aldaro/worker` | Start worker dev server | Works (needs Postgres) |
| `build` | `npm run build --workspaces` | Build all workspaces | Depends on Prisma generate |
| `test` | `npm test --workspaces` | Run all workspace tests | May fail if no test scripts defined |
| `test:integration` | mocha integration tests | Run integration tests | Needs staging env |
| `preflight` | `node scripts/preflight-check.js` | Staging preflight check | Needs all env vars |
| `proof:20x` | `./scripts/run-20x-proof.sh` | Run 20x proof | Needs staging |
| `verify:billing-parity` | Billing verification | Check billing records | Needs workspace ID |
| `verify:cleanup` | Cleanup verification | Check for orphans | Needs DB access |
| `db:seed` | Prisma seed | Seed database | Works |
| `db:reset` | Prisma reset | Reset database | Works (destructive) |
| `audit` | npm audit | Security audit | Works |

### Per-Service Script Coverage

| Service | dev | build | start | test | typecheck | lint |
|---|---|---|---|---|---|---|
| apps/api | `tsx watch` | `tsc` | `node dist/` | Missing | Missing | Missing |
| apps/web | `next dev` | `next build` | `next start` | Missing | Missing | `next lint` |
| apps/gateway | `tsx watch` | `tsc` | `node dist/` | Missing | Missing | Missing |
| worker | `tsx watch` | `tsc` | `node dist/` | Missing | Missing | Missing |
| packages/db | — | `tsc` | — | Missing | Missing | Missing |
| packages/shared | — | `tsc` | — | Missing | Missing | Missing |

**Missing scripts**: `test`, `typecheck`, and `lint` are absent from API, gateway, worker, packages/db, and packages/shared. Only web has lint (via Next.js).

---

## What Is Canonical Source vs Artifact

| Path | Type | Notes |
|---|---|---|
| `apps/*/src/` | Source | Canonical TypeScript source |
| `worker/src/` | Source | Canonical worker source |
| `packages/*/src/` | Source | Canonical shared source |
| `packages/db/prisma/schema.prisma` | Source | SQLite schema (local dev) |
| `packages/db/prisma/schema.staging.prisma` | Source | Postgres schema (staging) |
| `packages/db/prisma/seed.ts` | Source | Seed script |
| `apps/agent/aldaro_agent/` | Source | Python agent |
| `apps/cli/aldaro_cli/` | Source | Python CLI |
| `scripts/` | Source | Operational scripts |
| `docs/` | Source | Documentation |
| `tests/` | Source | Integration tests |
| `node_modules/` | Artifact | .gitignored, regenerated by `npm install` |
| `dist/` | Artifact | .gitignored, regenerated by `tsc`/`next build` |
| `.next/` | Artifact | .gitignored, regenerated by `next build` |
| `*.db` | Artifact | .gitignored, regenerated by `prisma db push` |
| `.env` | Secret | .gitignored, created from `.env.example` |

---

## Graceful Failure With Missing Env

| Service | Missing DB URL | Missing JWT secrets | Missing Proxmox | Missing Gateway |
|---|---|---|---|---|
| API | Crash (Prisma init) | Crash (JWT plugin) | Warns, continues | Warns, launch fails at gateway call |
| Worker | Crash (advisory lock) | N/A | Crash (provider init) | Ticks fail on gateway calls |
| Gateway | N/A (no DB) | N/A | N/A | Crash if GATEWAY_SERVICE_SECRET missing |
| Web | N/A (client-side) | Auth fails silently | N/A | N/A |

**Note**: Most services crash immediately with missing critical env rather than running in a degraded state. This is acceptable for development but means env must be populated before starting services.

---

## Common Issues

| Issue | Cause | Fix |
|---|---|---|
| `prisma: command not found` | Prisma not in PATH | Use `npx prisma` |
| `tsx: command not found` | tsx not installed | `npm install` at root |
| Port 5001 in use (macOS) | AirPlay Receiver | Use `GATEWAY_PORT=5051` |
| Worker fails `pg_try_advisory_lock` | SQLite database | Worker requires Postgres |
| `@prisma/client` import errors | Client not generated | Run `npx prisma generate` |
| CORS errors in browser | API `APP_BASE_URL` mismatch | Set `APP_BASE_URL=http://localhost:3000` in API .env |
| `ECONNREFUSED` on gateway calls | Gateway not running | Start gateway first |

---

## Local Postgres Path (Verified 2026-03-12)

For worker development or staging-like local testing, see:
- [staging-postgres-path.md](staging-postgres-path.md) — strategy and validation notes
- [local-proof-postgres-worker-2026-03-12.md](local-proof-postgres-worker-2026-03-12.md) — evidence

The worker's Postgres startup path, advisory lock, and warm-pool tick have been locally verified up to the Proxmox API boundary. Real infrastructure interactions are still unproven.
