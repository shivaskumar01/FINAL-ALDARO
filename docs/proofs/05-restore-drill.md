# Proof 05: Restore Drill

**Proves that the staging database can be backed up, restored to a fresh database, and all services boot and function correctly against the restored copy with zero data loss.**

---

## Objective

pg_dump → pg_restore to a fresh database. Row counts match exactly. All services boot. Auth works. Fleet state is consistent. This proves business continuity capability.

---

## Preconditions

| # | Requirement | How to verify |
|---|---|---|
| 1 | Proof 01 passed | Staging readiness green |
| 2 | Known data exists | At least 1 user, 1 workspace history, fleet nodes/GPUs seeded |
| 3 | `pg_dump` and `pg_restore` available | `which pg_dump pg_restore` |
| 4 | Sufficient disk space | `df -h` shows headroom for dump file |
| 5 | Can create a second database | `createdb` permission available |

---

## Commands

```bash
DATE=$(date +%Y-%m-%d)
DIR="exports/proofs/$DATE/05-restore-drill"
mkdir -p "$DIR"

# === PRE-BACKUP CAPTURE ===

# 1. Record row counts for all critical tables
psql "$DATABASE_URL" <<'SQL' | tee "$DIR/pre-backup-counts.txt"
SELECT 'users' AS tbl, COUNT(*) FROM users
UNION ALL SELECT 'workspaces', COUNT(*) FROM workspaces
UNION ALL SELECT 'fleet_nodes', COUNT(*) FROM fleet_nodes
UNION ALL SELECT 'fleet_gpus', COUNT(*) FROM fleet_gpus
UNION ALL SELECT 'vm_templates', COUNT(*) FROM vm_templates
UNION ALL SELECT 'gpu_skus', COUNT(*) FROM gpu_skus
UNION ALL SELECT 'usage_sessions', COUNT(*) FROM usage_sessions
UNION ALL SELECT 'workspace_cleanup_jobs', COUNT(*) FROM workspace_cleanup_jobs
UNION ALL SELECT 'workspace_meter_event_outbox', COUNT(*) FROM workspace_meter_event_outbox
UNION ALL SELECT 'workspace_endpoints', COUNT(*) FROM workspace_endpoints
UNION ALL SELECT 'workspace_gpu_allocations', COUNT(*) FROM workspace_gpu_allocations
UNION ALL SELECT 'workspace_launch_operations', COUNT(*) FROM workspace_launch_operations
UNION ALL SELECT 'incidents', COUNT(*) FROM incidents
UNION ALL SELECT 'warm_pool_config', COUNT(*) FROM warm_pool_config
UNION ALL SELECT 'email_outbox', COUNT(*) FROM email_outbox
ORDER BY tbl;
SQL

# 2. Record sample data fingerprints
psql "$DATABASE_URL" -c "SELECT id, email, role FROM users ORDER BY email LIMIT 5;" | tee "$DIR/pre-backup-users-sample.txt"
psql "$DATABASE_URL" -c "SELECT name, status FROM fleet_nodes ORDER BY name;" | tee "$DIR/pre-backup-nodes.txt"
psql "$DATABASE_URL" -c "SELECT key, \"pricePerHourCents\" FROM gpu_skus ORDER BY key;" | tee "$DIR/pre-backup-skus.txt"

# === BACKUP ===

# 3. Stop all services (prevent writes during backup)
echo "Stop API, Worker, Gateway before backup for clean snapshot"
# kill API_PID WORKER_PID GATEWAY_PID

# 4. Take backup
DUMP_FILE="$DIR/staging-backup-$DATE.dump"
pg_dump -Fc "$DATABASE_URL" > "$DUMP_FILE" 2>&1
echo "Backup exit code: $?" | tee "$DIR/backup-result.txt"
ls -lh "$DUMP_FILE" >> "$DIR/backup-result.txt"

# === RESTORE ===

# 5. Create fresh restore target
RESTORE_DB="aldaro_staging_restore_$DATE"
dropdb "$RESTORE_DB" 2>/dev/null
createdb "$RESTORE_DB" 2>&1 | tee "$DIR/createdb-result.txt"

# 6. Restore
pg_restore -d "postgresql://aldaro:PASSWORD@localhost:5432/$RESTORE_DB" "$DUMP_FILE" 2>&1 | tee "$DIR/restore-output.txt"
echo "Restore exit code: $?" >> "$DIR/restore-output.txt"

# === POST-RESTORE VERIFICATION ===

RESTORE_URL="postgresql://aldaro:PASSWORD@localhost:5432/$RESTORE_DB"

# 7. Record post-restore row counts
psql "$RESTORE_URL" <<'SQL' | tee "$DIR/post-restore-counts.txt"
SELECT 'users' AS tbl, COUNT(*) FROM users
UNION ALL SELECT 'workspaces', COUNT(*) FROM workspaces
UNION ALL SELECT 'fleet_nodes', COUNT(*) FROM fleet_nodes
UNION ALL SELECT 'fleet_gpus', COUNT(*) FROM fleet_gpus
UNION ALL SELECT 'vm_templates', COUNT(*) FROM vm_templates
UNION ALL SELECT 'gpu_skus', COUNT(*) FROM gpu_skus
UNION ALL SELECT 'usage_sessions', COUNT(*) FROM usage_sessions
UNION ALL SELECT 'workspace_cleanup_jobs', COUNT(*) FROM workspace_cleanup_jobs
UNION ALL SELECT 'workspace_meter_event_outbox', COUNT(*) FROM workspace_meter_event_outbox
UNION ALL SELECT 'workspace_endpoints', COUNT(*) FROM workspace_endpoints
UNION ALL SELECT 'workspace_gpu_allocations', COUNT(*) FROM workspace_gpu_allocations
UNION ALL SELECT 'workspace_launch_operations', COUNT(*) FROM workspace_launch_operations
UNION ALL SELECT 'incidents', COUNT(*) FROM incidents
UNION ALL SELECT 'warm_pool_config', COUNT(*) FROM warm_pool_config
UNION ALL SELECT 'email_outbox', COUNT(*) FROM email_outbox
ORDER BY tbl;
SQL

# 8. Diff row counts
diff "$DIR/pre-backup-counts.txt" "$DIR/post-restore-counts.txt" | tee "$DIR/count-diff.txt"

# 9. Compare sample data
psql "$RESTORE_URL" -c "SELECT id, email, role FROM users ORDER BY email LIMIT 5;" | tee "$DIR/post-restore-users-sample.txt"
diff "$DIR/pre-backup-users-sample.txt" "$DIR/post-restore-users-sample.txt" | tee "$DIR/users-diff.txt"

psql "$RESTORE_URL" -c "SELECT name, status FROM fleet_nodes ORDER BY name;" | tee "$DIR/post-restore-nodes.txt"
diff "$DIR/pre-backup-nodes.txt" "$DIR/post-restore-nodes.txt" | tee "$DIR/nodes-diff.txt"

# === SERVICE BOOT TEST ===

# 10. Point services at restored DB
export DATABASE_URL="$RESTORE_URL"

# 11. Start API against restored DB
cd apps/api && npx tsx src/index.ts &
RESTORE_API_PID=$!
sleep 5

# 12. API health
curl -s http://localhost:4000/health | tee "$DIR/restore-api-health.json"

# 13. Start Worker against restored DB
cd worker && npx tsx src/index.ts &
RESTORE_WORKER_PID=$!
sleep 5
# Check for leader lock in logs
grep -m1 "Acquired leader lock" /tmp/worker.log && echo "LEADER_LOCK=OK" > "$DIR/restore-worker-lock.txt" || echo "LEADER_LOCK=MISSING" > "$DIR/restore-worker-lock.txt"

# 14. Auth smoke test
curl -s -X POST http://localhost:4000/auth/login \
  -H "Content-Type: application/json" \
  -H "Origin: https://staging.aldaro.ai" \
  -d '{"email":"integration-test@aldaro.ai","password":"TEST_PASSWORD"}' \
  -c restore-cookies.txt \
  -v 2>&1 | tee "$DIR/restore-auth-smoke.txt"

# 15. Data integrity: query fleet state
psql "$RESTORE_URL" -c "SELECT \"gpuType\", status, COUNT(*) FROM fleet_gpus GROUP BY \"gpuType\", status;" | tee "$DIR/restore-fleet-state.txt"

# 16. Schema integrity check (verify all Prisma relations work)
psql "$RESTORE_URL" -c "
SELECT COUNT(*) AS constraint_count
FROM information_schema.table_constraints
WHERE constraint_schema = 'public' AND constraint_type IN ('PRIMARY KEY', 'UNIQUE', 'FOREIGN KEY');
" | tee "$DIR/restore-constraint-count.txt"
```

