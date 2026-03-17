/**
 * Cleanup Stress Tests
 *
 * Exercises cleanup job and sweeper logic under concurrent conditions:
 * - Multiple stale workspaces processed simultaneously
 * - Cleanup job upsert idempotency under concurrent calls
 * - Session finalization racing with cleanup
 * - Workspace status transitions under concurrent cleanup
 *
 * Requires: PostgreSQL (not SQLite)
 * Run: npx jest tests/stress/cleanup-stress.test.ts --testTimeout=60000
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TEST_REGION = 'cleanup-stress-region';

let testUserId: string;

beforeAll(async () => {
  const user = await prisma.user.upsert({
    where: { email: 'cleanup-stress@test.local' },
    update: {},
    create: {
      email: 'cleanup-stress@test.local',
      passwordHash: 'not-a-real-hash',
      role: 'CUSTOMER',
      customerAccessStatus: 'APPROVED',
    },
  });
  testUserId = user.id;
});

afterAll(async () => {
  await prisma.workspaceMeterEventOutbox.deleteMany({
    where: { workspace: { region: TEST_REGION } },
  });
  await prisma.usageSession.deleteMany({
    where: { workspace: { region: TEST_REGION } },
  });
  await prisma.workspaceCleanupJob.deleteMany({
    where: { workspace: { region: TEST_REGION } },
  });
  await prisma.workspace.deleteMany({ where: { region: TEST_REGION } });
  await prisma.user.deleteMany({ where: { email: 'cleanup-stress@test.local' } });
  await prisma.$disconnect();
});

// Simulate sweeper: find stale CREATING and enqueue cleanup
async function sweepStaleCreating() {
  const stale = await prisma.workspace.findMany({
    where: {
      status: 'CREATING',
      region: TEST_REGION,
      updatedAt: { lt: new Date(Date.now() - 1000) }, // 1s for testing (normally 15min)
    },
  });

  for (const ws of stale) {
    await prisma.workspace.update({
      where: { id: ws.id },
      data: { status: 'TERMINATING' },
    });

    await prisma.workspaceCleanupJob.upsert({
      where: { workspaceId: ws.id },
      update: { status: 'PENDING', nextAttemptAt: new Date() },
      create: {
        workspaceId: ws.id,
        reasonCode: 'stale_creating',
        status: 'PENDING',
        nextAttemptAt: new Date(),
      },
    });
  }
  return stale.length;
}

// Simulate session finalization (from cleanup job)
async function finalizeWorkspaceSessions(workspaceId: string) {
  const sessions = await prisma.usageSession.findMany({
    where: { workspaceId, status: 'RUNNING' },
  });

  for (const session of sessions) {
    const endTime = new Date();
    const totalSeconds = Math.max(0, Math.ceil((endTime.getTime() - session.startTime.getTime()) / 1000));
    const billedCents = Math.ceil((totalSeconds * session.pricePerHourCents) / 3600);

    try {
      await prisma.$transaction([
        prisma.usageSession.update({
          where: { id: session.id, status: 'RUNNING' },
          data: { endTime, totalSeconds, billedSeconds: totalSeconds, billedCents, status: 'ENDED' },
        }),
        prisma.workspaceMeterEventOutbox.upsert({
          where: { usageSessionId: session.id },
          update: { valueSeconds: totalSeconds, status: 'PENDING', nextAttemptAt: new Date() },
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
      if (err?.code === 'P2025') continue;
      throw err;
    }
  }
}

describe('Cleanup Stress Tests', () => {
  test('10 stale CREATING workspaces swept simultaneously', async () => {
    // Create 10 stale workspaces (updatedAt in the past)
    for (let i = 0; i < 10; i++) {
      await prisma.workspace.create({
        data: {
          gpuType: 'RTX_5090',
          region: TEST_REGION,
          status: 'CREATING',
          isWarmPool: false,
          updatedAt: new Date(Date.now() - 120000), // 2 min ago
        },
      });
    }

    // Run sweeper 3 times concurrently
    const results = await Promise.allSettled([
      sweepStaleCreating(),
      sweepStaleCreating(),
      sweepStaleCreating(),
    ]);

    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected.length).toBe(0);

    // All should be TERMINATING now
    const terminating = await prisma.workspace.count({
      where: { region: TEST_REGION, status: 'TERMINATING' },
    });
    expect(terminating).toBe(10);

    // Each should have exactly 1 cleanup job
    const jobs = await prisma.workspaceCleanupJob.findMany({
      where: { workspace: { region: TEST_REGION } },
    });
    expect(jobs.length).toBe(10);
  });

  test('cleanup job upsert is idempotent under 5 concurrent calls', async () => {
    const ws = await prisma.workspace.create({
      data: {
        gpuType: 'RTX_5090',
        region: TEST_REGION,
        status: 'TERMINATING',
        isWarmPool: false,
      },
    });

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        prisma.workspaceCleanupJob.upsert({
          where: { workspaceId: ws.id },
          update: { status: 'PENDING', nextAttemptAt: new Date() },
          create: {
            workspaceId: ws.id,
            reasonCode: 'concurrent_test',
            status: 'PENDING',
            nextAttemptAt: new Date(),
          },
        })
      )
    );

    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected.length).toBe(0);

    const jobs = await prisma.workspaceCleanupJob.findMany({
      where: { workspaceId: ws.id },
    });
    expect(jobs.length).toBe(1); // @unique on workspaceId
  });

  test('session finalization + concurrent close: no crash, 1 outbox', async () => {
    const ws = await prisma.workspace.create({
      data: {
        assignedUserId: testUserId,
        gpuType: 'RTX_5090',
        region: TEST_REGION,
        status: 'TERMINATING',
        isWarmPool: false,
      },
    });

    // Create a RUNNING session
    await prisma.usageSession.create({
      data: {
        userId: testUserId,
        workspaceId: ws.id,
        gpuType: 'RTX_5090',
        startTime: new Date(Date.now() - 3600000), // 1 hour ago
        status: 'RUNNING',
        pricePerHourCents: 150,
      },
    });

    // Race: finalize from 5 concurrent callers
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => finalizeWorkspaceSessions(ws.id))
    );

    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected.length).toBe(0);

    const sessions = await prisma.usageSession.findMany({
      where: { workspaceId: ws.id },
    });
    expect(sessions.length).toBe(1);
    expect(sessions[0].status).toBe('ENDED');
    expect(sessions[0].billedCents).toBeGreaterThan(0);

    const outbox = await prisma.workspaceMeterEventOutbox.findMany({
      where: { workspaceId: ws.id },
    });
    expect(outbox.length).toBe(1);
  });

  test('20 TERMINATING workspaces with sessions: all close cleanly', async () => {
    const workspaces: string[] = [];

    for (let i = 0; i < 20; i++) {
      const ws = await prisma.workspace.create({
        data: {
          assignedUserId: testUserId,
          gpuType: 'RTX_5090',
          region: TEST_REGION,
          status: 'TERMINATING',
          isWarmPool: false,
        },
      });
      workspaces.push(ws.id);

      await prisma.usageSession.create({
        data: {
          userId: testUserId,
          workspaceId: ws.id,
          gpuType: 'RTX_5090',
          startTime: new Date(Date.now() - (i + 1) * 600000), // varying durations
          status: 'RUNNING',
          pricePerHourCents: 100 + i * 10,
        },
      });
    }

    // Finalize all concurrently
    await Promise.all(
      workspaces.map(id => finalizeWorkspaceSessions(id))
    );

    // Verify: 0 RUNNING sessions in test region
    const running = await prisma.usageSession.count({
      where: { workspace: { region: TEST_REGION }, status: 'RUNNING' },
    });
    expect(running).toBe(0);

    // Verify: every ENDED session has an outbox entry
    const ended = await prisma.usageSession.findMany({
      where: { workspace: { region: TEST_REGION }, status: 'ENDED' },
    });

    for (const session of ended) {
      const outbox = await prisma.workspaceMeterEventOutbox.findFirst({
        where: { usageSessionId: session.id },
      });
      expect(outbox).not.toBeNull();
    }
  });
});
