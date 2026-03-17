import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const authorAuditRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireAuthor as any);

  fastify.get('/', async (request: any) => {
    const { page = 1, limit = 50, action } = request.query as any;
    const where: any = {};
    if (action) where.action = action;

    const [items, total] = await Promise.all([
      prisma.authorAudit.findMany({
        where,
        skip: (page - 1) * limit,
        take: parseInt(limit),
        orderBy: { createdAt: 'desc' },
        include: { actor: { select: { email: true } } },
      }),
      prisma.authorAudit.count({ where }),
    ]);

    return { items, total, page, limit };
  });
};
