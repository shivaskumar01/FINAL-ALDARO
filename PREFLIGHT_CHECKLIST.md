# Aldaro.AI Pre-Flight Checklist

**Goal Lock-in**: Aldaro fleet only. No external GPU providers. No third-party model resale.
**Allowed**: GitHub for auth and repo access. Stripe for billing.

Run this checklist before executing `run-20x-proof.sh`.

---

## 1. Code Freeze

- [ ] All changes committed
- [ ] Tag created: `git tag -a proof-YYYYMMDD-HHMMSS -m "description"`
- [ ] No uncommitted changes: `git status` shows clean
- [ ] Record commit hash: `git rev-parse HEAD`

---

## 2. Template Readiness

**Critical**: Template VM must be properly configured or tests will fail.

- [ ] **qemu-guest-agent enabled and running**
  ```bash
  # On template VM
  systemctl status qemu-guest-agent
  # Should show: active (running)
  ```

- [ ] **Cloud-init enabled**
  ```bash
  # Verify cloud-init is installed and will run
  cloud-init status
  # Should show: status: done
  ```

- [ ] **NVIDIA driver pinned and working**
  ```bash
  # On template VM
  nvidia-smi
  # Should show GPU details without errors
  
  # Verify driver version is pinned
  apt-mark showhold | grep nvidia
  ```

- [ ] **Aldaro agent bootstrap path works**
  ```bash
  # Verify agent binary/script exists at expected path
  ls -la /opt/aldaro/agent
  # Or wherever the agent is configured to bootstrap
  ```

- [ ] **SSH key injection works**
  ```bash
  # Test cloud-init SSH key injection
  # After clone, verify ~/.ssh/authorized_keys is populated
  ```

---

## 3. GPU Passthrough Verification

**Proof requirement**: One manual clone proves hostpci attach works.

- [ ] **Manual clone test completed**
  ```bash
  # From Proxmox CLI or UI:
  qm clone <template_vmid> <test_vmid> --name test-gpu-passthrough
  
  # Attach GPU
  qm set <test_vmid> -hostpci0 <pci_address>,pcie=1
  
  # Start VM
  qm start <test_vmid>
  
  # SSH in and verify
  nvidia-smi
  # Should show the attached GPU
  ```

- [ ] **PCI addresses recorded in database**
  ```sql
  SELECT id, node_id, gpu_type, pci_address, status 
  FROM fleet_gpus 
  WHERE status = 'FREE';
  ```

- [ ] **IOMMU enabled on host**
  ```bash
  # On Proxmox node
  dmesg | grep -i iommu
  # Should show IOMMU enabled
  ```

---

## 4. Network Configuration

- [ ] **Gateway can reach tenant VMs**
  ```bash
  # From gateway host, ping a test VM internal IP
  ping <vm_internal_ip>
  ```

- [ ] **Tenant VMs cannot talk to each other**
  ```bash
  # From VM A, try to reach VM B
  ping <vm_b_internal_ip>
  # Should fail or timeout
  ```

- [ ] **Proxmox API reachable only from worker**
  ```bash
  # From worker host
  curl -k https://<proxmox_ip>:8006/api2/json/version
  # Should return version info
  
  # From other hosts, should be blocked by firewall
  ```

- [ ] **Port range available for allocation**
  ```bash
  # Verify port range is free (e.g., 30000-32000)
  ss -tlnp | grep -E '3[0-2][0-9]{3}'
  # Should be empty
  ```

---

## 5. Database State

- [ ] **Migrations applied cleanly**
  ```bash
  npx prisma migrate status
  # Should show all migrations applied
  ```

- [ ] **Seed data exists for gpuTypes**
  ```sql
  SELECT * FROM gpu_type_configs;
  -- Should have entries for RTX_4090, A100, etc.
  ```

- [ ] **Templates seeded**
  ```sql
  SELECT * FROM vm_templates;
  -- Should have template per gpuType/region
  ```

- [ ] **Warm pool defaults configured**
  ```sql
  SELECT * FROM warm_pool_configs;
  -- Should have min/max values per gpuType
  ```

- [ ] **Fleet nodes registered**
  ```sql
  SELECT * FROM fleet_nodes WHERE status = 'ONLINE';
  -- Should show your Proxmox nodes
  ```

- [ ] **GPUs registered and FREE**
  ```sql
  SELECT COUNT(*) as free_gpus FROM fleet_gpus WHERE status = 'FREE';
  -- Should be >= 5 for concurrency tests
  ```

