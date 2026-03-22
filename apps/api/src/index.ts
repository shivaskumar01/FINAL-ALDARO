import Fastify from 'fastify';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import csrf from '@fastify/csrf-protection';
import { PrismaClient } from '@prisma/client';
import 'dotenv/config';

import { authRoutes } from './routes/auth';
import { workspaceRoutes } from './routes/workspaces';
import { internalAgentRoutes } from './routes/internal/agent';
import { billingRoutes } from './routes/billing';
import { authorPostRoutes } from './routes/author/posts';
import { authorBannerRoutes } from './routes/author/banner';
import { authorAuditRoutes } from './routes/author/audit';
import { authorUsageRoutes } from './routes/author/usage';
import { authorCustomersRoutes } from './routes/author/customers';
import { customerAccessRoutes } from './routes/customer/access';
import { recommendRoutes } from './routes/recommend';
import { opsFleetRoutes } from './routes/ops/fleet';
import { publicContentRoutes } from './routes/content';
import { userRoutes } from './routes/users';
import { publicRoutes } from './routes/public';
import { resolveCustomerAccessStatus } from './lib/customerAccess';
import { logSecurityEvent, SecurityEventType } from './lib/security';
import { buildPasswordVersion, SESSION_COOKIE_NAME } from './lib/session';
import { ALDARO_VERSION } from './version';

import { projectRoutes } from './routes/v1/projects';
import { runRoutes } from './routes/v1/runs';
import { agentRoutes } from './routes/v1/agent';
import { githubRoutes } from './routes/v1/integrations/github';
import { organizationRoutes } from './routes/organizations';
import { volumeRoutes } from './routes/volumes';
import { apiKeyRoutes } from './routes/api-keys';
import { webhookRoutes } from './routes/webhooks';
import { registryCredentialRoutes } from './routes/registry-credentials';
import { spotPricingRoutes } from './routes/spot-pricing';
import { supportRoutes } from './routes/support';
import { opsTicketRoutes } from './routes/ops/tickets';
import { budgetRoutes } from './routes/budget';
import { z } from 'zod';

// NOTE: Worker lifecycle management moved to standalone worker service.
// API should remain stateless. Do NOT start embedded worker here.

/**
 * Aldaro API Server
 * 
 * SECURITY: Fail fast on missing required configuration
 */

const isProduction = process.env.NODE_ENV === 'production';

// SECURITY: Validate required secrets at startup
if (isProduction) {
  const requiredSecrets = [
    'JWT_ACCESS_SECRET',
    'JWT_REFRESH_SECRET',
    'ALDARO_AGENT_SHARED_SECRET',
    'GATEWAY_SERVICE_SECRET',
    'ENCRYPTION_KEY',
    'DATABASE_URL',
  ];
  
  const missing = requiredSecrets.filter(k => !process.env[k]);
  if (missing.length > 0) {
    console.error(`FATAL: Missing required secrets: ${missing.join(', ')}`);
    process.exit(1);
  }
  
  // Validate secret strength
  if ((process.env.JWT_ACCESS_SECRET?.length || 0) < 32) {
    console.error('FATAL: JWT_ACCESS_SECRET must be at least 32 characters');
    process.exit(1);
  }
}

const fastify = Fastify({
  logger: true,
  trustProxy: isProduction,
  bodyLimit: 1024 * 512, // 512 KB max body to reduce DoS risk
});

const prisma = new PrismaClient();
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function getAllowedBrowserOrigins() {
  const configuredAppBaseUrl = process.env.APP_BASE_URL;
  const allowed = new Set<string>();

  if (configuredAppBaseUrl) allowed.add(configuredAppBaseUrl);
  if (!isProduction) {
    allowed.add('http://localhost:3000');
    allowed.add('http://127.0.0.1:3000');
  }

  return allowed;
}

function isAllowedBrowserOrigin(origin: string | undefined, isCookieAuth: boolean) {
  // SECURITY: Missing origin on cookie-authenticated mutations = CSRF attempt.
  // Non-browser clients (API keys via Bearer header) don't send Origin, so allow those.
  if (!origin) return !isCookieAuth;
  return getAllowedBrowserOrigins().has(origin);
}

function getRequestSessionToken(request: any) {
  const cookieToken = request.cookies[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const bearer = request.headers.authorization;
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ')) {
    return bearer.slice('Bearer '.length).trim();
  }
  return null;
}

