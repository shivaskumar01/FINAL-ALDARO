import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import dns from 'dns/promises';
import { decryptSecret } from '@aldaro/shared';

/**
 * Webhook Delivery Job (A4 FIX)
 *
 * Previously, emitters (e.g. budget-monitor) created `webhookDelivery` rows with
 * status=PENDING, but NOTHING drained them — the only sender was the inline test button.
 * This job delivers PENDING rows with HMAC signing, SSRF protection (fail-closed, A15),
 * exponential backoff, and endpoint auto-disable after repeated failures.
 */

const MAX_ATTEMPTS = 6;
const BACKOFF_MS = [30_000, 120_000, 300_000, 900_000, 3_600_000];
const BATCH = 20;
const SETTLE_MS = 5_000; // let inline (test-button) deliveries settle before the worker grabs them

function nextBackoff(attemptCount: number): number {
  if (attemptCount <= 0) return BACKOFF_MS[0];
  if (attemptCount - 1 >= BACKOFF_MS.length) return BACKOFF_MS[BACKOFF_MS.length - 1];
  return BACKOFF_MS[attemptCount - 1];
}

/**
 * SECURITY (A15): resolve the destination and block private/loopback/link-local ranges.
 * Fails CLOSED — if DNS yields nothing or errors, the delivery is blocked, not allowed.
 */
async function isBlockedDestination(hostname: string): Promise<boolean> {
  try {
    const v4 = await dns.resolve4(hostname).catch(() => [] as string[]);
    const v6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const all = [...v4, ...v6];
    if (all.length === 0) return true;
    for (const ip of all) {
      if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') return true;
      if (/^10\./.test(ip)) return true;
      if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(ip)) return true;
      if (/^192\.168\./.test(ip)) return true;
      if (/^169\.254\./.test(ip)) return true;
      if (ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe80')) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function sign(secret: string, payload: string, timestamp: string): string {
  return crypto.createHmac('sha256', secret).update(`${timestamp}.${payload}`).digest('hex');
}

async function deliverOne(prisma: PrismaClient, delivery: any): Promise<void> {
  const endpoint = delivery.endpoint;

  const fail = async (reason: string, status: number | null = null) => {
    const attemptCount = delivery.attemptCount + 1;
    const exhausted = attemptCount >= MAX_ATTEMPTS;
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: exhausted ? 'FAILED' : 'PENDING',
        responseStatus: status,
        responseBody: reason.slice(0, 4096),
        attemptCount,
        nextRetryAt: exhausted ? null : new Date(Date.now() + nextBackoff(attemptCount)),
      },
    });
    if (exhausted && endpoint) {
      const ep = await prisma.webhookEndpoint.update({
        where: { id: endpoint.id },
        data: { failureCount: { increment: 1 }, lastFailedAt: new Date() },
        select: { failureCount: true },
      });
      if (ep.failureCount >= 10) {
        await prisma.webhookEndpoint.update({ where: { id: endpoint.id }, data: { enabled: false } });
      }
    }
  };

  if (!endpoint || !endpoint.enabled) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', responseBody: 'Endpoint missing or disabled', nextRetryAt: null },
    });
    return;
  }

  let hostname: string;
  try {
    hostname = new URL(endpoint.url).hostname;
  } catch {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', responseBody: 'Invalid endpoint URL', nextRetryAt: null },
    });
    return;
  }

  if (await isBlockedDestination(hostname)) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'FAILED', responseBody: 'SSRF: destination resolved to a blocked range', nextRetryAt: null },
    });
    return;
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  let signingSecret: string;
  try {
    signingSecret = decryptSecret(endpoint.secret);
  } catch (err: any) {
    await fail(`Secret decrypt failed: ${err?.message || 'unknown'}`);
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(endpoint.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aldaro-Signature': `t=${timestamp},v1=${sign(signingSecret, delivery.payload, timestamp)}`,
        'X-Aldaro-Event-Timestamp': timestamp,
        'User-Agent': 'Aldaro-Webhooks/1.0',
      },
      body: delivery.payload,
      signal: controller.signal as any,
    });
    const body = (await res.text().catch(() => '')).slice(0, 4096);

    if (res.status >= 200 && res.status < 300) {
      await prisma.$transaction([
        prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: { status: 'DELIVERED', responseStatus: res.status, responseBody: body, attemptCount: delivery.attemptCount + 1, deliveredAt: new Date(), nextRetryAt: null },
        }),
        prisma.webhookEndpoint.update({
          where: { id: endpoint.id },
          data: { lastDeliveredAt: new Date(), failureCount: 0 },
        }),
      ]);
      return;
    }
    await fail(body || `HTTP ${res.status}`, res.status);
  } catch (err: any) {
    await fail(String(err?.message || 'fetch failed'));
  } finally {
    clearTimeout(timer);
  }
}

export async function processWebhookDeliveries(prisma: PrismaClient): Promise<void> {
  const now = new Date();
  const settleCutoff = new Date(Date.now() - SETTLE_MS);

  const deliveries = await prisma.webhookDelivery.findMany({
    where: {
      status: 'PENDING',
      createdAt: { lt: settleCutoff },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    include: { endpoint: true },
    orderBy: { createdAt: 'asc' },
    take: BATCH,
  });

  for (const delivery of deliveries) {
    await deliverOne(prisma, delivery);
  }
}
