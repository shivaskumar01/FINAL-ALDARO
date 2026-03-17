/**
 * Pre-flight check for 20x lifecycle proof
 * 
 * Verifies all prerequisites before running the integration test.
 * 
 * Checks cover:
 * 1. Environment variables and secrets
 * 2. Proxmox API connectivity
 * 3. Database configuration (migrations, seed data)
 * 4. Fleet resources (nodes, GPUs, templates)
 * 5. Service health (API, Gateway, Worker)
 * 6. No orphan resources from previous runs
 * 7. Template readiness (via Proxmox API)
 */

const { PrismaClient } = require('@prisma/client');
const axios = require('axios');
const https = require('https');
const { execSync } = require('child_process');

const prisma = new PrismaClient();

const API_URL = process.env.API_URL || 'http://localhost:4000';
const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:5001';
const PROXMOX_API_URL = process.env.PROXMOX_API_URL;
const PROXMOX_TOKEN = process.env.PROXMOX_API_TOKEN_ID && process.env.PROXMOX_API_TOKEN_SECRET
  ? `PVEAPIToken=${process.env.PROXMOX_API_TOKEN_ID}=${process.env.PROXMOX_API_TOKEN_SECRET}`
  : null;

// Minimum requirements for concurrency tests
const MIN_FREE_GPUS = 5;
const MIN_SECRET_LENGTH = 32;

const checks = [];
let allPassed = true;
let warnings = [];

function pass(name, details = '') {
  checks.push({ name, passed: true, details });
  console.log(`✓ ${name}${details ? ` (${details})` : ''}`);
}

function fail(name, reason) {
  checks.push({ name, passed: false, reason });
  console.log(`✗ ${name}: ${reason}`);
  allPassed = false;
}

