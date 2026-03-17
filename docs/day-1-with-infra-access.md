# Day 1 With Infrastructure Access

**Time-blocked execution plan for the first day after receiving Proxmox, Stripe, and networking credentials.**

**Prerequisites**: All items in `docs/infra-intake-packet.md` have been provided.

---

## Block 1: Environment Setup (0:00–0:30)

| # | Task | Command / Action | Done? |
|---|---|---|---|
| 1.1 | Create `.env.staging` files for API, Worker, Gateway | Copy from `docs/staging-env-templates.md`, fill real values | [ ] |
| 1.2 | Run environment validator | `scripts/validate-env.sh` — must exit 0 | [ ] |
| 1.3 | Verify Proxmox API reachable | `curl -k -H "Authorization: ..." https://HOST:8006/api2/json/version` | [ ] |
| 1.4 | Verify Stripe test key works | `curl https://api.stripe.com/v1/customers -u sk_test_KEY:` | [ ] |
| 1.5 | Verify Postgres reachable | `psql $DATABASE_URL -c "SELECT 1"` | [ ] |

**Gate**: `validate-env.sh` exits 0 with 0 errors. Do not proceed if any required var fails.

---

## Block 2: Database + Fleet Seed (0:30–1:00)

| # | Task | Command / Action | Done? |
|---|---|---|---|
| 2.1 | Apply Prisma migrations | `npx prisma migrate deploy` (from packages/db/) | [ ] |
| 2.2 | Verify partial unique index exists | `psql -c "\di usage_sessions_one_running_per_workspace"` | [ ] |
| 2.3 | Seed fleet_nodes | SQL from `docs/infra-intake-packet.md` with real node names | [ ] |
| 2.4 | Seed fleet_gpus | SQL from `docs/infra-intake-packet.md` with real PCI addresses | [ ] |
| 2.5 | Seed vm_templates | SQL from `docs/infra-intake-packet.md` with real template VMID | [ ] |
| 2.6 | Verify gpu_skus exist | `psql -c "SELECT key, \"pricePerHourCents\" FROM gpu_skus"` | [ ] |
| 2.7 | Seed warm_pool_config | `psql -c "SELECT * FROM warm_pool_config"` — verify entries | [ ] |
| 2.8 | Run clean-state check | `psql -f scripts/db-queries/clean-state-check.sql` — all zeros | [ ] |

**Gate**: All seed data present. `clean-state-check.sql` returns all zeros.

---

## Block 3: Service Boot (1:00–1:30)

| # | Task | Command / Action | Done? |
|---|---|---|---|
| 3.1 | Start API | `npm run dev:api` or production build — verify `/health` returns 200 | [ ] |
| 3.2 | Start Gateway | `npm run dev:gateway` — verify `/health` returns 200 | [ ] |
| 3.3 | Start Worker | `npm run dev:worker` — verify advisory lock acquired in logs | [ ] |
| 3.4 | Run preflight | `scripts/preflight-live-proof.sh` — must exit 0 | [ ] |

**Gate**: Preflight passes with 0 failures. All 3 services healthy.

---

## Block 4: Proof 01 — Staging Readiness (1:30–2:00)

| # | Task | Done? |
|---|---|---|
| 4.1 | `scripts/run-proof.sh 01` | [ ] |
| 4.2 | Verify all preconditions green | [ ] |
| 4.3 | Verify evidence captured to `exports/proofs/<date>/01-staging-readiness/` | [ ] |
| 4.4 | Record PASS/FAIL | [ ] |

**Gate**: Proof 01 PASS. If FAIL, stop and remediate before continuing.

---

## Block 5: Proof 02 — Billing Parity (2:00–3:00)

| # | Task | Done? |
|---|---|---|
| 5.1 | Launch a workspace (warm or cold path) | [ ] |
| 5.2 | Wait for RUNNING_ASSIGNED status | [ ] |
| 5.3 | Terminate the workspace | [ ] |
| 5.4 | Verify: exactly 1 ENDED session, 1 outbox entry, billedCents > 0 | [ ] |
| 5.5 | Verify: Stripe meter event accepted (check Stripe dashboard or API) | [ ] |
| 5.6 | Run `scripts/db-queries/proof-02-billing.sql` — all checks pass | [ ] |
| 5.7 | Run `scripts/run-proof.sh 02` for formal capture | [ ] |

**Gate**: Proof 02 PASS. Stripe meter event visible in dashboard.

---

## Block 6: Proofs 03, 04, 07 — Failure + Contention (3:00–5:00)

| # | Task | Done? |
|---|---|---|
| 6.1 | Proof 03: Terminate with injected failure → cleanup retries → eventually TERMINATED | [ ] |
| 6.2 | Proof 04: Two concurrent launches against 1 GPU → exactly 1 wins | [ ] |
| 6.3 | Proof 07: Seed stale workspaces → worker tick resolves them | [ ] |
| 6.4 | Run `scripts/db-queries/proof-07-cleanup.sql` for cleanup evidence | [ ] |
| 6.5 | Run billing state inspection → all zeros | [ ] |

**Gate**: Proofs 03, 04, 07 all PASS.

---

## Block 7: Proofs 06, 05 — Leakage + Restore (5:00–6:00)

| # | Task | Done? |
|---|---|---|
| 7.1 | Proof 06: Hit all error endpoints, scan responses for stack traces | [ ] |
| 7.2 | Proof 05: `pg_dump`, drop+recreate, `pg_restore`, verify row counts | [ ] |
| 7.3 | After restore: boot all 3 services, run preflight → still passes | [ ] |

**Gate**: Proofs 05, 06 PASS.

---

## Block 8: Package + Review (6:00–7:00)

| # | Task | Done? |
|---|---|---|
| 8.1 | Review `exports/proofs/<date>/proof-results.txt` — all 7 should have verdicts | [ ] |
| 8.2 | Run proof-pack integrity checklist (`docs/proofs/proof-pack-integrity-checklist.md`) | [ ] |
| 8.3 | `scripts/package-proof-evidence.sh` — creates archive | [ ] |
| 8.4 | Final billing state inspection → all zeros | [ ] |
| 8.5 | Update `docs/launch-readiness-index.md` with L2 results | [ ] |
| 8.6 | Update `docs/go-no-go-evidence-table.md` with proof verdicts | [ ] |
| 8.7 | Make GO/NO-GO recommendation to founder | [ ] |

---

## Decision Point

| All 7 proofs PASS | → **GO** — update launch-readiness-index, archive evidence |
|---|---|
| Any proof FAIL | → **NO-GO** — document failure, remediate, schedule re-run |
| Infra partially available | → Run what we can, document blocked proofs as SKIP |

---

## Abort Criteria

Stop immediately and escalate if:
- Proxmox API returns auth errors after credential setup
- VM clone fails with resource errors (disk space, memory)
- Stripe rejects meter events with non-auth errors
- Database migration fails or schema mismatch detected
- Any service crashes with unhandled exception (check structured logs)
