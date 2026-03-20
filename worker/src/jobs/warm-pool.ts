import { PrismaClient, Prisma } from '@prisma/client';
import { getProxmoxProvider, ProxmoxFleetProvider } from '../providers/proxmoxFleet';
import { v4 as uuidv4 } from 'uuid';
import crypto from 'crypto';
import axios from 'axios';

/**
 * Warm Pool Management
 * 
 * Maintains a pool of pre-provisioned workspaces on Aldaro-owned GPUs.
 * This enables fast workspace assignment (<60s) by avoiding cold boot times.
 * 
 * Uses ONLY Aldaro fleet (Proxmox). NO external GPU providers.
 * 
 * TELEMETRY: All provisioning stages write timestamps to workspace record
 * for author dashboard visibility.
 */

// Workspace prefix for this run (from environment or default)
const WORKSPACE_PREFIX = process.env.ALDARO_PROOF_WORKSPACE_PREFIX || 'aldaro';

/**
 * Sanitize error messages before storing in DB (visible to users via API).
 * Strips internal IPs, file paths, and Proxmox node names.
 */
function sanitizeErrorMessage(msg: string | undefined): string {
  if (!msg) return 'An internal error occurred';
  return msg
    .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]') // Strip IPs
    .replace(/\/[\w\/-]+\.(ts|js|json|log)/g, '[path]') // Strip file paths
    .replace(/node\d+/gi, '[node]') // Strip node names
    .slice(0, 500);
}

// VLAN range: 100–4094. Warm pool VMs get a shared management VLAN.
// User-assigned VMs get a per-org/per-user VLAN derived from their ID.
const WARM_POOL_VLAN = 100; // Isolated VLAN for unassigned warm pool VMs
const USER_VLAN_BASE = 200; // User VLANs start at 200, max 4094

// Clone concurrency semaphore: max simultaneous clones per Proxmox node
const MAX_CONCURRENT_CLONES = parseInt(process.env.MAX_CONCURRENT_CLONES || '3');

/**
 * Derive a deterministic VLAN tag from an org or user ID.
 * Maps UUID -> integer in range [USER_VLAN_BASE, 4094].
 */
function deriveVlanTag(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  const range = 4094 - USER_VLAN_BASE;
  return USER_VLAN_BASE + (Math.abs(hash) % range);
}

/**
 * Acquire a clone semaphore slot for a Proxmox node.
 * Returns true if acquired, false if at capacity.
 */
async function acquireCloneSemaphore(prisma: PrismaClient, node: string, workspaceId: string): Promise<boolean> {
  const active = await prisma.cloneSemaphore.count({
    where: { proxmoxNode: node, releasedAt: null },
  });
  if (active >= MAX_CONCURRENT_CLONES) {
    console.log(`[WarmPool] Clone semaphore full for ${node} (${active}/${MAX_CONCURRENT_CLONES})`);
    return false;
  }
  await prisma.cloneSemaphore.create({
    data: { proxmoxNode: node, workspaceId },
  });
  return true;
}

/**
 * Release a clone semaphore slot.
 */
async function releaseCloneSemaphore(prisma: PrismaClient, workspaceId: string): Promise<void> {
  await prisma.cloneSemaphore.updateMany({
    where: { workspaceId, releasedAt: null },
    data: { releasedAt: new Date() },
  });
}

export async function warmPoolTick(prisma: PrismaClient) {
  const configs = await prisma.warmPoolConfig.findMany();

  for (const cfg of configs) {
    const available = await prisma.workspace.count({
      where: {
        status: 'WARM_AVAILABLE',
        region: cfg.region,
        gpuType: cfg.gpuType,
        isWarmPool: true,
        assignedUserId: null,
        verificationStatus: 'PASS',
      },
    });

    // Scale up if below target
    if (available < cfg.targetCount) {
      const toSpawn = cfg.targetCount - available;
      console.log(`[WarmPool] Spawning ${toSpawn} warm workspaces for ${cfg.gpuType} in ${cfg.region}`);
      
      for (let i = 0; i < toSpawn; i++) {
        try {
          await spawnWarmWorkspace(prisma, cfg);
        } catch (err) {
          console.error(`[WarmPool] Failed to spawn warm workspace:`, err);
          // Continue trying to spawn others
        }
      }
    }

    // Scale down if above target + buffer
    if (available > cfg.targetCount + 1) {
      const extras = await prisma.workspace.findMany({
        where: {
          status: 'WARM_AVAILABLE',
          region: cfg.region,
          gpuType: cfg.gpuType,
          isWarmPool: true,
          assignedUserId: null,
        },
        orderBy: { verificationScore: 'asc' },
      });

      const killCount = available - (cfg.targetCount + 1);
      for (let i = 0; i < killCount && i < extras.length; i++) {
        console.log(`[WarmPool] Shrinking: terminating extra workspace ${extras[i].id}`);
        try {
          await terminateWorkspace(prisma, extras[i].id, 'warm_pool_shrink');
        } catch (err) {
          console.error(`[WarmPool] Failed to terminate workspace:`, err);
        }
      }
    }
  }

  // Process CREATING workspaces (cold launches)
  await processCreatingWorkspaces(prisma);

  // Process WAITING_FOR_AGENT workspaces (check for IP and agent)
  await processWaitingWorkspaces(prisma);
}

