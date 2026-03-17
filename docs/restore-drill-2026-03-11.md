# Restore Drill Report — 2026-03-11

## Outcome
**PARTIAL PASS (local simulation only)**  
**Staging/prod-like restore proof: BLOCKED**

## Metadata
- Date tested: 2026-03-11
- Environment: local (`/Users/shivaskumar/FINAL Aldaro.AI`)
- Operator: Engineering (Codex execution)
- Scope: backup artifact creation, local restore validation, API smoke against restored DB

## Commands Executed and Results
1. Create backup copy and restore candidate DB
   - Command: copied `packages/db/prisma/dev.db` to:
     - `exports/restore-drill-2026-03-11/dev-backup.db`
     - `/tmp/aldaro-restore-2026-03-11.db`
   - Evidence:
     - `exports/restore-drill-2026-03-11/backup-copy.log`
     - `exports/restore-drill-2026-03-11/backup-copy.exit`
   - Result: **PASS** (`exit=0`)

2. Validate record-count parity between source DB and restored DB
   - Evidence:
     - `exports/restore-drill-2026-03-11/restore-compare.json`
     - `exports/restore-drill-2026-03-11/restore-compare.exit`
   - Result: **PASS** (`exit=0`)
   - Snapshot parity: `match=true`
     - users: 26
     - workspaces: 106
     - usage sessions: 0
     - email outbox: 9
     - meter outbox: 0
     - cleanup jobs: 0

3. Boot/API smoke against restored DB
   - Command: `DATABASE_URL=file:/tmp/aldaro-restore-2026-03-11.db npm run test:integration -- --exit --grep "supports CLI bearer auth on protected v1 routes"`
   - Evidence:
     - `exports/restore-drill-2026-03-11/restore-api-smoke.log`
     - `exports/restore-drill-2026-03-11/restore-api-smoke.exit`
   - Result: **PASS** (`exit=0`, `1 passing`)

## Blocking Gaps (P0 still open)
1. This was a local SQLite restore simulation, not staging/prod-like Postgres restore.
2. No live infra validation from restored state (gateway/worker/proxmox) was proven.
3. No timed billing session exists in current dataset (`endedSessions=0`), so post-restore billing parity cannot be demonstrated.

## Why staging/prod-like restore is blocked right now
- Preflight requires unavailable secrets and infra connectivity:
  - `PROXMOX_API_URL`
  - `PROXMOX_API_TOKEN_ID`
  - `PROXMOX_API_TOKEN_SECRET`
  - `GATEWAY_SERVICE_SECRET`
  - `ALDARO_AGENT_SHARED_SECRET`
- Gateway health check is failing in this runtime.
- 20x proof runner cannot start in this workspace snapshot because `.git` metadata is absent.

## Required Retest to Close DATA-03
1. Run restore from real staging/prod-like backup (Postgres), not SQLite copy.
2. Start API + worker + gateway against restored DB.
3. Verify critical table counts and sampled row integrity.
4. Execute auth, author dashboard, workspace lifecycle smoke.
5. Execute billing parity check with a completed timed session.
6. Archive evidence in dated artifacts and attach to launch review.

