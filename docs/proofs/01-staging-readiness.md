# Proof 01: Staging Readiness

**Gate proof, all other proofs require this to pass first.**

---

## Objective

Confirm that the staging environment is fully operational: all services healthy, fleet inventory seeded, env secrets valid, DB schema applied, and clean starting state (no orphan resources).

---

## Preconditions

| # | Requirement | How to verify |
|---|---|---|
| 1 | Proxmox host reachable with IOMMU + GPU passthrough enabled | `curl -k https://PROXMOX_HOST:8006/api2/json/version` returns 200 |
| 2 | PostgreSQL running with `aldaro_staging` database | `psql -c "SELECT 1"` succeeds |
| 3 | Schema applied via `npx prisma db push --schema packages/db/prisma/schema.staging.prisma` | No errors |
| 4 | Seed data loaded per `docs/staging-fleet-seed-spec.md` | Fleet queries below return expected rows |
| 5 | All env files populated per `docs/staging-env-templates.md` | `scripts/validate-env.sh` exits 0 |
| 6 | DNS or `/etc/hosts` entries for staging services | `curl http://API_HOST:4000/health` resolves |

---

## Commands

```bash
# === PRE-FLIGHT ===

# 1. Validate env files for all services
scripts/validate-env.sh 2>&1 | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/env-validation.txt

# 2. Apply schema (idempotent)
cd packages/db && npx prisma db push --schema prisma/schema.staging.prisma 2>&1 | tee ../../exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/schema-push.txt && cd ../..

# === START SERVICES ===

# 3. Start Gateway
cd apps/gateway && GATEWAY_PORT=5001 npx tsx src/index.ts &
GATEWAY_PID=$!
sleep 3

# 4. Start API
cd apps/api && npx tsx src/index.ts &
API_PID=$!
sleep 5

# 5. Start Worker
cd worker && npx tsx src/index.ts &
WORKER_PID=$!
sleep 5

# === HEALTH CHECKS ===

# 6. API health
curl -s http://localhost:4000/health | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/api-health.json
echo ""

# 7. Gateway health
curl -s http://localhost:5001/health | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/gateway-health.json
echo ""

# 8. Worker leader lock (check logs)
grep -m1 "Acquired leader lock" /tmp/worker.log && echo "WORKER_LEADER_LOCK=OK" || echo "WORKER_LEADER_LOCK=MISSING"

# === FLEET INVENTORY ===

# 9. Verify fleet nodes
psql "$DATABASE_URL" -c "SELECT name, status FROM fleet_nodes;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/fleet-nodes.txt

# 10. Verify fleet GPUs
psql "$DATABASE_URL" -c "SELECT \"gpuType\", status, COUNT(*) FROM fleet_gpus GROUP BY \"gpuType\", status;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/fleet-gpus.txt

# 11. Verify VM templates
psql "$DATABASE_URL" -c "SELECT name, \"gpuType\", \"proxmoxNode\", enabled FROM vm_templates;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/vm-templates.txt

# 12. Verify GPU SKU pricing
psql "$DATABASE_URL" -c "SELECT key, \"pricePerHourCents\" FROM gpu_skus;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/gpu-skus.txt

# 13. Verify warm pool config
psql "$DATABASE_URL" -c "SELECT region, \"gpuType\", \"targetCount\" FROM warm_pool_config;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/warm-pool-config.txt

# === CLEAN STATE ===

# 14. No active workspaces
psql "$DATABASE_URL" -c "SELECT status, COUNT(*) FROM workspaces WHERE status NOT IN ('TERMINATED', 'FAILED') GROUP BY status;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/active-workspaces.txt

# 15. All GPUs free
psql "$DATABASE_URL" -c "SELECT status, COUNT(*) FROM fleet_gpus WHERE status != 'FREE' GROUP BY status;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/allocated-gpus.txt

# 16. No orphan endpoints
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM workspace_endpoints WHERE \"releasedAt\" IS NULL;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/orphan-endpoints.txt

# 17. No pending cleanup jobs
psql "$DATABASE_URL" -c "SELECT status, COUNT(*) FROM workspace_cleanup_jobs WHERE status NOT IN ('DONE', 'FAILED') GROUP BY status;" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/pending-cleanup.txt

# 18. No RUNNING usage sessions
psql "$DATABASE_URL" -c "SELECT COUNT(*) FROM usage_sessions WHERE status = 'RUNNING';" | tee exports/proofs/$(date +%Y-%m-%d)/01-staging-readiness/running-sessions.txt
```

---

## Pass/Fail Rules

| # | Check | PASS | FAIL |
|---|---|---|---|
| 1 | Env validation | Exit 0, no MISSING lines | Any missing or invalid env var |
| 2 | Schema push | No errors | Any Prisma error |
| 3 | API health | Returns `{"status":"ok"}` or equivalent | Non-200 or no response |
| 4 | Gateway health | Returns `{"status":"OK","allocations":0,...}` | Non-200 or no response |
| 5 | Worker leader lock | Log line contains "Acquired leader lock" | Missing or lock failure |
| 6 | Fleet nodes | At least 1 ACTIVE node | 0 rows |
| 7 | Fleet GPUs | At least 1 FREE GPU per configured type | 0 free GPUs |
| 8 | VM templates | At least 1 enabled template per node | 0 rows |
| 9 | GPU SKU pricing | RTX_5090 and A100_80GB have non-zero `pricePerHourCents` | Missing or $0 |
| 10 | Clean state | Queries 14-18 all return 0 rows | Any non-zero count |

**Overall**: ALL checks must pass. Any single failure = proof fails.

---

## False-Pass Warnings

| Scenario | Why it looks like a pass but isn't |
|---|---|
| Health returns 200 but DB is wrong database | API connects to any Postgres, verify `DATABASE_URL` points to `aldaro_staging` |
| GPU SKU exists but with $0 pricing | Session will be created with `pricePerHourCents=0`, billing proof will pass mathematically but bill nothing |
| Fleet GPU shows FREE but wrong PCI address | Provisioning will fail at GPU passthrough step, not caught by this proof |
| Worker acquires lock but Proxmox URL is wrong | Worker starts but all provisioning will fail, verify Proxmox reachability separately |
| Gateway starts in ephemeral mode | If `DATABASE_URL` is missing for gateway, it runs without persistence, hard-fail added for production/staging but verify |

---

## Evidence Artifacts

All saved to `exports/proofs/<date>/01-staging-readiness/`:

| File | Contents |
|---|---|
| `env-validation.txt` | Full output of env validator |
| `schema-push.txt` | Prisma schema push output |
| `api-health.json` | API health response |
| `gateway-health.json` | Gateway health response |
| `fleet-nodes.txt` | Fleet node inventory |
| `fleet-gpus.txt` | Fleet GPU inventory by type/status |
| `vm-templates.txt` | VM template list |
| `gpu-skus.txt` | GPU SKU pricing |
| `warm-pool-config.txt` | Warm pool target counts |
| `active-workspaces.txt` | Non-terminal workspace count (should be 0) |
| `allocated-gpus.txt` | Non-free GPU count (should be 0) |
| `orphan-endpoints.txt` | Unreleased endpoint count (should be 0) |
| `pending-cleanup.txt` | Pending cleanup job count (should be 0) |
| `running-sessions.txt` | RUNNING session count (should be 0) |

---

## Rollback/Cleanup

No destructive actions in this proof. If any check fails:
1. Fix the failing component (env var, seed data, service config)
2. Re-run the entire proof from the top
3. Do not proceed to other proofs until this passes

---

## Launch Impact if Failed

**Blocks everything.** No other proof can execute until staging readiness passes.