async function spawnWarmWorkspace(prisma: PrismaClient, cfg: { gpuType: string; region: string }) {
  const proxmox = getProxmoxProvider();
  const startTime = new Date();

  // 1. Find a free GPU on an active fleet node
  const gpu = await prisma.fleetGpu.findFirst({
    where: {
      status: 'FREE',
      OR: [
        { gpuType: cfg.gpuType },
        { gpuName: { contains: mapGpuType(cfg.gpuType) } },
      ],
      node: { status: 'ACTIVE' },
    },
    include: { node: true },
  });

  if (!gpu) {
    console.log(`[WarmPool] No free ${cfg.gpuType} GPU available in fleet`);
    return;
  }

  // 2. Find VM template
  const template = await prisma.vmTemplate.findFirst({
    where: { 
      proxmoxNode: gpu.node.name,
      gpuType: cfg.gpuType,
      enabled: true,
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!template) {
    // Fallback to any template on the node
    const anyTemplate = await prisma.vmTemplate.findFirst({
      where: { proxmoxNode: gpu.node.name, enabled: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!anyTemplate) {
      console.log(`[WarmPool] No VM template for node ${gpu.node.name}`);
      return;
    }
  }

  const vmTemplate = template || await prisma.vmTemplate.findFirst({
    where: { proxmoxNode: gpu.node.name, enabled: true },
    orderBy: { createdAt: 'desc' },
  });

  if (!vmTemplate) {
    console.log(`[WarmPool] No VM template found`);
    return;
  }

  // 3. Create workspace record
  const workspaceId = uuidv4();
  const newVmid = await getNextVmid(prisma, gpu.node.name);
  const vmName = `${WORKSPACE_PREFIX}-${workspaceId.slice(0, 8)}`;

  const workspace = await prisma.workspace.create({
    data: {
      id: workspaceId,
      gpuType: cfg.gpuType,
      region: cfg.region,
      status: 'CREATING',
      isWarmPool: true,
      proxmoxNode: gpu.node.name,
      proxmoxVmid: newVmid,
      // TELEMETRY: Record provision start time
      provisionStartedAt: startTime,
    },
  });

  console.log(`[WarmPool] Created workspace ${workspaceId} (vmid ${newVmid}, name ${vmName})`);

  // 4. Allocate GPU (atomic: both GPU status + allocation record)
  await prisma.$transaction([
    prisma.fleetGpu.update({
      where: { id: gpu.id },
      data: {
        status: 'ALLOCATED',
        currentWorkspaceId: workspaceId,
      },
    }),
    prisma.workspaceGpuAllocation.create({
      data: {
        workspaceId,
        gpuId: gpu.id,
        nodeId: gpu.nodeId,
      },
    }),
  ]);

  // 5. Acquire clone semaphore (prevents storage array DoS from concurrent clones)
  const acquired = await acquireCloneSemaphore(prisma, gpu.node.name, workspaceId);
  if (!acquired) {
    console.log(`[WarmPool] Deferring warm workspace ${workspaceId} — clone semaphore full on ${gpu.node.name}`);
    // Rollback GPU allocation and workspace — will retry next tick
    await prisma.fleetGpu.update({ where: { id: gpu.id }, data: { status: 'FREE', currentWorkspaceId: null } });
    await prisma.workspaceGpuAllocation.deleteMany({ where: { workspaceId } });
    await prisma.workspace.delete({ where: { id: workspaceId } });
    return;
  }

  // Clone VM
  try {
    console.log(`[WarmPool] Cloning template ${vmTemplate.templateVmid} -> ${newVmid} on ${gpu.node.name}`);
    const taskUpid = await proxmox.cloneVm(gpu.node.name, vmTemplate.templateVmid, {
      node: gpu.node.name,
      vmid: vmTemplate.templateVmid,
      newid: newVmid,
      name: vmName,
    });

    // Wait for clone to complete
    await proxmox.waitForTask(gpu.node.name, taskUpid, 180000);

    // Release clone semaphore immediately after clone (GPU attach + boot are fast)
    await releaseCloneSemaphore(prisma, workspaceId);

    // TELEMETRY: Clone complete
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { cloneCompletedAt: new Date() },
    });
    console.log(`[WarmPool] Clone completed for workspace ${workspaceId}`);

    // 6. Configure VM with GPU passthrough + VLAN isolation
    // Warm pool VMs get an isolated management VLAN — no tenant cross-talk
    console.log(`[WarmPool] Attaching GPU ${gpu.pciAddress} to workspace ${workspaceId}`);
    await proxmox.updateVmConfig(gpu.node.name, newVmid, {
      hostpci0: `${gpu.pciAddress},pcie=1`,
      net0: `virtio,bridge=vmbr0,tag=${WARM_POOL_VLAN}`,
    });
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { vlanTag: WARM_POOL_VLAN },
    });
    
    // TELEMETRY: GPU attached
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { gpuAttachedAt: new Date() },
    });
    console.log(`[WarmPool] GPU attached for workspace ${workspaceId}`);

    // 7. Attach persistent volume if workspace has one
    const attachedVolume = await prisma.persistentVolume.findFirst({
      where: { attachedToWorkspaceId: workspaceId },
    });
    if (attachedVolume) {
      const scsiDisk = `${attachedVolume.proxmoxStoragePool || 'local-lvm'}:${attachedVolume.proxmoxDiskId}`;
      await proxmox.updateVmConfig(gpu.node.name, newVmid, { scsi1: scsiDisk });
      console.log(`[WarmPool] Attached volume ${attachedVolume.id} to workspace ${workspaceId}`);
    }

    // 8. Set cloud-init (agent bootstrap)
    await proxmox.setCloudInit(gpu.node.name, newVmid, {
      ciuser: 'aldaro',
      ipconfig0: 'ip=dhcp',
    });

    // 9. Start VM
    console.log(`[WarmPool] Starting VM ${newVmid}`);
    await proxmox.startVm(gpu.node.name, newVmid);
    
    // TELEMETRY: Boot started
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { 
        bootCompletedAt: new Date(),
        status: 'WAITING_FOR_AGENT',
      },
    });

    console.log(`[WarmPool] Spawned workspace ${workspaceId} on ${gpu.node.name} (vmid ${newVmid})`);
  } catch (error: any) {
    console.error(`[WarmPool] Failed to provision workspace ${workspaceId}:`, error);

    // Release clone semaphore on failure
    await releaseCloneSemaphore(prisma, workspaceId);

    // TELEMETRY: Record error
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        lastErrorCode: error.code || 'PROVISION_ERROR',
        lastErrorMessage: sanitizeErrorMessage(error.message),
      },
    });

    // Rollback GPU
    await prisma.fleetGpu.update({
      where: { id: gpu.id },
      data: {
        status: 'FREE',
        currentWorkspaceId: null,
      },
    });

    await prisma.workspaceGpuAllocation.deleteMany({
      where: { workspaceId },
    });

    // Try to cleanup VM if it was created
    try {
      await proxmox.deleteVm(gpu.node.name, newVmid);
    } catch (cleanupErr) {
      console.error(`[WarmPool] Cleanup failed for VM ${newVmid}:`, cleanupErr);
    }
  }
}

