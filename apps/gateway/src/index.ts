import Fastify, { FastifyRequest, FastifyReply } from 'fastify';
import crypto from 'crypto';
import http from 'http';
import https from 'https';
import fs from 'fs';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';

/**
 * Aldaro Edge Gateway
 *
 * Manages port allocations for workspace access (SSH, Jupyter, VSCode).
 *
 * DURABILITY MODEL:
 * - DB (workspace_endpoints table) is the source of truth for all leases.
 * - In-memory Maps are a fast cache reconstructed from DB on startup.
 * - Allocate writes to DB first, then updates cache.
 * - Release writes to DB first, then updates cache.
 * - On crash/restart, cache is rebuilt from DB — no leases are lost.
 *
 * SECURITY MODEL:
 * - Internal service only - should be network-isolated
 * - HMAC signature verification for all requests
 * - Service secret from environment
 * - Timing-safe signature comparison
 */

const isProduction = process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------------------
// JWT verification for PRIVATE exposed ports.
// Uses the same JWT_ACCESS_SECRET as the API server.
// ---------------------------------------------------------------------------
const JWT_SECRET = process.env.JWT_ACCESS_SECRET || '';

function verifyJwt(token: string): { valid: boolean; payload?: any } {
  if (!JWT_SECRET) {
    if (isProduction) return { valid: false };
    // In dev without a secret, allow (same pattern as other dev bypasses)
    return { valid: true };
  }
  try {
    const parts = token.replace('Bearer ', '').split('.');
    if (parts.length !== 3) return { valid: false };
    const [headerB64, payloadB64, signatureB64] = parts;
    const expected = crypto
      .createHmac('sha256', JWT_SECRET)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');
    if (expected !== signatureB64) return { valid: false };
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString());
    // Check expiry
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

// ---------------------------------------------------------------------------
// SSRF Protection — block proxying to internal services
// ---------------------------------------------------------------------------
const ALLOWED_VM_SUBNET = process.env.VM_SUBNET || '10.10.'; // Workspace VMs live here
const BLOCKED_PORTS = new Set([22, 5432, 6379, 9000, 2379, 2380]); // SSH, Postgres, Redis, MinIO admin, etcd

function isAllowedProxyTarget(ip: string, port: number): boolean {
  // Block loopback
  if (ip === '127.0.0.1' || ip === 'localhost' || ip === '::1' || ip === '0.0.0.0') return false;
  // Block link-local / metadata (AWS 169.254.169.254)
  if (ip.startsWith('169.254.')) return false;
  // Only allow IPs in the VM subnet
  if (!ip.startsWith(ALLOWED_VM_SUBNET)) return false;
  // Block infrastructure ports
  if (BLOCKED_PORTS.has(port)) return false;
  return true;
}

function extractJwtFromRequest(cookieHeader?: string, authHeader?: string): string | null {
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  if (cookieHeader) {
    const match = cookieHeader.match(/aldaro_session=([^;]+)/);
    if (match) return match[1];
  }
  return null;
}

// Validate required config
const serviceSecret = process.env.GATEWAY_SERVICE_SECRET;
if (isProduction) {
  if (!serviceSecret) {
    console.error('FATAL: GATEWAY_SERVICE_SECRET is required in production');
    process.exit(1);
  }
  if (!JWT_SECRET) {
    console.error('FATAL: JWT_ACCESS_SECRET is required in production for PRIVATE port auth');
    process.exit(1);
  }
}

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// TLS support: If TLS_CERT_PATH and TLS_KEY_PATH are set, the gateway
// listens on HTTPS directly (useful without an external TLS terminator).
// For production, prefer Caddy (see deploy/Caddyfile) in front of this.
// ---------------------------------------------------------------------------
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
let httpsOptions: { key: Buffer; cert: Buffer } | undefined;

if (TLS_CERT_PATH && TLS_KEY_PATH) {
  try {
    httpsOptions = {
      key: fs.readFileSync(TLS_KEY_PATH),
      cert: fs.readFileSync(TLS_CERT_PATH),
    };
    console.log('[GATEWAY] TLS enabled — serving HTTPS directly');
  } catch (err) {
    console.error(`[GATEWAY] Failed to load TLS cert/key: ${(err as Error).message}`);
    process.exit(1);
  }
}

const fastify = Fastify({
  logger: true,
  ...(httpsOptions ? { https: httpsOptions } : {}),
});

const PORT_RANGE_START = 20000;
const PORT_RANGE_END = 40000;
const GATEWAY_HOST = process.env.GATEWAY_HOST || 'gw1.aldaro.ai';

// In-memory cache — rebuilt from DB on startup and kept in sync via allocate/release.
const activeAllocations = new Map<string, { ssh: number; jupyter: number; vscode: number; ip: string }>();
const allocatedPorts = new Set<number>();

// Exposed port cache — maps subdomain to routing info
interface ExposedPortMapping {
  workspace_id: string;
  internal_port: number;
  vm_internal_ip: string;
  access_mode: string; // PUBLIC or PRIVATE
  subdomain: string;
}
const exposedPortMappings = new Map<string, ExposedPortMapping>();

const exposePortSchema = z.object({
  workspace_id: z.string().uuid(),
  internal_port: z.number().int().min(1).max(65535),
  subdomain: z.string(),
  vm_internal_ip: z.string().ip(),
  access_mode: z.enum(['PUBLIC', 'PRIVATE']).default('PRIVATE'),
  nonce: z.string().optional(),
  timestamp: z.number().optional(),
});

const releasePortSchema = z.object({
  subdomain: z.string(),
  nonce: z.string().optional(),
  timestamp: z.number().optional(),
});

const allocateSchema = z.object({
  workspace_id: z.string().uuid(),
  vm_internal_ip: z.string().ip(),
  nonce: z.string().optional(),
  timestamp: z.number().optional(),
});

const releaseSchema = z.object({
  workspace_id: z.string().uuid(),
  nonce: z.string().optional(),
  timestamp: z.number().optional(),
});

// --- Startup reconciliation ---

/**
 * On boot, load all active leases (releasedAt IS NULL) from DB into memory.
 * This means a gateway restart does not lose track of allocated ports.
 */
async function reconcileLeases() {
  const activeLeases = await prisma.workspaceEndpoint.findMany({
    where: { releasedAt: null },
    include: { workspace: { select: { vmInternalIp: true } } },
  });

  let loaded = 0;
  let stale = 0;

  for (const lease of activeLeases) {
    activeAllocations.set(lease.workspaceId, {
      ssh: lease.sshPort,
      jupyter: lease.jupyterPort,
      vscode: lease.vscodePort,
      ip: lease.workspace?.vmInternalIp || '',
    });
    allocatedPorts.add(lease.sshPort);
    allocatedPorts.add(lease.jupyterPort);
    allocatedPorts.add(lease.vscodePort);
    loaded++;
  }

  // Detect stale leases: workspace is TERMINATED/FAILED but endpoint not released.
  const staleLeases = await prisma.workspaceEndpoint.findMany({
    where: {
      releasedAt: null,
      workspace: { status: { in: ['TERMINATED', 'FAILED'] } },
    },
  });

  for (const stale_lease of staleLeases) {
    console.warn(`[GATEWAY] Stale lease detected for workspace ${stale_lease.workspaceId} — auto-releasing`);
    await prisma.workspaceEndpoint.update({
      where: { id: stale_lease.id },
      data: { releasedAt: new Date() },
    });
    // Remove from cache
    activeAllocations.delete(stale_lease.workspaceId);
    allocatedPorts.delete(stale_lease.sshPort);
    allocatedPorts.delete(stale_lease.jupyterPort);
    allocatedPorts.delete(stale_lease.vscodePort);
    stale++;
  }

  console.log(`[GATEWAY] Reconciled: ${loaded} active leases loaded, ${stale} stale leases released`);

  // Also load active exposed port mappings
  try {
    const activePorts = await prisma.exposedPort.findMany({
      where: { status: 'ACTIVE', releasedAt: null },
      include: { workspace: { select: { vmInternalIp: true } } },
    });
    let portsLoaded = 0;
    for (const ep of activePorts) {
      if (ep.workspace?.vmInternalIp) {
        exposedPortMappings.set(ep.publicSubdomain, {
          workspace_id: ep.workspaceId,
          internal_port: ep.internalPort,
          vm_internal_ip: ep.workspace.vmInternalIp,
          access_mode: ep.accessMode,
          subdomain: ep.publicSubdomain,
        });
        portsLoaded++;
      }
    }
    console.log(`[GATEWAY] Reconciled: ${portsLoaded} exposed port mappings loaded`);
  } catch (err) {
    console.warn(`[GATEWAY] Failed to reconcile exposed ports: ${(err as Error).message}`);
  }
}

// --- HMAC verification ---

function verifySignature(rawBody: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(rawBody).digest('hex');

  const sigBuffer = Buffer.from(signature, 'hex');
  const expectedBuffer = Buffer.from(expectedSignature, 'hex');

  if (sigBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
}

// --- Port allocation ---

function getUniquePort(): number {
  let attempts = 0;
  while (attempts < 1000) {
    const port = Math.floor(Math.random() * (PORT_RANGE_END - PORT_RANGE_START)) + PORT_RANGE_START;
    if (!allocatedPorts.has(port)) {
      allocatedPorts.add(port);
      return port;
    }
    attempts++;
  }
  throw new Error('Unable to allocate unique port - pool exhausted');
}

// --- Raw body capture for HMAC ---

fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
  (req as any).rawBody = body;
  try {
    done(null, JSON.parse(body as string));
  } catch (err) {
    done(err as Error, undefined);
  }
});

