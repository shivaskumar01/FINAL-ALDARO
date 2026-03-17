/**
 * Experience Event Emitter
 * 
 * Lightweight events for tracking user journey and experience metrics.
 * Used by the author portal to measure real user experience.
 * 
 * Event Types:
 * - auth.login_success / auth.login_failed
 * - workspace.created / workspace.provision_started
 * - workspace.clone_complete / workspace.gpu_attached
 * - workspace.boot_running / workspace.ip_discovered
 * - agent.registered / agent.heartbeat
 * - gateway.ports_allocated
 * - connect.ssh_success / connect.ssh_failed
 * - connect.jupyter_success / connect.jupyter_failed
 * - workspace.terminated / workspace.failed
 * - billing.meter_emitted / billing.meter_success / billing.meter_failed
 * - billing.payment_failed / billing.blocked
 */

import { prisma } from '@aldaro/db';
import crypto from 'crypto';

export enum ExperienceEventType {
  // Auth events
  AUTH_LOGIN_SUCCESS = 'auth.login_success',
  AUTH_LOGIN_FAILED = 'auth.login_failed',
  AUTH_LOGOUT = 'auth.logout',
  
  // Workspace lifecycle events
  WORKSPACE_CREATED = 'workspace.created',
  WORKSPACE_PROVISION_STARTED = 'workspace.provision_started',
  WORKSPACE_CLONE_COMPLETE = 'workspace.clone_complete',
  WORKSPACE_GPU_ATTACHED = 'workspace.gpu_attached',
  WORKSPACE_BOOT_RUNNING = 'workspace.boot_running',
  WORKSPACE_IP_DISCOVERED = 'workspace.ip_discovered',
  WORKSPACE_TERMINATED = 'workspace.terminated',
  WORKSPACE_FAILED = 'workspace.failed',
  
  // Agent events
  AGENT_REGISTERED = 'agent.registered',
  AGENT_HEARTBEAT = 'agent.heartbeat',
  AGENT_HEARTBEAT_MISSED = 'agent.heartbeat_missed',
  
  // Gateway events
  GATEWAY_PORTS_ALLOCATED = 'gateway.ports_allocated',
  GATEWAY_PORTS_RELEASED = 'gateway.ports_released',
  
  // Connection events
  CONNECT_SSH_SUCCESS = 'connect.ssh_success',
  CONNECT_SSH_FAILED = 'connect.ssh_failed',
  CONNECT_JUPYTER_SUCCESS = 'connect.jupyter_success',
  CONNECT_JUPYTER_FAILED = 'connect.jupyter_failed',
  CONNECT_VSCODE_SUCCESS = 'connect.vscode_success',
  CONNECT_VSCODE_FAILED = 'connect.vscode_failed',
  
  // Billing events
  BILLING_METER_EMITTED = 'billing.meter_emitted',
  BILLING_METER_SUCCESS = 'billing.meter_success',
  BILLING_METER_FAILED = 'billing.meter_failed',
  BILLING_PAYMENT_FAILED = 'billing.payment_failed',
  BILLING_CUSTOMER_BLOCKED = 'billing.blocked',
}

export interface EmitEventOptions {
  userId?: string | null;
  workspaceId?: string | null;
  metadata?: Record<string, any>;
  requestId?: string;
  clientIp?: string;
  latencyMs?: number;
  errorCode?: string;
  protocol?: string;
  result?: 'success' | 'fail';
}

/**
 * Hash client IP for privacy
 */
function hashIp(ip: string): string {
  if (!ip) return '';
  return crypto.createHash('sha256').update(ip + process.env.JWT_ACCESS_SECRET).digest('hex').slice(0, 16);
}

/**
 * Emit an experience event
 * 
 * This is fire-and-forget - we don't want event emission to slow down
 * the actual user request.
 */
export async function emitExperienceEvent(
  type: ExperienceEventType,
  options: EmitEventOptions = {}
): Promise<void> {
  const {
    userId,
    workspaceId,
    metadata,
    requestId,
    clientIp,
    latencyMs,
    errorCode,
    protocol,
    result,
  } = options;

  // Fire and forget - don't await
  prisma.experienceEvent.create({
    data: {
      type,
      userId: userId || undefined,
      workspaceId: workspaceId || undefined,
      metadata: metadata ? JSON.stringify(metadata) : undefined,
      requestId,
      clientIp: clientIp ? hashIp(clientIp) : undefined,
      latencyMs,
      errorCode,
      protocol,
      result,
    },
  }).catch((err) => {
    // Log but don't throw - experience events shouldn't break the app
    console.error('Failed to emit experience event:', type, err.message);
  });
}

/**
 * Helper to emit auth events
 */
export function emitAuthEvent(
  success: boolean,
  userId: string | null,
  clientIp?: string,
  metadata?: Record<string, any>
): void {
  emitExperienceEvent(
    success ? ExperienceEventType.AUTH_LOGIN_SUCCESS : ExperienceEventType.AUTH_LOGIN_FAILED,
    {
      userId,
      clientIp,
      metadata,
      result: success ? 'success' : 'fail',
    }
  );
}

/**
 * Helper to emit workspace lifecycle events
 */
export function emitWorkspaceEvent(
  type: ExperienceEventType,
  workspaceId: string,
  userId?: string | null,
  metadata?: Record<string, any>
): void {
  emitExperienceEvent(type, {
    workspaceId,
    userId,
    metadata,
  });
}

/**
 * Helper to emit connection events
 */
export function emitConnectEvent(
  protocol: 'ssh' | 'jupyter' | 'vscode',
  success: boolean,
  workspaceId: string,
  userId?: string | null,
  options?: {
    clientIp?: string;
    latencyMs?: number;
    errorCode?: string;
  }
): void {
  const typeMap = {
    ssh: success ? ExperienceEventType.CONNECT_SSH_SUCCESS : ExperienceEventType.CONNECT_SSH_FAILED,
    jupyter: success ? ExperienceEventType.CONNECT_JUPYTER_SUCCESS : ExperienceEventType.CONNECT_JUPYTER_FAILED,
    vscode: success ? ExperienceEventType.CONNECT_VSCODE_SUCCESS : ExperienceEventType.CONNECT_VSCODE_FAILED,
  };

  emitExperienceEvent(typeMap[protocol], {
    workspaceId,
    userId,
    protocol,
    result: success ? 'success' : 'fail',
    clientIp: options?.clientIp,
    latencyMs: options?.latencyMs,
    errorCode: options?.errorCode,
  });
}

/**
 * Helper to emit billing events
 */
export function emitBillingEvent(
  type: ExperienceEventType,
  userId: string,
  metadata?: Record<string, any>
): void {
  emitExperienceEvent(type, {
    userId,
    metadata,
  });
}

export default {
  emit: emitExperienceEvent,
  emitAuth: emitAuthEvent,
  emitWorkspace: emitWorkspaceEvent,
  emitConnect: emitConnectEvent,
  emitBilling: emitBillingEvent,
  EventType: ExperienceEventType,
};
