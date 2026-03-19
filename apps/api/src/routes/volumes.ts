import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

const ALLOWED_SIZES_GB = [50, 100, 250, 500, 1000];

const createVolumeSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'Invalid volume name'),
  sizeGb: z.number().int().refine(v => ALLOWED_SIZES_GB.includes(v), {
    message: `sizeGb must be one of: ${ALLOWED_SIZES_GB.join(', ')}`,
  }),
});

const renameVolumeSchema = z.object({
  name: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9 _-]*$/, 'Invalid volume name'),
});

const attachVolumeSchema = z.object({
  workspaceId: z.string().uuid(),
});

export const volumeRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireCustomerApproved as any);

  // POST /volumes — Create a new persistent volume
  fastify.post('/', async (request: any, reply) => {
    const userId = request.user.userId;
    const { name, sizeGb } = createVolumeSchema.parse(request.body);

    // Limit volumes per user (max 10)
    const existing = await prisma.persistentVolume.count({
      where: { userId, status: { notIn: ['DELETED'] } },
    });
    if (existing >= 10) {
      return reply.status(429).send({
        errorCode: 'MAX_VOLUMES_REACHED',
        message: 'Maximum of 10 persistent volumes per account.',
        error: 'Maximum of 10 persistent volumes per account.',
        requestId: request.id,
      });
    }

    const volume = await prisma.persistentVolume.create({
      data: {
        userId,
        name,
        sizeGb,
        status: 'CREATING',
      },
    });

    return reply.status(201).send(volume);
  });

  // GET /volumes — List user's volumes
  fastify.get('/', async (request: any) => {
    const userId = request.user.userId;
    const query = request.query as any;
    const statusFilter = query.status;

    const where: any = {
      userId,
      status: { notIn: ['DELETED'] },
    };
    if (statusFilter) {
      where.status = statusFilter;
    }

    const volumes = await prisma.persistentVolume.findMany({
      where,
      include: {
        attachedWorkspace: {
          select: {
            id: true,
            status: true,
            gpuType: true,
            region: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return volumes;
  });

  // GET /volumes/:id — Volume detail
  fastify.get('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };

    const volume = await prisma.persistentVolume.findFirst({
      where: { id, userId },
      include: {
        attachedWorkspace: {
          select: {
            id: true,
            status: true,
            gpuType: true,
            region: true,
            assignedAt: true,
          },
        },
      },
    });

    if (!volume) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Volume not found.',
        error: 'Volume not found.',
        requestId: request.id,
      });
    }

    return volume;
  });

  // POST /volumes/:id/attach — Attach volume to a workspace
  fastify.post('/:id/attach', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };
    const { workspaceId } = attachVolumeSchema.parse(request.body);

    const volume = await prisma.persistentVolume.findFirst({
      where: { id, userId },
    });

    if (!volume) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Volume not found.',
        error: 'Volume not found.',
        requestId: request.id,
      });
    }

    if (volume.status !== 'AVAILABLE') {
      return reply.status(400).send({
        errorCode: 'VOLUME_NOT_AVAILABLE',
        message: `Volume is ${volume.status}, must be AVAILABLE to attach.`,
        error: `Volume is ${volume.status}, must be AVAILABLE to attach.`,
        requestId: request.id,
      });
    }

    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, assignedUserId: userId },
    });

    if (!workspace) {
      return reply.status(404).send({
        errorCode: 'WORKSPACE_NOT_FOUND',
        message: 'Workspace not found.',
        error: 'Workspace not found.',
        requestId: request.id,
      });
    }

    if (workspace.status !== 'RUNNING_ASSIGNED') {
      return reply.status(400).send({
        errorCode: 'WORKSPACE_NOT_RUNNING',
        message: 'Workspace must be RUNNING_ASSIGNED to attach a volume.',
        error: 'Workspace must be RUNNING_ASSIGNED to attach a volume.',
        requestId: request.id,
      });
    }

    // Check workspace doesn't already have a volume
    const existingAttachment = await prisma.persistentVolume.findFirst({
      where: { attachedToWorkspaceId: workspaceId },
    });
    if (existingAttachment) {
      return reply.status(409).send({
        errorCode: 'WORKSPACE_VOLUME_EXISTS',
        message: 'Workspace already has a volume attached.',
        error: 'Workspace already has a volume attached.',
        requestId: request.id,
      });
    }

    const updated = await prisma.persistentVolume.update({
      where: { id },
      data: {
        status: 'IN_USE',
        attachedToWorkspaceId: workspaceId,
        lastAttachedAt: new Date(),
      },
      include: {
        attachedWorkspace: {
          select: { id: true, status: true, gpuType: true, region: true },
        },
      },
    });

    return updated;
  });

  // POST /volumes/:id/detach — Detach volume from workspace
  fastify.post('/:id/detach', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };

    const volume = await prisma.persistentVolume.findFirst({
      where: { id, userId },
    });

    if (!volume) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Volume not found.',
        error: 'Volume not found.',
        requestId: request.id,
      });
    }

    if (volume.status !== 'IN_USE' || !volume.attachedToWorkspaceId) {
      return reply.status(400).send({
        errorCode: 'VOLUME_NOT_ATTACHED',
        message: 'Volume is not currently attached to a workspace.',
        error: 'Volume is not currently attached to a workspace.',
        requestId: request.id,
      });
    }

    const updated = await prisma.persistentVolume.update({
      where: { id },
      data: {
        status: 'AVAILABLE',
        attachedToWorkspaceId: null,
        lastDetachedAt: new Date(),
      },
    });

    return updated;
  });

  // DELETE /volumes/:id — Delete a volume
  fastify.delete('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };

    const volume = await prisma.persistentVolume.findFirst({
      where: { id, userId },
    });

    if (!volume) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Volume not found.',
        error: 'Volume not found.',
        requestId: request.id,
      });
    }

    if (volume.status === 'IN_USE') {
      return reply.status(400).send({
        errorCode: 'VOLUME_IN_USE',
        message: 'Cannot delete a volume that is attached to a workspace. Detach it first.',
        error: 'Cannot delete a volume that is attached to a workspace. Detach it first.',
        requestId: request.id,
      });
    }

    if (!['AVAILABLE', 'FAILED', 'CREATING'].includes(volume.status)) {
      return reply.status(400).send({
        errorCode: 'VOLUME_INVALID_STATE',
        message: `Cannot delete volume in ${volume.status} state.`,
        error: `Cannot delete volume in ${volume.status} state.`,
        requestId: request.id,
      });
    }

    const updated = await prisma.persistentVolume.update({
      where: { id },
      data: { status: 'DELETING' },
    });

    return updated;
  });

  // PUT /volumes/:id — Rename a volume
  fastify.put('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };
    const { name } = renameVolumeSchema.parse(request.body);

    const volume = await prisma.persistentVolume.findFirst({
      where: { id, userId },
    });

    if (!volume) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Volume not found.',
        error: 'Volume not found.',
        requestId: request.id,
      });
    }

    const updated = await prisma.persistentVolume.update({
      where: { id },
      data: { name },
    });

    return updated;
  });
};
