import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { workspaceService } from '../services/workspaceService';
import { isSupportedCustomerGpu } from '../lib/supportedGpus';
import crypto from 'crypto';

const prisma = new PrismaClient();

// Allowlist of trusted container registries. Images without a registry prefix
// are assumed to be Docker Hub (docker.io). Add internal registries as needed.
const ALLOWED_REGISTRIES = new Set([
  'docker.io',
  'ghcr.io',
  'nvcr.io',           // NVIDIA NGC
  'registry.aldaro.ai', // Aldaro internal
]);

function isAllowedImage(image: string): boolean {
  // Strip tag/digest
  const ref = image.split('@')[0].split(':')[0];
  const parts = ref.split('/');
  // "ubuntu" or "library/ubuntu" → Docker Hub (allowed)
  if (parts.length <= 2 && !parts[0].includes('.')) {
    return ALLOWED_REGISTRIES.has('docker.io');
  }
  // "ghcr.io/owner/repo" → registry is first segment
  const registry = parts[0].toLowerCase();
  return ALLOWED_REGISTRIES.has(registry);
}

const launchSchema = z.object({
  gpu_type: z.string().optional(),
  gpu_key: z.string().optional(),
  region: z.string().default('US'),
  intent: z.string().optional(),
  idempotency_key: z.string().optional(),
  max_duration_minutes: z.number().int().min(15).max(43200).nullable().optional(),
  custom_image: z.string().max(512).optional(),
  registry_credential_id: z.string().uuid().optional(),
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

  fastify.post('/launch', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
        keyGenerator: (request: any) => request.user?.userId || request.ip,
      },
    },
  }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { gpu_type, gpu_key, region, intent, idempotency_key, max_duration_minutes, custom_image, registry_credential_id } = launchSchema.parse(request.body);
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

    if (custom_image && !isAllowedImage(custom_image)) {
      return reply.status(400).send({
        errorCode: 'UNTRUSTED_REGISTRY',
        message: 'Custom image must be from an approved container registry.',
        error: 'Custom image must be from an approved container registry.',
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
        custom_image,
        registry_credential_id,
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

  // ---------------------------------------------------------------------------
  // Port Exposure — Zero Trust Tunnels
  // ---------------------------------------------------------------------------

  const exposePortSchema = z.object({
    port: z.number().int().min(1).max(65535),
    access_mode: z.enum(['PUBLIC', 'PRIVATE']).default('PRIVATE'),
  });

  const updatePortSchema = z.object({
    access_mode: z.enum(['PUBLIC', 'PRIVATE']),
  });

  // POST /:id/ports — Expose a port
  fastify.post('/:id/ports', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const { id } = request.params;
    const { port, access_mode } = exposePortSchema.parse(request.body);

    // Validate workspace belongs to user and is RUNNING_ASSIGNED
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
    if (workspace.status !== 'RUNNING_ASSIGNED') {
      return reply.status(400).send({
        errorCode: 'WORKSPACE_NOT_RUNNING',
        message: 'Workspace must be running to expose ports',
        error: 'Workspace must be running to expose ports',
        requestId: request.id,
      });
    }

    // Check if port is already exposed
    const existing = await prisma.exposedPort.findUnique({
      where: { workspaceId_internalPort: { workspaceId: id, internalPort: port } },
    });
    if (existing && existing.status === 'ACTIVE') {
      return reply.status(409).send({
        errorCode: 'PORT_ALREADY_EXPOSED',
        message: `Port ${port} is already exposed`,
        error: `Port ${port} is already exposed`,
        requestId: request.id,
      });
    }

    const subdomain = `ws-${workspace.id.slice(0, 8)}-${port}`;
    const publicUrl = `https://${subdomain}.aldaro.ai`;

    // If previously released, reactivate; otherwise create new
    let exposedPort;
    if (existing) {
      exposedPort = await prisma.exposedPort.update({
        where: { id: existing.id },
        data: { accessMode: access_mode, status: 'ACTIVE', releasedAt: null, publicSubdomain: subdomain, publicUrl },
      });
    } else {
      exposedPort = await prisma.exposedPort.create({
        data: {
          workspaceId: id,
          userId,
          internalPort: port,
          publicSubdomain: subdomain,
          publicUrl,
          accessMode: access_mode,
        },
      });
    }

    return {
      id: exposedPort.id,
      public_url: exposedPort.publicUrl,
      subdomain: exposedPort.publicSubdomain,
      port: exposedPort.internalPort,
      access_mode: exposedPort.accessMode,
    };
  });

  // GET /:id/ports — List exposed ports for workspace
  fastify.get('/:id/ports', async (request: any, reply: any) => {
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

    const ports = await prisma.exposedPort.findMany({
      where: { workspaceId: id, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });

    return ports.map((p: any) => ({
      id: p.id,
      port: p.internalPort,
      public_url: p.publicUrl,
      subdomain: p.publicSubdomain,
      access_mode: p.accessMode,
      protocol: p.protocol,
      status: p.status,
      created_at: p.createdAt,
    }));
  });

  // DELETE /:id/ports/:portId — Release exposed port
  fastify.delete('/:id/ports/:portId', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const { id, portId } = request.params;

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

    const port = await prisma.exposedPort.findFirst({
      where: { id: portId, workspaceId: id },
    });
    if (!port) {
      return reply.status(404).send({
        errorCode: 'PORT_NOT_FOUND',
        message: 'Exposed port not found',
        error: 'Exposed port not found',
        requestId: request.id,
      });
    }

    await prisma.exposedPort.update({
      where: { id: portId },
      data: { status: 'INACTIVE', releasedAt: new Date() },
    });

    return { ok: true };
  });

  // PUT /:id/ports/:portId — Update access mode
  fastify.put('/:id/ports/:portId', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const { id, portId } = request.params;
    const { access_mode } = updatePortSchema.parse(request.body);

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

    const port = await prisma.exposedPort.findFirst({
      where: { id: portId, workspaceId: id, status: 'ACTIVE' },
    });
    if (!port) {
      return reply.status(404).send({
        errorCode: 'PORT_NOT_FOUND',
        message: 'Exposed port not found',
        error: 'Exposed port not found',
        requestId: request.id,
      });
    }

    const updated = await prisma.exposedPort.update({
      where: { id: portId },
      data: { accessMode: access_mode },
    });

    return {
      id: updated.id,
      port: updated.internalPort,
      public_url: updated.publicUrl,
      subdomain: updated.publicSubdomain,
      access_mode: updated.accessMode,
    };
  });
};
