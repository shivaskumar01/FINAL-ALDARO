import { PrismaClient } from '@prisma/client';
import { warmPoolTick, terminateWorkspace } from './jobs/warm-pool';
import { idleTerminationTick } from './jobs/idle-termination';
import { eventRetentionTick } from './jobs/event-retention';
import { emailOutboxTick } from './jobs/email-outbox';
import { fleetDailyAggBackfill, fleetDailyAggTodayRefresh } from './jobs/fleet-daily-agg';
import { processWorkspaceCleanupJobs } from './jobs/workspace-cleanup';
import { processWorkspaceMeterEvents } from './jobs/workspace-metering';
import { runExecutorTick } from './jobs/run-executor';
import { volumeManagerTick } from './jobs/volume-manager';
import { getProxmoxProvider } from './providers/proxmoxFleet';
import crypto from 'crypto';

/**
 * Aldaro Worker Service
 * 
 * Manages workspace lifecycle using ONLY Aldaro-owned GPU infrastructure.
 * NO external GPU providers (RunPod, etc.) are supported.
 * 
 * This worker uses a LEADER LOCK pattern to ensure single-writer semantics:
 * - Only one worker instance can hold the leader lock
 * - Leader lock uses Postgres advisory locks with fencing tokens
 * - If a worker loses the lock, it stops processing immediately
 * 
 * Jobs (run under leader lock):
 * - Warm Pool: Maintains pre-provisioned warm workspaces for fast assignment
 * - Idle Termination: Terminates idle workspaces to conserve resources
 * - Incident Detection: Auto-generates incidents from system health checks
 */

const prisma = new PrismaClient();

const WARM_POOL_TICK_MS = (parseInt(process.env.WARM_POOL_TICK_SECONDS || '30')) * 1000;
const IDLE_TICK_MS = 60 * 1000;
const INCIDENT_TICK_MS = 30 * 1000;
const EMAIL_OUTBOX_TICK_MS = 30 * 1000;
const WORKSPACE_CLEANUP_TICK_MS = 15 * 1000;
const WORKSPACE_METERING_TICK_MS = 15 * 1000;
const RUN_EXECUTOR_TICK_MS = 5 * 1000;
const VOLUME_MANAGER_TICK_MS = 15 * 1000;
const FLEET_AGG_TODAY_REFRESH_MS = 60 * 60 * 1000; // hourly
const RETENTION_TICK_MS = 60 * 60 * 1000; // 1 hour (runs once when conditions met)
const LEADER_LOCK_ID = 1001; // Postgres advisory lock ID for worker leader
const LEADER_HEARTBEAT_MS = 10 * 1000;

// Worker identity
const WORKER_ID = process.env.WORKER_ID || `worker-${crypto.randomUUID().slice(0, 8)}`;
let currentFencingToken: string | null = null;
let isLeader = false;
let leaderLockConnection: any = null;

async function main() {
  console.log('='.repeat(60));
  console.log('Aldaro Worker Service Started');
  console.log(`Worker ID: ${WORKER_ID}`);
  console.log('Infrastructure: Aldaro Fleet (Proxmox)');
  console.log('External providers: DISABLED');
  console.log('='.repeat(60));

  // Validate required config
  const requiredEnv = [
    'DATABASE_URL',
    'PROXMOX_API_URL',
    'PROXMOX_API_TOKEN_ID',
    'PROXMOX_API_TOKEN_SECRET',
    'ALDARO_AGENT_SHARED_SECRET',
  ];

  const missing = requiredEnv.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }

  // Validate Proxmox connection
  try {
    const proxmox = getProxmoxProvider();
    console.log('✓ Proxmox connection validated');
  } catch (err) {
    console.error('✗ Failed to connect to Proxmox:', err);
    process.exit(1);
  }

  // Acquire leader lock
  console.log('Attempting to acquire leader lock...');
  await acquireLeaderLock();

  // Start tick loops (only run when leader)
  setInterval(leaderTick, 1000); // Check leadership every second
  
  // Leader heartbeat (update DB record)
  setInterval(updateLeaderHeartbeat, LEADER_HEARTBEAT_MS);

  console.log(`Warm pool tick interval: ${WARM_POOL_TICK_MS}ms`);
  console.log(`Idle termination tick interval: ${IDLE_TICK_MS}ms`);
  console.log(`Incident detection tick interval: ${INCIDENT_TICK_MS}ms`);
}

