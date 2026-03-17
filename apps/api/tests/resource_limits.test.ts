import request from 'supertest';
import { app } from '../src/index';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

describe('4. Resource Limits + Abuse Guardrails', () => {
  let token: string;
  let projectId: string;
  const prisma = new PrismaClient();
  const secret = process.env.JWT_ACCESS_SECRET || 'supersecret';

  beforeAll(async () => {
    await app.ready();
    
    await prisma.user.upsert({
      where: { id: 'limit-user' },
      update: { maxConcurrentRuns: 2 },
      create: { id: 'limit-user', email: 'limit@example.com', passwordHash: 'hash', role: 'CUSTOMER', maxConcurrentRuns: 2 }
    });
    token = jwt.sign({ userId: 'limit-user', email: 'limit@example.com', role: 'CUSTOMER' }, secret);

    const project = await prisma.project.create({
      data: { userId: 'limit-user', name: 'Limit Project', repoUrl: 'https://github.com/l/l' }
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('4.1.2: Third run attempt should return 429', async () => {
    // Start 2 runs
    await request(app.server)
      .post(`/v1/projects/${projectId}/runs`)
      .set('Cookie', [`aldaro_session=${token}`])
      .send({ gpu_type: 'RTX_5090', command: 'run 1' });
    
    await request(app.server)
      .post(`/v1/projects/${projectId}/runs`)
      .set('Cookie', [`aldaro_session=${token}`])
      .send({ gpu_type: 'RTX_5090', command: 'run 2' });

    // Third run should fail
    const res = await request(app.server)
      .post(`/v1/projects/${projectId}/runs`)
      .set('Cookie', [`aldaro_session=${token}`])
      .send({ gpu_type: 'RTX_5090', command: 'run 3' });
    
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('Concurrency limit reached');
  });

  it('4.2.1: Run with > 24 hours should return 400', async () => {
    const res = await request(app.server)
      .post(`/v1/projects/${projectId}/runs`)
      .set('Cookie', [`aldaro_session=${token}`])
      .send({ gpu_type: 'RTX_5090', command: 'long run', hours_max: 25 });
    
    expect(res.status).toBe(400);
  });
});
