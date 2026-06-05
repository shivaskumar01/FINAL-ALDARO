import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';

const prisma = new PrismaClient();

const API_KEY_PREFIX = 'ak_live_';

/**
 * Checks if the Authorization header contains an API key (ak_live_...).
 * If so, validates the key and decorates the request with apiKeyUser.
 * This is used as a preHandler on routes that accept API key auth.
 */
export async function apiKeyAuthHandler(request: FastifyRequest, reply: FastifyReply) {
  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
    return reply.status(401).send({
      errorCode: 'UNAUTHORIZED',
      message: 'Missing or invalid API key.',
      error: 'Missing or invalid API key.',
      requestId: request.id,
    });
  }

  const rawKey = authHeader.slice('Bearer '.length).trim();
  const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

  const apiKey = await prisma.apiKey.findUnique({
    where: { keyHash },
    include: { user: { select: { accountStatus: true } } },
  });

  if (!apiKey) {
    return reply.status(401).send({
      errorCode: 'UNAUTHORIZED',
      message: 'Invalid API key.',
      error: 'Invalid API key.',
      requestId: request.id,
    });
  }

  if (apiKey.revoked) {
    return reply.status(401).send({
      errorCode: 'API_KEY_REVOKED',
      message: 'This API key has been revoked.',
      error: 'This API key has been revoked.',
      requestId: request.id,
    });
  }

  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    return reply.status(401).send({
      errorCode: 'API_KEY_EXPIRED',
      message: 'This API key has expired.',
      error: 'This API key has expired.',
      requestId: request.id,
    });
  }

  // A9 FIX: API keys must respect account suspension. Unlike JWT sessions (which
  // re-check accountStatus on /auth/refresh within 15 min), API keys never expire,
  // so a suspended/blocked user would otherwise retain full API access indefinitely.
  if (apiKey.user.accountStatus !== 'ACTIVE') {
    return reply.status(403).send({
      errorCode: 'ACCOUNT_SUSPENDED',
      message: 'This account is not active.',
      error: 'This account is not active.',
      requestId: request.id,
    });
  }

  // Update lastUsedAt (fire-and-forget to avoid blocking the request)
  prisma.apiKey.update({
    where: { id: apiKey.id },
    data: { lastUsedAt: new Date() },
  }).catch((err) => {
    console.error('Failed to update API key lastUsedAt:', err);
  });

  // Decorate request with API key user info
  (request as any).apiKeyUser = {
    userId: apiKey.userId,
    organizationId: apiKey.organizationId,
    scopes: parseScopes(apiKey.scopes),
    apiKeyId: apiKey.id,
  };

  // Also set request.user for compatibility with existing auth middleware
  (request as any).user = {
    userId: apiKey.userId,
    role: 'CUSTOMER',
    accountStatus: 'ACTIVE',
  };
}

/**
 * Parse scope string into a Set. Supports "*" (all) or comma-separated values.
 */
function parseScopes(scopeStr: string): Set<string> {
  if (!scopeStr || scopeStr.trim() === '*') return new Set(['*']);
  return new Set(scopeStr.split(',').map(s => s.trim()).filter(Boolean));
}

/**
 * Check if request has the required scope.
 * Wildcard "*" grants all scopes. JWT session auth (no apiKeyUser) is always allowed.
 */
function hasScope(request: FastifyRequest, scope: string): boolean {
  const apiKeyUser = (request as any).apiKeyUser;
  // JWT session auth — no scope restriction
  if (!apiKeyUser) return true;
  const scopes: Set<string> = apiKeyUser.scopes;
  return scopes.has('*') || scopes.has(scope);
}

/**
 * Returns a preHandler that enforces the given scope on API key requests.
 * Usage: { preHandler: [dualAuth, requireScope('workspaces:write')] }
 */
export function requireScope(scope: string) {
  return async function scopeHandler(request: FastifyRequest, reply: FastifyReply) {
    if (!hasScope(request, scope)) {
      return reply.status(403).send({
        errorCode: 'INSUFFICIENT_SCOPE',
        message: `This API key does not have the required scope: ${scope}`,
        error: `This API key does not have the required scope: ${scope}`,
        requestId: request.id,
      });
    }
  };
}

/**
 * Middleware that accepts EITHER JWT session auth OR API key auth.
 * Tries JWT first (via cookie/bearer token), falls back to API key.
 */
export function buildDualAuthHandler(fastify: FastifyInstance) {
  return async function dualAuthHandler(request: FastifyRequest, reply: FastifyReply) {
    const authHeader = request.headers.authorization;

    // If the bearer token starts with the API key prefix, use API key auth
    if (authHeader && authHeader.startsWith(`Bearer ${API_KEY_PREFIX}`)) {
      return apiKeyAuthHandler(request, reply);
    }

    // Otherwise, delegate to standard JWT authenticate
    return (fastify.authenticate as any)(request, reply);
  };
}
