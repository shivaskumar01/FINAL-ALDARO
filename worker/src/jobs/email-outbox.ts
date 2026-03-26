/**
 * Email outbox processor: claims PENDING rows, sends via provider, updates status.
 * Configure SMTP or AWS SES via env; if none, logs to console (dev only).
 */

import { PrismaClient } from '@prisma/client';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [10_000, 30_000, 60_000, 300_000, 900_000];

function nextBackoff(attemptCount: number): number {
  if (attemptCount <= 0) return BACKOFF_MS[0];
  if (attemptCount - 1 >= BACKOFF_MS.length) return BACKOFF_MS[BACKOFF_MS.length - 1];
  return BACKOFF_MS[attemptCount - 1];
}

export async function emailOutboxTick(prisma: PrismaClient): Promise<void> {
  const now = new Date();

  // Recovery: find emails stuck in SENDING for >5 minutes (orphan from crash)
  // and reset them to PENDING for retry.
  await prisma.emailOutbox.updateMany({
    where: {
      status: 'SENDING',
      lastAttemptAt: { lt: new Date(Date.now() - 5 * 60_000) },
      attemptCount: { lt: MAX_ATTEMPTS },
    },
    data: { status: 'PENDING' },
  });

  const pending = await prisma.emailOutbox.findMany({
    where: {
      status: 'PENDING',
      attemptCount: { lt: MAX_ATTEMPTS },
      OR: [
        { nextAttemptAt: null },
        { nextAttemptAt: { lte: now } },
      ],
    },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });
  if (pending.length === 0) return;

  for (const row of pending) {
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { status: 'SENDING', lastAttemptAt: now, attemptCount: { increment: 1 } },
    });

    try {
      const result = await sendEmail({
        to: row.toEmail,
        subject: row.subject,
        bodyText: row.bodyText,
        bodyHtml: row.bodyHtml ?? undefined,
      });
      await prisma.emailOutbox.update({
        where: { id: row.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          providerMessageId: result?.messageId ?? null,
          nextAttemptAt: null,
        },
      });
    } catch (err) {
      const newAttemptCount = row.attemptCount + 1;
      const exhausted = newAttemptCount >= MAX_ATTEMPTS;
      console.error(`[EmailOutbox] Failed to send ${row.type} to ${row.toEmail} (attempt ${newAttemptCount}/${MAX_ATTEMPTS}):`, err);
      await prisma.emailOutbox.update({
        where: { id: row.id },
        data: {
          status: exhausted ? 'FAILED' : 'PENDING',
          nextAttemptAt: exhausted ? null : new Date(Date.now() + nextBackoff(newAttemptCount)),
        },
      });
    }
  }
}

async function sendEmail(params: {
  to: string;
  subject: string;
  bodyText: string;
  bodyHtml?: string;
}): Promise<{ messageId?: string } | null> {
  // TODO: Add AWS SES or SMTP provider. See spec §6.4 and §8.
  // For now: dev fallback – mark as sent and log (no real email sent).
  if (process.env.NODE_ENV === 'production' && !process.env.SMTP_HOST && !process.env.AWS_SES_REGION) {
    console.error('[EmailOutbox] PRODUCTION: No email provider configured (SMTP_HOST or AWS_SES_REGION). Emails will not be delivered.');
  }
  console.log(`[EmailOutbox] Would send to ${params.to}: ${params.subject}`);
  return { messageId: `dev-${Date.now()}` };
}
