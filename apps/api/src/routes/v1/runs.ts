import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { provisioner } from '../../providers/provisioner';
import { reportUsageToStripe } from '../../lib/billing';
import { ALDARO_VERSION } from '../../version';
import { extractBearerToken, verifyAgentSessionToken } from '../../lib/agentSession';
import { isSupportedCustomerGpu } from '../../lib/supportedGpus';

const prisma = new PrismaClient();

const runCreateSchema = z.object({
  gpu_type: z.string(),
  gpu_count: z.number().int().min(1).max(8).default(1),
  hours_max: z.number().int().min(1).max(24).default(2),
  command: z.string(),
  env: z.record(z.string()).optional(),
  artifact_paths: z.array(z.string()).default(['outputs/', 'artifacts/', 'checkpoints/', 'runs/']),
});

const runEventEnvelopeSchema = z.object({
  type: z.enum(['STATUS', 'LOG', 'METRIC', 'ARTIFACT', 'HEARTBEAT', 'ERROR', 'COMMAND']),
  payload: z.record(z.any()),
});

export const runRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // POST /v1/projects/:project_id/runs
  fastify.post('/projects/:project_id/runs', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { project_id } = request.params;
    
    let body;
    try {
      body = runCreateSchema.parse(request.body);
    } catch (err: any) {
      return reply.status(400).send({ error: 'Validation failed', details: err.errors });
    }

    const project = await prisma.project.findFirst({
      where: { id: project_id, userId },
    });

    if (!project) {
      return reply.status(404).send({ error: 'Project not found' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return reply.status(401).send({ error: 'User not found' });

    // Alpha gate
    if (!user.isAlphaTester) {
      return reply.status(403).send({ 
        error: 'Access Restricted', 
        message: 'Aldaro GPU Adoption Layer is currently in private Alpha. Please contact shivas@aldaro.ai for an invite.' 
      });
    }

    // Concurrency limit check
    const activeRuns = await prisma.run.count({
      where: {
        userId,
        status: { in: ['provisioning', 'initializing', 'running', 'uploading_artifacts'] },
      },
    });

    if (activeRuns >= user.maxConcurrentRuns) {
      return reply.status(429).send({ 
        error: 'Concurrency limit reached', 
        message: `You have ${activeRuns} active runs. Maximum allowed is ${user.maxConcurrentRuns}.` 
      });
    }

    // Daily spend cap check (simplified for MVP: billed seconds today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayBilled = await prisma.run.aggregate({
      where: {
        userId,
        createdAt: { gte: today }
      },
      _sum: { billedSeconds: true }
    });

    if ((todayBilled._sum.billedSeconds || 0) >= user.dailySpendLimitSeconds) {
      return reply.status(429).send({
        error: 'Daily limit reached',
        message: 'You have reached your daily GPU runtime limit.'
      });
    }

    // Max hours check
    if (body.hours_max > 24) {
      return reply.status(400).send({ error: 'Maximum run duration is 24 hours.' });
    }

    if (!isSupportedCustomerGpu(body.gpu_type)) {
      return reply.status(400).send({
        error: 'Unsupported GPU type.',
        message: 'Aldaro currently supports RTX 5090 and A100 only.',
      });
    }

    const run = await prisma.run.create({
      data: {
        projectId: project_id,
        userId,
        status: 'queued',
        gpuType: body.gpu_type,
        gpuCount: body.gpu_count,
        hoursMax: body.hours_max,
        command: body.command,
        envJson: body.env ? JSON.stringify(body.env) : null,
        artifactPathsJson: JSON.stringify(body.artifact_paths),
        version: ALDARO_VERSION, // Store API version
      },
    });

    let updatedRun = run;
    try {
      const { workspaceId } = await provisioner.provision({
        runId: run.id,
        gpuType: run.gpuType,
        gpuCount: run.gpuCount,
        env: body.env,
      });

      updatedRun = await prisma.run.update({
        where: { id: run.id },
        data: { 
          status: 'provisioning',
          upstreamInstanceId: workspaceId,
          infraStartedAt: new Date() // Cross-check timestamp
        },
      });
    } catch (err) {
      console.error('Provisioning failed:', err);
      updatedRun = await prisma.run.update({
        where: { id: run.id },
        data: { status: 'failed', errorMessage: 'Provisioning failed' },
      });
    }

    return reply.status(201).send(updatedRun);
  });

  // GET /v1/projects/:project_id/runs
  fastify.get('/projects/:project_id/runs', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any) => {
    const userId = request.user.userId;
    const { project_id } = request.params;
    const { limit = '20', cursor } = request.query as any;
    const clampedLimit = Math.min(Math.max(parseInt(limit) || 20, 1), 100);

    const items = await prisma.run.findMany({
      where: { projectId: project_id, userId },
      take: clampedLimit,
      skip: cursor ? 1 : 0,
      cursor: cursor ? { id: cursor } : undefined,
      orderBy: { createdAt: 'desc' },
    });

    const next_cursor = items.length === clampedLimit ? items[items.length - 1].id : null;

    return { items, next_cursor };
  });

  // GET /v1/runs/:run_id
  fastify.get('/runs/:run_id', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { run_id } = request.params;

    const run = await prisma.run.findFirst({
      where: { id: run_id, userId },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    return run;
  });

  // POST /v1/runs/:run_id/cancel
  fastify.post('/runs/:run_id/cancel', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { run_id } = request.params;

    const run = await prisma.run.findFirst({
      where: { id: run_id, userId },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    if (['completed', 'failed', 'canceled', 'timed_out'].includes(run.status)) {
      return reply.status(400).send({ error: 'Run already finished' });
    }

    await prisma.run.update({
      where: { id: run_id },
      data: { 
        status: 'canceled',
        infraFinishedAt: new Date() // Cross-check
      },
    });

    if (run.upstreamInstanceId) {
      await provisioner.deprovision(run.upstreamInstanceId);
    }

    return reply.status(202).send({ status: 'cancel_requested' });
  });

  // GET /v1/runs/:run_id/logs (SSE)
  fastify.get('/runs/:run_id/logs', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { run_id } = request.params;
    const { since_seq = 0 } = request.query as any;

    const run = await prisma.run.findFirst({
      where: { id: run_id, userId },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    // SSE Reverse Proxy Hardening: Prevent buffering in Nginx/Cloudflare
    reply.raw.setHeader('X-Accel-Buffering', 'no');
    reply.raw.setHeader('Transfer-Encoding', 'chunked');

    // Keep-alive loop
    const keepAlive = setInterval(() => {
      reply.raw.write(': keep-alive\n\n');
    }, 15000); // Every 15s

    const sendLogs = async (since: number) => {
      const logs = await prisma.runLog.findMany({
        where: { runId: run_id, seq: { gt: since } },
        orderBy: { seq: 'asc' },
      });

      for (const log of logs) {
        reply.raw.write(`data: ${JSON.stringify(log)}\n\n`);
      }
      return logs.length > 0 ? logs[logs.length - 1].seq : since;
    };

    let currentSeq = parseInt(since_seq);
    currentSeq = await sendLogs(currentSeq);

    // In a production system, we would use a Pub/Sub mechanism (Redis) to stream new logs.
    // For this MVP, we'll poll the DB every 2 seconds if the run is still active.
    
    const pollInterval = setInterval(async () => {
      // In test mode, don't poll to avoid hanging tests
      if (process.env.NODE_ENV === 'test') {
        clearInterval(pollInterval);
        clearInterval(keepAlive);
        reply.raw.end();
        return;
      }

      currentSeq = await sendLogs(currentSeq);
      
      const updatedRun = await prisma.run.findUnique({ where: { id: run_id } });
      if (!updatedRun || ['completed', 'failed', 'canceled', 'timed_out'].includes(updatedRun.status)) {
        clearInterval(pollInterval);
        clearInterval(keepAlive);
        reply.raw.end();
      }
    }, 2000);

    request.raw.on('close', () => {
      clearInterval(pollInterval);
      clearInterval(keepAlive);
    });
  });

  // GET /v1/runs/:run_id/artifacts
  fastify.get('/runs/:run_id/artifacts', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { run_id } = request.params;

    const run = await prisma.run.findFirst({
      where: { id: run_id, userId },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    const items = await prisma.artifact.findMany({
      where: { runId: run_id },
    });

    return { items };
  });

  // GET /v1/runs/:run_id/diagnostics
  fastify.get('/runs/:run_id/diagnostics', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { run_id } = request.params;

    const run = await prisma.run.findFirst({
      where: { id: run_id, userId },
      include: {
        events: true,
        agentSessions: true,
      },
    });

    if (!run) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    const logs = await prisma.runLog.findMany({
      where: { runId: run_id },
      orderBy: { seq: 'asc' },
    });

    const diagnosticBundle = {
      run_id: run.id,
      project_id: run.projectId,
      status: run.status,
      gpu: { type: run.gpuType, count: run.gpuCount },
      timeline: {
        created: run.createdAt,
        started: run.startedAt,
        finished: run.finishedAt,
        infra_started: run.infraStartedAt,
        infra_finished: run.infraFinishedAt,
      },
      error: run.errorMessage,
      exit_code: run.exitCode,
      // API3: Redact sensitive event data
      events: run.events.map(e => {
        let payload: any = {};
        try {
          payload = JSON.parse(e.payload);
        } catch {
          payload = { _raw: '[invalid JSON]' };
        }
        // Redact secrets/tokens if they exist in payload
        if (payload.token) payload.token = '[REDACTED]';
        if (payload.secret) payload.secret = '[REDACTED]';
        return { type: e.type, time: e.createdAt, payload };
      }),
      agent_sessions: run.agentSessions.map(s => {
        let caps: any = null;
        if (s.capabilitiesJson) {
          try { caps = JSON.parse(s.capabilitiesJson); } catch { caps = null; }
        }
        return { version: s.agentVersion, caps };
      }),
      log_transcript: logs.map(l => `[${l.stream}] ${l.line}`).join('\n'),
    };

    return diagnosticBundle;
  });

  // POST /v1/runs/:run_id/retry
  fastify.post('/runs/:run_id/retry', { preHandler: [fastify.authenticate as any, fastify.requireCustomerApproved as any] }, async (request: any, reply) => {
    const userId = request.user.userId;
    const { run_id } = request.params;

    const oldRun = await prisma.run.findFirst({
      where: { id: run_id, userId },
    });

    if (!oldRun) {
      return reply.status(404).send({ error: 'Run not found' });
    }

    // SECURITY: Enforce same limits as run creation
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { maxConcurrentRuns: true, dailySpendLimitSeconds: true },
    });

    if (!user) {
      return reply.status(401).send({ error: 'Unauthorized' });
    }

    const activeRuns = await prisma.run.count({
      where: {
        userId,
        status: { in: ['provisioning', 'initializing', 'running', 'uploading_artifacts'] },
      },
    });

    if (activeRuns >= user.maxConcurrentRuns) {
      return reply.status(429).send({
        error: 'Concurrency limit reached',
        message: `You have ${activeRuns} active runs. Maximum allowed is ${user.maxConcurrentRuns}.`
      });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayBilled = await prisma.run.aggregate({
      where: { userId, createdAt: { gte: today } },
      _sum: { billedSeconds: true },
    });

    if ((todayBilled._sum.billedSeconds || 0) >= user.dailySpendLimitSeconds) {
      return reply.status(429).send({
        error: 'Daily limit reached',
        message: 'You have reached your daily GPU runtime limit.',
      });
    }

    // Create a new run with same config
    const newRun = await prisma.run.create({
      data: {
        projectId: oldRun.projectId,
        userId: userId,
        status: 'queued',
        gpuType: oldRun.gpuType,
        gpuCount: oldRun.gpuCount,
        hoursMax: oldRun.hoursMax,
        command: oldRun.command,
        envJson: oldRun.envJson,
        artifactPathsJson: oldRun.artifactPathsJson,
      },
    });

    try {
      const { workspaceId } = await provisioner.provision({
        runId: newRun.id,
        gpuType: newRun.gpuType,
        gpuCount: newRun.gpuCount,
        env: newRun.envJson ? (() => { try { return JSON.parse(newRun.envJson); } catch { return undefined; } })() : undefined,
      });

      const updatedRun = await prisma.run.update({
        where: { id: newRun.id },
        data: { 
          status: 'provisioning',
          upstreamInstanceId: workspaceId,
          infraStartedAt: new Date()
        },
      });
      return reply.status(201).send(updatedRun);
    } catch (err) {
      await prisma.run.update({
        where: { id: newRun.id },
        data: { status: 'failed', errorMessage: 'Retry provisioning failed' },
      });
      return reply.status(500).send({ error: 'Provisioning failed' });
    }
  });

  // POST /v1/runs/:run_id/events (Event Ingestion from Agent)
  fastify.post('/runs/:run_id/events', async (request: any, reply) => {
    const { run_id } = request.params;
    const bearer = extractBearerToken(request.headers.authorization);
    if (!bearer) {
      return reply.status(401).send({ error: 'Missing agent session token' });
    }

    let agentToken;
    try {
      agentToken = verifyAgentSessionToken(fastify, bearer);
    } catch {
      return reply.status(401).send({ error: 'Invalid agent session token' });
    }

    if (agentToken.runId !== run_id) {
      return reply.status(403).send({ error: 'Agent session token does not match run' });
    }

    const session = await prisma.agentSession.findUnique({
      where: { id: agentToken.agentSessionId },
      select: { id: true, runId: true },
    });

    if (!session || session.runId !== run_id) {
      return reply.status(401).send({ error: 'Invalid agent session token' });
    }

    const body = runEventEnvelopeSchema.parse(request.body);

    await prisma.agentSession.update({
      where: { id: session.id },
      data: { lastHeartbeatAt: new Date() },
    });

    const event = await prisma.runEvent.create({
      data: {
        runId: run_id,
        type: body.type,
        payload: JSON.stringify(body.payload),
      },
    });

    fastify.log.info({ run_id, type: body.type, payload: body.payload }, 'Agent event received');

    // Handle specific event types to update Run status
    if (body.type === 'STATUS') {
      const state = body.payload.state;

      // SECURITY: Validate state transitions to prevent billing manipulation
      const VALID_TRANSITIONS: Record<string, string[]> = {
        'queued': ['provisioning', 'failed', 'canceled'],
        'provisioning': ['initializing', 'failed', 'canceled'],
        'initializing': ['running', 'failed', 'canceled'],
        'running': ['uploading_artifacts', 'completed', 'failed', 'canceled', 'timed_out'],
        'uploading_artifacts': ['completed', 'failed'],
      };

      const run = await prisma.run.findUnique({ where: { id: run_id }, select: { status: true, startedAt: true } });
      if (!run) {
        return reply.status(404).send({ error: 'Run not found' });
      }

      const allowed = VALID_TRANSITIONS[run.status];
      if (!allowed || !allowed.includes(state)) {
        return reply.status(400).send({
          error: 'Invalid state transition',
          message: `Cannot transition from '${run.status}' to '${state}'`
        });
      }

      const updateData: any = { status: state };

      if (state === 'running') {
        updateData.startedAt = new Date();
      } else if (['completed', 'failed', 'canceled', 'timed_out'].includes(state)) {
        updateData.finishedAt = new Date();
        updateData.infraFinishedAt = new Date();

        // Calculate billing
        if (run.startedAt) {
          const durationSeconds = Math.ceil((new Date().getTime() - run.startedAt.getTime()) / 1000);
          updateData.billedSeconds = durationSeconds;
        }
      }

      await prisma.run.update({
        where: { id: run_id },
        data: updateData,
      });

      // If finished, trigger billing report (async)
      if (['completed', 'failed', 'canceled', 'timed_out'].includes(state)) {
        reportUsageToStripe(run_id).catch(console.error);
      }
    } else if (body.type === 'LOG') {
      await prisma.runLog.create({
        data: {
          runId: run_id,
          stream: body.payload.stream,
          line: body.payload.line,
          seq: body.payload.seq,
        },
      });
    } else if (body.type === 'ARTIFACT') {
      await prisma.artifact.create({
        data: {
          runId: run_id,
          path: body.payload.path,
          kind: body.payload.kind,
          bytes: BigInt(body.payload.bytes || 0),
          sha256: body.payload.sha256,
        },
      });
    } else if (body.type === 'HEARTBEAT') {
      await prisma.agentSession.update({
        where: { id: session.id },
        data: { lastHeartbeatAt: new Date() },
      });
    }

    return { ok: true };
  });
};
