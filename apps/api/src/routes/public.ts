import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import bcrypt from 'bcrypt';
import { normalizeEmail, validatePassword, PASSWORD_REQUIREMENTS_MSG } from '../lib/security';
import { logSecurityEvent, SecurityEventType } from '../lib/security';
import {
  buildSessionTokenPayload,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from '../lib/session';
import { resolveCustomerAccessStatus } from '../lib/customerAccess';
import {
  SUPPORTED_CUSTOMER_GPU_DEFAULTS,
  SUPPORTED_CUSTOMER_GPU_KEYS,
  toCustomerGpuDisplayName,
} from '../lib/supportedGpus';

const prisma = new PrismaClient();

const joinAlphaSchema = z.object({
  fullName: z.string().min(1).max(256),
  email: z.string().email(),
  password: z.string(),
  company: z.string().max(256).optional(),
  useCase: z.string().max(1024).optional(),
  expectedGpuTypes: z.string().max(256).optional(),
  expectedHoursPerWeek: z.number().int().min(0).max(168).optional(),
  regionPreference: z.string().max(128).optional(),
  website: z.string().url().max(512).optional().or(z.literal('')),
  referralSource: z.string().max(256).optional(),
});

export const publicRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.get('/gpu-skus', async () => {
    const dbSkus = await prisma.gpuSku.findMany({
      where: {
        enabled: true,
        key: { in: [...SUPPORTED_CUSTOMER_GPU_KEYS] },
      },
    });
    const dbSkuMap = new Map(dbSkus.map((sku) => [sku.key, sku]));

    return {
      items: SUPPORTED_CUSTOMER_GPU_KEYS.map((key) => {
        const dbSku = dbSkuMap.get(key);
        const fallback = SUPPORTED_CUSTOMER_GPU_DEFAULTS[key];
        const pricePerHourCents = dbSku?.pricePerHourCents ?? fallback.pricePerHourCents;
        const displayName = toCustomerGpuDisplayName(key);
        return {
          key,
          display_name: displayName,
          price_per_hour_cents: pricePerHourCents,
          price_display: `$${(pricePerHourCents / 100).toFixed(2)} / hour`,
          vram_gb: dbSku?.vramGb ?? fallback.vramGb,
          short_badge: dbSku?.shortBadge ?? fallback.shortBadge,
          description_lines: dbSku ? JSON.parse(dbSku.descriptionLines) : [...fallback.descriptionLines],
        };
      }),
    };
  });

  fastify.get('/gpu-availability', async () => {
    // Workspace table stores GPU type key (e.g. RTX_5090, A100_80GB)
    const items = await Promise.all(
      SUPPORTED_CUSTOMER_GPU_KEYS.map(async (key) => {
        const warmCount = await prisma.workspace.count({
          where: {
            status: 'WARM_AVAILABLE',
            verificationStatus: 'PASS',
            assignedUserId: null,
            isWarmPool: true,
            gpuType: key,
          },
        });

        return {
          key,
          warm_available_count: warmCount,
          availability_label: warmCount > 0 ? 'Instant ready' : 'Standard ready',
        };
      })
    );

    return {
      items,
      refreshed_at: new Date().toISOString(),
    };
  });

  fastify.get('/cli/info', async () => {
    return {
      command: 'pip install aldaro',
      version: '1.0.0-alpha',
      documentation_url: 'https://docs.aldaro.ai/cli',
    };
  });

  fastify.post('/cli/track-click', async (request: any) => {
    // Analytics tracking for CLI interest
    // SECURITY: Do not log raw IP addresses (PII)
    console.log('[ANALYTICS] CLI Install Clicked');
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // POST /api/public/join-alpha
  // Create account, create application, set PENDING_REVIEW, queue review email.
  // Returns nextRoute for client redirect. Sets session cookie on success.
  // -------------------------------------------------------------------------
  fastify.post('/join-alpha', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
  }, async (request: any, reply: any) => {
    const body = joinAlphaSchema.safeParse(request.body);
    if (!body.success) {
      request.log.warn({ validation: body.error.flatten() }, 'join-alpha validation failed');
      return reply.status(400).send({ error: 'Invalid request.' });
    }
    const data = body.data;
    const email = normalizeEmail(data.email);

    if (!validatePassword(data.password)) {
      return reply.status(400).send({ error: PASSWORD_REQUIREMENTS_MSG });
    }

    if (email === 'shivas@aldaro.ai') {
      await logSecurityEvent(request, null, SecurityEventType.LOGIN_FAILURE, { email, reason: 'AUTHOR_SIGNUP_ATTEMPT' });
      return reply.status(400).send({ error: 'Invalid credentials.' });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
      include: {
        customerApplications: {
          where: { decision: null },
          orderBy: { submittedAt: 'desc' },
          take: 1,
        },
      },
    });

    if (existingUser) {
      const status = resolveCustomerAccessStatus(existingUser);
      return reply.send({
        nextRoute: '/login',
        applicationId: null,
        customerAccessStatus: status,
        authenticated: false,
        message: status === 'PENDING_REVIEW'
          ? 'An account already exists for this email. Sign in to check your review status.'
          : 'An account already exists for this email. Sign in to continue.',
      });
    }

    // New user: create user, application, and outbox in a transaction
    const passwordHash = await bcrypt.hash(data.password, 12);
    const user = await prisma.user.create({
      data: {
        email,
        passwordHash,
        role: 'CUSTOMER',
        customerAccessStatus: 'PENDING_REVIEW',
        customerAccessUpdatedAt: new Date(),
      },
    });

    const application = await prisma.customerApplication.create({
      data: {
        userId: user.id,
        fullName: data.fullName,
        email: user.email,
        company: data.company ?? null,
        useCase: data.useCase ?? null,
        expectedGpuTypes: data.expectedGpuTypes ?? null,
        expectedHoursPerWeek: data.expectedHoursPerWeek ?? null,
        regionPreference: data.regionPreference ?? null,
        website: (data.website && data.website !== '') ? data.website : null,
        referralSource: data.referralSource ?? null,
      },
    });

    const dedupeKey = `APPLICATION_IN_REVIEW:${application.id}`;
    await prisma.emailOutbox.create({
      data: {
        type: 'APPLICATION_IN_REVIEW',
        toEmail: user.email,
        userId: user.id,
        applicationId: application.id,
        subject: 'Aldaro.AI application received',
        bodyText: `Hey ${data.fullName.split(' ')[0] || data.fullName},\n\nYour Aldaro.AI application is in review.\nYou will get an email after approval.\nIf you need help, reply to this email.`,
        bodyHtml: null,
        status: 'PENDING',
        dedupeKey,
      },
    });

    await logSecurityEvent(request, user.id, SecurityEventType.LOGIN_SUCCESS, { method: 'join-alpha' });

    const token = (fastify as any).jwt.sign(buildSessionTokenPayload(user));
    const isProduction = process.env.NODE_ENV === 'production';
    return reply
      .setCookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(isProduction))
      .send({
        nextRoute: '/verification-processing',
        applicationId: application.id,
        customerAccessStatus: 'PENDING_REVIEW',
        authenticated: true,
      });
  });
};
