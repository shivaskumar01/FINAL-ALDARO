# Proof Levels — Three-Tier Evidence Model

This document defines the standard for distinguishing between code existence, local proof, and real-environment proof across the Aldaro platform.

---

## Definitions

### Level 0: Implementation Exists

Code implementing the feature is present in the repository. It compiles. It may have been manually reviewed. No execution evidence exists.

**What it proves**: A developer wrote something that looks correct.
**What it does NOT prove**: That it works, handles edge cases, or survives real conditions.

### Level 1: Local Proof Exists

The feature has been exercised in a local environment (macOS, local Postgres, placeholder infra credentials). Behavior was observed and documented with specific evidence (logs, DB state, HTTP responses).

**What it proves**: The code runs locally and produces expected behavior up to the boundary of available infrastructure.
**What it does NOT prove**: That it works against real Proxmox, real Stripe, real network conditions, real concurrency, or real failure modes.

### Level 2: Staging/Prod-Like Proof Exists

The feature has been exercised in an environment with real infrastructure: real Proxmox VMs, real Stripe test-mode billing, real gateway port allocation, real network conditions. Evidence was captured per the proof execution checklist.

**What it proves**: The system works under conditions representative of production.
**What it does NOT prove**: Production performance at scale, unless load-tested.

---

## Language Rules

| Instead of... | Say... |
|---|---|
| "Fixed" | "Implementation exists (L0)" or "Locally verified (L1)" or "Staging-proven (L2)" |
| "Works" | "Behaves as expected locally up to [boundary]" |
| "Validated" | "Locally validated" or "Staging-validated" — always specify |
| "Proven" | Only use for L2 with evidence artifact reference |
| "Tested" | Specify: "code-reviewed", "locally exercised", or "staging-tested" |
| "Secure" | "Error surface locally audited" or "Staging-proven clean" |

**Rule**: Never use "fixed", "works", or "proven" without explicitly stating the proof level.

---

## Current Proof Level Per Subsystem

Last updated: 2026-03-12

| Subsystem | Level | Evidence | Notes |
|---|---|---|---|
| **Auth (JWT/cookie/session)** | L0 | Code review only | Login, refresh, logout paths exist. Not locally exercised in production mode with full error capture. |
| **Approval flow** | L0 | Code review only | Approve/reject/pending paths exist. CSRF protection appears present. Rejection email path flagged as possibly missing. |
| **Workspace launch** | L0-L1 | Partial local | Warm-pool path reaches Proxmox boundary locally (L1). Cold launch path is L0 only. Idempotency via WorkspaceLaunchOperation exists (L0). |
| **Workspace terminate** | L0 | Code review only | Async cleanup queue exists. Not exercised against real gateway. Client response format not captured. |
| **Cleanup/reconciliation** | L1 (partial) | local-proof-postgres-worker-2026-03-12.md | Warm-pool failure rollback verified locally. Stale sweeper exists (L0). Cleanup job retry/dead-letter exists (L0). |
| **Billing (usage sessions)** | L0 | Code review only | Usage session lifecycle exists. Outbox pattern exists. No completed end-to-end timed session. |
| **Billing (Stripe emission)** | L0 | Code review only | Meter event emission code exists. Retry logic exists. Never called against real Stripe. |
| **Gateway (port allocation)** | L0 | Code review only | Allocate/release routes exist. HMAC verification exists. In-memory state. Not locally exercised. |
| **Restore drill** | L0 | Code review only | pg_dump/pg_restore path documented but never executed. |
| **Recommender** | L0 | Code review only | GPU recommendation exists. Not exercised. |
| **Worker leader lock** | L1 | local-proof-postgres-worker-2026-03-12.md | Advisory lock acquisition and release locally verified against Postgres. |
| **Last-GPU contention** | L0 | Code review only | GPU allocation uses DB-level locking. Never tested under real concurrency. |
| **Stack leakage** | L0 | Code review only | Error handler appears to sanitize. Not tested from client perspective in production mode. |
| **CSRF enforcement** | L0 | Code review only | Middleware appears present. Not exercised in production mode. |
| **CORS policy** | L0 | Code review only | Fastify CORS configured. Rejection behavior not captured. |
| **Rate limiting** | L0 | Code review only | Rate limit middleware appears configured. 429 response format not captured. |
| **Idle termination** | L0 | Code review only | Worker tick exists. Never observed terminating a real workspace. |
| **Incident detection** | L0 | Code review only | Multiple detection checks exist. Never triggered against real stuck state. |
| **Email outbox** | L0 | Code review only | Outbox pattern exists. Email delivery not tested. |
| **Warm pool** | L1 (partial) | local-proof-postgres-worker-2026-03-12.md | Reaches Proxmox clone boundary locally. Failure rollback verified. Full provisioning lifecycle unproven. |

---

## How to Advance Proof Level

### L0 → L1
- Exercise the feature locally
- Capture specific evidence (logs, DB queries, HTTP responses)
- Document what boundary the local proof reaches
- File evidence in docs/ with date stamp

### L1 → L2
- Exercise the feature against real infrastructure (Proxmox, Stripe, gateway)
- Follow the proof execution checklist (docs/proof-execution-checklist.md)
- Capture all evidence artifacts specified in the checklist
- File evidence with timestamps, screenshots, DB dumps
- Get pass/fail ruling per the checklist's pass/fail rules

---

## Evidence File Naming Convention

```
docs/local-proof-{subsystem}-{date}.md          # L1 evidence
docs/staging-proof-{subsystem}-{date}.md        # L2 evidence
docs/{subsystem}-audit.md                       # L0 analysis
```
