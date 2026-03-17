# Proof Execution Pack

Operator-grade test battery for Aldaro.AI launch readiness. Seven proofs, run in order, each with exact preconditions, commands, pass/fail rules, false-pass warnings, and rollback procedures.

---

## Proof-Run Order

Run strictly in this order. Each proof depends on the previous passing.

| Order | Proof | What It Proves | Blocking? |
|---|---|---|---|
| 1 | [01-staging-readiness.md](01-staging-readiness.md) | Environment is operational | **Gate** — all others blocked |
| 2 | [02-billing-parity.md](02-billing-parity.md) | Billing pipeline is exact | P0 |
| 3 | [03-terminate-outage-recovery.md](03-terminate-outage-recovery.md) | Cleanup recovers from gateway failure | P0 |
| 4 | [04-last-gpu-contention.md](04-last-gpu-contention.md) | Concurrent launch is safe | P0 |
| 5 | [07-cleanup-durability.md](07-cleanup-durability.md) | Worker auto-resolves stale state | P0 |
| 6 | [06-stack-leakage.md](06-stack-leakage.md) | No internal detail in error responses | P0 |
| 7 | [05-restore-drill.md](05-restore-drill.md) | DB backup/restore works | P0 |

**Why this order:**
- Proof 01 is the gate. Nothing runs without it.
- Proof 02 (billing) must be proven before proofs that create billable state.
- Proof 03 (terminate recovery) uses a running workspace from proof 02 flow.
- Proof 04 (GPU contention) needs billing proven first so leaked sessions are detectable.
- Proof 07 (cleanup durability) injects stale state — run before stack leakage to avoid interference.
- Proof 06 (stack leakage) is independent but benefits from a warm system.
- Proof 05 (restore drill) runs last because it stops and restarts services.

---

## Evidence Directory Structure

```
exports/proofs/
  YYYY-MM-DD/
    01-staging-readiness/
      env-validation.txt
      api-health.json
      gateway-health.json
      fleet-gpus.txt
      ...
    02-billing-parity/
      wallclock.txt
      usage-session.txt
      meter-outbox.txt
      ...
    03-terminate-outage-recovery/
      timeline.txt
      terminate-response.txt
      final-workspace.txt
      ...
    04-last-gpu-contention/
      response-a.json
      response-b.json
      post-gpu-state.txt
      ...
    05-restore-drill/
      pre-backup-counts.txt
      post-restore-counts.txt
      count-diff.txt
      ...
    06-stack-leakage/
      test1-terminate-failure.txt
      ...
      leak-scan.txt
      summary.txt
    07-cleanup-durability/
      injected-workspaces.txt
      final-workspaces.txt
      billing-math-check.txt
      ...
    manifest.json
```

---

## Proof Levels

| Level | Meaning | Sufficient for launch? |
|---|---|---|
| L0 | Implementation exists, code-reviewed only | No |
| L1 | Locally verified with evidence | No (necessary but not sufficient) |
| L2 | Staging/prod-like proof with evidence from this pack | Yes (if all pass/fail rules met) |

All 7 proofs target L2. Current status: L1 locally verified for billing, gateway, error surface, and cleanup. L2 requires real infrastructure.

---

## Running a Proof

1. Read the proof sheet completely before starting
2. Verify ALL preconditions are met
3. Create the evidence directory: `mkdir -p exports/proofs/$(date +%Y-%m-%d)/<proof-name>/`
4. Run commands in order, capturing output to evidence files
5. Evaluate pass/fail rules — check the false-pass warnings
6. If any check fails: stop, investigate, fix, re-run from the top
7. Run rollback/cleanup section before proceeding to next proof

---

## What This Pack Does NOT Cover

- Load testing / concurrent user stress (see `tests/stress/` when built)
- Security penetration testing
- Network partition tolerance beyond gateway outage
- Multi-region failover
- Stripe production-mode billing (test mode only)
- Long-running session accuracy (>24 hours)
