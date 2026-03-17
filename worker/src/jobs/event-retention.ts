import { PrismaClient } from '@prisma/client';

/**
 * Experience Event Retention Management
 * 
 * Handles lifecycle of ExperienceEvent data:
 * 1. Events 7+ days old are aggregated into daily rollups
 * 2. Events 30+ days old are deleted (only keep rollups)
 * 
 * This keeps Postgres fast while retaining historical trends.
 * Run this job once per day (e.g., at 2 AM).
 */

const EVENT_TYPE_MAPPINGS: Record<string, keyof RollupCounts> = {
  'auth.login_success': 'loginSuccessCount',
  'auth.login_failed': 'loginFailCount',
  'workspace.created': 'workspaceCreatedCount',
  'workspace.started': 'workspaceStartedCount',
  'workspace.failed': 'workspaceFailedCount',
  'workspace.terminated': 'workspaceTerminatedCount',
  'connect.ssh_success': 'connectSshSuccessCount',
  'connect.ssh_failed': 'connectSshFailCount',
  'connect.jupyter_success': 'connectJupyterSuccessCount',
  'connect.jupyter_failed': 'connectJupyterFailCount',
  'billing.meter_emitted': 'billingMeterEmittedCount',
  'billing.meter_failed': 'billingMeterFailCount',
};

interface RollupCounts {
  loginSuccessCount: number;
  loginFailCount: number;
  workspaceCreatedCount: number;
  workspaceStartedCount: number;
  workspaceFailedCount: number;
  workspaceTerminatedCount: number;
  connectSshSuccessCount: number;
  connectSshFailCount: number;
  connectJupyterSuccessCount: number;
  connectJupyterFailCount: number;
  billingMeterEmittedCount: number;
  billingMeterFailCount: number;
}

/**
 * Main retention tick - run once per day
 */
export async function eventRetentionTick(prisma: PrismaClient): Promise<void> {
  console.log('[EventRetention] Starting retention tick...');

  // Step 1: Aggregate events from 7-30 days ago into rollups
  await aggregateOldEvents(prisma);

  // Step 2: Delete events older than 30 days
  await deleteOldEvents(prisma);

  console.log('[EventRetention] Retention tick complete');
}

/**
 * Aggregate events from 7-30 days ago
 * Creates daily rollups grouped by user and gpuType
 */
