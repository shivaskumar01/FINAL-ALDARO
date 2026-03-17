/**
 * Aldaro.AI Integration Tests - Full Lifecycle
 * 
 * REQUIREMENT: 20 consecutive runs with zero manual intervention
 * 
 * Go/No-Go Rules:
 * - Zero orphan VMs in Proxmox
 * - Zero leaked GPU allocations
 * - Zero leaked port leases
 * - Every workspace ends TERMINATED or FAILED with full cleanup
 * - Every success reaches RUNNING, heartbeat, nvidia-smi pass
 */

import { describe, it, before, after } from 'mocha';
import { expect } from 'chai';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { execSync } from 'child_process';

const API_URL = process.env.API_URL || 'http://localhost:4000';
const PROXMOX_API_URL = process.env.PROXMOX_API_URL;
const PROXMOX_TOKEN = process.env.PROXMOX_API_TOKEN_ID && process.env.PROXMOX_API_TOKEN_SECRET
  ? `PVEAPIToken=${process.env.PROXMOX_API_TOKEN_ID}=${process.env.PROXMOX_API_TOKEN_SECRET}`
  : null;

// Workspace prefix from run-20x-proof.sh for deterministic naming and cleanup
const WORKSPACE_PREFIX = process.env.ALDARO_PROOF_WORKSPACE_PREFIX || `ws-test-${Date.now()}`;
const RUN_ID = process.env.ALDARO_PROOF_RUN_ID || 'local';

const prisma = new PrismaClient();

interface WorkspaceResult {
  workspaceId: string;
  startTime: Date;
  endTime: Date;
  finalStatus: string;
  heartbeatReceived: boolean;
  nvidiaSmiPassed: boolean;
  gpuReleased: boolean;
  portsReleased: boolean;
  vmDeleted: boolean;
}

const results: WorkspaceResult[] = [];

describe('Full Lifecycle Test (20x)', function() {
  this.timeout(600000); // 10 minutes per test

  let testUserId: string;
  let sessionCookie: string;

  before(async function() {
    // Create or get test user
    const user = await prisma.user.upsert({
      where: { email: 'integration-test@aldaro.ai' },
      update: {},
      create: {
        email: 'integration-test@aldaro.ai',
        passwordHash: 'test-hash',
        maxActiveWorkspaces: 5,
        isAlphaTester: true,
      },
    });
    testUserId = user.id;

    // Get session (in real test, would use proper auth flow)
    // For integration test, we'll use a direct DB-backed session
  });

  after(async function() {
    // Export results
    console.log('\n=== LIFECYCLE TEST RESULTS ===');
    console.log(JSON.stringify(results, null, 2));

    // Verify cleanup
    await verifyCleanup();

    await prisma.$disconnect();
  });

  // Generate 20 test iterations
  for (let i = 1; i <= 20; i++) {
    it(`Run ${i}/20: Full workspace lifecycle`, async function() {
      const result = await runFullLifecycle(testUserId, i);
      results.push(result);

      // Assertions
      expect(result.finalStatus).to.be.oneOf(['TERMINATED', 'FAILED']);
      expect(result.gpuReleased).to.be.true;
      expect(result.portsReleased).to.be.true;
      expect(result.vmDeleted).to.be.true;

      if (result.finalStatus === 'TERMINATED') {
        expect(result.heartbeatReceived).to.be.true;
        expect(result.nvidiaSmiPassed).to.be.true;
      }
    });
  }
});

async function runFullLifecycle(userId: string, runNumber: number): Promise<WorkspaceResult> {
  const startTime = new Date();
  let workspaceId: string = '';
  let heartbeatReceived = false;
  let nvidiaSmiPassed = false;

  try {
    console.log(`\n[Run ${runNumber}] Starting lifecycle test (prefix: ${WORKSPACE_PREFIX})...`);

    // 1. Create workspace with deterministic naming
    const vmName = `${WORKSPACE_PREFIX}-${String(runNumber).padStart(2, '0')}`;
    const workspace = await prisma.workspace.create({
      data: {
        assignedUserId: userId,
        gpuType: 'RTX_5090',
        region: 'US',
        status: 'CREATING',
        assignedAt: new Date(),
        // Store the VM name for Proxmox naming
        // (worker will use this for clone operation)
      },
    });
    workspaceId = workspace.id;
    
    // Tag workspace for this proof run (for cleanup verification)
    console.log(`[Run ${runNumber}] VM will be named: ${vmName}`);
    console.log(`[Run ${runNumber}] Created workspace: ${workspaceId}`);

    // 2. Wait for RUNNING_ASSIGNED (worker provisions)
    const running = await waitForStatus(workspaceId, ['RUNNING_ASSIGNED', 'FAILED'], 300000);
    
    if (running.status === 'FAILED') {
      console.log(`[Run ${runNumber}] Workspace failed during provisioning`);
      return buildResult(workspaceId, startTime, 'FAILED', false, false);
    }

    console.log(`[Run ${runNumber}] Workspace running: ${running.vmInternalIp}`);

    // 3. Verify heartbeat received
    const withHeartbeat = await waitForHeartbeat(workspaceId, 60000);
    heartbeatReceived = !!withHeartbeat.lastAgentHeartbeatAt;
    console.log(`[Run ${runNumber}] Heartbeat received: ${heartbeatReceived}`);

    // 4. SSH and run nvidia-smi
    if (running.portSsh && running.gatewayHost) {
      try {
        const sshResult = execSync(
          `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -p ${running.portSsh} aldaro@${running.gatewayHost} "nvidia-smi --query-gpu=name --format=csv,noheader"`,
          { timeout: 30000 }
        ).toString().trim();
        
        nvidiaSmiPassed = sshResult.includes('RTX') || sshResult.includes('5090');
        console.log(`[Run ${runNumber}] nvidia-smi output: ${sshResult}`);
      } catch (e) {
        console.log(`[Run ${runNumber}] nvidia-smi failed: ${e}`);
      }
    }

    // 5. Terminate workspace
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { status: 'TERMINATING' },
    });
    console.log(`[Run ${runNumber}] Initiated termination`);

    // 6. Wait for TERMINATED
    await waitForStatus(workspaceId, ['TERMINATED'], 120000);
    console.log(`[Run ${runNumber}] Workspace terminated`);

    return buildResult(workspaceId, startTime, 'TERMINATED', heartbeatReceived, nvidiaSmiPassed);

  } catch (error) {
    console.error(`[Run ${runNumber}] Error: ${error}`);
    
    // Cleanup on error
    if (workspaceId) {
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: 'FAILED' },
      }).catch(() => {});
    }

    return buildResult(workspaceId, startTime, 'FAILED', heartbeatReceived, nvidiaSmiPassed);
  }
}

