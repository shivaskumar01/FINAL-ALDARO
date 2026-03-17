import axios, { AxiosInstance } from 'axios';
import * as https from 'https';

/**
 * Proxmox Fleet Provider for Aldaro API
 * 
 * This provides VM lifecycle operations on Aldaro-owned Proxmox infrastructure.
 * NO external GPU providers are supported.
 * 
 * Operations:
 * - Clone VM from template
 * - Configure GPU passthrough (PCI device assignment)
 * - Set cloud-init configuration
 * - Start/Stop/Delete VMs
 * - Query VM status and network info via qemu-guest-agent
 */

export interface ProxmoxCloneRequest {
  node: string;
  vmid: number;
  newid: number;
  name: string;
  storage?: string;
  full?: boolean;
}

export interface ProxmoxConfigUpdate {
  hostpci0?: string; // GPU passthrough: "0000:65:00.0,pcie=1"
  memory?: number;
  cores?: number;
  sockets?: number;
  [key: string]: string | number | undefined;
}

export interface CloudInitConfig {
  ciuser?: string;
  cipassword?: string;
  sshkeys?: string;
  ipconfig0?: string;
  nameserver?: string;
  searchdomain?: string;
}

export interface VmStatus {
  status: string;
  qmpstatus?: string;
  uptime?: number;
  cpu?: number;
  mem?: number;
  maxmem?: number;
  disk?: number;
  maxdisk?: number;
  netin?: number;
  netout?: number;
}

export class ProxmoxFleetProvider {
  private api: AxiosInstance;

  constructor(
    private readonly host: string, // https://proxmox.aldaro.internal:8006
    private readonly apiToken: string // PVEAPIToken=USER@REALM!TOKENID=UUID
  ) {
    this.api = axios.create({
      baseURL: `${host}/api2/json`,
      headers: {
        'Authorization': apiToken,
        'Content-Type': 'application/json',
      },
      // Proxmox often uses self-signed certs in internal fleet
      // In production with proper PKI, set rejectUnauthorized: true
      httpsAgent: new https.Agent({ rejectUnauthorized: false }),
      timeout: 30000,
    });
  }

  /**
   * Clone a VM from a template.
   * Returns the task UPID for monitoring.
   */
  async cloneVm(node: string, sourceVmid: number, req: ProxmoxCloneRequest): Promise<string> {
    const res = await this.api.post(`/nodes/${node}/qemu/${sourceVmid}/clone`, {
      newid: req.newid,
      name: req.name,
      full: req.full !== false ? 1 : 0, // Default to full clone
      storage: req.storage || 'local-lvm',
    });
    
    return res.data.data; // Task UPID
  }

  /**
   * Wait for a Proxmox task to complete.
   */
  async waitForTask(node: string, upid: string, timeoutMs: number = 180000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const res = await this.api.get(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
      const status = res.data.data.status;
      
      if (status === 'stopped') {
        if (res.data.data.exitstatus === 'OK') {
          return;
        }
        throw new Error(`Proxmox task failed: ${res.data.data.exitstatus}`);
      }
      
      await new Promise(r => setTimeout(r, 2000));
    }
    
    throw new Error(`Proxmox task timeout after ${timeoutMs}ms: ${upid}`);
  }

