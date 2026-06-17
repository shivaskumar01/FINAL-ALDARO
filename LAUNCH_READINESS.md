# Aldaro.AI Launch Readiness Checklist

**Status:** Architecture Approved  
**Next Phase:** Integration Testing & Hardening

---

## Aldaro.AI Policy

**Aldaro rents compute only from Aldaro-owned GPU fleet.**

| Allowed | Not Allowed |
|---------|-------------|
| GitHub for auth and repo access | External GPU providers (RunPod, etc.) |
| Stripe for payments and billing | Third-party GPU hosting/marketplaces |
| Users run their own code on Aldaro GPUs | Reselling third-party hosted models |

**Clarification:** Users can run their own inference APIs (FastAPI, Flask, etc.) on Aldaro GPUs. This is NOT the same as Aldaro reselling OpenAI/Anthropic/etc. models.

---

## Pre-Launch Requirements

### 1. Proxmox Provisioning Proof (Integration Test)

**Requirement:** Run one full lifecycle on a real node, 20 times consecutively with zero manual intervention.

| Step | Verification |
|------|--------------|
| Create workspace | DB row created with status CREATING |
| Clone from template | Proxmox API returns task UPID, task completes OK |
| Attach GPU by PCI address | `hostpci0` config applied, `lspci` shows GPU in VM |
| Boot | VM status `running`, qmpstatus `running` |
| Discover IP | `qemu-guest-agent` returns IPv4, matches DB `vmInternalIp` |
| Agent heartbeat | `/internal/agent/heartbeat` received within 60s of boot |
| User connect works | SSH on allocated port succeeds, `nvidia-smi` shows GPU |
| Terminate | VM deleted, GPU status FREE, ports released |
| Repeat 20x | Automated script, no manual steps, zero failures |

**Test Script Location:** `tests/integration/full-lifecycle.test.ts`

```bash
# Acceptance command
npm run test:integration -- --grep "full lifecycle" --repeat 20
```

---

### 2. Warm Pool and Capacity Rules

**Configuration Required:**

```typescript
interface WarmPoolPolicy {
  // Per GPU type
  minWarmCount: number;        // e.g., 2 per gpuType
  maxWarmCount: number;        // e.g., 5 per gpuType
  maxWarmPerNode: number;      // e.g., 3 per physical node
  
  // Health thresholds
  nodeHealthCheck: {
    maxLoadAverage: number;    // e.g., 0.8
    minFreeDiskGb: number;     // e.g., 50
    maxMemoryUsagePct: number; // e.g., 90
  };
  
  // GPU health
  gpuAdmission: {
    maxEccErrors: number;      // e.g., 10 in 24h
    maxTempCelsius: number;    // e.g., 85
    maxFailureCount: number;   // e.g., 3 consecutive
  };
  
  // Retry policy
  cloneRetry: {
    maxAttempts: number;       // e.g., 3
    backoffMs: number[];       // e.g., [1000, 5000, 15000]
    failureWindow: string;     // e.g., "1h"
  };
}
```

**Implementation Tasks:**
- [ ] Add `WarmPoolPolicy` model to Prisma schema
- [ ] Implement node health check in worker tick
- [ ] Implement GPU health monitoring (ECC, temp via `nvidia-smi`)
- [ ] Add exponential backoff to clone failures
- [ ] Mark GPU as DEGRADED when thresholds exceeded

---

### 3. Worker Leader Lock Correctness

**Requirement:** Single writer for all mutation domains.

**Implementation:**

```typescript
// Using Postgres advisory locks
const LOCK_IDS = {
  PROVISION_TICK: 1001,
  WARM_POOL_TICK: 1002,
  IDLE_TERMINATION_TICK: 1003,
  BILLING_FINALIZE_TICK: 1004,
};

async function withLeaderLock<T>(
  lockId: number,
  fencingToken: string,
  fn: () => Promise<T>
): Promise<T | null> {
  const acquired = await prisma.$executeRaw`
    SELECT pg_try_advisory_lock(${lockId})
  `;
  
  if (!acquired) return null;
  
  try {
    // Verify fencing token is current
    const current = await redis.get(`leader:${lockId}`);
    if (current && current !== fencingToken) {
      throw new Error('Stale leader detected');
    }
    
    return await fn();
  } finally {
    await prisma.$executeRaw`
      SELECT pg_advisory_unlock(${lockId})
    `;
  }
}
```

**Tasks:**
- [ ] Add Postgres advisory lock wrapper
- [ ] Generate fencing token on worker startup
- [ ] Store fencing token in Redis with TTL
- [ ] Wrap each tick in leader lock
- [ ] Add heartbeat to extend lock ownership
- [ ] Test failover scenario

---

### 4. Gateway Hardening