// Register plugins
fastify.addHook('onSend', async (request, reply, payload) => {
  reply.header('X-Aldaro-Version', ALDARO_VERSION);
  return payload;
});

fastify.register(cors, {
  origin: (origin, cb) => {
    // In development: allow any localhost/127.0.0.1 port and reflect origin so browser accepts response
    if (!isProduction) {
      if (!origin || origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:')) {
        return cb(null, origin || 'http://localhost:3000');
      }
    }
    
    // In production, only allow configured origin
    if (origin === process.env.APP_BASE_URL) {
      return cb(null, true);
    }

    // Safe reject without throwing an internal error payload.
    cb(null, false);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-csrf-token'],
});

fastify.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      frameAncestors: ["'none'"],
      formAction: ["'self'"],
      baseUri: ["'self'"],
    },
  },
  crossOriginResourcePolicy: { policy: 'same-site' },
  hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  xssFilter: true,
});

fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  errorResponseBuilder: (_request, context) => {
    const afterMs = typeof context.after === 'number' ? context.after : 1000;
    const retryInSec = Math.max(1, Math.ceil(afterMs / 1000));
    return {
      errorCode: 'RATE_LIMITED',
      message: `Rate limit exceeded, retry in ${retryInSec} second${retryInSec === 1 ? '' : 's'}.`,
      error: `Rate limit exceeded, retry in ${retryInSec} second${retryInSec === 1 ? '' : 's'}.`,
    };
  },
});

// SECURITY: Use environment secrets, fail on default in production
const jwtSecret = process.env.JWT_ACCESS_SECRET || (isProduction ? '' : 'dev-secret-do-not-use');
const cookieSecret = process.env.JWT_REFRESH_SECRET || (isProduction ? '' : 'dev-cookie-secret');

if (!jwtSecret || !cookieSecret) {
  console.error('FATAL: JWT secrets not configured');
  process.exit(1);
}

fastify.register(jwt, {
  secret: jwtSecret,
  sign: {
    expiresIn: '2h',
  },
});

// SECURITY: Don't log secret details
console.log(`JWT configured (secret length: ${jwtSecret.length})`);

fastify.register(cookie, {
  secret: cookieSecret,
  parseOptions: {},
});

// Enforce CSRF in every environment for cookie-authenticated mutations.
fastify.register(csrf, {
  cookieOpts: {
    path: '/',
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict',
  },
  getToken: (request: any) => request.headers['x-csrf-token'],
});

function isCsrfExemptPath(pathname: string): boolean {
  if (pathname === '/billing/webhook') return true;
  if (pathname.startsWith('/internal/')) return true;
  if (pathname.startsWith('/v1/agent')) return true;
  if (/^\/v1\/runs\/[^/]+\/events$/.test(pathname)) return true;
  return false;
}

fastify.addHook('preHandler', async (request: any, reply: any) => {
  if (!MUTATION_METHODS.has(request.method)) return;

  const pathname = (request.raw.url || '').split('?')[0];
  if (isCsrfExemptPath(pathname)) return;

  // Only enforce CSRF for cookie-authenticated browser sessions.
  const sessionCookie = request.cookies?.[SESSION_COOKIE_NAME];
  if (!sessionCookie) return;
  const csrfHeader = request.headers['x-csrf-token'];
  if (typeof csrfHeader !== 'string' || csrfHeader.length === 0) {
    return reply.status(403).send({
      errorCode: 'CSRF_TOKEN_INVALID',
      message: 'Invalid or missing CSRF token.',
      error: 'Invalid or missing CSRF token.',
      requestId: request.id,
    });
  }

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const done = (fn: (value?: any) => void, value?: any) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      try {
        (fastify as any).csrfProtection(request, reply, (err?: any) => {
          if (err) done(reject, err);
          else done(resolve);
        });
        if (reply.sent) {
          done(resolve);
        }
      } catch (err) {
        done(reject, err);
      }
    });
    if (reply.sent) return;
  } catch {
    return reply.status(403).send({
      errorCode: 'CSRF_TOKEN_INVALID',
      message: 'Invalid or missing CSRF token.',
      error: 'Invalid or missing CSRF token.',
      requestId: request.id,
    });
  }
});

