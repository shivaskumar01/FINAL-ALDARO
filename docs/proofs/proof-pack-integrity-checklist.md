# Proof Pack Integrity Checklist

**Use after running `scripts/run-proof.sh all` to verify the evidence pack is complete and valid.**

---

## Pre-Archive Checks

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Evidence root exists | `ls exports/proofs/YYYY-MM-DD/` | 7 proof subdirectories + `proof-results.txt` |
| 2 | Results file has all 7 proofs | `wc -l exports/proofs/YYYY-MM-DD/proof-results.txt` | 7 lines |
| 3 | No proof has UNKNOWN verdict | `grep UNKNOWN exports/proofs/YYYY-MM-DD/proof-results.txt` | 0 matches |
| 4 | Every proof dir has ≥1 evidence file | `for d in exports/proofs/YYYY-MM-DD/*/; do echo "$(basename $d): $(ls -1 $d \| wc -l)"; done` | All counts ≥ 1 |
| 5 | Every proof dir has manifest.json | `for d in exports/proofs/YYYY-MM-DD/*/; do test -f "$d/manifest.json" && echo "OK: $(basename $d)" \|\| echo "MISSING: $(basename $d)"; done` | All OK |
| 6 | All manifests are valid JSON | `for f in exports/proofs/YYYY-MM-DD/*/manifest.json; do python3 -m json.tool "$f" > /dev/null && echo "OK: $f" \|\| echo "INVALID: $f"; done` | All OK |

---

## Per-Proof Minimum Evidence

| Proof | Required Evidence Files | Why |
|---|---|---|
| 01, Staging readiness | `validate-env.txt`, `preflight.txt`, `service-health.txt` | Proves environment is configured and services respond |
| 02, Billing parity | `billing-stress.txt`, `billing-state-inspection.txt`, `constraint-tests.txt`, `stripe-meter-event.txt` | Proves session lifecycle + Stripe acceptance |
| 03, Terminate outage recovery | `terminate-test.txt`, `cleanup-state.txt`, `gateway-release.txt` | Proves terminate → cleanup → port release chain |
| 04, Last GPU contention | `concurrent-launch.txt`, `gpu-allocation-state.txt` | Proves exactly 1 GPU allocated under race |
| 05, Restore drill | `pg-dump.txt`, `pg-restore.txt`, `post-restore-check.txt` | Proves backup/restore cycle preserves data |
| 06, Stack leakage | `error-responses.txt`, `leak-scan.txt` | Proves no stack traces or internal details in responses |
| 07, Cleanup durability | `stale-workspace-cleanup.txt`, `cleanup-state-inspection.txt` | Proves stale states resolve to terminal states |

---

## Archive Checks

| # | Check | Command | Expected |
|---|---|---|---|
| 1 | Archive exists | `ls exports/proofs/aldaro-proof-evidence-YYYY-MM-DD.tar.gz` | File exists |
| 2 | Archive is not empty | `tar tzf exports/proofs/aldaro-proof-evidence-YYYY-MM-DD.tar.gz \| wc -l` | > 20 entries |
| 3 | Top-level manifest included | `tar tzf ... \| grep manifest.json` | At least 1 match |
| 4 | Results file included | `tar tzf ... \| grep proof-results.txt` | 1 match |
| 5 | Archive extracts cleanly | `tar xzf ... -C /tmp/proof-verify/ && ls /tmp/proof-verify/YYYY-MM-DD/` | 7 dirs + results + manifest |

---

## Go/No-Go from Evidence Pack

| Condition | Decision |
|---|---|
| All 7 proofs PASS + all archive checks pass | **GO**, evidence pack is launch-grade |
| Any proof FAIL | **NO-GO**, identify failure, remediate, re-run that proof |
| Any proof SKIP | **CONDITIONAL**, document why skipped, get founder sign-off |
| Missing evidence files for a PASS proof | **INVALID**, re-run proof with proper evidence capture |
| Manifest checksum mismatch | **INVALID**, evidence may be corrupted, re-run |
