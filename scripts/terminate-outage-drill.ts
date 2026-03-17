import { PrismaClient } from '@aldaro/db';
import { processWorkspaceCleanupJobs } from '../worker/src/jobs/workspace-cleanup';
import http from 'node:http';

const prisma = new PrismaClient();

function setLocalInfraEnv() {
  process.env.PROXMOX_API_URL = 'http://127.0.0.1:5998';
  process.env.PROXMOX_API_TOKEN_ID = 'dummy-id';
  process.env.PROXMOX_API_TOKEN_SECRET = 'dummy-secret';
}

async function main() {
  setLocalInfraEnv();

  const ws = await prisma.workspace.create({
    data: {
      status: 'TERMINATING',
      region: 'US',
      gpuType: 'RTX_5090',
      gpuCount: 1,
      imageType: 'BASE_ML_V1',
      terminationReason: 'terminate_outage_drill',
      cleanupNextRetryAt: new Date(),
    },
  });

  await prisma.workspaceCleanupJob.create({
    data: {
      workspaceId: ws.id,
      reasonCode: 'terminate_outage_drill',
      status: 'PENDING',
      nextAttemptAt: new Date(),
      maxAttempts: 20,
    },
  });

  const before = await prisma.workspaceCleanupJob.findUnique({
    where: { workspaceId: ws.id },
    select: {
      status: true,
      attemptCount: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      nextAttemptAt: true,
    },
  });

  // Phase 1: gateway unavailable
  process.env.GATEWAY_INTERNAL_URL = 'http://127.0.0.1:5999';
  await processWorkspaceCleanupJobs(prisma);

  const afterOutage = await prisma.workspaceCleanupJob.findUnique({
    where: { workspaceId: ws.id },
    select: {
      status: true,
      attemptCount: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      nextAttemptAt: true,
    },
  });
  const wsAfterOutage = await prisma.workspace.findUnique({
    where: { id: ws.id },
    select: {
      status: true,
      cleanupLastErrorCode: true,
      cleanupLastErrorMessage: true,
    },
  });

  // Phase 2: gateway restored
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/internal/gateway/release') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'OK' }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });

  await new Promise<void>((resolve) => server.listen(5999, '127.0.0.1', () => resolve()));
  await prisma.workspaceCleanupJob.update({
    where: { workspaceId: ws.id },
    data: { nextAttemptAt: new Date() },
  });
  await processWorkspaceCleanupJobs(prisma);
  await new Promise<void>((resolve) => server.close(() => resolve()));

  const afterRecovery = await prisma.workspaceCleanupJob.findUnique({
    where: { workspaceId: ws.id },
    select: {
      status: true,
      attemptCount: true,
      lastErrorCode: true,
      lastErrorMessage: true,
      nextAttemptAt: true,
      completedAt: true,
    },
  });
  const wsAfterRecovery = await prisma.workspace.findUnique({
    where: { id: ws.id },
    select: {
      status: true,
      terminatedAt: true,
      cleanupLastErrorCode: true,
      cleanupLastErrorMessage: true,
    },
  });

  console.log(
    JSON.stringify(
      {
        workspaceId: ws.id,
        before,
        afterOutage,
        wsAfterOutage,
        afterRecovery,
        wsAfterRecovery,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
