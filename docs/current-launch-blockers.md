# Current Launch Blockers

**As of 2026-03-13. Updated after each proof or remediation session.**

---

## Blocking: Infrastructure Access

These cannot be resolved without external credentials/hardware.

| # | Blocker | What's needed | Who provides it |
|---|---|---|---|
| B1 | No Proxmox access | API URL, token ID, token secret for at least 1 node | Infra/founder |
| B2 | No Stripe test keys | `sk_test_*` secret key + webhook secret | Founder (Stripe Dashboard) |
| B3 | No real GPU PCI addresses | PCI bus addresses for GPUs in fleet nodes | Infra (from `lspci` on nodes) |
| B4 | No VM templates | Base VM image with CUDA, agent, cloud-init | Infra (build + upload to Proxmox) |
| B5 | No DNS/networking | Staging domain, SSL, iptables/nftables rules | Infra |
| B6 | No node names | Proxmox node identifiers for fleet_nodes table | Infra |

**Impact**: All 7 proofs require real infrastructure to reach L2. No proof can advance past L1 without B1-B6.

---

## Blocking: Code-Level (No Infra Needed)

| # | Blocker | File | Status | Effort |
|---|---|---|---|---|
| ~~C1~~ | ~~Partial unique index for one RUNNING session per workspace~~ | ~~Raw SQL migration~~ | **CLOSED**, migration applied, 8 tests pass |, |
| ~~C2~~ | ~~No `unhandledRejection` process handler~~ | API, Worker, Gateway | **CLOSED**, handlers added to all 3 services |, |
| ~~C3~~ | ~~GPU release in cleanup not guarded against missing GPU record~~ | ~~`worker/src/jobs/workspace-cleanup.ts`~~ | **CLOSED**, guard added with structured warning log |, |
| C4 | No periodic sweep for stale WorkspaceEndpoints (only gateway restart) | Worker tick or new job | Not started | 2 hours |

**Impact**: C1 is medium-severity (double-billing risk under concurrent race). C2-C4 are low-severity edge cases.

---

## Not Blocking But Not Proven

These are remediated and locally verified (L1) but not yet proven in staging (L2).

| # | Subsystem | L1 Evidence | What L2 Requires |
|---|---|---|---|
| N1 | Billing atomicity | 24 tests pass locally | Real Stripe meter event acceptance |
| N2 | Gateway durability | 23 tests pass locally | Real port forwarding + gateway restart under load |
| N3 | Error surface hardening | 10 response captures clean | Production-mode API with all routes exercisable |
| N4 | Worker provisioning rollback | 4 cleanup scenarios pass locally | Real Proxmox clone + failure injection |
| N5 | Cleanup durability | 4 stale-state scenarios exercised locally | Worker tick resolving stale state against real infra |
| N6 | GPU contention | Atomic `$transaction` in code | Two concurrent launches against 1 real GPU |
| N7 | Restore drill | Not tested | Real pg_dump/pg_restore cycle |

---

## Decision Matrix

| Scenario | Can we launch? | Why |
|---|---|---|
| All B-blockers resolved + all proofs pass | **YES** | Full L2 evidence |
| B-blockers resolved but C1 not done | **CONDITIONAL**, only if single-writer model holds | Application guard works but not DB-enforced |
| B-blockers resolved but some proofs fail | **NO** | Failed proof = unproven risk |
| B-blockers still open | **NO** | Cannot even attempt proofs |

---

## Unblocking Sequence

1. Get Proxmox credentials + node names → resolves B1, B3, B6
2. Build VM template → resolves B4
3. Get Stripe test keys → resolves B2
4. Configure DNS + SSL + iptables → resolves B5
5. Run `scripts/validate-env.sh` to confirm
6. Run `scripts/preflight-live-proof.sh` to confirm
7. Run `scripts/run-proof.sh all` to execute proof pack
