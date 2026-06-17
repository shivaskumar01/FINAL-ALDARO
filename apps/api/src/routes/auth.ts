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
import { revokeJti } from '../lib/ephemeralStore';
import {
  buildPasswordVersion,
  buildRefreshToken,
  buildSessionTokenPayload,
  getRedirectForUser,
  getRefreshCookieOptions,
  getSessionCookieOptions,
  REFRESH_COOKIE_NAME,
  SESSION_COOKIE_NAME,
  verifyRefreshToken,
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

// Periodic cleanup of stale throttle entries to prevent memory leak
setInterval(() => {
  const now = Date.now();
  for (const [key, state] of loginThrottleByKey) {
    // Remove entries whose window has expired AND are not locked
    if (now - state.windowStartedAt > LOGIN_WINDOW_MS && (!state.lockUntil || state.lockUntil < now)) {
      loginThrottleByKey.delete(key);
    }
  }
}, 60_000); // Clean up every minute

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
  email: z.string().email().max(320),
  password: z.string().min(1).max(256),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().length(64).regex(/^[a-f0-9]+$/), // 32 random bytes -> 64 hex chars
  newPassword: z.string().min(1).max(256),
});

export const authRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store, private, max-age=0');
    reply.header('Pragma', 'no-cache');
    return payload;
  });

  // CSRF token endpoint
  fastify.get('/csrf', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (request, reply) => {
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
    // SECURITY: Detect CLI by absence of browser indicators (cookie + origin).
    // Browsers always send Origin on cross-origin POST; CLI clients don't use cookies.
    // This prevents browser JS from spoofing x-aldaro-client to bypass Origin checks.
    const hasCookies = !!(request.cookies && Object.keys(request.cookies).length > 0);
    const hasOrigin = !!((request.headers as any).origin);
    const isCliClient = !hasCookies && !hasOrigin && request.headers['x-aldaro-client'] === 'cli';

    // SECURITY: Validate Origin header on login to prevent cross-origin login CSRF.
    // CLI clients don't send Origin, so skip for them.
    if (!isCliClient) {
      const origin = (request.headers as any).origin as string | undefined;
      const isProd = process.env.NODE_ENV === 'production';
      const appBaseUrl = process.env.APP_BASE_URL;
      const isValidOrigin = isProd
        ? (origin === appBaseUrl)
        : (!origin || ['http://localhost:3000', 'http://localhost:3001', 'http://127.0.0.1:3000', 'http://127.0.0.1:3001'].includes(origin));
      if (!isValidOrigin) {
        return reply.status(403).send({ error: 'Forbidden origin.' });
      }
    }
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

    // SECURITY: Always run bcrypt.compare even when user is not found,
    // so response timing doesn't reveal whether the email exists.
    const DUMMY_HASH = '$2b$12$LJ3m4ys3Lg2VBe5E5hYGdOa1lMHaBPRvBNAPsXwXKiU3CkVha.XYG';
    const hashToCompare = user?.passwordHash ?? DUMMY_HASH;
    const valid = await bcrypt.compare(password, hashToCompare);

    if (!user) return fail();
    if (user.accountStatus !== 'ACTIVE') return fail('ACCOUNT_NOT_ACTIVE');
    if (!valid) return fail();

    const accessToken = fastify.jwt.sign(buildSessionTokenPayload(user));
    const refreshSecret = process.env.JWT_REFRESH_SECRET || (IS_PRODUCTION ? '' : 'dev-cookie-secret');
    const refreshToken = buildRefreshToken(user, refreshSecret);

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

    return reply
      .setCookie(SESSION_COOKIE_NAME, accessToken, getSessionCookieOptions(IS_PRODUCTION))
      .setCookie(REFRESH_COOKIE_NAME, refreshToken, getRefreshCookieOptions(IS_PRODUCTION))
      .send({
        ok: true,
        role: user.role,
        token: isCliClient ? accessToken : undefined,
        refreshToken: isCliClient ? refreshToken : undefined,
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
        // SECURITY: verify signature, don't just decode, prevents forged userId in logs
        const decoded = fastify.jwt.verify(token) as any;
        userId = decoded?.userId;
        // A13: revoke this access token's jti for its remaining TTL so a stolen token
        // cannot be used after logout (closes the 15-min stateless-JWT window).
        if (decoded?.jti) {
          const ttl = decoded.exp ? Math.max(1, decoded.exp - Math.floor(Date.now() / 1000)) : 900;
          await revokeJti(decoded.jti, ttl);
        }
      }
    } catch {}

    await logSecurityEvent(request, userId, SecurityEventType.LOGOUT);

    return reply
      .clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(IS_PRODUCTION))
      .clearCookie(REFRESH_COOKIE_NAME, getRefreshCookieOptions(IS_PRODUCTION))
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

  // POST /auth/refresh, Silent token refresh
  // SECURITY: This is the enforcement point for session revocation.
  // Blocked/banned users are rejected here, forcing logout within 15 minutes.
  // CSRF exempt: protected by sameSite:strict on refresh cookie + CORS policy.
  fastify.post('/refresh', {
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute',
      },
    },
  }, async (request: any, reply) => {
    // Accept refresh token from cookie (browser) or request body (CLI)
    const refreshCookie = request.cookies[REFRESH_COOKIE_NAME];
    const bodyToken = (request.body as any)?.refreshToken;
    const token = refreshCookie || bodyToken;

    if (!token || typeof token !== 'string') {
      return reply.status(401).send({ error: 'Missing refresh token' });
    }

    const refreshSecret = process.env.JWT_REFRESH_SECRET || (IS_PRODUCTION ? '' : 'dev-cookie-secret');
    if (!refreshSecret) {
      return reply.status(500).send({ error: 'Server misconfigured' });
    }

    let payload;
    try {
      payload = verifyRefreshToken(token, refreshSecret);
    } catch {
      return reply.status(401).send({ error: 'Invalid or expired refresh token' });
    }

    // SECURITY: DB check, verify user is still active and password hasn't changed
    const user = await prisma.user.findUnique({
      where: { id: payload.userId },
      select: {
        id: true,
        role: true,
        accountStatus: true,
        passwordHash: true,
        customerAccessStatus: true,
        isAlphaTester: true,
      },
    });

    if (!user) {
      return reply.status(401).send({ error: 'Invalid refresh token' });
    }

    // SECURITY: Reject BLOCKED/banned users, forces logout within 15 minutes
    if (user.accountStatus !== 'ACTIVE') {
      await logSecurityEvent(request, user.id, SecurityEventType.LOGIN_FAILURE, {
        reason: 'REFRESH_BLOCKED_USER',
        accountStatus: user.accountStatus,
      });
      return reply
        .clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(IS_PRODUCTION))
        .clearCookie(REFRESH_COOKIE_NAME, getRefreshCookieOptions(IS_PRODUCTION))
        .status(401)
        .send({ error: 'Account suspended', code: 'ACCOUNT_BLOCKED' });
    }

    // SECURITY: Reject if password changed since refresh token was issued
    if (buildPasswordVersion(user.passwordHash) !== payload.pwdv) {
      return reply
        .clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(IS_PRODUCTION))
        .clearCookie(REFRESH_COOKIE_NAME, getRefreshCookieOptions(IS_PRODUCTION))
        .status(401)
        .send({ error: 'Session invalidated', code: 'PASSWORD_CHANGED' });
    }

    // Issue new access JWT + rotate refresh token
    const accessToken = fastify.jwt.sign(buildSessionTokenPayload(user));
    const newRefreshToken = buildRefreshToken(user, refreshSecret);

    // SECURITY: Detect CLI by absence of browser indicators (cookie + origin).
    // Browsers always send Origin on cross-origin POST; CLI clients don't use cookies.
    // This prevents browser JS from spoofing x-aldaro-client to bypass Origin checks.
    const hasCookies = !!(request.cookies && Object.keys(request.cookies).length > 0);
    const hasOrigin = !!((request.headers as any).origin);
    const isCliClient = !hasCookies && !hasOrigin && request.headers['x-aldaro-client'] === 'cli';
    const redirect_to = getRedirectForUser(user);
    const customerAccessStatus = user.role === 'CUSTOMER'
      ? resolveCustomerAccessStatus(user)
      : null;

    return reply
      .setCookie(SESSION_COOKIE_NAME, accessToken, getSessionCookieOptions(IS_PRODUCTION))
      .setCookie(REFRESH_COOKIE_NAME, newRefreshToken, getRefreshCookieOptions(IS_PRODUCTION))
      .send({
        ok: true,
        role: user.role,
        token: isCliClient ? accessToken : undefined,
        refreshToken: isCliClient ? newRefreshToken : undefined,
        redirect_to,
        customerAccessStatus,
      });
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
      
      // SECURITY: Token sent via email outbox only, never log raw tokens.
      console.log(`[Auth] Password reset requested for user ${user.id}`);
    }

    // Always return success to prevent enumeration
    return { ok: true, message: 'If an account exists, a reset link has been sent.' };
  });

  fastify.post('/reset-password', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
      },
    },
  }, async (request, reply) => {
    const { token, newPassword } = resetPasswordSchema.parse(request.body);

    if (!validatePassword(newPassword)) {
      return reply.status(400).send({ error: PASSWORD_REQUIREMENTS_MSG });
    }

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    // SECURITY: Atomic find-and-clear in a transaction to prevent race conditions
    // where two concurrent requests could both consume the same token.
    const passwordHash = await bcrypt.hash(newPassword, 12);
    const user = await prisma.$transaction(async (tx: any) => {
      const found = await tx.user.findFirst({
        where: {
          passwordResetTokenHash: tokenHash,
          passwordResetExpiresAt: { gt: new Date() },
        },
      });
      if (!found) return null;

      await tx.user.update({
        where: { id: found.id },
        data: {
          passwordHash,
          passwordResetTokenHash: null,
          passwordResetExpiresAt: null,
          lastReauthAt: null,
        },
      });
      return found;
    });

    if (!user) {
      return reply.status(400).send({ error: 'Invalid or expired reset token.' });
    }

    await logSecurityEvent(request, user.id, SecurityEventType.PW_RESET_DONE);

    // After password reset, revoke all active sessions by clearing both cookies.
    // The refresh token's pwdv will also mismatch on any other device, forcing re-login.
    return reply
      .clearCookie(SESSION_COOKIE_NAME, getSessionCookieOptions(IS_PRODUCTION))
      .clearCookie(REFRESH_COOKIE_NAME, getRefreshCookieOptions(IS_PRODUCTION))
      .send({ ok: true, message: 'Password has been reset. Please login with your new password.' });
  });

  fastify.post('/reauth', {
    preHandler: fastify.authenticate as any,
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '15 minutes',
        keyGenerator: (request: any) => request.user?.userId || request.ip,
      },
    },
  }, async (request: any, reply) => {
    const { password } = z.object({ password: z.string() }).parse(request.body);
    const userId = request.user.userId;

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(401).send({ error: 'Unauthorized' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      await logSecurityEvent(request, userId, SecurityEventType.LOGIN_FAILURE, { reason: 'REAUTH_FAILED' });
      return reply.status(401).send({ error: 'Invalid credentials.' });
    }

    await prisma.user.update({
      where: { id: userId },
      data: { lastReauthAt: new Date() },
    });

    return { ok: true };
  });
};
