#!/usr/bin/env node
/**
 * Billing parity verification helper for staging drills.
 *
 * Usage:
 *   node scripts/verify-billing-parity.js --workspace <workspaceId>
 *   node scripts/verify-billing-parity.js --session <usageSessionId>
 *   node scripts/verify-billing-parity.js --workspace <workspaceId> --invoice <stripeInvoiceId>
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('--')) continue;
    parsed[arg.slice(2)] = args[i + 1];
    i += 1;
  }
  return parsed;
}

function toCentsFromSeconds(seconds, pricePerHourCents) {
  return Math.ceil((seconds * pricePerHourCents) / 3600);
}

async function loadSession({ workspace, session }) {
  if (session) {
    return prisma.usageSession.findUnique({
      where: { id: session },
      include: { workspace: true, user: true, meterOutbox: true },
    });
  }
  if (workspace) {
    return prisma.usageSession.findFirst({
      where: { workspaceId: workspace },
      orderBy: { startTime: 'desc' },
      include: { workspace: true, user: true, meterOutbox: true },
    });
  }
  return null;
}

async function loadStripeInvoiceCents(invoiceId) {
  if (!invoiceId || !process.env.STRIPE_SECRET_KEY) return null;
  const Stripe = require('stripe');
  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
  const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ['lines.data'] });
  const lines = invoice?.lines?.data || [];
  const totalCents = lines.reduce((sum, line) => sum + (line.amount || 0), 0);
  return {
    invoiceId,
    currency: invoice.currency,
    totalCents,
    lineCount: lines.length,
  };
}

async function main() {
  const args = parseArgs();
  const usage = await loadSession(args);
  if (!usage) {
    throw new Error('Usage session not found. Provide --workspace or --session.');
  }

  const derivedBilledCents = toCentsFromSeconds(usage.billedSeconds || 0, usage.pricePerHourCents || 0);
  const internalParity =
    usage.status === 'ENDED' &&
    usage.endTime !== null &&
    usage.totalSeconds === usage.billedSeconds &&
    usage.billedCents === derivedBilledCents;

  const meter = usage.meterOutbox;
  const meterParity = !!meter &&
    meter.status === 'SENT' &&
    !!meter.stripeMeterEventId &&
    meter.usageSessionId === usage.id &&
    meter.valueSeconds === usage.billedSeconds;

  const stripeInvoice = await loadStripeInvoiceCents(args.invoice);

  const report = {
    generatedAt: new Date().toISOString(),
    input: {
      workspaceId: args.workspace || null,
      usageSessionId: args.session || usage.id,
      stripeInvoiceId: args.invoice || null,
    },
    usage: {
      id: usage.id,
      workspaceId: usage.workspaceId,
      userId: usage.userId,
      status: usage.status,
      startTime: usage.startTime?.toISOString() || null,
      endTime: usage.endTime?.toISOString() || null,
      totalSeconds: usage.totalSeconds,
      billedSeconds: usage.billedSeconds,
      pricePerHourCents: usage.pricePerHourCents,
      billedCents: usage.billedCents,
      expectedBilledCents: derivedBilledCents,
      stripeMeterEventId: usage.stripeMeterEventId || null,
    },
    meterOutbox: meter ? {
      id: meter.id,
      status: meter.status,
      usageSessionId: meter.usageSessionId,
      valueSeconds: meter.valueSeconds,
      stripeMeterEventId: meter.stripeMeterEventId,
      attemptCount: meter.attemptCount,
      sentAt: meter.sentAt?.toISOString() || null,
    } : null,
    stripeInvoice,
    checks: {
      internalParity,
      meterParity,
      invoiceParity: stripeInvoice ? stripeInvoice.totalCents === usage.billedCents : null,
    },
  };

  console.log(JSON.stringify(report, null, 2));
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
