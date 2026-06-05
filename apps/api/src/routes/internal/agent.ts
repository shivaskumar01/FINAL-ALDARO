import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { z } from 'zod';
import { deriveWorkspaceAgentSecret } from '@aldaro/shared';
import { setIfAbsentWithTtl } from '../../lib/ephemeralStore';

// Workspace states from which an agent callback must NOT revive the workspace.
const TERMINAL_WORKSPACE_STATES = new Set(['TERMINATED', 'TERMINATING', 'FAILED']);

/**
 * Internal Agent API
 * 
 * SECURITY MODEL:
 * - HMAC-SHA256 signature of raw request body (not JSON.stringify)
 * - Timing-safe comparison to prevent timing attacks
 * - Nonce + timestamp for replay protection
 * - Agent shared secret from environment (fail fast if missing in production)
 */

const prisma = new PrismaClient();

// A14: nonce replay cache moved to the shared ephemeral store (Redis when REDIS_URL is
// set, else in-memory). A per-instance Map was replay-bypassable across API replicas — an
// attacker could replay a captured agent callback against a different replica.
// Nonce TTL matches MAX_TIMESTAMP_DRIFT_MS: payloads older than 60s are already rejected
// by the timestamp check, so nonces only need to live that long.
const NONCE_TTL_MS = 60 * 1000; // 60 seconds
const MAX_TIMESTAMP_DRIFT_MS = 60 * 1000; // 1 minute

const verifyResultSchema = z.object({
  workspace_id: z.string().uuid(),
  result: z.object({
    pass: z.boolean(),
    score_0_100: z.number(),
    gpu_name: z.string().optional(),
    vram_gb: z.number().optional(),
    cuda_version: z.string().optional(),
    driver_version: z.string().optional(),
    disk_read_mb_s: z.number().optional(),
    disk_write_mb_s: z.number().optional(),
    net_down_mbps: z.number().optional(),
    net_up_mbps: z.number().optional(),
    micro_train_seconds: z.number().optional(),
    torch_matmul_seconds: z.number().optional(),
  }),
  raw_log: z.string().optional(),
  // Replay protection
  nonce: z.string().optional(),
  timestamp: z.number().optional(),
});

const heartbeatSchema = z.object({
  workspace_id: z.string().uuid(),
  // GPU metrics
  gpu_utilization_pct: z.number().optional(),
  gpu_memory_used_mb: z.number().optional(),
  gpu_temperature_c: z.number().optional(),
  gpu_ecc_errors: z.number().optional(),
  // CPU metrics  
  cpu_pct: z.number().optional(),
  memory_used_mb: z.number().optional(),
  disk_used_mb: z.number().optional(),
  // Network
  network_rx_mb: z.number().optional(),
  network_tx_mb: z.number().optional(),
  // Agent info
  agent_version: z.string().optional(),
  driver_version: z.string().optional(),
  cuda_version: z.string().optional(),
  // Replay protection
  nonce: z.string().optional(),
  timestamp: z.number().optional(),
});

function timingSafeEqual(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'hex');
  const bBuffer = Buffer.from(b, 'hex');
  
  if (aBuffer.length !== bBuffer.length) {
    return false;
  }
  
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function validateSignature(rawBody: string, signature: string, secret: string): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  const expectedSignature = hmac.update(rawBody).digest('hex');
  
  return timingSafeEqual(signature, expectedSignature);
}

async function checkReplayProtection(nonce: string | undefined, timestamp: number | undefined): Promise<{ valid: boolean; error?: string }> {
  // Skip replay check in development if no nonce provided
  if (process.env.NODE_ENV === 'development' && !nonce) {
    return { valid: true };
  }

  if (!nonce || !timestamp) {
    return { valid: false, error: 'Missing nonce or timestamp' };
  }

  // Check timestamp drift
  const now = Date.now();
  if (Math.abs(now - timestamp) > MAX_TIMESTAMP_DRIFT_MS) {
    return { valid: false, error: 'Timestamp too old or in future' };
  }

  // Atomic check-and-set: false => the nonce was already used (replay).
  const fresh = await setIfAbsentWithTtl(`agent:nonce:${nonce}`, '1', Math.ceil(NONCE_TTL_MS / 1000));
  if (!fresh) {
    return { valid: false, error: 'Nonce already used (replay attack)' };
  }

  return { valid: true };
}

