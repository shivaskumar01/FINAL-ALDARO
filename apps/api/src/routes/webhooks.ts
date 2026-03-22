import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import crypto from 'crypto';
import { dispatchWebhook } from '../lib/webhookDispatch';
import { encryptSecret } from '../lib/encryption';

const prisma = new PrismaClient();

const VALID_WEBHOOK_EVENTS = [
  'run.created',
  'run.started',
  'run.completed',
  'run.failed',
  'workspace.created',
  'workspace.running',
  'workspace.failed',
  'workspace.terminated',
  'billing.usage_recorded',
  'budget.warning',
] as const;

type WebhookEvent = typeof VALID_WEBHOOK_EVENTS[number];

/**
 * SECURITY: Block webhook URLs targeting internal/private IP ranges (SSRF protection).
 */
function isBlockedWebhookUrl(urlStr: string): boolean {
  try {
    const url = new URL(urlStr);
    const hostname = url.hostname.toLowerCase();
    // Block loopback
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '0.0.0.0') return true;
    // Block private IPv4 ranges
    if (/^10\./.test(hostname)) return true;
    if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
    if (/^192\.168\./.test(hostname)) return true;
    // Block link-local / AWS metadata
    if (/^169\.254\./.test(hostname)) return true;
    // Block internal Aldaro domains
    if (hostname.endsWith('.internal') || hostname.endsWith('.local')) return true;
    return false;
  } catch {
    return true; // Invalid URL = blocked
  }
}

const webhookEventSchema = z.string().refine(
  (val): val is WebhookEvent => (VALID_WEBHOOK_EVENTS as readonly string[]).includes(val),
  { message: 'Invalid webhook event type' },
);

const createWebhookSchema = z.object({
  url: z.string().url().max(2048),
  events: z.array(webhookEventSchema).min(1).max(50),
});

const updateWebhookSchema = z.object({
  url: z.string().url().max(2048).optional(),
  events: z.array(webhookEventSchema).min(1).max(50).optional(),
  enabled: z.boolean().optional(),
});