---

## Pass/Fail Rules

| # | Check | PASS | FAIL |
|---|---|---|---|
| 1 | Backup completes | Exit code 0, dump file > 0 bytes | Any error |
| 2 | Restore completes | Exit code 0, no ERROR lines in output (warnings OK) | Any error |
| 3 | Row counts match | `count-diff.txt` is empty | Any row count mismatch |
| 4 | Sample data matches | `users-diff.txt` and `nodes-diff.txt` are empty | Any data mismatch |
| 5 | API boots | Health returns OK | Crash or non-200 |
| 6 | Worker boots | Leader lock acquired | Lock failure or crash |
| 7 | Auth works | Login returns 200 with cookie | Auth failure |
| 8 | Constraints intact | Constraint count matches original | Missing constraints |

**Overall**: ALL checks must pass.

---

## False-Pass Warnings

| Scenario | Why it looks like a pass but isn't |
|---|---|
| Row counts match but data is corrupted | Counts are identical but specific rows have NULL where they shouldn't, sample data diff catches some of this but not all |
| Restore warnings about "already exists" | pg_restore may emit warnings if sequences or extensions conflict, check if they're fatal |
| Auth works but passwords are different | If password hashing salt changed between environments, logins may fail, test with a known password |
| Worker boots but can't reach Proxmox | Leader lock is DB-only, Proxmox connectivity is a separate check |
| Partial restore (some tables empty) | Row count of 0 matches if original was also 0, verify tables that should have data actually do |

