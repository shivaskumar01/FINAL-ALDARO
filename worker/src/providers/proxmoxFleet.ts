import axios, { AxiosInstance } from 'axios';
import https from 'https';
import fs from 'fs';

/**
 * Proxmox Fleet Provider for Aldaro Worker
 *
 * This provides VM lifecycle operations on Aldaro-owned Proxmox infrastructure.
 * NO external GPU providers are supported.
 */

export interface ProxmoxCloneRequest {
  node: string;
  vmid: number;
  newid: number;
  name: string;
  storage?: string;
}

export interface ProxmoxConfigUpdate {
  hostpci0?: string; // GPU passthrough: "0000:65:00.0,pcie=1"
  [key: string]: string | undefined;
}

export class ProxmoxFleetProvider {
  private api: AxiosInstance;

  constructor(
    private readonly host: string,
    private readonly apiToken: string
  ) {
    // SECURITY: TLS verification is enabled by default. To use a custom CA
    // (e.g. Proxmox self-signed), set PROXMOX_CA_CERT_PATH to the CA file.
    // Only disable TLS verification in local dev via PROXMOX_TLS_SKIP_VERIFY=true.
    const skipVerify = process.env.PROXMOX_TLS_SKIP_VERIFY === 'true';
    const caPath = process.env.PROXMOX_CA_CERT_PATH;
    let agent: https.Agent;

    if (caPath) {
      agent = new https.Agent({ ca: fs.readFileSync(caPath), rejectUnauthorized: true });
    } else if (skipVerify && process.env.NODE_ENV !== 'production') {
      agent = new https.Agent({ rejectUnauthorized: false });
    } else {
      agent = new https.Agent({ rejectUnauthorized: true });
    }

    this.api = axios.create({
      baseURL: `${host}/api2/json`,
      headers: {
        'Authorization': apiToken,
        'Content-Type': 'application/json',
      },
      httpsAgent: agent,
    });

    // SECURITY: Redact Authorization header from axios error objects
    // to prevent token leakage in error logs or stack traces.
    this.api.interceptors.response.use(
      (res) => res,
      (err) => {
        if (err.config?.headers?.Authorization) {
          err.config.headers.Authorization = '[REDACTED]';
        }
        if (err.response?.config?.headers?.Authorization) {
          err.response.config.headers.Authorization = '[REDACTED]';
        }
        throw err;
      }
    );
  }

  async cloneVm(node: string, sourceVmid: number, req: ProxmoxCloneRequest): Promise<string> {
    const res = await this.api.post(`/nodes/${node}/qemu/${sourceVmid}/clone`, {
      newid: req.newid,
      name: req.name,
      full: 1, // Full clone, not linked
      storage: req.storage || 'local-lvm',
    });
    
    // Returns task UPID
    return res.data.data;
  }

  async waitForTask(node: string, upid: string, timeoutMs: number = 120000): Promise<void> {
    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      const res = await this.api.get(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
      const status = res.data.data.status;
      
      if (status === 'stopped') {
        if (res.data.data.exitstatus === 'OK') {
          return;
        }
        throw new Error(`Task failed: ${res.data.data.exitstatus}`);
      }
      
      await new Promise(r => setTimeout(r, 2000));
    }
    
    throw new Error(`Task timeout after ${timeoutMs}ms`);
  }

  async updateVmConfig(node: string, vmid: number, config: ProxmoxConfigUpdate): Promise<void> {
    await this.api.post(`/nodes/${node}/qemu/${vmid}/config`, config);
  }

  async setCloudInit(node: string, vmid: number, config: {
    sshkeys?: string;
    ciuser?: string;
    cipassword?: string;
    ipconfig0?: string;
    nameserver?: string;
  }): Promise<void> {
    await this.api.post(`/nodes/${node}/qemu/${vmid}/config`, config);
  }

  async startVm(node: string, vmid: number): Promise<void> {
    await this.api.post(`/nodes/${node}/qemu/${vmid}/status/start`);
  }

  async stopVm(node: string, vmid: number): Promise<void> {
    await this.api.post(`/nodes/${node}/qemu/${vmid}/status/stop`);
  }

  async deleteVm(node: string, vmid: number): Promise<void> {
    // First stop if running
    try {
      await this.stopVm(node, vmid);
      await new Promise(r => setTimeout(r, 3000)); // Wait for stop
    } catch (e) {
      // Ignore stop errors
    }
    
    await this.api.delete(`/nodes/${node}/qemu/${vmid}`);
  }

  async getVmStatus(node: string, vmid: number): Promise<{
    status: string;
    qmpstatus?: string;
    uptime?: number;
    cpu?: number;
    mem?: number;
  }> {
    const res = await this.api.get(`/nodes/${node}/qemu/${vmid}/status/current`);
    return res.data.data;
  }

  async getVmIpAddress(node: string, vmid: number): Promise<string | null> {
    try {
      const res = await this.api.get(`/nodes/${node}/qemu/${vmid}/agent/network-get-interfaces`);
      const interfaces = res.data.data.result;
      
      for (const iface of interfaces) {
        if (iface.name === 'eth0' || iface.name === 'ens18') {
          for (const addr of iface['ip-addresses'] || []) {
            if (addr['ip-address-type'] === 'ipv4' && !addr['ip-address'].startsWith('127.')) {
              return addr['ip-address'];
            }
          }
        }
      }
      return null;
    } catch (e) {
      // qemu-guest-agent might not be running yet
      return null;
    }
  }

  async isAgentResponsive(node: string, vmid: number): Promise<boolean> {
    try {
      await this.api.post(`/nodes/${node}/qemu/${vmid}/agent/ping`);
      return true;
    } catch (e) {
      return false;
    }
  }
}

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