// --- Authentication middleware ---

fastify.addHook('preHandler', async (request: FastifyRequest, reply) => {
  if (request.raw.url?.startsWith('/health')) {
    return;
  }

  if (!serviceSecret && !isProduction) {
    return;
  }

  const signature = request.headers['x-gateway-signature'] as string;
  const rawBody = (request as any).rawBody as string;

  if (!signature) {
    return reply.status(401).send({ error: 'Missing signature' });
  }

  if (!serviceSecret) {
    return reply.status(500).send({ error: 'Server misconfigured' });
  }

  if (!verifySignature(rawBody, signature, serviceSecret)) {
    return reply.status(401).send({ error: 'Invalid signature' });
  }
});

// --- Routes ---

fastify.post('/internal/gateway/allocate', async (request, reply) => {
  const { workspace_id, vm_internal_ip } = allocateSchema.parse(request.body);

  // Idempotent: check cache first, then DB.
  const cached = activeAllocations.get(workspace_id);
  if (cached) {
    console.log(`[GATEWAY] Returning cached allocation for ${workspace_id}`);
    return {
      gateway_host: GATEWAY_HOST,
      ssh_port: cached.ssh,
      jupyter_port: cached.jupyter,
      vscode_port: cached.vscode,
    };
  }

  // Check DB for existing lease (cache may have been cleared on restart before reconcile ran for this workspace)
  const dbLease = await prisma.workspaceEndpoint.findUnique({
    where: { workspaceId: workspace_id },
  });
  if (dbLease && !dbLease.releasedAt) {
    // Rebuild cache entry
    activeAllocations.set(workspace_id, {
      ssh: dbLease.sshPort,
      jupyter: dbLease.jupyterPort,
      vscode: dbLease.vscodePort,
      ip: vm_internal_ip,
    });
    allocatedPorts.add(dbLease.sshPort);
    allocatedPorts.add(dbLease.jupyterPort);
    allocatedPorts.add(dbLease.vscodePort);
    console.log(`[GATEWAY] Returning DB allocation for ${workspace_id}`);
    return {
      gateway_host: GATEWAY_HOST,
      ssh_port: dbLease.sshPort,
      jupyter_port: dbLease.jupyterPort,
      vscode_port: dbLease.vscodePort,
    };
  }

  // Allocate new ports
  const ssh_port = getUniquePort();
  const jupyter_port = getUniquePort();
  const vscode_port = getUniquePort();

  console.log(`[GATEWAY] Allocating ports for ${workspace_id} (${vm_internal_ip}): SSH=${ssh_port}, Jupyter=${jupyter_port}, VSCode=${vscode_port}`);

  // Write to DB first (durable). If this fails, ports are freed from the Set.
  try {
    await prisma.workspaceEndpoint.upsert({
      where: { workspaceId: workspace_id },
      update: {
        gatewayHost: GATEWAY_HOST,
        sshPort: ssh_port,
        jupyterPort: jupyter_port,
        vscodePort: vscode_port,
        releasedAt: null,
        allocatedAt: new Date(),
      },
      create: {
        workspaceId: workspace_id,
        gatewayHost: GATEWAY_HOST,
        sshPort: ssh_port,
        jupyterPort: jupyter_port,
        vscodePort: vscode_port,
      },
    });
  } catch (err) {
    // Roll back in-memory allocation if DB write fails
    allocatedPorts.delete(ssh_port);
    allocatedPorts.delete(jupyter_port);
    allocatedPorts.delete(vscode_port);
    throw err;
  }

  // Update in-memory cache
  activeAllocations.set(workspace_id, {
    ssh: ssh_port,
    jupyter: jupyter_port,
    vscode: vscode_port,
    ip: vm_internal_ip,
  });

  // In production, configure iptables/nftables for port forwarding here.
  // NOT YET IMPLEMENTED — see docs/gateway-local-validation.md for current state.

  return {
    gateway_host: GATEWAY_HOST,
    ssh_port,
    jupyter_port,
    vscode_port,
  };
});