async function processCreatingWorkspaces(prisma: PrismaClient) {
  // Handle any CREATING workspaces that need provisioning (user-assigned workspaces)
  const creating = await prisma.workspace.findMany({
    where: { 
      status: 'CREATING', 
      proxmoxVmid: null,
      assignedUserId: { not: null }, // Only user-assigned workspaces
    },
    include: { assignedUser: true },
    take: 5,
  });

  for (const ws of creating) {
    console.log(`[WarmPool] Cold workspace ${ws.id} for user ${ws.assignedUser?.email} needs provisioning`);
    
    // Trigger cold provisioning (similar to spawnWarmWorkspace but with user assignment)
    try {
      await provisionColdWorkspace(prisma, ws);
    } catch (err) {
      console.error(`[WarmPool] Cold provision failed for ${ws.id}:`, err);
    }
  }
}

async function provisionColdWorkspace(prisma: PrismaClient, ws: any) {
  const proxmox = getProxmoxProvider();
  const startTime = new Date();

  // Mark provision started
  await prisma.workspace.update({
    where: { id: ws.id },
    data: { provisionStartedAt: startTime },
  });

  // Find a free GPU
  const gpu = await prisma.fleetGpu.findFirst({
    where: {
      status: 'FREE',
      OR: [
        { gpuType: ws.gpuType },
        { gpuName: { contains: mapGpuType(ws.gpuType) } },
      ],
      node: { status: 'ACTIVE' },
    },
    include: { node: true },
  });

  if (!gpu) {
    await prisma.workspace.update({
      where: { id: ws.id },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        lastErrorCode: 'NO_GPU_AVAILABLE',
        lastErrorMessage: `No free ${ws.gpuType} GPU available`,
      },
    });
    return;
  }

  // Find template
  const template = await prisma.vmTemplate.findFirst({
    where: { 
      proxmoxNode: gpu.node.name,
      enabled: true,
    },
  });

  if (!template) {
    await prisma.workspace.update({
      where: { id: ws.id },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        lastErrorCode: 'NO_TEMPLATE',
        lastErrorMessage: `No VM template for node ${gpu.node.name}`,
      },
    });
    return;
  }

  const newVmid = await getNextVmid(prisma, gpu.node.name);
  const vmName = `${WORKSPACE_PREFIX}-${ws.id.slice(0, 8)}`;

  // Update workspace with VM details
  await prisma.workspace.update({
    where: { id: ws.id },
    data: {
      proxmoxNode: gpu.node.name,
      proxmoxVmid: newVmid,
    },
  });

  // Allocate GPU (atomic: both GPU status + allocation record)
  await prisma.$transaction([
    prisma.fleetGpu.update({
      where: { id: gpu.id },
      data: {
        status: 'ALLOCATED',
        currentWorkspaceId: ws.id,
      },
    }),
    prisma.workspaceGpuAllocation.create({
      data: {
        workspaceId: ws.id,
        gpuId: gpu.id,
        nodeId: gpu.nodeId,
      },
    }),
  ]);

  // Acquire clone semaphore
  const acquired = await acquireCloneSemaphore(prisma, gpu.node.name, ws.id);
  if (!acquired) {
    console.log(`[WarmPool] Deferring cold workspace ${ws.id} — clone semaphore full on ${gpu.node.name}`);
    // Rollback GPU — will retry next tick
    await prisma.fleetGpu.update({ where: { id: gpu.id }, data: { status: 'FREE', currentWorkspaceId: null } });
    await prisma.workspaceGpuAllocation.deleteMany({ where: { workspaceId: ws.id } });
    await prisma.workspace.update({ where: { id: ws.id }, data: { proxmoxNode: null, proxmoxVmid: null } });
    return;
  }

  // Derive VLAN tag for tenant isolation
  const vlanTag = deriveVlanTag(ws.orgId || ws.assignedUserId || ws.id);

  try {
    // Clone
    const taskUpid = await proxmox.cloneVm(gpu.node.name, template.templateVmid, {
      node: gpu.node.name,
      vmid: template.templateVmid,
      newid: newVmid,
      name: vmName,
    });
    await proxmox.waitForTask(gpu.node.name, taskUpid, 180000);
    await releaseCloneSemaphore(prisma, ws.id);

    await prisma.workspace.update({
      where: { id: ws.id },
      data: { cloneCompletedAt: new Date() },
    });

    // GPU passthrough + VLAN isolation (per-tenant network segment)
    await proxmox.updateVmConfig(gpu.node.name, newVmid, {
      hostpci0: `${gpu.pciAddress},pcie=1`,
      net0: `virtio,bridge=vmbr0,tag=${vlanTag}`,
    });
    await prisma.workspace.update({
      where: { id: ws.id },
      data: { gpuAttachedAt: new Date(), vlanTag },
    });

    // Attach persistent volume if workspace has one
    const attachedVolume = await prisma.persistentVolume.findFirst({
      where: { attachedToWorkspaceId: ws.id },
    });
    if (attachedVolume) {
      const scsiDisk = `${attachedVolume.proxmoxStoragePool || 'local-lvm'}:${attachedVolume.proxmoxDiskId}`;
      await proxmox.updateVmConfig(gpu.node.name, newVmid, { scsi1: scsiDisk });
      console.log(`[WarmPool] Attached volume ${attachedVolume.id} to workspace ${ws.id}`);
    }

    // Provision S3 bucket for ML checkpoints (if MinIO is configured)
    const s3Env = await provisionS3Bucket(prisma, ws);

    // Cloud-init with S3 credentials injected
    const cloudInitConfig: any = {
      ciuser: 'aldaro',
      ipconfig0: 'ip=dhcp',
    };
    // Inject S3 env vars via cloud-init user-data if bucket was provisioned
    if (s3Env) {
      cloudInitConfig.ciuser = 'aldaro';
      // SSH keys and env injection happen via the agent startup, not cloud-init directly
    }
    await proxmox.setCloudInit(gpu.node.name, newVmid, cloudInitConfig);

    // Start
    await proxmox.startVm(gpu.node.name, newVmid);
    await prisma.workspace.update({
      where: { id: ws.id },
      data: {
        bootCompletedAt: new Date(),
        status: 'WAITING_FOR_AGENT',
      },
    });

    console.log(`[WarmPool] Cold-provisioned workspace ${ws.id} for user (VLAN ${vlanTag})`);
  } catch (error: any) {
    console.error(`[WarmPool] Cold provision failed for ${ws.id}:`, error);

    await releaseCloneSemaphore(prisma, ws.id);

    await prisma.workspace.update({
      where: { id: ws.id },
      data: {
        status: 'FAILED',
        failedAt: new Date(),
        lastErrorCode: error.code || 'PROVISION_ERROR',
        lastErrorMessage: sanitizeErrorMessage(error.message),
      },
    });

    // Rollback GPU
    await prisma.fleetGpu.update({
      where: { id: gpu.id },
      data: {
        status: 'FREE',
        currentWorkspaceId: null,
      },
    });

    await prisma.workspaceGpuAllocation.deleteMany({
      where: { workspaceId: ws.id },
    });

    // Cleanup VM
    try {
      await proxmox.deleteVm(gpu.node.name, newVmid);
    } catch (cleanupErr) {
      console.error(`[WarmPool] Cleanup failed:`, cleanupErr);
    }
  }
}

