import crypto from 'crypto';
import { FastifyInstance } from 'fastify';

const DEV_AGENT_SHARED_SECRET = 'dev-agent-shared-secret';

export type AgentSessionTokenPayload = {
  kind: 'agent-session';
  runId: string;
  agentSessionId: string;
  jti: string;
};

export function getAgentSharedSecret() {
  return process.env.ALDARO_AGENT_SHARED_SECRET || DEV_AGENT_SHARED_SECRET;
}

export function extractBearerToken(value: string | string[] | undefined) {
  if (!value || Array.isArray(value)) return null;
  if (!value.startsWith('Bearer ')) return null;
  return value.slice('Bearer '.length).trim();
}

export function hasValidAgentBootstrapSecret(authorization: string | string[] | undefined) {
  const bearer = extractBearerToken(authorization);
  if (!bearer) return false;

  const expected = Buffer.from(getAgentSharedSecret(), 'utf8');
  const received = Buffer.from(bearer, 'utf8');
  if (expected.length !== received.length) return false;

  return crypto.timingSafeEqual(expected, received);
}

export function buildAgentSessionToken(fastify: FastifyInstance, runId: string, agentSessionId: string) {
  return fastify.jwt.sign(
    {
      kind: 'agent-session',
      runId,
      agentSessionId,
      jti: crypto.randomUUID(),
    } satisfies AgentSessionTokenPayload,
    {
      expiresIn: '15m',
    }
  );
}

export function verifyAgentSessionToken(fastify: FastifyInstance, token: string): AgentSessionTokenPayload {
  const decoded = fastify.jwt.verify(token) as Partial<AgentSessionTokenPayload>;
  if (decoded.kind !== 'agent-session' || !decoded.runId || !decoded.agentSessionId || !decoded.jti) {
    throw new Error('Invalid agent session token');
  }

  return decoded as AgentSessionTokenPayload;
}
