import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { 
  logSecurityEvent, 
  SecurityEventType, 
  normalizeEmail, 
  validatePassword,
  PASSWORD_REQUIREMENTS_MSG,
} from '../lib/security';
import crypto from 'crypto';
import { resolveCustomerAccessStatus } from '../lib/customerAccess';
import {
  buildSessionTokenPayload,
  getRedirectForUser,
  getSessionCookieOptions,
  SESSION_COOKIE_NAME,
} from '../lib/session';

const prisma = new PrismaClient();
const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const MAX_LOGIN_FAILURES = IS_PRODUCTION ? 5 : 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const LOGIN_LOCK_MS = IS_PRODUCTION ? 30 * 60_000 : 2 * 60_000;
const LOGIN_RATE_LIMIT_MAX = IS_PRODUCTION ? 5 : 30;

type LoginThrottleState = {
  count: number;
  windowStartedAt: number;
  lockUntil: number | null;
};

const loginThrottleByKey = new Map<string, LoginThrottleState>();

function getLoginThrottleKeys(email: string, ip: string) {
  const keys = [
    `email:${email}`,
    `email-ip:${email}|${ip}`,
  ];
  // In production, add IP-wide lockouts to slow broad credential stuffing.
  // In local development, this is too disruptive when testing multiple accounts.
  if (IS_PRODUCTION) {
    keys.push(`ip:${ip}`);
  }
  return keys;
}

function getLoginThrottleState(key: string, now: number) {
  const current = loginThrottleByKey.get(key);
  if (!current || now - current.windowStartedAt > LOGIN_WINDOW_MS) {
    const fresh = { count: 0, windowStartedAt: now, lockUntil: null };
    loginThrottleByKey.set(key, fresh);
    return fresh;
  }
  return current;
}

function getActiveThrottleLock(keys: string[], now: number) {
  for (const key of keys) {
    const state = getLoginThrottleState(key, now);
    if (state.lockUntil && state.lockUntil > now) {
      return state.lockUntil;
    }
  }
  return null;
}

function recordLoginFailure(keys: string[], now: number) {
  for (const key of keys) {
    const state = getLoginThrottleState(key, now);
    state.count += 1;
    if (state.count >= MAX_LOGIN_FAILURES) {
      state.lockUntil = now + LOGIN_LOCK_MS;
    }
    loginThrottleByKey.set(key, state);
  }
}

function clearLoginFailures(keys: string[]) {
  for (const key of keys) {
    loginThrottleByKey.delete(key);
  }
}

