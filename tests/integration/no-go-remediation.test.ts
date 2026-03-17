import { after, before, describe, it } from 'mocha';
import { expect } from 'chai';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

process.env.NODE_ENV = 'test';
process.env.ALDARO_AGENT_SHARED_SECRET = process.env.ALDARO_AGENT_SHARED_SECRET || 'test-agent-shared-secret';

const prisma = new PrismaClient();
const testPrefix = `no-go-remediation-${Date.now()}`;
let app: any;

function makeEmail(label: string) {
  return `${testPrefix}-${label}@aldaro.ai`;
}

function firstCookie(response: any) {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) {
    return raw[0].split(';')[0];
  }
  if (typeof raw === 'string') {
    return raw.split(';')[0];
  }
  throw new Error('No cookie returned');
}

function cookieByName(response: any, cookieName: string): string | null {
  const raw = response.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  for (const cookie of cookies) {
    if (cookie.startsWith(`${cookieName}=`)) {
      return cookie.split(';')[0];
    }
  }
  return null;
}

function mergeCookies(...cookies: Array<string | null | undefined>) {
  return cookies.filter(Boolean).join('; ');
}

async function createUser(label: string, overrides: Record<string, unknown> = {}) {
  const password = (overrides.password as string) || 'ValidPassword123!@#';
  const passwordHash = await bcrypt.hash(password, 10);
  return prisma.user.create({
    data: {
      email: makeEmail(label),
      passwordHash,
      role: 'CUSTOMER',
      accountStatus: 'ACTIVE',
      customerAccessStatus: 'APPROVED',
      isAlphaTester: true,
      maxActiveWorkspaces: 5,
      ...overrides,
      passwordHash,
    } as any,
  });
}

async function login(email: string, password = 'ValidPassword123!@#') {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password },
  });
  expect(res.statusCode).to.equal(200);
  return firstCookie(res);
}

async function csrfSession(cookie: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/csrf',
    headers: { cookie },
  });
  expect(res.statusCode).to.equal(200);
  const token = res.json().token as string;
  const raw = res.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const csrfCookie = cookieByName(res, '_csrf');
  const injectedCookies = cookies.map((c) => c.split(';')[0]);
  return {
    token,
    cookie: mergeCookies(cookie, csrfCookie, ...injectedCookies),
  };
}

async function resolveLaunchResponse(
  cookie: string,
  csrfToken: string,
  payload: Record<string, unknown>,
  initial: any,
) {
  let response = initial;
  for (let i = 0; i < 30; i += 1) {
    if (response.statusCode === 200) return response;
    if (response.statusCode !== 202) return response;
    await new Promise((resolve) => setTimeout(resolve, 150));
    response = await app.inject({
      method: 'POST',
      url: '/workspaces/launch',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
      },
      payload,
    });
  }
  return response;
}

