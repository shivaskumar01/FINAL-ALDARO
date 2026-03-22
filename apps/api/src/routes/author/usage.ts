/**
 * Author Portal Usage Routes
 * 
 * Provides dashboard data for the author portal including:
 * - Live usage metrics
 * - Fleet health snapshots
 * - Customer usage tables
 * - Experience KPIs
 */

import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { prisma } from '@aldaro/db';

// Redis client for caching (optional) - only connect when REDIS_URL is set
let redisClient: any = null;
const redisUrl = process.env.REDIS_URL?.trim();
if (redisUrl) {
  try {
    const Redis = require('ioredis');
    redisClient = new Redis(redisUrl);
    redisClient.on('error', () => { redisClient = null; });
  } catch {
    console.log('Redis not available, caching disabled');
  }
}

async function getCached<T>(key: string, ttlSeconds: number, fetcher: () => Promise<T>): Promise<T> {
  if (!redisClient) return fetcher();
  try {
    const cached = await redisClient.get(key);
    if (cached) return JSON.parse(cached);
    const data = await fetcher();
    await redisClient.setex(key, ttlSeconds, JSON.stringify(data));
    return data;
  } catch {
    return fetcher();
  }
}

export const authorUsageRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // All routes require author authentication
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireAuthor as any);

  // =========================================================================
  // GET /author/usage/overview
  // Returns all dashboard data for the overview page
  // =========================================================================
  fastify.get('/overview', async (request: any) => {
    const { window = '24h' } = request.query as { window?: string };
    const windowMs = parseWindow(window);
    const windowStart = new Date(Date.now() - windowMs);

    return getCached(`author:overview:${window}`, 5, async () => {
      const [
        liveNow,
        experienceKPIs,
        fleetHealth,
        billingHealth,
        recentChanges,
      ] = await Promise.all([
        getLiveNowMetrics(),
        getExperienceKPIs(windowStart),
        getFleetHealthSnapshot(),
        getBillingHealthSnapshot(windowStart),
        getRecentChanges(windowStart),
      ]);

      return {
        liveNow,
        experienceKPIs,
        fleetHealth,
        billingHealth,
        recentChanges,
        generatedAt: new Date().toISOString(),
      };
    });
  });

  // =========================================================================
  // GET /author/usage/customers
  // Returns customer usage table with rollups
  // =========================================================================
  fastify.get('/customers', async (request: any) => {
    const { 
      window = '24h', 
      limit = 200, 
      cursor,
      search,
      sortBy = 'gpuHours24h',
      sortDir = 'desc',
    } = request.query as any;
    
    const windowMs = parseWindow(window);
    const windowStart = new Date(Date.now() - windowMs);

    return getCached(`author:customers:${window}:${limit}:${cursor || ''}:${search || ''}`, 30, async () => {
      // Get all users with workspace activity
      const users = await prisma.user.findMany({
        where: search ? {
          OR: [
            { email: { contains: search } },
            { id: { contains: search } },
          ],
        } : undefined,
        take: parseInt(limit) + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        select: {
          id: true,
          email: true,
          paymentStatus: true,
          createdAt: true,
          lastLoginAt: true,
          role: true,
        },
      });

      const hasMore = users.length > parseInt(limit);
      const items = users.slice(0, parseInt(limit));
      const nextCursor = hasMore ? items[items.length - 1]?.id : null;

      // Enrich with usage data
      const enrichedUsers = await Promise.all(
        items.map(async (user) => {
          const [
            workspacesNow,
            gpusNow,
            sessions24h,
            sessions7d,
            lastWorkspace,
            provisionFailures24h,
          ] = await Promise.all([
            // Workspaces running now
            prisma.workspace.count({
              where: {
                assignedUserId: user.id,
                status: { in: ['RUNNING_ASSIGNED', 'IDLE'] },
              },
            }),
            // GPUs in use now
            prisma.workspace.count({
              where: {
                assignedUserId: user.id,
                status: { in: ['RUNNING_ASSIGNED', 'IDLE'] },
                gpuAllocation: { isNot: null },
              },
            }),
            // GPU hours last 24h
            prisma.usageSession.aggregate({
              where: {
                userId: user.id,
                OR: [
                  { startTime: { gte: windowStart } },
                  { endTime: { gte: windowStart } },
                ],
              },
              _sum: { billedSeconds: true },
            }),
            // GPU hours last 7d
            prisma.usageSession.aggregate({
              where: {
                userId: user.id,
                OR: [
                  { startTime: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
                  { endTime: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
                ],
              },
              _sum: { billedSeconds: true },
            }),
            // Last workspace
            prisma.workspace.findFirst({
              where: { assignedUserId: user.id },
              orderBy: { createdAt: 'desc' },
              select: {
                id: true,
                createdAt: true,
                startedAt: true,
                lastAgentHeartbeatAt: true,
                firstConnectAt: true,
              },
            }),
            // Provision failures
            prisma.workspace.count({
              where: {
                assignedUserId: user.id,
                status: 'FAILED',
                failedAt: { gte: windowStart },
              },
            }),
          ]);

          const gpuHours24h = (sessions24h._sum.billedSeconds || 0) / 3600;
          const gpuHours7d = (sessions7d._sum.billedSeconds || 0) / 3600;

          return {
            ...user,
            activeNow: workspacesNow > 0,
            workspacesRunningNow: workspacesNow,
            gpusInUseNow: gpusNow,
            gpuHours24h: Math.round(gpuHours24h * 100) / 100,
            gpuHours7d: Math.round(gpuHours7d * 100) / 100,
            provisionFailures24h,
            lastWorkspaceStartedAt: lastWorkspace?.startedAt || lastWorkspace?.createdAt,
            lastHeartbeatAt: lastWorkspace?.lastAgentHeartbeatAt,
            lastConnectAt: lastWorkspace?.firstConnectAt,
            supportRiskScore: calculateSupportRiskScore({
              paymentFailed: user.paymentStatus === 'BLOCKED',
              provisionFailures24h,
              gpuHours24h,
            }),
          };
        })
      );

      // Sort
      enrichedUsers.sort((a, b) => {
        const aVal = (a as any)[sortBy] || 0;
        const bVal = (b as any)[sortBy] || 0;
        return sortDir === 'desc' ? bVal - aVal : aVal - bVal;
      });

      return {
        items: enrichedUsers,
        nextCursor,
        hasMore,
        total: await prisma.user.count(),
      };
    });
  });

  // =========================================================================
  // GET /author/usage/customers/:userId
  // Returns detailed customer view
  // =========================================================================
  fastify.get('/customers/:userId', async (request: any, reply: any) => {
    const { userId } = request.params;
    const { window = '7d' } = request.query as { window?: string };
    const windowMs = parseWindow(window);
    const windowStart = new Date(Date.now() - windowMs);

    const [user, workspaces, sessions, events] = await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          paymentStatus: true,
          createdAt: true,
          lastLoginAt: true,
          stripeCustomerId: true,
          maxActiveWorkspaces: true,
        },
      }),
      // Current workspaces
      prisma.workspace.findMany({
        where: {
          assignedUserId: userId,
          status: { in: ['RUNNING_ASSIGNED', 'IDLE', 'CREATING', 'WAITING_FOR_AGENT'] },
        },
        include: {
          gpuAllocation: { include: { gpu: true } },
          endpoint: true,
        },
        orderBy: { createdAt: 'desc' },
      }),
      // Recent sessions
      prisma.usageSession.findMany({
        where: {
          userId,
          startTime: { gte: windowStart },
        },
        orderBy: { startTime: 'desc' },
        take: 100,
      }),
      // Experience events
      prisma.experienceEvent.findMany({
        where: {
          userId,
          createdAt: { gte: windowStart },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);

    if (!user) return reply.status(404).send({ error: 'User not found' });

    // Calculate funnel metrics
    const funnel = await calculateUserFunnel(userId, windowStart);

    return {
      user,
      currentWorkspaces: workspaces,
      recentSessions: sessions,
      experienceTimeline: events,
      funnel,
    };
  });

  // =========================================================================
  // GET /author/usage/workspaces
  // Returns workspace list with filters
  // =========================================================================
  fastify.get('/workspaces', async (request: any) => {
    const {
      status,
      gpuType,
      node,
      userId,
      stuck,
      limit = 200,
      cursor,
    } = request.query as any;

    const where: any = {};
    if (status) where.status = status;
    if (gpuType) where.gpuType = gpuType;
    if (node) where.proxmoxNode = node;
    if (userId) where.assignedUserId = userId;
    if (stuck === 'true') {
      where.status = { in: ['CREATING', 'WAITING_FOR_AGENT', 'VERIFYING'] };
      where.createdAt = { lt: new Date(Date.now() - 5 * 60 * 1000) }; // >5 min old
    }

    return getCached(`author:workspaces:${JSON.stringify(where)}:${limit}:${cursor || ''}`, 10, async () => {
      const workspaces = await prisma.workspace.findMany({
        where,
        take: parseInt(limit) + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        orderBy: { createdAt: 'desc' },
        include: {
          assignedUser: { select: { id: true, email: true } },
          gpuAllocation: { include: { gpu: true, node: true } },
          endpoint: true,
        },
      });

      const hasMore = workspaces.length > parseInt(limit);
      const items = workspaces.slice(0, parseInt(limit));

      return {
        items: items.map(ws => ({
          ...ws,
          provisionDurationMs: ws.startedAt && ws.createdAt
            ? ws.startedAt.getTime() - ws.createdAt.getTime()
            : null,
        })),
        nextCursor: hasMore ? items[items.length - 1]?.id : null,
        hasMore,
      };
    });
  });

  // =========================================================================
  // GET /author/usage/workspaces/:workspaceId
  // Returns detailed workspace view with provisioning trace
  // =========================================================================
  fastify.get('/workspaces/:workspaceId', async (request: any, reply: any) => {
    const { workspaceId } = request.params;

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      include: {
        assignedUser: { select: { id: true, email: true } },
        gpuAllocation: { include: { gpu: true, node: true } },
        endpoint: true,
        verifications: { orderBy: { ranAt: 'desc' }, take: 5 },
      },
    });
    if (!workspace) return reply.status(404).send({ error: 'Workspace not found' });

    const [events, sessions] = await Promise.all([
      prisma.experienceEvent.findMany({
        where: { workspaceId },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.usageSession.findMany({
        where: { workspaceId },
        orderBy: { startTime: 'desc' },
      }),
    ]);

    // Build provisioning trace
    const provisioningTrace = buildProvisioningTrace(workspace);

    return {
      workspace,
      provisioningTrace,
      experienceEvents: events,
      usageSessions: sessions,
    };
  });

  // =========================================================================
  // GET /author/usage/fleet
  // Returns fleet summary
  // =========================================================================
  fastify.get('/fleet', async (request: any) => {
    return getCached('author:fleet', 10, async () => {
      const [
        gpusByStatus,
        gpusByType,
        gpusByNode,
        nodes,
        warmPool,
      ] = await Promise.all([
        prisma.fleetGpu.groupBy({
          by: ['status'],
          _count: true,
        }),
        prisma.fleetGpu.groupBy({
          by: ['gpuType'],
          _count: true,
        }),
        prisma.fleetGpu.groupBy({
          by: ['nodeId'],
          _count: true,
        }),
        prisma.fleetNode.findMany({
          include: {
            _count: { select: { gpus: true } },
          },
        }),
        prisma.workspace.groupBy({
          by: ['gpuType'],
          where: { status: 'WARM_AVAILABLE' },
          _count: true,
        }),
      ]);

      // Get warm pool targets
      const warmPoolConfigs = await prisma.warmPoolConfig.findMany();
      const warmPoolStatus = warmPoolConfigs.map(config => {
        const actual = warmPool.find(w => w.gpuType === config.gpuType)?._count || 0;
        return {
          gpuType: config.gpuType,
          region: config.region,
          target: config.targetCount,
          actual,
          shortfall: Math.max(0, config.targetCount - actual),
        };
      });

      return {
        gpusByStatus: Object.fromEntries(gpusByStatus.map(g => [g.status, g._count])),
        gpusByType: Object.fromEntries(gpusByType.map(g => [g.gpuType || 'UNKNOWN', g._count])),
        nodes: nodes.map(n => ({
          ...n,
          gpuCount: n._count.gpus,
        })),
        warmPool: warmPoolStatus,
        generatedAt: new Date().toISOString(),
      };
    });
  });

  // =========================================================================
  // GET /author/usage/incidents
  // Returns incidents list with optional status (comma-separated) and severity
  // =========================================================================
  fastify.get('/incidents', async (request: any) => {
    const { status, severity, limit: limitParam } = request.query as any;
    const limit = Math.min(Math.max(parseInt(limitParam, 10) || 100, 1), 500);
    const where: any = {};
    if (status) {
      const statuses = String(status).split(',').map((s: string) => s.trim()).filter(Boolean);
      if (statuses.length > 0) where.status = { in: statuses };
    }
    if (severity) where.severity = severity;

    // Short cache (5s) so authors see fresh incident updates
    return getCached(`author:incidents:${status || 'all'}:${severity || 'all'}:${limit}`, 5, async () => {
      const incidents = await prisma.incident.findMany({
        where,
        orderBy: [{ status: 'asc' }, { lastSeenAt: 'desc' }], // OPEN/ACKED first, then by recent
        take: limit,
      });
      return { items: incidents };
    });
  });

  // =========================================================================
  // POST /author/usage/incidents - Create manual incident
  // =========================================================================
  fastify.post('/incidents', async (request: any, reply: any) => {
    const body = request.body as { title: string; description?: string; severity?: string; type?: string };
    const title = body.title?.trim();
    if (!title || title.length > 200) {
      return reply.status(400).send({ error: 'Title is required (max 200 characters)' });
    }
    const severity = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'].includes(body.severity || '') ? body.severity : 'MEDIUM';
    const type = (body.type?.trim() || 'manual').replace(/[^a-z0-9_]/gi, '_').slice(0, 64) || 'manual';
    const incident = await prisma.incident.create({
      data: {
        type,
        severity,
        title,
        description: body.description?.trim()?.slice(0, 2000) || null,
        status: 'OPEN',
        count: 1,
      },
    });
    return incident;
  });

  // =========================================================================
  // POST /author/actions/terminate-workspace
  // Terminates a workspace (idempotent)
  // =========================================================================
  fastify.post('/actions/terminate-workspace', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request: any) => {
    const { workspaceId, reason } = request.body as { workspaceId: string; reason?: string };
    const actorId = request.user.userId;

    const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId } });
    if (!workspace) {
      return { success: false, error: 'Workspace not found' };
    }

    if (['TERMINATED', 'FAILED'].includes(workspace.status)) {
      return { success: true, message: 'Already terminated' };
    }

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        status: 'TERMINATING',
        terminationReason: reason || 'author_action',
      },
    });

    // Log audit event
    await prisma.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: 'terminate_workspace',
        targetType: 'workspace',
        targetId: workspaceId,
        diffJson: JSON.stringify({ reason }),
      },
    });

    return { success: true };
  });

  // =========================================================================
  // POST /author/actions/disable-gpu
  // Disables a GPU
  // =========================================================================
  fastify.post('/actions/disable-gpu', {
    config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  }, async (request: any) => {
    const { gpuId, reason } = request.body as { gpuId: string; reason?: string };
    const actorId = request.user.userId;

    await prisma.fleetGpu.update({
      where: { id: gpuId },
      data: { status: 'DISABLED' },
    });

    await prisma.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: 'disable_gpu',
        targetType: 'gpu',
        targetId: gpuId,
        diffJson: JSON.stringify({ reason }),
      },
    });

    return { success: true };
  });

  // =========================================================================
  // POST /author/actions/drain-node
  // Enables/disables a node for new workloads
  // =========================================================================
  fastify.post('/actions/drain-node', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request: any) => {
    const { nodeId, enabled } = request.body as { nodeId: string; enabled: boolean };
    const actorId = request.user.userId;

    await prisma.fleetNode.update({
      where: { id: nodeId },
      data: { status: enabled ? 'ACTIVE' : 'DRAINING' },
    });

    await prisma.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: enabled ? 'enable_node' : 'drain_node',
        targetType: 'node',
        targetId: nodeId,
      },
    });

    return { success: true };
  });

  // =========================================================================
  // POST /author/actions/enable-gpu
  // Enables a previously disabled GPU
  // =========================================================================
  fastify.post('/actions/enable-gpu', async (request: any) => {
    const { gpuId, reason } = request.body as { gpuId: string; reason?: string };
    const actorId = request.user.userId;

    const gpu = await prisma.fleetGpu.findUnique({ where: { id: gpuId } });
    if (!gpu) {
      return { success: false, error: 'GPU not found' };
    }

    await prisma.fleetGpu.update({
      where: { id: gpuId },
      data: { status: 'FREE' },
    });

    await prisma.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: 'enable_gpu',
        targetType: 'gpu',
        targetId: gpuId,
        diffJson: JSON.stringify({ reason, previousStatus: gpu.status }),
      },
    });

    return { success: true };
  });

  // =========================================================================
  // POST /author/actions/emergency-stop
  // Stops all provisioning activity (circuit breaker)
  // =========================================================================
  fastify.post('/actions/emergency-stop', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request: any) => {
    const { enabled, reason } = request.body as { enabled: boolean; reason: string };
    const actorId = request.user.userId;

    if (!reason) {
      return { success: false, error: 'Reason is required for emergency stop' };
    }

    // Update config change
    await prisma.configChange.create({
      data: {
        actorId,
        configType: 'emergency',
        configKey: 'provisioning_stopped',
        oldValue: enabled ? 'false' : 'true',
        newValue: enabled ? 'true' : 'false',
        reason,
      },
    });

    await prisma.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: enabled ? 'emergency_stop_enabled' : 'emergency_stop_disabled',
        targetType: 'system',
        targetId: 'provisioning',
        diffJson: JSON.stringify({ reason }),
      },
    });

    // Also create an incident if stopping
    if (enabled) {
      await prisma.incident.create({
        data: {
          type: 'emergency_stop',
          severity: 'CRITICAL',
          title: 'Emergency provisioning stop activated',
          description: reason,
          status: 'OPEN',
          ownerId: actorId,
        },
      });
    }

    return { success: true };
  });

  // =========================================================================
  // POST /author/actions/update-warm-pool
  // Updates warm pool targets
  // =========================================================================
  fastify.post('/actions/update-warm-pool', async (request: any) => {
    const { gpuType, region, targetCount, reason } = request.body as { 
      gpuType: string; 
      region: string; 
      targetCount: number;
      reason?: string;
    };
    const actorId = request.user.userId;

    const existing = await prisma.warmPoolConfig.findUnique({
      where: { region_gpuType: { region, gpuType } },
    });

    const oldCount = existing?.targetCount ?? 0;

    await prisma.warmPoolConfig.upsert({
      where: { region_gpuType: { region, gpuType } },
      update: { targetCount },
      create: { region, gpuType, targetCount },
    });

    await prisma.configChange.create({
      data: {
        actorId,
        configType: 'warm_pool',
        configKey: `${region}/${gpuType}/targetCount`,
        oldValue: String(oldCount),
        newValue: String(targetCount),
        reason,
      },
    });

    await prisma.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: 'update_warm_pool',
        targetType: 'warm_pool_config',
        targetId: `${region}/${gpuType}`,
        diffJson: JSON.stringify({ oldCount, newCount: targetCount, reason }),
      },
    });

    return { success: true };
  });

  // =========================================================================
  // POST /author/actions/acknowledge-incident
  // Acknowledge an incident
  // =========================================================================
  fastify.post('/actions/acknowledge-incident', async (request: any) => {
    const { incidentId, notes } = request.body as { incidentId: string; notes?: string };
    const actorId = request.user.userId;

    await prisma.incident.update({
      where: { id: incidentId },
      data: {
        status: 'ACKED',
        ownerId: actorId,
        notes: notes ?? undefined,
      },
    });

    await prisma.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: 'acknowledge_incident',
        targetType: 'incident',
        targetId: incidentId,
        diffJson: JSON.stringify({ notes }),
      },
    });

    return { success: true };
  });

  // =========================================================================
  // POST /author/actions/resolve-incident
  // Resolve an incident
  // =========================================================================
  fastify.post('/actions/resolve-incident', async (request: any) => {
    const { incidentId, notes } = request.body as { incidentId: string; notes?: string };
    const actorId = request.user.userId;

    await prisma.incident.update({
      where: { id: incidentId },
      data: {
        status: 'RESOLVED',
        resolvedAt: new Date(),
        notes: notes || undefined,
      },
    });

    await prisma.authorAudit.create({
      data: {
        actorUserId: actorId,
        action: 'resolve_incident',
        targetType: 'incident',
        targetId: incidentId,
        diffJson: JSON.stringify({ notes }),
      },
    });

    return { success: true };
  });

  // =========================================================================
  // GET /author/audit-timeline
  // Returns the audit timeline for the author portal
  // =========================================================================
  fastify.get('/audit-timeline', async (request: any) => {
    const { window = '24h', limit = 100 } = request.query as any;
    const windowMs = parseWindow(window);
    const windowStart = new Date(Date.now() - windowMs);

    const [audits, configChanges, incidents] = await Promise.all([
      prisma.authorAudit.findMany({
        where: { createdAt: { gte: windowStart } },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
        include: { actor: { select: { email: true } } },
      }),
      prisma.configChange.findMany({
        where: { createdAt: { gte: windowStart } },
        orderBy: { createdAt: 'desc' },
        take: parseInt(limit),
      }),
      prisma.incident.findMany({
        where: { firstSeenAt: { gte: windowStart } },
        orderBy: { firstSeenAt: 'desc' },
        take: parseInt(limit),
      }),
    ]);

    // Combine into timeline
    const timeline = [
      ...audits.map(a => ({
        type: 'audit',
        timestamp: a.createdAt,
        action: a.action,
        actor: a.actor?.email,
        target: `${a.targetType}:${a.targetId}`,
        details: a.diffJson ? JSON.parse(a.diffJson) : null,
      })),
      ...configChanges.map(c => ({
        type: 'config',
        timestamp: c.createdAt,
        action: 'config_change',
        actor: c.actorId,
        target: `${c.configType}:${c.configKey}`,
        details: { old: c.oldValue, new: c.newValue, reason: c.reason },
      })),
      ...incidents.map(i => ({
        type: 'incident',
        timestamp: i.firstSeenAt,
        action: `incident_${i.status.toLowerCase()}`,
        actor: null,
        target: i.type,
        details: { severity: i.severity, title: i.title, count: i.count },
      })),
    ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
     .slice(0, parseInt(limit));

    return { timeline };
  });
};

