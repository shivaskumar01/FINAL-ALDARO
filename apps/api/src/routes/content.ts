import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

export const publicContentRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/announcements', async () => {
    return prisma.authorPost.findMany({
      where: { visibility: 'IN_APP_ANNOUNCEMENT', status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      take: 3,
    });
  });

  fastify.get('/changelog', async (request: any) => {
    const { page: rawPage = '1', limit: rawLimit = '20' } = request.query as any;
    const page = Math.max(1, Math.min(parseInt(rawPage, 10) || 1, 200));
    const limit = Math.max(1, Math.min(parseInt(rawLimit, 10) || 20, 50));
    return prisma.authorPost.findMany({
      where: { visibility: 'CHANGELOG', status: 'PUBLISHED' },
      orderBy: { publishedAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });
  });

  fastify.get('/post/:slug', async (request: any, reply) => {
    const post = await prisma.authorPost.findFirst({
      where: { slug: request.params.slug, status: 'PUBLISHED' },
    });
    if (!post) return reply.status(404).send({ error: 'Not Found' });
    return post;
  });

  fastify.get('/banner', async () => {
    const now = new Date();
    return prisma.appBanner.findFirst({
      where: {
        enabled: true,
        OR: [
          { startAt: null },
          { startAt: { lte: now } },
        ],
        AND: [
          { OR: [{ endAt: null }, { endAt: { gte: now } }] },
        ],
      },
    });
  });
};
