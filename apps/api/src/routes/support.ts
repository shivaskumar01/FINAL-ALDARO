import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

export const supportRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);

  // GET /support/tickets, list user's tickets (paginated)
  fastify.get('/tickets', async (request: any) => {
    const userId = request.user.userId;
    const { page: rawPage = '1', limit: rawLimit = '20' } = request.query as any;
    const page = Math.max(1, Math.min(parseInt(rawPage, 10) || 1, 100));
    const limit = Math.max(1, Math.min(parseInt(rawLimit, 10) || 20, 50));

    const [tickets, total] = await Promise.all([
      prisma.supportTicket.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          _count: { select: { messages: true } },
        },
      }),
      prisma.supportTicket.count({ where: { userId } }),
    ]);
    return { tickets, total, page, limit };
  });

  // GET /support/tickets/:id, ticket detail with messages
  fastify.get('/tickets/:id', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const role = request.user.role;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

    const ticket = await prisma.supportTicket.findUnique({
      where: { id },
      include: {
        messages: {
          where: role === 'AUTHOR' ? {} : { isInternal: false },
          orderBy: { createdAt: 'asc' },
          include: { author: { select: { id: true, email: true, role: true } } },
        },
        user: { select: { id: true, email: true } },
      },
    });

    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });
    if (role !== 'AUTHOR' && ticket.userId !== userId) {
      return reply.status(404).send({ error: 'Ticket not found' });
    }

    return { ticket };
  });

  // POST /support/tickets, create ticket
  fastify.post('/tickets', async (request: any) => {
    const userId = request.user.userId;
    const body = z.object({
      subject: z.string().min(3).max(200),
      description: z.string().min(10).max(5000),
      category: z.enum(['gpu_crash', 'billing', 'network', 'general']).optional(),
      usageSessionId: z.string().uuid().optional(),
      workspaceId: z.string().uuid().optional(),
    }).parse(request.body);

    const ticket = await prisma.supportTicket.create({
      data: {
        userId,
        subject: body.subject,
        description: body.description,
        category: body.category ?? null,
        usageSessionId: body.usageSessionId ?? null,
        workspaceId: body.workspaceId ?? null,
      },
    });

    return { ticket };
  });

  // POST /support/tickets/:id/messages, add message to ticket
  fastify.post('/tickets/:id/messages', async (request: any, reply: any) => {
    const userId = request.user.userId;
    const role = request.user.role;
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const body = z.object({
      body: z.string().min(1).max(5000),
      isInternal: z.boolean().optional(),
    }).parse(request.body);

    const ticket = await prisma.supportTicket.findUnique({ where: { id } });
    if (!ticket) return reply.status(404).send({ error: 'Ticket not found' });
    if (role !== 'AUTHOR' && ticket.userId !== userId) {
      return reply.status(404).send({ error: 'Ticket not found' });
    }

    const message = await prisma.ticketMessage.create({
      data: {
        ticketId: id,
        authorId: userId,
        body: body.body,
        isInternal: role === 'AUTHOR' ? (body.isInternal ?? false) : false,
      },
    });

    // Auto-update ticket status when ops replies
    if (role === 'AUTHOR' && ticket.status === 'OPEN') {
      await prisma.supportTicket.update({
        where: { id },
        data: { status: 'IN_PROGRESS' },
      });
    }

    return { message };
  });

  // GET /support/sessions, list user's recent sessions for ticket dropdown
  fastify.get('/sessions', async (request: any) => {
    const userId = request.user.userId;
    const sessions = await prisma.usageSession.findMany({
      where: { userId },
      orderBy: { startTime: 'desc' },
      take: 20,
      select: {
        id: true,
        workspaceId: true,
        gpuType: true,
        startTime: true,
        endTime: true,
        status: true,
        pricePerHourCents: true,
        billedCents: true,
      },
    });
    return { sessions };
  });
};