- [ ] **No leftover allocations from previous runs**
  ```sql
  SELECT COUNT(*) FROM fleet_gpus WHERE status IN ('ALLOCATED', 'RESERVED');
  -- Should be 0
  
  SELECT COUNT(*) FROM workspace_endpoints WHERE released_at IS NULL;
  -- Should be 0
  ```

---

## 6. Secrets Configuration

**Critical**: No defaults allowed. All secrets must be production-grade.

- [ ] **JWT secrets set and strong (>=32 chars)**
  ```bash
  echo ${#JWT_ACCESS_SECRET}  # Should be >= 32
  echo ${#JWT_REFRESH_SECRET} # Should be >= 32
  ```

- [ ] **Agent shared secret set**
  ```bash
  [ -n "$ALDARO_AGENT_SHARED_SECRET" ] && echo "Set" || echo "MISSING"
  ```

- [ ] **Gateway service secret set**
  ```bash
  [ -n "$GATEWAY_SERVICE_SECRET" ] && echo "Set" || echo "MISSING"
  ```

- [ ] **Proxmox credentials set**
  ```bash
  [ -n "$PROXMOX_API_URL" ] && echo "Set" || echo "MISSING"
  [ -n "$PROXMOX_API_TOKEN_ID" ] && echo "Set" || echo "MISSING"
  [ -n "$PROXMOX_API_TOKEN_SECRET" ] && echo "Set" || echo "MISSING"
  ```

- [ ] **Stripe keys set (for billing tests)**
  ```bash
  [ -n "$STRIPE_SECRET_KEY" ] && echo "Set" || echo "MISSING"
  [ -n "$STRIPE_WEBHOOK_SECRET" ] && echo "Set" || echo "MISSING"
  ```

- [ ] **No .env files in repo**
  ```bash
  find . -name ".env*" -not -name ".env.example" | wc -l
  # Should be 0
  ```

---

## 7. Services Health

- [ ] **API responding**
  ```bash
  curl http://localhost:4000/health
  # Should return {"status":"ok"}
  ```

- [ ] **Worker running (single instance)**
  ```bash
  # Check only ONE worker process
  pgrep -f "worker" | wc -l
  # Should be 1
  ```

- [ ] **Gateway responding**
  ```bash
  curl http://localhost:5001/health
  # Should return {"status":"ok"}
  ```

- [ ] **Database connected**
  ```bash
  npx prisma db execute --stdin <<< "SELECT 1"
  # Should succeed
  ```

- [ ] **Proxmox API accessible from worker**
  ```bash
  curl -k -H "Authorization: PVEAPIToken=$PROXMOX_API_TOKEN_ID=$PROXMOX_API_TOKEN_SECRET" \
    "$PROXMOX_API_URL/api2/json/version"
  # Should return version info
  ```

---

## 8. Test User Setup

- [ ] **Integration test user exists**
  ```sql
  SELECT id, email, max_active_workspaces 
  FROM users 
  WHERE email = 'integration-test@aldaro.ai';
  ```

- [ ] **User has sufficient workspace quota**
  ```sql
  -- max_active_workspaces should be >= 10 for concurrency tests
  ```

---

## 9. Logging Configuration

- [ ] **Log level set to debug/info for proof run**
  ```bash
  echo $LOG_LEVEL
  # Should be 'debug' or 'info'
  ```

- [ ] **Logs are being written**
  ```bash
  # Check API logs
  tail -5 apps/api/api.log || journalctl -u aldaro-api -n 5
  
  # Check Worker logs  
  tail -5 worker/worker.log || journalctl -u aldaro-worker -n 5
  ```

---

## 10. Final Verification

Run the automated preflight check:

```bash
npm run preflight
# OR
node scripts/preflight-check.js
```

All checks must pass before proceeding with `./scripts/run-20x-proof.sh`.

---

## Quick Reference: Environment Variables Required

```bash
# Database
DATABASE_URL=postgresql://...

# Proxmox
PROXMOX_API_URL=https://<node>:8006
PROXMOX_API_TOKEN_ID=<user>@<realm>!<token-name>
PROXMOX_API_TOKEN_SECRET=<token-secret>

# Auth
JWT_ACCESS_SECRET=<min-32-chars>
JWT_REFRESH_SECRET=<min-32-chars>
GITHUB_CLIENT_ID=<from-github>
GITHUB_CLIENT_SECRET=<from-github>

# Internal Services
ALDARO_AGENT_SHARED_SECRET=<min-32-chars>
GATEWAY_SERVICE_SECRET=<min-32-chars>
GATEWAY_INTERNAL_URL=http://localhost:5001

# Billing
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Runtime
NODE_ENV=production  # Or 'development' for local testing
LOG_LEVEL=debug
```