// Auth middleware
fastify.decorate('authenticate', async (request: any, reply: any) => {
  try {
    const token = getRequestSessionToken(request);
    if (!token) throw new Error('Unauthorized');

    if (MUTATION_METHODS.has(request.method)) {
      const origin = request.headers.origin as string | undefined;
      const isCookieAuth = !!request.cookies[SESSION_COOKIE_NAME];
      if (!isAllowedBrowserOrigin(origin, isCookieAuth)) {
        return reply.status(403).send({
          errorCode: 'FORBIDDEN_ORIGIN',
          message: 'Forbidden origin',
          error: 'Forbidden origin',
          requestId: request.id,
        });
      }
    }

    const decoded = fastify.jwt.verify(token) as any;
    const dbUser = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, role: true, accountStatus: true, passwordHash: true },
    });

    if (!dbUser || dbUser.accountStatus !== 'ACTIVE') {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    if (!decoded?.pwdv || decoded.pwdv !== buildPasswordVersion(dbUser.passwordHash)) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    if (dbUser.role !== decoded.role) {
      await logSecurityEvent(request, decoded.userId || null, SecurityEventType.ROLE_GATED_ACCESS, {
        path: request.url,
        reason: 'jwt_db_role_mismatch',
        jwtRole: decoded.role,
        dbRole: dbUser.role,
      });
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    request.user = {
      userId: dbUser.id,
      role: dbUser.role,
      accountStatus: dbUser.accountStatus,
      jti: decoded?.jti ?? null,
    };
  } catch (err) {
    return reply.status(401).send({ error: 'Unauthorized' });
  }
});

fastify.decorate('requireAuthor', async (request: any, reply: any) => {
  // SECURITY: Double-check author role server-side
  // 1. JWT must have AUTHOR role claim
  // 2. User must exist in DB with AUTHOR role
  // 3. Account must be ACTIVE
  
  const userId = request.user?.userId;
  const jwtRole = request.user?.role;
  
  // First gate: JWT claim
  if (jwtRole !== 'AUTHOR') {
    await logSecurityEvent(request, userId || null, SecurityEventType.ROLE_GATED_ACCESS, { 
      path: request.url,
      reason: 'jwt_role_mismatch',
    });
    return reply.status(404).send({ error: 'Not Found' });
  }
  
  // Second gate: DB verification (prevents stale JWT from working)
  if (!userId) {
    await logSecurityEvent(request, null, SecurityEventType.ROLE_GATED_ACCESS, { 
      path: request.url,
      reason: 'no_user_id',
    });
    return reply.status(404).send({ error: 'Not Found' });
  }
  
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, role: true, accountStatus: true },
    });
    
    if (!user || user.role !== 'AUTHOR') {
      await logSecurityEvent(request, userId, SecurityEventType.ROLE_GATED_ACCESS, { 
        path: request.url,
        reason: 'db_role_mismatch',
        dbRole: user?.role,
      });
      return reply.status(404).send({ error: 'Not Found' });
    }
    
    if (user.accountStatus !== 'ACTIVE') {
      await logSecurityEvent(request, userId, SecurityEventType.ROLE_GATED_ACCESS, { 
        path: request.url,
        reason: 'account_not_active',
        status: user.accountStatus,
      });
      return reply.status(403).send({ error: 'Account suspended' });
    }
    
    // Log successful author access for audit
    await logSecurityEvent(request, userId, SecurityEventType.ROLE_GATED_ACCESS, { 
      path: request.url,
      granted: true,
    });
  } catch (err) {
    console.error('Author verification failed:', err);
    return reply.status(500).send({ error: 'Internal error' });
  }
});

fastify.decorate('requireReauth', async (request: any, reply: any) => {
  const userId = request.user?.userId;
  if (!userId) return reply.status(401).send({ error: 'Unauthorized' });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.lastReauthAt) return reply.status(403).send({ error: 'Re-authentication required', code: 'REAUTH_REQUIRED' });

  const ageMinutes = (Date.now() - user.lastReauthAt.getTime()) / 60000;
  // SECURITY: 5-minute window for reauth gate (tightened from 30 min)
  if (ageMinutes > 5) {
    return reply.status(403).send({ error: 'Re-authentication expired', code: 'REAUTH_REQUIRED' });
  }

  // SECURITY: Reauth must have happened AFTER this token was issued.
  // Prevents stolen pre-reauth tokens from passing the gate.
  const tokenIat = request.user?.iat;
  if (tokenIat && user.lastReauthAt.getTime() < tokenIat * 1000) {
    return reply.status(403).send({ error: 'Re-authentication required', code: 'REAUTH_REQUIRED' });
  }
});

