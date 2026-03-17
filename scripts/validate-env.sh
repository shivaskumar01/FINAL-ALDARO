#!/usr/bin/env bash
set -euo pipefail

# Environment Validation for Aldaro Staging/Production
#
# Checks all required env vars for API, Worker, and Gateway.
# Performs semantic validation: URL reachability, secret entropy, key mode.
#
# Usage:
#   scripts/validate-env.sh           # Check all services
#   scripts/validate-env.sh api       # Check only API
#   scripts/validate-env.sh worker    # Check only Worker
#   scripts/validate-env.sh gateway   # Check only Gateway
#
# Exit codes:
#   0 = all checks pass
#   1 = one or more checks failed

SCOPE="${1:-all}"
ERRORS=0
WARNINGS=0

red() { printf "\033[0;31m%s\033[0m\n" "$1"; }
green() { printf "\033[0;32m%s\033[0m\n" "$1"; }
yellow() { printf "\033[0;33m%s\033[0m\n" "$1"; }

check_var() {
  local name="$1"
  local value="${!name:-}"
  local required="${2:-true}"

  if [ -z "$value" ]; then
    if [ "$required" = "true" ]; then
      red "FAIL: $name is not set"
      ERRORS=$((ERRORS + 1))
    else
      yellow "WARN: $name is not set (optional)"
      WARNINGS=$((WARNINGS + 1))
    fi
    return 1
  fi
  green "OK:   $name is set"
  return 0
}

check_url_reachable() {
  local name="$1"
  local url="${!name:-}"
  if [ -z "$url" ]; then return 1; fi

  if curl -s -o /dev/null -w "" --connect-timeout 5 "$url" 2>/dev/null; then
    green "OK:   $name ($url) is reachable"
  else
    red "FAIL: $name ($url) is NOT reachable"
    ERRORS=$((ERRORS + 1))
  fi
}

check_secret_entropy() {
  local name="$1"
  local value="${!name:-}"
  local min_length="${2:-16}"

  if [ -z "$value" ]; then return 1; fi

  local len=${#value}
  if [ "$len" -lt "$min_length" ]; then
    red "FAIL: $name is too short ($len chars, need $min_length+)"
    ERRORS=$((ERRORS + 1))
    return 1
  fi

  # Check for obvious placeholders
  if echo "$value" | grep -qiE '^(password|secret|changeme|test|xxx|placeholder)$'; then
    red "FAIL: $name appears to be a placeholder value"
    ERRORS=$((ERRORS + 1))
    return 1
  fi

  green "OK:   $name has adequate entropy ($len chars)"
}

check_stripe_test_mode() {
  local name="$1"
  local value="${!name:-}"
  if [ -z "$value" ]; then return 1; fi

  if echo "$value" | grep -q "^sk_test_\|^pk_test_\|^rk_test_"; then
    green "OK:   $name is in test mode"
  elif echo "$value" | grep -q "^sk_live_\|^pk_live_\|^rk_live_"; then
    red "FAIL: $name is a LIVE key — must use test keys for staging"
    ERRORS=$((ERRORS + 1))
  else
    yellow "WARN: $name does not match expected Stripe key format"
    WARNINGS=$((WARNINGS + 1))
  fi
}

check_postgres_url() {
  local name="$1"
  local url="${!name:-}"
  if [ -z "$url" ]; then return 1; fi

  if echo "$url" | grep -q "^postgresql://\|^postgres://"; then
    green "OK:   $name has valid Postgres URL format"
  else
    red "FAIL: $name does not look like a Postgres URL"
    ERRORS=$((ERRORS + 1))
    return 1
  fi

  # Try to connect
  if psql "$url" -c "SELECT 1" > /dev/null 2>&1; then
    green "OK:   $name database is reachable"
  else
    red "FAIL: $name database is NOT reachable"
    ERRORS=$((ERRORS + 1))
  fi
}

echo "=== Aldaro Environment Validation ==="
echo "Scope: $SCOPE"
echo "Time:  $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# --- API ---
if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "api" ]; then
  echo "--- API Service ---"
  check_var DATABASE_URL
  check_postgres_url DATABASE_URL
  check_var JWT_ACCESS_SECRET
  check_secret_entropy JWT_ACCESS_SECRET 32
  check_var JWT_REFRESH_SECRET
  check_secret_entropy JWT_REFRESH_SECRET 32
  check_var GATEWAY_SERVICE_SECRET
  check_secret_entropy GATEWAY_SERVICE_SECRET 16
  check_var GATEWAY_INTERNAL_URL false || true
  check_var STRIPE_SECRET_KEY false || true
  if [ -n "${STRIPE_SECRET_KEY:-}" ]; then
    check_stripe_test_mode STRIPE_SECRET_KEY
  fi
  check_var STRIPE_WEBHOOK_SECRET false || true
  check_var CSRF_SECRET false || true
  check_secret_entropy CSRF_SECRET 16 2>/dev/null || true
  check_var ALLOWED_ORIGINS false || true
  echo ""
fi

# --- Worker ---
if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "worker" ]; then
  echo "--- Worker Service ---"
  check_var DATABASE_URL
  check_var PROXMOX_API_URL false || true
  if [ -n "${PROXMOX_API_URL:-}" ]; then
    check_url_reachable PROXMOX_API_URL
  fi
  check_var PROXMOX_API_TOKEN_ID false || true
  check_var PROXMOX_API_TOKEN_SECRET false || true
  check_var GATEWAY_SERVICE_SECRET
  check_var GATEWAY_INTERNAL_URL false || true
  check_var ALDARO_AGENT_SHARED_SECRET false || true
  check_secret_entropy ALDARO_AGENT_SHARED_SECRET 16 2>/dev/null || true
  echo ""
fi

# --- Gateway ---
if [ "$SCOPE" = "all" ] || [ "$SCOPE" = "gateway" ]; then
  echo "--- Gateway Service ---"
  check_var DATABASE_URL
  check_var GATEWAY_SERVICE_SECRET
  check_secret_entropy GATEWAY_SERVICE_SECRET 16
  check_var GATEWAY_PORT false || true
  check_var GATEWAY_HOST false || true
  echo ""
fi

# --- Summary ---
echo "=== Validation Summary ==="
echo "Errors:   $ERRORS"
echo "Warnings: $WARNINGS"

if [ "$ERRORS" -gt 0 ]; then
  red "RESULT: FAIL ($ERRORS errors)"
  exit 1
else
  if [ "$WARNINGS" -gt 0 ]; then
    yellow "RESULT: PASS with warnings ($WARNINGS warnings)"
  else
    green "RESULT: PASS"
  fi
  exit 0
fi
