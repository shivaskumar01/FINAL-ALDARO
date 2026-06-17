import { PrismaClient } from '@prisma/client';

/**
 * Burst Orchestrator
 *
 * Runs every 2 minutes under leader lock. Detects demand that exceeds
 * Aldaro-owned fleet capacity and provisions temporary burst nodes from
 * upstream GPU cloud providers (e.g. Lambda, CoreWeave).
 *
 * Lifecycle:
 *   PROVISIONING → ACTIVE → DRAINING → TERMINATED
 *
 * The orchestrator also drains and terminates burst nodes once local
 * capacity frees up, to minimise external spend.
 */

// How long to wait for a burst node to come online before timing out
const PROVISION_TIMEOUT_MS = Math.min(
  Math.max(parseInt(process.env.BURST_PROVISION_TIMEOUT_MS || String(10 * 60 * 1000)) || 600_000, 60_000),
  30 * 60 * 1000, // Cap at 30 minutes
);

// Minimum warm pool shortfall that triggers burst provisioning
const BURST_THRESHOLD = Math.min(
  Math.max(parseInt(process.env.BURST_THRESHOLD || '2') || 2, 1),
  100, // Cap at 100
);

// Maximum concurrent burst nodes
const MAX_BURST_NODES = Math.min(
  Math.max(parseInt(process.env.MAX_BURST_NODES || '10') || 10, 1),
  50, // Hard cap to prevent runaway provisioning
);

export async function burstOrchestratorTick(prisma: PrismaClient) {
  await checkDemandAndProvision(prisma);
  await checkProvisionTimeout(prisma);
  await drainExcessBurstNodes(prisma);
  await cleanupTerminatedNodes(prisma);
}

// ---------------------------------------------------------------------------
// 1. Demand detection → provision burst nodes
// ---------------------------------------------------------------------------
async function checkDemandAndProvision(prisma: PrismaClient) {
  const configs = await prisma.warmPoolConfig.findMany();

  for (const cfg of configs) {
    // Count current warm pool supply
    const warmCount = await prisma.workspace.count({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType: cfg.gpuType,
        region: cfg.region,
      },
    });

    // Count pending demand (workspaces waiting for assignment)
    const pendingDemand = await prisma.workspace.count({
      where: {
        status: { in: ['CREATING', 'WAITING_FOR_AGENT'] },
        gpuType: cfg.gpuType,
        region: cfg.region,
        isWarmPool: false,
      },
    });

    // Count free GPUs of this type on local fleet
    const freeLocalGpus = await prisma.fleetGpu.count({
      where: {
        gpuType: cfg.gpuType,
        status: 'FREE',
        node: { status: 'ONLINE' },
      },
    });

    const shortfall = cfg.targetCount - warmCount;
    const totalUnmetDemand = Math.max(0, shortfall) + pendingDemand - freeLocalGpus;

    if (totalUnmetDemand < BURST_THRESHOLD) continue;

    // Count existing active/provisioning burst nodes for this GPU type
    const existingBurst = await prisma.burstNode.count({
      where: {
        gpuType: cfg.gpuType,
        status: { in: ['PROVISIONING', 'ACTIVE'] },
      },
    });

    if (existingBurst >= MAX_BURST_NODES) {
      console.log(`[BurstOrchestrator] Max burst nodes (${MAX_BURST_NODES}) reached for ${cfg.gpuType}`);
      continue;
    }

    const toProvision = Math.min(totalUnmetDemand, MAX_BURST_NODES - existingBurst);

    for (let i = 0; i < toProvision; i++) {
      const nodeId = `burst-${cfg.gpuType}-${Date.now()}-${i}`;
      await prisma.burstNode.create({
        data: {
          id: nodeId,
          provider: process.env.BURST_PROVIDER || 'lambda',
          region: cfg.region,
          gpuType: cfg.gpuType,
          gpuCount: 1,
          status: 'PROVISIONING',
          triggerReason: `shortfall=${shortfall} pending=${pendingDemand} freeLocal=${freeLocalGpus}`,
          hourlyRateCents: cfg.currentSpotPriceCents || 0,
        },
      });

      console.log(`[BurstOrchestrator] Provisioning burst node ${nodeId} (${cfg.gpuType} in ${cfg.region})`);
    }
  }
}

// ---------------------------------------------------------------------------
// 2. Timeout detection, mark stale PROVISIONING nodes as failed
// ---------------------------------------------------------------------------
async function checkProvisionTimeout(prisma: PrismaClient) {
  const cutoff = new Date(Date.now() - PROVISION_TIMEOUT_MS);

  const stale = await prisma.burstNode.findMany({
    where: {
      status: 'PROVISIONING',
      provisionedAt: { lt: cutoff },
    },
  });

  for (const node of stale) {
    await prisma.burstNode.update({
      where: { id: node.id },
      data: {
        status: 'TERMINATED',
        terminatedAt: new Date(),
        lastErrorCode: 'PROVISION_TIMEOUT',
        lastErrorMessage: `Node did not come online within ${PROVISION_TIMEOUT_MS / 1000}s`,
      },
    });
    console.log(`[BurstOrchestrator] Timed out burst node ${node.id}`);
  }
}

// ---------------------------------------------------------------------------
// 3. Drain excess burst nodes when local capacity recovers
// ---------------------------------------------------------------------------
async function drainExcessBurstNodes(prisma: PrismaClient) {
  const configs = await prisma.warmPoolConfig.findMany();

  for (const cfg of configs) {
    const warmCount = await prisma.workspace.count({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType: cfg.gpuType,
        region: cfg.region,
      },
    });

    const freeLocalGpus = await prisma.fleetGpu.count({
      where: {
        gpuType: cfg.gpuType,
        status: 'FREE',
        node: { status: 'ONLINE' },
      },
    });

    // If local pool is healthy (at or above target), drain burst nodes
    if (warmCount >= cfg.targetCount && freeLocalGpus > 0) {
      const activeBurst = await prisma.burstNode.findMany({
        where: {
          gpuType: cfg.gpuType,
          status: 'ACTIVE',
        },
        orderBy: { provisionedAt: 'asc' }, // drain oldest first
      });

      // Drain up to freeLocalGpus burst nodes (1:1 replacement)
      const toDrain = Math.min(activeBurst.length, freeLocalGpus);
      for (let i = 0; i < toDrain; i++) {
        await prisma.burstNode.update({
          where: { id: activeBurst[i].id },
          data: {
            status: 'DRAINING',
            drainingAt: new Date(),
          },
        });
        console.log(`[BurstOrchestrator] Draining burst node ${activeBurst[i].id} (local capacity recovered)`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Cleanup: terminate fully drained nodes (no running workspaces)
// ---------------------------------------------------------------------------
async function cleanupTerminatedNodes(prisma: PrismaClient) {
  const drainingNodes = await prisma.burstNode.findMany({
    where: { status: 'DRAINING' },
  });

  for (const node of drainingNodes) {
    // Check if any workspaces are still running on this burst node
    const activeWorkspaces = await prisma.workspace.count({
      where: {
        proxmoxNode: node.proxmoxNodeName || undefined,
        status: { in: ['RUNNING_ASSIGNED', 'CREATING', 'WAITING_FOR_AGENT'] },
      },
    });

    if (activeWorkspaces === 0) {
      await prisma.burstNode.update({
        where: { id: node.id },
        data: {
          status: 'TERMINATED',
          terminatedAt: new Date(),
        },
      });
      console.log(`[BurstOrchestrator] Terminated burst node ${node.id} (fully drained)`);
    }
  }
}
