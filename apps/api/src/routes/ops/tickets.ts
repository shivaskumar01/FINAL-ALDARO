import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

/**
 * Ops Ticket Triage Routes (Author-only)
 *
 * - List all tickets
 * - View ticket detail
 * - Refund a usage session (Stripe credit)
 * - Quarantine a GPU node
 * - Resolve / update ticket status
 */
export const opsTicketRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireAuthor as any);

  // GET /api/ops/tickets — list all tickets
  fastify.get('/', async (request: any) => {
    const query = z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(),
      limit: z.coerce.number().min(1).max(100).default(50),
    }).parse(request.query);

    const tickets = await prisma.supportTicket.findMany({
      where: query.status ? { status: query.status } : {},
      orderBy: [
        { status: 'asc' }, // OPEN first
        { createdAt: 'desc' },
      ],
      take: query.limit,
      include: {
        user: { select: { id: true, email: true } },
        _count: { select: { messages: true } },
      },
    });

    return { tickets };
  });

  // GET /api/ops/tickets/:id — full ticket with messages, session, workspace
  fastify.get('/:id', async (request: any, reply: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, email: true } },
        messages: {
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, email: true, role: true } } },
        },
      },
    });

    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

    // Fetch related session if linked
    let session = null;
    if (ticket.usageSessionId) {
      session = await prisma.usageSession.findUnique({
        where: { id: ticket.usageSessionId },
        include: {
          workspace: {
            select: {
              id: true, gpuType: true, proxmoxNode: true, status: true,
              gpuAllocation: { select: { gpuId: true } },
            },
          },
        },
      });
    }

    return { ticket, session };
  });

  // POST /api/ops/tickets/:id/refund — refund the linked usage session
  fastify.post('/:id/refund', {
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 hour',
      },
    },
  }, async (request: any, reply: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });
    if (ticket.refundedAt) return reply.status(409).send({ error: 'Already refunded' });
    if (!ticket.usageSessionId) return reply.status(400).send({ error: 'No usage session linked to this ticket' });

    const session = await prisma.usageSession.findUnique({ where: { id: ticket.usageSessionId } });
    if (!session) return reply.status(404).send({ error: 'Usage session not found' });
    // SECURITY: Verify session belongs to the ticket's user (prevent refunding arbitrary sessions)
    if (session.userId !== ticket.userId) {
      return reply.status(403).send({ error: 'Session does not belong to ticket user' });
    }
    if (session.billedCents <= 0) return reply.status(400).send({ error: 'Session has no billed amount' });

    // Issue Stripe credit note / refund
    const refundCents = session.billedCents;
    let stripeRefundId: string | null = null;

    if (process.env.STRIPE_SECRET_KEY) {
      try {
        const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
        const user = await prisma.user.findUnique({ where: { id: session.userId } });

        if (user?.stripeCustomerId) {
          // Create a customer credit balance transaction (credit note)
          const balanceTx = await stripe.customers.createBalanceTransaction(user.stripeCustomerId, {
            amount: -refundCents, // negative = credit
            currency: 'usd',
            description: `Refund for ticket ${ticket.id} — session ${session.id}`,
          });
          stripeRefundId = balanceTx.id;
        }
      } catch (err: any) {
        console.error(`[OPS] Stripe refund failed for ticket ${id}:`, err.message);
        // SECURITY: Do not leak Stripe error details to the client
        return reply.status(502).send({ error: 'Stripe refund failed. Check server logs for details.' });
      }
    } else {
      console.warn(`[OPS] STRIPE_SECRET_KEY not set — recording refund locally only`);
    }

    await prisma.supportTicket.update({
      where: { id },
      data: {
        refundedCents: refundCents,
        refundedAt: new Date(),
      },
    });

    return {
      ok: true,
      refundedCents: refundCents,
      stripeRefundId,
      sessionId: session.id,
    };
  });

  // POST /api/ops/tickets/:id/quarantine-gpu — mark GPU as MAINTENANCE
  fastify.post('/:id/quarantine-gpu', async (request: any, reply: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      gpuId: z.string().uuid(),
    }).parse(request.body);

    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

    const gpu = await prisma.fleetGpu.findUnique({ where: { id: body.gpuId } });
    if (!gpu) return reply.status(404).send({ error: 'GPU not found' });

    // SECURITY: Verify GPU is related to the ticket's workspace/session.
    // Tickets without a linked session cannot quarantine GPUs — prevents
    // arbitrary GPU quarantine by creating unlinked tickets.
    if (!ticket.usageSessionId) {
      return reply.status(400).send({ error: 'Cannot quarantine GPU: ticket has no linked usage session' });
    }
    const session = await prisma.usageSession.findUnique({
      where: { id: ticket.usageSessionId },
      select: { workspace: { select: { gpuAllocation: { select: { gpuId: true } } } } },
    });
    const ticketGpuId = session?.workspace?.gpuAllocation?.gpuId;
    if (!ticketGpuId || ticketGpuId !== body.gpuId) {
      return reply.status(400).send({ error: 'GPU is not associated with this ticket\'s workspace' });
    }

    await prisma.fleetGpu.update({
      where: { id: body.gpuId },
      data: {
        status: 'MAINTENANCE',
        currentWorkspaceId: null,
      },
    });

    // Release any allocation
    await prisma.workspaceGpuAllocation.updateMany({
      where: { gpuId: body.gpuId, releasedAt: null },
      data: { releasedAt: new Date() },
    });

    // Create incident for visibility
    await prisma.incident.create({
      data: {
        type: 'gpu_quarantined',
        severity: 'HIGH',
        title: `GPU quarantined from ticket ${ticket.id.slice(0, 8)}`,
        description: `GPU ${gpu.id.slice(0, 8)} (${gpu.gpuType || gpu.gpuName}) on node ${gpu.nodeId.slice(0, 8)} quarantined due to support ticket`,
        status: 'OPEN',
      },
    });

    return {
      ok: true,
      gpuId: body.gpuId,
      newStatus: 'MAINTENANCE',
    };
  });

  // PATCH /api/ops/tickets/:id — update ticket status
  fastify.patch('/:id', async (request: any, reply: any) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(),
      priority: z.enum(['LOW', 'NORMAL', 'HIGH', 'URGENT']).optional(),
      assignedToId: z.string().uuid().nullable().optional(),
    }).parse(request.body);

    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });

    const data: any = {};
    if (body.status) data.status = body.status;
    if (body.priority) data.priority = body.priority;
    if (body.assignedToId !== undefined) data.assignedToId = body.assignedToId;
    if (body.status === 'RESOLVED') data.resolvedAt = new Date();

    const updated = await prisma.supportTicket.update({ where: { id }, data });
    return { ticket: updated };
  });
};
