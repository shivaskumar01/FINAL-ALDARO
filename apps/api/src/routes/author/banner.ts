import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

const bannerSchema = z.object({
  enabled: z.boolean(),
  message: z.string().max(120).optional().nullable(),
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']),
  linkText: z.string().optional().nullable(),
  linkUrl: z.string().url().optional().nullable().refine(
    (val) => !val || /^https?:\/\//i.test(val),
    { message: 'linkUrl must be an HTTP or HTTPS URL' }
  ),
  startAt: z.string().datetime().optional().nullable(),
  endAt: z.string().datetime().optional().nullable(),
});

export const authorBannerRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireAuthor as any);

  fastify.get('/', async () => {
    return (await prisma.appBanner.findFirst()) || {
      enabled: false,
      message: null,
      severity: 'INFO',
      linkText: null,
      linkUrl: null,
      startAt: null,
      endAt: null,
    };
  });

  fastify.put('/', {
    preHandler: fastify.requireReauth as any,
  }, async (request: any, reply) => {
    const data = bannerSchema.parse(request.body);
    const userId = request.user.userId;

    const oldBanner = await prisma.appBanner.findFirst();
    const bannerData = {
      enabled: data.enabled,
      message: data.message,
      severity: data.severity,
      linkText: data.linkText,
      linkUrl: data.linkUrl,
      startAt: data.startAt ? new Date(data.startAt) : null,
      endAt: data.endAt ? new Date(data.endAt) : null,
      updatedByUserId: userId,
      updatedAt: new Date(),
    };

    const banner = await prisma.$transaction(async (tx) => {
      const savedBanner = oldBanner
        ? await tx.appBanner.update({
            where: { id: oldBanner.id },
            data: bannerData,
          })
        : await tx.appBanner.create({
            data: bannerData,
          });

      await tx.authorAudit.create({
        data: {
          actorUserId: userId,
          action: 'BANNER_UPDATE',
          targetType: 'BANNER',
          targetId: savedBanner.id,
          diffJson: JSON.stringify({ before: oldBanner, after: savedBanner }),
        },
      });

      return savedBanner;
    });

    return banner;
  });
};
