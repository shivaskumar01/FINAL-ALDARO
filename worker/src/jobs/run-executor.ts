import { PrismaClient } from '@prisma/client';

/**
 * Run Executor Job
 *
 * Drives the ML training run lifecycle on Aldaro-owned GPU workspaces.
 * Lifecycle: queued → provisioning → initializing → running → uploading_artifacts → completed/failed
 *
 * Uses ONLY Aldaro fleet (Proxmox). NO external GPU providers.
 *
 * This job is called on a tick interval by the worker leader loop.
 * It processes runs in each lifecycle stage and transitions them forward.
 */

const AGENT_PORT = 8844;
const HEARTBEAT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const ARTIFACT_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:4000';

// ─────────────────────────────────────────────────────────────────────────────
// Main tick
// ─────────────────────────────────────────────────────────────────────────────

export async function runExecutorTick(prisma: PrismaClient) {
  await processQueuedRuns(prisma);
  await processProvisioningRuns(prisma);
  await processInitializingRuns(prisma);
  await processRunningRuns(prisma);
  await processUploadingArtifactsRuns(prisma);
  await processTimedOutRuns(prisma);
  await processUnreportedRunBilling(prisma);
}

/**
 * A5 FIX: durable retry for run billing. reportRunBilling is best-effort at finalize;
 * if Stripe was unreachable, stripeUsageReported stays false and the run would never be
 * billed (runs don't use the meter-event outbox). Sweep finished-but-unreported runs and
 * retry. Safe/idempotent: reportRunBilling re-checks the flag and Stripe dedupes on run.id.
 */
async function processUnreportedRunBilling(prisma: PrismaClient) {
  const runs = await prisma.run.findMany({
    where: {
      stripeUsageReported: false,
      billedSeconds: { gt: 0 },
      status: { in: ['completed', 'failed', 'canceled', 'timed_out'] },
      user: { stripeCustomerId: { not: null } },
    },
    select: { id: true },
    orderBy: { updatedAt: 'asc' },
    take: 25,
  });

  for (const run of runs) {
    await reportRunBilling(prisma, run.id);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage: queued → provisioning
// ─────────────────────────────────────────────────────────────────────────────

async function processQueuedRuns(prisma: PrismaClient) {
  const runs = await prisma.run.findMany({
    where: { status: 'queued' },
    orderBy: { createdAt: 'asc' },
    take: 10,
  });

  for (const run of runs) {
    try {
      await provisionRunWorkspace(prisma, run);
    } catch (err: any) {
      console.error(`[RunExecutor] Failed to provision run ${run.id}:`, err.message);
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          errorMessage: `Provisioning failed: ${err.message?.slice(0, 500)}`,
          finishedAt: new Date(),
        },
      });
    }
  }
}

/**
 * Provision a workspace for a queued run.
 * Tries to assign a warm workspace first; falls back to cold provision marker.
 */
