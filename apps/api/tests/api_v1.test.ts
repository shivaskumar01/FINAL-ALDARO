import request from 'supertest';
import { app } from '../src/index';
import jwt from 'jsonwebtoken';
import { PrismaClient } from '@prisma/client';

describe('V1 Projects and Runs API', () => {
  let projectId: string;
  let runId: string;
  let token: string;

  beforeAll(async () => {
    await app.ready();
    const prisma = new PrismaClient();
    
    // Ensure test user exists
    await prisma.user.upsert({
      where: { id: 'test-user-id' },
      update: {},
      create: {
        id: 'test-user-id',
        email: 'test@example.com',
        passwordHash: 'dummy-hash',
        role: 'CUSTOMER',
        paymentStatus: 'VALID', // Required for workspace launch, although we are testing v1 runs
      }
    });

    const secret = process.env.JWT_ACCESS_SECRET || 'supersecret';
    token = jwt.sign({ userId: 'test-user-id', email: 'test@example.com', role: 'CUSTOMER' }, secret);
  });

  afterAll(async () => {
    await app.close();
  });

  it('API_PROJ_001: should create a project', async () => {
    const res = await request(app.server)
      .post('/v1/projects')
      .set('Cookie', [`aldaro_session=${token}`])
      .send({
        name: 'Test Project',
        repo_url: 'https://github.com/aldaro/test-repo',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.name).toBe('Test Project');
    projectId = res.body.id;
  });

  it('API_PROJ_002: should list projects', async () => {
    const res = await request(app.server)
      .get('/v1/projects')
      .set('Cookie', [`aldaro_session=${token}`]);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('API_RUN_001: should create a run', async () => {
    const res = await request(app.server)
      .post(`/v1/projects/${projectId}/runs`)
      .set('Cookie', [`aldaro_session=${token}`])
      .send({
        gpu_type: 'RTX_5090',
        command: 'python train.py',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.status).toBe('provisioning');
    runId = res.body.id;
  });

  it('API_RUN_003: should get run details', async () => {
    const res = await request(app.server)
      .get(`/v1/runs/${runId}`)
      .set('Cookie', [`aldaro_session=${token}`]);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(runId);
  });

  it('API_RUN_004: should cancel a run', async () => {
    const res = await request(app.server)
      .post(`/v1/runs/${runId}/cancel`)
      .set('Cookie', [`aldaro_session=${token}`]);
    expect(res.status).toBe(202);
    expect(res.body.status).toBe('cancel_requested');
  });
});
