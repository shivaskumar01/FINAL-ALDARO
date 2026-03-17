import { PrismaClient } from '@prisma/client';
import { runOrphanKiller } from '../src/worker';
import { provisioner } from '../src/providers/provisioner';

describe('6. Provisioner Worker Hardening', () => {
  const prisma = new PrismaClient();
  let userId = 'worker-user';
  let projectId = 'worker-project';

  beforeAll(async () => {
    await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId, email: 'worker@example.com', passwordHash: 'hash', role: 'CUSTOMER' }
    });
    await prisma.project.upsert({
      where: { id: projectId },
      update: {},
      create: { id: projectId, userId, name: 'Worker Project', repoUrl: 'https://github.com/w/w' }
    });
  });

  it('6.1: Orphan killer should deprovision active infra for terminal runs', async () => {
    const run = await prisma.run.create({
      data: {
        userId,
        projectId,
        gpuType: 'RTX_5090',
        command: 'test',
        status: 'completed',
        upstreamInstanceId: 'mock-orphan-1'
      }
    });

    await runOrphanKiller();

    const updatedRun = await prisma.run.findUnique({ where: { id: run.id } });
    expect(updatedRun?.upstreamInstanceId).toBeNull();
  });

  it('6.2: Stuck provisioning should fail after timeout', async () => {
    const run = await prisma.run.create({
      data: {
        userId,
        projectId,
        gpuType: 'RTX_5090',
        command: 'test',
        status: 'provisioning',
        upstreamInstanceId: 'mock-stuck-1',
        updatedAt: new Date(Date.now() - 15 * 60 * 1000) // 15 mins ago
      }
    });

    await runOrphanKiller();

    const updatedRun = await prisma.run.findUnique({ where: { id: run.id } });
    expect(updatedRun?.status).toBe('failed');
    expect(updatedRun?.errorMessage).toBe('Provisioning timed out');
  });
});
