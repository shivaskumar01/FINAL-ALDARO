import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { validatePassword, PASSWORD_REQUIREMENTS_MSG } from '../lib/security';
import { logSecurityEvent, SecurityEventType } from '../lib/security';

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

  fastify.put('/settings', {
    // Require recent re-authentication for sensitive account changes (email)
    preHandler: fastify.requireReauth as any,
  }, async (request: any, reply) => {
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

  // POST /users/change-password — change password (requires reauth)
  fastify.post('/change-password', {
    preHandler: fastify.requireReauth as any,
    config: { rateLimit: { max: 5, timeWindow: '15 minutes' } },
  }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { currentPassword, newPassword } = z.object({
      currentPassword: z.string().min(1),
      newPassword: z.string().min(1),
    }).parse(request.body);

    if (!validatePassword(newPassword)) {
      return reply.status(400).send({ error: PASSWORD_REQUIREMENTS_MSG });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      await logSecurityEvent(request, userId, SecurityEventType.LOGIN_FAILURE, { reason: 'PASSWORD_CHANGE_WRONG_CURRENT' });
      return reply.status(401).send({ error: 'Current password is incorrect.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash },
    });

    await logSecurityEvent(request, userId, SecurityEventType.PW_RESET_DONE, { method: 'change-password' });

    return { ok: true, message: 'Password changed successfully.' };
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