/**
 * Acquire the leader lock using Postgres advisory lock
 * This ensures only one worker can be the leader at a time
 */
async function acquireLeaderLock(): Promise<void> {
  try {
    // Try to acquire the advisory lock
    const result = await prisma.$queryRaw<{ acquired: boolean }[]>`
      SELECT pg_try_advisory_lock(${LEADER_LOCK_ID}) as acquired
    `;
    
    if (result[0]?.acquired) {
      isLeader = true;
      currentFencingToken = crypto.randomUUID();
      
      // Update leader record in DB
      await prisma.workerLeader.upsert({
        where: { id: 1 },
        update: {
          workerId: WORKER_ID,
          fencingToken: currentFencingToken,
          acquiredAt: new Date(),
          lastTickAt: new Date(),
        },
        create: {
          id: 1,
          workerId: WORKER_ID,
          fencingToken: currentFencingToken,
          acquiredAt: new Date(),
          lastTickAt: new Date(),
        },
      });
      
      console.log(`✓ Acquired leader lock (fencing token: ${currentFencingToken.slice(0, 8)}...)`);
    } else {
      console.log('Another worker is the leader. Waiting...');
      
      // Wait and retry
      setTimeout(acquireLeaderLock, 5000);
    }
  } catch (err) {
    console.error('Failed to acquire leader lock:', err);
    setTimeout(acquireLeaderLock, 5000);
  }
}

/**
 * Verify we still hold the leader lock
 */