  /**
   * Update VM configuration (e.g., add GPU passthrough).
   */
  async updateVmConfig(node: string, vmid: number, config: ProxmoxConfigUpdate): Promise<void> {
    const res = await this.api.post(`/nodes/${node}/qemu/${vmid}/config`, config);
    if (res.status !== 200) {
      throw new Error(`Proxmox updateVmConfig failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
  }

  /**
   * Set cloud-init configuration for a VM.
   */
  async setCloudInit(node: string, vmid: number, config: CloudInitConfig): Promise<void> {
    // URL-encode SSH keys if present
    const payload: Record<string, string> = {};
    
    if (config.ciuser) payload.ciuser = config.ciuser;
    if (config.cipassword) payload.cipassword = config.cipassword;
    if (config.sshkeys) payload.sshkeys = encodeURIComponent(config.sshkeys);
    if (config.ipconfig0) payload.ipconfig0 = config.ipconfig0;
    if (config.nameserver) payload.nameserver = config.nameserver;
    if (config.searchdomain) payload.searchdomain = config.searchdomain;

    await this.api.post(`/nodes/${node}/qemu/${vmid}/config`, payload);
  }

  /**
   * Start a VM.
   */
  async startVm(node: string, vmid: number): Promise<string> {
    const res = await this.api.post(`/nodes/${node}/qemu/${vmid}/status/start`);
    return res.data.data; // Task UPID
  }

  /**
   * Stop a VM (graceful shutdown via ACPI).
   */
  async stopVm(node: string, vmid: number): Promise<string> {
    const res = await this.api.post(`/nodes/${node}/qemu/${vmid}/status/stop`);
    return res.data.data; // Task UPID
  }

  /**
   * Shutdown a VM gracefully via qemu-guest-agent.
   */
  async shutdownVm(node: string, vmid: number): Promise<string> {
    const res = await this.api.post(`/nodes/${node}/qemu/${vmid}/status/shutdown`);
    return res.data.data; // Task UPID
  }

  /**
   * Delete a VM.
   */
  async deleteVm(node: string, vmid: number): Promise<void> {
    // First try to stop it
    try {
      await this.stopVm(node, vmid);
      await new Promise(r => setTimeout(r, 5000)); // Wait for stop
    } catch (e) {
      // VM might already be stopped, continue
    }

    const res = await this.api.delete(`/nodes/${node}/qemu/${vmid}`);
    if (res.status !== 200) {
      throw new Error(`Proxmox deleteVm failed: ${res.status} ${JSON.stringify(res.data)}`);
    }
  }

  /**
   * Get current VM status.
   */
  async getVmStatus(node: string, vmid: number): Promise<VmStatus> {
    const res = await this.api.get(`/nodes/${node}/qemu/${vmid}/status/current`);
    return res.data.data;
  }

  /**
   * Get VM's IP address via qemu-guest-agent.
   * Requires qemu-guest-agent to be running inside the VM.
   */
  async getVmIpAddress(node: string, vmid: number): Promise<string | null> {
    try {
      const res = await this.api.get(`/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`);
      const interfaces = res.data.data.result;
      
      // Look for common interface names
      const preferredInterfaces = ['eth0', 'ens18', 'ens3', 'enp0s3'];
      
      for (const ifaceName of preferredInterfaces) {
        const iface = interfaces.find((i: any) => i.name === ifaceName);
        if (iface && iface['ip-addresses']) {
          for (const addr of iface['ip-addresses']) {
            if (addr['ip-address-type'] === 'ipv4' && !addr['ip-address'].startsWith('127.')) {
              return addr['ip-address'];
            }
          }
        }
      }
      
      // Fallback: find any non-loopback IPv4
      for (const iface of interfaces) {
        if (iface.name === 'lo') continue;
        for (const addr of iface['ip-addresses'] || []) {
          if (addr['ip-address-type'] === 'ipv4' && !addr['ip-address'].startsWith('127.')) {
            return addr['ip-address'];
          }
        }
      }
      
      return null;
    } catch (e) {
      // qemu-guest-agent might not be running yet
      return null;
    }
  }

  /**
   * Check if qemu-guest-agent is responsive.
   */
  async isAgentResponsive(node: string, vmid: number): Promise<boolean> {
    try {
      await this.api.post(`/nodes/${node}/qemu/${vmid}/agent/ping`);
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Execute a command inside the VM via qemu-guest-agent.
   */
  async execInVm(node: string, vmid: number, command: string): Promise<{ exitcode: number; stdout: string; stderr: string }> {
    const res = await this.api.post(`/nodes/${node}/qemu/${vmid}/agent/exec`, {
      command,
    });

    const pid = res.data.data.pid;

    // Poll for completion
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000));
      
      const statusRes = await this.api.get(`/nodes/${node}/qemu/${vmid}/agent/exec-status`, {
        params: { pid },
      });

      if (statusRes.data.data.exited) {
        return {
          exitcode: statusRes.data.data.exitcode || 0,
          stdout: statusRes.data.data['out-data'] ? Buffer.from(statusRes.data.data['out-data'], 'base64').toString() : '',
          stderr: statusRes.data.data['err-data'] ? Buffer.from(statusRes.data.data['err-data'], 'base64').toString() : '',
        };
      }
    }

    throw new Error('Command execution timeout');
  }

  /**
   * Get the next available VM ID for a node.
   */
  async getNextVmid(node: string): Promise<number> {
    const res = await this.api.get(`/cluster/nextid`);
    return res.data.data;
  }

  /**
   * List all VMs on a node.
   */
  async listVms(node: string): Promise<Array<{ vmid: number; name: string; status: string }>> {
    const res = await this.api.get(`/nodes/${node}/qemu`);
    return res.data.data;
  }
}

// Singleton instance
let _provider: ProxmoxFleetProvider | null = null;

export function getProxmoxProvider(): ProxmoxFleetProvider {
  if (!_provider) {
    const host = process.env.PROXMOX_API_URL;
    const tokenId = process.env.PROXMOX_API_TOKEN_ID;
    const tokenSecret = process.env.PROXMOX_API_TOKEN_SECRET;

    if (!host || !tokenId || !tokenSecret) {
      throw new Error('PROXMOX_API_URL, PROXMOX_API_TOKEN_ID, and PROXMOX_API_TOKEN_SECRET are required');
    }

    const apiToken = `PVEAPIToken=${tokenId}=${tokenSecret}`;
    _provider = new ProxmoxFleetProvider(host, apiToken);
  }
  return _provider;
}
