import { PrismaClient } from '@prisma/client';
import { ProxmoxFleetProvider } from './proxmoxFleetProvider';
import { v4 as uuidv4 } from 'uuid';

/**
 * Aldaro Fleet Provisioner
 * 
 * This provisioner uses ONLY Aldaro-owned GPU infrastructure via Proxmox.
 * NO external GPU providers (RunPod, etc.) are supported.
 */

const prisma = new PrismaClient();

export interface ProvisionRequest {
  runId: string;
  gpuType: string;
  gpuCount: number;
  region?: string;
  env?: Record<string, string>;
}

export interface ProvisionResponse {
  workspaceId: string;
  status: string;
  proxmoxNode: string;
  proxmoxVmid: number;
}

function getProxmoxProvider(): ProxmoxFleetProvider {
  const host = process.env.PROXMOX_API_URL;
  const tokenId = process.env.PROXMOX_API_TOKEN_ID;
  const tokenSecret = process.env.PROXMOX_API_TOKEN_SECRET;

  if (!host || !tokenId || !tokenSecret) {
    throw new Error('PROXMOX_API_URL, PROXMOX_API_TOKEN_ID, and PROXMOX_API_TOKEN_SECRET are required');
  }

  const apiToken = `PVEAPIToken=${tokenId}=${tokenSecret}`;
  return new ProxmoxFleetProvider(host, apiToken);
}

export class Provisioner {
  /**
   * Provision a workspace for a run using Aldaro's fleet.
   * This creates a VM clone with GPU passthrough on our Proxmox infrastructure.
   */
  async provision(req: ProvisionRequest): Promise<ProvisionResponse> {
    // 1. Find a free GPU of the requested type on an active fleet node
    const gpu = await prisma.fleetGpu.findFirst({
      where: {
        status: 'FREE',
        gpuName: { contains: this.mapGpuType(req.gpuType) },
        node: { status: 'ACTIVE' },
      },
      include: { node: true },
    });

    if (!gpu) {
      throw new Error(`NO_GPU_AVAILABLE: No free ${req.gpuType} GPU available in Aldaro fleet`);
    }

    // 2. Find VM template for this GPU type
    const template = await prisma.vmTemplate.findFirst({
      where: { proxmoxNode: gpu.node.name },
      orderBy: { createdAt: 'desc' },
    });

    if (!template) {
      throw new Error(`NO_TEMPLATE: No VM template configured for node ${gpu.node.name}`);
    }

    // 3. Create workspace record
    const workspaceId = uuidv4();
    const newVmid = await this.getNextVmid(gpu.node.name);

    await prisma.workspace.create({
      data: {
        id: workspaceId,
        gpuType: req.gpuType,
        region: req.region || 'US',
        status: 'CREATING',
        proxmoxNode: gpu.node.name,
        proxmoxVmid: newVmid,
      },
    });

    // 4. Allocate the GPU
    await prisma.fleetGpu.update({
      where: { id: gpu.id },
      data: { status: 'ALLOCATED' },
    });

    await prisma.workspaceGpuAllocation.create({
      data: {
        workspaceId,
        gpuId: gpu.id,
        nodeId: gpu.nodeId,
      },
    });

    // 5. Provision on Proxmox
    try {
      const proxmox = getProxmoxProvider();

      // Clone VM from template
      await proxmox.cloneVm(gpu.node.name, template.templateVmid, {
        node: gpu.node.name,
        vmid: template.templateVmid,
        newid: newVmid,
        name: `aldaro-run-${req.runId}-${workspaceId.slice(0, 8)}`,
      });

      // Attach GPU via PCI passthrough
      await proxmox.updateVmConfig(gpu.node.name, newVmid, {
        hostpci0: `${gpu.pciAddress},pcie=1`,
      });

      // Set cloud-init config (SSH keys, agent bootstrap)
      // Note: In production, this would set up cloud-init properly
      // await proxmox.setCloudInit(gpu.node.name, newVmid, { ... });

      // Start VM
      await proxmox.startVm(gpu.node.name, newVmid);

      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: 'WAITING_FOR_AGENT' },
      });

      return {
        workspaceId,
        status: 'provisioning',
        proxmoxNode: gpu.node.name,
        proxmoxVmid: newVmid,
      };
    } catch (error) {
      // Rollback on failure
      console.error(`Provisioning failed for workspace ${workspaceId}:`, error);

      await prisma.fleetGpu.update({
        where: { id: gpu.id },
        data: { status: 'FREE' },
      });

      await prisma.workspaceGpuAllocation.deleteMany({
        where: { workspaceId },
      });

      await prisma.workspace.update({
        where: { id: workspaceId },
        data: { status: 'FAILED' },
      });

      throw error;
    }
  }

  /**
   * Deprovision a workspace - delete VM and release GPU.
   */
  async deprovision(workspaceId: string): Promise<void> {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: { gpuAllocation: true },
    });

    if (!workspace || !workspace.proxmoxNode || !workspace.proxmoxVmid) {
      console.log(`Workspace ${workspaceId} has no Proxmox backing, skipping deprovision`);
      return;
    }

    try {
      const proxmox = getProxmoxProvider();

      // Stop and delete VM
      try {
        await proxmox.stopVm(workspace.proxmoxNode, workspace.proxmoxVmid);
      } catch (e) {
        // VM might already be stopped
        console.log(`Stop VM failed (may already be stopped):`, e);
      }

      await proxmox.deleteVm(workspace.proxmoxNode, workspace.proxmoxVmid);
    } catch (error) {
      console.error(`Failed to delete Proxmox VM for workspace ${workspaceId}:`, error);
      // Continue with cleanup even if Proxmox delete fails
    }

    // Release GPU allocation
    if (workspace.gpuAllocation) {
      await prisma.fleetGpu.update({
        where: { id: workspace.gpuAllocation.gpuId },
        data: { status: 'FREE' },
      });

      await prisma.workspaceGpuAllocation.update({
        where: { id: workspace.gpuAllocation.id },
        data: { releasedAt: new Date() },
      });
    }
  }

  /**
   * Map user-facing GPU type to Aldaro fleet GPU names.
   */
  private mapGpuType(gpuType: string): string {
    const mapping: Record<string, string> = {
      'RTX_5090': '5090',
      'A100_80GB': 'A100',
    };
    return mapping[gpuType] || gpuType;
  }

  /**
   * Get next available VM ID for a node.
   * In production, this should use Proxmox's nextid API or a distributed lock.
   */
  private async getNextVmid(node: string): Promise<number> {
    const lastWorkspace = await prisma.workspace.findFirst({
      where: { proxmoxNode: node, proxmoxVmid: { not: null } },
      orderBy: { proxmoxVmid: 'desc' },
    });

    // Start at 1000 to avoid conflicts with templates (usually < 1000)
    return (lastWorkspace?.proxmoxVmid || 999) + 1;
  }
}

export const provisioner = new Provisioner();