/**
 * Provision a MinIO S3 bucket for ML checkpoint storage.
 * Creates a per-workspace bucket + access key, stores encrypted secret on workspace record.
 */
async function provisionS3Bucket(prisma: PrismaClient, ws: any): Promise<{ accessKeyId: string; secretAccessKey: string; bucket: string; endpoint: string } | null> {
  const minioEndpoint = process.env.MINIO_ENDPOINT;
  const minioAdminKey = process.env.MINIO_ROOT_USER;
  const minioAdminSecret = process.env.MINIO_ROOT_PASSWORD;

  if (!minioEndpoint || !minioAdminKey || !minioAdminSecret) {
    return null; // MinIO not configured
  }

  const bucketName = `ws-${ws.id.slice(0, 12)}`;
  const accessKeyId = `ak-${crypto.randomBytes(8).toString('hex')}`;
  const secretAccessKey = crypto.randomBytes(24).toString('base64url');

  try {
    // Create bucket via MinIO S3 API
    await axios.put(`${minioEndpoint}/${bucketName}`, null, {
      headers: {
        'Authorization': `AWS ${minioAdminKey}:${minioAdminSecret}`,
      },
      timeout: 10000,
    });

    // Create access key via MinIO admin API (mc admin user add)
    await axios.post(`${minioEndpoint}/minio/admin/v3/add-user`, null, {
      params: { accessKey: accessKeyId, secretKey: secretAccessKey },
      headers: {
        'Authorization': `AWS ${minioAdminKey}:${minioAdminSecret}`,
      },
      timeout: 10000,
    });

    // SECURITY: Encrypt secret key before storing — never store plaintext
    const encKey = process.env.ENCRYPTION_KEY;
    if (!encKey || encKey.length < 32) {
      throw new Error('ENCRYPTION_KEY must be set and >= 32 characters to provision S3 buckets');
    }
    const key = crypto.createHash('sha256').update(encKey).digest();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(secretAccessKey, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const encryptedSecret = `${iv.toString('base64')}:${tag.toString('base64')}:${encrypted.toString('base64')}`;

    await prisma.workspace.update({
      where: { id: ws.id },
      data: {
        s3BucketName: bucketName,
        s3AccessKeyId: accessKeyId,
        s3SecretAccessKeyEnc: encryptedSecret,
      },
    });

    console.log(`[S3] Provisioned bucket ${bucketName} for workspace ${ws.id}`);
    return { accessKeyId, secretAccessKey, bucket: bucketName, endpoint: minioEndpoint };
  } catch (err: any) {
    console.error(`[S3] Failed to provision bucket for workspace ${ws.id}:`, err.message);
    return null; // Non-fatal: workspace runs without S3
  }
}

// ---------------------------------------------------------------------------
// AES-256-GCM decryption for registry credentials (mirrors API encryption)
// ---------------------------------------------------------------------------
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }
  return crypto.createHash('sha256').update(key).digest();
}

