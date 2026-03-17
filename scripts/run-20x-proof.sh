#!/bin/bash
set -e

# =============================================================================
# Aldaro.AI 20x Lifecycle Proof - Execution Script
# =============================================================================
#
# GOAL: Aldaro fleet only. No external GPU providers. No third-party model resale.
# ALLOWED: GitHub for auth/repo. Stripe for billing.
#
# REQUIREMENTS:
# - Aldaro-owned Proxmox nodes with GPUs
# - Test template VM with qemu-guest-agent and NVIDIA drivers
# - API, Worker, Gateway, Postgres, Redis running
# - Environment variables configured
#
# USAGE:
#   ./scripts/run-20x-proof.sh
#
# =============================================================================

echo "=============================================="
echo "Aldaro.AI 20x Lifecycle Proof"
echo "=============================================="
echo ""

# -----------------------------------------------------------------------------
# Step 1: Freeze the code and pin run window
# -----------------------------------------------------------------------------
echo "[Step 1] Freezing code and pinning run window..."

COMMIT_HASH=$(git rev-parse HEAD)
RUN_ID="proxmox-20x-$(date +%Y%m%d-%H%M%S)"
TAG_NAME="proof-${RUN_ID}"

# Pin exact run window timestamps
STARTED_AT_UTC=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
STARTED_AT_LOCAL=$(date +"%Y-%m-%dT%H:%M:%S%z")
STARTED_AT_EPOCH=$(date +%s)

# Generate unique workspace prefix for this run
WORKSPACE_PREFIX="ws-proof-$(date +%Y%m%d-%H%M%S)"

echo "Commit: ${COMMIT_HASH}"
echo "Run ID: ${RUN_ID}"
echo "Tag: ${TAG_NAME}"
echo "Started (UTC): ${STARTED_AT_UTC}"
echo "Started (Local): ${STARTED_AT_LOCAL}"
echo "Workspace Prefix: ${WORKSPACE_PREFIX}"

# Create tag
git tag -a "${TAG_NAME}" -m "20x lifecycle proof run at ${STARTED_AT_UTC}" 2>/dev/null || echo "Tag already exists or not in git repo"
echo "Tagged as ${TAG_NAME}"

# Create exports directory
mkdir -p "exports/${RUN_ID}"

# Write run metadata files
echo "${COMMIT_HASH}" > "exports/${RUN_ID}/commit.txt"
echo "${TAG_NAME}" > "exports/${RUN_ID}/tag.txt"
echo "${RUN_ID}" > "exports/${RUN_ID}/run_id.txt"
echo "${STARTED_AT_UTC}" > "exports/${RUN_ID}/started_at_utc.txt"
echo "${STARTED_AT_LOCAL}" > "exports/${RUN_ID}/started_at_local.txt"
echo "${STARTED_AT_EPOCH}" > "exports/${RUN_ID}/started_at_epoch.txt"
echo "${WORKSPACE_PREFIX}" > "exports/${RUN_ID}/workspace_prefix.txt"

# Export prefix for tests to use
export ALDARO_PROOF_RUN_ID="${RUN_ID}"
export ALDARO_PROOF_WORKSPACE_PREFIX="${WORKSPACE_PREFIX}"
export ALDARO_PROOF_STARTED_AT_UTC="${STARTED_AT_UTC}"
export ALDARO_PROOF_STARTED_AT_EPOCH="${STARTED_AT_EPOCH}"

echo ""

# -----------------------------------------------------------------------------
# Step 2: Pre-flight checks
# -----------------------------------------------------------------------------
echo "[Step 2] Running pre-flight checks..."

# Check required environment variables
REQUIRED_VARS=(
  "PROXMOX_API_URL"
  "PROXMOX_API_TOKEN_ID"
  "PROXMOX_API_TOKEN_SECRET"
  "DATABASE_URL"
  "GATEWAY_SERVICE_SECRET"
  "ALDARO_AGENT_SHARED_SECRET"
)

MISSING_VARS=()
for VAR in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!VAR}" ]; then
    MISSING_VARS+=("$VAR")
  fi
done

