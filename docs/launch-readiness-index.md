# Launch Readiness Index

Single source of truth for launch readiness.

**Overall status: NO-GO** (as of 2026-03-13)

---

## What Changed in This Phase

- Billing remediation verified: 24 regression tests passing, race condition bug found and fixed, all SQL inspection queries clean
- Gateway remediation verified: 23 regression tests passing, HMAC verified at function level, stale lease heuristic documented, ephemeral mode hard-fail added for staging/prod
- Worker provisioning remediated: atomic GPU alloc, agent timeout fix, session close atomicity in warm-pool terminate path
- Error surface remediated: all findUniqueOrThrow removed, all .flatten() server-side only
- Cleanup durability matrix created with 8 stale-state scenarios, verification queries, and 6 identified gaps
- DB constraint review completed: 14/14 upsert targets DB-backed, 1 missing partial unique index identified
- Billing invariant doc created with 7 formal invariants and their enforcement status

## What Is Now Better Locally

- Billing session lifecycle is race-safe across all three close paths (API, worker cleanup, warm-pool terminate)
- Gateway lease state survives restarts, auto-cleans stale leases, rejects bad HMAC signatures
- Worker provisioning failure leaves deterministic, non-leaking DB state (locally verifiable paths)
- Error responses are sanitized (no .flatten() leak, no findUniqueOrThrow leak)

## What Still Blocks Launch

**Code-level gaps** (no infra needed):
1. ~~Partial unique index for one RUNNING session per workspace~~, **CLOSED** (migration applied, 8 constraint tests pass)
2. Error surface response capture from running production-mode API, **L1 verified** (10 responses captured locally)
3. Cleanup durability matrix scenarios, **L1 verified** (4 scenarios exercised locally)

**Infrastructure-dependent** (blocked on access):
1. Proxmox credentials, Stripe test keys, node names, PCI addresses
2. Staging bootstrap and 7 proof scenarios
3. iptables/nftables port forwarding, agent credential delivery

---

## Proof Level Key

| Level | Meaning | Sufficient for launch? |
|---|---|---|
| L0 | Implementation exists, code-reviewed only | No |
| L1 | Locally verified with evidence | No (necessary but not sufficient) |
| L2 | Staging/prod-like proof with evidence | Yes (if pass/fail rules met) |

---

## P0, Must be L2 before launch

| # | Subsystem | Audit | Remediated | Local Verified | Real-Env Proof |
|---|---|---|---|---|---|
| 1 | **Staging readiness** | [staging-bootstrap-runbook.md](staging-bootstrap-runbook.md) | N/A | L1 partial, worker boots, reaches Proxmox boundary | Not started |
| 2 | **Billing parity** | [billing-path-audit.md](billing-path-audit.md), [billing-invariants.md](billing-invariants.md) | **Yes**, atomic close, P2025 race fix, attemptCount fix | **L1**, 24 tests pass, SQL clean | Not started |
| 3 | **Terminate outage recovery** | [cleanup-durability-matrix.md](cleanup-durability-matrix.md) | **Yes**, cleanup atomicity, stale sweeper, dead-letter | **L1**, 23 gateway tests pass | Not started |
| 4 | **Last-GPU contention** | [worker-risk-audit.md](worker-risk-audit.md) | **Partial**, atomic GPU alloc, no DB-level lock on GPU selection | Not tested | Not started |
| 5 | **Restore drill** |, | N/A | Not tested | Not started |
| 6 | **Stack leakage** | [error-surface-audit.md](error-surface-audit.md) | **Yes**, findUniqueOrThrow removed, .flatten() server-only | **L1**, production-mode responses captured, all clean | Not started |
| 7 | **Cleanup durability** | [cleanup-durability-matrix.md](cleanup-durability-matrix.md), [worker-failure-matrix.md](worker-failure-matrix.md) | **Yes**, atomic session finalize, agent timeout fix, GPU alloc atomic | **L1**, 4 stale-state scenarios exercised, final state clean | Not started |

---

## P1, Must be at least L1 before launch