export const webhookRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // All webhook management routes require JWT session auth
  fastify.addHook('preHandler', fastify.authenticate as any);

  // -------------------------------------------------------------------------
  // POST /webhooks — Create a webhook endpoint
  // -------------------------------------------------------------------------
  fastify.post('/', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: any, reply) => {
    const userId = request.user.userId;
    const body = createWebhookSchema.parse(request.body);

    // Limit webhooks per user (max 10)
    const existingCount = await prisma.webhookEndpoint.count({ where: { userId } });
    if (existingCount >= 10) {
      return reply.status(429).send({
        errorCode: 'MAX_WEBHOOKS_REACHED',
        message: 'Maximum of 10 webhook endpoints per account.',
        error: 'Maximum of 10 webhook endpoints per account.',
        requestId: request.id,
      });
    }

    // SECURITY: Block SSRF — reject internal/private webhook URLs
    if (isBlockedWebhookUrl(body.url)) {
      return reply.status(400).send({
        errorCode: 'INVALID_WEBHOOK_URL',
        message: 'Webhook URL must not target internal or private IP addresses.',
        error: 'Webhook URL must not target internal or private IP addresses.',
        requestId: request.id,
      });
    }

    // Auto-generate HMAC signing secret
    const rawSecret = `whsec_${crypto.randomBytes(32).toString('base64url')}`;
    // Encrypt at rest — decrypted on dispatch for HMAC signing
    const encryptedSecret = encryptSecret(rawSecret);

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        userId,
        url: body.url,
        secret: encryptedSecret,
        events: JSON.stringify(body.events),
      },
    });

    return reply.status(201).send({
      id: endpoint.id,
      url: endpoint.url,
      events: JSON.parse(endpoint.events),
      secret: rawSecret,
      enabled: endpoint.enabled,
      createdAt: endpoint.createdAt,
      _notice: 'Store the signing secret securely. It will not be shown again.',
    });
  });

  // -------------------------------------------------------------------------
  // GET /webhooks — List user's webhook endpoints
  // -------------------------------------------------------------------------
  fastify.get('/', async (request: any) => {
    const userId = request.user.userId;

    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { userId },
      select: {
        id: true,
        url: true,
        events: true,
        enabled: true,
        failureCount: true,
        lastDeliveredAt: true,
        lastFailedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      items: endpoints.map((ep) => ({
        ...ep,
        events: JSON.parse(ep.events),
      })),
    };
  });

  // -------------------------------------------------------------------------
  // PUT /webhooks/:id — Update endpoint url/events/enabled
  // -------------------------------------------------------------------------
  fastify.put('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;
    const body = updateWebhookSchema.parse(request.body);

    // SECURITY: Block SSRF on URL updates
    if (body.url && isBlockedWebhookUrl(body.url)) {
      return reply.status(400).send({
        errorCode: 'INVALID_WEBHOOK_URL',
        message: 'Webhook URL must not target internal or private IP addresses.',
        error: 'Webhook URL must not target internal or private IP addresses.',
        requestId: request.id,
      });
    }

    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Webhook endpoint not found.',
        error: 'Webhook endpoint not found.',
        requestId: request.id,
      });
    }

    const updated = await prisma.webhookEndpoint.update({
      where: { id },
      data: {
        ...(body.url !== undefined && { url: body.url }),
        ...(body.events !== undefined && { events: JSON.stringify(body.events) }),
        ...(body.enabled !== undefined && { enabled: body.enabled }),
        // Reset failure count if re-enabling
        ...(body.enabled === true && { failureCount: 0 }),
      },
      select: {
        id: true,
        url: true,
        events: true,
        enabled: true,
        failureCount: true,
        lastDeliveredAt: true,
        lastFailedAt: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    return {
      ok: true,
      endpoint: {
        ...updated,
        events: JSON.parse(updated.events),
      },
    };
  });

  // -------------------------------------------------------------------------
  // DELETE /webhooks/:id — Delete a webhook endpoint
  // -------------------------------------------------------------------------
  fastify.delete('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;

    const existing = await prisma.webhookEndpoint.findFirst({
      where: { id, userId },
    });

    if (!existing) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Webhook endpoint not found.',
        error: 'Webhook endpoint not found.',
        requestId: request.id,
      });
    }

    // Delete deliveries first, then endpoint
    await prisma.$transaction([
      prisma.webhookDelivery.deleteMany({ where: { endpointId: id } }),
      prisma.webhookEndpoint.delete({ where: { id } }),
    ]);

    return { ok: true, message: 'Webhook endpoint deleted.' };
  });

  // -------------------------------------------------------------------------
  // POST /webhooks/:id/test — Send a test webhook delivery
  // -------------------------------------------------------------------------
  fastify.post('/:id/test', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;

    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id, userId },
    });

    if (!endpoint) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Webhook endpoint not found.',
        error: 'Webhook endpoint not found.',
        requestId: request.id,
      });
    }

    const testPayload = {
      event: 'webhook.test',
      data: {
        message: 'This is a test webhook delivery from Aldaro.AI',
        timestamp: new Date().toISOString(),
      },
    };

    // Dispatch a test event directly to this endpoint
    try {
      await dispatchWebhook('webhook.test', testPayload.data, userId, id);
      return { ok: true, message: 'Test webhook dispatched.' };
    } catch (err: any) {
      return reply.status(502).send({
        errorCode: 'WEBHOOK_DELIVERY_FAILED',
        message: `Test delivery failed: ${err.message}`,
        error: `Test delivery failed: ${err.message}`,
        requestId: request.id,
      });
    }
  });

  // -------------------------------------------------------------------------
  // GET /webhooks/:id/deliveries — List recent deliveries
  // -------------------------------------------------------------------------
  fastify.get('/:id/deliveries', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;
    const { limit = '20', cursor } = request.query as any;

    // Verify ownership
    const endpoint = await prisma.webhookEndpoint.findFirst({
      where: { id, userId },
    });

    if (!endpoint) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Webhook endpoint not found.',
        error: 'Webhook endpoint not found.',
        requestId: request.id,
      });
    }

    const take = Math.min(parseInt(limit) || 20, 100);

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { endpointId: id },
      take,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        event: true,
        responseStatus: true,
        attemptCount: true,
        deliveredAt: true,
        nextRetryAt: true,
        status: true,
        createdAt: true,
      },
    });

    const next_cursor = deliveries.length === take ? deliveries[deliveries.length - 1].id : null;

    return { items: deliveries, next_cursor };
  });
};
