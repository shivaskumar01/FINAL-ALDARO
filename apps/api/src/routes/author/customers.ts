/**
 * Author Portal – Customer applications queue: pending count, list, detail, approve, reject, suspend.
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

export const authorCustomersRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireAuthor as any);

  // GET /api/author/customers/pending-count
  fastify.get('/pending-count', async () => {
    const count = await prisma.customerApplication.count({
      where: { decision: null },
    });
    return { count };
  });

  // GET /api/author/customers/queue?status=pending
  fastify.get('/queue', async (request: any) => {
    const { status = 'pending' } = request.query as { status?: string };
    if (status !== 'pending') {
      const list = await prisma.customerApplication.findMany({
        where: status === 'approved' ? { decision: 'APPROVED' } : status === 'rejected' ? { decision: 'REJECTED' } : {},
        orderBy: { submittedAt: 'desc' },
        take: 200,
        include: {
          user: { select: { id: true, email: true, customerAccessStatus: true } },
        },
      });
      return {
        items: list.map((a) => ({
          applicationId: a.id,
          userId: a.userId,
          fullName: a.fullName,
          email: a.email,
          company: a.company,
          useCase: a.useCase,
          submittedAt: a.submittedAt.toISOString(),
          customerAccessStatus: a.user.customerAccessStatus,
          decision: a.decision,
          reviewedAt: a.reviewedAt?.toISOString() ?? null,
        })),
      };
    }

    const list = await prisma.customerApplication.findMany({
      where: { decision: null },
      orderBy: { submittedAt: 'desc' },
      take: 200,
      include: {
        user: { select: { id: true, email: true, customerAccessStatus: true } },
        emailOutbox: {
          where: { type: 'APPLICATION_IN_REVIEW' },
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { status: true, sentAt: true },
        },
      },
    });

    return {
      items: list.map((a) => ({
        applicationId: a.id,
        userId: a.userId,
        fullName: a.fullName,
        email: a.email,
        company: a.company,
        useCase: a.useCase,
        submittedAt: a.submittedAt.toISOString(),
        customerAccessStatus: a.user.customerAccessStatus,
        emailSentStatus: a.emailOutbox[0]?.status ?? 'not_sent',
        emailSentAt: a.emailOutbox[0]?.sentAt?.toISOString() ?? null,
      })),
    };
  });

  // GET /api/author/customers/applications/:applicationId
  fastify.get('/applications/:applicationId', async (request: any, reply: any) => {
    const { applicationId } = request.params as { applicationId: string };
    const app = await prisma.customerApplication.findUnique({
      where: { id: applicationId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            customerAccessStatus: true,
            customerAccessUpdatedAt: true,
            createdAt: true,
          },
        },
        emailOutbox: {
          orderBy: { createdAt: 'desc' },
          select: { type: true, status: true, sentAt: true, attemptCount: true, createdAt: true },
        },
      },
    });
    if (!app) return reply.status(404).send({ error: 'Application not found' });

    return {
      ...app,
      submittedAt: app.submittedAt.toISOString(),
      reviewedAt: app.reviewedAt?.toISOString() ?? null,
      user: app.user,
      emailStatus: app.emailOutbox,
    };
  });

  // POST /api/author/customers/applications/:applicationId/approve
  const approveSchema = z.object({ internalNotes: z.string().max(2000).optional() });
  fastify.post('/applications/:applicationId/approve', async (request: any, reply: any) => {
    const actorId = request.user.userId;
    const { applicationId } = request.params as { applicationId: string };
    const body = approveSchema.safeParse(request.body || {});
    const internalNotes = body.success ? body.data.internalNotes : undefined;

    const app = await prisma.customerApplication.findUnique({
      where: { id: applicationId },
      include: { user: true },
    });
    if (!app) return reply.status(404).send({ error: 'Application not found' });
    if (app.decision) return reply.status(400).send({ error: 'Application already reviewed' });

    const fromStatus = app.user.customerAccessStatus ?? 'PENDING_REVIEW';

    await prisma.$transaction([
      prisma.user.update({
        where: { id: app.userId },
        data: {
          isAlphaTester: true,
          customerAccessStatus: 'APPROVED',
          customerAccessUpdatedAt: new Date(),
          customerAccessUpdatedById: actorId,
          customerAccessReason: null,
        },
      }),
      prisma.customerApplication.update({
        where: { id: applicationId },
        data: {
          decision: 'APPROVED',
          reviewedAt: new Date(),
          reviewedById: actorId,
          internalNotes: internalNotes ?? app.internalNotes,
        },
      }),
      prisma.emailOutbox.upsert({
        where: { dedupeKey: `APPLICATION_ACCEPTED:${app.id}` },
        update: {},
        create: {
          type: 'APPLICATION_ACCEPTED',
          toEmail: app.user.email,
          userId: app.userId,
          applicationId: app.id,
          subject: 'Aldaro.AI application approved',
          bodyText: `Hey ${app.fullName.split(' ')[0] || app.fullName},\n\nYour Aldaro.AI application is approved.\nSign in to access your customer portal and start renting GPUs.\nLogin link: ${process.env.PORTAL_URL || 'https://app.aldaro.ai'}`,
          bodyHtml: null,
          status: 'PENDING',
          dedupeKey: `APPLICATION_ACCEPTED:${app.id}`,
        },
      }),
      prisma.authorAudit.create({
        data: {
          actorUserId: actorId,
          action: 'CUSTOMER_APPROVE',
          targetType: 'CustomerApplication',
          targetId: applicationId,
          diffJson: JSON.stringify({
            targetUserId: app.userId,
            fromStatus,
            toStatus: 'APPROVED',
            reason: internalNotes ?? null,
          }),
        },
      }),
    ]);

    return { customerAccessStatus: 'APPROVED' };
  });

  // POST /api/author/customers/applications/:applicationId/reject
  const rejectSchema = z.object({
    decisionReason: z.string().min(1).max(2000),
    internalNotes: z.string().max(2000).optional(),
  });
  fastify.post('/applications/:applicationId/reject', async (request: any, reply: any) => {
    const actorId = request.user.userId;
    const { applicationId } = request.params as { applicationId: string };
    const body = rejectSchema.safeParse(request.body);
    if (!body.success) {
      request.log.warn({ validation: body.error.flatten() }, 'reject validation failed');
      return reply.status(400).send({ error: 'decisionReason is required.' });
    }

    const app = await prisma.customerApplication.findUnique({
      where: { id: applicationId },
      include: { user: true },
    });
    if (!app) return reply.status(404).send({ error: 'Application not found' });
    if (app.decision) return reply.status(400).send({ error: 'Application already reviewed' });

    const fromStatus = app.user.customerAccessStatus ?? 'PENDING_REVIEW';

    await prisma.$transaction([
      prisma.user.update({
        where: { id: app.userId },
        data: {
          isAlphaTester: false,
          customerAccessStatus: 'REJECTED',
          customerAccessUpdatedAt: new Date(),
          customerAccessUpdatedById: actorId,
          customerAccessReason: body.data.decisionReason,
        },
      }),
      prisma.customerApplication.update({
        where: { id: applicationId },
        data: {
          decision: 'REJECTED',
          decisionReason: body.data.decisionReason,
          reviewedAt: new Date(),
          reviewedById: actorId,
          internalNotes: body.data.internalNotes ?? app.internalNotes,
        },
      }),
      prisma.emailOutbox.upsert({
        where: { dedupeKey: `APPLICATION_REJECTED:${app.id}` },
        update: {},
        create: {
          type: 'APPLICATION_REJECTED',
          toEmail: app.user.email,
          userId: app.userId,
          applicationId: app.id,
          subject: 'Aldaro.AI application update',
          bodyText: `Hey ${app.fullName.split(' ')[0] || app.fullName},\n\nThanks for applying to Aldaro.AI. We are unable to approve your application right now.\n\nReason: ${body.data.decisionReason}\n\nYou can reply to this email for support or apply again later.`,
          bodyHtml: null,
          status: 'PENDING',
          dedupeKey: `APPLICATION_REJECTED:${app.id}`,
        },
      }),
      prisma.authorAudit.create({
        data: {
          actorUserId: actorId,
          action: 'CUSTOMER_REJECT',
          targetType: 'CustomerApplication',
          targetId: applicationId,
          diffJson: JSON.stringify({
            targetUserId: app.userId,
            fromStatus,
            toStatus: 'REJECTED',
            reason: body.data.decisionReason,
            internalNotes: body.data.internalNotes ?? null,
          }),
        },
      }),
    ]);

    return { customerAccessStatus: 'REJECTED' };
  });

  // POST /api/author/customers/:userId/suspend
  const suspendSchema = z.object({ reason: z.string().min(1).max(2000) });
  fastify.post('/:userId/suspend', async (request: any, reply: any) => {
    const actorId = request.user.userId;
    const { userId } = request.params as { userId: string };
    const body = suspendSchema.safeParse(request.body);
    if (!body.success) {
      request.log.warn({ validation: body.error.flatten() }, 'suspend validation failed');
      return reply.status(400).send({ error: 'reason is required.' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(404).send({ error: 'User not found' });

    const fromStatus = user.customerAccessStatus ?? 'APPROVED';

    await prisma.$transaction([
      prisma.user.update({
        where: { id: userId },
        data: {
          isAlphaTester: false,
          customerAccessStatus: 'SUSPENDED',
          customerAccessUpdatedAt: new Date(),
          customerAccessUpdatedById: actorId,
          customerAccessReason: body.data.reason,
        },
      }),
      prisma.authorAudit.create({
        data: {
          actorUserId: actorId,
          action: 'CUSTOMER_SUSPEND',
          targetType: 'User',
          targetId: userId,
          diffJson: JSON.stringify({
            targetUserId: userId,
            fromStatus,
            toStatus: 'SUSPENDED',
            reason: body.data.reason,
          }),
        },
      }),
    ]);

    return { customerAccessStatus: 'SUSPENDED' };
  });
};
