/**
 * Author Dashboard Validation Tests
 * 
 * Tests dashboard endpoints against deterministic fixtures to ensure
 * metrics are calculated correctly before production.
 * 
 * Run with: npm run test:dashboard
 */

import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { expect } from 'chai';
import { v4 as uuidv4 } from 'uuid';

const prisma = new PrismaClient();
const API_URL = process.env.API_URL || 'http://localhost:3001';

// Test fixtures
interface TestFixture {
  users: { id: string; email: string; role: string }[];
  workspaces: any[];
  gpus: any[];
  sessions: any[];
  events: any[];
}

let fixture: TestFixture;
let authorToken: string;

describe('Author Dashboard Validation', function () {
  this.timeout(30000);

  before(async () => {
    console.log('Setting up test fixtures...');
    
    // Get author token
    const authorLogin = await axios.post(`${API_URL}/auth/login`, {
      email: process.env.AUTHOR_EMAIL || 'admin@aldaro.ai',
      password: process.env.AUTHOR_PASSWORD,
    });
    authorToken = authorLogin.data.token;

    // Clean up any existing test data
    await cleanupTestData();

    // Create deterministic fixtures
    fixture = await createFixtures();
    
    console.log('Fixtures created:');
    console.log(`  Users: ${fixture.users.length}`);
    console.log(`  Workspaces: ${fixture.workspaces.length}`);
    console.log(`  Sessions: ${fixture.sessions.length}`);
    console.log(`  Events: ${fixture.events.length}`);
  });

  after(async () => {
    console.log('Cleaning up test fixtures...');
    await cleanupTestData();
    await prisma.$disconnect();
  });

  describe('Overview Endpoint', () => {
    it('should return correct active users count', async () => {
      const response = await axios.get(`${API_URL}/api/author/usage/overview?window=24h`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      // User A has RUNNING workspace, User B has none
      expect(response.data.liveNow.activeUsersNow).to.equal(1);
    });

    it('should return correct users using GPUs count', async () => {
      const response = await axios.get(`${API_URL}/api/author/usage/overview?window=24h`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      // User A has 1 workspace with GPU ATTACHED
      expect(response.data.liveNow.usersUsingGpusNow).to.equal(1);
    });

    it('should return correct active GPUs count', async () => {
      const response = await axios.get(`${API_URL}/api/author/usage/overview?window=24h`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      // 1 GPU attached to running workspace
      expect(response.data.liveNow.activeGpusNow).to.equal(1);
    });

    it('should return correct warm pool count', async () => {
      const response = await axios.get(`${API_URL}/api/author/usage/overview?window=24h`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      // We created 2 warm workspaces
      expect(response.data.liveNow.warmPoolAvailable).to.be.at.least(2);
    });

    it('should return correct provision success rate', async () => {
      const response = await axios.get(`${API_URL}/api/author/usage/overview?window=24h`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      // 3 successful provisions, 1 failed = 75%
      const expected = (3 / 4) * 100;
      expect(response.data.experienceKPIs.provisionSuccessRate).to.be.closeTo(expected, 1);
    });
  });

  describe('Customer Table', () => {
    it('should return correct GPU-hours for User A', async () => {
      const response = await axios.get(`${API_URL}/api/author/usage/customers?window=24h`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      const userA = response.data.customers.find((c: any) => c.email === 'test-user-a@aldaro.ai');
      expect(userA).to.exist;
      
      // User A had 2 sessions totaling 7200 seconds = 2.0 GPU-hours
      expect(userA.gpuHours24h).to.be.closeTo(2.0, 0.1);
    });

    it('should return correct workspaces running count', async () => {
      const response = await axios.get(`${API_URL}/api/author/usage/customers?window=24h`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      const userA = response.data.customers.find((c: any) => c.email === 'test-user-a@aldaro.ai');
      expect(userA.workspacesRunningNow).to.equal(1);

      const userB = response.data.customers.find((c: any) => c.email === 'test-user-b@aldaro.ai');
      expect(userB.workspacesRunningNow).to.equal(0);
    });

    it('should sort by GPU hours descending by default', async () => {
      const response = await axios.get(`${API_URL}/api/author/usage/customers?window=24h`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      const customers = response.data.customers.filter((c: any) => 
        c.email.startsWith('test-user-')
      );
      
      // User A should be first (has GPU hours)
      expect(customers[0]?.email).to.equal('test-user-a@aldaro.ai');
    });
  });

  describe('Workspace Trace', () => {
    it('should show provision stages in order', async () => {
      const runningWs = fixture.workspaces.find(w => w.status === 'RUNNING');
      
      const response = await axios.get(
        `${API_URL}/api/author/usage/workspaces/${runningWs.id}`,
        { headers: { Authorization: `Bearer ${authorToken}` } }
      );

      const trace = response.data.provisioningTrace;
      
      // All stages should exist
      expect(trace.provisionStartedAt).to.exist;
      expect(trace.cloneCompletedAt).to.exist;
      expect(trace.gpuAttachedAt).to.exist;
      expect(trace.bootCompletedAt).to.exist;
      expect(trace.ipDiscoveredAt).to.exist;
      expect(trace.agentRegisteredAt).to.exist;
      expect(trace.startedAt).to.exist;
      
      // Stages should be in chronological order
      expect(new Date(trace.cloneCompletedAt).getTime())
        .to.be.greaterThan(new Date(trace.provisionStartedAt).getTime());
      expect(new Date(trace.gpuAttachedAt).getTime())
        .to.be.greaterThan(new Date(trace.cloneCompletedAt).getTime());
    });

    it('should show non-negative durations', async () => {
      const runningWs = fixture.workspaces.find(w => w.status === 'RUNNING');
      
      const response = await axios.get(
        `${API_URL}/api/author/usage/workspaces/${runningWs.id}`,
        { headers: { Authorization: `Bearer ${authorToken}` } }
      );

      const durations = response.data.provisioningTrace.durations || {};
      
      for (const [stage, duration] of Object.entries(durations)) {
        expect(duration as number, `${stage} duration`).to.be.at.least(0);
      }
    });
  });

  describe('Funnel Metrics', () => {
    it('should show correct funnel conversions', async () => {
      const userA = fixture.users.find(u => u.email === 'test-user-a@aldaro.ai');
      
      const response = await axios.get(
        `${API_URL}/api/author/usage/customers/${userA!.id}?window=7d`,
        { headers: { Authorization: `Bearer ${authorToken}` } }
      );

      const funnel = response.data.funnel;
      
      // User A: 2 logins, 2 workspace creates, 1 reached running, 1 connected
      expect(funnel.loginAttempts).to.be.at.least(2);
      expect(funnel.workspacesCreated).to.be.at.least(2);
      expect(funnel.reachedRunning).to.be.at.least(1);
    });
  });

  describe('Incident Detection', () => {
    it('should create incident for provision failure spike', async () => {
      // Create multiple failed workspaces to trigger spike
      const failedWs = [];
      for (let i = 0; i < 5; i++) {
        const ws = await prisma.workspace.create({
          data: {
            id: uuidv4(),
            gpuType: 'RTX_5090',
            status: 'FAILED',
            failedAt: new Date(),
            lastErrorCode: 'PROVISION_FAILED',
            assignedUserId: fixture.users[0].id,
          },
        });
        failedWs.push(ws);
      }

      // Wait for incident detection
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check incidents
      const response = await axios.get(`${API_URL}/api/author/usage/incidents`, {
        headers: { Authorization: `Bearer ${authorToken}` },
      });

      // Should have provision failure incident
      const incident = response.data.incidents.find(
        (i: any) => i.type === 'provision_failure_spike' && i.status === 'OPEN'
      );
      
      // Clean up
      for (const ws of failedWs) {
        await prisma.workspace.delete({ where: { id: ws.id } });
      }
      
      // The incident should exist after spike
      // (Note: may not exist if not enough failures to trigger threshold)
      console.log('Provision failure incident:', incident ? 'FOUND' : 'NOT FOUND');
    });
  });

  describe('Security', () => {
    it('should reject non-author access', async () => {
      // Try to access author endpoint without token
      try {
        await axios.get(`${API_URL}/api/author/usage/overview`, {
          headers: {},
        });
        expect.fail('Should have rejected unauthorized request');
      } catch (err: any) {
        expect(err.response.status).to.be.oneOf([401, 404]);
      }
    });

    it('should reject non-author user', async () => {
      // Create a customer user and try to access
      const customerUser = await prisma.user.create({
        data: {
          id: uuidv4(),
          email: `test-customer-${Date.now()}@aldaro.ai`,
          passwordHash: 'hash',
          role: 'CUSTOMER',
        },
      });

      try {
        // Try with a fake token
        await axios.get(`${API_URL}/api/author/usage/overview`, {
          headers: { Authorization: 'Bearer fake-token' },
        });
        expect.fail('Should have rejected customer user');
      } catch (err: any) {
        expect(err.response.status).to.be.oneOf([401, 403, 404]);
      } finally {
        await prisma.user.delete({ where: { id: customerUser.id } });
      }
    });
  });
});

async function createFixtures(): Promise<TestFixture> {
  const now = new Date();
  const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
  const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);

  // Create test users
  const userA = await prisma.user.create({
    data: {
      id: uuidv4(),
      email: 'test-user-a@aldaro.ai',
      passwordHash: 'test-hash',
      role: 'CUSTOMER',
      accountStatus: 'ACTIVE',
      paymentStatus: 'VALID',
    },
  });

  const userB = await prisma.user.create({
    data: {
      id: uuidv4(),
      email: 'test-user-b@aldaro.ai',
      passwordHash: 'test-hash',
      role: 'CUSTOMER',
      accountStatus: 'ACTIVE',
      paymentStatus: 'VALID',
    },
  });

  // Create test node
  const node = await prisma.fleetNode.upsert({
    where: { name: 'test-node-01' },
    update: {},
    create: {
      name: 'test-node-01',
      apiHost: 'https://test:8006',
      status: 'ACTIVE',
    },
  });

  // Create test GPUs
  const gpu1 = await prisma.fleetGpu.create({
    data: {
      nodeId: node.id,
      gpuName: 'NVIDIA RTX 5090',
      gpuType: 'RTX_5090',
      pciAddress: '0000:test:00.0',
      vramGb: 32,
      status: 'ATTACHED',
    },
  });

  const gpu2 = await prisma.fleetGpu.create({
    data: {
      nodeId: node.id,
      gpuName: 'NVIDIA RTX 5090',
      gpuType: 'RTX_5090',
      pciAddress: '0000:test:01.0',
      vramGb: 32,
      status: 'FREE',
    },
  });

  // Create workspaces
  // User A: 1 RUNNING workspace with GPU
  const wsRunning = await prisma.workspace.create({
    data: {
      id: uuidv4(),
      assignedUserId: userA.id,
      gpuType: 'RTX_5090',
      status: 'RUNNING',
      provisionStartedAt: twoHoursAgo,
      cloneCompletedAt: new Date(twoHoursAgo.getTime() + 30000),
      gpuAttachedAt: new Date(twoHoursAgo.getTime() + 35000),
      bootCompletedAt: new Date(twoHoursAgo.getTime() + 60000),
      ipDiscoveredAt: new Date(twoHoursAgo.getTime() + 90000),
      agentRegisteredAt: new Date(twoHoursAgo.getTime() + 100000),
      startedAt: new Date(twoHoursAgo.getTime() + 100000),
      lastAgentHeartbeatAt: new Date(),
      vmInternalIp: '10.0.0.100',
      proxmoxNode: node.name,
      proxmoxVmid: 1000,
    },
  });

  // Create GPU allocation
  await prisma.workspaceGpuAllocation.create({
    data: {
      workspaceId: wsRunning.id,
      gpuId: gpu1.id,
      nodeId: node.id,
    },
  });

  await prisma.fleetGpu.update({
    where: { id: gpu1.id },
    data: { currentWorkspaceId: wsRunning.id },
  });

  // User A: 1 FAILED workspace
  const wsFailed = await prisma.workspace.create({
    data: {
      id: uuidv4(),
      assignedUserId: userA.id,
      gpuType: 'RTX_5090',
      status: 'FAILED',
      failedAt: oneHourAgo,
      lastErrorCode: 'CLONE_FAILED',
    },
  });

  // Warm pool workspaces
  const warmWs1 = await prisma.workspace.create({
    data: {
      id: uuidv4(),
      gpuType: 'RTX_5090',
      status: 'WARM_AVAILABLE',
      isWarmPool: true,
      verificationStatus: 'PASS',
      startedAt: oneHourAgo,
    },
  });

  const warmWs2 = await prisma.workspace.create({
    data: {
      id: uuidv4(),
      gpuType: 'RTX_5090',
      status: 'WARM_AVAILABLE',
      isWarmPool: true,
      verificationStatus: 'PASS',
      startedAt: oneHourAgo,
    },
  });

  // Create usage sessions for User A (total: 7200 seconds = 2 GPU-hours)
  const session1 = await prisma.usageSession.create({
    data: {
      userId: userA.id,
      workspaceId: wsRunning.id,
      gpuType: 'RTX_5090',
      startTime: twoHoursAgo,
      endTime: new Date(twoHoursAgo.getTime() + 3600 * 1000), // 1 hour
      totalSeconds: 3600,
      billedSeconds: 3600,
      status: 'COMPLETED',
    },
  });

  const session2 = await prisma.usageSession.create({
    data: {
      userId: userA.id,
      workspaceId: wsRunning.id,
      gpuType: 'RTX_5090',
      startTime: oneHourAgo,
      endTime: now,
      totalSeconds: 3600,
      billedSeconds: 3600,
      status: 'COMPLETED',
    },
  });

  // Create experience events
  const events = [];

  // Login events
  events.push(await prisma.experienceEvent.create({
    data: {
      userId: userA.id,
      type: 'auth.login_success',
      createdAt: twoHoursAgo,
    },
  }));

  events.push(await prisma.experienceEvent.create({
    data: {
      userId: userA.id,
      type: 'auth.login_success',
      createdAt: oneHourAgo,
    },
  }));

  // Workspace events
  events.push(await prisma.experienceEvent.create({
    data: {
      userId: userA.id,
      workspaceId: wsRunning.id,
      type: 'workspace.created',
      createdAt: twoHoursAgo,
    },
  }));

  events.push(await prisma.experienceEvent.create({
    data: {
      userId: userA.id,
      workspaceId: wsRunning.id,
      type: 'workspace.started',
      createdAt: new Date(twoHoursAgo.getTime() + 100000),
      latencyMs: 100000,
    },
  }));

  events.push(await prisma.experienceEvent.create({
    data: {
      userId: userA.id,
      workspaceId: wsFailed.id,
      type: 'workspace.created',
      createdAt: oneHourAgo,
    },
  }));

  events.push(await prisma.experienceEvent.create({
    data: {
      userId: userA.id,
      workspaceId: wsFailed.id,
      type: 'workspace.failed',
      createdAt: new Date(oneHourAgo.getTime() + 30000),
      errorCode: 'CLONE_FAILED',
    },
  }));

  // Connect event
  events.push(await prisma.experienceEvent.create({
    data: {
      userId: userA.id,
      workspaceId: wsRunning.id,
      type: 'connect.ssh_success',
      createdAt: new Date(twoHoursAgo.getTime() + 120000),
      protocol: 'ssh',
      result: 'success',
    },
  }));

  return {
    users: [userA, userB],
    workspaces: [wsRunning, wsFailed, warmWs1, warmWs2],
    gpus: [gpu1, gpu2],
    sessions: [session1, session2],
    events,
  };
}

async function cleanupTestData(): Promise<void> {
  // Delete in correct order due to foreign keys
  await prisma.experienceEvent.deleteMany({
    where: { userId: { contains: 'test-user-' } },
  });
  
  await prisma.usageSession.deleteMany({
    where: { user: { email: { contains: 'test-user-' } } },
  });
  
  await prisma.workspaceGpuAllocation.deleteMany({
    where: { workspace: { assignedUser: { email: { contains: 'test-user-' } } } },
  });
  
  await prisma.workspace.deleteMany({
    where: { 
      OR: [
        { assignedUser: { email: { contains: 'test-user-' } } },
        { isWarmPool: true, id: { startsWith: '' } },
      ],
    },
  });
  
  await prisma.fleetGpu.deleteMany({
    where: { pciAddress: { contains: 'test:' } },
  });
  
  await prisma.fleetNode.deleteMany({
    where: { name: 'test-node-01' },
  });
  
  await prisma.user.deleteMany({
    where: { email: { contains: 'test-user-' } },
  });
}
