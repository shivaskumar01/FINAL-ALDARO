/**
 * Incident Detector
 * 
 * Auto-generates incidents based on system health checks.
 * Run periodically by the worker service.
 * 
 * Incident Rules:
 * - Provision failure rate above threshold
 * - Median provision time above threshold
 * - Orphan VM detected
 * - GPU stuck ATTACHED with no active workspace
 * - Port lease leak detected
 * - Heartbeat misses above threshold
 * - Node unhealthy for > N minutes
 * - Warm pool shortfall > N minutes
 * - Stripe payment failures spike
 */

import { prisma } from '@aldaro/db';

export enum IncidentType {
  PROVISION_FAILURE_SPIKE = 'provision_failure_spike',
  PROVISION_SLOW = 'provision_slow',
  ORPHAN_VM_DETECTED = 'orphan_vm_detected',
  GPU_STUCK_ATTACHED = 'gpu_stuck_attached',
  PORT_LEASE_LEAK = 'port_lease_leak',
  HEARTBEAT_MISSES_SPIKE = 'heartbeat_misses_spike',
  NODE_UNHEALTHY = 'node_unhealthy',
  WARM_POOL_SHORTFALL = 'warm_pool_shortfall',
  PAYMENT_FAILURES_SPIKE = 'payment_failures_spike',
}

export enum IncidentSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

interface IncidentRule {
  type: IncidentType;
  check: () => Promise<IncidentCheckResult | null>;
}

interface IncidentCheckResult {
  type: IncidentType;
  severity: IncidentSeverity;
  title: string;
  description: string;
  affectedWorkspaceIds?: string[];
  affectedNodeIds?: string[];
  affectedGpuIds?: string[];
  count?: number;
}

// Thresholds
const PROVISION_FAILURE_RATE_THRESHOLD = 0.1; // 10%
const PROVISION_TIME_P95_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes
const HEARTBEAT_MISS_THRESHOLD = 5;
const WARM_POOL_SHORTFALL_THRESHOLD = 3;

/**
 * Run all incident detection checks
 */
export async function runIncidentDetection(): Promise<void> {
  const rules: IncidentRule[] = [
    { type: IncidentType.PROVISION_FAILURE_SPIKE, check: checkProvisionFailures },
    { type: IncidentType.GPU_STUCK_ATTACHED, check: checkGpuStuckAttached },
    { type: IncidentType.PORT_LEASE_LEAK, check: checkPortLeaseLeaks },
    { type: IncidentType.HEARTBEAT_MISSES_SPIKE, check: checkHeartbeatMisses },
    { type: IncidentType.WARM_POOL_SHORTFALL, check: checkWarmPoolShortfall },
    { type: IncidentType.NODE_UNHEALTHY, check: checkNodeHealth },
  ];

  for (const rule of rules) {
    try {
      const result = await rule.check();
      
      if (result) {
        await upsertIncident(result);
      } else {
        // Auto-resolve if condition cleared
        await resolveIncidentIfCleared(rule.type);
      }
    } catch (err) {
      console.error(`Incident check failed for ${rule.type}:`, err);
    }
  }
}

/**
 * Create or update an incident
 */
async function upsertIncident(result: IncidentCheckResult): Promise<void> {
  const existing = await prisma.incident.findFirst({
    where: {
      type: result.type,
      status: { in: ['OPEN', 'ACKED'] },
    },
  });

  if (existing) {
    // Update existing incident
    await prisma.incident.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        count: { increment: 1 },
        severity: result.severity,
        description: result.description,
        affectedWorkspaceIds: result.affectedWorkspaceIds 
          ? JSON.stringify(result.affectedWorkspaceIds) 
          : existing.affectedWorkspaceIds,
        affectedNodeIds: result.affectedNodeIds 
          ? JSON.stringify(result.affectedNodeIds) 
          : existing.affectedNodeIds,
        affectedGpuIds: result.affectedGpuIds 
          ? JSON.stringify(result.affectedGpuIds) 
          : existing.affectedGpuIds,
      },
    });
  } else {
    // Create new incident
    await prisma.incident.create({
      data: {
        type: result.type,
        severity: result.severity,
        title: result.title,
        description: result.description,
        status: 'OPEN',
        count: result.count || 1,
        affectedWorkspaceIds: result.affectedWorkspaceIds 
          ? JSON.stringify(result.affectedWorkspaceIds) 
          : null,
        affectedNodeIds: result.affectedNodeIds 
          ? JSON.stringify(result.affectedNodeIds) 
          : null,
        affectedGpuIds: result.affectedGpuIds 
          ? JSON.stringify(result.affectedGpuIds) 
          : null,
      },
    });
  }
}

/**
 * Auto-resolve incident if condition cleared
 */
async function resolveIncidentIfCleared(type: IncidentType): Promise<void> {
  await prisma.incident.updateMany({
    where: {
      type,
      status: 'OPEN',
    },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      notes: 'Auto-resolved: condition cleared',
    },
  });
}

// =============================================================================
// Incident Check Functions
// =============================================================================