const loginSchema = z.object({
  email: z.string(),
  password: z.string(),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string(),
  newPassword: z.string(),
});

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store, private, max-age=0');
    reply.header('Pragma', 'no-cache');
    return payload;
  });

  // CSRF token endpoint
  fastify.get('/csrf', async (request, reply) => {
    const token = await reply.generateCsrf();
    return { token };
  });

  fastify.post('/signup', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute'
      }
    }
  }, async (_request, reply) => {
    return reply.status(404).send({ error: 'Not Found' });
  });

  fastify.post('/login', {
    config: {
      rateLimit: {
        max: LOGIN_RATE_LIMIT_MAX,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const { email: rawEmail, password } = loginSchema.parse(request.body);
    const email = normalizeEmail(rawEmail);
    const isCliClient = request.headers['x-aldaro-client'] === 'cli';
    const now = Date.now();
    const throttleKeys = getLoginThrottleKeys(email, request.ip);
    const activeLockUntil = getActiveThrottleLock(throttleKeys, now);

    if (activeLockUntil && activeLockUntil > now) {
      await logSecurityEvent(request, null, SecurityEventType.LOGIN_FAILURE, { email, reason: 'LOGIN_THROTTLED' });
      reply.header('Retry-After', String(Math.ceil((activeLockUntil - now) / 1000)));
      return reply.status(429).send({ error: 'Too many login attempts. Try again later.' });
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: { id: true, passwordHash: true, role: true, accountStatus: true, customerAccessStatus: true, isAlphaTester: true },
    });
    
    const fail = async (reason?: string) => {
      recordLoginFailure(throttleKeys, now);
      await logSecurityEvent(request, user?.id || null, SecurityEventType.LOGIN_FAILURE, { email, reason: reason || 'INVALID_CREDENTIALS' });
      // Always return generic error
      return reply.status(401).send({ error: 'Invalid credentials.' });
    };

    if (!user) return fail();
    if (user.accountStatus !== 'ACTIVE') return fail('ACCOUNT_NOT_ACTIVE');

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return fail();

    // Constant-time comparison for secrets is handled by bcrypt.compare

    const token = fastify.jwt.sign(buildSessionTokenPayload(user));

    await logSecurityEvent(request, user.id, SecurityEventType.LOGIN_SUCCESS);

    await prisma.user.update({
      where: { id: user.id },
      data: { lastLoginAt: new Date() },
    });
    clearLoginFailures(throttleKeys);

    const redirect_to = getRedirectForUser(user);
    const customerAccessStatus = user.role === 'CUSTOMER'
      ? resolveCustomerAccessStatus(user)
      : null;

    const isProduction = process.env.NODE_ENV === 'production';
    return reply
      .setCookie(SESSION_COOKIE_NAME, token, getSessionCookieOptions(isProduction))
      .send({ 
        ok: true,
        role: user.role,
        token: isCliClient ? token : undefined,
        redirect_to,
        customerAccessStatus,
      });
  });

  fastify.post('/logout', async (request, reply) => {
    // Get user id from token if possible for logging
    let userId: string | null = null;
    try {
      const token = request.cookies[SESSION_COOKIE_NAME];
      if (token) {
        const decoded = fastify.jwt.decode(token) as any;
        userId = decoded?.userId;
      }
    } catch {}

    await logSecurityEvent(request, userId, SecurityEventType.LOGOUT);

    return reply
      .clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(process.env.NODE_ENV === 'production'))
      .send({ ok: true });
  });

  fastify.get('/session', {
    preHandler: fastify.authenticate as any,
  }, async (request: any, reply) => {
    const userId = request.user.userId;
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        role: true,
        accountStatus: true,
        customerAccessStatus: true,
        isAlphaTester: true,
      },
    });

    if (!user || user.accountStatus !== 'ACTIVE') {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    return {
      ok: true,
      userId: user.id,
      role: user.role,
      accountStatus: user.accountStatus,
      customerAccessStatus: user.role === 'CUSTOMER'
        ? resolveCustomerAccessStatus(user)
        : null,
      redirect_to: getRedirectForUser(user),
    };
  });

  fastify.post('/forgot-password', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: '1 minute'
      }
    }
  }, async (request, reply) => {
    const { email: rawEmail } = forgotPasswordSchema.parse(request.body);
    const email = normalizeEmail(rawEmail);

    const user = await prisma.user.findUnique({ where: { email } });
    
    if (user) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');
      
      await prisma.user.update({
        where: { id: user.id },
        data: {
          passwordResetTokenHash: resetTokenHash,
          passwordResetExpiresAt: new Date(Date.now() + 3600000), // 1 hour TTL
        },
      });

      await logSecurityEvent(request, user.id, SecurityEventType.PW_RESET_REQ);
      
      // In a real app, send email here. For now, we'll just log it.
      console.log(`[DEV] Password reset link: http://localhost:3000/reset-password?token=${resetToken}`);
    }

    // Always return success to prevent enumeration
    return { ok: true, message: 'If an account exists, a reset link has been sent.' };
  });

  fastify.post('/reset-password', async (request, reply) => {
    const { token, newPassword } = resetPasswordSchema.parse(request.body);

    if (!validatePassword(newPassword)) {
      return reply.status(400).send({ error: PASSWORD_REQUIREMENTS_MSG });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const user = await prisma.user.findFirst({
      where: {
        passwordResetTokenHash: tokenHash,
        passwordResetExpiresAt: { gt: new Date() },
      },
    });

    if (!user) {
      return reply.status(400).send({ error: 'Invalid or expired reset token.' });
    }

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordResetTokenHash: null,
        passwordResetExpiresAt: null,
        // Optional: clear lastReauthAt to force re-auth
        lastReauthAt: null,
      },
    });

    await logSecurityEvent(request, user.id, SecurityEventType.PW_RESET_DONE);

    // After password reset, revoke all active sessions by clearing the cookie
    // In a multi-session store system, we would invalidate all sessions in the DB
    return reply
      .clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(process.env.NODE_ENV === 'production'))
      .send({ ok: true, message: 'Password has been reset. Please login with your new password.' });
  });

  fastify.post('/reauth', {
    preHandler: fastify.authenticate as any,
  }, async (request: any, reply) => {
    const { password } = z.object({ password: z.string() }).parse(request.body);
    const userId = request.user.userId;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return reply.status(401).send({ error: 'Invalid credentials.' });

    await prisma.user.update({
      where: { id: userId },
      data: { lastReauthAt: new Date() },
    });

    return { ok: true };
  });
};
