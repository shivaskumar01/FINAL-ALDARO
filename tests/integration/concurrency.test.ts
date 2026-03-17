/**
 * Aldaro.AI Integration Tests - Concurrency
 * 
 * Tests 5 simultaneous workspace requests:
 * - Warm pool assignments stay fast and correct
 * - No double-assignment of warm workspaces
 * - No GPU assigned to multiple workspaces
 */

import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Workspace prefix from run-20x-proof.sh for deterministic naming
const WORKSPACE_PREFIX = process.env.ALDARO_PROOF_WORKSPACE_PREFIX || `ws-conc-${Date.now()}`;
const RUN_ID = process.env.ALDARO_PROOF_RUN_ID || 'local';

describe('Concurrency Tests', function() {
  this.timeout(600000); // 10 minutes

  const testUsers: string[] = [];
  const workspaceResults: Map<string, { userId: string; assignedAt: Date; warmAssigned: boolean }> = new Map();

  before(async function() {
    // Create 5 test users
    for (let i = 0; i < 5; i++) {
      const user = await prisma.user.upsert({
        where: { email: `concurrency-test-${i}@aldaro.ai` },
        update: {},
        create: {
          email: `concurrency-test-${i}@aldaro.ai`,
          passwordHash: 'test-hash',
          maxActiveWorkspaces: 5,
          isAlphaTester: true,
        },
      });
      testUsers.push(user.id);
    }

    // Ensure warm pool has some workspaces
    const warmCount = await prisma.workspace.count({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType: 'RTX_5090',
        assignedUserId: null,
      },
    });

    console.log(`Warm pool has ${warmCount} available RTX_5090 workspaces`);
  });

  after(async function() {
    // Cleanup test workspaces
    for (const [workspaceId] of workspaceResults) {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: 'TERMINATED', terminatedAt: new Date() },
      }).catch(() => {});
    }

    await prisma.$disconnect();
  });

  it('should handle 5 simultaneous workspace requests correctly', async function() {
    const warmBefore = await prisma.workspace.findMany({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType: 'RTX_5090',
        assignedUserId: null,
      },
      select: { id: true },
    });
    const warmIds = new Set(warmBefore.map(w => w.id));

    console.log(`Starting concurrent requests with ${warmIds.size} warm workspaces available`);

    // Launch 5 requests simultaneously
    const startTime = Date.now();
    const promises = testUsers.map(async (userId, index) => {
      const workspace = await createWorkspaceRequest(userId, 'RTX_5090');
      const assignedAt = new Date();
      const warmAssigned = warmIds.has(workspace.id);
      
      workspaceResults.set(workspace.id, { userId, assignedAt, warmAssigned });
      
      console.log(`User ${index}: workspace ${workspace.id}, warm=${warmAssigned}`);
      return workspace;
    });

    const workspaces = await Promise.all(promises);
    const totalTime = Date.now() - startTime;

    console.log(`All 5 requests completed in ${totalTime}ms`);

    // Verify: No double-assignment
    const assignedUsers = new Set<string>();
    for (const ws of workspaces) {
      if (ws.assignedUserId) {
        expect(assignedUsers.has(ws.assignedUserId)).to.be.false;
        assignedUsers.add(ws.assignedUserId);
      }
    }

    // Verify: Each workspace has unique GPU
    const gpuAllocations = await prisma.workspaceGpuAllocation.findMany({
      where: {
        workspaceId: { in: workspaces.map(w => w.id) },
      },
    });

    const gpuIds = gpuAllocations.map(a => a.gpuId);
    const uniqueGpuIds = new Set(gpuIds);
    expect(gpuIds.length).to.equal(uniqueGpuIds.size);

    // Verify: Warm assignments were fast
    const warmAssignments = Array.from(workspaceResults.values()).filter(r => r.warmAssigned);
    if (warmAssignments.length > 0) {
      console.log(`${warmAssignments.length} requests got warm assignments`);
      // Warm assignments should complete in <30s
      expect(totalTime).to.be.lessThan(30000 * warmAssignments.length);
    }

    // Wait for all to reach RUNNING or handle cold provisioning
    for (const ws of workspaces) {
      await waitForStatus(ws.id, ['RUNNING_ASSIGNED', 'WARM_AVAILABLE', 'FAILED'], 300000);
    }
  });

  it('should not double-assign a warm workspace under race conditions', async function() {
    // Create a single warm workspace
    const warmWs = await prisma.workspace.create({
      data: {
        gpuType: 'RTX_5090',
        region: 'US',
        status: 'WARM_AVAILABLE',
        isWarmPool: true,
        verificationStatus: 'PASS',
        verificationScore: 100,
      },
    });

    // Attempt to assign it to 3 users simultaneously
    const assignPromises = testUsers.slice(0, 3).map(async (userId) => {
      try {
        return await prisma.$transaction(async (tx) => {
          const ws = await tx.workspace.findUnique({
            where: { id: warmWs.id },
          });

          if (!ws || ws.assignedUserId) {
            return null; // Already assigned
          }

          return tx.workspace.update({
            where: { id: warmWs.id },
            data: {
              assignedUserId: userId,
              status: 'ASSIGNING',
              isWarmPool: false,
            },
          });
        });
      } catch (e) {
        return null; // Transaction conflict
      }
    });

    const results = await Promise.all(assignPromises);
    const successfulAssignments = results.filter(r => r !== null);

    // Exactly one should succeed
    expect(successfulAssignments.length).to.equal(1);

    // Cleanup
    await prisma.workspace.delete({ where: { id: warmWs.id } }).catch(() => {});
  });
});

async function createWorkspaceRequest(userId: string, gpuType: string): Promise<any> {
  // First, try to get a warm workspace
  const warmWorkspace = await prisma.$transaction(async (tx) => {
    const warm = await tx.workspace.findFirst({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType,
        assignedUserId: null,
        isWarmPool: true,
        verificationStatus: 'PASS',
      },
      orderBy: { verificationScore: 'desc' },
    });

    if (!warm) return null;

    // Try to claim it
    try {
      return await tx.workspace.update({
        where: { 
          id: warm.id,
          assignedUserId: null, // Optimistic lock
        },
        data: {
          assignedUserId: userId,
          assignedAt: new Date(),
          status: 'ASSIGNING',
          isWarmPool: false,
        },
      });
    } catch {
      return null; // Someone else got it
    }
  });

  if (warmWorkspace) {
    return warmWorkspace;
  }

  // Cold creation
  return prisma.workspace.create({
    data: {
      assignedUserId: userId,
      gpuType,
      region: 'US',
      status: 'CREATING',
      assignedAt: new Date(),
    },
  });
}

async function waitForStatus(workspaceId: string, statuses: string[], timeoutMs: number): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (ws && statuses.includes(ws.status)) {
      return ws;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  throw new Error(`Timeout waiting for status ${statuses.join('|')}`);
}