// Customer portal gating: only APPROVED customers can use usage/provision/billing APIs
fastify.decorate('requireCustomerApproved', async (request: any, reply: any) => {
  if (request.user?.role !== 'CUSTOMER') {
    await logSecurityEvent(request, request.user?.userId || null, SecurityEventType.ROLE_GATED_ACCESS, {
      path: request.url,
      reason: 'customer_route_non_customer',
      role: request.user?.role || null,
    });
    return reply.status(404).send({ error: 'Not Found' });
  }
  const userId = request.user?.userId;
  if (!userId) return reply.status(401).send({ error: 'Unauthorized' });
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { customerAccessStatus: true, isAlphaTester: true },
  });
  const status = resolveCustomerAccessStatus(user);
  if (status !== 'APPROVED') {
    return reply.status(403).send({
      error: 'Customer access not approved.',
      errorCode: 'CUSTOMER_NOT_APPROVED',
      customerAccessStatus: status,
    });
  }
});

// SECURITY: In production, do not expose internal errors to the client
fastify.setErrorHandler((err: any, request, reply) => {
  request.log?.error?.(err);
  const statusCode = err.statusCode ?? 500;
  const isCsrfError = typeof err.code === 'string' && err.code.startsWith('FST_CSRF_');
  const errorCode =
    isCsrfError
      ? 'CSRF_TOKEN_INVALID'
      : typeof err.code === 'string'
      ? err.code
      : statusCode === 400
        ? 'BAD_REQUEST'
        : statusCode === 401
          ? 'UNAUTHORIZED'
          : statusCode === 403
            ? 'FORBIDDEN'
            : statusCode === 404
              ? 'NOT_FOUND'
              : statusCode === 409
                ? 'CONFLICT'
                : statusCode === 429
                  ? 'RATE_LIMITED'
                  : 'INTERNAL_ERROR';

  const message =
    isCsrfError
      ? 'Invalid or missing CSRF token.'
      : statusCode >= 500
      ? 'Internal server error'
      : statusCode === 400
        ? 'Bad request'
        : statusCode === 401
          ? 'Unauthorized'
          : statusCode === 403
            ? 'Forbidden'
            : statusCode === 404
              ? 'Not found'
              : statusCode === 409
                ? 'Conflict'
                : statusCode === 429
                  ? 'Too many requests'
                  : 'Request failed';

  reply.status(statusCode).send({
    errorCode,
    message,
    error: message,
    requestId: request.id,
  });
});

// Register routes
fastify.register(authRoutes, { prefix: '/auth' });
fastify.register(publicRoutes, { prefix: '/api/public' });
fastify.register(userRoutes, { prefix: '/users' });
fastify.register(workspaceRoutes, { prefix: '/workspaces' });
fastify.register(internalAgentRoutes, { prefix: '/internal/agent' });
fastify.register(billingRoutes, { prefix: '/billing' });
fastify.register(authorPostRoutes, { prefix: '/api/author/posts' });
fastify.register(authorBannerRoutes, { prefix: '/api/author/banner' });
fastify.register(authorAuditRoutes, { prefix: '/api/author/audit' });
fastify.register(authorUsageRoutes, { prefix: '/api/author/usage' });
fastify.register(authorCustomersRoutes, { prefix: '/api/author/customers' });
fastify.register(customerAccessRoutes, { prefix: '/api/customer' });
fastify.register(recommendRoutes, { prefix: '/api/recommend' });
fastify.register(publicContentRoutes, { prefix: '/api/content' });
fastify.register(opsFleetRoutes, { prefix: '/api/ops/fleet' });
fastify.register(organizationRoutes, { prefix: '/organizations' });
fastify.register(volumeRoutes, { prefix: '/volumes' });
fastify.register(apiKeyRoutes, { prefix: '/api-keys' });
fastify.register(webhookRoutes, { prefix: '/webhooks' });
fastify.register(registryCredentialRoutes, { prefix: '/registry-credentials' });
fastify.register(spotPricingRoutes, { prefix: '/spot-pricing' });
fastify.register(supportRoutes, { prefix: '/support' });
fastify.register(opsTicketRoutes, { prefix: '/api/ops/tickets' });
fastify.register(budgetRoutes, { prefix: '/budget' });

