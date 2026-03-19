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
    scopes: apiKey.scopes,
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
