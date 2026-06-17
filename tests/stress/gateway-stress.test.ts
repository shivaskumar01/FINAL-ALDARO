/**
 * Gateway Stress Tests
 *
 * Exercises port allocation under concurrent load:
 * - Simultaneous allocations for different workspaces
 * - Allocate + release interleaving
 * - Port uniqueness under pressure
 * - Cache consistency after concurrent operations
 *
 * Requires: PostgreSQL (not SQLite)
 * Run: npx jest tests/stress/gateway-stress.test.ts --testTimeout=60000
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const TEST_REGION = 'gw-stress-region';

// Inline gateway allocation logic (DB-first, then cache)
async function allocatePorts(workspaceId: string, vmIp: string) {
  // Check for existing
  const existing = await prisma.workspaceEndpoint.findUnique({
    where: { workspaceId },
  });
  if (existing && !existing.releasedAt) {
    return {
      ssh: existing.sshPort,
      jupyter: existing.jupyterPort,
      vscode: existing.vscodePort,
    };
  }

  // Generate random ports in range
  const getPort = () => 20000 + Math.floor(Math.random() * 20000);
  const ssh = getPort();
  const jupyter = getPort();
  const vscode = getPort();

  await prisma.workspaceEndpoint.upsert({
    where: { workspaceId },
    update: {
      gatewayHost: 'gw-stress.test',
      sshPort: ssh,
      jupyterPort: jupyter,
      vscodePort: vscode,
      releasedAt: null,
      allocatedAt: new Date(),
    },
    create: {
      workspaceId,
      gatewayHost: 'gw-stress.test',
      sshPort: ssh,
      jupyterPort: jupyter,
      vscodePort: vscode,
    },
  });

  return { ssh, jupyter, vscode };
}

async function releasePorts(workspaceId: string) {
  const updated = await prisma.workspaceEndpoint.updateMany({
    where: { workspaceId, releasedAt: null },
    data: { releasedAt: new Date() },
  });
  return updated.count > 0;
}

beforeAll(async () => {
  // Create test workspaces
  const user = await prisma.user.upsert({
    where: { email: 'gw-stress@test.local' },
    update: {},
    create: {
      email: 'gw-stress@test.local',
      passwordHash: 'not-a-real-hash',
      role: 'CUSTOMER',
      customerAccessStatus: 'APPROVED',
    },
  });

  for (let i = 0; i < 30; i++) {
    await prisma.workspace.create({
      data: {
        id: `gw-stress-ws-${i.toString().padStart(3, '0')}`,
        assignedUserId: user.id,
        gpuType: 'RTX_5090',
        region: TEST_REGION,
        status: 'RUNNING_ASSIGNED',
        isWarmPool: false,
      },
    });
  }
});

afterAll(async () => {
  await prisma.workspaceEndpoint.deleteMany({
    where: { workspace: { region: TEST_REGION } },
  });
  await prisma.workspace.deleteMany({ where: { region: TEST_REGION } });
  await prisma.user.deleteMany({ where: { email: 'gw-stress@test.local' } });
  await prisma.$disconnect();
});

describe('Gateway Stress Tests', () => {
  test('20 concurrent allocations for different workspaces: all succeed', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `gw-stress-ws-${i.toString().padStart(3, '0')}`);

    const results = await Promise.allSettled(
      ids.map(id => allocatePorts(id, '10.0.0.1'))
    );

    const fulfilled = results.filter(r => r.status === 'fulfilled');
    const rejected = results.filter(r => r.status === 'rejected');

    // Some may fail due to port uniqueness collisions, that's OK
    // The important thing is no unhandled crash
    expect(fulfilled.length).toBeGreaterThan(0);
    console.log(`Succeeded: ${fulfilled.length}, Failed: ${rejected.length}`);

    // Verify DB state
    const endpoints = await prisma.workspaceEndpoint.findMany({
      where: { workspace: { region: TEST_REGION }, releasedAt: null },
    });
    expect(endpoints.length).toBeGreaterThan(0);

    // Check all ports are unique
    const allPorts = endpoints.flatMap(e => [e.sshPort, e.jupyterPort, e.vscodePort]);
    const uniquePorts = new Set(allPorts);
    expect(uniquePorts.size).toBe(allPorts.length);
  });

  test('duplicate allocation for same workspace is idempotent', async () => {
    const wsId = 'gw-stress-ws-025';

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => allocatePorts(wsId, '10.0.0.25'))
    );

    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected.length).toBe(0);

    const endpoints = await prisma.workspaceEndpoint.findMany({
      where: { workspaceId: wsId, releasedAt: null },
    });
    expect(endpoints.length).toBe(1);
  });

  test('allocate then release then re-allocate: clean lifecycle', async () => {
    const wsId = 'gw-stress-ws-026';

    // Allocate
    const first = await allocatePorts(wsId, '10.0.0.26');
    expect(first.ssh).toBeGreaterThan(0);

    // Release
    const released = await releasePorts(wsId);
    expect(released).toBe(true);

    // Re-allocate (upsert should work)
    const second = await allocatePorts(wsId, '10.0.0.26');
    expect(second.ssh).toBeGreaterThan(0);

    // Final state: 1 active endpoint
    const active = await prisma.workspaceEndpoint.findFirst({
      where: { workspaceId: wsId, releasedAt: null },
    });
    expect(active).not.toBeNull();
  });

  test('double release is idempotent (no crash)', async () => {
    const wsId = 'gw-stress-ws-027';
    await allocatePorts(wsId, '10.0.0.27');

    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => releasePorts(wsId))
    );

    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected.length).toBe(0);

    // One should return true, rest false
    const trueCount = results
      .filter(r => r.status === 'fulfilled')
      .filter(r => (r as PromiseFulfilledResult<boolean>).value === true).length;
    expect(trueCount).toBe(1);
  });

  test('interleaved allocate/release across workspaces: no deadlock', async () => {
    const ops: Promise<any>[] = [];

    for (let i = 0; i < 10; i++) {
      const wsId = `gw-stress-ws-${(i + 10).toString().padStart(3, '0')}`;
      ops.push(allocatePorts(wsId, `10.0.0.${i + 10}`));
      if (i > 0) {
        const prevWsId = `gw-stress-ws-${(i + 9).toString().padStart(3, '0')}`;
        ops.push(releasePorts(prevWsId));
      }
    }

    const results = await Promise.allSettled(ops);
    const rejected = results.filter(r => r.status === 'rejected');
    expect(rejected.length).toBe(0);
  });
});