---

## Evidence Artifacts

All saved to `exports/proofs/<date>/05-restore-drill/`:

| File | Contents |
|---|---|
| `pre-backup-counts.txt` | Row counts before backup |
| `pre-backup-users-sample.txt` | User sample fingerprint |
| `pre-backup-nodes.txt` | Fleet nodes fingerprint |
| `pre-backup-skus.txt` | GPU SKU fingerprint |
| `staging-backup-<date>.dump` | The actual backup file |
| `backup-result.txt` | Backup exit code + file size |
| `restore-output.txt` | pg_restore output |
| `post-restore-counts.txt` | Row counts after restore |
| `count-diff.txt` | Row count diff (should be empty) |
| `users-diff.txt` | User sample diff (should be empty) |
| `nodes-diff.txt` | Fleet nodes diff (should be empty) |
| `restore-api-health.json` | API health against restored DB |
| `restore-worker-lock.txt` | Worker leader lock status |
| `restore-auth-smoke.txt` | Auth test response |
| `restore-fleet-state.txt` | Fleet GPU state |
| `restore-constraint-count.txt` | DB constraint count |

---

## Rollback/Cleanup

```bash
# Stop services pointing at restore DB
kill $RESTORE_API_PID $RESTORE_WORKER_PID 2>/dev/null

# Drop restore database
dropdb "$RESTORE_DB"

# Point services back at original DB
export DATABASE_URL="postgresql://aldaro:PASSWORD@localhost:5432/aldaro_staging"

# Restart original services
```

---

## Launch Impact if Failed

**High.** Without restore capability, a production database failure means total data loss. This is a business continuity requirement.
