# Minimum Viable Staging Fleet Seed Spec

This defines the exact records that must exist in the staging database before any proof run.

## 1. Fleet Nodes

At least 1 active node. Must match a real Proxmox node name.

```
FleetNode:
  - name: "<real-proxmox-node-name>"   # e.g. "pve1", must match Proxmox
    apiHost: "<proxmox-api-url>"       # e.g. "https://10.10.0.10:8006"
    status: "ACTIVE"
```

For contention tests (last-GPU race), 1 node is sufficient if it has >= 2 GPUs of the same type.

## 2. Fleet GPUs

At least 2 GPUs of the same type on the same node (for contention test).
Recommended minimum: 2x RTX 5090 + 1x A100 80GB.

Each GPU must have a real PCI address from `lspci` on the Proxmox host.

```
FleetGpu (per GPU):
  - nodeId: "<fleet-node-id>"
    gpuName: "NVIDIA GeForce RTX 5090"   # exact string from nvidia-smi
    gpuType: "RTX_5090"
    pciAddress: "0000:65:00.0"           # real PCI address from lspci
    status: "FREE"
    vramGb: 32

  - nodeId: "<fleet-node-id>"
    gpuName: "NVIDIA GeForce RTX 5090"
    gpuType: "RTX_5090"
    pciAddress: "0000:66:00.0"           # different real PCI address
    status: "FREE"
    vramGb: 32

  - nodeId: "<fleet-node-id>"
    gpuName: "NVIDIA A100-SXM4-80GB"
    gpuType: "A100_80GB"
    pciAddress: "0000:81:00.0"
    status: "FREE"
    vramGb: 80
```

## 3. VM Templates

At least 1 template per GPU type on the node. Must reference a real Proxmox template VMID.

Template VM requirements:
- qemu-guest-agent installed and enabled
- NVIDIA driver installed and pinned
- cloud-init configured
- Aldaro agent bootstrap path configured
- SSH key injection working

```
VmTemplate:
  - proxmoxNode: "<node-name>"
    templateVmid: <real-vmid>           # e.g. 9000
    name: "aldaro-base-rtx5090"
    gpuType: "RTX_5090"
    region: "US"
    enabled: true
    diskSizeGb: 50
    memorySizeMb: 32768
    cpuCores: 8

  - proxmoxNode: "<node-name>"
    templateVmid: <real-vmid>           # e.g. 9001
    name: "aldaro-base-a100"
    gpuType: "A100_80GB"
    region: "US"
    enabled: true
    diskSizeGb: 100
    memorySizeMb: 65536
    cpuCores: 16
```

## 4. GPU SKUs (pricing data)

```
GpuSku:
  - key: "RTX_5090"
    displayName: "RTX 5090"
    pricePerHourCents: 55
    vramGb: 32
    shortBadge: "Best value"
    descriptionLines: '["Fine-tuning","Inference","Fast iteration"]'
    enabled: true

  - key: "A100_80GB"
    displayName: "A100N"
    pricePerHourCents: 249
    vramGb: 80
    shortBadge: "Max VRAM"
    descriptionLines: '["Large batch training","Bigger checkpoints","VRAM-heavy pipelines"]'
    enabled: true
```

## 5. Warm Pool Config

```
WarmPoolConfig:
  - region: "US"
    gpuType: "RTX_5090"
    targetCount: 1                      # 1 warm workspace minimum for staging

  - region: "US"
    gpuType: "A100_80GB"
    targetCount: 0                      # optional for staging; set to 1 to test warm A100
```

## 6. Test Users

### Author/Admin User
```
User:
  - email: "shivas@aldaro.ai"          # or actual admin email
    role: "AUTHOR"
    accountStatus: "ACTIVE"
    passwordHash: <bcrypt of known password>
    customerAccessStatus: "APPROVED"
    maxActiveWorkspaces: 10
```

### Integration Test Customer
```
User:
  - email: "integration-test@aldaro.ai"
    role: "CUSTOMER"
    accountStatus: "ACTIVE"
    passwordHash: <bcrypt of known password>
    customerAccessStatus: "APPROVED"
    isAlphaTester: true
    maxActiveWorkspaces: 10
    stripeCustomerId: "cus_test_XXXX"   # Stripe test customer ID (required for billing proof)
```

### Pending Customer (for approval flow tests)
```
User:
  - email: "pending-test@aldaro.ai"
    role: "CUSTOMER"
    accountStatus: "ACTIVE"
    customerAccessStatus: "PENDING_REVIEW"
```

## 7. Billing-Related Seed Data

For billing parity proof, the test customer needs:
- `stripeCustomerId` set to a real Stripe test-mode customer
- That Stripe customer must have a valid test payment method attached
- A Stripe meter named `gpu_seconds` must exist in the Stripe test account

Create in Stripe Dashboard (test mode):
1. Customer with email `integration-test@aldaro.ai`
2. Payment method: Stripe test card `4242424242424242`
3. Billing meter: event_name = `gpu_seconds`, payload key = `value`

## 8. Clean State Requirements

Before any proof run, these must all be zero:
- Workspaces in non-terminal status (`CREATING`, `TERMINATING`, `WAITING_FOR_AGENT`, etc.)
- FleetGpus with status `ALLOCATED` or `RESERVED`
- WorkspaceEndpoints with `releasedAt = null`
- UsageSessions with status `RUNNING`
- WorkspaceCleanupJobs with status `PENDING`, `RUNNING`, or `RETRY`
- WorkspaceMeterEventOutbox with status `PENDING` or `RETRY`

## Summary: Minimum Viable Staging Inventory

| Resource | Count | Notes |
|---|---|---|
| Fleet Nodes | 1 | Must match real Proxmox node |
| RTX 5090 GPUs | 2 | For contention test |
| A100 80GB GPUs | 1 | For multi-SKU proof |
| VM Templates | 1-2 | Per GPU type on the node |
| GPU SKUs | 2 | RTX_5090, A100_80GB |
| Warm Pool Configs | 1-2 | At least RTX_5090 |
| Author User | 1 | For admin operations |
| Customer User | 1 | With Stripe test customer |
| Pending User | 1 | For approval flow tests |