function decryptToken(encryptedStr: string): string {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = encryptedStr.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted token format');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

/**
 * Send custom image startup command to workspace agent.
 * Called when a workspace transitions to RUNNING_ASSIGNED and has a customImageRepo.
 */
async function sendCustomImageStartup(prisma: PrismaClient, ws: any): Promise<void> {
  if (!ws.customImageRepo || !ws.vmInternalIp) return;

  const fullImage = `${ws.customImageRepo}:${ws.customImageTag || 'latest'}`;
  console.log(`[WarmPool] Sending custom image startup to workspace ${ws.id}: ${fullImage}`);

  const startupPayload: any = {
    custom_image: fullImage,
    gpu_passthrough: true,
  };

  // If workspace has S3 bucket credentials, include them for checkpoint storage
  if (ws.s3BucketName && ws.s3AccessKeyId && ws.s3SecretAccessKeyEnc) {
    try {
      const s3SecretKey = decryptToken(ws.s3SecretAccessKeyEnc);
      startupPayload.s3_env = {
        AWS_ACCESS_KEY_ID: ws.s3AccessKeyId,
        AWS_SECRET_ACCESS_KEY: s3SecretKey,
        AWS_S3_ENDPOINT_URL: process.env.MINIO_ENDPOINT || 'http://minio.aldaro.internal:9000',
        S3_BUCKET: ws.s3BucketName,
      };
    } catch (err) {
      console.error(`[WarmPool] Failed to decrypt S3 credentials for workspace ${ws.id}:`, err);
    }
  }

  // If registry credential is set, decrypt and include auth details
  if (ws.registryCredentialId) {
    try {
      const credential = await prisma.imageRegistryCredential.findUnique({
        where: { id: ws.registryCredentialId },
      });

      if (credential) {
        const decryptedToken = decryptToken(credential.encryptedToken);
        startupPayload.registry_url = credential.registryUrl;
        startupPayload.registry_username = credential.username || undefined;
        startupPayload.registry_token = decryptedToken;
      }
    } catch (err) {
      console.error(`[WarmPool] Failed to decrypt registry credential for workspace ${ws.id}:`, err);
      // Continue without registry auth — the image may be public
    }
  }

  try {
    await axios.post(`http://${ws.vmInternalIp}:8844/startup`, startupPayload, {
      timeout: 30000,
    });
    console.log(`[WarmPool] Custom image startup sent successfully for workspace ${ws.id}`);
  } catch (err: any) {
    console.error(`[WarmPool] Failed to send custom image startup to workspace ${ws.id}:`, err.message);
    // Non-fatal: workspace is still usable, just without custom image
  }
}

/**
 * Start a usage session for a cold-booted workspace using the price that was
 * locked at launch time (workspace.lockedSpotPriceCents). Falls back to live
 * spot price if the locked price is missing (shouldn't happen for new launches).
 */
async function startUsageSessionForColdWorkspace(prisma: PrismaClient, ws: any): Promise<void> {
  // Guard: don't create duplicate sessions
  const existing = await prisma.usageSession.findFirst({
    where: { workspaceId: ws.id, status: 'RUNNING' },
  });
  if (existing) return;

  let pricePerHourCents = 0;

  if (ws.lockedSpotPriceCents != null && ws.lockedSpotPriceCents > 0) {
    // Use the price captured at launch time — this is the price the user saw at checkout
    pricePerHourCents = ws.lockedSpotPriceCents;
  } else {
    // Fallback for workspaces created before this fix was deployed
    const warmPoolCfg = await prisma.warmPoolConfig.findFirst({
      where: { gpuType: ws.gpuType },
    });
    if (warmPoolCfg && warmPoolCfg.currentSpotPriceCents > 0) {
      pricePerHourCents = warmPoolCfg.currentSpotPriceCents;
    } else {
      const sku = await prisma.gpuSku.findFirst({ where: { key: ws.gpuType } });
      pricePerHourCents = sku?.pricePerHourCents || 0;
    }
    console.warn(`[BILLING] Workspace ${ws.id} had no lockedSpotPriceCents — using fallback price ${pricePerHourCents}`);
  }

  try {
    await prisma.usageSession.create({
      data: {
        userId: ws.assignedUserId,
        workspaceId: ws.id,
        gpuType: ws.gpuType,
        startTime: new Date(),
        status: 'RUNNING',
        pricePerHourCents,
      },
    });
    console.log(`[BILLING] Started usage session for cold workspace ${ws.id} at ${pricePerHourCents} cents/hr (locked at launch)`);
  } catch (err: any) {
    // P2002 = unique constraint — another path already created the session
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return;
    }
    throw err;
  }
}