fastify.post('/internal/gateway/release', async (request, reply) => {
  const { workspace_id } = releaseSchema.parse(request.body);

  // Write to DB first (mark released). Idempotent — safe if already released or not found.
  const updated = await prisma.workspaceEndpoint.updateMany({
    where: { workspaceId: workspace_id, releasedAt: null },
    data: { releasedAt: new Date() },
  });

  // Update in-memory cache
  const alloc = activeAllocations.get(workspace_id);
  if (alloc) {
    console.log(`[GATEWAY] Releasing ports for ${workspace_id}: SSH=${alloc.ssh}, Jupyter=${alloc.jupyter}, VSCode=${alloc.vscode}`);

    // In production, remove iptables/nftables rules here.
    // NOT YET IMPLEMENTED.

    allocatedPorts.delete(alloc.ssh);
    allocatedPorts.delete(alloc.jupyter);
    allocatedPorts.delete(alloc.vscode);
    activeAllocations.delete(workspace_id);
  }

  return { ok: true, released: updated.count > 0 };
});

// --- Exposed Port Routes (Zero Trust Tunnels) ---

fastify.post('/internal/gateway/expose-port', async (request, reply) => {
  const { workspace_id, internal_port, subdomain, vm_internal_ip, access_mode } = exposePortSchema.parse(request.body);

  // SECURITY: Block SSRF — only allow proxying to workspace VM subnet
  if (!isAllowedProxyTarget(vm_internal_ip, internal_port)) {
    return reply.status(400).send({
      error: 'Invalid target',
      message: 'Target IP or port is not allowed',
    });
  }

  const mapping: ExposedPortMapping = {
    workspace_id,
    internal_port,
    vm_internal_ip,
    access_mode,
    subdomain,
  };

  // Store in memory
  exposedPortMappings.set(subdomain, mapping);

  // Persist to DB
  try {
    const publicUrl = `https://${subdomain}.aldaro.ai`;
    await prisma.exposedPort.upsert({
      where: { publicSubdomain: subdomain },
      update: { status: 'ACTIVE', releasedAt: null, accessMode: access_mode },
      create: {
        workspaceId: workspace_id,
        userId: '', // filled by API layer; gateway only stores routing
        internalPort: internal_port,
        publicSubdomain: subdomain,
        publicUrl,
        accessMode: access_mode,
      },
    });
  } catch (err) {
    // DB write is best-effort from gateway side; API is source of truth
    console.warn(`[GATEWAY] Failed to persist exposed port to DB: ${(err as Error).message}`);
  }

  const publicUrl = `https://${subdomain}.aldaro.ai`;
  console.log(`[GATEWAY] Exposed port ${internal_port} for workspace ${workspace_id} at ${publicUrl}`);

  return { ok: true, public_url: publicUrl, subdomain };
});