async function checkProvisionFailures(): Promise<IncidentCheckResult | null> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  
  const [total, failed] = await Promise.all([
    prisma.workspace.count({
      where: { createdAt: { gte: oneHourAgo } },
    }),
    prisma.workspace.count({
      where: {
        createdAt: { gte: oneHourAgo },
        status: 'FAILED',
      },
    }),
  ]);

  if (total < 5) return null; // Not enough data

  const failureRate = failed / total;
  
  if (failureRate >= PROVISION_FAILURE_RATE_THRESHOLD) {
    const failedWorkspaces = await prisma.workspace.findMany({
      where: {
        createdAt: { gte: oneHourAgo },
        status: 'FAILED',
      },
      select: { id: true },
      take: 10,
    });

    return {
      type: IncidentType.PROVISION_FAILURE_SPIKE,
      severity: failureRate >= 0.3 ? IncidentSeverity.CRITICAL : IncidentSeverity.HIGH,
      title: 'Provision failure rate elevated',
      description: `${Math.round(failureRate * 100)}% failure rate in last hour (${failed}/${total})`,
      affectedWorkspaceIds: failedWorkspaces.map(w => w.id),
      count: failed,
    };
  }

  return null;
}

async function checkGpuStuckAttached(): Promise<IncidentCheckResult | null> {
  // Find GPUs that are ATTACHED but have no active workspace
  const stuckGpus = await prisma.fleetGpu.findMany({
    where: {
      status: 'ATTACHED',
      allocation: {
        workspace: {
          status: { in: ['TERMINATED', 'FAILED'] },
        },
      },
    },
    select: { id: true, gpuName: true },
  });

  if (stuckGpus.length > 0) {
    return {
      type: IncidentType.GPU_STUCK_ATTACHED,
      severity: stuckGpus.length >= 3 ? IncidentSeverity.HIGH : IncidentSeverity.MEDIUM,
      title: 'GPU stuck in ATTACHED state',
      description: `${stuckGpus.length} GPU(s) attached to terminated workspaces`,
      affectedGpuIds: stuckGpus.map(g => g.id),
      count: stuckGpus.length,
    };
  }

  return null;
}

async function checkPortLeaseLeaks(): Promise<IncidentCheckResult | null> {
  const leakedPorts = await prisma.workspaceEndpoint.findMany({
    where: {
      releasedAt: null,
      workspace: {
        status: { in: ['TERMINATED', 'FAILED'] },
      },
    },
    select: { id: true, workspaceId: true },
  });

  if (leakedPorts.length > 0) {
    return {
      type: IncidentType.PORT_LEASE_LEAK,
      severity: leakedPorts.length >= 5 ? IncidentSeverity.HIGH : IncidentSeverity.MEDIUM,
      title: 'Port lease leak detected',
      description: `${leakedPorts.length} unreleased port lease(s) for terminated workspaces`,
      affectedWorkspaceIds: leakedPorts.map(p => p.workspaceId),
      count: leakedPorts.length,
    };
  }

  return null;
}

async function checkHeartbeatMisses(): Promise<IncidentCheckResult | null> {
  const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
  
  const missedHeartbeats = await prisma.workspace.findMany({
    where: {
      status: { in: ['RUNNING_ASSIGNED', 'IDLE'] },
      lastAgentHeartbeatAt: { lt: sixtySecondsAgo },
    },
    select: { id: true },
  });

  if (missedHeartbeats.length >= HEARTBEAT_MISS_THRESHOLD) {
    return {
      type: IncidentType.HEARTBEAT_MISSES_SPIKE,
      severity: missedHeartbeats.length >= 10 ? IncidentSeverity.CRITICAL : IncidentSeverity.HIGH,
      title: 'Agent heartbeat misses elevated',
      description: `${missedHeartbeats.length} active workspaces with stale heartbeats`,
      affectedWorkspaceIds: missedHeartbeats.map(w => w.id),
      count: missedHeartbeats.length,
    };
  }

  return null;
}

async function checkWarmPoolShortfall(): Promise<IncidentCheckResult | null> {
  const configs = await prisma.warmPoolConfig.findMany();
  
  const shortfalls: { gpuType: string; shortfall: number }[] = [];
  
  for (const config of configs) {
    const actual = await prisma.workspace.count({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType: config.gpuType,
        region: config.region,
      },
    });
    
    const shortfall = config.targetCount - actual;
    if (shortfall >= WARM_POOL_SHORTFALL_THRESHOLD) {
      shortfalls.push({ gpuType: config.gpuType, shortfall });
    }
  }

  if (shortfalls.length > 0) {
    return {
      type: IncidentType.WARM_POOL_SHORTFALL,
      severity: shortfalls.some(s => s.shortfall >= 5) ? IncidentSeverity.HIGH : IncidentSeverity.MEDIUM,
      title: 'Warm pool below target',
      description: shortfalls.map(s => `${s.gpuType}: ${s.shortfall} below target`).join(', '),
      count: shortfalls.reduce((sum, s) => sum + s.shortfall, 0),
    };
  }

  return null;
}

async function checkNodeHealth(): Promise<IncidentCheckResult | null> {
  const unhealthyNodes = await prisma.fleetNode.findMany({
    where: {
      status: { not: 'ACTIVE' },
    },
    select: { id: true, name: true, status: true },
  });

  if (unhealthyNodes.length > 0) {
    return {
      type: IncidentType.NODE_UNHEALTHY,
      severity: unhealthyNodes.length >= 2 ? IncidentSeverity.CRITICAL : IncidentSeverity.HIGH,
      title: 'Fleet node(s) unhealthy',
      description: unhealthyNodes.map(n => `${n.name}: ${n.status}`).join(', '),
      affectedNodeIds: unhealthyNodes.map(n => n.id),
      count: unhealthyNodes.length,
    };
  }

  return null;
}

export default { runIncidentDetection };