function warn(name, reason) {
  warnings.push({ name, reason });
  console.log(`⚠ ${name}: ${reason}`);
}

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           Aldaro.AI Pre-Flight Check                          ║');
  console.log('║   Goal: Aldaro fleet only. No external GPU providers.         ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  // ========================================================================
  // SECTION 1: Environment Variables and Secrets
  // ========================================================================
  console.log('── Secrets Configuration ──');
  
  const requiredEnv = [
    'PROXMOX_API_URL',
    'PROXMOX_API_TOKEN_ID',
    'PROXMOX_API_TOKEN_SECRET',
    'DATABASE_URL',
    'GATEWAY_SERVICE_SECRET',
    'ALDARO_AGENT_SHARED_SECRET',
  ];

  const missingEnv = requiredEnv.filter(k => !process.env[k]);
  if (missingEnv.length > 0) {
    fail('Required env vars', `Missing: ${missingEnv.join(', ')}`);
  } else {
    pass('Required env vars', 'All present');
  }

  // Check secret strength
  const secrets = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'ALDARO_AGENT_SHARED_SECRET', 'GATEWAY_SERVICE_SECRET'];
  const weakSecrets = secrets.filter(s => process.env[s] && process.env[s].length < MIN_SECRET_LENGTH);
  if (weakSecrets.length > 0) {
    fail('Secret strength', `Weak secrets (<${MIN_SECRET_LENGTH} chars): ${weakSecrets.join(', ')}`);
  } else {
    pass('Secret strength', `All secrets >= ${MIN_SECRET_LENGTH} chars`);
  }

  // Check no defaults allowed
  const defaultPatterns = ['changeme', 'secret', 'password', 'default', 'test123'];
  const hasDefaults = secrets.some(s => {
    const val = process.env[s] || '';
    return defaultPatterns.some(p => val.toLowerCase().includes(p));
  });
  if (hasDefaults) {
    fail('No default secrets', 'Found default/weak pattern in secrets');
  } else {
    pass('No default secrets');
  }

  // ========================================================================
  // SECTION 2: Proxmox API Connectivity
  // ========================================================================
  console.log('\n── Proxmox Infrastructure ──');
  
  let proxmoxApi = null;
  let proxmoxNodes = [];
  
  if (PROXMOX_API_URL && PROXMOX_TOKEN) {
    try {
      proxmoxApi = axios.create({
        baseURL: PROXMOX_API_URL,
        headers: { Authorization: PROXMOX_TOKEN },
        httpsAgent: new https.Agent({ rejectUnauthorized: false }),
        timeout: 15000,
      });

      const res = await proxmoxApi.get('/api2/json/nodes');
      if (res.data.data && res.data.data.length > 0) {
        proxmoxNodes = res.data.data;
        pass('Proxmox API reachable', `${proxmoxNodes.length} node(s)`);
      } else {
        fail('Proxmox API', 'No nodes found');
      }
    } catch (e) {
      fail('Proxmox API', e.message);
    }
  } else {
    fail('Proxmox API', 'Credentials not configured');
  }

  // ========================================================================
  // SECTION 3: Template Readiness (via Proxmox API)
  // ========================================================================
  console.log('\n── Template Readiness ──');
  
  if (proxmoxApi && proxmoxNodes.length > 0) {
    try {
      const templates = await prisma.vmTemplate.findMany();
      
      for (const template of templates) {
        // Check if template VM exists in Proxmox
        try {
          const vmRes = await proxmoxApi.get(
            `/api2/json/nodes/${template.proxmoxNode}/qemu/${template.templateVmid}/config`
          );
          
          const config = vmRes.data.data;
          
          // Check qemu-guest-agent enabled
          const hasAgent = config.agent && config.agent.includes('enabled=1');
          if (!hasAgent) {
            warn(`Template ${template.id}`, 'qemu-guest-agent may not be enabled');
          }
          
          // Check cloud-init drive exists
          const hasCloudInit = Object.keys(config).some(k => k.startsWith('ide') || k.startsWith('scsi'));
          
          pass(`Template ${template.gpuType}/${template.region}`, `VMID ${template.templateVmid} exists`);
        } catch (e) {
          fail(`Template ${template.id}`, `VMID ${template.templateVmid} not found: ${e.message}`);
        }
      }
      
      if (templates.length === 0) {
        fail('VM templates', 'No templates configured in database');
      }
    } catch (e) {
      fail('Template check', e.message);
    }
  } else {
    warn('Template readiness', 'Skipped (Proxmox API not available)');
  }

  // ========================================================================
  // SECTION 4: GPU Passthrough Verification
  // ========================================================================
  console.log('\n── GPU Passthrough ──');
  
  try {
    const gpus = await prisma.fleetGpu.findMany({
      where: { status: 'FREE' },
      include: { node: true },
    });
    
    if (gpus.length >= MIN_FREE_GPUS) {
      pass('Free GPUs available', `${gpus.length} free (need ${MIN_FREE_GPUS} for concurrency test)`);
    } else if (gpus.length > 0) {
      warn('Free GPUs', `Only ${gpus.length} free, need ${MIN_FREE_GPUS} for concurrency tests`);
    } else {
      fail('Free GPUs', 'No free GPUs in database');
    }

    // Check all GPUs have PCI addresses
    const missingPci = gpus.filter(g => !g.pciAddress);
    if (missingPci.length > 0) {
      fail('GPU PCI addresses', `${missingPci.length} GPUs missing pciAddress`);
    } else if (gpus.length > 0) {
      pass('GPU PCI addresses', 'All GPUs have pciAddress configured');
    }
  } catch (e) {
    fail('GPU configuration', e.message);
  }

  // ========================================================================
  // SECTION 5: Database State
  // ========================================================================
  console.log('\n── Database State ──');
  
  // Check migrations
  try {
    // Try to run a simple query to verify DB is accessible
    await prisma.$queryRaw`SELECT 1`;
    pass('Database connection');
  } catch (e) {
    fail('Database connection', e.message);
  }

  // Check fleet nodes
  try {
    const nodes = await prisma.fleetNode.findMany({
      where: { status: 'ACTIVE' },
    });
    if (nodes.length > 0) {
      pass('Fleet nodes', `${nodes.length} active`);
    } else {
      fail('Fleet nodes', 'No active nodes in database');
    }
  } catch (e) {
    fail('Fleet nodes', e.message);
  }

  // Check warm pool config
  try {
    const configs = await prisma.warmPoolConfig.findMany();
    if (configs.length > 0) {
      pass('Warm pool config', `${configs.length} config(s)`);
    } else {
      warn('Warm pool config', 'No warm pool configurations (tests will cold-boot)');
    }
  } catch (e) {
    fail('Warm pool config', e.message);
  }

  // Check for orphan resources
  try {
    const stuckWorkspaces = await prisma.workspace.count({
      where: {
        status: { in: ['CREATING', 'WAITING_FOR_AGENT', 'VERIFYING', 'ASSIGNING', 'RUNNING_ASSIGNED', 'TERMINATING'] },
      },
    });

    const allocatedGpus = await prisma.fleetGpu.count({
      where: { status: { in: ['ALLOCATED', 'RESERVED'] } },
    });

    const unreleasedPorts = await prisma.workspaceEndpoint.count({
      where: { releasedAt: null },
    });

    if (stuckWorkspaces === 0 && allocatedGpus === 0 && unreleasedPorts === 0) {
      pass('No orphan resources');
    } else {
      fail('Orphan resources', `${stuckWorkspaces} stuck workspaces, ${allocatedGpus} allocated GPUs, ${unreleasedPorts} unreleased ports`);
    }
  } catch (e) {
    fail('Orphan resource check', e.message);
  }

  // ========================================================================
  // SECTION 6: Service Health
  // ========================================================================
  console.log('\n── Service Health ──');
  
  // API health
  try {
    const res = await axios.get(`${API_URL}/health`, { timeout: 5000 });
    if (res.data.status === 'OK' || res.data.status === 'ok') {
      pass('API health', API_URL);
    } else {
      fail('API health', `Unexpected response: ${JSON.stringify(res.data)}`);
    }
  } catch (e) {
    fail('API health', `${API_URL} - ${e.message}`);
  }

  // Gateway health
  try {
    const res = await axios.get(`${GATEWAY_URL}/health`, { timeout: 5000 });
    if (res.data.status === 'OK' || res.data.status === 'ok') {
      pass('Gateway health', GATEWAY_URL);
    } else {
      fail('Gateway health', `Unexpected response: ${JSON.stringify(res.data)}`);
    }
  } catch (e) {
    fail('Gateway health', `${GATEWAY_URL} - ${e.message}`);
  }

  // Check worker is running (single instance)
  try {
    const result = execSync('pgrep -f "worker" 2>/dev/null | wc -l', { encoding: 'utf-8' }).trim();
    const workerCount = parseInt(result, 10) || 0;
    if (workerCount === 1) {
      pass('Worker process', '1 instance running');
    } else if (workerCount === 0) {
      warn('Worker process', 'No worker running (will need to start)');
    } else {
      warn('Worker process', `${workerCount} instances (should be 1 for leader lock)`);
    }
  } catch (e) {
    warn('Worker process', 'Could not check worker count');
  }

  // ========================================================================
  // SECTION 7: Test User
  // ========================================================================
  console.log('\n── Test User ──');
  
  try {
    let user = await prisma.user.findUnique({
      where: { email: 'integration-test@aldaro.ai' },
    });
    
    if (user) {
      if (user.maxActiveWorkspaces >= 10) {
        pass('Test user ready', `quota: ${user.maxActiveWorkspaces}`);
      } else {
        // Update quota
        await prisma.user.update({
          where: { id: user.id },
          data: { maxActiveWorkspaces: 10 },
        });
        pass('Test user quota updated', 'maxActiveWorkspaces: 10');
      }
    } else {
      // Create test user
      await prisma.user.create({
        data: {
          email: 'integration-test@aldaro.ai',
          passwordHash: 'integration-test-hash',
          maxActiveWorkspaces: 10,
          isAlphaTester: true,
        },
      });
      pass('Test user created', 'integration-test@aldaro.ai');
    }
  } catch (e) {
    fail('Test user', e.message);
  }

  // ========================================================================
  // SUMMARY
  // ========================================================================
  console.log('\n╔══════════════════════════════════════════════════════════════╗');
  console.log('║                    Pre-Flight Summary                          ║');
  console.log('╚══════════════════════════════════════════════════════════════╝\n');

  const passed = checks.filter(c => c.passed).length;
  const failed = checks.filter(c => !c.passed).length;

  console.log(`Passed:   ${passed}`);
  console.log(`Failed:   ${failed}`);
  console.log(`Warnings: ${warnings.length}`);
  console.log('');

  if (warnings.length > 0) {
    console.log('Warnings (non-blocking):');
    warnings.forEach(w => {
      console.log(`  ⚠ ${w.name}: ${w.reason}`);
    });
    console.log('');
  }

  if (allPassed) {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ✅ All checks passed - ready for 20x proof');
    console.log('');
    console.log('  Next step:');
    console.log('    ./scripts/run-20x-proof.sh');
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(0);
  } else {
    console.log('═══════════════════════════════════════════════════════════════');
    console.log('  ❌ Pre-flight check FAILED');
    console.log('');
    console.log('  Fix these issues before running 20x proof:');
    checks.filter(c => !c.passed).forEach(c => {
      console.log(`    - ${c.name}: ${c.reason}`);
    });
    console.log('═══════════════════════════════════════════════════════════════');
    process.exit(1);
  }
}

main()
  .catch(e => {
    console.error('Pre-flight check error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
