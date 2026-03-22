import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import crypto from 'crypto';

const prisma = new PrismaClient();

const REGISTRY_TYPES = ['DOCKER_HUB', 'AWS_ECR', 'GCP_GCR', 'GITHUB_GHCR', 'CUSTOM'] as const;

// SECURITY: Block SSRF in registry URL verification
function isAllowedRegistryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    // Block loopback, link-local, metadata, and private IPs
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return false;
    if (host.startsWith('169.254.')) return false;
    if (host.startsWith('10.') || host.startsWith('192.168.')) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    if (host.endsWith('.local') || host.endsWith('.internal')) return false;
    // Must be HTTPS (except for docker.io compatibility)
    if (parsed.protocol !== 'https:' && !host.includes('docker.io')) return false;
    return true;
  } catch {
    return false;
  }
}

const createCredentialSchema = z.object({
  name: z.string().min(1).max(128).default('Default Registry'),
  registryUrl: z.string().url().max(512),
  registryType: z.enum(REGISTRY_TYPES).default('DOCKER_HUB'),
  username: z.string().max(256).optional(),
  token: z.string().min(1).max(4096),
});

// ---------------------------------------------------------------------------
// AES-256-GCM encryption helpers
// ---------------------------------------------------------------------------
function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY must be at least 32 characters');
  }
  // Derive a consistent 32-byte key via SHA-256
  return crypto.createHash('sha256').update(key).digest();
}

function encryptToken(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Format: base64(iv):base64(authTag):base64(ciphertext)
  return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted.toString('base64')}`;
}

function decryptToken(encryptedStr: string): string {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = encryptedStr.split(':');
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error('Invalid encrypted token format');
  }
  const iv = Buffer.from(ivB64, 'base64');
  const authTag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return decrypted.toString('utf8');
}

// Export for use by worker
export { decryptToken };

export const registryCredentialRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireCustomerApproved as any);

  // POST /registry-credentials — Save registry credentials
  fastify.post('/', async (request: any, reply) => {
    const userId = request.user.userId;
    const { name, registryUrl, registryType, username, token } = createCredentialSchema.parse(request.body);

    // SECURITY: Block internal/private registry URLs
    if (!isAllowedRegistryUrl(registryUrl)) {
      return reply.status(400).send({
        errorCode: 'INVALID_REGISTRY_URL',
        message: 'Registry URL must not target internal or private addresses.',
        error: 'Registry URL must not target internal or private addresses.',
        requestId: request.id,
      });
    }

    // Limit credentials per user (max 20)
    const existing = await prisma.imageRegistryCredential.count({
      where: { userId },
    });
    if (existing >= 20) {
      return reply.status(429).send({
        errorCode: 'MAX_CREDENTIALS_REACHED',
        message: 'Maximum of 20 registry credentials per account.',
        error: 'Maximum of 20 registry credentials per account.',
        requestId: request.id,
      });
    }

    const encryptedToken = encryptToken(token);

    const credential = await prisma.imageRegistryCredential.create({
      data: {
        userId,
        name,
        registryUrl,
        registryType,
        username: username || null,
        encryptedToken,
      },
    });

    return reply.status(201).send({
      id: credential.id,
      name: credential.name,
      registryUrl: credential.registryUrl,
      registryType: credential.registryType,
      username: credential.username,
      verified: credential.verified,
      lastVerifiedAt: credential.lastVerifiedAt,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    });
  });

  // GET /registry-credentials — List user's credentials (never return decrypted token)
  fastify.get('/', async (request: any) => {
    const userId = request.user.userId;

    const credentials = await prisma.imageRegistryCredential.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        registryUrl: true,
        registryType: true,
        username: true,
        verified: true,
        lastVerifiedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return credentials;
  });

  // DELETE /registry-credentials/:id — Delete credential
  fastify.delete('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };

    const credential = await prisma.imageRegistryCredential.findFirst({
      where: { id, userId },
    });

    if (!credential) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Registry credential not found.',
        error: 'Registry credential not found.',
        requestId: request.id,
      });
    }

    // Check if any active workspaces reference this credential
    const activeWorkspaces = await prisma.workspace.count({
      where: {
        registryCredentialId: id,
        status: { in: ['RUNNING_ASSIGNED', 'ASSIGNING', 'CREATING', 'WAITING_FOR_AGENT', 'VERIFYING'] },
      },
    });

    if (activeWorkspaces > 0) {
      return reply.status(409).send({
        errorCode: 'CREDENTIAL_IN_USE',
        message: 'Cannot delete credential while active workspaces reference it.',
        error: 'Cannot delete credential while active workspaces reference it.',
        requestId: request.id,
      });
    }

    await prisma.imageRegistryCredential.delete({
      where: { id },
    });

    return { ok: true };
  });

  // POST /registry-credentials/:id/verify — Test the credential
  fastify.post('/:id/verify', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params as { id: string };

    const credential = await prisma.imageRegistryCredential.findFirst({
      where: { id, userId },
    });

    if (!credential) {
      return reply.status(404).send({
        errorCode: 'NOT_FOUND',
        message: 'Registry credential not found.',
        error: 'Registry credential not found.',
        requestId: request.id,
      });
    }

    let verified = false;
    let errorMessage: string | null = null;

    try {
      const token = decryptToken(credential.encryptedToken);
      const registryUrl = credential.registryUrl.replace(/\/+$/, '');

      // SECURITY: SSRF check — block requests to internal/private addresses
      if (!isAllowedRegistryUrl(registryUrl)) {
        return {
          id: credential.id,
          verified: false,
          lastVerifiedAt: new Date(),
          error: 'Registry URL targets a blocked address.',
        };
      }

      // Attempt a HEAD/GET request to the registry API to validate credentials
      // Different registries use different auth mechanisms
      const authHeader = credential.username
        ? `Basic ${Buffer.from(`${credential.username}:${token}`).toString('base64')}`
        : `Bearer ${token}`;

      // Try the v2 registry API check endpoint
      const checkUrl = registryUrl.includes('docker.io')
        ? 'https://registry-1.docker.io/v2/'
        : `${registryUrl}/v2/`;

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);

      try {
        const res = await fetch(checkUrl, {
          method: 'GET',
          headers: { Authorization: authHeader },
          signal: controller.signal,
        });
        clearTimeout(timeout);

        verified = res.status === 200 || res.status === 401 === false;
        // 200 = valid, 401 = bad creds, anything else is ambiguous
        if (res.status === 200) {
          verified = true;
        } else if (res.status === 401) {
          verified = false;
          errorMessage = 'Authentication failed: invalid credentials.';
        } else {
          // Some registries return 404 on /v2/ but creds might still be valid
          // Mark as verified if we at least got a response
          verified = res.status < 500;
        }
      } catch (fetchErr: any) {
        clearTimeout(timeout);
        if (fetchErr.name === 'AbortError') {
          errorMessage = 'Registry connection timed out.';
        } else {
          errorMessage = `Registry connection failed: ${fetchErr.message}`;
        }
      }
    } catch (err: any) {
      errorMessage = 'Failed to decrypt credential token.';
    }

    await prisma.imageRegistryCredential.update({
      where: { id },
      data: {
        verified,
        lastVerifiedAt: new Date(),
      },
    });

    return {
      id: credential.id,
      verified,
      lastVerifiedAt: new Date(),
      error: errorMessage,
    };
  });
};
