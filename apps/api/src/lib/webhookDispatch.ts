import { PrismaClient } from '@prisma/client';
import crypto from 'crypto';
import dns from 'dns/promises';
import { decryptSecret } from './encryption';

const prisma = new PrismaClient();

const MAX_RETRY_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 10;

/**
 * SECURITY: Resolve hostname and validate the IP is not internal/private.
 * This prevents DNS rebinding attacks where a hostname resolves to an
 * internal IP at delivery time (after passing the creation-time check).
 */
async function isBlockedResolvedIp(hostname: string): Promise<boolean> {
  try {
    const addresses = await dns.resolve4(hostname).catch(() => [] as string[]);
    const addresses6 = await dns.resolve6(hostname).catch(() => [] as string[]);
    const all = [...addresses, ...addresses6];
    if (all.length === 0) return false; // Let fetch handle DNS failure
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
    return false; // DNS resolution failure — let fetch handle it
  }
}

/**
 * Compute HMAC-SHA256 signature for a webhook payload.
 */
function computeSignature(secret: string, payload: string): string {
  return crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
}

/**
 * Delay helper for exponential backoff.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send an HTTP POST to a webhook endpoint with HMAC-SHA256 signature.
 * Returns the response status and body.
 */
async function sendWebhookRequest(
  url: string,
  secret: string,
  payload: string,
): Promise<{ status: number; body: string }> {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signedPayload = `${timestamp}.${payload}`;
  const signature = computeSignature(secret, signedPayload);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Aldaro-Signature': `t=${timestamp},v1=${signature}`,
        'X-Aldaro-Event-Timestamp': timestamp,
        'User-Agent': 'Aldaro-Webhooks/1.0',
      },
      body: payload,
      signal: controller.signal,
    });

    const body = await response.text().catch(() => '');
    return { status: response.status, body: body.slice(0, 4096) };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Dispatch a webhook event to all matching endpoints for a user.
 *
 * @param event - Event type (e.g. "run.completed", "workspace.failed")
 * @param payload - Event payload object
 * @param userId - The user who owns the endpoints
 * @param specificEndpointId - If provided, only send to this endpoint (for testing)
 */
export async function dispatchWebhook(
  event: string,
  payload: object,
  userId: string,
  specificEndpointId?: string,
): Promise<void> {
  // Find matching endpoints
  const whereClause: any = {
    userId,
    enabled: true,
  };

  if (specificEndpointId) {
    whereClause.id = specificEndpointId;
  }

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: whereClause,
  });

  // Filter to endpoints subscribed to this event type
  const matchingEndpoints = endpoints.filter((ep) => {
    try {
      const subscribedEvents: string[] = JSON.parse(ep.events);
      if (!Array.isArray(subscribedEvents)) return false;
      return subscribedEvents.includes('*') || subscribedEvents.includes(event);
    } catch {
      console.error(`[Webhook] Malformed events JSON for endpoint ${ep.id}`);
      return false;
    }
  });

  if (matchingEndpoints.length === 0) return;

  const fullPayload = JSON.stringify({
    id: crypto.randomUUID(),
    event,
    created_at: new Date().toISOString(),
    data: payload,
  });

  // Dispatch to each endpoint concurrently
  await Promise.allSettled(
    matchingEndpoints.map((endpoint) =>
      deliverToEndpoint(endpoint, event, fullPayload),
    ),
  );
}

/**
 * Deliver a webhook to a single endpoint with retry logic.
 */
async function deliverToEndpoint(
  endpoint: { id: string; url: string; secret: string; failureCount: number },
  event: string,
  payload: string,
): Promise<void> {
  // Create delivery record
  const delivery = await prisma.webhookDelivery.create({
    data: {
      endpointId: endpoint.id,
      event,
      payload,
      status: 'PENDING',
      attemptCount: 0,
    },
  });

  let lastError: Error | null = null;
  let lastStatus: number | null = null;
  let lastBody: string | null = null;

  // SECURITY: Re-validate destination IP at delivery time to prevent DNS rebinding.
  // The URL was checked at creation, but DNS could have changed since then.
  try {
    const hostname = new URL(endpoint.url).hostname;
    if (await isBlockedResolvedIp(hostname)) {
      console.error(`[Webhook] SSRF blocked: ${endpoint.id} resolved to internal IP`);
      await prisma.webhookDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'FAILED',
          responseBody: 'SSRF: destination resolved to blocked IP range',
          attemptCount: 1,
        },
      });
      return;
    }
  } catch {
    // URL parse failure — will be caught by fetch below
  }

  for (let attempt = 1; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      // Decrypt secret (handles both encrypted and legacy plaintext values)
      const signingSecret = decryptSecret(endpoint.secret);
      const result = await sendWebhookRequest(endpoint.url, signingSecret, payload);
      lastStatus = result.status;
      lastBody = result.body;

      if (result.status >= 200 && result.status < 300) {
        // Successful delivery
        await prisma.$transaction([
          prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
              status: 'DELIVERED',
              responseStatus: result.status,
              responseBody: result.body,
              attemptCount: attempt,
              deliveredAt: new Date(),
            },
          }),
          prisma.webhookEndpoint.update({
            where: { id: endpoint.id },
            data: {
              lastDeliveredAt: new Date(),
              failureCount: 0, // Reset on success
            },
          }),
        ]);
        return;
      }

      // Non-2xx response — treat as failure and retry
      lastError = new Error(`HTTP ${result.status}`);
    } catch (err: any) {
      lastError = err;
      lastStatus = null;
      lastBody = err.message;
    }

    // Wait before retrying (exponential backoff: 1s, 4s, 9s)
    if (attempt < MAX_RETRY_ATTEMPTS) {
      await delay(attempt * attempt * 1000);
    }
  }

  // All attempts exhausted — mark as failed
  const newFailureCount = endpoint.failureCount + 1;

  await prisma.$transaction([
    prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'FAILED',
        responseStatus: lastStatus,
        responseBody: lastBody?.slice(0, 4096) ?? lastError?.message ?? null,
        attemptCount: MAX_RETRY_ATTEMPTS,
      },
    }),
    prisma.webhookEndpoint.update({
      where: { id: endpoint.id },
      data: {
        failureCount: newFailureCount,
        lastFailedAt: new Date(),
        // Auto-disable after MAX_CONSECUTIVE_FAILURES
        ...(newFailureCount >= MAX_CONSECUTIVE_FAILURES && { enabled: false }),
      },
    }),
  ]);
}
