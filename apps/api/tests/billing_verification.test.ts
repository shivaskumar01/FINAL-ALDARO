import request from 'supertest';
import { app } from '../src/index';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

describe('5. Billing + Metering (Stripe)', () => {
  let token: string;
  let runId: string;
  const prisma = new PrismaClient();
  const secret = process.env.JWT_ACCESS_SECRET || 'supersecret';

  beforeAll(async () => {
    await app.ready();
    
    await prisma.user.upsert({
      where: { id: 'billing-user' },
      update: { stripeCustomerId: 'cus_test' },
      create: { id: 'billing-user', email: 'billing@example.com', passwordHash: 'hash', role: 'CUSTOMER', stripeCustomerId: 'cus_test' }
    });
    token = jwt.sign({ userId: 'billing-user', email: 'billing@example.com', role: 'CUSTOMER' }, secret);

    const project = await prisma.project.create({
      data: { userId: 'billing-user', name: 'Billing Project', repoUrl: 'https://github.com/b/b' }
    });

    const run = await prisma.run.create({
      data: { userId: 'billing-user', projectId: project.id, gpuType: 'RTX_5090', command: 'test', status: 'running', startedAt: new Date(Date.now() - 100000) } // 100s ago
    });
    runId = run.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('5.1.3: billedSeconds should be calculated on finalization', async () => {
    // Send STATUS=completed event
    const res = await request(app.server)
      .post(`/v1/runs/${runId}/events`)
      .send({
        type: 'STATUS',
        payload: { state: 'completed' }
      });
    
    expect(res.status).toBe(200);

    const run = await prisma.run.findUnique({ where: { id: runId } });
    expect(run?.billedSeconds).toBeGreaterThan(0);
    expect(run?.status).toBe('completed');
  });
});