async function provisionRunWorkspace(prisma: PrismaClient, run: any) {
  // If this run already has an upstream workspace, skip (idempotency)
  if (run.upstreamInstanceId) {
    console.log(`[RunExecutor] Run ${run.id} already has workspace ${run.upstreamInstanceId}, skipping provision`);
    await prisma.run.update({
      where: { id: run.id },
      data: { status: 'provisioning' },
    });
    return;
  }

  // 1. Try to claim a warm workspace matching the GPU type
  const warmWorkspace = await prisma.workspace.findFirst({
    where: {
      status: 'WARM_AVAILABLE',
      gpuType: run.gpuType,
      assignedUserId: null,
      isWarmPool: true,
      verificationStatus: 'PASS',
    },
    orderBy: { verificationScore: 'desc' },
  });

  if (warmWorkspace) {
    // Assign the warm workspace to this run's user
    await prisma.$transaction([
      prisma.workspace.update({
        where: { id: warmWorkspace.id },
        data: {
          status: 'RUNNING_ASSIGNED',
          assignedUserId: run.userId,
          assignedAt: new Date(),
          startedAt: new Date(),
          isWarmPool: false,
        },
      }),
      prisma.run.update({
        where: { id: run.id },
        data: {
          status: 'provisioning',
          upstreamInstanceId: warmWorkspace.id,
          infraStartedAt: new Date(),
        },
      }),
    ]);

    console.log(`[RunExecutor] Assigned warm workspace ${warmWorkspace.id} to run ${run.id}`);
    return;
  }

  // 2. No warm workspace available, create a cold workspace record.
  //    The warm-pool tick (processCreatingWorkspaces) will pick this up and
  //    provision the actual VM on Proxmox.
  const { v4: uuidv4 } = await import('uuid');
  const workspaceId = uuidv4();

  await prisma.$transaction([
    prisma.workspace.create({
      data: {
        id: workspaceId,
        gpuType: run.gpuType,
        gpuCount: run.gpuCount,
        region: 'US',
        status: 'CREATING',
        isWarmPool: false,
        assignedUserId: run.userId,
        assignedAt: new Date(),
      },
    }),
    prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'provisioning',
        upstreamInstanceId: workspaceId,
        infraStartedAt: new Date(),
      },
    }),
  ]);

  console.log(`[RunExecutor] Created cold workspace ${workspaceId} for run ${run.id}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage: provisioning → initializing
// ─────────────────────────────────────────────────────────────────────────────

async function processProvisioningRuns(prisma: PrismaClient) {
  const runs = await prisma.run.findMany({
    where: { status: 'provisioning', upstreamInstanceId: { not: null } },
    take: 20,
  });

  for (const run of runs) {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id: run.upstreamInstanceId! },
      });

      if (!workspace) {
        console.error(`[RunExecutor] Workspace ${run.upstreamInstanceId} not found for run ${run.id}`);
        await prisma.run.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            errorMessage: 'Workspace disappeared during provisioning',
            finishedAt: new Date(),
          },
        });
        continue;
      }

      // Workspace is ready (agent is responsive, VM is running)
      if (workspace.status === 'RUNNING_ASSIGNED') {
        await prisma.run.update({
          where: { id: run.id },
          data: { status: 'initializing' },
        });
        console.log(`[RunExecutor] Run ${run.id} workspace ready, transitioning to initializing`);
        continue;
      }

      // Workspace failed during provisioning
      if (workspace.status === 'FAILED' || workspace.status === 'TERMINATED') {
        await prisma.run.update({
          where: { id: run.id },
          data: {
            status: 'failed',
            errorMessage: `Workspace provisioning failed: ${workspace.lastErrorCode || 'UNKNOWN'}`,
            finishedAt: new Date(),
          },
        });
        console.log(`[RunExecutor] Run ${run.id} workspace ${workspace.id} failed (${workspace.lastErrorCode})`);
        continue;
      }

      // Otherwise workspace is still booting (CREATING, WAITING_FOR_AGENT, etc.), keep waiting
    } catch (err: any) {
      console.error(`[RunExecutor] Error checking provisioning for run ${run.id}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage: initializing → running
// ─────────────────────────────────────────────────────────────────────────────

async function processInitializingRuns(prisma: PrismaClient) {
  const runs = await prisma.run.findMany({
    where: { status: 'initializing', upstreamInstanceId: { not: null } },
    take: 10,
    include: {
      project: true,
    },
  });

  for (const run of runs) {
    try {
      const workspace = await prisma.workspace.findUnique({
        where: { id: run.upstreamInstanceId! },
      });

      if (!workspace || !workspace.vmInternalIp) {
        console.error(`[RunExecutor] Workspace ${run.upstreamInstanceId} missing or has no IP for run ${run.id}`);
        continue;
      }

      await initializeRun(prisma, run, workspace);
    } catch (err: any) {
      console.error(`[RunExecutor] Error initializing run ${run.id}:`, err.message);
      await prisma.run.update({
        where: { id: run.id },
        data: {
          status: 'failed',
          errorMessage: `Initialization error: ${err.message?.slice(0, 500)}`,
          finishedAt: new Date(),
        },
      });
    }
  }
}

/**
 * Send execution payload to the in-VM agent.
 * POST http://<workspace-ip>:8844/execute
 */
export async function initializeRun(prisma: PrismaClient, run: any, workspace: any) {
  const project = run.project || await prisma.project.findUnique({ where: { id: run.projectId } });

  if (!project) {
    throw new Error(`Project ${run.projectId} not found`);
  }

  const payload = {
    run_id: run.id,
    repo_url: project.repoUrl,
    branch: project.defaultBranch,
    command: run.command,
    env: safeJsonParse(run.envJson, {}),
    artifact_paths: safeJsonParse(run.artifactPathsJson, []),
    callback_url: `${API_BASE_URL}/v1/runs/${run.id}/events`,
    max_seconds: run.hoursMax * 3600,
  };

  // SECURITY: Validate VM IP is in the expected workspace subnet
  const vmSubnet = process.env.VM_SUBNET || '10.10.';
  if (!workspace.vmInternalIp.startsWith(vmSubnet)) {
    throw new Error(`VM IP ${workspace.vmInternalIp} is not in allowed subnet, possible SSRF`);
  }

  const agentUrl = `http://${workspace.vmInternalIp}:${AGENT_PORT}/execute`;
  console.log(`[RunExecutor] Sending execute to agent for run ${run.id}`);

  try {
    const response = await fetch(agentUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30_000), // 30s connection timeout
    });

    if (!response.ok) {
      const text = await response.text().catch(() => 'unknown');
      throw new Error(`Agent returned ${response.status}: ${text.slice(0, 300)}`);
    }

    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'running',
        startedAt: new Date(),
      },
    });

    console.log(`[RunExecutor] Run ${run.id} now running on workspace ${workspace.id}`);
  } catch (err: any) {
    console.error(`[RunExecutor] Agent execute call failed for run ${run.id}:`, err.message);

    await prisma.run.update({
      where: { id: run.id },
      data: {
        status: 'failed',
        errorMessage: `Agent initialization failed: ${err.message?.slice(0, 500)}`,
        finishedAt: new Date(),
        infraFinishedAt: new Date(),
      },
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage: running → monitor for timeout / heartbeat / completion
// ─────────────────────────────────────────────────────────────────────────────

async function processRunningRuns(prisma: PrismaClient) {
  const runs = await prisma.run.findMany({
    where: { status: 'running' },
    take: 50,
  });

  for (const run of runs) {
    try {
      // Check timeout first (most critical)
      const timedOut = await checkRunTimeout(prisma, run);
      if (timedOut) continue;

      // Check heartbeat
      const heartbeatFailed = await checkRunHeartbeat(prisma, run);
      if (heartbeatFailed) continue;

      // Check for agent-reported completion (via RunEvent STATUS events)
      // The agent posts STATUS events to /v1/runs/:run_id/events which updates
      // the run status directly. So if the run is still 'running' here,
      // the agent hasn't reported completion yet. Nothing to do.
    } catch (err: any) {
      console.error(`[RunExecutor] Error monitoring run ${run.id}:`, err.message);
    }
  }
}

/**
 * Check if a running run has exceeded its hoursMax.
 * Returns true if the run was timed out.
 */
export async function checkRunTimeout(prisma: PrismaClient, run: any): Promise<boolean> {
  if (!run.startedAt) return false;

  const maxMs = run.hoursMax * 3600 * 1000;
  const elapsed = Date.now() - new Date(run.startedAt).getTime();

  if (elapsed < maxMs) return false;

  console.log(`[RunExecutor] Run ${run.id} timed out (elapsed: ${Math.round(elapsed / 1000)}s, max: ${run.hoursMax}h)`);

  const billedSeconds = Math.ceil(elapsed / 1000);

  await prisma.run.update({
    where: { id: run.id },
    data: {
      status: 'timed_out',
      finishedAt: new Date(),
      infraFinishedAt: new Date(),
      billedSeconds,
      errorMessage: `Run exceeded maximum duration of ${run.hoursMax} hours`,
    },
  });

  // Trigger workspace cleanup
  if (run.upstreamInstanceId) {
    await enqueueWorkspaceCleanup(prisma, run.upstreamInstanceId, 'run_timed_out');
  }

  // Report billing
  await reportRunBilling(prisma, run.id);

  return true;
}

/**
 * Check if the agent is still alive by querying AgentSession heartbeat.
 * Returns true if the heartbeat has failed.
 */
export async function checkRunHeartbeat(prisma: PrismaClient, run: any): Promise<boolean> {
  const session = await prisma.agentSession.findFirst({
    where: { runId: run.id },
    orderBy: { createdAt: 'desc' },
  });

  // If no session exists yet, the agent might still be starting up.
  // Give it some grace, only fail if the run has been 'running' for > 5 min without a session.
  if (!session) {
    if (!run.startedAt) return false;
    const sinceStart = Date.now() - new Date(run.startedAt).getTime();
    if (sinceStart > HEARTBEAT_TIMEOUT_MS) {
      console.log(`[RunExecutor] Run ${run.id} has no agent session after ${Math.round(sinceStart / 1000)}s`);
      await failRun(prisma, run, 'Agent never registered a session');
      return true;
    }
    return false;
  }

  if (!session.lastHeartbeatAt) return false;

  const heartbeatAge = Date.now() - new Date(session.lastHeartbeatAt).getTime();

  if (heartbeatAge > HEARTBEAT_TIMEOUT_MS) {
    console.log(`[RunExecutor] Run ${run.id} agent heartbeat timeout (last: ${Math.round(heartbeatAge / 1000)}s ago)`);
    await failRun(prisma, run, 'Agent heartbeat timeout');
    return true;
  }

  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage: uploading_artifacts → completed
// ─────────────────────────────────────────────────────────────────────────────

async function processUploadingArtifactsRuns(prisma: PrismaClient) {
  const runs = await prisma.run.findMany({
    where: { status: 'uploading_artifacts' },
    take: 20,
  });

  for (const run of runs) {
    try {
      // Check if artifacts are done by looking at the most recent STATUS event
      const latestStatusEvent = await prisma.runEvent.findFirst({
        where: {
          runId: run.id,
          type: 'STATUS',
        },
        orderBy: { createdAt: 'desc' },
      });

      if (latestStatusEvent) {
        const payload = safeJsonParse(latestStatusEvent.payload, {});
        if (payload.state === 'completed' || payload.state === 'failed') {
          // Agent reported terminal state, finalize
          await finalizeRun(prisma, run);
          continue;
        }
      }

      // Timeout: if uploading has been going on too long, finalize anyway
      if (run.finishedAt) {
        const uploadDuration = Date.now() - new Date(run.finishedAt).getTime();
        if (uploadDuration > ARTIFACT_UPLOAD_TIMEOUT_MS) {
          console.log(`[RunExecutor] Run ${run.id} artifact upload timed out after ${Math.round(uploadDuration / 1000)}s`);
          await finalizeRun(prisma, run);
        }
      }
    } catch (err: any) {
      console.error(`[RunExecutor] Error processing uploading_artifacts for run ${run.id}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Stage: timed_out cleanup
// ─────────────────────────────────────────────────────────────────────────────

async function processTimedOutRuns(prisma: PrismaClient) {
  // Find timed_out runs that still have a workspace attached and haven't been cleaned up
  const runs = await prisma.run.findMany({
    where: {
      status: 'timed_out',
      upstreamInstanceId: { not: null },
      infraFinishedAt: null,
    },
    take: 10,
  });

  for (const run of runs) {
    try {
      await prisma.run.update({
        where: { id: run.id },
        data: { infraFinishedAt: new Date() },
      });

      if (run.upstreamInstanceId) {
        await enqueueWorkspaceCleanup(prisma, run.upstreamInstanceId, 'run_timed_out');
      }

      await reportRunBilling(prisma, run.id);
    } catch (err: any) {
      console.error(`[RunExecutor] Error cleaning up timed_out run ${run.id}:`, err.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Finalize: billing + workspace release
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Called when a run reaches a terminal state.
 * Calculates billed seconds, reports to Stripe, and releases the workspace.
 */
export async function finalizeRun(prisma: PrismaClient, run: any) {
  const now = new Date();

  // Calculate billed seconds
  let billedSeconds = run.billedSeconds || 0;
  if (run.startedAt && billedSeconds === 0) {
    const finishTime = run.finishedAt ? new Date(run.finishedAt) : now;
    billedSeconds = Math.ceil((finishTime.getTime() - new Date(run.startedAt).getTime()) / 1000);
  }

  // Determine terminal status (default to completed if we got here)
  const terminalStatus = ['completed', 'failed', 'canceled', 'timed_out'].includes(run.status)
    ? run.status
    : 'completed';

  await prisma.run.update({
    where: { id: run.id },
    data: {
      status: terminalStatus,
      finishedAt: run.finishedAt || now,
      infraFinishedAt: run.infraFinishedAt || now,
      billedSeconds,
    },
  });

  console.log(`[RunExecutor] Finalized run ${run.id}: status=${terminalStatus}, billed=${billedSeconds}s`);

  // Report billing to Stripe
  await reportRunBilling(prisma, run.id);

  // Release the workspace
  if (run.upstreamInstanceId) {
    await releaseRunWorkspace(prisma, run.upstreamInstanceId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fail a run and trigger workspace cleanup.
 */
async function failRun(prisma: PrismaClient, run: any, errorMessage: string) {
  const now = new Date();
  let billedSeconds = 0;
  if (run.startedAt) {
    billedSeconds = Math.ceil((now.getTime() - new Date(run.startedAt).getTime()) / 1000);
  }

  await prisma.run.update({
    where: { id: run.id },
    data: {
      status: 'failed',
      errorMessage,
      finishedAt: now,
      infraFinishedAt: now,
      billedSeconds,
    },
  });

  if (run.upstreamInstanceId) {
    await enqueueWorkspaceCleanup(prisma, run.upstreamInstanceId, 'run_failed');
  }

  await reportRunBilling(prisma, run.id);
}

/**
 * Report run billing to Stripe.
 * Uses the same Stripe meter event pattern as the API billing lib.
 */
async function reportRunBilling(prisma: PrismaClient, runId: string) {
  try {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { user: true },
    });

    if (!run || !run.user?.stripeCustomerId || run.stripeUsageReported || !run.billedSeconds) {
      return;
    }

    // Lazy-import Stripe to avoid requiring the key when it's not needed
    const Stripe = (await import('stripe')).default;
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
      apiVersion: '2023-10-16' as any,
    });

    await stripe.billing.meterEvents.create({
      event_name: 'gpu_runtime_seconds',
      payload: {
        value: run.billedSeconds.toString(),
        stripe_customer_id: run.user.stripeCustomerId,
      },
      identifier: run.id,
      timestamp: Math.floor(Date.now() / 1000),
    });

    await prisma.run.update({
      where: { id: run.id },
      data: { stripeUsageReported: true },
    });

    console.log(`[RunExecutor] Reported ${run.billedSeconds}s for run ${run.id} to Stripe`);
  } catch (err: any) {
    // Non-fatal: the workspace metering outbox or a retry sweep can pick this up later
    console.error(`[RunExecutor] Billing report failed for run ${runId}:`, err.message);
  }
}

/**
 * Release a workspace after a run finishes.
 * If the workspace was from the warm pool, return it to WARM_AVAILABLE.
 * Otherwise, mark it for termination.
 */
async function releaseRunWorkspace(prisma: PrismaClient, workspaceId: string) {
  try {
    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) return;

    // Skip if already in a terminal or cleanup state
    if (['TERMINATED', 'TERMINATING', 'FAILED'].includes(workspace.status)) {
      return;
    }

    if (workspace.isWarmPool) {
      // Return to warm pool
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          status: 'WARM_AVAILABLE',
          assignedUserId: null,
          assignedAt: null,
        },
      });
      console.log(`[RunExecutor] Returned workspace ${workspaceId} to warm pool`);
    } else {
      // Cold workspace, enqueue for termination
      await enqueueWorkspaceCleanup(prisma, workspaceId, 'run_completed');
    }
  } catch (err: any) {
    console.error(`[RunExecutor] Failed to release workspace ${workspaceId}:`, err.message);
  }
}

/**
 * Enqueue a workspace cleanup job (same pattern as warm-pool.ts).
 * Uses upsert to be idempotent.
 */
async function enqueueWorkspaceCleanup(prisma: PrismaClient, workspaceId: string, reasonCode: string) {
  try {
    // Set workspace to TERMINATING
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        status: 'TERMINATING',
        terminationReason: reasonCode,
      },
    });

    // Upsert cleanup job
    await prisma.workspaceCleanupJob.upsert({
      where: { workspaceId },
      update: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        reasonCode,
      },
      create: {
        workspaceId,
        reasonCode,
        status: 'PENDING',
        nextAttemptAt: new Date(),
      },
    });

    console.log(`[RunExecutor] Enqueued cleanup for workspace ${workspaceId} (reason: ${reasonCode})`);
  } catch (err: any) {
    console.error(`[RunExecutor] Failed to enqueue cleanup for workspace ${workspaceId}:`, err.message);
  }
}

function safeJsonParse(json: string | null | undefined, fallback: any): any {
  if (!json) return fallback;
  try {
    return JSON.parse(json);
  } catch {
    return fallback;
  }
}
