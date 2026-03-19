import { PrismaClient, Workspace, Prisma } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';
import crypto from 'crypto';

/**
 * Workspace Service
 * 
 * Handles workspace lifecycle operations:
 * - Launch (warm pool assignment or cold creation)
 * - Gateway port allocation with proper auth
 * - Usage session tracking for billing
 * - Termination with billing finalization
 */

const prisma = new PrismaClient();
const TERMINAL_WORKSPACE_STATUSES = new Set(['TERMINATED', 'FAILED']);
const ACTIVE_WORKSPACE_STATUSES = ['RUNNING_ASSIGNED', 'ASSIGNING', 'CREATING', 'WAITING_FOR_AGENT', 'VERIFYING'];
const OPERATION_POLL_MS = 100;
const OPERATION_POLL_TIMEOUT_MS = 5000;

// Generate HMAC signature for gateway requests
function signGatewayRequest(body: object): string {
  const secret = process.env.GATEWAY_SERVICE_SECRET;
  if (!secret) {
    // Development mode - skip signing
    return '';
  }
  
  const hmac = crypto.createHmac('sha256', secret);
  return hmac.update(JSON.stringify(body)).digest('hex');
}

// Generate secure random token for workspace credentials
function generateSecureToken(length: number = 32): string {
  return crypto.randomBytes(length).toString('hex');
}

