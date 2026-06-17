import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

export const budgetRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);

  // GET /budget, get current budget config + MTD spend
  fastify.get('/', async (request: any) => {
    const userId = request.user.userId;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        monthlySoftLimitCents: true,
        hardLimitAction: true,
        lastBudgetAlertAt: true,
      },
    });

    // Calculate MTD spend
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const sessions = await prisma.usageSession.findMany({
      where: {
        userId,
        startTime: { gte: monthStart },
      },
      select: {
        billedCents: true,
        status: true,
        startTime: true,
        pricePerHourCents: true,
        totalSeconds: true,
      },
    });

    let mtdSpendCents = 0;
    for (const s of sessions) {
      if (s.status === 'ENDED') {
        mtdSpendCents += s.billedCents;
      } else if (s.status === 'RUNNING') {
        // Estimate running session cost
        const elapsed = Math.max(0, (now.getTime() - s.startTime.getTime()) / 1000);
        mtdSpendCents += Math.ceil((elapsed * s.pricePerHourCents) / 3600);
      }
    }

    // Recent alerts
    const alerts = await prisma.budgetAlert.findMany({
      where: { userId },
      orderBy: { notifiedAt: 'desc' },
      take: 5,
    });

    return {
      monthlySoftLimitCents: user?.monthlySoftLimitCents ?? null,
      hardLimitAction: user?.hardLimitAction ?? 'ALERT',
      mtdSpendCents,
      alerts,
    };
  });

  // PUT /budget, update budget settings
  fastify.put('/', async (request: any) => {
    const userId = request.user.userId;
    const body = z.object({
      // Min $1 (100 cents), max $50,000 (5,000,000 cents). Null = no limit.
      monthlySoftLimitCents: z.number().int().min(100).max(5_000_000).nullable(),
      hardLimitAction: z.enum(['ALERT', 'AUTO_TERMINATE']),
    }).parse(request.body);

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        monthlySoftLimitCents: body.monthlySoftLimitCents,
        hardLimitAction: body.hardLimitAction,
      },
      select: {
        monthlySoftLimitCents: true,
        hardLimitAction: true,
      },
    });

    return user;
  });
};
