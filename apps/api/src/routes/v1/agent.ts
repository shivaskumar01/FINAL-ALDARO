import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  buildAgentSessionToken,
  extractBearerToken,
  hasValidAgentBootstrapSecret,
  verifyAgentSessionToken,
} from '../../lib/agentSession';

const prisma = new PrismaClient();
const AGENT_SESSION_TTL_MS = 15 * 60 * 1000;

const agentHelloSchema = z.object({
  run_id: z.string(),
  agent_version: z.string(),
  capabilities: z.record(z.any()).optional(),
  system: z.record(z.any()).optional(),
});

export const agentRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /v1/agent/handshake
  fastify.post('/handshake', async (request: any, reply) => {
    if (!hasValidAgentBootstrapSecret(request.headers.authorization)) {
      return reply.status(401).send({ error: 'Unauthorized agent bootstrap token' });
    }

    const body = agentHelloSchema.parse(request.body);

    const run = await prisma.run.findUnique({
      where: { id: body.run_id },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    // SECURITY: Limit max agent sessions per run to prevent abuse
    const sessionCount = await prisma.agentSession.count({ where: { runId: body.run_id } });
    if (sessionCount >= 50) {
      return reply.status(429).send({ error: 'Maximum agent sessions per run exceeded' });
    }

    const session = await prisma.agentSession.create({
      data: {
        runId: body.run_id,
        agentVersion: body.agent_version,
        capabilitiesJson: body.capabilities ? JSON.stringify(body.capabilities) : null,
        systemInfoJson: body.system ? JSON.stringify(body.system) : null,
      },
    });

    const token = buildAgentSessionToken(fastify, body.run_id, session.id);

    // Generate a WebSocket URL (placeholder for now)
    const ws_url = `ws://localhost:4000/v1/runs/${body.run_id}/ws?session_id=${session.id}`;

    return {
      agent_session_id: session.id,
      token,
      expires_at: new Date(Date.now() + AGENT_SESSION_TTL_MS).toISOString(),
      ws_url,
      heartbeat_interval_seconds: 5,
    };
  });

  // POST /v1/agent/token/refresh
  fastify.post('/token/refresh', async (request: any, reply) => {
    const bearer = extractBearerToken(request.headers.authorization);
    if (!bearer) {
      return reply.status(401).send({ error: 'Missing agent session token' });
    }

    let sessionToken;
    try {
      sessionToken = verifyAgentSessionToken(fastify, bearer);
    } catch {
      return reply.status(401).send({ error: 'Invalid agent session token' });
    }

    const session = await prisma.agentSession.findUnique({
      where: { id: sessionToken.agentSessionId },
      select: { id: true, runId: true },
    });

    if (!session || session.runId !== sessionToken.runId) {
      return reply.status(401).send({ error: 'Invalid agent session token' });
    }

    return {
      token: buildAgentSessionToken(fastify, session.runId, session.id),
      expires_at: new Date(Date.now() + AGENT_SESSION_TTL_MS).toISOString(),
    };
  });
};
