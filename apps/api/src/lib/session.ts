import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { resolveCustomerAccessStatus } from './customerAccess';

export const SESSION_COOKIE_NAME = 'aldaro_session';
export const REFRESH_COOKIE_NAME = 'aldaro_refresh';

type SessionUserLike = {
  id: string;
  role: string;
  passwordHash?: string | null;
  customerAccessStatus?: string | null;
  isAlphaTester?: boolean | null;
};

export type SessionTokenPayload = {
  userId: string;
  role: string;
  jti: string;
  pwdv: string;
};

export type RefreshTokenPayload = {
  userId: string;
  pwdv: string;
  type: 'refresh';
};

export function getSessionCookieOptions(isProduction: boolean) {
  return {
    path: '/',
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
    maxAge: 60 * 15, // Match access JWT TTL (15 minutes)
  };
}

export function getRefreshCookieOptions(isProduction: boolean) {
  return {
    path: '/auth',
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
    maxAge: 7 * 24 * 3600, // 7 days
  };
}

export function buildPasswordVersion(passwordHash: string) {
  return crypto.createHash('sha256').update(passwordHash).digest('hex').slice(0, 24);
}

export function buildSessionTokenPayload(user: Pick<SessionUserLike, 'id' | 'role' | 'passwordHash'>): SessionTokenPayload {
  if (!user.passwordHash) {
    throw new Error('passwordHash is required to build a session token');
  }

  return {
    userId: user.id,
    role: user.role,
    jti: crypto.randomUUID(),
    pwdv: buildPasswordVersion(user.passwordHash),
  };
}

export function buildRefreshToken(
  user: Pick<SessionUserLike, 'id' | 'passwordHash'>,
  secret: string,
): string {
  if (!user.passwordHash) {
    throw new Error('passwordHash is required to build a refresh token');
  }
  return jwt.sign(
    { userId: user.id, pwdv: buildPasswordVersion(user.passwordHash), type: 'refresh' },
    secret,
    { algorithm: 'HS256', expiresIn: '7d' },
  );
}

export function verifyRefreshToken(token: string, secret: string): RefreshTokenPayload {
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] }) as any;
  if (decoded.type !== 'refresh') {
    throw new Error('Invalid token type');
  }
  return decoded as RefreshTokenPayload;
}

export function getRedirectForUser(user: SessionUserLike) {
  if (user.role === 'AUTHOR') return '/author';

  const status = resolveCustomerAccessStatus(user);
  if (status === 'APPROVED') return '/app';
  if (status === 'PENDING_REVIEW') return '/pending-review';
  return '/access-denied';
}
