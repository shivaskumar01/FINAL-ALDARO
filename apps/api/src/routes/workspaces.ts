import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { workspaceService } from '../services/workspaceService';
import { isSupportedCustomerGpu } from '../lib/supportedGpus';
import crypto from 'crypto';

const prisma = new PrismaClient();

const launchSchema = z.object({
  gpu_type: z.string().optional(),
  gpu_key: z.string().optional(),
  region: z.string().default('US'),
  intent: z.string().optional(),
  idempotency_key: z.string().optional(),
  max_duration_minutes: z.number().int().min(15).max(43200).nullable().optional(),
}).refine((body) => !!(body.gpu_type || body.gpu_key), {
  message: 'gpu_type is required',
});

export const workspaceRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireCustomerApproved as any);

  fastify.get('/', async (request: any) => {
    const userId = request.user.userId;
    return prisma.workspace.findMany({
      where: { assignedUserId: userId },
      orderBy: { createdAt: 'desc' },
    });
  });

  fastify.post('/launch', async (request: any, reply) => {
    const userId = request.user.userId;
    const { gpu_type, gpu_key, region, intent, idempotency_key, max_duration_minutes } = launchSchema.parse(request.body);
    const normalizedGpuType = gpu_type || gpu_key!;
    if (!isSupportedCustomerGpu(normalizedGpuType)) {
      return reply.status(400).send({
        errorCode: 'UNSUPPORTED_GPU',
        message: 'Unsupported GPU type.',
        error: 'Unsupported GPU type.',
        requestId: request.id,
      });
    }

    const operationKey = idempotency_key || intent;
    if (!operationKey) {
      return reply.status(400).send({
        errorCode: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'idempotency_key (or intent) is required.',
        error: 'idempotency_key (or intent) is required.',
        requestId: request.id,
      });
    }

    try {
      const requestHash = crypto
        .createHash('sha256')
        .update(JSON.stringify({ userId, gpuType: normalizedGpuType, region, operationKey }))
        .digest('hex');

      const launchResult = await workspaceService.launch(
        userId,
        normalizedGpuType,
        region,
        operationKey,
        requestHash,
        max_duration_minutes ?? undefined,
      );
      return {
        workspace_id: launchResult.workspace.id,
        status: launchResult.workspace.status,
        redirect_to: `/app/workspace/${launchResult.workspace.id}`,
        operationKey: launchResult.operationKey,
        idempotentReplay: launchResult.idempotentReplay,
      };
    } catch (err: any) {
      if (err.message === 'MAX_WORKSPACES_REACHED') {
        return reply.status(429).send({
          errorCode: 'MAX_WORKSPACES_REACHED',
          message: 'Maximum active workspaces reached',
          error: 'Maximum active workspaces reached',
          requestId: request.id,
        });
      }
      if (err.message === 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST') {
        return reply.status(409).send({
          errorCode: 'IDEMPOTENCY_KEY_CONFLICT',
          message: 'idempotency_key was already used with a different launch payload.',
          error: 'idempotency_key was already used with a different launch payload.',
          requestId: request.id,
        });
      }
      if (err.message === 'OPERATION_IN_PROGRESS') {
        return reply.status(202).send({
          status: 'PROCESSING',
          operationKey,
          idempotentReplay: true,
          requestId: request.id,
        });
      }
      throw err;
    }
  });

  fastify.get('/:id', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const { id } = request.params;
    const workspace = await prisma.workspace.findFirst({
      where: { id, assignedUserId: userId },
    });
    if (!workspace) {
      return reply.status(404).send({
        errorCode: 'WORKSPACE_NOT_FOUND',
        message: 'Workspace not found',
        error: 'Workspace not found',
        requestId: request.id,
      });
    }
    return workspace;
  });

  fastify.post('/:id/terminate', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const { id } = request.params;
    try {
      const termination = await workspaceService.terminate(id, userId);
      return reply.status(202).send({
        ok: true,
        workspace_id: id,
        status: termination.status,
        queued: termination.queued,
        alreadyFinal: termination.alreadyFinal,
      });
    } catch (err: any) {
      if (err.message === 'WORKSPACE_NOT_FOUND') {
        return reply.status(404).send({
          errorCode: 'WORKSPACE_NOT_FOUND',
          message: 'Workspace not found',
          error: 'Workspace not found',
          requestId: request.id,
        });
      }
      throw err;
    }
  });
};