async function verifyLeaderLock(): Promise<boolean> {
  if (!isLeader || !currentFencingToken) return false;
  
  try {
    // Check if our fencing token is still current
    const leader = await prisma.workerLeader.findUnique({ where: { id: 1 } });
    
    if (leader?.fencingToken !== currentFencingToken) {
      console.error('FENCING: Another worker has taken over leadership!');
      isLeader = false;
      currentFencingToken = null;
      
      // Try to re-acquire
      setTimeout(acquireLeaderLock, 1000);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error('Failed to verify leader lock:', err);
    return false;
  }
}

/**
 * Update leader heartbeat in DB
 */
async function updateLeaderHeartbeat(): Promise<void> {
  if (!isLeader || !currentFencingToken) return;
  
  try {
    await prisma.workerLeader.update({
      where: { id: 1 },
      data: { lastTickAt: new Date() },
    });
  } catch (err) {
    console.error('Failed to update leader heartbeat:', err);
  }
}

// Track last tick times
let lastWarmPoolTick = 0;
let lastIdleTick = 0;
let lastIncidentTick = 0;
let lastRetentionTick = 0;
let lastRetentionDate: string | null = null; // Run retention once per day
let lastEmailOutboxTick = 0;
let lastWorkspaceCleanupTick = 0;
let lastWorkspaceMeteringTick = 0;
let lastRunExecutorTick = 0;
let lastVolumeManagerTick = 0;
let lastFleetAggTick = 0;
let lastFleetAggDate: string | null = null; // Run backfill once per day

/**
 * Main leader tick - runs all jobs under leader lock
 */
async function leaderTick() {
  if (!isLeader) return;
  
  // Verify we still hold the lock
  const stillLeader = await verifyLeaderLock();
  if (!stillLeader) return;
  
  const now = Date.now();
  
  // Warm Pool Tick
  if (now - lastWarmPoolTick >= WARM_POOL_TICK_MS) {
    lastWarmPoolTick = now;
    try {
      await warmPoolTick(prisma);
    } catch (err) {
      console.error('Error in warmPoolTick:', err);
    }
  }
  
  // Idle Termination Tick
  if (now - lastIdleTick >= IDLE_TICK_MS) {
    lastIdleTick = now;
    try {
      await idleTerminationTick(prisma);
    } catch (err) {
      console.error('Error in idleTerminationTick:', err);
    }
  }
  
  // Incident Detection Tick
  if (now - lastIncidentTick >= INCIDENT_TICK_MS) {
    lastIncidentTick = now;
    try {
      await incidentDetectionTick();
    } catch (err) {
      console.error('Error in incidentDetectionTick:', err);
    }
  }

  // Email Outbox Tick (application in review / application accepted)
  if (now - lastEmailOutboxTick >= EMAIL_OUTBOX_TICK_MS) {
    lastEmailOutboxTick = now;
    try {
      await emailOutboxTick(prisma);
    } catch (err) {
      console.error('Error in emailOutboxTick:', err);
    }
  }

  // Workspace cleanup queue tick (terminate retries + stale-state sweeper)
  if (now - lastWorkspaceCleanupTick >= WORKSPACE_CLEANUP_TICK_MS) {
    lastWorkspaceCleanupTick = now;
    try {
      await processWorkspaceCleanupJobs(prisma);
    } catch (err) {
      console.error('Error in processWorkspaceCleanupJobs:', err);
    }
  }

  // Workspace Stripe metering outbox tick
  if (now - lastWorkspaceMeteringTick >= WORKSPACE_METERING_TICK_MS) {
    lastWorkspaceMeteringTick = now;
    try {
      await processWorkspaceMeterEvents(prisma);
    } catch (err) {
      console.error('Error in processWorkspaceMeterEvents:', err);
    }
  }

  // Run Executor Tick (drive ML run lifecycle)
  if (now - lastRunExecutorTick >= RUN_EXECUTOR_TICK_MS) {
    lastRunExecutorTick = now;
    try {
      await runExecutorTick(prisma);
    } catch (err) {
      console.error('Error in runExecutorTick:', err);
    }
  }

  // Volume Manager Tick (create/delete persistent volumes)
  if (now - lastVolumeManagerTick >= VOLUME_MANAGER_TICK_MS) {
    lastVolumeManagerTick = now;
    try {
      await volumeManagerTick(prisma);
    } catch (err) {
      console.error('Error in volumeManagerTick:', err);
    }
  }

  // Fleet daily aggregates:
  // - hourly refresh for today
  // - daily backfill for last 45 days around ~2 AM
  if (now - lastFleetAggTick >= FLEET_AGG_TODAY_REFRESH_MS) {
    lastFleetAggTick = now;
    try {
      await fleetDailyAggTodayRefresh(prisma);
    } catch (err) {
      console.error('Error in fleetDailyAggTodayRefresh:', err);
    }
  }

  const currentDate = new Date().toISOString().slice(0, 10);
  const currentHour = new Date().getHours();
  if (currentDate !== lastFleetAggDate && currentHour >= 2 && currentHour < 4) {
    lastFleetAggDate = currentDate;
    try {
      await fleetDailyAggBackfill(prisma, 45);
    } catch (err) {
      console.error('Error in fleetDailyAggBackfill:', err);
    }
  }

  // Event Retention Tick (once per day, run at ~2 AM)
  if (currentDate !== lastRetentionDate && currentHour >= 2 && currentHour < 4) {
    lastRetentionDate = currentDate;
    lastRetentionTick = now;
    try {
      console.log('[Worker] Running daily event retention...');
      await eventRetentionTick(prisma);
    } catch (err) {
      console.error('Error in eventRetentionTick:', err);
    }
  }
}

/**
 * Incident Detection Tick
 * Runs under leader lock to ensure single-writer for incidents
 */
async function incidentDetectionTick() {
  // Check provision failure rate
  await checkProvisionFailures();
  
  // Check for stuck GPUs
  await checkStuckGpus();
  
  // Check for port leaks
  await checkPortLeaks();
  
  // Check heartbeat misses
  await checkHeartbeatMisses();
  
  // Check warm pool shortfall
  await checkWarmPoolShortfall();

  // Check cleanup backlog growth / dead letters
  await checkCleanupBacklog();

  // Check metering emission failures
  await checkMeteringFailures();
}

async function checkProvisionFailures() {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  
  const [total, failed] = await Promise.all([
    prisma.workspace.count({ where: { createdAt: { gte: oneHourAgo } } }),
    prisma.workspace.count({ where: { createdAt: { gte: oneHourAgo }, status: 'FAILED' } }),
  ]);
  
  if (total < 5) return;
  
  const failureRate = failed / total;
  
  if (failureRate >= 0.1) {
    await upsertIncident({
      type: 'provision_failure_spike',
      severity: failureRate >= 0.3 ? 'CRITICAL' : 'HIGH',
      title: 'Provision failure rate elevated',
      description: `${Math.round(failureRate * 100)}% failure rate in last hour (${failed}/${total})`,
    });
  } else {
    await resolveIncident('provision_failure_spike');
  }
}

async function checkStuckGpus() {
  const stuckGpus = await prisma.fleetGpu.findMany({
    where: {
      status: { in: ['ALLOCATED', 'RESERVED'] },
      allocation: {
        workspace: {
          status: { in: ['TERMINATED', 'FAILED'] },
        },
      },
    },
  });
  
  if (stuckGpus.length > 0) {
    await upsertIncident({
      type: 'gpu_stuck_attached',
      severity: stuckGpus.length >= 3 ? 'HIGH' : 'MEDIUM',
      title: 'GPU stuck in allocated state',
      description: `${stuckGpus.length} GPU(s) allocated to terminated workspaces`,
    });
    
    // Auto-fix: release stuck GPUs
    for (const gpu of stuckGpus) {
      await prisma.fleetGpu.update({
        where: { id: gpu.id },
        data: { status: 'FREE', currentWorkspaceId: null },
      });
      console.log(`[Incident] Auto-released stuck GPU ${gpu.id}`);
    }
  } else {
    await resolveIncident('gpu_stuck_attached');
  }
}

async function checkPortLeaks() {
  const leakedPorts = await prisma.workspaceEndpoint.findMany({
    where: {
      releasedAt: null,
      workspace: {
        status: { in: ['TERMINATED', 'FAILED'] },
      },
    },
  });
  
  if (leakedPorts.length > 0) {
    await upsertIncident({
      type: 'port_lease_leak',
      severity: leakedPorts.length >= 5 ? 'HIGH' : 'MEDIUM',
      title: 'Port lease leak detected',
      description: `${leakedPorts.length} unreleased port lease(s)`,
    });
    
    // Auto-fix: release leaked ports
    for (const port of leakedPorts) {
      await prisma.workspaceEndpoint.update({
        where: { id: port.id },
        data: { releasedAt: new Date() },
      });
      console.log(`[Incident] Auto-released leaked port lease ${port.id}`);
    }
  } else {
    await resolveIncident('port_lease_leak');
  }
}

async function checkHeartbeatMisses() {
  const sixtySecondsAgo = new Date(Date.now() - 60 * 1000);
  
  const misses = await prisma.workspace.count({
    where: {
      status: { in: ['RUNNING_ASSIGNED', 'IDLE'] },
      lastAgentHeartbeatAt: { lt: sixtySecondsAgo },
    },
  });
  
  if (misses >= 5) {
    await upsertIncident({
      type: 'heartbeat_misses_spike',
      severity: misses >= 10 ? 'CRITICAL' : 'HIGH',
      title: 'Agent heartbeat misses elevated',
      description: `${misses} active workspaces with stale heartbeats`,
    });
  } else {
    await resolveIncident('heartbeat_misses_spike');
  }
}

async function checkWarmPoolShortfall() {
  const configs = await prisma.warmPoolConfig.findMany();
  let totalShortfall = 0;
  
  for (const cfg of configs) {
    const actual = await prisma.workspace.count({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType: cfg.gpuType,
        region: cfg.region,
      },
    });
    
    const shortfall = cfg.targetCount - actual;
    if (shortfall > 0) totalShortfall += shortfall;
  }
  
  if (totalShortfall >= 3) {
    await upsertIncident({
      type: 'warm_pool_shortfall',
      severity: totalShortfall >= 5 ? 'HIGH' : 'MEDIUM',
      title: 'Warm pool below target',
      description: `Total shortfall: ${totalShortfall} workspaces`,
    });
  } else {
    await resolveIncident('warm_pool_shortfall');
  }
}