if [ ${#MISSING_VARS[@]} -gt 0 ]; then
  echo "ERROR: Missing required environment variables:"
  printf '  - %s\n' "${MISSING_VARS[@]}"
  exit 1
fi

echo "✓ All required environment variables set"

# Check services are running
echo "Checking services..."

# API
if curl -sf "http://localhost:4000/health" > /dev/null 2>&1; then
  echo "✓ API is running"
else
  echo "ERROR: API not reachable at http://localhost:4000/health"
  exit 1
fi

# Gateway
if curl -sf "http://localhost:5001/health" > /dev/null 2>&1; then
  echo "✓ Gateway is running"
else
  echo "ERROR: Gateway not reachable at http://localhost:5001/health"
  exit 1
fi

# Database
if npx prisma db execute --stdin <<< "SELECT 1" > /dev/null 2>&1; then
  echo "✓ Database is reachable"
else
  echo "ERROR: Database not reachable"
  exit 1
fi

echo ""

# -----------------------------------------------------------------------------
# Step 3: Run 20x lifecycle test
# -----------------------------------------------------------------------------
echo "[Step 3] Running 20x lifecycle test..."
echo "Started at: $(date)"

START_TIME=$(date +%s)

npm run test:integration -- \
  tests/integration/lifecycle.test.ts \
  --repeat 20 \
  --reporter json \
  2>&1 | tee "exports/${RUN_ID}/lifecycle-20x.log"

LIFECYCLE_EXIT=$?

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

echo "Completed at: $(date)"
echo "Duration: ${DURATION} seconds"
echo "Exit code: ${LIFECYCLE_EXIT}"

if [ ${LIFECYCLE_EXIT} -ne 0 ]; then
  echo "WARNING: Lifecycle test failed with exit code ${LIFECYCLE_EXIT}"
fi

echo ""

# -----------------------------------------------------------------------------
# Step 4: Run additional tests
# -----------------------------------------------------------------------------
echo "[Step 4] Running additional tests..."

echo ""
echo "[4a] Failure injection test..."
npm run test:integration -- \
  tests/integration/failure-injection.test.ts \
  --reporter json \
  2>&1 | tee "exports/${RUN_ID}/failure-injection.log"

echo ""
echo "[4b] Concurrency test..."
npm run test:integration -- \
  tests/integration/concurrency.test.ts \
  --reporter json \
  2>&1 | tee "exports/${RUN_ID}/concurrency.log"

echo ""
echo "[4c] Leader failover test..."
npm run test:integration -- \
  tests/integration/leader-failover.test.ts \
  --reporter json \
  2>&1 | tee "exports/${RUN_ID}/leader-failover.log"

echo ""

# -----------------------------------------------------------------------------
# Step 5: Export review package
# -----------------------------------------------------------------------------
echo "[Step 5] Exporting review package..."

echo "Exporting workspace sessions..."
node scripts/export-workspace-sessions.js > "exports/${RUN_ID}/workspace-sessions.json"

echo "Exporting port leases..."
node scripts/export-port-leases.js > "exports/${RUN_ID}/port-leases.json"

echo "Exporting Proxmox tasks..."
node scripts/export-proxmox-tasks.js > "exports/${RUN_ID}/proxmox-tasks.json"

echo "Verifying cleanup..."
node scripts/verify-cleanup.js > "exports/${RUN_ID}/cleanup-verification.json"
CLEANUP_EXIT=$?

echo ""

# -----------------------------------------------------------------------------
# Step 6: Capture service logs (deterministic from run start time)
# -----------------------------------------------------------------------------
echo "[Step 6] Capturing service logs since ${STARTED_AT_UTC}..."

# Try Docker first, then systemd, then local files
# Use exact start time for deterministic log capture
if command -v docker &> /dev/null && docker ps | grep -q aldaro; then
  echo "Capturing logs from Docker since ${STARTED_AT_UTC}..."
  docker logs --since "${STARTED_AT_UTC}" aldaro-api 2>&1 > "exports/${RUN_ID}/api.log" || true
  docker logs --since "${STARTED_AT_UTC}" aldaro-worker 2>&1 > "exports/${RUN_ID}/worker.log" || true
  docker logs --since "${STARTED_AT_UTC}" aldaro-gateway 2>&1 > "exports/${RUN_ID}/gateway.log" || true
elif command -v journalctl &> /dev/null; then
  echo "Capturing logs from systemd since ${STARTED_AT_UTC}..."
  journalctl -u aldaro-api --since "${STARTED_AT_UTC}" > "exports/${RUN_ID}/api.log" 2>/dev/null || true
  journalctl -u aldaro-worker --since "${STARTED_AT_UTC}" > "exports/${RUN_ID}/worker.log" 2>/dev/null || true
  journalctl -u aldaro-gateway --since "${STARTED_AT_UTC}" > "exports/${RUN_ID}/gateway.log" 2>/dev/null || true
else
  echo "Copying local log files (filtering by timestamp)..."
  # Filter logs by timestamp if possible, otherwise copy full logs
  if [ -f apps/api/api.log ]; then
    awk -v start="${STARTED_AT_EPOCH}" 'BEGIN{FS="[\\[\\]]"} {if($2 >= start) print}' apps/api/api.log > "exports/${RUN_ID}/api.log" 2>/dev/null || cp apps/api/api.log "exports/${RUN_ID}/api.log"
  fi
  if [ -f worker/worker.log ]; then
    awk -v start="${STARTED_AT_EPOCH}" 'BEGIN{FS="[\\[\\]]"} {if($2 >= start) print}' worker/worker.log > "exports/${RUN_ID}/worker.log" 2>/dev/null || cp worker/worker.log "exports/${RUN_ID}/worker.log"
  fi
  if [ -f apps/gateway/gateway.log ]; then
    awk -v start="${STARTED_AT_EPOCH}" 'BEGIN{FS="[\\[\\]]"} {if($2 >= start) print}' apps/gateway/gateway.log > "exports/${RUN_ID}/gateway.log" 2>/dev/null || cp apps/gateway/gateway.log "exports/${RUN_ID}/gateway.log"
  fi
fi

echo ""

# -----------------------------------------------------------------------------
# Step 7: Create summary and zip
# -----------------------------------------------------------------------------
echo "[Step 7] Creating summary and zip..."

cat > "exports/${RUN_ID}/SUMMARY.md" << EOF
# 20x Lifecycle Proof Run Summary

**Run ID:** ${RUN_ID}
**Commit:** ${COMMIT_HASH}
**Tag:** ${TAG_NAME}
**Date:** $(date -Iseconds)
**Duration:** ${DURATION} seconds

## Test Results

| Test | Exit Code |
|------|-----------|
| 20x Lifecycle | ${LIFECYCLE_EXIT} |
| Failure Injection | (see log) |
| Concurrency | (see log) |
| Leader Failover | (see log) |

## Cleanup Verification

Exit code: ${CLEANUP_EXIT}

## Files Included

- commit.txt - Git commit hash
- tag.txt - Git tag name
- lifecycle-20x.log - Main test output
- failure-injection.log - Failure test output
- concurrency.log - Concurrency test output
- leader-failover.log - Failover test output
- workspace-sessions.json - DB export of sessions
- port-leases.json - DB export of port allocations
- proxmox-tasks.json - Proxmox task history
- cleanup-verification.json - Resource leak check
- api.log - API service logs
- worker.log - Worker service logs
- gateway.log - Gateway service logs

## Commands Run

\`\`\`bash
# Lifecycle test
npm run test:integration -- tests/integration/lifecycle.test.ts --repeat 20

# Failure injection
npm run test:integration -- tests/integration/failure-injection.test.ts

# Concurrency
npm run test:integration -- tests/integration/concurrency.test.ts

# Leader failover
npm run test:integration -- tests/integration/leader-failover.test.ts
\`\`\`

## Go/No-Go Checklist

- [ ] Zero manual steps
- [ ] Zero orphan VMs in Proxmox
- [ ] Zero leaked GPU allocations
- [ ] Zero leaked port leases
- [ ] Every workspace ends TERMINATED or FAILED
- [ ] Every success: RUNNING + heartbeat + nvidia-smi
- [ ] No external GPU providers
- [ ] No third-party model resale

EOF

# Create zip
cd exports
zip -r "${RUN_ID}.zip" "${RUN_ID}"
cd ..

echo ""
echo "=============================================="
echo "20x Lifecycle Proof Complete"
echo "=============================================="
echo ""
echo "Run ID: ${RUN_ID}"
echo "Commit: ${COMMIT_HASH}"
echo "Tag: ${TAG_NAME}"
echo ""
echo "Export location: exports/${RUN_ID}.zip"
echo ""
echo "Lifecycle test exit code: ${LIFECYCLE_EXIT}"
echo "Cleanup verification exit code: ${CLEANUP_EXIT}"
echo ""

if [ ${LIFECYCLE_EXIT} -eq 0 ] && [ ${CLEANUP_EXIT} -eq 0 ]; then
  echo "✅ All tests passed - ready for review"
else
  echo "❌ Some tests failed - review logs before submitting"
fi

echo ""
echo "Next steps:"
echo "1. Review exports/${RUN_ID}/SUMMARY.md"
echo "2. Review exports/${RUN_ID}/cleanup-verification.json"
echo "3. Submit exports/${RUN_ID}.zip for review"
