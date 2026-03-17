import { PrismaClient } from '@prisma/client';
import { FastifyRequest } from 'fastify';

const prisma = new PrismaClient();

export enum SecurityEventType {
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILURE = 'LOGIN_FAILURE',
  LOGOUT = 'LOGOUT',
  PW_RESET_REQ = 'PW_RESET_REQ',
  PW_RESET_DONE = 'PW_RESET_DONE',
  ROLE_GATED_ACCESS = 'ROLE_GATED_ACCESS',
  PAYMENT_METHOD_CHANGE = 'PAYMENT_METHOD_CHANGE',
}

export async function logSecurityEvent(
  request: FastifyRequest,
  userId: string | null,
  eventType: SecurityEventType,
  eventData?: any
) {
  try {
    await prisma.securityLog.create({
      data: {
        userId,
        eventType,
        ip: request.ip,
        userAgent: request.headers['user-agent'] || null,
        eventData: eventData ? JSON.stringify(eventData) : null,
      },
    });
  } catch (err) {
    console.error('Failed to log security event:', err);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Password policy: 15-128 chars, at least one upper, one lower, one digit, one symbol.
 * Prevents weak passwords and brute-force.
 */
export function validatePassword(password: string): boolean {
  if (password.length < 15 || password.length > 128) return false;
  if (!/[A-Z]/.test(password)) return false;
  if (!/[a-z]/.test(password)) return false;
  if (!/[0-9]/.test(password)) return false;
  if (!/[^A-Za-z0-9]/.test(password)) return false; // at least one symbol
  return true;
}

/** Generic error message for password validation (no hints to attackers). */
export const PASSWORD_REQUIREMENTS_MSG =
  'Password must be 15–128 characters with upper, lower, digit, and symbol.';
