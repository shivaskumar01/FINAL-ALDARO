import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

const postSchema = z.object({
  title: z.string().min(3).max(120),
  slug: z.string().min(3).max(60).regex(/^[a-z0-9-]+$/),
  excerpt: z.string().max(180).optional(),
  visibility: z.enum(['IN_APP_ANNOUNCEMENT', 'CHANGELOG', 'DOC_PAGE']),
  bodyMarkdown: z.string().min(20).max(50000),
  coverImageUrl: z.string().url().optional().or(z.literal('')),
  tags: z.array(z.string()).optional(),
  ctaText: z.string().optional(),
  ctaUrl: z.string().optional(),
  seoTitle: z.string().optional(),
  seoDescription: z.string().max(160).optional(),
});

function toAuthorPostData(
  data: z.infer<typeof postSchema>,
  userId: string,
): Prisma.AuthorPostUncheckedCreateInput {
  return {
    title: data.title,
    slug: data.slug,
    excerpt: data.excerpt ?? null,
    bodyMarkdown: data.bodyMarkdown,
    visibility: data.visibility,
    status: 'DRAFT',
    tags: JSON.stringify(data.tags ?? []),
    coverImageUrl: data.coverImageUrl || null,
    ctaText: data.ctaText ?? null,
    ctaUrl: data.ctaUrl ?? null,
    seoTitle: data.seoTitle ?? null,
    seoDescription: data.seoDescription ?? null,
    createdByUserId: userId,
    updatedByUserId: userId,
  };
}

function toAuthorPostUpdateData(
  data: z.infer<typeof postSchema>,
  userId: string,
): Prisma.AuthorPostUncheckedUpdateInput {
  return {
    title: data.title,
    slug: data.slug,
    excerpt: data.excerpt ?? null,
    bodyMarkdown: data.bodyMarkdown,
    visibility: data.visibility,
    tags: JSON.stringify(data.tags ?? []),
    coverImageUrl: data.coverImageUrl || null,
    ctaText: data.ctaText ?? null,
    ctaUrl: data.ctaUrl ?? null,
    seoTitle: data.seoTitle ?? null,
    seoDescription: data.seoDescription ?? null,
    updatedByUserId: userId,
    updatedAt: new Date(),
  };
}

export const authorPostRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireAuthor as any);

  fastify.get('/', async (request: any) => {
    const querySchema = z.object({
      q: z.string().max(200).optional(),
      status: z.enum(['DRAFT', 'PUBLISHED', 'ARCHIVED']).optional(),
      visibility: z.enum(['IN_APP_ANNOUNCEMENT', 'CHANGELOG', 'DOC_PAGE']).optional(),
      page: z.coerce.number().int().min(1).max(1000).default(1),
      limit: z.coerce.number().int().min(1).max(100).default(20),
    });
    const { q, status, visibility, page, limit } = querySchema.parse(request.query);
    const where: any = {};
    if (q) where.title = { contains: q, mode: 'insensitive' };
    if (status) where.status = status;
    if (visibility) where.visibility = visibility;

    const [items, total] = await Promise.all([
      prisma.authorPost.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { updatedAt: 'desc' },
      }),
      prisma.authorPost.count({ where }),
    ]);

    return { items, total, page, limit };
  });

  fastify.get('/:id', async (request: any, reply: any) => {
    const post = await prisma.authorPost.findUnique({
      where: { id: request.params.id },
      include: { revisions: { orderBy: { createdAt: 'desc' }, take: 10 } },
    });
    if (!post) return reply.status(404).send({ error: 'Post not found' });
    return post;
  });

  fastify.post('/', async (request: any) => {
    const data = postSchema.parse(request.body);
    const userId = request.user.userId;

    const post = await prisma.$transaction(async (tx) => {
      const createdPost = await tx.authorPost.create({
        data: toAuthorPostData(data, userId),
      });

      await tx.authorPostRevision.create({
        data: {
          postId: createdPost.id,
          title: data.title,
          bodyMarkdown: data.bodyMarkdown,
          excerpt: data.excerpt,
          updatedByUserId: userId,
        },
      });

      await tx.authorAudit.create({
        data: { actorUserId: userId, action: 'POST_CREATE', targetType: 'POST', targetId: createdPost.id },
      });

      return createdPost;
    });

    return post;
  });

  fastify.put('/:id', async (request: any) => {
    const data = postSchema.parse(request.body);
    const userId = request.user.userId;
    const postId = request.params.id;

    const oldPost = await prisma.authorPost.findUnique({ where: { id: postId } });

    const post = await prisma.$transaction(async (tx) => {
      const updatedPost = await tx.authorPost.update({
        where: { id: postId },
        data: toAuthorPostUpdateData(data, userId),
      });

      await tx.authorPostRevision.create({
        data: {
          postId,
          title: data.title,
          bodyMarkdown: data.bodyMarkdown,
          excerpt: data.excerpt,
          updatedByUserId: userId,
        },
      });

      await tx.authorAudit.create({
        data: {
          actorUserId: userId,
          action: 'POST_UPDATE',
          targetType: 'POST',
          targetId: postId,
          diffJson: JSON.stringify({ before: oldPost, after: updatedPost }),
        },
      });

      return updatedPost;
    });

    return post;
  });

  fastify.post('/:id/publish', {
    preHandler: fastify.requireReauth as any,
  }, async (request: any, reply) => {
    const postId = request.params.id;
    const userId = request.user.userId;

    const post = await prisma.authorPost.update({
      where: { id: postId },
      data: { status: 'PUBLISHED', publishedAt: new Date(), scheduledPublishAt: null },
    });

    await prisma.authorAudit.create({
      data: { actorUserId: userId, action: 'POST_PUBLISH', targetType: 'POST', targetId: postId },
    });

    return post;
  });

  fastify.post('/:id/archive', {
    preHandler: fastify.requireReauth as any,
  }, async (request: any, reply) => {
    const postId = request.params.id;
    const userId = request.user.userId;

    const post = await prisma.authorPost.update({
      where: { id: postId },
      data: { status: 'ARCHIVED' },
    });

    await prisma.authorAudit.create({
      data: { actorUserId: userId, action: 'POST_ARCHIVE', targetType: 'POST', targetId: postId },
    });

    return post;
  });
};
