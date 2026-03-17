import { PrismaClient, WorkspaceCleanupJob } from '@prisma/client';
import axios from 'axios';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getProxmoxProvider } from '../providers/proxmoxFleet';

const CLEANUP_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 900_000];
const STALE_TERMINATING_MS = 10 * 60_000;
const STALE_CREATING_MS = 15 * 60_000;

function nextCleanupBackoff(attemptCount: number): number {
  if (attemptCount <= 0) return CLEANUP_BACKOFF_MS[0];
  if (attemptCount - 1 >= CLEANUP_BACKOFF_MS.length) return CLEANUP_BACKOFF_MS[CLEANUP_BACKOFF_MS.length - 1];
  return CLEANUP_BACKOFF_MS[attemptCount - 1];
}

function errorDetails(err: any) {
  const message = err?.message || 'Cleanup failed';
  const code = err?.code || err?.response?.status || 'CLEANUP_FAILED';
  return { code: String(code), message: String(message) };
}

function signGatewayRequest(body: object): string {
  const secret = process.env.GATEWAY_SERVICE_SECRET;
  if (!secret) return '';
  return crypto.createHmac('sha256', secret).update(JSON.stringify(body)).digest('hex');
}

async function releaseGatewayPorts(workspaceId: string) {
  const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || 'http://localhost:5001';
  const body = {
    workspace_id: workspaceId,
    timestamp: Date.now(),
    nonce: uuidv4(),
  };
  const signature = signGatewayRequest(body);
  await axios.post(`${gatewayUrl}/internal/gateway/release`, body, {
    headers: signature ? { 'x-gateway-signature': signature } : {},
    timeout: 10_000,
  });
}

/**
 * Close all running usage sessions for a workspace and atomically enqueue meter events.
 * Each session close + outbox enqueue is a single DB transaction.
 * Safe for duplicate calls: the WHERE clause includes status: 'RUNNING',
 * so a session already ENDED will cause a Prisma P2025 (record not found) which we catch.
 */
async function finalizeUsageSessions(prisma: PrismaClient, workspaceId: string) {
  const activeSessions = await prisma.usageSession.findMany({
    where: {
      workspaceId,
      status: 'RUNNING',
    },
  });

  for (const session of activeSessions) {
    const endTime = new Date();
    const totalSeconds = Math.max(0, Math.ceil((endTime.getTime() - session.startTime.getTime()) / 1000));
    const billedCents = Math.ceil((totalSeconds * session.pricePerHourCents) / 3600);

    try {
      await prisma.$transaction([
        prisma.usageSession.update({
          where: { id: session.id, status: 'RUNNING' },
          data: {
            endTime,
            totalSeconds,
            billedSeconds: totalSeconds,
            billedCents,
            status: 'ENDED',
          },
        }),
        prisma.workspaceMeterEventOutbox.upsert({
          where: { usageSessionId: session.id },
          update: {
            valueSeconds: totalSeconds,
            status: 'PENDING',
            nextAttemptAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
          },
          create: {
            usageSessionId: session.id,
            userId: session.userId,
            workspaceId,
            valueSeconds: totalSeconds,
            status: 'PENDING',
            nextAttemptAt: new Date(),
          },
        }),
      ]);
    } catch (err: any) {
      // P2025 = record not found (session already closed by another path). Safe to skip.
      if (err?.code === 'P2025') continue;
      throw err;
    }
  }
}

async function markCleanupFailedIncident(prisma: PrismaClient, workspaceId: string, reason: string) {
  const existing = await prisma.incident.findFirst({
    where: {
      type: 'workspace_cleanup_failed',
      status: { in: ['OPEN', 'ACKED'] },
      affectedWorkspaceIds: {
        contains: workspaceId,
      },
    },
  });

  if (existing) {
    await prisma.incident.update({
      where: { id: existing.id },
      data: {
        lastSeenAt: new Date(),
        count: { increment: 1 },
        description: reason,
      },
    });
    return;
  }

  await prisma.incident.create({
    data: {
      type: 'workspace_cleanup_failed',
      severity: 'HIGH',
      title: 'Workspace cleanup dead-letter reached',
      description: reason,
      status: 'OPEN',
      count: 1,
      affectedWorkspaceIds: JSON.stringify([workspaceId]),
    },
  });
}