describe('NO-GO Remediation', function () {
  this.timeout(60000);

  before(async function () {
    ({ app } = await import('../../apps/api/src/index'));
    await app.ready();
  });

  after(async function () {
    const users = await prisma.user.findMany({
      where: { email: { startsWith: testPrefix } },
      select: { id: true },
    });
    const userIds = users.map((u) => u.id);

    const workspaces = await prisma.workspace.findMany({
      where: { assignedUserId: { in: userIds } },
      select: { id: true },
    });
    const workspaceIds = workspaces.map((w) => w.id);

    await prisma.workspaceMeterEventOutbox.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.workspaceLaunchOperation.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await prisma.workspaceCleanupJob.deleteMany({ where: { workspaceId: { in: workspaceIds } } }).catch(() => {});
    await prisma.workspaceEndpoint.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspaceGpuAllocation.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.usageSession.deleteMany({ where: { workspaceId: { in: workspaceIds } } });
    await prisma.workspace.deleteMany({ where: { id: { in: workspaceIds } } });
    await prisma.authorAudit.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.customerApplication.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.emailOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.securityLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    await prisma.$disconnect();
  });

  it('launch idempotency creates one workspace under parallel duplicate requests', async function () {
    const user = await createUser('launch-idempotency');
    const sessionCookie = await login(user.email);
    const csrf = await csrfSession(sessionCookie);
    const idempotencyKey = `launch-${Date.now()}`;

    const payload = {
      gpu_key: 'RTX_5090',
      region: 'US',
      idempotency_key: idempotencyKey,
    };

    const [first, second] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/workspaces/launch',
        headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token },
        payload,
      }),
      app.inject({
        method: 'POST',
        url: '/workspaces/launch',
        headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token },
        payload,
      }),
    ]);

    const firstResolved = await resolveLaunchResponse(csrf.cookie, csrf.token, payload, first);
    const secondResolved = await resolveLaunchResponse(csrf.cookie, csrf.token, payload, second);

    expect(firstResolved.statusCode).to.equal(200);
    expect(secondResolved.statusCode).to.equal(200);

    const firstWorkspaceId = firstResolved.json().workspace_id as string;
    const secondWorkspaceId = secondResolved.json().workspace_id as string;
    expect(firstWorkspaceId).to.equal(secondWorkspaceId);

    const operation = await prisma.workspaceLaunchOperation.findUniqueOrThrow({
      where: {
        userId_operationKey: {
          userId: user.id,
          operationKey: idempotencyKey,
        },
      },
    });
    expect(operation.workspaceId).to.equal(firstWorkspaceId);

    const workspaceCount = await prisma.workspace.count({
      where: {
        assignedUserId: user.id,
        launchOperationKey: idempotencyKey,
      },
    });
    expect(workspaceCount).to.equal(1);
  });

  it('terminate endpoint is async-safe and queues cleanup job', async function () {
    const user = await createUser('terminate-async');
    const workspace = await prisma.workspace.create({
      data: {
        assignedUserId: user.id,
        gpuType: 'RTX_5090',
        region: 'US',
        status: 'RUNNING_ASSIGNED',
        assignedAt: new Date(),
      },
    });

    const sessionCookie = await login(user.email);
    const csrf = await csrfSession(sessionCookie);

    const res = await app.inject({
      method: 'POST',
      url: `/workspaces/${workspace.id}/terminate`,
      headers: { cookie: csrf.cookie, 'x-csrf-token': csrf.token },
    });

    expect(res.statusCode).to.equal(202);
    const body = res.json();
    expect(body.status).to.equal('TERMINATING');
    expect(JSON.stringify(body)).to.not.match(/stack|ECONNREFUSED|axios|proxmox/i);

    const updatedWorkspace = await prisma.workspace.findUniqueOrThrow({ where: { id: workspace.id } });
    expect(updatedWorkspace.status).to.equal('TERMINATING');

    const cleanupJob = await prisma.workspaceCleanupJob.findUniqueOrThrow({
      where: { workspaceId: workspace.id },
    });
    expect(cleanupJob.status).to.equal('PENDING');
  });

  it('enforces CSRF on author reject and queues rejection email once token is valid', async function () {
    const author = await createUser('author-csrf', {
      role: 'AUTHOR',
      customerAccessStatus: 'PENDING_REVIEW',
      isAlphaTester: false,
    });
    const applicant = await createUser('applicant-csrf', {
      customerAccessStatus: 'PENDING_REVIEW',
      isAlphaTester: false,
    });

    const appRecord = await prisma.customerApplication.create({
      data: {
        userId: applicant.id,
        fullName: 'Applicant CSRF',
        email: applicant.email,
      },
    });

    const authorCookie = await login(author.email);

    const noTokenRes = await app.inject({
      method: 'POST',
      url: `/api/author/customers/applications/${appRecord.id}/reject`,
      headers: { cookie: authorCookie },
      payload: { decisionReason: 'Insufficient details' },
    });
    expect(noTokenRes.statusCode).to.equal(403);
    expect(noTokenRes.json().errorCode).to.equal('CSRF_TOKEN_INVALID');

    const badTokenRes = await app.inject({
      method: 'POST',
      url: `/api/author/customers/applications/${appRecord.id}/reject`,
      headers: {
        cookie: authorCookie,
        'x-csrf-token': 'invalid-token',
      },
      payload: { decisionReason: 'Insufficient details' },
    });
    expect(badTokenRes.statusCode).to.equal(403);
    expect(badTokenRes.json().errorCode).to.equal('CSRF_TOKEN_INVALID');

    const csrf = await csrfSession(authorCookie);
    const validRes = await app.inject({
      method: 'POST',
      url: `/api/author/customers/applications/${appRecord.id}/reject`,
      headers: {
        cookie: csrf.cookie,
        'x-csrf-token': csrf.token,
      },
      payload: { decisionReason: 'Insufficient details' },
    });
    expect(validRes.statusCode).to.equal(200);
    expect(validRes.json().customerAccessStatus).to.equal('REJECTED');

    const rejectionEmail = await prisma.emailOutbox.findUnique({
      where: { dedupeKey: `APPLICATION_REJECTED:${appRecord.id}` },
    });
    expect(rejectionEmail).to.not.equal(null);
    expect(rejectionEmail?.type).to.equal('APPLICATION_REJECTED');
  });
});
