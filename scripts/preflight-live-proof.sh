#!/usr/bin/env bash
set -euo pipefail

# Pre-flight check for live proof execution.
# Verifies everything needed before running the proof pack.
#
# Usage:
#   scripts/preflight-live-proof.sh
#
# Checks:
#   1. Environment variables (calls validate-env.sh)
#   2. Service health (API, Gateway, Worker)
#   3. Fleet inventory (nodes, GPUs, templates, SKUs)
#   4. Clean state (no orphan resources)
#   5. Evidence directory writable
#
# Exit codes:
#   0 = ready for proof execution
#   1 = one or more checks failed

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ERRORS=0

red() { printf "\033[0;31m%s\033[0m\n" "$1"; }
green() { printf "\033[0;32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[0;33m%s\033[0m\n" "$1"; }

section() { echo ""; echo "=== $1 ==="; }

check() {
  local name="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    green "OK:   $name"
  else
    red "FAIL: $name"
    ERRORS=$((ERRORS + 1))
  fi
}

section "1. Environment Validation"
if "$SCRIPT_DIR/validate-env.sh" > /dev/null 2>&1; then
  green "OK:   All env vars valid"
else
  red "FAIL: Environment validation failed — run scripts/validate-env.sh for details"
  ERRORS=$((ERRORS + 1))
fi

section "2. Service Health"

# API
API_URL="${API_URL:-http://localhost:4000}"
API_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$API_URL/health" 2>/dev/null || echo "000")
check "API health ($API_URL)" "$([ "$API_HEALTH" = "200" ] && echo 0 || echo 1)"

# Gateway
GATEWAY_URL="${GATEWAY_URL:-http://localhost:5001}"
GW_HEALTH=$(curl -s -o /dev/null -w "%{http_code}" "$GATEWAY_URL/health" 2>/dev/null || echo "000")
check "Gateway health ($GATEWAY_URL)" "$([ "$GW_HEALTH" = "200" ] && echo 0 || echo 1)"

# Worker (check via DB — worker acquires advisory lock)
if [ -n "${DATABASE_URL:-}" ]; then
  # Check if worker advisory lock is held
  LOCK_HELD=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM pg_locks WHERE locktype = 'advisory';" 2>/dev/null | tr -d ' ')
  check "Worker leader lock held" "$([ "$LOCK_HELD" -gt 0 ] && echo 0 || echo 1)"
else
  red "FAIL: Cannot check worker — DATABASE_URL not set"
  ERRORS=$((ERRORS + 1))
fi

section "3. Fleet Inventory"

if [ -n "${DATABASE_URL:-}" ]; then
  # Nodes
  NODE_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM fleet_nodes WHERE status = 'ACTIVE';" 2>/dev/null | tr -d ' ')
  check "Active fleet nodes ($NODE_COUNT)" "$([ "$NODE_COUNT" -gt 0 ] && echo 0 || echo 1)"

  # Free GPUs
  FREE_GPU=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM fleet_gpus WHERE status = 'FREE';" 2>/dev/null | tr -d ' ')
  check "Free GPUs ($FREE_GPU)" "$([ "$FREE_GPU" -gt 0 ] && echo 0 || echo 1)"

  # Templates
  TEMPLATE_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM vm_templates WHERE enabled = true;" 2>/dev/null | tr -d ' ')
  check "Enabled VM templates ($TEMPLATE_COUNT)" "$([ "$TEMPLATE_COUNT" -gt 0 ] && echo 0 || echo 1)"

  # GPU SKUs with pricing
  SKU_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM gpu_skus WHERE \"pricePerHourCents\" > 0;" 2>/dev/null | tr -d ' ')
  check "GPU SKUs with pricing ($SKU_COUNT)" "$([ "$SKU_COUNT" -gt 0 ] && echo 0 || echo 1)"

  # Warm pool config
  WPC_COUNT=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM warm_pool_config;" 2>/dev/null | tr -d ' ')
  check "Warm pool configs ($WPC_COUNT)" "$([ "$WPC_COUNT" -gt 0 ] && echo 0 || echo 1)"
fi

section "4. Clean State"

if [ -n "${DATABASE_URL:-}" ]; then
  ACTIVE_WS=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM workspaces WHERE status NOT IN ('TERMINATED', 'FAILED');" 2>/dev/null | tr -d ' ')
  check "No active workspaces ($ACTIVE_WS)" "$([ "$ACTIVE_WS" = "0" ] && echo 0 || echo 1)"

  ALLOC_GPU=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM fleet_gpus WHERE status != 'FREE';" 2>/dev/null | tr -d ' ')
  check "All GPUs free ($ALLOC_GPU allocated)" "$([ "$ALLOC_GPU" = "0" ] && echo 0 || echo 1)"

  ORPHAN_EP=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM workspace_endpoints WHERE \"releasedAt\" IS NULL;" 2>/dev/null | tr -d ' ')
  check "No orphan endpoints ($ORPHAN_EP)" "$([ "$ORPHAN_EP" = "0" ] && echo 0 || echo 1)"

  RUNNING_SS=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM usage_sessions WHERE status = 'RUNNING';" 2>/dev/null | tr -d ' ')
  check "No RUNNING sessions ($RUNNING_SS)" "$([ "$RUNNING_SS" = "0" ] && echo 0 || echo 1)"

  PENDING_CJ=$(psql "$DATABASE_URL" -t -c "SELECT COUNT(*) FROM workspace_cleanup_jobs WHERE status NOT IN ('DONE', 'FAILED');" 2>/dev/null | tr -d ' ')
  check "No pending cleanup jobs ($PENDING_CJ)" "$([ "$PENDING_CJ" = "0" ] && echo 0 || echo 1)"
fi

section "5. Evidence Directory"

EVIDENCE_ROOT="exports/proofs/$(date +%Y-%m-%d)"
mkdir -p "$EVIDENCE_ROOT" 2>/dev/null
if [ -w "$EVIDENCE_ROOT" ]; then
  green "OK:   Evidence directory writable ($EVIDENCE_ROOT)"
else
  red "FAIL: Cannot write to evidence directory ($EVIDENCE_ROOT)"
  ERRORS=$((ERRORS + 1))
fi

# --- Summary ---
echo ""
echo "==============================="
if [ "$ERRORS" -gt 0 ]; then
  red "PREFLIGHT: FAIL ($ERRORS issues)"
  echo "Fix all issues before running proofs."
  exit 1
else
  green "PREFLIGHT: PASS — ready for proof execution"
  exit 0
fi