export const internalAgentRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // Validate secret on startup
  const secret = process.env.ALDARO_AGENT_SHARED_SECRET;
  if (!secret && process.env.NODE_ENV !== 'development') {
    throw new Error('ALDARO_AGENT_SHARED_SECRET is required in production');
  }

  // Capture raw body for HMAC verification
  fastify.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // A3 FIX: accept the legacy global-secret signature only when explicitly allowed.
  // Defaults to allowed in non-production (local/dev convenience) and DENIED in production,
  // so a real fleet must use per-workspace secrets. Set ALLOW_LEGACY_AGENT_SECRET=true to
  // bridge a migration window.
  const allowLegacyAgentSecret =
    process.env.ALLOW_LEGACY_AGENT_SECRET === 'true' ||
    (process.env.ALLOW_LEGACY_AGENT_SECRET == null && process.env.NODE_ENV !== 'production');

  // HMAC middleware for internal endpoints
  fastify.addHook('preHandler', async (request: FastifyRequest, reply) => {
    const signature = request.headers['x-aldaro-signature'] as string;
    const rawBody = (request as any).rawBody as string;

    if (!signature) {
      return reply.status(401).send({ error: 'Missing signature' });
    }

    if (!secret) {
      return reply.status(500).send({ error: 'Server misconfigured' });
    }

    const body = request.body as { workspace_id?: string; nonce?: string; timestamp?: number };

    // A3 FIX: bind the signature to the specific workspace. The agent signs with a
    // per-workspace secret derived from the global secret (injected at provision time),
    // and we recompute it here. This prevents a customer with root on their own VM from
    // forging callbacks for any other workspace_id.
    const workspaceId = typeof body?.workspace_id === 'string' ? body.workspace_id : null;
    if (!workspaceId) {
      return reply.status(400).send({ error: 'Missing workspace_id' });
    }

    const perWorkspaceSecret = deriveWorkspaceAgentSecret(secret, workspaceId);
    const validPerWorkspace = validateSignature(rawBody, signature, perWorkspaceSecret);
    const validLegacy =
      !validPerWorkspace && allowLegacyAgentSecret && validateSignature(rawBody, signature, secret);

    if (!validPerWorkspace && !validLegacy) {
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    // Replay protection
    const replayCheck = await checkReplayProtection(body.nonce, body.timestamp);
    if (!replayCheck.valid) {
      return reply.status(401).send({ error: replayCheck.error });
    }
  });

  fastify.post('/verify-result', async (request, reply) => {
    const { workspace_id, result, raw_log } = verifyResultSchema.parse(request.body);

    const workspace = await prisma.workspace.findUnique({ where: { id: workspace_id } });
    if (!workspace) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    await prisma.workspaceVerification.create({
      data: {
        workspaceId: workspace_id,
        pass: result.pass,
        score0100: result.score_0_100,
        gpuName: result.gpu_name,
        vramGb: result.vram_gb,
        cudaVersion: result.cuda_version,
        driverVersion: result.driver_version,
        diskReadMbS: result.disk_read_mb_s,
        diskWriteMbS: result.disk_write_mb_s,
        netDownMbps: result.net_down_mbps,
        netUpMbps: result.net_up_mbps,
        microTrainSeconds: result.micro_train_seconds,
        rawLog: raw_log,
      },
    });

    // A17 FIX: keep the verification record for audit, but never revive a workspace
    // that is already terminating/terminated/failed (a late or forged result must not
    // flip it back to RUNNING_ASSIGNED/WARM_AVAILABLE).
    if (TERMINAL_WORKSPACE_STATES.has(workspace.status)) {
      return { ok: true, ignored: 'workspace_terminal' };
    }

    if (result.pass) {
      await prisma.workspace.update({
        where: { id: workspace_id },
        data: {
          verificationStatus: 'PASS',
          verificationScore: result.score_0_100,
          status: workspace.isWarmPool ? 'WARM_AVAILABLE' : 'RUNNING_ASSIGNED',
        },
      });
    } else {
      await prisma.workspace.update({
        where: { id: workspace_id },
        data: {
          verificationStatus: 'FAIL',
          verificationScore: result.score_0_100,
          status: 'FAILED',
        },
      });
      // Worker will handle cleanup of FAILED workspaces
    }

    return { ok: true };
  });

  fastify.post('/heartbeat', async (request, reply) => {
    const heartbeat = heartbeatSchema.parse(request.body);
    const { workspace_id } = heartbeat;

    const workspace = await prisma.workspace.findUnique({ 
      where: { id: workspace_id },
      include: { gpuAllocation: true },
    });
    if (!workspace) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    // A17 FIX: ignore heartbeats for terminal workspaces so a (possibly forged) agent
    // cannot keep a terminated/idle workspace looking alive or refresh its metrics.
    if (TERMINAL_WORKSPACE_STATES.has(workspace.status)) {
      return { ok: true, ignored: 'workspace_terminal' };
    }

    const now = new Date();

    // Build update data
    const updateData: any = {
      lastAgentHeartbeatAt: now,
      lastHealthCheckAt: now,
    };

    // GPU metrics
    if (heartbeat.gpu_utilization_pct !== undefined) {
      updateData.lastGpuUtilizationPct = heartbeat.gpu_utilization_pct;
    }
    if (heartbeat.gpu_memory_used_mb !== undefined) {
      updateData.lastGpuMemUsedMb = heartbeat.gpu_memory_used_mb;
    }
    if (heartbeat.gpu_temperature_c !== undefined) {
      updateData.lastGpuTempC = heartbeat.gpu_temperature_c;
    }

    // CPU/Memory metrics
    if (heartbeat.cpu_pct !== undefined) {
      updateData.lastCpuPct = heartbeat.cpu_pct;
    }
    if (heartbeat.memory_used_mb !== undefined) {
      updateData.lastMemUsedMb = heartbeat.memory_used_mb;
    }
    if (heartbeat.disk_used_mb !== undefined) {
      updateData.lastDiskUsedMb = heartbeat.disk_used_mb;
    }

    // Network
    if (heartbeat.network_rx_mb !== undefined) {
      updateData.lastNetworkRxMb = heartbeat.network_rx_mb;
    }
    if (heartbeat.network_tx_mb !== undefined) {
      updateData.lastNetworkTxMb = heartbeat.network_tx_mb;
    }

    // TELEMETRY: First heartbeat marks agent as registered
    if (!workspace.agentRegisteredAt) {
      updateData.agentRegisteredAt = now;
    }

    await prisma.workspace.update({
      where: { id: workspace_id },
      data: updateData,
    });

    // Also update GPU metrics if allocation exists
    if (workspace.gpuAllocation) {
      const gpuUpdateData: any = {
        lastSeenAt: now,
      };
      
      if (heartbeat.gpu_temperature_c !== undefined) {
        gpuUpdateData.lastTempC = heartbeat.gpu_temperature_c;
      }
      if (heartbeat.gpu_utilization_pct !== undefined) {
        gpuUpdateData.lastUtilPct = heartbeat.gpu_utilization_pct;
      }
      if (heartbeat.gpu_memory_used_mb !== undefined) {
        gpuUpdateData.lastMemUsedMb = heartbeat.gpu_memory_used_mb;
      }
      // Track ECC errors (increment if new errors detected)
      if (heartbeat.gpu_ecc_errors !== undefined && heartbeat.gpu_ecc_errors > 0) {
        gpuUpdateData.eccErrors24h = { increment: heartbeat.gpu_ecc_errors };
        gpuUpdateData.lastEccErrorAt = now;
      }

      await prisma.fleetGpu.update({
        where: { id: workspace.gpuAllocation.gpuId },
        data: gpuUpdateData,
      });
    }

    return { ok: true };
  });
};