export class WorkspaceService {
  async launch(userId: string, gpuType: string, region: string, operationKey: string, requestHash: string, maxDurationMinutes?: number, customImage?: string, registryCredentialId?: string) {
    const existing = await prisma.workspaceLaunchOperation.findUnique({
      where: { userId_operationKey: { userId, operationKey } },
      include: { workspace: true },
    });
    if (existing) {
      if (existing.requestHash !== requestHash) {
        throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
      }

      if (existing.workspace) {
        return {
          workspace: existing.workspace,
          operationKey,
          idempotentReplay: true,
        };
      }

      if (existing.status === 'FAILED') {
        throw new Error(existing.lastErrorCode || 'LAUNCH_OPERATION_FAILED');
      }

      const existingWorkspace = await this.waitForOperationWorkspace(userId, operationKey);
      if (existingWorkspace) {
        return {
          workspace: existingWorkspace,
          operationKey,
          idempotentReplay: true,
        };
      }
      throw new Error('OPERATION_IN_PROGRESS');
    }

    try {
      await prisma.workspaceLaunchOperation.create({
        data: {
          userId,
          operationKey,
          requestHash,
          status: 'PROCESSING',
        },
      });
    } catch (err: any) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const conflict = await prisma.workspaceLaunchOperation.findUnique({
          where: { userId_operationKey: { userId, operationKey } },
          include: { workspace: true },
        });

        if (conflict && conflict.requestHash !== requestHash) {
          throw new Error('IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_REQUEST');
        }

        if (conflict?.workspace) {
          return {
            workspace: conflict.workspace,
            operationKey,
            idempotentReplay: true,
          };
        }

        const existingWorkspace = await this.waitForOperationWorkspace(userId, operationKey);
        if (existingWorkspace) {
          return {
            workspace: existingWorkspace,
            operationKey,
            idempotentReplay: true,
          };
        }
        throw new Error('OPERATION_IN_PROGRESS');
      }
      throw err;
    }

    try {
      const workspace = await this.launchWorkspaceInternal(userId, gpuType, region, operationKey, maxDurationMinutes, customImage, registryCredentialId);
      await prisma.workspaceLaunchOperation.update({
        where: { userId_operationKey: { userId, operationKey } },
        data: {
          workspaceId: workspace.id,
          status: 'COMPLETED',
          lastErrorCode: null,
          lastErrorMessage: null,
        },
      });
      return {
        workspace,
        operationKey,
        idempotentReplay: false,
      };
    } catch (err: any) {
      await prisma.workspaceLaunchOperation.update({
        where: { userId_operationKey: { userId, operationKey } },
        data: {
          status: 'FAILED',
          lastErrorCode: err?.code || err?.message || 'LAUNCH_FAILED',
          lastErrorMessage: err?.message || 'Launch failed',
        },
      }).catch(() => {});
      throw err;
    }
  }

  private async waitForOperationWorkspace(userId: string, operationKey: string): Promise<Workspace | null> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < OPERATION_POLL_TIMEOUT_MS) {
      const existing = await prisma.workspaceLaunchOperation.findUnique({
        where: { userId_operationKey: { userId, operationKey } },
        include: { workspace: true },
      });
      if (existing?.workspace) return existing.workspace;
      if (existing?.status === 'FAILED') {
        throw new Error(existing.lastErrorCode || 'LAUNCH_OPERATION_FAILED');
      }
      await new Promise((resolve) => setTimeout(resolve, OPERATION_POLL_MS));
    }
    return null;
  }

  private async launchWorkspaceInternal(userId: string, gpuType: string, region: string, operationKey: string, maxDurationMinutes?: number, customImage?: string, registryCredentialId?: string) {
    // 1. Quota check
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new Error('USER_NOT_FOUND');
    const activeCount = await prisma.workspace.count({
      where: {
        assignedUserId: userId,
        status: { in: ACTIVE_WORKSPACE_STATUSES },
      },
    });

    if (activeCount >= user.maxActiveWorkspaces) {
      throw new Error('MAX_WORKSPACES_REACHED');
    }

    // Parse custom image into repo and tag
    let customImageRepo: string | undefined;
    let customImageTag: string | undefined;
    if (customImage) {
      const colonIdx = customImage.lastIndexOf(':');
      // Handle images like "repo/name:tag" but not "registry.io:5000/repo" (port-only colon)
      if (colonIdx > 0 && !customImage.substring(colonIdx + 1).includes('/')) {
        customImageRepo = customImage.substring(0, colonIdx);
        customImageTag = customImage.substring(colonIdx + 1);
      } else {
        customImageRepo = customImage;
        customImageTag = 'latest';
      }
    }

    // 2. Attempt warm assignment
    const warmWorkspace = await this.findWarmWorkspace(gpuType, region);
    if (warmWorkspace) {
      return this.assignWarmWorkspace(warmWorkspace.id, userId, operationKey, maxDurationMinutes, customImageRepo, customImageTag, registryCredentialId);
    }

    // 3. Cold launch
    return this.createColdWorkspace(userId, gpuType, region, operationKey, maxDurationMinutes, customImageRepo, customImageTag, registryCredentialId);
  }

  private async findWarmWorkspace(gpuType: string, region: string) {
    return prisma.workspace.findFirst({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType,
        region,
        assignedUserId: null,
        isWarmPool: true,
        verificationStatus: 'PASS',
      },
      orderBy: { verificationScore: 'desc' },
    });
  }

  private async assignWarmWorkspace(workspaceId: string, userId: string, operationKey: string, maxDurationMinutes?: number, customImageRepo?: string, customImageTag?: string, registryCredentialId?: string) {
    const workspace = await prisma.$transaction(async (tx) => {
      const ws = await tx.workspace.findUnique({
        where: { id: workspaceId },
      });

      if (!ws || ws.assignedUserId) throw new Error('WORKSPACE_ALREADY_ASSIGNED');

      const updated = await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          assignedUserId: userId,
          assignedAt: new Date(),
          isWarmPool: false,
          status: 'ASSIGNING',
          launchOperationKey: operationKey,
          maxDurationMinutes: maxDurationMinutes ?? null,
          customImageRepo: customImageRepo ?? null,
          customImageTag: customImageTag ?? null,
          registryCredentialId: registryCredentialId ?? null,
        },
      });

      return updated;
    });

    // Allocate gateway ports with secure tokens
    await this.allocateGatewayPorts(workspace.id, workspace.vmInternalIp!);

    // Start usage session
    await this.startUsageSession(userId, workspace.id, workspace.gpuType);

    await prisma.workspace.update({
      where: { id: workspace.id },
      data: { status: 'RUNNING_ASSIGNED' },
    });

    return workspace;
  }

  private async createColdWorkspace(userId: string, gpuType: string, region: string, operationKey: string, maxDurationMinutes?: number, customImageRepo?: string, customImageTag?: string, registryCredentialId?: string) {
    const workspace = await prisma.workspace.create({
      data: {
        assignedUserId: userId,
        gpuType,
        region,
        status: 'CREATING',
        assignedAt: new Date(),
        launchOperationKey: operationKey,
        maxDurationMinutes: maxDurationMinutes ?? null,
        customImageRepo: customImageRepo ?? null,
        customImageTag: customImageTag ?? null,
        registryCredentialId: registryCredentialId ?? null,
      },
    });

    // In production, this would be a background job.
    // For MVP, the worker will handle CREATING -> PROVISIONING
    return workspace;
  }

  async allocateGatewayPorts(workspaceId: string, vmInternalIp: string) {
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || 'http://localhost:5001';
    
    // Generate secure per-workspace credentials
    const jupyterToken = generateSecureToken(32);
    const vscodePassword = generateSecureToken(16);
    
    // Build signed request
    const body = {
      workspace_id: workspaceId,
      vm_internal_ip: vmInternalIp,
      timestamp: Date.now(),
      nonce: uuidv4(),
    };
    
    const signature = signGatewayRequest(body);
    
    const res = await axios.post(`${gatewayUrl}/internal/gateway/allocate`, body, {
      headers: signature ? { 'x-gateway-signature': signature } : {},
    });

    const { gateway_host, ssh_port, jupyter_port, vscode_port } = res.data;

    // Gateway now writes the endpoint record durably on allocate.
    // Upsert here in case gateway already persisted it, or in case gateway
    // is running in ephemeral mode (no DB) and we need to be the writer.
    await prisma.workspaceEndpoint.upsert({
      where: { workspaceId },
      update: {
        gatewayHost: gateway_host,
        sshPort: ssh_port,
        jupyterPort: jupyter_port,
        vscodePort: vscode_port,
        releasedAt: null,
      },
      create: {
        workspaceId,
        gatewayHost: gateway_host,
        sshPort: ssh_port,
        jupyterPort: jupyter_port,
        vscodePort: vscode_port,
      },
    });

    // Build connection URLs with real credentials
    const connect_ssh_command = `ssh -p ${ssh_port} aldaro@${gateway_host}`;
    const connect_jupyter_url = `http://${gateway_host}:${jupyter_port}/?token=${jupyterToken}`;
    const connect_vscode_url = `http://${gateway_host}:${vscode_port}/?tkn=${vscodePassword}`;

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        gatewayHost: gateway_host,
        portSsh: ssh_port,
        portJupyter: jupyter_port,
        portVscode: vscode_port,
        connectSshCommand: connect_ssh_command,
        connectJupyterUrl: connect_jupyter_url,
        connectVscodeUrl: connect_vscode_url,
      },
    });

    // TODO: Send credentials to agent inside VM via secure channel
    // The agent should configure Jupyter with the token and VSCode with the password
    // This could be done via cloud-init, or via a secure agent API call
  }

  async startUsageSession(userId: string, workspaceId: string, gpuType: string) {
    // Guard: do not create a duplicate session for an already-running workspace.
    // Application-level check (fast path) + DB partial unique index (safety net).
    const existing = await prisma.usageSession.findFirst({
      where: { workspaceId, status: 'RUNNING' },
    });
    if (existing) return;

    // Use spot price from WarmPoolConfig if available, fall back to GpuSku base price
    const warmPoolCfg = await prisma.warmPoolConfig.findFirst({
      where: { gpuType },
    });

    let pricePerHourCents = 0;
    if (warmPoolCfg && warmPoolCfg.currentSpotPriceCents > 0) {
      pricePerHourCents = warmPoolCfg.currentSpotPriceCents;

      // Update lastRentalAt to track demand for spot pricing algorithm
      await prisma.warmPoolConfig.update({
        where: { id: warmPoolCfg.id },
        data: { lastRentalAt: new Date() },
      });
    } else {
      const sku = await prisma.gpuSku.findUnique({ where: { key: gpuType } });
      if (!sku) {
        console.error(`[BILLING] GpuSku not found for key "${gpuType}" — session will have $0 pricing`);
      }
      pricePerHourCents = sku?.pricePerHourCents || 0;
    }

    try {
      await prisma.usageSession.create({
        data: {
          userId,
          workspaceId,
          gpuType,
          startTime: new Date(),
          status: 'RUNNING',
          pricePerHourCents,
        },
      });
    } catch (err: any) {
      // P2002 = unique constraint violation from partial index (concurrent race).
      // Another path already created the RUNNING session — safe to ignore.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return;
      }
      throw err;
    }
  }

  async terminate(workspaceId: string, userId: string) {
    const workspace = await prisma.workspace.findFirst({
      where: { id: workspaceId, assignedUserId: userId },
    });
    if (!workspace) {
      throw new Error('WORKSPACE_NOT_FOUND');
    }

    if (TERMINAL_WORKSPACE_STATUSES.has(workspace.status)) {
      return {
        workspaceId,
        status: workspace.status,
        queued: false,
        alreadyFinal: true,
      };
    }

    // Fast path: if no VM was ever provisioned (no proxmoxVmid), terminate
    // directly without needing the worker to clean up infrastructure.
    const hasVm = workspace.proxmoxVmid != null;
    if (!hasVm) {
      await this.endUsageSession(workspaceId);
      await prisma.workspace.update({
        where: { id: workspaceId },
        data: {
          status: 'TERMINATED',
          terminationReason: 'manual',
          terminatedAt: new Date(),
        },
      });
      return {
        workspaceId,
        status: 'TERMINATED',
        queued: false,
        alreadyFinal: false,
      };
    }

    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.workspace.update({
        where: { id: workspaceId },
        data: {
          status: 'TERMINATING',
          terminationReason: 'manual',
          cleanupNextRetryAt: now,
        },
      });

      await tx.workspaceCleanupJob.upsert({
        where: { workspaceId },
        update: {
          reasonCode: 'manual_terminate',
          status: 'PENDING',
          nextAttemptAt: now,
          completedAt: null,
          lastErrorCode: null,
          lastErrorMessage: null,
        },
        create: {
          workspaceId,
          reasonCode: 'manual_terminate',
          status: 'PENDING',
          nextAttemptAt: now,
          maxAttempts: 20,
        },
      });
    });

    return {
      workspaceId,
      status: 'TERMINATING',
      queued: true,
      alreadyFinal: false,
    };
  }

  /**
   * Close a running usage session and atomically enqueue its meter event.
   * Both writes happen in a single DB transaction — if either fails, neither commits.
   * Safe for duplicate calls: skips if session is already ENDED.
   */
  async endUsageSession(workspaceId: string) {
    const session = await prisma.usageSession.findFirst({
      where: { workspaceId, status: 'RUNNING' },
    });

    if (!session) return;

    const endTime = new Date();
    const totalSeconds = Math.max(0, Math.ceil((endTime.getTime() - session.startTime.getTime()) / 1000));
    const billedCents = Math.ceil((totalSeconds * session.pricePerHourCents) / 3600);

    try {
      await prisma.$transaction([
        prisma.usageSession.update({
          where: { id: session.id, status: 'RUNNING' },
          data: {
            endTime,
            totalSeconds,
            billedSeconds: totalSeconds,
            billedCents,
            status: 'ENDED',
          },
        }),
        prisma.workspaceMeterEventOutbox.upsert({
          where: { usageSessionId: session.id },
          update: {
            valueSeconds: totalSeconds,
            status: 'PENDING',
            nextAttemptAt: new Date(),
            lastErrorCode: null,
            lastErrorMessage: null,
          },
          create: {
            usageSessionId: session.id,
            userId: session.userId,
            workspaceId,
            valueSeconds: totalSeconds,
            status: 'PENDING',
            nextAttemptAt: new Date(),
          },
        }),
      ]);
    } catch (err: any) {
      // P2025 = session already closed by a concurrent path (worker cleanup racing API terminate).
      // Safe to ignore — the session is already ENDED with an outbox entry.
      if (err?.code === 'P2025') return;
      throw err;
    }

    // INV-3 invariant check: outbox entry must exist after successful close
    const outboxCheck = await prisma.workspaceMeterEventOutbox.findUnique({
      where: { usageSessionId: session.id },
    });
    if (!outboxCheck) {
      console.error(JSON.stringify({
        level: 'error', service: 'api', event: 'invariant_violation',
        invariant: 'INV-3', message: 'Session closed but no outbox entry found',
        sessionId: session.id, workspaceId, timestamp: new Date().toISOString(),
      }));
    }
  }

  private async releaseGatewayPorts(workspaceId: string) {
    const gatewayUrl = process.env.GATEWAY_INTERNAL_URL || 'http://localhost:5001';
    
    const body = {
      workspace_id: workspaceId,
      timestamp: Date.now(),
      nonce: uuidv4(),
    };
    
    const signature = signGatewayRequest(body);
    
    await axios.post(`${gatewayUrl}/internal/gateway/release`, body, {
      headers: signature ? { 'x-gateway-signature': signature } : {},
    });

    await prisma.workspaceEndpoint.updateMany({
      where: { workspaceId },
      data: { releasedAt: new Date() },
    });
  }
}

export const workspaceService = new WorkspaceService();