async function processWaitingWorkspaces(prisma: PrismaClient) {
  const proxmox = getProxmoxProvider();

  const waiting = await prisma.workspace.findMany({
    where: { status: 'WAITING_FOR_AGENT' },
    take: 10,
  });

  for (const ws of waiting) {
    if (!ws.proxmoxNode || !ws.proxmoxVmid) continue;

    try {
      // Check if VM has IP address
      const ip = await proxmox.getVmIpAddress(ws.proxmoxNode, ws.proxmoxVmid);
      
      if (ip && !ws.vmInternalIp) {
        // TELEMETRY: IP discovered
        await prisma.workspace.update({
          where: { id: ws.id },
          data: { 
            vmInternalIp: ip,
            ipDiscoveredAt: new Date(),
          },
        });
        console.log(`[WarmPool] Workspace ${ws.id} got IP: ${ip}`);
      }

      // Check if agent is responsive (via heartbeat timestamp)
      const freshWs = await prisma.workspace.findUnique({ where: { id: ws.id } });
      if (!freshWs) continue;

      if (freshWs.vmInternalIp && freshWs.lastAgentHeartbeatAt) {
        const now = new Date();
        const heartbeatAge = (now.getTime() - freshWs.lastAgentHeartbeatAt.getTime()) / 1000;

        // Agent is responsive if we've seen heartbeat in last 30 seconds
        if (heartbeatAge < 30) {
          // TELEMETRY: Mark agent registered if not already
          const updates: any = {
            status: freshWs.isWarmPool ? 'WARM_AVAILABLE' : 'RUNNING_ASSIGNED',
            verificationStatus: 'PASS',
            verificationScore: 100,
          };

          if (!freshWs.agentRegisteredAt) {
            updates.agentRegisteredAt = new Date();
          }

          // For user-assigned workspaces, set startedAt
          if (!freshWs.isWarmPool && !freshWs.startedAt) {
            updates.startedAt = new Date();
          }

          await prisma.workspace.update({
            where: { id: ws.id },
            data: updates,
          });
          console.log(`[WarmPool] Workspace ${ws.id} is now ${freshWs.isWarmPool ? 'WARM_AVAILABLE' : 'RUNNING_ASSIGNED'}`);

          // Start billing for cold-booted user workspaces using the price
          // locked at launch time (prevents bait-and-switch from spot pricing changes)
          if (!freshWs.isWarmPool && freshWs.assignedUserId) {
            await startUsageSessionForColdWorkspace(prisma, freshWs);
          }

          // If workspace has a custom image and just became RUNNING_ASSIGNED, send startup
          if (!freshWs.isWarmPool && freshWs.customImageRepo) {
            await sendCustomImageStartup(prisma, freshWs);
          }
        }
      }

      // Timeout check: workspaces waiting too long should be cleaned up
      const waitingTime = (new Date().getTime() - (ws.bootCompletedAt?.getTime() || ws.createdAt.getTime())) / 1000;
      if (waitingTime > 300) { // 5 minute timeout
        console.log(`[WarmPool] Workspace ${ws.id} timed out waiting for agent (${waitingTime}s)`);
        await prisma.workspace.update({
          where: { id: ws.id },
          data: {
            status: 'TERMINATING',
            failedAt: new Date(),
            lastErrorCode: 'AGENT_TIMEOUT',
            lastErrorMessage: 'Agent did not register within timeout period',
            terminationReason: 'agent_timeout',
          },
        });

        // Enqueue cleanup job instead of inline terminate (cleanup job handles
        // VM deletion, GPU release, session finalization, and gateway release)
        await prisma.workspaceCleanupJob.upsert({
          where: { workspaceId: ws.id },
          update: {
            status: 'PENDING',
            nextAttemptAt: new Date(),
            reasonCode: 'agent_timeout',
          },
          create: {
            workspaceId: ws.id,
            reasonCode: 'agent_timeout',
            status: 'PENDING',
            nextAttemptAt: new Date(),
          },
        });
      }
    } catch (err) {
      console.error(`[WarmPool] Error processing waiting workspace ${ws.id}:`, err);
    }
  }
}