async function checkCleanupBacklog() {
  const [backlog, failed] = await Promise.all([
    prisma.workspaceCleanupJob.count({
      where: {
        status: { in: ['PENDING', 'RUNNING', 'RETRY'] },
      },
    }),
    prisma.workspaceCleanupJob.count({
      where: { status: 'FAILED' },
    }),
  ]);

  if (failed > 0) {
    await upsertIncident({
      type: 'workspace_cleanup_failed',
      severity: 'HIGH',
      title: 'Workspace cleanup dead-letter detected',
      description: `${failed} cleanup job(s) are in FAILED dead-letter state`,
    });
    return;
  }

  if (backlog >= 10) {
    await upsertIncident({
      type: 'workspace_cleanup_backlog',
      severity: backlog >= 25 ? 'CRITICAL' : 'HIGH',
      title: 'Workspace cleanup backlog elevated',
      description: `${backlog} cleanup job(s) pending/retrying`,
    });
  } else {
    await resolveIncident('workspace_cleanup_backlog');
    await resolveIncident('workspace_cleanup_failed');
  }
}

async function checkMeteringFailures() {
  const failed = await prisma.workspaceMeterEventOutbox.count({
    where: { status: 'FAILED' },
  });

  if (failed > 0) {
    await upsertIncident({
      type: 'billing_meter_emit_failed',
      severity: failed >= 10 ? 'CRITICAL' : 'HIGH',
      title: 'Billing metering emission failures detected',
      description: `${failed} metering outbox event(s) are in FAILED state`,
    });
  } else {
    await resolveIncident('billing_meter_emit_failed');
  }
}