| Subsystem | Audit | Remediated | Current Level |
|---|---|---|---|
| Auth (login/refresh/logout) |, |, | L0 |
| CSRF enforcement |, |, | L0 |
| CORS policy |, |, | L0 |
| Rate limiting |, |, | L0 |
| Approval flow | [approval-flow-audit.md](approval-flow-audit.md) |, | L0 |
| Cross-tenant isolation |, |, | L0 |
| Gateway routes | [gateway-local-validation.md](gateway-local-validation.md) | **Yes**, DB leases, reconciliation, HMAC, ephemeral hard-fail | **L1**, 23 tests pass |
| Worker leader lock |, |, | L1, [locally verified](local-proof-postgres-worker-2026-03-12.md) |
| Warm pool provisioning | [worker-risk-audit.md](worker-risk-audit.md) | **Yes**, atomic GPU alloc, agent timeout fix | L1 partial |
| Idle termination |, |, | L0 |
| Incident detection |, |, | L0 |
| Email outbox |, |, | L0 |
| DB constraints | [db-constraint-review.md](db-constraint-review.md) | 14/14 upserts DB-backed | L0, review only |

---

## Code Remediation Tracker

| Workstream | Files Changed | Tests | Status |
|---|---|---|---|
| 1: Billing atomicity | workspaceService.ts, workspace-cleanup.ts, workspace-metering.ts | 24 pass | **Verified** |
| 2: Gateway durability | gateway/src/index.ts | 23 pass | **Verified** |
| 3: Error surface | 5 route files, workspaceService.ts | Response capture | **Verified**, production-mode responses captured, all clean |
| 5: Worker provisioning | warm-pool.ts (3 fixes) | Cleanup scenarios | Remediated + 4 cleanup scenarios exercised locally |
| Race condition fix | workspaceService.ts:endUsageSession | Covered in billing tests | **Found and fixed during verification** |
| Ephemeral hard-fail | gateway/src/index.ts |, | Added |

---

## Infrastructure Readiness

| Item | Status |
|---|---|
| Local Postgres | Ready, PostgreSQL 15.17 |
| Local API | Runnable |
| Local Worker | Runnable (Postgres) |
| Local Gateway | Runnable, DB-backed |
| Proxmox access | **Missing** |
| Stripe test keys | **Missing** |
| Real GPU PCI addresses | **Missing** |
| VM templates | **Missing** |
| DNS/networking | **Missing** |

---

## Operational Docs

| Document | Purpose | Status |
|---|---|---|
| [proof-levels.md](proof-levels.md) | Three-tier evidence model | Created |
| [proof-execution-checklist.md](proof-execution-checklist.md) | 7 proof scenarios | Created |
| [staging-bootstrap-runbook.md](staging-bootstrap-runbook.md) | Staging bring-up | Created |
| [staging-env-templates.md](staging-env-templates.md) | Secret matrix | Created |
| [staging-fleet-seed-spec.md](staging-fleet-seed-spec.md) | Fleet inventory | Created |
| [staging-postgres-path.md](staging-postgres-path.md) | Postgres strategy | Created |
| [local-proof-postgres-worker-2026-03-12.md](local-proof-postgres-worker-2026-03-12.md) | Worker evidence | Created |
| [worker-risk-audit.md](worker-risk-audit.md) | Worker failure analysis | Created |
| [worker-failure-matrix.md](worker-failure-matrix.md) | Worker failures | Updated with remediation |
| [billing-path-audit.md](billing-path-audit.md) | Billing lifecycle | Updated with 24-test evidence |
| [billing-invariants.md](billing-invariants.md) | Formal billing invariants | **New** |
| [gateway-local-validation.md](gateway-local-validation.md) | Gateway evidence | Updated with 23-test evidence |
| [error-surface-audit.md](error-surface-audit.md) | Error handling | Updated with remediation |
| [cleanup-durability-matrix.md](cleanup-durability-matrix.md) | Stale-state scenarios | Created |
| [db-constraint-review.md](db-constraint-review.md) | Schema constraint audit | **New** |
| [workspace-lifecycle-state-machine.md](workspace-lifecycle-state-machine.md) | Status transitions | Created |
| [approval-flow-audit.md](approval-flow-audit.md) | Approval analysis | Created |
| [billing-state-inspection.sql](../scripts/billing-state-inspection.sql) | Billing diagnostic queries | Created |