**Network Binding:**
```yaml
# docker-compose.yml
gateway:
  networks:
    - internal  # Control plane only
  ports: []     # No external exposure
```

**Security Checklist:**
- [ ] Bind to private network interface only (e.g., `10.0.0.0/8`)
- [ ] HMAC required on every `/internal/*` route
- [ ] Add nonce + timestamp to all requests
- [ ] Reject requests older than 60 seconds
- [ ] In-memory nonce cache with 5-minute TTL

**Port Allocation Hardening:**
- [ ] Add lease TTL to port allocations (e.g., 24h max)
- [ ] Background job to reclaim expired leases
- [ ] On worker startup, reconcile allocations vs running workspaces
- [ ] Per-workspace allowlist: only SSH(22), Jupyter(8888), VSCode(8080)

---

### 5. Network and Isolation

**Network Topology:**

```
┌─────────────────────────────────────────────────────────────┐
│                     Control Plane Network                    │
│                        10.10.0.0/24                          │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────────────┐ │
│  │   API   │  │ Worker  │  │ Gateway │  │ Proxmox API     │ │
│  │ :4000   │  │         │  │ :5001   │  │ :8006 (locked)  │ │
│  └─────────┘  └─────────┘  └─────────┘  └─────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                    NAT/Firewall
                              │
┌─────────────────────────────────────────────────────────────┐
│                      Tenant Network                          │
│                        10.20.0.0/16                          │
│  ┌───────────────┐  ┌───────────────┐  ┌───────────────┐    │
│  │ VM (ws-001)   │  │ VM (ws-002)   │  │ VM (ws-003)   │    │
│  │ 10.20.1.10    │  │ 10.20.1.11    │  │ 10.20.2.10    │    │
│  └───────────────┘  └───────────────┘  └───────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

**Firewall Rules:**
- [ ] Proxmox API (8006) accessible only from Worker IP
- [ ] Block east-west traffic between tenant VMs
- [ ] Per-VM ingress: allow only SSH, Jupyter, VSCode from Gateway
- [ ] Egress: allow outbound for pip/apt, block internal ranges

**Implementation:**
- [ ] Proxmox firewall rules per VM
- [ ] VPC/VLAN segmentation
- [ ] Network policy enforcement

---

### 6. Agent Protocol and Bootstrap

**Agent Contract:**

```typescript
interface AgentRegistration {
  workspace_id: string;
  agent_version: string;
  hostname: string;
  internal_ip: string;
  gpu_present: boolean;
  gpu_name?: string;
  driver_version?: string;
  cuda_version?: string;
}

interface AgentHeartbeat {
  workspace_id: string;
  uptime_seconds: number;
  gpu_utilization_pct: number;
  gpu_memory_used_mb: number;
  gpu_temp_celsius: number;
  network_rx_bytes: number;
  network_tx_bytes: number;
  nonce: string;
  timestamp: number;
}

// Timing
const HEARTBEAT_INTERVAL_SECONDS = 5;
const HEARTBEAT_GRACE_WINDOW_SECONDS = 30;
const DEAD_AGENT_THRESHOLD_SECONDS = 60;
```

**Security Requirements:**
- [ ] Raw body HMAC signing (not JSON.stringify)
- [ ] Timing-safe signature comparison
- [ ] Nonce + timestamp replay protection
- [ ] Reject requests > 60s old
- [ ] Key rotation: support dual-key period during rotation

**Bootstrap via Cloud-Init:**
```yaml
#cloud-config
runcmd:
  - curl -sSL https://agent.aldaro.ai/install.sh | bash
  - systemctl enable aldaro-agent
  - systemctl start aldaro-agent
write_files:
  - path: /etc/aldaro/config.yaml
    content: |
      workspace_id: ${WORKSPACE_ID}
      api_base_url: ${API_BASE_URL}
      shared_secret: ${AGENT_SECRET}
