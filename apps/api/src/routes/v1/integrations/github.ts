import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import fetch from 'node-fetch';

const prisma = new PrismaClient();

export const githubRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);

  // POST /v1/integrations/github/installations
  fastify.post('/installations', async (request: any, reply) => {
    const userId = request.user.userId;
    const { installation_id } = z.object({ installation_id: z.string() }).parse(request.body);

    const installation = await prisma.gitHubInstallation.upsert({
      where: { installationId: installation_id },
      update: { userId }, // Re-link if exists
      create: {
        userId,
        installationId: installation_id,
      }
    });

    return installation;
  });

  // GET /v1/integrations/github/installations
  fastify.get('/installations', async (request: any) => {
    const userId = request.user.userId;
    return prisma.gitHubInstallation.findMany({
      where: { userId }
    });
  });

  // GET /v1/integrations/github/repos
  fastify.get('/repos', async (request: any) => {
    const userId = request.user.userId;
    const installations = await prisma.gitHubInstallation.findMany({
      where: { userId }
    });

    if (installations.length === 0) return { items: [] };

    // In a real app, we would fetch repos from GitHub using the installation token
    // For MVP, we'll return a placeholder or stub
    return {
      items: [
        { id: 1, full_name: 'aldaro/demo-training', private: true },
        { id: 2, full_name: 'aldaro/inference-api', private: true }
      ]
    };
  });
};
