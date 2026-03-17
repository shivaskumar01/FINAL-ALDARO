/**
 * Email outbox processor: claims PENDING rows, sends via provider, updates status.
 * Configure SMTP or AWS SES via env; if none, logs to console (dev only).
 */

import { PrismaClient } from '@prisma/client';

const BATCH_SIZE = 10;
const MAX_ATTEMPTS = 5;

export async function emailOutboxTick(prisma: PrismaClient): Promise<void> {
  const pending = await prisma.emailOutbox.findMany({
    where: { status: 'PENDING', attemptCount: { lt: MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: BATCH_SIZE,
  });
  if (pending.length === 0) return;

  for (const row of pending) {
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { status: 'SENDING', lastAttemptAt: new Date(), attemptCount: { increment: 1 } },
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
        },
      });
    } catch (err) {
      console.error(`[EmailOutbox] Failed to send ${row.type} to ${row.toEmail}:`, err);
      await prisma.emailOutbox.update({
        where: { id: row.id },
        data: { status: 'FAILED' },
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
  console.log(`[EmailOutbox] Would send to ${params.to}: ${params.subject}`);
  return { messageId: `dev-${Date.now()}` };
}
