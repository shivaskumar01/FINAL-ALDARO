import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

const verifySignature = (body: string, signature: string, secret: string) => {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(body);
  const expectedSignature = hmac.digest('hex');
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
};

export const internalAgentRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', async (request, reply) => {
    const signature = request.headers['x-aldaro-signature'] as string;
    const secret = process.env.ALDARO_AGENT_SHARED_SECRET || '';

    if (!signature || !verifySignature(JSON.stringify(request.body), signature, secret)) {
      return reply.status(401).send({ error: 'Unauthorized signature' });
    }
  });

  fastify.post('/verify-result', async (request: any, reply) => {
    const { workspace_id, verification, raw_log } = request.body;

    const ws = await prisma.workspace.findUnique({
      where: { id: workspace_id },
    });

    if (!ws) {
      return reply.status(404).send({ error: 'Workspace not found' });
    }

    await prisma.workspaceVerification.create({
      data: {
        workspaceId: workspace_id,
        gpuName: verification.gpu_name,
        vramGb: verification.vram_gb,
        cudaVersion: verification.cuda_version,
        driverVersion: verification.driver_version,
        diskReadMbS: verification.disk_read_mb_s,
        diskWriteMbS: verification.disk_write_mb_s,
        netDownMbps: verification.net_down_mbps,
        netUpMbps: verification.net_up_mbps,
        microTrainSeconds: verification.micro_train_seconds,
        score0100: verification.score_0_100,
        pass: verification.pass,
        rawLog: raw_log,
      },
    });

    const vStatus = verification.pass ? 'PASS' : 'FAIL';
    
    if (vStatus === 'FAIL') {
      await prisma.workspace.update({
        where: { id: workspace_id },
        data: {
          verificationStatus: 'FAIL',
          status: 'FAILED',
        },
      });
      // In production, trigger immediate termination
      return reply.send({ ok: true });
    }

    // Pass logic
    if (ws.isWarmPool && !ws.assignedUserId) {
      await prisma.workspace.update({
        where: { id: workspace_id },
        data: {
          verificationStatus: 'PASS',
          verificationScore: verification.score_0_100,
          status: 'WARM_AVAILABLE',
        },
      });
    } else if (ws.assignedUserId) {
      // User was waiting
      await prisma.workspace.update({
        where: { id: workspace_id },
        data: {
          verificationStatus: 'PASS',
          verificationScore: verification.score_0_100,
          status: 'ASSIGNING',
        },
      });

      // Start usage session
      await prisma.usageSession.create({
        data: {
          userId: ws.assignedUserId,
          workspaceId: ws.id,
          startTime: new Date(),
          status: 'RUNNING',
          pricePerHourCents: 120, // lookup
        },
      });

      await prisma.workspace.update({
        where: { id: ws.id },
        data: { status: 'RUNNING_ASSIGNED' },
      });
    }

    return reply.send({ ok: true });
  });

  fastify.post('/heartbeat', async (request: any, reply) => {
    const { workspace_id, gpu_utilization_pct, network_rx_mb, network_tx_mb } = request.body;

    await prisma.workspace.update({
      where: { id: workspace_id },
      data: {
        lastAgentHeartbeatAt: new Date(),
        lastGpuUtilizationPct: gpu_utilization_pct,
        lastNetworkRxMb: network_rx_mb,
        lastNetworkTxMb: network_tx_mb,
      },
    });

    return reply.send({ ok: true });
  });
};