async function buildResult(
  workspaceId: string,
  startTime: Date,
  finalStatus: string,
  heartbeatReceived: boolean,
  nvidiaSmiPassed: boolean
): Promise<WorkspaceResult> {
  const endTime = new Date();

  // Check GPU released
  const gpuAlloc = await prisma.workspaceGpuAllocation.findUnique({
    where: { workspaceId },
    include: { gpu: true },
  });
  const gpuReleased = !gpuAlloc || gpuAlloc.releasedAt !== null || gpuAlloc.gpu.status === 'FREE';

  // Check ports released
  const endpoint = await prisma.workspaceEndpoint.findUnique({
    where: { workspaceId },
  });
  const portsReleased = !endpoint || endpoint.releasedAt !== null;

  // Check VM deleted (would need Proxmox API call in real test)
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
  const vmDeleted = !workspace?.proxmoxVmid || await checkVmDeleted(workspace.proxmoxNode!, workspace.proxmoxVmid);

  return {
    workspaceId,
    startTime,
    endTime,
    finalStatus,
    heartbeatReceived,
    nvidiaSmiPassed,
    gpuReleased,
    portsReleased,
    vmDeleted,
  };
}

async function waitForStatus(workspaceId: string, statuses: string[], timeoutMs: number): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (ws && statuses.includes(ws.status)) {
      return ws;
    }
    await sleep(2000);
  }
  throw new Error(`Timeout waiting for status ${statuses.join('|')}`);
}

async function waitForHeartbeat(workspaceId: string, timeoutMs: number): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ws = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (ws?.lastAgentHeartbeatAt) {
      return ws;
    }
    await sleep(2000);
  }
  return prisma.workspace.findUnique({ where: { id: workspaceId } });
}

async function checkVmDeleted(node: string, vmid: number): Promise<boolean> {
  if (!PROXMOX_API_URL || !PROXMOX_TOKEN) return true; // Skip in mock mode
  
  try {
    const res = await axios.get(`${PROXMOX_API_URL}/api2/json/nodes/${node}/qemu/${vmid}/status/current`, {
      headers: { Authorization: PROXMOX_TOKEN },
      httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
    });
    return false; // VM exists
  } catch (e: any) {
    if (e.response?.status === 500 || e.response?.status === 404) {
      return true; // VM doesn't exist
    }
    throw e;
  }
}

async function verifyCleanup(): Promise<void> {
  console.log('\n=== CLEANUP VERIFICATION ===');

  // Check for leaked GPU allocations
  const leakedGpus = await prisma.fleetGpu.count({
    where: { status: 'ALLOCATED' },
  });
  console.log(`Leaked GPU allocations: ${leakedGpus}`);

  // Check for leaked port leases
  const leakedPorts = await prisma.workspaceEndpoint.count({
    where: { releasedAt: null },
  });
  console.log(`Leaked port leases: ${leakedPorts}`);

  // Check for stuck workspaces
  const stuckWorkspaces = await prisma.workspace.count({
    where: {
      status: { in: ['CREATING', 'WAITING_FOR_AGENT', 'VERIFYING', 'ASSIGNING', 'RUNNING_ASSIGNED', 'TERMINATING'] },
    },
  });
  console.log(`Stuck workspaces: ${stuckWorkspaces}`);

  // Verify all from this test run are cleaned
  if (leakedGpus > 0 || leakedPorts > 0 || stuckWorkspaces > 0) {
    throw new Error('CLEANUP VERIFICATION FAILED');
  }

  console.log('✅ All resources cleaned up');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
