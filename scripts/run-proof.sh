#!/usr/bin/env bash
set -euo pipefail

# Semi-automated proof runner.
# Runs a single proof with operator prompts, evidence capture, and pass/fail tracking.
#
# Usage:
#   scripts/run-proof.sh <proof-number>
#   scripts/run-proof.sh 01    # Run staging readiness
#   scripts/run-proof.sh 02    # Run billing parity
#   scripts/run-proof.sh all   # Run all proofs in order
#
# Features:
#   - Pre-proof pause for operator to verify preconditions
#   - Evidence directory auto-created
#   - Post-proof pause for operator to evaluate pass/fail
#   - Rollback reminder after each proof
#   - Results logged to manifest

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_DIR"

PROOF_NUM="${1:?Usage: scripts/run-proof.sh <proof-number|all>}"
DATE=$(date +%Y-%m-%d)
RESULTS_FILE="exports/proofs/$DATE/proof-results.txt"

red() { printf "\033[0;31m%s\033[0m\n" "$1"; }
green() { printf "\033[0;32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[0;33m%s\033[0m\n" "$1"; }
bold() { printf "\033[1m%s\033[0m\n" "$1"; }

pause_operator() {
  local message="$1"
  echo ""
  yellow ">>> OPERATOR CHECKPOINT <<<"
  echo "$message"
  echo ""
  read -p "Press ENTER to continue, or Ctrl+C to abort... " _
}

record_result() {
  local proof="$1"
  local result="$2"
  local timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  mkdir -p "$(dirname "$RESULTS_FILE")"
  echo "$timestamp | $proof | $result" >> "$RESULTS_FILE"
}

PROOF_NAMES=(
  "01-staging-readiness"
  "02-billing-parity"
  "03-terminate-outage-recovery"
  "04-last-gpu-contention"
  "05-restore-drill"
  "06-stack-leakage"
  "07-cleanup-durability"
)

# Proof execution order (per docs/proofs/README.md)
PROOF_ORDER=("01" "02" "03" "04" "07" "06" "05")

get_proof_name() {
  local num="$1"
  for name in "${PROOF_NAMES[@]}"; do
    if [[ "$name" == "$num"* ]]; then
      echo "$name"
      return
    fi
  done
  echo ""
}

run_single_proof() {
  local num="$1"
  local proof_name=$(get_proof_name "$num")

  if [ -z "$proof_name" ]; then
    red "Unknown proof number: $num"
    exit 1
  fi

  local proof_doc="docs/proofs/$proof_name.md"
  local evidence_dir="exports/proofs/$DATE/$proof_name"

  echo ""
  bold "=============================================="
  bold "  PROOF: $proof_name"
  bold "  Date:  $DATE"
  bold "=============================================="
  echo ""

  # Check proof doc exists
  if [ ! -f "$proof_doc" ]; then
    red "Proof document not found: $proof_doc"
    exit 1
  fi

  # Create evidence directory
  mkdir -p "$evidence_dir"
  echo "Evidence directory: $evidence_dir"
  echo ""

  # --- PRE-PROOF ---
  bold "--- PRECONDITIONS ---"
  echo "Review the preconditions in: $proof_doc"
  echo ""

  # Show preconditions section from proof doc
  sed -n '/^## Preconditions/,/^---/p' "$proof_doc" | head -30
  echo ""

  pause_operator "Verify all preconditions are met. Have you checked each one?"

  # --- EXECUTION ---
  bold "--- EXECUTION ---"
  echo "Follow the commands in: $proof_doc"
  echo "Save all output to: $evidence_dir/"
  echo ""

  # Source the capture helper
  source scripts/capture-proof-evidence.sh "$proof_name"

  pause_operator "Execute the proof commands now. When done, press ENTER to continue to evaluation."

  # --- EVALUATION ---
  bold "--- PASS/FAIL EVALUATION ---"
  echo "Review the pass/fail rules in: $proof_doc"
  echo ""

  # Show pass/fail section
  sed -n '/^## Pass\/Fail Rules/,/^---/p' "$proof_doc" | head -30
  echo ""

  bold "--- FALSE-PASS WARNINGS ---"
  sed -n '/^## False-Pass Warnings/,/^---/p' "$proof_doc" | head -20
  echo ""

  # Ask operator for result
  echo ""
  bold "What is the result?"
  echo "  [P] PASS — all checks met"
  echo "  [F] FAIL — one or more checks failed"
  echo "  [S] SKIP — proof not applicable or blocked"
  echo ""
  read -p "Result [P/F/S]: " RESULT

  case "${RESULT^^}" in
    P)
      green "PROOF $proof_name: PASS"
      record_result "$proof_name" "PASS"
      ;;
    F)
      red "PROOF $proof_name: FAIL"
      read -p "Failure reason: " FAIL_REASON
      record_result "$proof_name" "FAIL: $FAIL_REASON"
      ;;
    S)
      yellow "PROOF $proof_name: SKIP"
      read -p "Skip reason: " SKIP_REASON
      record_result "$proof_name" "SKIP: $SKIP_REASON"
      ;;
    *)
      yellow "Unknown result: $RESULT"
      record_result "$proof_name" "UNKNOWN: $RESULT"
      ;;
  esac

  # Generate evidence manifest
  finish_capture

  # --- ROLLBACK/CLEANUP ---
  bold "--- ROLLBACK/CLEANUP ---"
  echo "Review cleanup steps in: $proof_doc"
  echo ""
  sed -n '/^## Rollback\/Cleanup/,/^---/p' "$proof_doc" | head -20
  echo ""

  pause_operator "Run cleanup/rollback steps before proceeding to next proof."

  echo ""
  green "Proof $proof_name complete."
  echo ""
}

# --- MAIN ---

if [ "$PROOF_NUM" = "all" ]; then
  bold "Running all proofs in execution order..."
  echo "Order: ${PROOF_ORDER[*]}"
  echo ""

  # Run preflight first
  bold "=== PREFLIGHT CHECK ==="
  if scripts/preflight-live-proof.sh; then
    green "Preflight passed."
  else
    red "Preflight failed. Fix issues before running proofs."
    exit 1
  fi

  for num in "${PROOF_ORDER[@]}"; do
    run_single_proof "$num"
  done

  # Final summary
  echo ""
  bold "=============================================="
  bold "  ALL PROOFS COMPLETE"
  bold "=============================================="
  echo ""
  echo "Results:"
  cat "$RESULTS_FILE"
  echo ""
  echo "Evidence: exports/proofs/$DATE/"
  echo ""

  # Package evidence
  read -p "Package evidence into archive? [y/N]: " PACKAGE
  if [ "${PACKAGE^^}" = "Y" ]; then
    scripts/package-proof-evidence.sh "$DATE"
  fi
else
  run_single_proof "$PROOF_NUM"
fi
