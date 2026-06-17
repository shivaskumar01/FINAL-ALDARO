/**
 * Customer access status and application (pending review) APIs.
 * Used by verification-processing and pending-review screens.
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { resolveCustomerAccessStatus } from '../../lib/customerAccess';

const prisma = new PrismaClient();

const APPLICATION_UPDATE_COOLDOWN_MS = 60_000;
const RESEND_EMAIL_COOLDOWN_MS = 3 * 60_000; // 3 minutes

export const customerAccessRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', async (request: any, reply: any) => {
    if (request.user?.role !== 'CUSTOMER') {
      return reply.status(404).send({ error: 'Not Found' });
    }
  });

  // GET /api/customer/access-status
  fastify.get('/access-status', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        customerAccessStatus: true,
        isAlphaTester: true,
        customerAccessUpdatedAt: true,
        customerAccessReason: true,
      },
    });
    if (!user) return reply.status(404).send({ error: 'User not found' });

    const status = resolveCustomerAccessStatus(user);
    const app = await prisma.customerApplication.findFirst({
      where: { userId },
      orderBy: { submittedAt: 'desc' },
      select: { submittedAt: true, reviewedAt: true, decisionReason: true },
    });

    return {
      customerAccessStatus: status,
      submittedAt: app?.submittedAt?.toISOString() ?? null,
      reviewedAt: app?.reviewedAt?.toISOString() ?? null,
      decisionReason: app?.decisionReason ?? user.customerAccessReason,
    };
  });

  // POST /api/customer/application-update (only when PENDING_REVIEW)
  const applicationUpdateSchema = z.object({
    fullName: z.string().min(1).max(256).optional(),
    company: z.string().max(256).optional(),
    useCase: z.string().max(1024).optional(),
    expectedGpuTypes: z.string().max(256).optional(),
    expectedHoursPerWeek: z.number().int().min(0).max(168).optional(),
    regionPreference: z.string().max(128).optional(),
    website: z.string().url().max(512).optional().or(z.literal('')),
    referralSource: z.string().max(256).optional(),
  });

  fastify.post('/application-update', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { customerAccessStatus: true, isAlphaTester: true },
    });
    if (!user || resolveCustomerAccessStatus(user) !== 'PENDING_REVIEW') {
      return reply.status(403).send({ error: 'Only pending applications can be updated.', errorCode: 'NOT_PENDING' });
    }

    const body = applicationUpdateSchema.safeParse(request.body);
    if (!body.success) {
      request.log.warn({ validation: body.error.flatten() }, 'application-update validation failed');
      return reply.status(400).send({ error: 'Invalid request.' });
    }

    const pending = await prisma.customerApplication.findFirst({
      where: { userId, decision: null },
      orderBy: { submittedAt: 'desc' },
    });
    if (!pending) return reply.status(404).send({ error: 'No pending application found.' });

    const update: Record<string, unknown> = {};
    if (body.data.fullName !== undefined) update.fullName = body.data.fullName;
    if (body.data.company !== undefined) update.company = body.data.company;
    if (body.data.useCase !== undefined) update.useCase = body.data.useCase;
    if (body.data.expectedGpuTypes !== undefined) update.expectedGpuTypes = body.data.expectedGpuTypes;
    if (body.data.expectedHoursPerWeek !== undefined) update.expectedHoursPerWeek = body.data.expectedHoursPerWeek;
    if (body.data.regionPreference !== undefined) update.regionPreference = body.data.regionPreference;
    if (body.data.website !== undefined) update.website = body.data.website && body.data.website !== '' ? body.data.website : null;
    if (body.data.referralSource !== undefined) update.referralSource = body.data.referralSource;

    const updated = await prisma.customerApplication.update({
      where: { id: pending.id },
      data: update,
      select: {
        id: true,
        fullName: true,
        email: true,
        company: true,
        useCase: true,
        submittedAt: true,
      },
    });

    return {
      applicationId: updated.id,
      fullName: updated.fullName,
      email: updated.email,
      company: updated.company,
      useCase: updated.useCase,
      submittedAt: updated.submittedAt.toISOString(),
    };
  });

  // POST /api/customer/resend-review-email (rate-limited, PENDING_REVIEW only)
  fastify.post('/resend-review-email', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { customerAccessStatus: true, isAlphaTester: true, email: true },
    });
    if (!user || resolveCustomerAccessStatus(user) !== 'PENDING_REVIEW') {
      return reply.status(403).send({ error: 'Only pending applications can resend the review email.', errorCode: 'NOT_PENDING' });
    }

    const now = Date.now();
    // SECURITY: DB-backed cooldown check, survives API restarts and works across instances.
    const recentEmail = await prisma.emailOutbox.findFirst({
      where: {
        userId,
        type: 'APPLICATION_IN_REVIEW',
        createdAt: { gte: new Date(now - RESEND_EMAIL_COOLDOWN_MS) },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (recentEmail) {
      return reply.status(429).send({ error: 'Please wait a few minutes before requesting another email.' });
    }

    const pending = await prisma.customerApplication.findFirst({
      where: { userId, decision: null },
      orderBy: { submittedAt: 'desc' },
    });
    if (!pending) return reply.status(404).send({ error: 'No pending application found.' });

    const recentSent = await prisma.emailOutbox.findFirst({
      where: {
        applicationId: pending.id,
        type: 'APPLICATION_IN_REVIEW',
        status: 'SENT',
        sentAt: { gte: new Date(now - RESEND_EMAIL_COOLDOWN_MS) },
      },
    });
    if (recentSent) {
      return reply.send({ ok: true, message: 'Email sent.' });
    }

    const dedupeKey = `APPLICATION_IN_REVIEW:${pending.id}:${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '-')}`;
    await prisma.emailOutbox.create({
      data: {
        type: 'APPLICATION_IN_REVIEW',
        toEmail: user.email,
        userId,
        applicationId: pending.id,
        subject: 'Aldaro.AI application received',
        bodyText: `Hey ${pending.fullName.split(' ')[0] || pending.fullName},\n\nYour Aldaro.AI application is in review.\nYou will get an email after approval.\nIf you need help, reply to this email.`,
        bodyHtml: null,
        status: 'PENDING',
        dedupeKey,
      },
    });

    return reply.send({ ok: true, message: 'Email sent.' });
  });
};