fastify.post('/internal/gateway/release-port', async (request, reply) => {
  const { subdomain } = releasePortSchema.parse(request.body);

  const mapping = exposedPortMappings.get(subdomain);
  if (mapping) {
    console.log(`[GATEWAY] Releasing exposed port ${mapping.internal_port} for workspace ${mapping.workspace_id} (${subdomain})`);
    exposedPortMappings.delete(subdomain);
  }

  // Mark released in DB
  try {
    await prisma.exposedPort.updateMany({
      where: { publicSubdomain: subdomain, releasedAt: null },
      data: { status: 'INACTIVE', releasedAt: new Date() },
    });
  } catch (err) {
    console.warn(`[GATEWAY] Failed to release exposed port in DB: ${(err as Error).message}`);
  }

  return { ok: true, released: !!mapping };
});

// --- Reverse Proxy for Exposed Ports ---

/**
 * Simple reverse proxy using Node.js http.request.
 * Forwards all headers, supports WebSocket upgrade for Gradio/Streamlit.
 * Adds X-Forwarded-For and X-Forwarded-Proto headers.
 */
function proxyRequest(
  targetHost: string,
  targetPort: number,
  req: FastifyRequest,
  reply: FastifyReply,
): void {
  const rawReq = req.raw;
  const url = rawReq.url || '/';

  const proxyReqOptions: http.RequestOptions = {
    hostname: targetHost,
    port: targetPort,
    path: url,
    method: rawReq.method,
    headers: {
      ...rawReq.headers,
      host: `${targetHost}:${targetPort}`,
      'x-forwarded-for': req.ip || rawReq.socket.remoteAddress || '',
      'x-forwarded-proto': 'https',
      'x-forwarded-host': rawReq.headers.host || '',
    },
    timeout: 30000,
  };

  const proxyReq = http.request(proxyReqOptions, (proxyRes) => {
    reply.raw.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
    proxyRes.pipe(reply.raw);
  });

  proxyReq.on('error', (err) => {
    console.error(`[GATEWAY] Proxy error: ${err.message}`);
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(502, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify({ error: 'Bad gateway', message: 'Failed to reach upstream service' }));
    }
  });

  // Pipe request body
  rawReq.pipe(proxyReq);
}

