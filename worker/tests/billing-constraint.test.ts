/**
 * Billing Constraint Tests
 *
 * Verifies that the partial unique index "usage_sessions_one_running_per_workspace"
 * enforces INV-1: at most one RUNNING usage session per workspace.
 *
 * Requires: PostgreSQL with the migration applied.
 * Run: npx jest worker/tests/billing-constraint.test.ts
 */

import { PrismaClient, Prisma } from '@prisma/client';

const prisma = new PrismaClient();
const TEST_REGION = 'constraint-test-region';

let testUserId: string;

beforeAll(async () => {
  const user = await prisma.user.upsert({
    where: { email: 'constraint-test@test.local' },
    update: {},
    create: {
      email: 'constraint-test@test.local',
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
  await prisma.workspace.deleteMany({ where: { region: TEST_REGION } });
  await prisma.user.deleteMany({ where: { email: 'constraint-test@test.local' } });
  await prisma.$disconnect();
});

async function createWorkspace() {
  return prisma.workspace.create({
    data: {
      assignedUserId: testUserId,
      gpuType: 'RTX_5090',
      region: TEST_REGION,
      status: 'RUNNING_ASSIGNED',
      isWarmPool: false,
    },
  });
}

describe('Partial Unique Index: one RUNNING session per workspace', () => {
  test('first RUNNING session succeeds', async () => {
    const ws = await createWorkspace();

    const session = await prisma.usageSession.create({
      data: {
        userId: testUserId,
        workspaceId: ws.id,
        gpuType: 'RTX_5090',
        startTime: new Date(),
        status: 'RUNNING',
        pricePerHourCents: 150,
      },
    });

    expect(session.id).toBeDefined();
    expect(session.status).toBe('RUNNING');
  });

  test('second RUNNING session for same workspace is blocked by DB', async () => {
    const ws = await createWorkspace();

    // First session
    await prisma.usageSession.create({
      data: {
        userId: testUserId,
        workspaceId: ws.id,
        gpuType: 'RTX_5090',
        startTime: new Date(),
        status: 'RUNNING',
        pricePerHourCents: 150,
      },
    });

    // Second session, should fail with unique constraint violation
    await expect(
      prisma.usageSession.create({
        data: {
          userId: testUserId,
          workspaceId: ws.id,
          gpuType: 'RTX_5090',
          startTime: new Date(),
          status: 'RUNNING',
          pricePerHourCents: 150,
        },
      })
    ).rejects.toThrow();
  });

  test('second RUNNING session gives P2002 unique constraint error', async () => {
    const ws = await createWorkspace();

    await prisma.usageSession.create({
      data: {
        userId: testUserId,
        workspaceId: ws.id,
        gpuType: 'RTX_5090',
        startTime: new Date(),
        status: 'RUNNING',
        pricePerHourCents: 150,
      },
    });

    try {
      await prisma.usageSession.create({
        data: {
          userId: testUserId,
          workspaceId: ws.id,
          gpuType: 'RTX_5090',
          startTime: new Date(),
          status: 'RUNNING',
          pricePerHourCents: 150,
        },
      });
      fail('Should have thrown');
    } catch (err: any) {
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect(err.code).toBe('P2002');
    }
  });

  test('ENDED sessions are not constrained, multiple per workspace allowed', async () => {
    const ws = await createWorkspace();

    // Create and close 3 sessions
    for (let i = 0; i < 3; i++) {
      await prisma.usageSession.create({
        data: {
          userId: testUserId,
          workspaceId: ws.id,
          gpuType: 'RTX_5090',
          startTime: new Date(Date.now() - (i + 1) * 3600000),
          endTime: new Date(Date.now() - i * 3600000),
          totalSeconds: 3600,
          billedCents: 150,
          status: 'ENDED',
          pricePerHourCents: 150,
        },
      });
    }

    const sessions = await prisma.usageSession.findMany({
      where: { workspaceId: ws.id },
    });
    expect(sessions.length).toBe(3);
    expect(sessions.every(s => s.status === 'ENDED')).toBe(true);
  });

  test('ENDED sessions + one RUNNING session coexist', async () => {
    const ws = await createWorkspace();

    // Historical ended sessions
    for (let i = 0; i < 2; i++) {
      await prisma.usageSession.create({
        data: {
          userId: testUserId,
          workspaceId: ws.id,
          gpuType: 'RTX_5090',
          startTime: new Date(Date.now() - (i + 1) * 7200000),
          endTime: new Date(Date.now() - (i + 1) * 3600000),
          totalSeconds: 3600,
          billedCents: 150,
          status: 'ENDED',
          pricePerHourCents: 150,
        },
      });
    }

    // One active RUNNING session
    const running = await prisma.usageSession.create({
      data: {
        userId: testUserId,
        workspaceId: ws.id,
        gpuType: 'RTX_5090',
        startTime: new Date(),
        status: 'RUNNING',
        pricePerHourCents: 150,
      },
    });

    expect(running.status).toBe('RUNNING');

    const all = await prisma.usageSession.findMany({
      where: { workspaceId: ws.id },
    });
    expect(all.length).toBe(3); // 2 ENDED + 1 RUNNING
  });

  test('closing RUNNING session then opening new one succeeds', async () => {
    const ws = await createWorkspace();

    // Open session
    const session1 = await prisma.usageSession.create({
      data: {
        userId: testUserId,
        workspaceId: ws.id,
        gpuType: 'RTX_5090',
        startTime: new Date(Date.now() - 3600000),
        status: 'RUNNING',
        pricePerHourCents: 150,
      },
    });

    // Close it
    await prisma.usageSession.update({
      where: { id: session1.id },
      data: { status: 'ENDED', endTime: new Date(), totalSeconds: 3600, billedCents: 150 },
    });

    // Open new session, should succeed because previous is ENDED
    const session2 = await prisma.usageSession.create({
      data: {
        userId: testUserId,
        workspaceId: ws.id,
        gpuType: 'RTX_5090',
        startTime: new Date(),
        status: 'RUNNING',
        pricePerHourCents: 200,
      },
    });

    expect(session2.id).toBeDefined();
    expect(session2.id).not.toBe(session1.id);
  });

  test('concurrent race: two inserts for same workspace, exactly one wins', async () => {
    const ws = await createWorkspace();

    const results = await Promise.allSettled([
      prisma.usageSession.create({
        data: {
          userId: testUserId,
          workspaceId: ws.id,
          gpuType: 'RTX_5090',
          startTime: new Date(),
          status: 'RUNNING',
          pricePerHourCents: 150,
        },
      }),
      prisma.usageSession.create({
        data: {
          userId: testUserId,
          workspaceId: ws.id,
          gpuType: 'RTX_5090',
          startTime: new Date(),
          status: 'RUNNING',
          pricePerHourCents: 150,
        },
      }),
    ]);

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // Verify exactly 1 RUNNING session
    const running = await prisma.usageSession.count({
      where: { workspaceId: ws.id, status: 'RUNNING' },
    });
    expect(running).toBe(1);
  });

  test('application guard and DB constraint do not produce contradictory errors', async () => {
    const ws = await createWorkspace();

    // Simulate the application guard pattern from startUsageSession
    async function guardedCreate() {
      const existing = await prisma.usageSession.findFirst({
        where: { workspaceId: ws.id, status: 'RUNNING' },
      });
      if (existing) return { created: false, session: existing };

      try {
        const session = await prisma.usageSession.create({
          data: {
            userId: testUserId,
            workspaceId: ws.id,
            gpuType: 'RTX_5090',
            startTime: new Date(),
            status: 'RUNNING',
            pricePerHourCents: 150,
          },
        });
        return { created: true, session };
      } catch (err: any) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          // DB constraint caught what application guard missed (race)
          const existing = await prisma.usageSession.findFirst({
            where: { workspaceId: ws.id, status: 'RUNNING' },
          });
          return { created: false, session: existing };
        }
        throw err;
      }
    }

    // First call, should create
    const r1 = await guardedCreate();
    expect(r1.created).toBe(true);

    // Second call, should be blocked by app guard or DB
    const r2 = await guardedCreate();
    expect(r2.created).toBe(false);
    expect(r2.session?.id).toBe(r1.session?.id);

    // Verify: exactly 1 RUNNING
    const count = await prisma.usageSession.count({
      where: { workspaceId: ws.id, status: 'RUNNING' },
    });
    expect(count).toBe(1);
  });
});