async function aggregateOldEvents(prisma: PrismaClient): Promise<void> {
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  thirtyDaysAgo.setHours(0, 0, 0, 0);

  // Get distinct dates that need aggregation
  const events = await prisma.experienceEvent.findMany({
    where: {
      createdAt: {
        gte: thirtyDaysAgo,
        lt: sevenDaysAgo,
      },
    },
    select: {
      id: true,
      createdAt: true,
      userId: true,
      type: true,
      latencyMs: true,
    },
  });

  if (events.length === 0) {
    console.log('[EventRetention] No events to aggregate');
    return;
  }

  console.log(`[EventRetention] Aggregating ${events.length} events`);

  // Group events by date, userId
  const groups = new Map<string, { 
    date: Date; 
    userId: string | null; 
    counts: RollupCounts;
    provisionLatencies: number[];
    connectLatencies: number[];
  }>();

  for (const event of events) {
    const date = new Date(event.createdAt);
    date.setHours(0, 0, 0, 0);
    
    const key = `${date.toISOString()}_${event.userId || 'system'}`;
    
    if (!groups.has(key)) {
      groups.set(key, {
        date,
        userId: event.userId,
        counts: {
          loginSuccessCount: 0,
          loginFailCount: 0,
          workspaceCreatedCount: 0,
          workspaceStartedCount: 0,
          workspaceFailedCount: 0,
          workspaceTerminatedCount: 0,
          connectSshSuccessCount: 0,
          connectSshFailCount: 0,
          connectJupyterSuccessCount: 0,
          connectJupyterFailCount: 0,
          billingMeterEmittedCount: 0,
          billingMeterFailCount: 0,
        },
        provisionLatencies: [],
        connectLatencies: [],
      });
    }

    const group = groups.get(key)!;
    
    // Increment count based on event type
    const countField = EVENT_TYPE_MAPPINGS[event.type];
    if (countField) {
      group.counts[countField]++;
    }

    // Track latencies for averaging
    if (event.latencyMs) {
      if (event.type.startsWith('workspace.')) {
        group.provisionLatencies.push(event.latencyMs);
      }
      if (event.type.startsWith('connect.')) {
        group.connectLatencies.push(event.latencyMs);
      }
    }
  }

  // Upsert rollups
  for (const [, group] of groups) {
    const avgProvisionLatency = group.provisionLatencies.length > 0
      ? group.provisionLatencies.reduce((a, b) => a + b, 0) / group.provisionLatencies.length
      : null;
    
    const avgConnectLatency = group.connectLatencies.length > 0
      ? group.connectLatencies.reduce((a, b) => a + b, 0) / group.connectLatencies.length
      : null;

    const existingRollup = await prisma.dailyEventRollup.findFirst({
      where: {
        date: group.date,
        userId: group.userId,
        gpuType: null,
      },
    });

    if (existingRollup) {
      await prisma.dailyEventRollup.update({
        where: { id: existingRollup.id },
        data: {
          loginSuccessCount: { increment: group.counts.loginSuccessCount },
          loginFailCount: { increment: group.counts.loginFailCount },
          workspaceCreatedCount: { increment: group.counts.workspaceCreatedCount },
          workspaceStartedCount: { increment: group.counts.workspaceStartedCount },
          workspaceFailedCount: { increment: group.counts.workspaceFailedCount },
          workspaceTerminatedCount: { increment: group.counts.workspaceTerminatedCount },
          connectSshSuccessCount: { increment: group.counts.connectSshSuccessCount },
          connectSshFailCount: { increment: group.counts.connectSshFailCount },
          connectJupyterSuccessCount: { increment: group.counts.connectJupyterSuccessCount },
          connectJupyterFailCount: { increment: group.counts.connectJupyterFailCount },
          billingMeterEmittedCount: { increment: group.counts.billingMeterEmittedCount },
          billingMeterFailCount: { increment: group.counts.billingMeterFailCount },
          avgProvisionLatencyMs: avgProvisionLatency,
          avgConnectLatencyMs: avgConnectLatency,
        },
      });
    } else {
      await prisma.dailyEventRollup.create({
        data: {
          date: group.date,
          userId: group.userId,
          gpuType: null,
          ...group.counts,
          avgProvisionLatencyMs: avgProvisionLatency,
          avgConnectLatencyMs: avgConnectLatency,
        },
      });
    }
  }

  console.log(`[EventRetention] Created/updated ${groups.size} rollup records`);
}

/**
 * Delete events older than 30 days
 * At this point they've been aggregated into rollups
 */
async function deleteOldEvents(prisma: PrismaClient): Promise<void> {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const result = await prisma.experienceEvent.deleteMany({
    where: {
      createdAt: { lt: thirtyDaysAgo },
    },
  });

  if (result.count > 0) {
    console.log(`[EventRetention] Deleted ${result.count} events older than 30 days`);
  }
}

/**
 * Get aggregated metrics from rollups (for long-term queries)
 */
export async function getHistoricalMetrics(
  prisma: PrismaClient,
  startDate: Date,
  endDate: Date,
  userId?: string,
): Promise<{
  totalLogins: number;
  totalWorkspacesCreated: number;
  totalConnects: number;
  avgProvisionLatencyMs: number | null;
}> {
  const rollups = await prisma.dailyEventRollup.findMany({
    where: {
      date: { gte: startDate, lte: endDate },
      userId: userId ?? null,
    },
  });

  let totalLogins = 0;
  let totalWorkspacesCreated = 0;
  let totalConnects = 0;
  let provisionLatencies: number[] = [];

  for (const r of rollups) {
    totalLogins += r.loginSuccessCount;
    totalWorkspacesCreated += r.workspaceCreatedCount;
    totalConnects += r.connectSshSuccessCount + r.connectJupyterSuccessCount;
    if (r.avgProvisionLatencyMs) {
      provisionLatencies.push(r.avgProvisionLatencyMs);
    }
  }

  const avgProvisionLatencyMs = provisionLatencies.length > 0
    ? provisionLatencies.reduce((a, b) => a + b, 0) / provisionLatencies.length
    : null;

  return {
    totalLogins,
    totalWorkspacesCreated,
    totalConnects,
    avgProvisionLatencyMs,
  };
}
