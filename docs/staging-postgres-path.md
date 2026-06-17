# Postgres Staging Path

## Current State

- Prisma `schema.prisma` datasource is set to `provider = "sqlite"` with `url = env("DATABASE_URL")`
- Local dev uses `file:./dev.db` (SQLite)
- Production intent is Postgres (documented, not yet implemented)
- Worker uses `pg_try_advisory_lock` which is Postgres-only, **worker cannot run on SQLite**

## What Assumes SQLite

1. **schema.prisma** `provider = "sqlite"`, this is the main gate
2. **packages/db/.env**, `DATABASE_URL="file:./dev.db"`
3. **apps/api/.env**, `DATABASE_URL="file:/Users/shivaskumar/...dev.db"`
4. **Prisma migrations** under `packages/db/prisma/migrations/`, generated for SQLite

## What Would Break on Postgres Without Changes

1. **Prisma provider mismatch**: If `schema.prisma` says `sqlite` but `DATABASE_URL` points to Postgres, Prisma will error. The provider must match the target.
2. **Migrations**: SQLite migrations are not directly compatible with Postgres. A fresh `prisma migrate dev` against Postgres will generate new Postgres-native migrations.
3. **Worker leader lock**: `pg_try_advisory_lock` works on Postgres, fails on SQLite. This is correct for staging, the worker is designed for Postgres.
4. **BigInt handling**: The `Artifact.bytes` field uses `BigInt`, works on both but serialization differs.
5. **Decimal fields**: `FleetDailyAgg`, `WorkspaceVerification` use `Decimal`, Postgres uses `numeric`, SQLite stores as text. Querying/sorting behavior may differ.

## Strategy: Environment-Driven Provider Switching

Prisma does not natively support runtime provider switching from a single schema. The clean approach:

### Option A: Staging schema overlay (recommended)

Create `packages/db/prisma/schema.staging.prisma` that is identical to `schema.prisma` but with `provider = "postgresql"`. Use it for staging migrations and generation.

Workflow:
```bash
# For staging/prod
PRISMA_SCHEMA=packages/db/prisma/schema.staging.prisma npx prisma migrate dev
PRISMA_SCHEMA=packages/db/prisma/schema.staging.prisma npx prisma generate
```

### Option B: Switch provider to Postgres permanently

Change `schema.prisma` to `provider = "postgresql"` and accept that local dev now requires Postgres too (via Docker or brew).

Trade-off: simpler, but local SQLite dev breaks.

### Option C: Multi-provider via Prisma preview

Prisma has experimental `multiProvider` support. Not recommended for production reliability.

## Recommended: Option A for now

Keep local dev on SQLite. Create a staging schema for Postgres. Once staging is proven, evaluate switching everything to Postgres (Option B).

## Local Postgres Validation (2026-03-12)

Steps 1-7 below have been executed locally and verified:
- PostgreSQL 15.17 installed (Homebrew, aarch64)
- `schema.staging.prisma` created with `provider = "postgresql"`
- `prisma db push` succeeded, 37 tables created
- `prisma generate` succeeded, client generated for Postgres
- Seed script ran successfully (existing `seed.ts`, not `seed-staging.ts`)
- Worker started against local Postgres, acquired advisory lock, ran ticks
- Worker reached the Proxmox clone boundary and handled the failure cleanly

**This validates the local Postgres path.** Real staging still requires actual infrastructure (Proxmox, gateway, Stripe).
Full evidence: `docs/local-proof-postgres-worker-2026-03-12.md`

## Staging DB Bring-Up Steps

```bash
# 1. Ensure Postgres is running and accessible
psql -h db-host -U aldaro -d aldaro_staging -c "SELECT 1"

# 2. Create the staging schema file
cp packages/db/prisma/schema.prisma packages/db/prisma/schema.staging.prisma
# Edit: change provider = "sqlite" to provider = "postgresql"

# 3. Set DATABASE_URL to Postgres
export DATABASE_URL="postgresql://aldaro:PASSWORD@db-host:5432/aldaro_staging"

# 4. Push schema to Postgres (creates tables without migration history)
npx prisma db push --schema packages/db/prisma/schema.staging.prisma

# 5. Generate Prisma client for Postgres
npx prisma generate --schema packages/db/prisma/schema.staging.prisma

# 6. Seed fleet data
npx tsx packages/db/prisma/seed-staging.ts

# 7. Verify
npx prisma studio --schema packages/db/prisma/schema.staging.prisma
```

## Code That Needs Attention for Postgres

1. **Worker leader lock** (`worker/src/index.ts:102`): Uses `pg_try_advisory_lock`, correct for Postgres, will fail on SQLite. This is expected.
2. **Worker shutdown** (`worker/src/index.ts:579`): Uses `pg_advisory_unlock`, same.
3. **Raw queries**: Search for `$queryRaw` and `$executeRaw` across the codebase to verify Postgres compatibility.

## Local vs Staging Database Path Summary

| Aspect | Local (SQLite) | Staging (Postgres) |
|---|---|---|
| Schema file | `schema.prisma` | `schema.staging.prisma` |
| Provider | `sqlite` | `postgresql` |
| DATABASE_URL | `file:./dev.db` | `postgresql://...` |
| Worker leader lock | Fails (expected) | Works |
| Migrations | SQLite-flavored | Postgres-flavored |
| Advisory locks | Not available | Available |
| Use for | UI dev, route testing, unit tests | Lifecycle proof, billing proof, integration |
