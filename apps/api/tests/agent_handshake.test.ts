import request from 'supertest';
import { app } from '../src/index';
import { PrismaClient } from '@prisma/client';

describe('V1 Agent API Handshake', () => {
  let runId: string;
  const prisma = new PrismaClient();

  beforeAll(async () => {
    await app.ready();
    
    const project = await prisma.project.create({
      data: {
        userId: 'test-user-id',
        name: 'Agent Test Project',
        repoUrl: 'https://github.com/aldaro/test-repo',
      }
    });
    
    const run = await prisma.run.create({
      data: {
        projectId: project.id,
        userId: 'test-user-id',
        status: 'provisioning',
        gpuType: 'RTX_5090',
        command: 'python train.py',
      }
    });
    runId = run.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('AGENT_HS_001: handshake success returns session id', async () => {
    const res = await request(app.server)
      .post('/v1/agent/handshake')
      .send({
        run_id: runId,
        agent_version: '0.1.0',
        capabilities: { repo_clone: true },
        system: { hostname: 'test-host' }
      });
    
    expect(res.status).toBe(200);
    expect(res.body.agent_session_id).toBeDefined();
    expect(res.body.ws_url).toContain(runId);
  });

  it('AGENT_HS_002: invalid run id returns 404', async () => {
    const res = await request(app.server)
      .post('/v1/agent/handshake')
      .send({
        run_id: 'non-existent-run',
        agent_version: '0.1.0',
      });
    
    expect(res.status).toBe(404);
  });
});