// V1 Control Plane routes
fastify.register(projectRoutes, { prefix: '/v1/projects' });
fastify.register(runRoutes, { prefix: '/v1' });
fastify.register(agentRoutes, { prefix: '/v1/agent' });
fastify.register(githubRoutes, { prefix: '/v1/integrations/github' });

// Admin / Alpha Management (internal)
fastify.post('/api/admin/alpha/allow', { preHandler: [fastify.authenticate as any, fastify.requireAuthor as any] }, async (request: any) => {
  const { email } = z.object({ email: z.string().email() }).parse(request.body);
  const actorId = request.user.userId;
  const user = await prisma.user.findUnique({
    where: { email },
    include: {
      customerApplications: {
        where: { decision: null },
        orderBy: { submittedAt: 'desc' },
        take: 1,
      },
    },
  });

  if (!user) {
    return { ok: false, message: `User ${email} not found.` };
  }

  const pendingApplication = user.customerApplications[0] ?? null;
  const fromStatus = resolveCustomerAccessStatus(user);

  await prisma.$transaction(async (tx) => {
    await tx.user.update({
      where: { id: user.id },
      data: {
        isAlphaTester: true,
        customerAccessStatus: 'APPROVED',
        customerAccessUpdatedAt: new Date(),
        customerAccessUpdatedById: actorId,
        customerAccessReason: null,
      },
    });

    if (pendingApplication) {
      await tx.customerApplication.update({
        where: { id: pendingApplication.id },
        data: {
          decision: 'APPROVED',
          reviewedAt: new Date(),
          reviewedById: actorId,
        },
      });

      const acceptedDedupeKey = `APPLICATION_ACCEPTED:${pendingApplication.id}`;
      const existingAccepted = await tx.emailOutbox.findUnique({
        where: { dedupeKey: acceptedDedupeKey },
        select: { id: true },
      });

      if (!existingAccepted) {
        await tx.emailOutbox.create({
          data: {
            type: 'APPLICATION_ACCEPTED',
            toEmail: user.email,
            userId: user.id,
            applicationId: pendingApplication.id,
            subject: 'Aldaro.AI application approved',
            bodyText: `Hey ${pendingApplication.fullName.split(' ')[0] || pendingApplication.fullName},\n\nYour Aldaro.AI application is approved.\nSign in to access your customer portal and start renting GPUs.\nLogin link: ${process.env.PORTAL_URL || 'https://app.aldaro.ai'}`,
            bodyHtml: null,
            status: 'PENDING',
            dedupeKey: acceptedDedupeKey,
          },
        });
      }
    }

    await tx.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: 'CUSTOMER_APPROVE',
        targetType: 'User',
        targetId: user.id,
        diffJson: JSON.stringify({
          targetUserId: user.id,
          fromStatus,
          toStatus: 'APPROVED',
          source: 'admin_alpha_allow',
          applicationId: pendingApplication?.id ?? null,
        }),
      },
    });
  });

  return { ok: true, message: `User ${email} is now approved for alpha access.` };
});

fastify.get('/health', async () => {
  return { status: 'OK' };
});

export const app = fastify;

// --- Process-level crash discipline ---
// These handlers ensure unhandled errors are visible, logged, and cause a clean exit.
// Fastify handles most request-level errors, but these catch edge cases outside request scope.

process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  console.error(JSON.stringify({
    level: 'fatal',
    service: 'api',
    pid: process.pid,
    timestamp: new Date().toISOString(),
    event: 'unhandled_rejection',
    error: reason?.message || String(reason),
    stack: reason?.stack,
  }));
  // Terminate: unhandled rejections indicate broken control flow.
  // Fastify will drain connections during shutdown.
  process.exit(1);
});

process.on('uncaughtException', (err: Error) => {
  console.error(JSON.stringify({
    level: 'fatal',
    service: 'api',
    pid: process.pid,
    timestamp: new Date().toISOString(),
    event: 'uncaught_exception',
    error: err.message,
    stack: err.stack,
  }));
  // Terminate immediately: process state is unreliable after uncaught exception.
  process.exit(1);
});

const start = async () => {
  if (process.env.NODE_ENV === 'test') return;
  // NOTE: Worker lifecycle management runs in standalone worker service.
  // API remains stateless for horizontal scaling.
  try {
    const port = parseInt(process.env.API_PORT || '4000');
    await fastify.listen({ port, host: '0.0.0.0' });
    console.log(`Server listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
