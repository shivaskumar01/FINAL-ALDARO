# Aldaro.AI Production Runbook

## Overview

This runbook documents operational procedures for managing the Aldaro fleet. All actions create audit trails in the `AuthorAudit` and `ConfigChange` tables.

## Access

- **Author Portal**: `/author` (requires AUTHOR role)
- **API Base**: `/api/author/`
- **All actions require re-authentication** for sensitive operations

---

## Emergency Procedures

### Emergency Stop Provisioning

**When to use**: System-wide issue, cascading failures, suspected security incident

```bash
POST /api/author/actions/emergency-stop
{
  "enabled": true,
  "reason": "Brief description of issue"
}
```

**Effect**:
- Creates CRITICAL incident
- Stops all new workspace provisioning
- Does NOT affect running workspaces
- Logged to ConfigChange and AuthorAudit

**To resume**:
```bash
POST /api/author/actions/emergency-stop
{
  "enabled": false,
  "reason": "Issue resolved: <description>"
}
```

### Terminate Workspace

**When to use**: Stuck workspace, suspected abuse, resource leak

```bash
POST /api/author/actions/terminate-workspace
{
  "workspaceId": "uuid",
  "reason": "stuck_in_provision" | "abuse" | "manual_cleanup"
}
```

**Effect**:
- Sets workspace status to TERMINATING
- Worker will clean up VM and release GPU
- Idempotent (can call multiple times)

---

## Fleet Management

### Disable GPU

**When to use**: ECC errors, thermal issues, suspected hardware fault

```bash
POST /api/author/actions/disable-gpu
{
  "gpuId": "uuid",
  "reason": "ECC errors > threshold"
}
```

**Effect**:
- Sets GPU status to DISABLED
- GPU will not be allocated to new workspaces
- Existing workspaces on this GPU continue running

### Enable GPU

**When to use**: After hardware issue resolved

```bash
POST /api/author/actions/enable-gpu
{
  "gpuId": "uuid",
  "reason": "Hardware replaced and tested"
}
```

### Drain Node

**When to use**: Before maintenance, firmware updates, hardware replacement

```bash
POST /api/author/actions/drain-node
{
  "nodeId": "uuid",
  "enabled": false
}
```

**Effect**:
- Sets node status to DRAINING
- No new workspaces will be provisioned on this node
- Existing workspaces continue running
- When all workspaces terminate, node can be taken offline

**To un-drain**:
```bash
POST /api/author/actions/drain-node
{
  "nodeId": "uuid",
  "enabled": true
}
```

---

## Warm Pool Management

### Update Warm Pool Target

**When to use**: Demand changes, capacity planning

```bash
POST /api/author/actions/update-warm-pool
{
  "gpuType": "RTX_4090",
  "region": "US",
  "targetCount": 5,
  "reason": "Increased demand forecast"
}
```

**Effect**:
- Worker will scale warm pool to new target
- Logged to ConfigChange for audit

---

## Incident Management

### Acknowledge Incident

```bash
POST /api/author/actions/acknowledge-incident
{
  "incidentId": "uuid",
  "notes": "Investigating root cause"
}
```

### Resolve Incident

```bash
POST /api/author/actions/resolve-incident
{
  "incidentId": "uuid",
  "notes": "Fixed by restarting worker service"
}
```

---

## Monitoring Thresholds

### Auto-generated Incidents

| Incident Type | Trigger | Severity |
|---------------|---------|----------|
| `provision_failure_spike` | >10% failure rate in 1h | HIGH/CRITICAL |
| `gpu_stuck_attached` | GPU allocated to terminated workspace | MEDIUM/HIGH |
| `port_lease_leak` | Port not released after termination | MEDIUM/HIGH |
| `heartbeat_misses_spike` | >5 stale heartbeats | HIGH/CRITICAL |
| `warm_pool_shortfall` | >3 below target for >5 min | MEDIUM/HIGH |

### Key Metrics to Watch

1. **Provision p95**: Should be <120s
2. **Failure rate**: Should be <5%
3. **Heartbeat misses**: Should be 0 for healthy workspaces
4. **Warm pool actual vs target**: Should match within 1-2

---

## Backup and Recovery

### Database Backup

Postgres backups run daily via `pg_dump`. Location: `s3://aldaro-backups/postgres/`

**Manual backup**:
```bash
pg_dump $DATABASE_URL | gzip > backup-$(date +%Y%m%d-%H%M%S).sql.gz
```

### Redis Recovery

Redis is used for caching only. If Redis is wiped:
1. All caches will be rebuilt on next request
2. No data loss expected
3. May see temporary latency spike

### Restore Drill Checklist

- [ ] Stop API and Worker services
- [ ] Restore Postgres from backup
- [ ] Verify table counts match expected
- [ ] Restart Worker (will acquire leader lock)
- [ ] Restart API
- [ ] Verify author dashboard loads
- [ ] Run cleanup verification script

---

## Post-Incident Review

After any incident:

1. **Document timeline** in incident notes
2. **Identify root cause**
3. **Add detection rule** if not auto-detected
4. **Update this runbook** if new procedure needed
5. **Review audit timeline** for related actions

---

## Contact Escalation

1. **On-call engineer**: Check PagerDuty
2. **Author portal**: `/author/incidents` for current status
3. **Emergency**: Slack #aldaro-incidents

---

## Appendix: API Endpoints Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/author/usage/overview` | GET | Dashboard metrics |
| `/api/author/usage/customers` | GET | Customer table |
| `/api/author/usage/customers/:id` | GET | Customer detail |
| `/api/author/usage/workspaces` | GET | Workspace list |
| `/api/author/usage/workspaces/:id` | GET | Workspace detail |
| `/api/author/usage/fleet` | GET | Fleet summary |
| `/api/author/usage/incidents` | GET | Open incidents |
| `/api/author/usage/audit-timeline` | GET | Audit log |
| `/api/author/actions/terminate-workspace` | POST | Terminate workspace |
| `/api/author/actions/disable-gpu` | POST | Disable GPU |
| `/api/author/actions/enable-gpu` | POST | Enable GPU |
| `/api/author/actions/drain-node` | POST | Drain/undrain node |
| `/api/author/actions/emergency-stop` | POST | Emergency stop |
| `/api/author/actions/update-warm-pool` | POST | Update warm pool |
| `/api/author/actions/acknowledge-incident` | POST | Ack incident |
| `/api/author/actions/resolve-incident` | POST | Resolve incident |
