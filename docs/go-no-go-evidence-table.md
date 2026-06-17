# Go/No-Go Evidence Table

**Decision support for launch authorization. Every row must be GREEN for GO.**

---

## Evidence Status (updated 2026-03-13)

| # | Subsystem | Remediated? | L1 (Local) | L2 (Staging) | Tests | Gaps |
|---|---|---|---|---|---|---|
| 1 | **Billing atomicity** | Yes | 24/24 pass + 8 constraint tests + 12/12 stress | Not started | `worker/tests/billing-correctness.test.ts`, `worker/tests/billing-constraint.test.ts`, `tests/stress/billing-stress.test.ts` | **None**, INV-1 DB-enforced |
| 2 | **Gateway durability** | Yes | 23/23 pass + 15/15 stress | Not started | `apps/gateway/tests/lease-durability.test.ts`, `tests/stress/gateway-stress.test.ts` | No periodic endpoint sweep (C4) |
| 3 | **Error surface** | Yes | 10/10 clean | Not started | Manual curl capture |, |
| 4 | **Worker provisioning** | Yes | 4 scenarios clean | Not started | Manual DB exercise | GPU release guard (C3) |
| 5 | **Cleanup durability** | Yes | 4 scenarios clean + 12/12 stress | Not started | `tests/stress/cleanup-stress.test.ts` |, |
| 6 | **DB constraints** | 14/14 + partial unique index | **L1**, index applied, constraint tests pass | Not started | `worker/tests/billing-constraint.test.ts` |, |
| 7 | **Staging readiness** | N/A | Partial (worker boots) | Not started | `scripts/preflight-live-proof.sh` | All infra missing |
| 8 | **Process crash discipline** | Yes | Handlers in all 3 services | Not started | Code review |, |

---

## Blocker → Proof → Evidence Mapping

| Blocker | Closes When | Proof Required | Evidence Artifact Path | Escalation Owner |
|---|---|---|---|---|
| B1: No Proxmox access | Credentials provided | 01 (staging readiness) | `exports/proofs/<date>/01-staging-readiness/` | Infra/founder |
| B2: No Stripe test keys | Keys provided | 02 (billing parity) | `exports/proofs/<date>/02-billing-parity/stripe-meter-event.txt` | Founder |
| B3: No GPU PCI addresses | `lspci` output from nodes | 01, 04 | `exports/proofs/<date>/04-last-gpu-contention/gpu-allocation-state.txt` | Infra |
| B4: No VM templates | Template built + uploaded | 01, 02, 03, 04 | `exports/proofs/<date>/01-staging-readiness/service-health.txt` | Infra |
| B5: No DNS/networking | Domain + SSL + iptables | 01, 06 | `exports/proofs/<date>/06-stack-leakage/error-responses.txt` | Infra |
| B6: No node names | Node IDs seeded in fleet_nodes | 01 | `exports/proofs/<date>/01-staging-readiness/preflight.txt` | Infra |
| C3: GPU release guard | Code fix + test | 03 (terminate recovery) | `exports/proofs/<date>/03-terminate-outage-recovery/` | Dev |
| C4: Stale endpoint sweep | Worker job + test | 07 (cleanup durability) | `exports/proofs/<date>/07-cleanup-durability/` | Dev |

---

## Proof Execution Status

| Proof | Document | Locally Prepared? | Stress Tested? | L2 Run Date | Result |
|---|---|---|---|---|---|
| 01 Staging Readiness | `docs/proofs/01-staging-readiness.md` | Yes | N/A |, |, |
| 02 Billing Parity | `docs/proofs/02-billing-parity.md` | Yes | Yes, 4/4 × 3 runs |, |, |
| 03 Terminate Recovery | `docs/proofs/03-terminate-outage-recovery.md` | Yes | N/A |, |, |
| 04 GPU Contention | `docs/proofs/04-last-gpu-contention.md` | Yes | N/A |, |, |
| 05 Restore Drill | `docs/proofs/05-restore-drill.md` | Yes | N/A |, |, |
| 06 Stack Leakage | `docs/proofs/06-stack-leakage.md` | Yes | Yes, 5/5 × 3 runs |, |, |
| 07 Cleanup Durability | `docs/proofs/07-cleanup-durability.md` | Yes | Yes, 4/4 × 3 runs |, |, |

---

## Infrastructure Status

| Item | Status | Needed For | Blocks Proofs |
|---|---|---|---|
| Proxmox access | **MISSING** | All proofs | 01-07 |
| Stripe test keys | **MISSING** | Billing meter events | 02 |
| Real GPU PCI addresses | **MISSING** | GPU passthrough | 02, 03, 04 |
| VM templates | **MISSING** | Workspace launch | 01-04, 07 |
| DNS/networking | **MISSING** | External access | 01, 06 |
| Local Postgres | **READY** | Local verification (done) |, |

---

## Operational Readiness

| Item | Status | Validated? |
|---|---|---|
| Proof execution pack (7 sheets) | **READY** | Yes, all sections present |
| Evidence capture harness | **READY** | Yes, manifest generation tested |
| DB query packs | **READY** | Yes |
| Environment validator | **READY** | Yes, tested with broken inputs, bug fixed |
| Preflight checker | **READY** | Yes, tested with services down |
| Proof runner (semi-automated) | **READY** | Yes, orchestration rehearsed |
| Evidence packager | **READY** | Yes, archive tested |
| Proof-pack integrity checklist | **READY** | `docs/proofs/proof-pack-integrity-checklist.md` |
| Stress test suites | **READY** | Yes, 3 suites × 3 runs each |
| Billing state inspection queries | **READY** | Yes, all 7 metrics at 0 post-stress |

---

## GO/NO-GO Decision

**Current answer: NO-GO.**

**Reason**: Infrastructure access (Proxmox, Stripe, GPU addresses, VM templates, DNS) is not available. No proof can advance to L2.

**What changes the answer to GO**: All 7 proofs pass at L2 with evidence captured in `exports/proofs/<date>/` and archived via `scripts/package-proof-evidence.sh`.

**Decision authority**: Founder.
