import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { logSecurityEvent, SecurityEventType } from '../lib/security';

const prisma = new PrismaClient();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '', {
  apiVersion: '2023-10-16',
});

export const billingRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.post('/setup-intent', {
    preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any, fastify.requireReauth as any],
  }, async (request: any, reply) => {
    const userId = request.user.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(404).send({ error: 'User not found' });

    let customerId = user.stripeCustomerId;
    if (!customerId) {
      // SECURITY: Idempotency key prevents duplicate Stripe customers if
      // Stripe succeeds but the DB update fails and the user retries.
      const customer = await stripe.customers.create({
        email: user.email,
        metadata: { userId: user.id },
      }, {
        idempotencyKey: `create-customer-${user.id}`,
      });
      customerId = customer.id;
      await prisma.user.update({
        where: { id: user.id },
        data: { stripeCustomerId: customerId },
      });
    }

    const setupIntent = await stripe.setupIntents.create({
      customer: customerId,
      payment_method_types: ['card'],
    });

    return { client_secret: setupIntent.client_secret };
  });

  fastify.get('/status', {
    preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any],
  }, async (request: any, reply) => {
    const userId = request.user.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(404).send({ error: 'User not found' });
    return {
      payment_status: user.paymentStatus,
      has_card: !!user.stripeDefaultPaymentMethodId,
    };
  });

  fastify.post('/webhook', { config: { rawBody: true } }, async (request: any, reply) => {
    const sig = request.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET || '';

    let event;
    try {
      event = stripe.webhooks.constructEvent(request.rawBody, sig, webhookSecret);
    } catch (err: any) {
      // SECURITY: Do not leak Stripe error details to the client
      console.error('[Billing] Webhook signature verification failed:', err.message);
      return reply.status(400).send({ error: 'Webhook signature verification failed.' });
    }

    if (event.type === 'setup_intent.succeeded') {
      const setupIntent = event.data.object as Stripe.SetupIntent;
      const customerId = setupIntent.customer as string;
      const paymentMethodId = setupIntent.payment_method as string;

      const user = await prisma.user.findFirst({
        where: { stripeCustomerId: customerId },
      });

      if (user) {
        await prisma.user.update({
          where: { id: user.id },
          data: {
            paymentStatus: 'VALID',
            stripeDefaultPaymentMethodId: paymentMethodId,
          },
        });
        await logSecurityEvent(request, user.id, SecurityEventType.PAYMENT_METHOD_CHANGE, { action: 'added' });
      }
    }

    return { received: true };
  });
};
