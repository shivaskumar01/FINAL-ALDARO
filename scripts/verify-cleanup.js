/**
 * Verify no leaked resources after integration tests
 * 
 * Checks:
 * - Zero orphan VMs in Proxmox (by workspace prefix)
 * - Zero leaked GPU allocations (RESERVED/ALLOCATED with no RUNNING workspace)
 * - Zero leaked port leases (ACTIVE with TERMINATED/FAILED workspace)
 * - Zero stuck usage sessions (RUNNING with TERMINATED workspace)
 * - Zero stuck workspaces
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const https = require('https');

const prisma = new PrismaClient();

const PROXMOX_API_URL = process.env.PROXMOX_API_URL;
const PROXMOX_TOKEN = process.env.PROXMOX_API_TOKEN_ID && process.env.PROXMOX_API_TOKEN_SECRET
  ? `PVEAPIToken=${process.env.PROXMOX_API_TOKEN_ID}=${process.env.PROXMOX_API_TOKEN_SECRET}`
  : null;

// Get workspace prefix from environment (set by run-20x-proof.sh)
const WORKSPACE_PREFIX = process.env.ALDARO_PROOF_WORKSPACE_PREFIX || 'aldaro-';

async function main() {
  const results = {
    passed: true,
    run_id: process.env.ALDARO_PROOF_RUN_ID || 'unknown',
    workspace_prefix: WORKSPACE_PREFIX,
    checks: [],
  };

  console.log(`Verifying cleanup for prefix: ${WORKSPACE_PREFIX}`);
  console.log('');

  // -------------------------------------------------------------------------
  // 1. Check for orphan VMs in Proxmox by prefix
  // -------------------------------------------------------------------------
  if (PROXMOX_API_URL && PROXMOX_TOKEN) {
    try {
      const api = axios.create({
        baseURL: PROXMOX_API_URL,
        headers: { Authorization: PROXMOX_TOKEN },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      });

      const nodesRes = await api.get('/api2/json/nodes');
      let orphanVms = [];

      for (const node of nodesRes.data.data) {
        const vmsRes = await api.get(`/api2/json/nodes/${node.node}/qemu`);
        
        // Find VMs matching the proof run prefix
        const matchingVms = vmsRes.data.data.filter(vm => 
          vm.name && vm.name.startsWith(WORKSPACE_PREFIX)
        );

        for (const vm of matchingVms) {
          // Check if this VM has a corresponding active workspace
          const workspace = await prisma.workspace.findFirst({
            where: {
              proxmoxNode: node.node,
              proxmoxVmid: vm.vmid,
              status: { notIn: ['TERMINATED', 'FAILED'] },
            },
          });

          // If no active workspace, it's an orphan
          if (!workspace) {
            orphanVms.push({
              node: node.node,
              vmid: vm.vmid,
              name: vm.name,
              status: vm.status,
            });
          }
        }
      }

      if (orphanVms.length === 0) {
        results.checks.push({
          name: 'Orphan VMs in Proxmox (by prefix)',
          value: 0,
          expected: 0,
          passed: true,
        });
        console.log(`✓ No orphan VMs with prefix "${WORKSPACE_PREFIX}"`);
      } else {
        results.checks.push({
          name: 'Orphan VMs in Proxmox (by prefix)',
          value: orphanVms.length,
          expected: 0,
          passed: false,
          orphans: orphanVms,
        });
        console.log(`✗ Found ${orphanVms.length} orphan VMs:`);
        orphanVms.forEach(vm => {
          console.log(`    - ${vm.node}/${vm.vmid} (${vm.name}) - ${vm.status}`);
        });
        results.passed = false;
      }
    } catch (e) {
      results.checks.push({
        name: 'Orphan VMs in Proxmox',
        value: 'ERROR',
        passed: false,
        error: e.message,
      });
      console.log(`✗ Proxmox check failed: ${e.message}`);
      results.passed = false;
    }
  } else {
    results.checks.push({
      name: 'Orphan VMs in Proxmox',
      value: 'SKIP',
      passed: true,
      note: 'Proxmox credentials not configured',
    });
    console.log('⚠ Skipping Proxmox check (credentials not configured)');
  }

  // -------------------------------------------------------------------------
  // 2. Check for leaked GPU allocations
  //    GPU in RESERVED or ALLOCATED with no RUNNING workspace
  // -------------------------------------------------------------------------
  const leakedGpuAllocations = await prisma.fleetGpu.findMany({
    where: {
      status: { in: ['ALLOCATED', 'RESERVED'] },
    },
    include: {
      allocation: {
        include: {
          workspace: true,
        },
      },
    },
  });

  const orphanGpus = leakedGpuAllocations.filter(gpu => {
    if (!gpu.allocation) return true; // Allocated but no allocation record
    const ws = gpu.allocation.workspace;
    if (!ws) return true; // Allocation but no workspace
    // Workspace exists but not in running state
    return !['RUNNING_ASSIGNED', 'ASSIGNING', 'CREATING', 'WAITING_FOR_AGENT', 'VERIFYING', 'WARM_AVAILABLE'].includes(ws.status);
  });

  if (orphanGpus.length === 0) {
    results.checks.push({
      name: 'Leaked GPU allocations',
      value: 0,
      expected: 0,
      passed: true,
    });
    console.log('✓ No leaked GPU allocations');
  } else {
    results.checks.push({
      name: 'Leaked GPU allocations',
      value: orphanGpus.length,
      expected: 0,
      passed: false,
      gpus: orphanGpus.map(g => ({
        id: g.id,
        status: g.status,
        workspaceId: g.allocation?.workspaceId,
        workspaceStatus: g.allocation?.workspace?.status,
      })),
    });
    console.log(`✗ Found ${orphanGpus.length} leaked GPU allocations`);
    results.passed = false;
  }

  // -------------------------------------------------------------------------
  // 3. Check for leaked port leases
  //    Port lease not released where workspace is TERMINATED or FAILED
  // -------------------------------------------------------------------------
  const leakedPorts = await prisma.workspaceEndpoint.findMany({
    where: {
      releasedAt: null,
      workspace: {
        status: { in: ['TERMINATED', 'FAILED'] },
      },
    },
    include: {
      workspace: {
        select: { id: true, status: true },
      },
    },
  });

  if (leakedPorts.length === 0) {
    results.checks.push({
      name: 'Leaked port leases',
      value: 0,
      expected: 0,
      passed: true,
    });
    console.log('✓ No leaked port leases');
  } else {
    results.checks.push({
      name: 'Leaked port leases',
      value: leakedPorts.length,
      expected: 0,
      passed: false,
      leases: leakedPorts.map(p => ({
        id: p.id,
        workspaceId: p.workspaceId,
        workspaceStatus: p.workspace.status,
        sshPort: p.sshPort,
        jupyterPort: p.jupyterPort,
        vscodePort: p.vscodePort,
      })),
    });
    console.log(`✗ Found ${leakedPorts.length} leaked port leases`);
    results.passed = false;
  }

  // -------------------------------------------------------------------------
  // 4. Check for stuck usage sessions
  //    Session in RUNNING where workspace is TERMINATED
  // -------------------------------------------------------------------------
  const stuckSessions = await prisma.usageSession.findMany({
    where: {
      status: 'RUNNING',
      workspace: {
        status: { in: ['TERMINATED', 'FAILED'] },
      },
    },
    include: {
      workspace: {
        select: { id: true, status: true },
      },
    },
  });

  if (stuckSessions.length === 0) {
    results.checks.push({
      name: 'Stuck usage sessions',
      value: 0,
      expected: 0,
      passed: true,
    });
    console.log('✓ No stuck usage sessions');
  } else {
    results.checks.push({
      name: 'Stuck usage sessions',
      value: stuckSessions.length,
      expected: 0,
      passed: false,
      sessions: stuckSessions.map(s => ({
        id: s.id,
        workspaceId: s.workspaceId,
        workspaceStatus: s.workspace.status,
        startTime: s.startTime,
      })),
    });
    console.log(`✗ Found ${stuckSessions.length} stuck usage sessions`);
    results.passed = false;
  }

  // -------------------------------------------------------------------------
  // 5. Check for stuck workspaces (older than 30 min in transient state)
  // -------------------------------------------------------------------------
  const stuckStatuses = ['CREATING', 'WAITING_FOR_AGENT', 'VERIFYING', 'ASSIGNING', 'TERMINATING'];
  const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000);
  
  const stuckWorkspaces = await prisma.workspace.findMany({
    where: {
      status: { in: stuckStatuses },
      createdAt: { lt: stuckCutoff },
    },
    select: {
      id: true,
      status: true,
      createdAt: true,
      proxmoxNode: true,
      proxmoxVmid: true,
    },
  });

  if (stuckWorkspaces.length === 0) {
    results.checks.push({
      name: 'Stuck workspaces (>30min)',
      value: 0,
      expected: 0,
      passed: true,
    });
    console.log('✓ No stuck workspaces');
  } else {
    results.checks.push({
      name: 'Stuck workspaces (>30min)',
      value: stuckWorkspaces.length,
      expected: 0,
      passed: false,
      workspaces: stuckWorkspaces,
    });
    console.log(`✗ Found ${stuckWorkspaces.length} stuck workspaces`);
    results.passed = false;
  }

  // -------------------------------------------------------------------------
  // 6. Check workspaces with this run's prefix all ended properly
  // -------------------------------------------------------------------------
  if (WORKSPACE_PREFIX && WORKSPACE_PREFIX !== 'aldaro-') {
    const runWorkspaces = await prisma.workspace.findMany({
      where: {
        // Match by proxmox VM name pattern (would need to store this)
        // For now, check all recent workspaces
        createdAt: { gte: new Date(Date.now() - 4 * 60 * 60 * 1000) }, // Last 4 hours
      },
      select: {
        id: true,
        status: true,
        proxmoxNode: true,
        proxmoxVmid: true,
        createdAt: true,
        terminatedAt: true,
      },
    });

    const notEnded = runWorkspaces.filter(w => 
      !['TERMINATED', 'FAILED'].includes(w.status)
    );

    if (notEnded.length === 0) {
      results.checks.push({
        name: 'All run workspaces ended',
        value: runWorkspaces.length,
        expected: runWorkspaces.length,
        passed: true,
      });
      console.log(`✓ All ${runWorkspaces.length} workspaces ended properly`);
    } else {
      results.checks.push({
        name: 'All run workspaces ended',
        value: `${runWorkspaces.length - notEnded.length}/${runWorkspaces.length}`,
        passed: false,
        notEnded: notEnded,
      });
      console.log(`✗ ${notEnded.length} workspaces did not end properly`);
      results.passed = false;
    }
  }

  // -------------------------------------------------------------------------
  // Output results
  // -------------------------------------------------------------------------
  console.log('');
  console.log('='.repeat(50));
  console.log('CLEANUP VERIFICATION SUMMARY');
  console.log('='.repeat(50));
  console.log('');

  const passed = results.checks.filter(c => c.passed).length;
  const failed = results.checks.filter(c => !c.passed).length;

  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log('');

  // Output JSON for export
  console.log(JSON.stringify(results, null, 2));

  if (!results.passed) {
    console.error('\n❌ CLEANUP VERIFICATION FAILED - DO NOT SUBMIT');
    process.exit(1);
  } else {
    console.log('\n✅ All cleanup checks passed - ready for submission');
    process.exit(0);
  }
}

main()
  .catch(e => {
    console.error('Cleanup verification error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
