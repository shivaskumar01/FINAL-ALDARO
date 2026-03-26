import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const authorAuditRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireAuthor as any);

  fastify.get('/', async (request: any) => {
    const { page: rawPage = '1', limit: rawLimit = '50', action } = request.query as any;
    const page = Math.max(1, Math.min(parseInt(rawPage, 10) || 1, 500));
    const limit = Math.max(1, Math.min(parseInt(rawLimit, 10) || 50, 200));
    const where: any = {};
    if (action && typeof action === 'string' && action.length <= 100) where.action = action;

    const [items, total] = await Promise.all([
      prisma.authorAudit.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { email: true } } },
      }),
      prisma.authorAudit.count({ where }),
    ]);

    return { items, total, page, limit };
  });
};