async function processCleanupJob(prisma: PrismaClient, job: WorkspaceCleanupJob) {
  const now = new Date();
  const started = await prisma.workspaceCleanupJob.update({
    where: { id: job.id },
    data: {
      status: 'RUNNING',
      attemptCount: { increment: 1 },
      lastAttemptAt: now,
    },
  });

  await prisma.workspace.update({
    where: { id: job.workspaceId },
    data: {
      cleanupAttemptCount: { increment: 1 },
      cleanupLastAttemptAt: now,
    },
  }).catch(() => {});

  try {
    const proxmox = getProxmoxProvider();
    const ws = await prisma.workspace.findUnique({
      where: { id: job.workspaceId },
      include: { gpuAllocation: true, endpoint: true },
    });

    if (!ws) {
      await prisma.workspaceCleanupJob.update({
        where: { id: job.id },
        data: { status: 'DONE', completedAt: new Date(), nextAttemptAt: null },
      });
      return;
    }

    await finalizeUsageSessions(prisma, ws.id);

    // INV-5 invariant check: no RUNNING sessions should remain after finalize
    const stillRunning = await prisma.usageSession.count({
      where: { workspaceId: ws.id, status: 'RUNNING' },
    });
    if (stillRunning > 0) {
      console.error(JSON.stringify({
        level: 'error', service: 'worker', event: 'invariant_violation',
        invariant: 'INV-5', message: `${stillRunning} RUNNING session(s) remain after finalizeUsageSessions`,
        workspaceId: ws.id, timestamp: new Date().toISOString(),
      }));
    }

    // Best effort. If gateway is down, job will retry.
    await releaseGatewayPorts(ws.id);

    if (ws.proxmoxNode && ws.proxmoxVmid) {
      try {
        await proxmox.stopVm(ws.proxmoxNode, ws.proxmoxVmid);
      } catch {
        // VM may already be stopped/deleted.
      }
      try {
        await proxmox.deleteVm(ws.proxmoxNode, ws.proxmoxVmid);
      } catch (err: any) {
        if (!String(err?.message || '').toLowerCase().includes('does not exist')) {
          throw err;
        }
      }
    }

    if (ws.gpuAllocation) {
      // C3: Guard against missing GPU record — the GPU may have been removed from fleet
      const gpu = await prisma.fleetGpu.findUnique({
        where: { id: ws.gpuAllocation.gpuId },
      });
      if (gpu) {
        await prisma.fleetGpu.update({
          where: { id: ws.gpuAllocation.gpuId },
          data: {
            status: 'FREE',
            currentWorkspaceId: null,
          },
        });
      } else {
        console.warn(JSON.stringify({
          level: 'warn', service: 'worker', event: 'gpu_record_missing',
          gpuId: ws.gpuAllocation.gpuId, workspaceId: ws.id,
          message: 'GPU record not found during cleanup — allocation will be released without GPU status update',
          timestamp: new Date().toISOString(),
        }));
      }

      await prisma.workspaceGpuAllocation.update({
        where: { id: ws.gpuAllocation.id },
        data: { releasedAt: new Date() },
      });
    }

    await prisma.workspaceEndpoint.updateMany({
      where: { workspaceId: ws.id },
      data: { releasedAt: new Date() },
    });

    await prisma.workspace.update({
      where: { id: ws.id },
      data: {
        status: 'TERMINATED',
        terminatedAt: new Date(),
        cleanupNextRetryAt: null,
        cleanupLastErrorCode: null,
        cleanupLastErrorMessage: null,
      },
    });

    // INV-6 invariant check: session close + outbox must be atomic
    const endedWithoutOutbox = await prisma.usageSession.count({
      where: {
        workspaceId: ws.id,
        status: 'ENDED',
        outboxEntry: { is: null },
      },
    });
    if (endedWithoutOutbox > 0) {
      console.error(JSON.stringify({
        level: 'error', service: 'worker', event: 'invariant_violation',
        invariant: 'INV-6', message: `${endedWithoutOutbox} ENDED session(s) without outbox entry`,
        workspaceId: ws.id, timestamp: new Date().toISOString(),
      }));
    }

    await prisma.workspaceCleanupJob.update({
      where: { id: job.id },
      data: {
        status: 'DONE',
        completedAt: new Date(),
        nextAttemptAt: null,
        lastErrorCode: null,
        lastErrorMessage: null,
      },
    });
  } catch (err: any) {
    const details = errorDetails(err);
    const exhausted = started.attemptCount >= started.maxAttempts;
    const nextAttemptAt = exhausted ? null : new Date(Date.now() + nextCleanupBackoff(started.attemptCount));

    await prisma.workspaceCleanupJob.update({
      where: { id: job.id },
      data: {
        status: exhausted ? 'FAILED' : 'RETRY',
        lastErrorCode: details.code,
        lastErrorMessage: details.message,
        nextAttemptAt,
      },
    });

    await prisma.workspace.update({
      where: { id: job.workspaceId },
      data: {
        cleanupNextRetryAt: nextAttemptAt,
        cleanupLastErrorCode: details.code,
        cleanupLastErrorMessage: details.message,
      },
    }).catch(() => {});

    if (exhausted) {
      await markCleanupFailedIncident(prisma, job.workspaceId, details.message);
    }
  }
}