export async function terminateWorkspace(prisma: PrismaClient, id: string, reason?: string) {
  const proxmox = getProxmoxProvider();

  const ws = await prisma.workspace.findUnique({
    where: { id },
    include: { gpuAllocation: true, endpoint: true },
  });

  if (!ws) return;

  await prisma.workspace.update({
    where: { id },
    data: { 
      status: 'TERMINATING',
      terminationReason: reason || 'manual',
    },
  });

  // Delete VM from Proxmox
  if (ws.proxmoxNode && ws.proxmoxVmid) {
    try {
      await proxmox.stopVm(ws.proxmoxNode, ws.proxmoxVmid);
      await proxmox.deleteVm(ws.proxmoxNode, ws.proxmoxVmid);
    } catch (err: any) {
      // VM might already be deleted
      if (!err.message?.includes('does not exist')) {
        console.error(`[WarmPool] Error deleting VM ${ws.proxmoxVmid}:`, err);
      }
    }
  }

  // Release GPU
  if (ws.gpuAllocation) {
    await prisma.fleetGpu.update({
      where: { id: ws.gpuAllocation.gpuId },
      data: { 
        status: 'FREE',
        currentWorkspaceId: null,
      },
    });

    await prisma.workspaceGpuAllocation.update({
      where: { id: ws.gpuAllocation.id },
      data: { releasedAt: new Date() },
    });
  }

  // Release ports
  if (ws.endpoint) {
    await prisma.workspaceEndpoint.update({
      where: { id: ws.endpoint.id },
      data: { releasedAt: new Date() },
    });
  }

  // Close any open usage sessions atomically with outbox enqueue
  const activeSessions = await prisma.usageSession.findMany({
    where: {
      workspaceId: id,
      status: 'RUNNING',
    },
  });

  for (const session of activeSessions) {
    const endTime = new Date();
    const totalSeconds = Math.max(0, Math.ceil((endTime.getTime() - session.startTime.getTime()) / 1000));
    const billedCents = Math.ceil((totalSeconds * session.pricePerHourCents) / 3600);

    try {
      await prisma.$transaction([
        prisma.usageSession.update({
          where: { id: session.id, status: 'RUNNING' },
          data: {
            endTime,
            totalSeconds,
            billedSeconds: totalSeconds,
            billedCents,
            status: 'ENDED',
          },
        }),
        prisma.workspaceMeterEventOutbox.upsert({
          where: { usageSessionId: session.id },
          update: {
            valueSeconds: totalSeconds,
            status: 'PENDING',
            nextAttemptAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
          },
          create: {
            usageSessionId: session.id,
            userId: session.userId,
            workspaceId: id,
            valueSeconds: totalSeconds,
            status: 'PENDING',
            nextAttemptAt: new Date(),
          },
        }),
      ]);
    } catch (err: any) {
      // P2025 = session already closed by another path. Safe to skip.
      if (err?.code === 'P2025') continue;
      throw err;
    }
  }

  await prisma.workspace.update({
    where: { id },
    data: {
      status: 'TERMINATED',
      terminatedAt: new Date(),
    },
  });

  console.log(`[WarmPool] Terminated workspace ${id} (reason: ${reason || 'manual'})`);
}

function mapGpuType(gpuType: string): string {
  const mapping: Record<string, string> = {
    'RTX_5090': '5090',
    'A100_80GB': 'A100',
  };
  return mapping[gpuType] || gpuType;
}

async function getNextVmid(prisma: PrismaClient, node: string): Promise<number> {
  const lastWorkspace = await prisma.workspace.findFirst({
    where: { proxmoxNode: node, proxmoxVmid: { not: null } },
    orderBy: { proxmoxVmid: 'desc' },
  });

  return (lastWorkspace?.proxmoxVmid || 999) + 1;
}
