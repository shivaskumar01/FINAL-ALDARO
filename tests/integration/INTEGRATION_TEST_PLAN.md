# Aldaro.AI Integration Test Plan

**Launch Blocker:** Proxmox integration proof on real hardware  
**Requirement:** 20 consecutive lifecycle runs with zero manual intervention

---

## Review Package Deliverables

After the 20x run, provide:

| # | Deliverable | Format |
|---|-------------|--------|
| 1 | Git commit hash tested | `git rev-parse HEAD` |
| 2 | Command for 20x test | Shell command |
| 3 | Worker logs (full window) | `worker/logs/integration-test-*.log` |
| 4 | API logs (same window) | `api/logs/integration-test-*.log` |
| 5 | Proxmox task export | JSON: `[{upid, status, start, end}]` |
| 6 | DB workspace session export | CSV/JSON: workspace_id, start, end, billed_seconds, status |
| 7 | Port lease export | JSON: `[{workspace_id, ssh_port, jupyter_port, vscode_port, allocated_at, released_at}]` |

---

## Go/No-Go Rules

### Hard Requirements (ALL must pass)

| Rule | Verification |
|------|--------------|
| Zero manual steps | Fully automated script |
| Zero orphan VMs in Proxmox | `pvesh get /nodes/{node}/qemu` shows no aldaro-* VMs after cleanup |
| Zero leaked GPU allocations | `SELECT * FROM fleet_gpus WHERE status = 'ALLOCATED'` returns 0 |
| Zero leaked port leases | `SELECT * FROM workspace_endpoints WHERE released_at IS NULL` returns 0 |
| Every workspace TERMINATED or FAILED | No CREATING, RUNNING, TERMINATING stuck states |
| Every success: RUNNING + heartbeat + nvidia-smi | Agent callback received, GPU verified |

---

## Test Suite

### Test 1: Happy Path (20x Consecutive Runs)

```bash
# Command
npm run test:integration -- --grep "lifecycle" --repeat 20 --bail

# What it does per iteration:
# 1. Create workspace request
# 2. Wait for WARM_AVAILABLE or cold provision
# 3. Verify RUNNING_ASSIGNED
# 4. Verify agent heartbeat received
# 5. SSH to workspace, run nvidia-smi
# 6. Terminate workspace
# 7. Verify TERMINATED
# 8. Verify GPU FREE
# 9. Verify ports released
```

### Test 2: Failure Injection

| Failure Mode | Injection Method | Expected Outcome |
|--------------|------------------|------------------|
| Clone failure | Mock Proxmox API 500 | Workspace FAILED, GPU FREE, no orphan VM |
| GPU attach failure | Invalid PCI address | Workspace FAILED, VM deleted, no leaked GPU |
| Guest agent missing | Boot VM without qemu-guest-agent | Timeout → FAILED, full cleanup |
| Agent never registers | Agent process killed | Heartbeat timeout → FAILED, full cleanup |

```bash
npm run test:integration -- --grep "failure injection"
```

### Test 3: Concurrency (5 Simultaneous Requests)

```bash
npm run test:integration -- --grep "concurrency" --concurrency 5
```

| Check | Pass Criteria |
|-------|---------------|
| Warm pool assignment | First N (up to warm count) assigned in <30s |
| Cold provisioning | Remaining requests provision correctly |
| No double-assignment | Each warm workspace assigned to exactly one user |
| GPU allocation | No GPU assigned to multiple workspaces |

### Test 4: Leader Failover

```bash
npm run test:integration -- --grep "leader failover"
```

| Step | Action |
|------|--------|
| 1 | Start worker, begin provisioning |
| 2 | Mid-provision (after clone, before GPU attach), kill -9 worker |
| 3 | Restart worker |
| 4 | Verify: single leader resumes |
| 5 | Verify: no duplicate VM clones |
| 6 | Verify: workspace completes or fails cleanly |

---

## Policy Enforcement (Code Review Checklist)

Before merge, reviewer must verify:

- [ ] **Aldaro-owned GPUs only** - No external provider adapters in runtime paths
- [ ] **No feature flags for external providers** - No `ENABLE_RUNPOD=true` or similar
- [ ] **No hosted model resale** - No OpenAI/Anthropic/etc. API calls
- [ ] **GitHub limited** - Only OAuth + repo access, no GitHub Actions compute
- [ ] **Stripe limited** - Only payments/billing, no Stripe Identity or other services

---

## Test Execution Instructions

### Prerequisites

1. Real Proxmox cluster with:
   - At least 1 node with GPUs
   - VM template configured
   - qemu-guest-agent in template
   - Network configured for DHCP

2. Environment variables:
   ```bash
   export PROXMOX_API_URL=https://proxmox.aldaro.internal:8006
   export PROXMOX_API_TOKEN_ID=aldaro@pam!integration
   export PROXMOX_API_TOKEN_SECRET=<token>
   export DATABASE_URL=postgresql://...
   export GATEWAY_SERVICE_SECRET=<secret>
   export ALDARO_AGENT_SHARED_SECRET=<secret>
   ```

3. Clean database state:
   ```bash
   npm run db:reset
   npm run db:seed
   ```

### Run Full Suite

```bash
# Record git commit
git rev-parse HEAD > test-results/commit.txt

# Start services with logging
npm run api:start -- --log-file api/logs/integration-test-$(date +%s).log &
npm run worker:start -- --log-file worker/logs/integration-test-$(date +%s).log &
npm run gateway:start &

# Wait for services
sleep 10

# Run 20x lifecycle test
npm run test:integration -- --grep "lifecycle" --repeat 20 --reporter json > test-results/lifecycle-20x.json

# Run failure injection
npm run test:integration -- --grep "failure injection" --reporter json > test-results/failure-injection.json

# Run concurrency test
npm run test:integration -- --grep "concurrency" --reporter json > test-results/concurrency.json

# Run leader failover test
npm run test:integration -- --grep "leader failover" --reporter json > test-results/leader-failover.json

# Export Proxmox tasks
node scripts/export-proxmox-tasks.js > test-results/proxmox-tasks.json

# Export DB sessions
node scripts/export-workspace-sessions.js > test-results/workspace-sessions.json

# Export port leases
node scripts/export-port-leases.js > test-results/port-leases.json

# Verify cleanup
node scripts/verify-cleanup.js
```

---

## Expected Output Structure

```
test-results/
├── commit.txt                  # Git commit hash
├── lifecycle-20x.json          # 20x run results
├── failure-injection.json      # Failure mode results
├── concurrency.json            # 5x concurrent results
├── leader-failover.json        # Failover results
├── proxmox-tasks.json          # UPID list with status
├── workspace-sessions.json     # Start, end, billed_seconds, status
├── port-leases.json            # Allocate/release timestamps
└── cleanup-verification.json   # Final state verification
```

---

## Sign-Off Criteria

| Criterion | Required |
|-----------|----------|
| 20x lifecycle: 100% pass | Yes |
| Failure injection: 100% cleanup | Yes |
| Concurrency: No race conditions | Yes |
| Leader failover: Single writer | Yes |
| Zero orphan resources | Yes |
| Policy compliance | Yes |

**Approver:** _______________  
**Date:** _______________  
**Commit:** _______________