// Subdomain-based proxy route: GET/POST/PUT/DELETE /proxy/:subdomain/*
fastify.all('/proxy/:subdomain/*', async (request: any, reply) => {
  const { subdomain } = request.params;
  const mapping = exposedPortMappings.get(subdomain);

  if (!mapping) {
    return reply.status(404).send({ error: 'Not found', message: 'No service exposed at this subdomain' });
  }

  // For PRIVATE ports, verify JWT signature (not just presence)
  if (mapping.access_mode === 'PRIVATE') {
    const token = extractJwtFromRequest(
      request.headers.cookie as string | undefined,
      request.headers.authorization as string | undefined,
    );
    if (!token) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'This port requires Aldaro authentication' });
    }
    const { valid } = verifyJwt(token);
    if (!valid) {
      return reply.status(401).send({ error: 'Unauthorized', message: 'Invalid or expired authentication token' });
    }
  }

  // SECURITY: Defense-in-depth SSRF check at proxy time
  if (!isAllowedProxyTarget(mapping.vm_internal_ip, mapping.internal_port)) {
    return reply.status(403).send({ error: 'Forbidden', message: 'Target is blocked by security policy' });
  }

  // Proxy to the VM
  proxyRequest(mapping.vm_internal_ip, mapping.internal_port, request, reply);
  return reply;
});