```

---

### 7. Auth Details for Browser Sessions

**Cookie Configuration:**

```typescript
const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'lax' as const,  // 'strict' breaks OAuth redirects
  path: '/',
  maxAge: 7 * 24 * 60 * 60,  // 7 days
  domain: process.env.COOKIE_DOMAIN,
};
```

**CSRF Strategy:**
- Double-submit cookie pattern
- `x-csrf-token` header on all POST/PUT/DELETE/PATCH
- Token refreshed on each request

**Remaining Cleanup:**
- [x] Remove query param token fallback (done)
- [x] Remove localStorage token storage (done)
- [x] Remove Authorization header from localStorage (done)

---

### 8. Billing Completion and Enforcement

**Three Required Components:**

#### A. Metering Event Emission
```typescript
async function emitStripeUsage(session: UsageSession) {
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  
  await stripe.billing.meterEvents.create({
    event_name: 'gpu_seconds',
    payload: {
      stripe_customer_id: session.user.stripeCustomerId,
      value: session.totalSeconds.toString(),
    },
  }, {
    idempotencyKey: `session-${session.id}`,
  });
  
  await prisma.usageSession.update({
    where: { id: session.id },
    data: { 
      status: 'CHARGED',
      stripeUsageReported: true,
    },
  });
}
```

#### B. Webhook Handler
```typescript
app.post('/webhooks/stripe', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const event = stripe.webhooks.constructEvent(
    req.rawBody,
    sig,
    process.env.STRIPE_WEBHOOK_SECRET
  );
  
  // Idempotency: check if already processed
  const existing = await prisma.stripeEvent.findUnique({
    where: { eventId: event.id }
  });
  if (existing) return res.json({ received: true });
  
  switch (event.type) {
    case 'invoice.payment_failed':
      await handlePaymentFailed(event.data.object);
      break;
    case 'customer.subscription.deleted':
      await handleSubscriptionCanceled(event.data.object);
      break;
  }
  
  await prisma.stripeEvent.create({
    data: { eventId: event.id, type: event.type }
  });
  
  res.json({ received: true });
});
```

#### C. Enforcement
```typescript
async function enforcePaymentStatus(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  
  if (user.paymentStatus === 'BLOCKED') {
    // Block new workspace creation
    throw new Error('PAYMENT_REQUIRED');
  }
  
  if (user.paymentStatus === 'GRACE_PERIOD') {
    const graceEnd = new Date(user.graceStartedAt);
    graceEnd.setHours(graceEnd.getHours() + 24);
    
    if (new Date() > graceEnd) {
      // Terminate all running workspaces
      await terminateAllUserWorkspaces(userId);
      await prisma.user.update({
        where: { id: userId },
        data: { paymentStatus: 'BLOCKED' }
      });
    }
  }
}
```

**UI Requirements:**
- [ ] Show payment status banner
- [ ] Show grace period countdown
- [ ] Block "Create Workspace" button when blocked

---

### 9. Data Model and Migrations Final Pass

**Single Source of Truth:** Prisma schema

**Tasks:**
- [ ] Run `prisma migrate reset` on empty Postgres
- [ ] Verify all migrations apply cleanly
- [ ] Remove deprecated columns:
  - `upstreamProvider`
  - `upstreamInstanceId`
  - `publicIp`
  - `dataCenterId`
- [ ] Seed script for:
  - VM templates per node
  - GPU types (RTX_4090, A100_80GB, H100)
  - GPU SKU pricing
  - Default warm pool configs
- [ ] Verify no `dev.db` in repo

---

### 10. Observability and Audit Trail

**Structured Logging:**
```typescript
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
  mixin: () => ({
    service: 'aldaro-api',
    version: ALDARO_VERSION,
  }),
});

