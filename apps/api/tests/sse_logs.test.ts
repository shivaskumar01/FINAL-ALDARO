import request from 'supertest';
import { app } from '../src/index';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

describe('V1 SSE Logs API', () => {
  let runId: string;
  let token: string;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await app.ready();
    const secret = process.env.JWT_ACCESS_SECRET || 'supersecret';
    token = jwt.sign({ userId: 'sse-user', email: 'sse@example.com', role: 'CUSTOMER' }, secret);
    
    await prisma.user.upsert({
      where: { id: 'sse-user' },
      update: {},
      create: { id: 'sse-user', email: 'sse@example.com', passwordHash: 'hash', role: 'CUSTOMER' }
    });

    const project = await prisma.project.create({
      data: {
        userId: 'sse-user',
        name: 'Log Test Project',
        repoUrl: 'https://github.com/aldaro/test-repo',
      }
    });
    
    const run = await prisma.run.create({
      data: {
        projectId: project.id,
        userId: 'sse-user',
        status: 'running',
        gpuType: 'RTX_5090',
        command: 'python train.py',
      }
    });
    runId = run.id;
    
    await prisma.runLog.createMany({
      data: [
        { runId: runId, stream: 'stdout', line: 'Starting...', seq: 1 },
        { runId: runId, stream: 'stdout', line: 'Processing...', seq: 2 },
      ]
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('SSE_001: should return text/event-stream content type', async () => {
    const res = await request(app.server)
      .get(`/v1/runs/${runId}/logs`)
      .set('Cookie', [`aldaro_session=${token}`]);
    
    expect(res.header['content-type']).toContain('text/event-stream');
  });

  it('SSE_002: should send existing log lines', async () => {
    const res = await request(app.server)
      .get(`/v1/runs/${runId}/logs`)
      .set('Cookie', [`aldaro_session=${token}`]);
    
    expect(res.text).toContain('data: {"id":');
    expect(res.text).toContain('Starting...');
    expect(res.text).toContain('Processing...');
  });

  it('SSE_003: since_seq should resume from correct point', async () => {
    const res = await request(app.server)
      .get(`/v1/runs/${runId}/logs?since_seq=1`)
      .set('Cookie', [`aldaro_session=${token}`]);
    
    expect(res.text).not.toContain('Starting...');
    expect(res.text).toContain('Processing...');
  });
});
