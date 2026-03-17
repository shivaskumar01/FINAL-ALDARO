import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

const updateSettingsSchema = z.object({
  email: z.string().email().optional(),
  maxActiveWorkspaces: z.number().min(1).max(10).optional(),
});

export const userRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);

  fastify.get('/me', async (request: any) => {
    const userId = request.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        accountStatus: true,
        paymentStatus: true,
        maxActiveWorkspaces: true,
        createdAt: true,
      }
    });
    return user;
  });

  fastify.put('/settings', async (request: any, reply) => {
    const userId = request.user.userId;
    const data = updateSettingsSchema.parse(request.body);

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        email: data.email,
        maxActiveWorkspaces: data.maxActiveWorkspaces,
      },
      select: {
        id: true,
        email: true,
        role: true,
        accountStatus: true,
        maxActiveWorkspaces: true,
      }
    });

    return user;
  });

  fastify.get('/usage-sessions', async (request: any) => {
    const userId = request.user.userId;
    const { workspaceId, status, limit = 20 } = request.query as {
      workspaceId?: string;
      status?: string;
      limit?: string | number;
    };

    return prisma.usageSession.findMany({
      where: {
        userId,
        ...(workspaceId ? { workspaceId } : {}),
        ...(status ? { status } : {}),
      },
      orderBy: { startTime: 'desc' },
      take: Math.min(parseInt(String(limit), 10) || 20, 100),
    });
  });
};
