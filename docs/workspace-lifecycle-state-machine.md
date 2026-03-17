# Workspace Lifecycle State Machine

**Proof level**: L0 (derived from code review). Transitions locally verified only for warm-pool CREATING → FAILED path.

---

## Status Values

From code review across API and worker:

| Status | Terminal? | Owner | Description |
|---|---|---|---|
| `CREATING` | No | Worker | Workspace record created, provisioning in progress |
| `WAITING_FOR_AGENT` | No | Worker | VM booted, waiting for agent registration |
| `WARM_AVAILABLE` | No | Worker | Warm pool workspace ready for assignment |
| `RUNNING_ASSIGNED` | No | API/Worker | Assigned to user, actively running |
| `TERMINATING` | No | API | Terminate requested, cleanup in progress |
| `TERMINATED` | Yes | Worker | Successfully cleaned up |
| `FAILED` | Yes | Worker | Provisioning or lifecycle failed |

---

## State Transition Map

```
                     ┌──────────────────────────────────────────┐
                     │                                          │
                     ▼                                          │
┌──────────┐    ┌──────────┐    ┌──────────────────┐    ┌──────────────┐
│ CREATING │───▶│ WAITING  │───▶│ WARM_AVAILABLE   │───▶│   RUNNING    │
│          │    │ FOR_AGENT│    │ (warm pool only)  │    │   ASSIGNED   │
└──────────┘    └──────────┘    └──────────────────┘    └──────────────┘
     │               │                   │                      │
     │               │                   │                      │
     ▼               ▼                   ▼                      ▼
┌──────────┐    ┌──────────┐    ┌──────────────────┐    ┌──────────────┐
│  FAILED  │    │  FAILED  │    │   TERMINATING    │◀───│ TERMINATING  │
│          │    │          │    │                  │    │              │
└──────────┘    └──────────┘    └────────┬─────────┘    └──────────────┘
                                         │
                                         ▼
                                ┌──────────────────┐
                                │   TERMINATED     │
                                │                  │
                                └──────────────────┘
```

### Transition Details

| From | To | Trigger | Owner | File:Line |
|---|---|---|---|---|
| (new) | CREATING | Workspace DB record created | Worker (warm) or API (cold) | warm-pool.ts:146, workspaceService.ts |
| CREATING | WAITING_FOR_AGENT | VM cloned, GPU attached, VM started | Worker | warm-pool.ts:222 |
| CREATING | FAILED | Provision error (clone, config, boot) | Worker | warm-pool.ts:233 |
| CREATING | TERMINATING | Stale sweeper (>15 min stuck) | Worker | workspace-cleanup.ts (sweeper) |
| WAITING_FOR_AGENT | WARM_AVAILABLE | Agent registers (warm pool) | API/Agent | Agent registration endpoint |
| WAITING_FOR_AGENT | RUNNING_ASSIGNED | Agent registers (user-assigned) | API/Agent | Agent registration endpoint |
| WAITING_FOR_AGENT | FAILED | Agent registration timeout (5 min) | Worker | warm-pool.ts |
| WARM_AVAILABLE | RUNNING_ASSIGNED | User launches, warm workspace assigned | API | workspaceService.ts |
| WARM_AVAILABLE | TERMINATING | Idle termination or manual terminate | Worker/API | idle-termination, workspaceService |
| RUNNING_ASSIGNED | TERMINATING | User terminates or idle timeout | API/Worker | workspaceService.ts, idle-termination |
| TERMINATING | TERMINATED | Cleanup job completes | Worker | workspace-cleanup.ts |
| TERMINATING | FAILED | Cleanup exhausts retries (20 attempts) | Worker | workspace-cleanup.ts |

### Invalid Transitions

These should never happen:

| Transition | Why invalid |
|---|---|
| TERMINATED → any | Terminal state |
| FAILED → any | Terminal state |
| RUNNING_ASSIGNED → CREATING | Can't go backwards |
| WARM_AVAILABLE → CREATING | Can't go backwards |
| WAITING_FOR_AGENT → CREATING | Can't go backwards |
| TERMINATING → RUNNING_ASSIGNED | Can't resume from termination |
| Any → WARM_AVAILABLE (non-warm workspace) | Only warm pool workspaces enter WARM_AVAILABLE |

**Guard rails**: No explicit state machine enforcement in code. Status is set directly via `prisma.workspace.update({ data: { status: 'NEW_STATUS' } })`. Invalid transitions are prevented by control flow logic (e.g., terminate handler checks current status before transitioning).

---

## Stale-State Timeout Rules

