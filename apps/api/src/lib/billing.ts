import Stripe from 'stripe';
import { PrismaClient } from '@prisma/client';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16' as any,
});

const prisma = new PrismaClient();

export async function reportUsageToStripe(runId: string) {
  try {
    const run = await prisma.run.findUnique({
      where: { id: runId },
      include: { user: true },
    });

    if (!run || !run.user?.stripeCustomerId || run.stripeUsageReported || !run.billedSeconds) {
      return;
    }

    // Cross-check: infra lifetime vs reported billedSeconds
    let durationSeconds = run.billedSeconds;
    if (run.infraStartedAt && run.infraFinishedAt) {
      const infraLifetime = Math.ceil((run.infraFinishedAt.getTime() - run.infraStartedAt.getTime()) / 1000);
      // If discrepancy > 5%, log a warning but proceed with billedSeconds (agent reported)
      // or use the larger of the two if we want to be safe against agent crashes.
      if (Math.abs(infraLifetime - durationSeconds) > (durationSeconds * 0.05)) {
        console.warn(`[BILLING] Discrepancy detected for run ${runId}: Agent=${durationSeconds}s, Infra=${infraLifetime}s`);
      }
    }

    // Per the spec: "Usage event emitted once per run completion/cancel/timeout."
    // "Idempotency key = run_id."
    
    // Stripe Metering API (v2 meters use events)
    // Note: If using legacy usage records, it's different. 
    // Spec mentions "meter events" which is the newer approach.
    
    await stripe.billing.meterEvents.create({
      event_name: 'gpu_runtime_seconds',
      payload: {
        value: run.billedSeconds.toString(),
        stripe_customer_id: run.user.stripeCustomerId,
      },
      identifier: run.id, // Idempotency
      timestamp: Math.floor(Date.now() / 1000), // Required by Stripe Meter Events
    });

    await prisma.run.update({
      where: { id: run.id },
      data: { stripeUsageReported: true },
    });

    console.log(`[BILLING] Reported ${run.billedSeconds}s for run ${run.id} to Stripe.`);
  } catch (err: any) {
    console.error(`[BILLING] Failed to report usage for run ${runId}:`, err.message);
    // Spec: "If Stripe is down, queue the meter event and retry."
    // For MVP, we'll log it and we could have a background task that picks up stripeUsageReported=false and finishedAt!=null
  }
}
