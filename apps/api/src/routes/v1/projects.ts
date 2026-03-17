import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';

const prisma = new PrismaClient();

const projectCreateSchema = z.object({
  name: z.string().min(2).max(60),
  repo_url: z.string().url(),
  default_branch: z.string().default('main'),
  visibility: z.enum(['private', 'public']).default('private'),
});

export const projectRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /v1/projects
  fastify.post('/', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const body = projectCreateSchema.parse(request.body);

    const project = await prisma.project.create({
      data: {
        userId,
        name: body.name,
        repoUrl: body.repo_url,
        defaultBranch: body.default_branch,
        visibility: body.visibility,
      },
    });

    return reply.status(201).send(project);
  });

  // GET /v1/projects
  fastify.get('/', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any) => {
    const userId = request.user.userId;
    const { limit = 20, cursor } = request.query as any;

    const items = await prisma.project.findMany({
      where: { userId },
      take: parseInt(limit),
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
    });

    const next_cursor = items.length === parseInt(limit) ? items[items.length - 1].id : null;

    return { items, next_cursor };
  });

  // GET /v1/projects/:project_id
  fastify.get('/:project_id', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { project_id } = request.params;

    const project = await prisma.project.findFirst({
      where: { id: project_id, userId },
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    return project;
  });
};
