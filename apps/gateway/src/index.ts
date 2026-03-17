import Fastify, { FastifyRequest } from 'fastify';
import crypto from 'crypto';
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

// Validate required config
const serviceSecret = process.env.GATEWAY_SERVICE_SECRET;
if (!serviceSecret && isProduction) {
  console.error('FATAL: GATEWAY_SERVICE_SECRET is required in production');
  process.exit(1);
}

const prisma = new PrismaClient();
const fastify = Fastify({ logger: true });

const PORT_RANGE_START = 20000;
const PORT_RANGE_END = 40000;
const GATEWAY_HOST = process.env.GATEWAY_HOST || 'gw1.aldaro.ai';

// In-memory cache — rebuilt from DB on startup and kept in sync via allocate/release.
const activeAllocations = new Map<string, { ssh: number; jupyter: number; vscode: number; ip: string }>();
const allocatedPorts = new Set<number>();

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

// Health check (no auth)
fastify.get('/health', async () => {
  return {
    status: 'OK',
    allocations: activeAllocations.size,
    portsUsed: allocatedPorts.size,
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
    stack: reason?.stack,
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
    stack: err.stack,
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
    console.log(`Gateway listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

export { fastify, prisma, activeAllocations, allocatedPorts, reconcileLeases };
