import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import crypto from 'crypto';

const prisma = new PrismaClient();

const API_KEY_PREFIX = 'ak_live_';

const createApiKeySchema = z.object({
  name: z.string().min(1).max(100).default('Default'),
  scopes: z.string().max(500).default('*'),
  expiresAt: z.string().datetime().optional(),
});

const updateApiKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  scopes: z.string().max(500).optional(),
});

export const apiKeyRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // All API key management routes require JWT session auth
  fastify.addHook('preHandler', fastify.authenticate as any);

  // -------------------------------------------------------------------------
  // POST /api-keys, Generate a new API key
  // -------------------------------------------------------------------------
  fastify.post('/', async (request: any, reply) => {
    const userId = request.user.userId;
    const body = createApiKeySchema.parse(request.body);

    // Generate a cryptographically secure random key
    const rawKeyBytes = crypto.randomBytes(48);
    const rawKey = API_KEY_PREFIX + rawKeyBytes.toString('base64url');
    const keyPrefix = rawKey.slice(0, 12); // e.g. "ak_live_XXXX"
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');

    const apiKey = await prisma.apiKey.create({
      data: {
        userId,
        name: body.name,
        keyPrefix,
        keyHash,
        scopes: body.scopes,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
      },
    });

    // Return the raw key ONCE, it cannot be retrieved again
    return reply.status(201).send({
      id: apiKey.id,
      name: apiKey.name,
      keyPrefix: apiKey.keyPrefix,
      key: rawKey,
      scopes: apiKey.scopes,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      _notice: 'Store this key securely. It will not be shown again.',
    });
  });

  // -------------------------------------------------------------------------
  // GET /api-keys, List user's API keys (never show raw key)
  // -------------------------------------------------------------------------
  fastify.get('/', async (request: any) => {
    const userId = request.user.userId;

    const keys = await prisma.apiKey.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        revoked: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return { items: keys };
  });

  // -------------------------------------------------------------------------
  // PUT /api-keys/:id, Update key name or scopes
  // -------------------------------------------------------------------------
  fastify.put('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;
    const body = updateApiKeySchema.parse(request.body);

    const existing = await prisma.apiKey.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'API key not found.',
        error: 'API key not found.',
        requestId: request.id,
      });
    }

    const updated = await prisma.apiKey.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.scopes !== undefined && { scopes: body.scopes }),
      },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        lastUsedAt: true,
        expiresAt: true,
        revoked: true,
        createdAt: true,
      },
    });

    return { ok: true, apiKey: updated };
  });

  // -------------------------------------------------------------------------
  // DELETE /api-keys/:id, Revoke an API key (soft delete)
  // -------------------------------------------------------------------------
  fastify.delete('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;

    const existing = await prisma.apiKey.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'API key not found.',
        error: 'API key not found.',
        requestId: request.id,
      });
    }

    await prisma.apiKey.update({
      where: { id },
      data: { revoked: true },
    });

    return { ok: true, message: 'API key revoked.' };
  });
};