// Handle WebSocket upgrade for exposed ports
fastify.server.on('upgrade', (req: http.IncomingMessage, socket: any, head: Buffer) => {
  // Extract subdomain from URL path: /proxy/:subdomain/...
  const match = req.url?.match(/^\/proxy\/([^/]+)/);
  if (!match) return; // Not an exposed port proxy request

  const subdomain = match[1];
  const mapping = exposedPortMappings.get(subdomain);
  if (!mapping) {
    socket.destroy();
    return;
  }

  // For PRIVATE ports, verify JWT signature on WebSocket upgrade
  if (mapping.access_mode === 'PRIVATE') {
    const token = extractJwtFromRequest(
      req.headers.cookie as string | undefined,
      req.headers.authorization as string | undefined,
    );
    if (!token) {
      console.warn(`[GATEWAY] WebSocket upgrade denied: no auth token for ${subdomain} from ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!verifyJwt(token).valid) {
      console.warn(`[GATEWAY] WebSocket upgrade denied: invalid/expired token for ${subdomain} from ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
  }

  // Create WebSocket proxy connection to upstream
  const proxyReq = http.request({
    hostname: mapping.vm_internal_ip,
    port: mapping.internal_port,
    path: req.url?.replace(`/proxy/${subdomain}`, '') || '/',
    method: 'GET',
    headers: {
      ...req.headers,
      host: `${mapping.vm_internal_ip}:${mapping.internal_port}`,
      'x-forwarded-for': req.socket.remoteAddress || '',
      'x-forwarded-proto': 'https',
    },
  });

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\n` +
      Object.entries(proxyRes.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join('\r\n') +
      '\r\n\r\n',
    );
    if (proxyHead.length > 0) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on('error', () => socket.destroy());
    socket.on('error', () => proxySocket.destroy());
  });

  proxyReq.on('error', () => {
    socket.destroy();
  });

  proxyReq.end();
});

// Health check (no auth)
fastify.get('/health', async () => {
  return {
    status: 'OK',
    allocations: activeAllocations.size,
    portsUsed: allocatedPorts.size,
    exposedPorts: exposedPortMappings.size,
  };
});

// --- Start ---

// --- Process-level crash discipline ---
process.on('unhandledRejection', (reason: any) => {
  console.error(JSON.stringify({
    level: 'fatal',
    service: 'gateway',
    pid: process.pid,
    timestamp: new Date().toISOString(),
    event: 'unhandled_rejection',
    error: reason?.message || String(reason),
    ...(process.env.NODE_ENV !== 'production' && { stack: reason?.stack }),
  }));
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  console.error(JSON.stringify({
    level: 'fatal',
    service: 'gateway',
    pid: process.pid,
    timestamp: new Date().toISOString(),
    event: 'uncaught_exception',
    error: err.message,
    ...(process.env.NODE_ENV !== 'production' && { stack: err.stack }),
  }));
  process.exit(1);
});

const start = async () => {
  try {
    // Reconcile leases from DB before accepting traffic
    if (process.env.DATABASE_URL) {
      await reconcileLeases();
    } else if (isProduction || process.env.NODE_ENV === 'staging') {
      console.error('FATAL: DATABASE_URL is required in production/staging — ephemeral mode is not safe');
      process.exit(1);
    } else {
      console.warn('[GATEWAY] No DATABASE_URL — running in ephemeral mode (no lease persistence). This is only safe for local development.');
    }

    const port = parseInt(process.env.GATEWAY_PORT || '5001');
    await fastify.listen({ port, host: '0.0.0.0' });
    const protocol = httpsOptions ? 'HTTPS' : 'HTTP';
    console.log(`Gateway listening on ${protocol} port ${port}`);

    // If using direct TLS, watch cert files for renewal and reload
    if (TLS_CERT_PATH && TLS_KEY_PATH && httpsOptions) {
      const TLS_RELOAD_INTERVAL_MS = parseInt(process.env.TLS_RELOAD_INTERVAL_MS || String(6 * 60 * 60 * 1000)); // 6 hours
      setInterval(() => {
        try {
          const newKey = fs.readFileSync(TLS_KEY_PATH);
          const newCert = fs.readFileSync(TLS_CERT_PATH);
          const server = fastify.server as https.Server;
          server.setSecureContext({ key: newKey, cert: newCert });
          console.log('[GATEWAY] TLS certificates reloaded');
        } catch (err) {
          console.error(`[GATEWAY] Failed to reload TLS certificates: ${(err as Error).message}`);
        }
      }, TLS_RELOAD_INTERVAL_MS);
    }
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

export { fastify, prisma, activeAllocations, allocatedPorts, exposedPortMappings, reconcileLeases };
