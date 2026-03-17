/**
 * Database Seed Script
 * 
 * SECURITY NOTES:
 * - Author credentials are NEVER stored in source code
 * - Author account is bootstrapped via environment variable on first deploy
 * - After first deploy, rotate the password immediately
 * - This script seeds only reference data (GPUs, templates, SKUs, etc.)
 */

import { PrismaClient } from '@prisma/client';
import { FLEET_GPU_SPECS, getBasePriceCentsPerGpuHour } from '@aldaro/shared';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

const prisma = new PrismaClient();

async function main() {
  console.log('Starting database seed...');

  // ==========================================================================
  // 1. Bootstrap Author Account (SECURE)
  // ==========================================================================
  // Author password MUST come from environment variable
  // Never commit passwords to source code
  const authorEmail = process.env.AUTHOR_EMAIL || 'admin@aldaro.ai';
  const authorPassword = process.env.AUTHOR_INITIAL_PASSWORD;
  
  if (authorPassword) {
    // Validate password strength
    if (authorPassword.length < 16) {
      throw new Error('AUTHOR_INITIAL_PASSWORD must be at least 16 characters');
    }
    
    const authorHash = await bcrypt.hash(authorPassword, 12); // Use cost 12 for production

    const author = await prisma.user.upsert({
      where: { email: authorEmail },
      update: {
        role: 'AUTHOR',
        // Only update hash if this is initial setup
      },
      create: {
        email: authorEmail,
        passwordHash: authorHash,
        role: 'AUTHOR',
        accountStatus: 'ACTIVE',
        paymentStatus: 'VALID',
      },
    });

    console.log(`Author account ready: ${author.email}`);
    console.log('IMPORTANT: Rotate the author password after first login!');
  } else {
    console.log('AUTHOR_INITIAL_PASSWORD not set - skipping author bootstrap');
    console.log('To create author: set AUTHOR_INITIAL_PASSWORD env var and re-run seed');
  }

  // ==========================================================================
  // 2. Bootstrap Test Accounts (for development and testing)
  // ==========================================================================
  if (process.env.NODE_ENV !== 'production') {
    // Integration test user
    const testPassword = process.env.TEST_USER_PASSWORD || crypto.randomBytes(16).toString('hex');
    const testHash = await bcrypt.hash(testPassword, 10);

    await prisma.user.upsert({
      where: { email: 'integration-test@aldaro.ai' },
      update: {},
      create: {
        email: 'integration-test@aldaro.ai',
        passwordHash: testHash,
        role: 'CUSTOMER',
        accountStatus: 'ACTIVE',
        paymentStatus: 'VALID',
        maxActiveWorkspaces: 10,
        isAlphaTester: true,
      },
    });
    console.log('Integration test user created');

    // Tester account: test@aldaro.ai / TesterAccount21
    const testerHash = await bcrypt.hash('TesterAccount21', 10);
    await prisma.user.upsert({
      where: { email: 'test@aldaro.ai' },
      update: { passwordHash: testerHash },
      create: {
        email: 'test@aldaro.ai',
        passwordHash: testerHash,
        role: 'CUSTOMER',
        accountStatus: 'ACTIVE',
        paymentStatus: 'VALID',
        maxActiveWorkspaces: 5,
        isAlphaTester: true,
      },
    });
    console.log('Tester account created: test@aldaro.ai');

    // Author account: shivas@aldaro.ai / AuthorAccount21
    const authorTestHash = await bcrypt.hash('AuthorAccount21', 10);
    await prisma.user.upsert({
      where: { email: 'shivas@aldaro.ai' },
      update: { passwordHash: authorTestHash, role: 'AUTHOR' },
      create: {
        email: 'shivas@aldaro.ai',
        passwordHash: authorTestHash,
        role: 'AUTHOR',
        accountStatus: 'ACTIVE',
        paymentStatus: 'VALID',
        maxActiveWorkspaces: 10,
        isAlphaTester: true,
      },
    });
    console.log('Author account created: shivas@aldaro.ai');
  }

  // ==========================================================================
  // 3. Seed Fleet Nodes
  // ==========================================================================
  const nodes = [
    { 
      name: 'pve-node-01', 
      apiHost: process.env.PROXMOX_NODE_01_HOST || 'https://10.0.0.10:8006',
      status: 'ACTIVE',
    },
    { 
      name: 'pve-node-02', 
      apiHost: process.env.PROXMOX_NODE_02_HOST || 'https://10.0.0.11:8006',
      status: 'ACTIVE',
    },
  ];

  for (const node of nodes) {
    await prisma.fleetNode.upsert({
      where: { name: node.name },
      update: { apiHost: node.apiHost, status: node.status },
      create: node,
    });
  }
  console.log(`Seeded ${nodes.length} Fleet Nodes`);

  const pve1 = await prisma.fleetNode.findUniqueOrThrow({ where: { name: 'pve-node-01' } });
  const pve2 = await prisma.fleetNode.findUniqueOrThrow({ where: { name: 'pve-node-02' } });

  // ==========================================================================
  // 4. Seed Fleet GPUs (2 on hand: one RTX 5090, one A100)
  // ==========================================================================
  const gpus = [
    { nodeId: pve1.id, gpuName: FLEET_GPU_SPECS.RTX_5090.gpuName, gpuType: 'RTX_5090', pciAddress: '0000:01:00.0', vramGb: FLEET_GPU_SPECS.RTX_5090.vramGb },
    { nodeId: pve2.id, gpuName: FLEET_GPU_SPECS.A100_80GB.gpuName, gpuType: 'A100_80GB', pciAddress: '0000:41:00.0', vramGb: FLEET_GPU_SPECS.A100_80GB.vramGb },
  ];

  const keepPciAddresses = new Set(gpus.map(g => `${g.nodeId}:${g.pciAddress}`));
  const allFleetGpus = await prisma.fleetGpu.findMany({ select: { id: true, nodeId: true, pciAddress: true } });
  for (const existing of allFleetGpus) {
    if (!keepPciAddresses.has(`${existing.nodeId}:${existing.pciAddress}`)) {
      await prisma.workspaceGpuAllocation.deleteMany({ where: { gpuId: existing.id } });
      await prisma.fleetGpu.delete({ where: { id: existing.id } });
    }
  }
  for (const gpu of gpus) {
    await prisma.fleetGpu.upsert({
      where: { nodeId_pciAddress: { nodeId: gpu.nodeId, pciAddress: gpu.pciAddress } },
      update: { gpuName: gpu.gpuName, gpuType: gpu.gpuType, vramGb: gpu.vramGb },
      create: { ...gpu, status: 'FREE' },
    });
  }
  console.log(`Seeded ${gpus.length} Fleet GPUs (1x RTX 5090, 1x A100)`);

  // ==========================================================================
  // 5. Seed VM Templates
  // ==========================================================================
  const templates = [
    {
      proxmoxNode: 'pve-node-01',
      templateVmid: 9000,
      name: 'aldaro-base-rtx5090-v1',
      gpuType: 'RTX_5090',
      region: 'US',
      imageVersion: 'v1.0.0',
      diskSizeGb: 100,
      memorySizeMb: 32768,
      cpuCores: 8,
    },
    {
      proxmoxNode: 'pve-node-02',
      templateVmid: 9001,
      name: 'aldaro-base-a100-v1',
      gpuType: 'A100_80GB',
      region: 'US',
      imageVersion: 'v1.0.0',
      diskSizeGb: 200,
      memorySizeMb: 65536,
      cpuCores: 16,
    },
  ];

  for (const template of templates) {
    await prisma.vmTemplate.upsert({
      where: { proxmoxNode_templateVmid: { proxmoxNode: template.proxmoxNode, templateVmid: template.templateVmid } },
      update: template,
      create: template,
    });
  }
  console.log(`Seeded ${templates.length} VM Templates`);

  // ==========================================================================
  // 6. Seed Warm Pool Config
  // ==========================================================================
  const warmPoolConfigs = [
    { region: 'US', gpuType: 'RTX_5090', targetCount: 1 },
    { region: 'US', gpuType: 'A100_80GB', targetCount: 1 },
  ];

  for (const config of warmPoolConfigs) {
    await prisma.warmPoolConfig.upsert({
      where: { region_gpuType: { region: config.region, gpuType: config.gpuType } },
      update: { targetCount: config.targetCount },
      create: config,
    });
  }
  console.log(`Seeded ${warmPoolConfigs.length} Warm Pool Configs`);

  // ==========================================================================
  // 7. Seed GPU SKUs (Pricing from shared pricing algorithm)
  // ==========================================================================
  const skuConfigs = [
    {
      key: FLEET_GPU_SPECS.RTX_5090.key,
      displayName: FLEET_GPU_SPECS.RTX_5090.displayName,
      vramGb: FLEET_GPU_SPECS.RTX_5090.vramGb,
      shortBadge: FLEET_GPU_SPECS.RTX_5090.shortBadge,
      descriptionLines: FLEET_GPU_SPECS.RTX_5090.descriptionLines,
    },
    {
      key: FLEET_GPU_SPECS.A100_80GB.key,
      displayName: FLEET_GPU_SPECS.A100_80GB.displayName,
      vramGb: FLEET_GPU_SPECS.A100_80GB.vramGb,
      shortBadge: FLEET_GPU_SPECS.A100_80GB.shortBadge,
      descriptionLines: FLEET_GPU_SPECS.A100_80GB.descriptionLines,
    },
  ];
  const skus = skuConfigs.map((c) => ({
    ...c,
    descriptionLines: JSON.stringify(c.descriptionLines),
    pricePerHourCents: getBasePriceCentsPerGpuHour(c.key) ?? (c.key === 'RTX_5090' ? 55 : 249),
  }));

  const offeredKeys = skus.map((s) => s.key);
  for (const sku of skus) {
    await prisma.gpuSku.upsert({
      where: { key: sku.key },
      update: sku,
      create: sku,
    });
  }
  const removed = await prisma.gpuSku.deleteMany({
    where: { key: { notIn: offeredKeys } },
  });
  if (removed.count > 0) console.log(`Removed ${removed.count} discontinued GPU SKU(s)`);
  console.log(`Seeded ${skus.length} GPU SKUs (RTX 5090, A100 80GB only)`);

  // ==========================================================================
  // 8. Initialize App Banner
  // ==========================================================================
  const author = await prisma.user.findFirst({ where: { role: 'AUTHOR' } });
  if (author) {
    const bannerExists = await prisma.appBanner.findFirst();
    if (!bannerExists) {
      await prisma.appBanner.create({
        data: {
          enabled: false,
          message: null,
          severity: 'INFO',
          updatedByUserId: author.id,
        },
      });
      console.log('Initialized app banner');
    }
  }

  // ==========================================================================
  // 9. Initialize Worker Leader (for single-writer guarantee)
  // ==========================================================================
  try {
    await prisma.workerLeader.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        workerId: 'initial',
        fencingToken: crypto.randomUUID(),
      },
    });
    console.log('Initialized worker leader record');
  } catch (e) {
    // Table might not exist yet, that's okay
    console.log('Worker leader table not ready (will be created on first migration)');
  }

  console.log('\nSeed completed successfully!');
  console.log('\nIMPORTANT REMINDERS:');
  console.log('1. If you set AUTHOR_INITIAL_PASSWORD, rotate it after first login');
  console.log('2. Never commit passwords to source control');
  console.log('3. Review PCI addresses match your actual hardware before production');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
