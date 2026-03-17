# Billing Parity Evidence Template

Use this template to capture evidence for every billing proof run. Fill in ALL fields. Any blank field is a proof gap.

---

## Run Metadata

| Field | Value |
|---|---|
| Run ID | |
| Date | |
| Environment | local / staging / production |
| Operator | |
| GPU Type | |
| Price Per Hour (cents) | |

---

## Timestamps

| Event | Timestamp (UTC) | Source |
|---|---|---|
| Launch request sent | | Client wallclock |
| Workspace CREATING | | DB `createdAt` |
| Workspace RUNNING_ASSIGNED | | DB `startedAt` |
| Usage session RUNNING | | DB `startTime` |
| Terminate request sent | | Client wallclock |
| Workspace TERMINATING | | DB `updatedAt` when status changed |
| Usage session ENDED | | DB `endTime` |
| Workspace TERMINATED | | DB `terminatedAt` |
| Meter outbox created | | DB `createdAt` |
| Meter outbox SENT | | DB `sentAt` |
| Stripe meter event received | | Stripe Dashboard / API |

---

## Duration Calculations

| Metric | Value | Source |
|---|---|---|
| Wallclock duration (seconds) | | terminate_request_time - launch_running_time |
| Usage session totalSeconds | | DB `totalSeconds` |
| Wallclock vs session delta | | abs(wallclock - totalSeconds) |
| Delta within ±5s? | YES / NO | |

---

## Billing Calculations

| Metric | Value | Source |
|---|---|---|
| totalSeconds | | DB |
| billedSeconds | | DB |
| pricePerHourCents | | DB (via GPU SKU) |
| Expected billedCents | | ceil(totalSeconds × pricePerHourCents / 3600) |
| Actual billedCents | | DB |
| Billing formula match? | YES / NO | expected == actual |

---

## Stripe Parity

| Metric | Value | Source |
|---|---|---|
| Outbox valueSeconds | | DB |
| Outbox status | | DB (must be SENT) |
| Outbox stripeMeterEventId | | DB |
| Stripe meter event ID | | Stripe API |
| Stripe meter event value | | Stripe API |
| Stripe value == totalSeconds? | YES / NO | |
| Stripe customer ID | | Stripe API |
| Stripe customer matches user? | YES / NO | |

---

## Resource Cleanup

| Resource | Expected State | Actual State | Clean? |
|---|---|---|---|
| Workspace status | TERMINATED | | |
| GPU status | FREE | | |
| GPU currentWorkspaceId | NULL | | |
| WorkspaceGpuAllocation releasedAt | SET | | |
| WorkspaceEndpoint releasedAt | SET | | |
| Usage session status | ENDED | | |
| Meter outbox status | SENT | | |

---

## Duplicate Risk Check

| Check | Result |
|---|---|
| Usage sessions for this workspace (count) | (must be exactly 1) |
| Meter outbox records for this session (count) | (must be exactly 1) |
| Stripe meter events with this identifier (count) | (must be exactly 1) |
| Any other workspace using same GPU during overlap? | (must be NO) |

---

## DB Evidence Queries

```sql
-- Workspace record
SELECT id, status, "gpuType", "startedAt", "terminatedAt", "assignedUserId",
       "proxmoxNode", "proxmoxVmid"
FROM workspaces WHERE id = 'WORKSPACE_ID';

-- Usage session
SELECT id, "workspaceId", "userId", "startTime", "endTime",
       "totalSeconds", "billedSeconds", "billedCents", status,
       "gpuType", "pricePerHourCents"
FROM usage_sessions WHERE "workspaceId" = 'WORKSPACE_ID';

-- Meter outbox
SELECT id, "usageSessionId", "valueSeconds", status,
       "stripeMeterEventId", "sentAt", "attemptCount",
       "lastErrorCode", "lastErrorMessage"
FROM workspace_meter_event_outbox
WHERE "usageSessionId" = 'SESSION_ID';

-- GPU state
SELECT id, "gpuType", status, "currentWorkspaceId"
FROM fleet_gpus WHERE id = 'GPU_ID';

-- Duplicate check
SELECT COUNT(*) as session_count
FROM usage_sessions WHERE "workspaceId" = 'WORKSPACE_ID';

SELECT COUNT(*) as outbox_count
FROM workspace_meter_event_outbox WHERE "usageSessionId" = 'SESSION_ID';
```

---

## Stripe API Evidence

```bash
# Get meter event (requires Stripe CLI or API key)
curl https://api.stripe.com/v1/billing/meter_events \
  -u sk_test_KEY: \
  -d "identifier=METER_EVENT_ID"

# Or use Stripe Dashboard: Billing > Meters > gpu_seconds > Events
```

---

## Overall Verdict

| Criterion | Pass? |
|---|---|
| Usage session exists with status ENDED | |
| totalSeconds within ±5s of wallclock | |
| billedCents matches formula exactly | |
| Meter outbox status is SENT | |
| Stripe meter event matches totalSeconds | |
| No orphan resources | |
| No duplicate records | |
| **OVERALL** | **PASS / FAIL** |

---

## Notes
(Any observations, anomalies, or follow-up items)