// =============================================================================
// Helper Functions
// =============================================================================

function parseWindow(window: string): number {
  const match = window.match(/^(\d+)(h|d)$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === 'h' ? value * 60 * 60 * 1000 : value * 24 * 60 * 60 * 1000;
}

async function getLiveNowMetrics() {
  const [
    activeUsers,
    usersUsingGpus,
    activeWorkspaces,
    provisioningWorkspaces,
    activeGpus,
    freeGpus,
    warmPool,
    connectionHealth,
  ] = await Promise.all([
    // Active users now
    prisma.workspace.findMany({
      where: { status: { in: ['RUNNING_ASSIGNED', 'IDLE'] } },
      select: { assignedUserId: true },
      distinct: ['assignedUserId'],
    }),
    // Users using GPUs now
    prisma.workspace.findMany({
      where: {
        status: { in: ['RUNNING_ASSIGNED', 'IDLE'] },
        gpuAllocation: { isNot: null },
      },
      select: { assignedUserId: true },
      distinct: ['assignedUserId'],
    }),
    // Active workspaces
    prisma.workspace.count({
      where: { status: { in: ['RUNNING_ASSIGNED', 'IDLE'] } },
    }),
    // Provisioning workspaces
    prisma.workspace.count({
      where: { status: { in: ['CREATING', 'WAITING_FOR_AGENT', 'VERIFYING'] } },
    }),
    // Active GPUs
    prisma.fleetGpu.count({
      where: { status: 'ATTACHED' },
    }),
    // Free GPUs
    prisma.fleetGpu.count({
      where: { status: 'FREE' },
    }),
    // Warm pool by type
    prisma.workspace.groupBy({
      by: ['gpuType'],
      where: { status: 'WARM_AVAILABLE' },
      _count: true,
    }),
    // Connection health (workspaces with recent heartbeat)
    getConnectionHealth(),
  ]);

  return {
    activeUsersNow: activeUsers.filter(u => u.assignedUserId).length,
    usersUsingGpusNow: usersUsingGpus.filter(u => u.assignedUserId).length,
    activeWorkspacesNow: activeWorkspaces,
    provisioningWorkspacesNow: provisioningWorkspaces,
    activeGpusNow: activeGpus,
    freeGpusNow: freeGpus,
    queueDepthNow: provisioningWorkspaces,
    warmPoolNow: Object.fromEntries(warmPool.map(w => [w.gpuType, w._count])),
    connectionHealthPct: connectionHealth,
  };
}

async function getConnectionHealth(): Promise<number> {
  const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
  
  const [total, healthy] = await Promise.all([
    prisma.workspace.count({
      where: { status: { in: ['RUNNING_ASSIGNED', 'IDLE'] } },
    }),
    prisma.workspace.count({
      where: {
        status: { in: ['RUNNING_ASSIGNED', 'IDLE'] },
        lastAgentHeartbeatAt: { gte: thirtySecondsAgo },
      },
    }),
  ]);

  return total > 0 ? Math.round((healthy / total) * 100) : 100;
}

async function getExperienceKPIs(windowStart: Date) {
  // Get successful provisions in window
  const successfulProvisions = await prisma.workspace.findMany({
    where: {
      startedAt: { gte: windowStart },
      status: { in: ['RUNNING_ASSIGNED', 'TERMINATED', 'IDLE'] },
    },
    select: {
      createdAt: true,
      startedAt: true,
      firstConnectAt: true,
    },
  });

  const totalProvisions = await prisma.workspace.count({
    where: { createdAt: { gte: windowStart } },
  });

  const failedProvisions = await prisma.workspace.count({
    where: {
      createdAt: { gte: windowStart },
      status: 'FAILED',
    },
  });

  // Calculate provision times
  const provisionTimes = successfulProvisions
    .filter(w => w.startedAt && w.createdAt)
    .map(w => w.startedAt!.getTime() - w.createdAt.getTime())
    .sort((a, b) => a - b);

  const median = provisionTimes.length > 0
    ? provisionTimes[Math.floor(provisionTimes.length / 2)]
    : null;

  const p95 = provisionTimes.length > 0
    ? provisionTimes[Math.floor(provisionTimes.length * 0.95)]
    : null;

  // Calculate connect times
  const connectTimes = successfulProvisions
    .filter(w => w.firstConnectAt && w.startedAt)
    .map(w => w.firstConnectAt!.getTime() - w.startedAt!.getTime())
    .sort((a, b) => a - b);

  const medianConnectTime = connectTimes.length > 0
    ? connectTimes[Math.floor(connectTimes.length / 2)]
    : null;

  // GPU hours
  const gpuHours = await prisma.usageSession.aggregate({
    where: {
      OR: [
        { startTime: { gte: windowStart } },
        { endTime: { gte: windowStart } },
      ],
    },
    _sum: { billedSeconds: true },
  });

  // Idle terminations
  const idleTerminations = await prisma.workspace.count({
    where: {
      terminatedAt: { gte: windowStart },
      terminationReason: 'idle',
    },
  });

  // Average session duration
  const avgSession = await prisma.usageSession.aggregate({
    where: {
      endTime: { gte: windowStart },
      status: { in: ['ENDED', 'COMPLETED'] },
    },
    _avg: { totalSeconds: true },
  });

  return {
    medianTimeToRunningMs: median,
    p95TimeToRunningMs: p95,
    provisionSuccessRate: totalProvisions > 0
      ? Math.round(((totalProvisions - failedProvisions) / totalProvisions) * 100)
      : 100,
    provisionFailures: failedProvisions,
    medianTimeToConnectMs: medianConnectTime,
    gpuHoursUsed: Math.round((gpuHours._sum.billedSeconds || 0) / 3600 * 100) / 100,
    idleTerminations,
    avgSessionDurationMinutes: avgSession._avg.totalSeconds
      ? Math.round(avgSession._avg.totalSeconds / 60)
      : null,
  };
}

async function getFleetHealthSnapshot() {
  const [
    nodes,
    degradedGpus,
    disabledGpus,
    heartbeatMisses,
  ] = await Promise.all([
    prisma.fleetNode.findMany({
      select: { id: true, status: true },
    }),
    prisma.fleetGpu.count({ where: { status: 'DEGRADED' } }),
    prisma.fleetGpu.count({ where: { status: 'DISABLED' } }),
    // Workspaces with stale heartbeat (>60s)
    prisma.workspace.count({
      where: {
        status: { in: ['RUNNING_ASSIGNED', 'IDLE'] },
        lastAgentHeartbeatAt: { lt: new Date(Date.now() - 60 * 1000) },
      },
    }),
  ]);

  const healthyNodes = nodes.filter(n => n.status === 'ACTIVE').length;

  return {
    nodesHealthy: healthyNodes,
    nodesTotal: nodes.length,
    gpusDegraded: degradedGpus,
    gpusDisabled: disabledGpus,
    heartbeatMisses,
    orphanRisk: 0, // Would need to check Proxmox
  };
}

async function getBillingHealthSnapshot(windowStart: Date) {
  const [blocked, graceperiod, sessions] = await Promise.all([
    prisma.user.count({ where: { paymentStatus: 'BLOCKED' } }),
    prisma.user.count({ where: { paymentStatus: 'GRACE_PERIOD' } }),
    prisma.usageSession.aggregate({
      where: {
        OR: [
          { startTime: { gte: windowStart } },
          { endTime: { gte: windowStart } },
        ],
      },
      _sum: { billedCents: true },
    }),
  ]);

  return {
    customersBlocked: blocked,
    customersGracePeriod: graceperiod,
    paymentFailures24h: 0, // Would need Stripe events
    revenueEstimate24hCents: sessions._sum.billedCents || 0,
  };
}

async function getRecentChanges(windowStart: Date) {
  const [leaderChanges, deploys, configChanges] = await Promise.all([
    prisma.workerLeader.findFirst(),
    prisma.deployVersion.findMany({
      where: { createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
    prisma.configChange.findMany({
      where: { createdAt: { gte: windowStart } },
      orderBy: { createdAt: 'desc' },
      take: 10,
    }),
  ]);

  return {
    currentLeader: leaderChanges,
    recentDeploys: deploys,
    recentConfigChanges: configChanges,
  };
}

async function calculateUserFunnel(userId: string, windowStart: Date) {
  const [
    loginAttempts,
    successfulLogins,
    workspacesCreated,
    workspacesRunning,
    workspacesConnected,
    sessionsOver10Min,
    sessionsBilled,
  ] = await Promise.all([
    prisma.experienceEvent.count({
      where: {
        userId,
        type: { in: ['auth.login_success', 'auth.login_failed'] },
        createdAt: { gte: windowStart },
      },
    }),
    prisma.experienceEvent.count({
      where: {
        userId,
        type: 'auth.login_success',
        createdAt: { gte: windowStart },
      },
    }),
    prisma.workspace.count({
      where: {
        assignedUserId: userId,
        createdAt: { gte: windowStart },
      },
    }),
    prisma.workspace.count({
      where: {
        assignedUserId: userId,
        createdAt: { gte: windowStart },
        startedAt: { not: null },
      },
    }),
    prisma.workspace.count({
      where: {
        assignedUserId: userId,
        createdAt: { gte: windowStart },
        firstConnectAt: { not: null },
      },
    }),
    prisma.usageSession.count({
      where: {
        userId,
        startTime: { gte: windowStart },
        totalSeconds: { gte: 600 },
      },
    }),
    prisma.usageSession.count({
      where: {
        userId,
        startTime: { gte: windowStart },
        billedCents: { gt: 0 },
      },
    }),
  ]);

  return {
    loginAttempts,
    successfulLogins,
    workspacesCreated,
    workspacesReachedRunning: workspacesRunning,
    workspacesFirstConnect: workspacesConnected,
    sessionsOver10Min,
    sessionsBilledSuccessfully: sessionsBilled,
  };
}

function calculateSupportRiskScore(data: {
  paymentFailed: boolean;
  provisionFailures24h: number;
  gpuHours24h: number;
}): number {
  let score = 0;
  if (data.paymentFailed) score += 30;
  if (data.provisionFailures24h >= 2) score += 20;
  if (data.provisionFailures24h >= 1) score += 10;
  // Could add more signals
  return Math.min(100, score);
}

function buildProvisioningTrace(workspace: any) {
  const stages = [
    { name: 'created', time: workspace.createdAt },
    { name: 'provision_started', time: workspace.provisionStartedAt },
    { name: 'clone_complete', time: workspace.cloneCompletedAt },
    { name: 'gpu_attached', time: workspace.gpuAttachedAt },
    { name: 'boot_complete', time: workspace.bootCompletedAt },
    { name: 'ip_discovered', time: workspace.ipDiscoveredAt },
    { name: 'agent_registered', time: workspace.agentRegisteredAt },
    { name: 'first_heartbeat', time: workspace.lastAgentHeartbeatAt },
    { name: 'running', time: workspace.startedAt },
  ].filter(s => s.time);

  // Calculate durations between stages
  const trace = stages.map((stage, i) => ({
    stage: stage.name,
    timestamp: stage.time,
    durationFromPrevMs: i > 0 && stages[i - 1].time
      ? stage.time.getTime() - stages[i - 1].time.getTime()
      : null,
  }));

  return trace;
}

export default authorUsageRoutes;
