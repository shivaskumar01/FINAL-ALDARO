import { PrismaClient } from '@prisma/client';

/**
 * Idle Workspace Termination
 *
 * This job only marks/queues termination. Actual infrastructure teardown,
 * billing finalization, and retries are handled by workspace-cleanup jobs.
 */

async function enqueueCleanupJob(prisma: PrismaClient, workspaceId: string, reasonCode: string) {
  const now = new Date();

  await prisma.$transaction([
    prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        status: 'TERMINATING',
        terminationReason: reasonCode,
        cleanupNextRetryAt: now,
      },
    }),
    prisma.workspaceCleanupJob.upsert({
      where: { workspaceId },
      update: {
        reasonCode,
        status: 'PENDING',
        nextAttemptAt: now,
        completedAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
      create: {
        workspaceId,
        reasonCode,
        status: 'PENDING',
        nextAttemptAt: now,
        maxAttempts: 20,
      },
    }),
  ]);
}

export async function idleTerminationTick(prisma: PrismaClient) {
  const activeWorkspaces = await prisma.workspace.findMany({
    where: {
      status: 'RUNNING_ASSIGNED',
    },
    select: {
      id: true,
      createdAt: true,
      assignedAt: true,
      lastAgentHeartbeatAt: true,
      lastGpuUtilizationPct: true,
    },
  });

  const now = new Date();
  const idleThresholdMinutes = parseInt(process.env.AUTO_TERMINATE_IDLE_MINUTES || '20', 10);
  const deadAgentThresholdMinutes = 5;

  for (const ws of activeWorkspaces) {
    let reasonCode: string | null = null;

    if (ws.lastAgentHeartbeatAt) {
      const heartbeatAge = (now.getTime() - ws.lastAgentHeartbeatAt.getTime()) / 1000 / 60;
      if (heartbeatAge > deadAgentThresholdMinutes) {
        reasonCode = 'dead_agent';
      }
    } else {
      const workspaceAge = (now.getTime() - ws.createdAt.getTime()) / 1000 / 60;
      if (workspaceAge > 10) {
        reasonCode = 'agent_missing';
      }
    }

    if (!reasonCode && ws.lastGpuUtilizationPct !== null && ws.lastGpuUtilizationPct < 5 && ws.assignedAt) {
      const runtimeMins = (now.getTime() - ws.assignedAt.getTime()) / 1000 / 60;
      if (runtimeMins > idleThresholdMinutes) {
        reasonCode = 'idle_timeout';
      }
    }

    if (!reasonCode) continue;

    console.log(`[IdleTermination] Queueing workspace ${ws.id} for cleanup (${reasonCode})`);
    await enqueueCleanupJob(prisma, ws.id, reasonCode);
  }
}
