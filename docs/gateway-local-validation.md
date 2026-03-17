# Gateway Local Validation

**Proof level**: L0 (code review only). Routes not exercised from a running instance.

---

## Service Overview

The gateway is an internal Fastify microservice managing port allocations for workspace access (SSH, Jupyter, VSCode).

| Aspect | Value |
|---|---|
| Runtime | Fastify (TypeScript) |
| Port range | 20000-40000 (20,000 ports) |
| State | **In-memory** Maps (ephemeral) |
| Auth | HMAC-SHA256 with timing-safe comparison |
| Default port | 5001 (configurable via `GATEWAY_PORT`) |

---

## Routes

### GET /health (Public)

No authentication. Returns:
```json
{ "status": "OK", "allocations": <count>, "portsUsed": <count> }
```

### POST /internal/gateway/allocate (Authenticated)

**Request**: `{ workspace_id: string, vm_internal_ip: string, nonce?: string, timestamp?: number }`

**Response**: `{ gateway_host, ssh_port, jupyter_port, vscode_port }`

**Logic**:
1. Validate body (Zod)
2. Check if workspace already allocated → return cached allocation (idempotent)
3. Allocate 3 unique ports via random selection from 20000-40000
4. Store in-memory: `activeAllocations.set(workspace_id, { ssh, jupyter, vscode, ip })`

**Port allocation**: Random selection with 1000 retry attempts. Throws if pool exhausted.

**iptables/nftables**: Comments indicate rules should be configured — **NOT implemented in code**.

### POST /internal/gateway/release (Authenticated)

**Request**: `{ workspace_id: string, nonce?: string, timestamp?: number }`

**Response**: `{ ok: true }` (always 200, even if workspace not found — idempotent)

**Logic**:
1. Validate body (Zod)
2. Look up allocation by workspace_id
3. If found: remove ports from `allocatedPorts` Set, remove from `activeAllocations` Map
4. Return success regardless

---

## Authentication

### HMAC-SHA256 Signature

1. Client computes `HMAC-SHA256(JSON.stringify(body), GATEWAY_SERVICE_SECRET)` → hex digest
2. Sends as `x-gateway-signature` header
3. Gateway recomputes over raw request body and compares with `crypto.timingSafeEqual()`

**Raw body capture**: Custom content-type parser stores raw body before JSON parsing — prevents signature bypass via format changes.

**Dev mode**: If `GATEWAY_SERVICE_SECRET` not set in development, auth is skipped. Production exits on missing secret.

### Error Responses

| Scenario | Status | Response |
|---|---|---|
| Missing signature header | 401 | `{ error: "Missing signature" }` |
| Invalid signature | 401 | `{ error: "Invalid signature" }` |
| Secret not configured | 500 | `{ error: "Server misconfigured" }` |

---

## Integration Points

### Worker → Gateway (Release)

**File**: `worker/src/jobs/workspace-cleanup.ts:23-41`

- Calls `/internal/gateway/release` during workspace cleanup
- Signs with HMAC
- 10-second timeout
- If gateway down: cleanup job retries with exponential backoff

### API → Gateway (Allocate)

**File**: `apps/api/src/services/workspaceService.ts:250-304`

- Calls `/internal/gateway/allocate` when warm workspace assigned
- Generates per-workspace Jupyter token + VSCode password
- Stores endpoint record in `workspaceEndpoint` table
- Updates workspace with connection strings (SSH command, Jupyter URL, VSCode URL)

**Incomplete**: Credentials generated but **never sent to agent inside VM** (TODO in code at line 301). Services would be inaccessible.

### Worker → DB (Port Leak Detection)

**File**: `worker/src/index.ts:388-417`

- `checkPortLeaks()` finds `workspaceEndpoint` records with `releasedAt: null` where workspace is TERMINATED/FAILED
- Auto-marks as released in DB
- **Does NOT call gateway release** — if gateway has stale allocation, it persists until restart

---

## Configuration

| Variable | Default | Required |
|---|---|---|
| `GATEWAY_SERVICE_SECRET` | — | Yes (production) |
| `GATEWAY_PORT` | 5001 | No |
| `GATEWAY_HOST` | gw1.aldaro.ai | No |
| `DATABASE_URL` | — | Yes (for durable leases; ephemeral mode if absent) |
| Port range | 20000-40000 | Hard-coded |

**Shared secrets**: `GATEWAY_SERVICE_SECRET` must match across API, Worker, and Gateway.
**Shared database**: `DATABASE_URL` must match across API, Worker, and Gateway (same Postgres instance).

---

## Critical Issues

| # | Issue | Severity | Remediation Status |
|---|---|---|---|
| 1 | **All state in-memory** — crash loses all allocations | Critical | **REMEDIATED** — Gateway now persists leases to `workspace_endpoints` DB table and reconstructs on startup |
| 2 | **No iptables/nftables rules** — ports allocated but traffic not forwarded | Critical | Open — requires real infrastructure |
| 3 | **Credentials not delivered to agent** — Jupyter tokens generated but never sent | Critical | Open — requires agent protocol work |
| 4 | Port pool exhaustion with 1000 random-retry limit | High | Open — low priority at current scale |
| 5 | Port leak detection marks DB only, not gateway | Medium | **REMEDIATED** — Gateway startup reconciliation detects and auto-releases stale leases |
| 6 | No allocation TTL or heartbeat | Medium | Partially mitigated — stale lease detection on startup covers crash scenarios |

