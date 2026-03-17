import crypto from 'crypto';
import { resolveCustomerAccessStatus } from './customerAccess';

export const SESSION_COOKIE_NAME = 'aldaro_session';

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

export function getSessionCookieOptions(isProduction: boolean) {
  return {
    path: '/',
    httpOnly: true,
    secure: isProduction,
    sameSite: 'strict' as const,
    maxAge: 3600 * 12,
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

export function getRedirectForUser(user: SessionUserLike) {
  if (user.role === 'AUTHOR') return '/author';

  const status = resolveCustomerAccessStatus(user);
  if (status === 'APPROVED') return '/app';
  if (status === 'PENDING_REVIEW') return '/pending-review';
  return '/access-denied';
}