export async function enqueueStaleWorkspaceCleanup(prisma: PrismaClient) {
  const now = Date.now();
  const staleTerminatingBefore = new Date(now - STALE_TERMINATING_MS);
  const staleCreatingBefore = new Date(now - STALE_CREATING_MS);

  const staleTerminating = await prisma.workspace.findMany({
    where: {
      status: 'TERMINATING',
      updatedAt: { lt: staleTerminatingBefore },
    },
    select: { id: true },
    take: 100,
  });

  const staleCreating = await prisma.workspace.findMany({
    where: {
      status: 'CREATING',
      updatedAt: { lt: staleCreatingBefore },
    },
    select: { id: true },
    take: 100,
  });

  for (const ws of staleTerminating) {
    await prisma.workspaceCleanupJob.upsert({
      where: { workspaceId: ws.id },
      update: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        reasonCode: 'stale_terminating_reconcile',
      },
      create: {
        workspaceId: ws.id,
        reasonCode: 'stale_terminating_reconcile',
        status: 'PENDING',
        nextAttemptAt: new Date(),
      },
    });
  }

  for (const ws of staleCreating) {
    await prisma.workspace.update({
      where: { id: ws.id },
      data: {
        status: 'TERMINATING',
        terminationReason: 'stale_creating_reconcile',
      },
    }).catch(() => {});

    await prisma.workspaceCleanupJob.upsert({
      where: { workspaceId: ws.id },
      update: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        reasonCode: 'stale_creating_reconcile',
      },
      create: {
        workspaceId: ws.id,
        reasonCode: 'stale_creating_reconcile',
        status: 'PENDING',
        nextAttemptAt: new Date(),
      },
    });
  }
}

export async function processWorkspaceCleanupJobs(prisma: PrismaClient) {
  await enqueueStaleWorkspaceCleanup(prisma);

  const now = new Date();
  const jobs = await prisma.workspaceCleanupJob.findMany({
    where: {
      status: { in: ['PENDING', 'RUNNING', 'RETRY'] },
      OR: [
        { nextAttemptAt: null },
        { nextAttemptAt: { lte: now } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: 20,
  });

  for (const job of jobs) {
    await processCleanupJob(prisma, job);
  }
}
