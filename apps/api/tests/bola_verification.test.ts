import request from 'supertest';
import { app } from '../src/index';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

describe('3. Auth + Object-Level Authorization (BOLA)', () => {
  let userAToken: string;
  let userBToken: string;
  let projectAId: string;
  let runAId: string;
  const prisma = new PrismaClient();
  const secret = process.env.JWT_ACCESS_SECRET || 'supersecret';

  beforeAll(async () => {
    await app.ready();
    
    // Create User A and their project/run
    await prisma.user.upsert({
      where: { id: 'user-a' },
      update: {},
      create: { id: 'user-a', email: 'user-a@example.com', passwordHash: 'hash', role: 'CUSTOMER' }
    });
    userAToken = jwt.sign({ userId: 'user-a', email: 'user-a@example.com', role: 'CUSTOMER' }, secret);

    const projectA = await prisma.project.create({
      data: { userId: 'user-a', name: 'Project A', repoUrl: 'https://github.com/a/a' }
    });
    projectAId = projectA.id;

    const runA = await prisma.run.create({
      data: { userId: 'user-a', projectId: projectAId, gpuType: 'RTX_5090', command: 'test' }
    });
    runAId = runA.id;

    // Create User B
    await prisma.user.upsert({
      where: { id: 'user-b' },
      update: {},
      create: { id: 'user-b', email: 'user-b@example.com', passwordHash: 'hash', role: 'CUSTOMER' }
    });
    userBToken = jwt.sign({ userId: 'user-b', email: 'user-b@example.com', role: 'CUSTOMER' }, secret);
  });

  afterAll(async () => {
    await app.close();
  });

  it('3.1.2: User B should NOT be able to access User A project', async () => {
    const res = await request(app.server)
      .get(`/v1/projects/${projectAId}`)
      .set('Cookie', [`aldaro_session=${userBToken}`]);
    
    expect(res.status).toBe(404); // Ownership check failed
  });

  it('3.1.2: User B should NOT be able to access User A run', async () => {
    const res = await request(app.server)
      .get(`/v1/runs/${runAId}`)
      .set('Cookie', [`aldaro_session=${userBToken}`]);
    
    expect(res.status).toBe(404);
  });

  it('3.1.2: User B should NOT be able to cancel User A run', async () => {
    const res = await request(app.server)
      .post(`/v1/runs/${runAId}/cancel`)
      .set('Cookie', [`aldaro_session=${userBToken}`]);
    
    expect(res.status).toBe(404);
  });
});
