import { PrismaClient, WorkspaceMeterEventOutbox } from '@prisma/client';
import fetch from 'node-fetch';

const METERING_BACKOFF_MS = [10_000, 30_000, 60_000, 120_000, 300_000, 900_000];
const BATCH_SIZE = 20;
const STRIPE_METER_EVENTS_URL = 'https://api.stripe.com/v1/billing/meter_events';

function nextBackoff(attemptCount: number): number {
  if (attemptCount <= 0) return METERING_BACKOFF_MS[0];
  if (attemptCount - 1 >= METERING_BACKOFF_MS.length) {
    return METERING_BACKOFF_MS[METERING_BACKOFF_MS.length - 1];
  }
  return METERING_BACKOFF_MS[attemptCount - 1];
}

function buildStripeBody(eventName: string, usageSessionId: string, valueSeconds: number, stripeCustomerId: string) {
  const payload = new URLSearchParams();
  payload.set('event_name', eventName);
  payload.set('identifier', usageSessionId);
  payload.set('timestamp', String(Math.floor(Date.now() / 1000)));
  payload.set('payload[value]', String(valueSeconds));
  payload.set('payload[stripe_customer_id]', stripeCustomerId);
  return payload.toString();
}

async function sendMeterEvent(
  stripeSecretKey: string,
  event: WorkspaceMeterEventOutbox,
  stripeCustomerId: string,
): Promise<{ stripeMeterEventId: string }> {
  // SECURITY: Idempotency key prevents duplicate billing on retry after
  // Stripe success + DB commit failure (audit gap: Stripe double-billing).
  const idempotencyKey = `meter-${event.usageSessionId}-${event.id}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  let response;
  try {
    response = await fetch(STRIPE_METER_EVENTS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey,
      },
      body: buildStripeBody(event.eventName, event.usageSessionId, event.valueSeconds, stripeCustomerId),
      signal: controller.signal as any,
    });
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();
  let json: any = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch {
    // Non-JSON Stripe errors are handled through raw body below.
  }

  if (!response.ok) {
    const err: any = new Error(json?.error?.message || raw || 'Failed to emit Stripe meter event');
    err.code = json?.error?.code || `HTTP_${response.status}`;
    throw err;
  }

  return {
    stripeMeterEventId: String(json?.identifier || json?.id || event.usageSessionId),
  };
}

async function processMeterOutboxEvent(
  prisma: PrismaClient,
  event: WorkspaceMeterEventOutbox,
  stripeSecretKey: string,
) {
  const now = new Date();
  // Read current attempt count without incrementing yet.
  // Increment happens atomically inside the success or failure update below.
  const currentAttemptCount = event.attemptCount;

  try {
    const user = await prisma.user.findUnique({
      where: { id: event.userId },
      select: { stripeCustomerId: true },
    });
    if (!user?.stripeCustomerId) {
      throw Object.assign(new Error('Stripe customer is not configured for this user.'), {
        code: 'STRIPE_CUSTOMER_MISSING',
      });
    }

    const meter = await sendMeterEvent(stripeSecretKey, event, user.stripeCustomerId);

    // Success: mark SENT + record Stripe ID + increment attempt count — all in one transaction.
    await prisma.$transaction([
      prisma.workspaceMeterEventOutbox.update({
        where: { id: event.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          nextAttemptAt: null,
          stripeMeterEventId: meter.stripeMeterEventId,
          attemptCount: { increment: 1 },
          lastAttemptAt: now,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      }),
      prisma.usageSession.update({
        where: { id: event.usageSessionId },
        data: {
          stripeMeterEventId: meter.stripeMeterEventId,
        },
      }),
    ]);
  } catch (err: any) {
    const newAttemptCount = currentAttemptCount + 1;
    const exhausted = newAttemptCount >= event.maxAttempts;
    const code = String(err?.code || 'STRIPE_METER_EMIT_FAILED');
    const message = String(err?.message || 'Failed to emit Stripe meter event');
    const nextAttemptAt = exhausted ? null : new Date(Date.now() + nextBackoff(newAttemptCount));

    await prisma.workspaceMeterEventOutbox.update({
      where: { id: event.id },
      data: {
        status: exhausted ? 'FAILED' : 'RETRY',
        attemptCount: { increment: 1 },
        lastAttemptAt: now,
        nextAttemptAt,
        lastErrorCode: code,
        lastErrorMessage: message,
      },
    });
  }
}

let _stripeMissingWarned = false;

export async function processWorkspaceMeterEvents(prisma: PrismaClient) {
  const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
  if (!stripeSecretKey) {
    if (!_stripeMissingWarned) {
      console.warn('[Metering] STRIPE_SECRET_KEY not set — all meter events will be silently skipped. Billing is DISABLED.');
      _stripeMissingWarned = true;
    }
    return;
  }

  const now = new Date();
  const events = await prisma.workspaceMeterEventOutbox.findMany({
    where: {
      status: { in: ['PENDING', 'RETRY'] },
      OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });

  for (const event of events) {
    await processMeterOutboxEvent(prisma, event, stripeSecretKey);
  }
}