From `workspace-cleanup.ts` stale sweeper:

| Status | Timeout | Action |
|---|---|---|
| CREATING | 15 minutes | Sweeper transitions to TERMINATING, creates cleanup job |
| WAITING_FOR_AGENT | 5 minutes (in warm-pool.ts) | Worker marks FAILED after agent timeout |
| TERMINATING | 10 minutes | Sweeper creates cleanup job if none exists |
| WARM_AVAILABLE | Via idle termination | Terminated if idle too long |
| RUNNING_ASSIGNED | `AUTO_TERMINATE_IDLE_MINUTES` env | Worker terminates idle workspaces |

---

## Resource Lifecycle Per Transition

### On CREATING (workspace record created)
| Resource | Action |
|---|---|
| FleetGpu | Set to ALLOCATED, `currentWorkspaceId` set |
| WorkspaceGpuAllocation | Created |
| WorkspaceEndpoint | Not yet created |
| UsageSession | Not yet created |

### On CREATING → FAILED (provision failure)
| Resource | Action | Verified? |
|---|---|---|
| FleetGpu | Rolled back to FREE, `currentWorkspaceId` cleared | L1 (locally verified) |
| WorkspaceGpuAllocation | Deleted | L1 (locally verified) |
| UsageSession | Not created (correct) | L1 (locally verified) |
| WorkspaceEndpoint | Not created (correct) | L1 (locally verified) |

### On RUNNING_ASSIGNED (workspace active)
| Resource | State |
|---|---|
| FleetGpu | ALLOCATED |
| WorkspaceGpuAllocation | Exists |
| WorkspaceEndpoint | Created (gateway ports allocated) |
| UsageSession | Created with status RUNNING |

### On TERMINATING → TERMINATED (cleanup)
| Resource | Action | Verified? |
|---|---|---|
| FleetGpu | Released to FREE | L0 |
| WorkspaceGpuAllocation | releasedAt set | L0 |
| WorkspaceEndpoint | releasedAt set (gateway ports released) | L0 |
| UsageSession | Closed (status ENDED, totalSeconds calculated) | L0 |
| WorkspaceMeterEventOutbox | Created for billing emission | L0 |
| VM | Stopped and deleted on Proxmox | L0 |

### On TERMINATING → FAILED (cleanup exhausted)
| Resource | Action |
|---|---|
| Incident | Created (dead-letter) |
| Cleanup job | Status set to DEAD_LETTER |
| Other resources | May be leaked — incident alerts operator |

---

## Warm Pool vs User-Initiated Flow

### Warm Pool Flow
1. Worker warm-pool tick detects shortfall
2. Creates workspace (CREATING, `isWarmPool: true`, no `assignedUserId`)
3. Provisions VM (clone → config → boot)
4. WAITING_FOR_AGENT → WARM_AVAILABLE (on agent registration)
5. Sits idle until user requests launch
6. On launch: assignedUserId set, status → RUNNING_ASSIGNED

### User-Initiated (Cold) Flow
1. API receives launch request
2. Checks for available warm workspace first
3. If warm available: assigns directly (WARM_AVAILABLE → RUNNING_ASSIGNED)
4. If no warm: creates cold workspace (CREATING, `isWarmPool: false`, `assignedUserId` set)
5. Worker provisions VM
6. WAITING_FOR_AGENT → RUNNING_ASSIGNED (on agent registration)

### Key Difference
Warm pool workspaces go through WARM_AVAILABLE state. Cold workspaces skip directly from WAITING_FOR_AGENT to RUNNING_ASSIGNED.

---

## Cleanup Job Behavior Per State

| Workspace Status | Cleanup Job Created? | By Whom |
|---|---|---|
| CREATING (stale >15min) | Yes | Stale sweeper |
| TERMINATING (API-initiated) | Yes | Terminate handler |
| TERMINATING (stale >10min) | Yes (if missing) | Stale sweeper |
| FAILED | No | Already terminal |
| TERMINATED | No | Already terminal |

---

## Open Questions

1. **No state machine enforcement**: Status transitions are set directly without validating the current state. A bug could cause an invalid transition.
2. **WAITING_FOR_AGENT timeout**: Where exactly is the 5-minute timeout enforced? Is it in warm-pool.ts only or also for cold workspaces?
3. **Concurrent terminate**: What happens if two terminate requests arrive simultaneously? Is there a guard against double-transition?
4. **WARM_AVAILABLE idle timeout**: Is there an explicit idle timeout for warm pool workspaces, or do they live indefinitely until claimed?
