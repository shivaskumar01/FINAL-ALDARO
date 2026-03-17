# Staging P0 Proof Report — 2026-03-11

## Decision
**NO-GO remains in effect.**

## Metadata
- Date tested: 2026-03-11
- Environment: local runtime only (not staging/prod-like)
- Operator: Engineering (Codex execution)
- Scope: run blocker-proof commands and capture executable evidence artifacts

## Evidence Bundle
- `exports/staging-p0-proof-2026-03-11/preflight.log`
- `exports/staging-p0-proof-2026-03-11/preflight.exit`
- `exports/staging-p0-proof-2026-03-11/verify-cleanup.log`
- `exports/staging-p0-proof-2026-03-11/verify-cleanup.exit`
- `exports/staging-p0-proof-2026-03-11/integration-remediation-security.log`
- `exports/staging-p0-proof-2026-03-11/integration-remediation-security.exit`
- `exports/staging-p0-proof-2026-03-11/verify-billing-parity.log`
- `exports/staging-p0-proof-2026-03-11/verify-billing-parity.exit`
- `exports/staging-p0-proof-2026-03-11/db-snapshot.json`
- `exports/staging-p0-proof-2026-03-11/db-snapshot.exit`
- `exports/staging-p0-proof-2026-03-11/run-20x-proof.log`
- `exports/staging-p0-proof-2026-03-11/run-20x-proof.exit`

## Command Results
1. `npm run preflight`
   - Exit: `1`
   - Result: **FAIL**
   - Key blockers:
     - Missing Proxmox/Gateway secrets
     - Gateway health check failed (`ECONNREFUSED`)
     - Orphan/stuck workspaces detected: 34
     - Worker process count anomaly

2. `npm run verify:cleanup`
   - Exit: `1`
   - Result: **FAIL**
   - Passed checks: no leaked GPU allocations, no leaked ports, no stuck usage sessions
   - Failed check: 34 stuck workspaces (`CREATING`, `TERMINATING`, `WAITING_FOR_AGENT`)

3. `npm run test:integration -- --exit --grep "NO-GO Remediation|Security Regressions"`
   - Exit: `0`
   - Result: **PASS**
   - Summary: `9 passing`
   - Covered paths:
     - launch idempotency under parallel duplicate requests
     - async-safe terminate queueing
     - CSRF enforcement on author reject (tokenless/invalid blocked; valid accepted)
     - selected security regression guards

4. `node scripts/verify-billing-parity.js --workspace 3845351b-32d5-4d4d-a0c3-f1d4cdbcc74a`
   - Exit: `1`
   - Result: **FAIL**
   - Output: `Usage session not found. Provide --workspace or --session.`
   - Interpretation: no completed usage session available to prove invoice parity.

5. `bash scripts/run-20x-proof.sh`
   - Exit: `128`
   - Result: **FAIL**
   - Immediate blocker: `.git` metadata unavailable in this workspace snapshot (`fatal: not a git repository`).

6. DB snapshot probe
   - Exit: `0`
   - Result: **PASS** (evidence capture only)
   - Current state:
     - workspaces by status: `CREATING=25`, `TERMINATING=2`, `WAITING_FOR_AGENT=7`, `FAILED=52`, `TERMINATED=20`
     - `endedSessions=0`
     - `emailOutbox pending=9`
     - `cleanupJobs=0`
     - `meterOutbox=0`

## Required Retest Matrix (P0 blockers)
1. E2E-04 successful launch (one intent -> one workspace)
   - Current evidence: **PASS (local integration)**  
   - Remaining: staging/prod-like proof with live infra

2. E2E-05 failed launch cleanup (no stuck residue)
   - Current evidence: **FAIL**
   - Reason: stuck workspace backlog remains

3. E2E-06 terminate outage recovery (no 500/stack leak, safe final state)
   - Current evidence: **PARTIAL**
   - Local async terminate test passes, but gateway is down; staging outage drill not executed

4. E2E-07 last-GPU race
   - Current evidence: **BLOCKED**
   - Reason: no staging/prod-like constrained inventory run

5. E2E-09 billing exactness parity
   - Current evidence: **FAIL/BLOCKED**
   - Reason: no completed usage session + no Stripe parity artifact

6. API-04 CSRF in staging/prod-like
   - Current evidence: **PASS (local integration)**
   - Remaining: staging/prod-like retest evidence

7. DATA-03 restore drill
   - Current evidence: **PARTIAL PASS** (local simulation only)
   - See: `docs/restore-drill-2026-03-11.md`

8. OBS-02 zero stack leakage in client-facing responses
   - Current evidence: **NOT PROVEN in staging/prod-like**
   - Local integration logs include server stack traces for CSRF errors; client-surface proof not completed in this pass

## Launch Recommendation
**NO-GO** until all P0 retests above are passed in staging/prod-like with linked evidence artifacts.

