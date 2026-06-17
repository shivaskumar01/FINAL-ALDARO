# Infrastructure Intake Packet

**Purpose**: Everything the infra provider needs to hand over for staging bring-up. One document, one pass.

**Last updated**: 2026-03-13

---

## What We Need (checklist)

Hand this section to whoever controls infra. Every item has a "why" so they can prioritize.

### 1. Proxmox Access (blocks ALL proofs)

| Item | Format | Example | Why |
|---|---|---|---|
| Proxmox host URL | `https://HOST:8006` | `https://pve1.internal:8006` | Worker calls Proxmox API to clone/start/stop/delete VMs |
| API token ID | `user@realm!tokenname` | `aldaro@pve!staging` | Authentication for Proxmox API |
| API token secret | UUID | `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` | Authentication for Proxmox API |
| Node name(s) | String | `pve1`, `pve2` | Worker targets specific nodes for VM operations |

**Verify**: `curl -k -H "Authorization: PVEAPIToken=TOKEN_ID=TOKEN_SECRET" https://HOST:8006/api2/json/version` returns 200.

### 2. GPU PCI Addresses (blocks proofs 02, 03, 04)

| Item | Format | Example | Why |
|---|---|---|---|
| PCI address per GPU | Bus:Device.Function | `0000:41:00.0` | GPU passthrough requires exact PCI addresses |
| GPU model per address | String | `RTX 5090`, `A100 80GB` | Maps to GpuSku pricing table |
| Which node each GPU is in | Node name | `pve1` | fleet_gpus table links GPU to node |

**How to get**: On each Proxmox node, run:
```bash
lspci -nn | grep -i nvidia
# Example output:
# 41:00.0 3D controller [0302]: NVIDIA Corporation ... [10de:2684]
```

### 3. VM Template (blocks proofs 01-04, 07)

| Item | Format | Example | Why |
|---|---|---|---|
| Template VMID | Integer | `9000` | Worker clones this template for new workspaces |
| Template node | Node name | `pve1` | Where the template lives |
| What's installed | Checklist below |, | Agent, CUDA, cloud-init must be pre-installed |

**Template must include**:
- [ ] Ubuntu 22.04 or 24.04
- [ ] NVIDIA drivers + CUDA toolkit
- [ ] cloud-init configured (hostname, network, SSH keys)
- [ ] Aldaro agent installed at `/opt/aldaro/agent/`
- [ ] Python 3.10+ (for agent)
- [ ] SSH server running
- [ ] Ports 8888 (Jupyter), 8080 (VSCode), 22 (SSH) open

### 4. Stripe Test Keys (blocks proof 02)

| Item | Format | Example | Why |
|---|---|---|---|
| Secret key | `sk_test_...` | `sk_test_51abc...` | API sends meter events to Stripe |
| Webhook secret | `whsec_...` | `whsec_abc123...` | API verifies Stripe webhook signatures |
| Publishable key | `pk_test_...` | `pk_test_51abc...` | Frontend Stripe.js (optional for proof) |
| Meter event name | String | `gpu_usage_seconds` | Must match Stripe dashboard meter config |

**Verify**: `curl https://api.stripe.com/v1/customers -u sk_test_YOUR_KEY:` returns customer list.

### 5. DNS / Networking (blocks proofs 01, 06)

| Item | Format | Example | Why |
|---|---|---|---|
| Staging domain | FQDN | `staging.aldaro.ai` | Web frontend |
| API subdomain | FQDN | `api-staging.aldaro.ai` | API endpoint |
| Gateway host | FQDN or IP | `gw1.aldaro.ai` | Port forwarding for SSH/Jupyter/VSCode |
| SSL certificate | cert + key | Let's Encrypt or wildcard | HTTPS required |
| Port range for gateway | Integer range | `10000-20000` | Gateway allocates ports for workspace access |

**Networking rules needed**:
```
# On gateway host
iptables -A INPUT -p tcp --dport 10000:20000 -j ACCEPT   # workspace ports
iptables -A INPUT -p tcp --dport 5001 -j ACCEPT            # gateway API (internal only)

# On Proxmox nodes
# VMs must reach gateway host on port 5001 (internal)
# VMs must be reachable from gateway host on ports 22, 8888, 8080
```

---

## What We Provide Back

Once credentials arrive, we will:

1. Run `scripts/validate-env.sh`, confirms all vars set + semantic checks
2. Run `scripts/preflight-live-proof.sh`, confirms services boot, fleet seed, clean state
3. Seed fleet data:
   - `fleet_nodes`, one row per Proxmox node
   - `fleet_gpus`, one row per GPU with PCI address
   - `vm_templates`, one row per template
   - `gpu_skus`, pricing (already seeded locally)
   - `warm_pool_config`, target counts per region/GPU type
4. Run `scripts/run-proof.sh all`, executes all 7 proofs with evidence capture
5. Package evidence via `scripts/package-proof-evidence.sh`

---

## Seed Data SQL (fill in blanks)

```sql
-- Fleet nodes (one per Proxmox node)
INSERT INTO fleet_nodes (id, name, "proxmoxHost", status, region, "totalGpus", "freeGpus", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), '__NODE_NAME__', '__PROXMOX_HOST__', 'ACTIVE', 'us-east-1', __GPU_COUNT__, __GPU_COUNT__, NOW(), NOW());

-- Fleet GPUs (one per physical GPU)
INSERT INTO fleet_gpus (id, "nodeId", "pciAddress", model, status, "gpuType", "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), (SELECT id FROM fleet_nodes WHERE name = '__NODE_NAME__'), '__PCI_ADDRESS__', '__MODEL__', 'FREE', '__GPU_TYPE__', NOW(), NOW());

-- VM template
INSERT INTO vm_templates (id, name, "proxmoxNode", "templateVmid", "gpuType", enabled, "createdAt", "updatedAt")
VALUES
  (gen_random_uuid(), 'base-cuda-__GPU_TYPE__', '__NODE_NAME__', __TEMPLATE_VMID__, '__GPU_TYPE__', true, NOW(), NOW());
```

---

## Timeline Expectation

| Step | Time after credentials arrive |
|---|---|
| Env configured + validate-env passes | 30 min |
| Fleet seeded + preflight passes | 1 hour |
| All 7 proofs executed | 4-6 hours |
| Evidence packaged + reviewed | 1 hour |
| Go/No-Go decision | Same day |