// Per-request context
app.addHook('onRequest', (req, reply, done) => {
  req.log = logger.child({
    requestId: req.id,
    workspaceId: req.params?.workspaceId,
    userId: req.user?.userId,
  });
  done();
});
```

**Metrics (Prometheus):**
```typescript
const metrics = {
  provision_duration_seconds: new Histogram({...}),
  clone_failures_total: new Counter({...}),
  warm_pool_size: new Gauge({...}),
  idle_terminations_total: new Counter({...}),
  gateway_port_allocation_failures_total: new Counter({...}),
  agent_heartbeat_misses_total: new Counter({...}),
};
```

**Tracing (OpenTelemetry):**
- [ ] Instrument API, Worker, Gateway
- [ ] Propagate trace context between services
- [ ] Export to Jaeger/Honeycomb

**Audit Log Events:**
- `workspace.created`
- `workspace.started`
- `workspace.stopped`
- `workspace.terminated`
- `billing.session_started`
- `billing.session_ended`
- `billing.payment_failed`
- `admin.user_suspended`
- `admin.gpu_disabled`

---

### 11. Abuse Controls

**Rate Limits:**
```typescript
const RATE_LIMITS = {
  workspaceCreate: { max: 5, window: '1h' },
  workspaceStart: { max: 10, window: '1h' },
  apiGeneral: { max: 100, window: '1m' },
};
```

**Quotas:**
```typescript
interface UserQuotas {
  maxConcurrentWorkspaces: number;  // default: 2
  maxPortsPerWorkspace: number;     // default: 3
  maxGpuHoursPerDay: number;        // default: 8
  maxGpuHoursPerMonth: number;      // default: 100
}
```

**Timeouts:**
```typescript
const TIMEOUTS = {
  provisioningMaxMs: 10 * 60 * 1000,  // 10 minutes
  cloneTaskMaxMs: 3 * 60 * 1000,      // 3 minutes
  bootWaitMaxMs: 5 * 60 * 1000,       // 5 minutes
  agentRegisterMaxMs: 2 * 60 * 1000,  // 2 minutes
};
```

**Orphan Cleanup Job:**
```typescript
// Run every 5 minutes
async function orphanCleanupTick() {
  // VMs in Proxmox with no matching workspace
  // Workspaces stuck in CREATING > 15 min
  // GPU allocations with no active workspace
  // Port allocations with no active workspace
  // Usage sessions stuck in RUNNING with terminated workspace
}
```

---

## Acceptance Tests

### Test 1: New User End-to-End
```gherkin
Given a new user with GitHub account
When they sign in with GitHub OAuth
And create a workspace with RTX_4090
And wait for workspace to be RUNNING
And connect to Jupyter via allocated port
And run nvidia-smi
Then output shows RTX 4090
When they terminate the workspace
Then workspace status is TERMINATED
And GPU is FREE
And ports are released
And usage session is ENDED with correct billing
```

### Test 2: Warm Pool Under Load
```gherkin
Given warm pool config: minWarm=2 for RTX_4090
And 0 warm workspaces exist
When warm pool tick runs
Then 2 workspaces are created with status WARM_AVAILABLE
When 5 users request RTX_4090 workspace simultaneously
Then first 2 get warm assignment (<30s)
And next 3 get cold provisioning (<5min)
And warm pool replenishes to 2
```

### Test 3: Provision Failure Cleanup
```gherkin
Given a Proxmox clone that will fail
When provision tick processes workspace
Then workspace status is FAILED
And no VM exists in Proxmox
And GPU status is FREE
And no port allocation exists
And no stuck DB rows
```

### Test 4: Idle Termination Flow
```gherkin
Given a running workspace with GPU < 5% for 20 min
When idle termination tick runs
Then workspace status is TERMINATED
And usage session is ENDED
And billing is calculated correctly
And GPU is FREE
And ports are released
```

### Test 5: Payment Failure Enforcement
```gherkin
Given a user with failed payment
When they try to create a workspace
Then request is rejected with PAYMENT_REQUIRED
Given a user in grace period with running workspace
When grace period expires
Then workspace is terminated
And user status is BLOCKED
```

---

## Review Request

When ready, send updated repo or zip for review. I will check:

1. **No external provider traces**
   - No RunPod imports or references
   - No third-party GPU API calls
   - GitHub limited to auth/repo only

2. **No secret leakage**
   - No `.env` files
   - No hardcoded secrets
   - No secrets in logs

3. **No mocked provisioning paths**
   - Real Proxmox API calls
   - Real GPU passthrough
   - Real IP discovery

---

## Review Package Deliverables (20x Run)

After completing the 20x lifecycle test, provide:

| # | Deliverable | How to Generate |
|---|-------------|-----------------|
| 1 | Git commit hash | `git rev-parse HEAD` |
| 2 | Test command | `npm run test:integration -- --grep "lifecycle" --repeat 20` |
| 3 | Worker logs | `worker/logs/integration-test-*.log` |
| 4 | API logs | `api/logs/integration-test-*.log` |
| 5 | Proxmox tasks | `node scripts/export-proxmox-tasks.js` |
| 6 | Workspace sessions | `node scripts/export-workspace-sessions.js` |
| 7 | Port leases | `node scripts/export-port-leases.js` |

---

## Hard Go/No-Go Rules

| Rule | Verification |
|------|--------------|
| Zero manual steps | Fully automated script |
| Zero orphan VMs | `node scripts/verify-cleanup.js` |
| Zero leaked GPU allocations | DB check: `status = 'ALLOCATED'` count = 0 |
| Zero leaked port leases | DB check: `released_at IS NULL` with terminated workspace = 0 |
| Every workspace ends TERMINATED or FAILED | No stuck states |
| Every success: RUNNING + heartbeat + nvidia-smi | Agent callback received |

---

## Additional Tests After 20x Happy Path

| Test | File | What It Validates |
|------|------|-------------------|
| Failure Injection | `tests/integration/failure-injection.test.ts` | Clone fail, GPU attach fail, guest agent missing, agent never registers → full cleanup |
| Concurrency | `tests/integration/concurrency.test.ts` | 5 simultaneous requests → warm pool fast, no double-assign |
| Leader Failover | `tests/integration/leader-failover.test.ts` | Kill worker mid-provision → single leader resumes |

---

## Policy Enforcement (Every Code Review)

```
[ ] Aldaro-owned GPUs only in every runtime path
[ ] No external GPU provider adapters hidden behind flags
[ ] No hosted model resale paths (OpenAI, Anthropic, etc.)
[ ] GitHub only for auth and repo access
[ ] Stripe only for billing
```

---

**Architecture Status:** Approved  
**Implementation Status:** Ready for integration testing  
**Launch Blocker:** Proxmox 20x lifecycle proof on real hardware