---

## Remediation Evidence (2026-03-12)

### Code changes

| File | Change | Purpose |
|---|---|---|
| `apps/gateway/src/index.ts` | Added Prisma dependency, `reconcileLeases()` on startup | Durable lease persistence |
| `apps/gateway/src/index.ts` | `/allocate` writes to DB first (upsert), then updates cache | DB is source of truth |
| `apps/gateway/src/index.ts` | `/release` writes to DB first (updateMany), then updates cache | DB is source of truth |
| `apps/gateway/src/index.ts` | Startup reconciliation loads active leases from DB, detects/releases stale leases | Crash recovery |
| `apps/api/src/services/workspaceService.ts:273` | Changed `workspaceEndpoint.create` to `upsert` | Handles gateway already having written the record |

### Durability model

```
ALLOCATE:  DB upsert → in-memory cache update → return ports
RELEASE:   DB updateMany(releasedAt) → in-memory cache delete → return ok
STARTUP:   DB query(releasedAt IS NULL) → rebuild cache → detect stale → auto-release stale
CRASH:     Cache lost → next startup rebuilds from DB → no leases lost
```

### DB guarantees

- `WorkspaceEndpoint.workspaceId` is `@unique` — one lease per workspace
- `WorkspaceEndpoint.sshPort`, `jupyterPort`, `vscodePort` are each `@unique` — no port collisions at DB level
- `releasedAt IS NULL` distinguishes active from released leases

### Tests (23/23 pass on local Postgres, 2026-03-13)

| Test Group | Count | What it proves |
|---|---|---|
| **Allocation** | 5 | Clean allocate, duplicate upsert, multiple workspaces, sshPort unique constraint, jupyterPort unique constraint |
| **Release** | 3 | Release sets releasedAt, double release is no-op, unknown workspace is safe |
| **Restart / Reconciliation** | 5 | DB reconstruction, released lease excluded from cache, stale TERMINATED auto-released, stale FAILED auto-released, RUNNING_ASSIGNED NOT auto-released |
| **DB-First Write** | 1 | Port collision causes DB failure → in-memory rollback |
| **HMAC Validation** | 7 | Correct sig accepted, wrong sig rejected, altered body rejected, missing sig rejected, short sig rejected, timing-safe buffer lengths, different secrets produce different signatures |
| **Endpoint Orphan Detection** | 2 | Finds orphans on terminal workspaces, cleanup doesn't affect active leases |

### Stale Lease Heuristic (documented)

A lease is "stale" if:
- `releasedAt IS NULL` (still active in DB)
- AND workspace status is `TERMINATED` or `FAILED`

This means the workspace reached a terminal state but cleanup never released the endpoint (crash, cleanup exhaustion, or gateway never called). On gateway startup, `reconcileLeases()` finds and releases all stale leases automatically.

**What is NOT considered stale**: Workspaces in `CREATING`, `WAITING_FOR_AGENT`, `WARM_AVAILABLE`, `RUNNING_ASSIGNED`, or `TERMINATING` — these are still in lifecycle and their leases should remain active.

### Firewall/NAT assumptions (documented, not implemented)

The gateway currently allocates ports and tracks leases but does **not** configure iptables/nftables rules. Traffic forwarding from public ports to VM internal IPs is **not implemented**. This requires:
- Root/CAP_NET_ADMIN access on the gateway host
- iptables DNAT rules for each port → VM IP mapping
- Rule cleanup on release
- This is a real-infrastructure dependency, not a code-level fix

---

## What This Audit Proves (L1 — locally verified)

- Gateway leases are durably persisted in `workspace_endpoints` table
- Gateway restart reconstructs active leases from DB (no lease loss)
- Stale leases (terminal workspace, unreleased endpoint) are auto-detected and released on startup
- Active leases on RUNNING_ASSIGNED workspaces are NOT auto-released
- Port uniqueness enforced at both in-memory and DB levels (ssh, jupyter, vscode each `@unique`)
- Allocate and release are both idempotent
- Double release is safe
- DB write failure during allocate causes in-memory rollback (no divergence)
- HMAC signature verification: correct accepted, wrong rejected, altered body rejected, missing rejected, short rejected
- Timing-safe comparison operates on equal-length 32-byte buffers (SHA-256 output)
- Different gateway secrets produce different signatures
- Orphan endpoint detection correctly identifies terminal workspaces without affecting active leases

## What This Audit Does NOT Prove

- Gateway actually boots and serves HTTP requests end-to-end (needs running instance test)
- HMAC verification works end-to-end over HTTP (tested at function level, not HTTP level)
- Port allocation under high concurrent load (>100 simultaneous allocates)
- iptables/nftables rules work (not implemented — real infra dependency)
- Credential delivery to agent works (not implemented)
- Multi-gateway instance coordination (single instance assumed)
- Ephemeral mode cannot accidentally be used in staging (warning exists but no hard-fail for non-local envs)
- Whether lease persistence alone is enough, or if port-programming (iptables) state also needs reconciliation
