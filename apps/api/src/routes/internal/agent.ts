import { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import { z } from 'zod';

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

// In-memory nonce cache (in production, use Redis with TTL)
const usedNonces = new Map<string, number>();
const NONCE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const MAX_TIMESTAMP_DRIFT_MS = 60 * 1000; // 1 minute

// Cleanup old nonces periodically
setInterval(() => {
  const now = Date.now();
  for (const [nonce, timestamp] of usedNonces) {
    if (now - timestamp > NONCE_TTL_MS) {
      usedNonces.delete(nonce);
    }
  }
}, 60 * 1000);

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

function checkReplayProtection(nonce: string | undefined, timestamp: number | undefined): { valid: boolean; error?: string } {
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

  // Check nonce uniqueness
  if (usedNonces.has(nonce)) {
    return { valid: false, error: 'Nonce already used (replay attack)' };
  }

  // Store nonce
  usedNonces.set(nonce, timestamp);

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

  // HMAC middleware for internal endpoints
  fastify.addHook('preHandler', async (request: FastifyRequest, reply) => {
    const signature = request.headers['x-aldaro-signature'] as string;
    const agentId = request.headers['x-aldaro-agent-id'] as string;
    const rawBody = (request as any).rawBody as string;

    // In development, allow bypassing signature check
    if (process.env.NODE_ENV === 'development' && !signature) {
      return;
    }

    if (!signature) {
      return reply.status(401).send({ error: 'Missing signature' });
    }

    if (!secret) {
      // Development fallback
      if (process.env.NODE_ENV === 'development') {
        return;
      }
      return reply.status(500).send({ error: 'Server misconfigured' });
    }

    // Validate HMAC with timing-safe comparison
    if (!validateSignature(rawBody, signature, secret)) {
      return reply.status(401).send({ error: 'Invalid signature' });
    }

    // Replay protection
    const body = request.body as { nonce?: string; timestamp?: number };
    const replayCheck = checkReplayProtection(body.nonce, body.timestamp);
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