async function upsertIncident(data: {
  type: string;
  severity: string;
  title: string;
  description: string;
}) {
  const existing = await prisma.incident.findFirst({
    where: { type: data.type, status: { in: ['OPEN', 'ACKED'] } },
  });
  
  if (existing) {
    await prisma.incident.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        count: { increment: 1 },
        severity: data.severity,
        description: data.description,
      },
    });
  } else {
    await prisma.incident.create({
      data: {
        type: data.type,
        severity: data.severity,
        title: data.title,
        description: data.description,
        status: 'OPEN',
        count: 1,
      },
    });
    console.log(`[Incident] Created: ${data.type} - ${data.title}`);
  }
}

async function resolveIncident(type: string) {
  const updated = await prisma.incident.updateMany({
    where: { type, status: { in: ['OPEN', 'ACKED'] } },
    data: {
      status: 'RESOLVED',
      resolvedAt: new Date(),
      notes: 'Auto-resolved: condition cleared',
    },
  });
  
  if (updated.count > 0) {
    console.log(`[Incident] Auto-resolved: ${type}`);
  }
}

// Graceful shutdown
async function shutdown() {
  console.log('Shutting down worker...');
  
  // Release leader lock
  if (isLeader) {
    try {
      await prisma.$executeRaw`SELECT pg_advisory_unlock(${LEADER_LOCK_ID})`;
      console.log('Released leader lock');
    } catch (err) {
      console.error('Failed to release leader lock:', err);
    }
  }
  
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --- Process-level crash discipline ---
// Worker must terminate on unhandled errors to avoid ghost processing with stale state.

process.on('unhandledRejection', (reason: any) => {
  console.error(JSON.stringify({
    level: 'fatal',
    service: 'worker',
    workerId: WORKER_ID,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    event: 'unhandled_rejection',
    error: reason?.message || String(reason),
    stack: reason?.stack,
  }));
  // Terminate: worker must not continue with potentially corrupted tick state.
  // Advisory lock is session-scoped and will auto-release on disconnect.
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  console.error(JSON.stringify({
    level: 'fatal',
    service: 'worker',
    workerId: WORKER_ID,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    event: 'uncaught_exception',
    error: err.message,
    stack: err.stack,
  }));
  process.exit(1);
});

main().catch((err) => {
  console.error('Worker failed to start:', err);
  process.exit(1);
});
