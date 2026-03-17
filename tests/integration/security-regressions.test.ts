import { after, before, describe, it } from 'mocha';
import { expect } from 'chai';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import crypto from 'crypto';

process.env.NODE_ENV = 'test';
process.env.ALDARO_AGENT_SHARED_SECRET = process.env.ALDARO_AGENT_SHARED_SECRET || 'test-agent-shared-secret';

const prisma = new PrismaClient();
const testPrefix = `security-regression-${Date.now()}`;

let app: any;

function makeEmail(label: string) {
  return `${testPrefix}-${label}@aldaro.ai`;
}

function extractCookie(response: any) {
  const raw = response.headers['set-cookie'];
  if (Array.isArray(raw)) {
    return raw[0].split(';')[0];
  }
  if (typeof raw === 'string') {
    return raw.split(';')[0];
  }
  throw new Error('No session cookie returned');
}

async function fetchCsrfContext(cookie: string) {
  const csrfRes = await app.inject({
    method: 'GET',
    url: '/auth/csrf',
    headers: { cookie },
  });
  const raw = csrfRes.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const csrfCookie = cookies.find((entry) => entry.startsWith('_csrf='))?.split(';')[0];
  const mergedSetCookies = cookies.map((entry) => entry.split(';')[0]);
  return {
    token: csrfRes.json().token as string,
    cookie: [cookie, csrfCookie, ...mergedSetCookies].filter(Boolean).join('; '),
  };
}

async function createUser(label: string, overrides: Record<string, unknown> = {}) {
  const password = overrides.password as string | undefined;
  const passwordHash = await bcrypt.hash(password || 'ValidPassword123!@#', 10);
  return prisma.user.create({
    data: {
      email: makeEmail(label),
      passwordHash,
      role: 'CUSTOMER',
      accountStatus: 'ACTIVE',
      customerAccessStatus: 'APPROVED',
      isAlphaTester: true,
      ...overrides,
      passwordHash,
    } as any,
  });
}

describe('Security Regressions', function () {
  this.timeout(30000);

  before(async function () {
    ({ app } = await import('../../apps/api/src/index'));
    await app.ready();
  });

  after(async function () {
    const users = await prisma.user.findMany({
      where: { email: { startsWith: testPrefix } },
      select: { id: true },
    });
    const userIds = users.map((user) => user.id);

    const projects = await prisma.project.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });
    const projectIds = projects.map((project) => project.id);

    const runs = await prisma.run.findMany({
      where: { userId: { in: userIds } },
      select: { id: true },
    });
    const runIds = runs.map((run) => run.id);

    const posts = await prisma.authorPost.findMany({
      where: { slug: { startsWith: testPrefix } },
      select: { id: true },
    });
    const postIds = posts.map((post) => post.id);

    await prisma.runEvent.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.runLog.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.artifact.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.agentSession.deleteMany({ where: { runId: { in: runIds } } });
    await prisma.run.deleteMany({ where: { id: { in: runIds } } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.authorPostRevision.deleteMany({ where: { postId: { in: postIds } } });
    await prisma.authorPost.deleteMany({ where: { id: { in: postIds } } });
    await prisma.authorAudit.deleteMany({ where: { actorUserId: { in: userIds } } });
    await prisma.customerApplication.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.emailOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.securityLog.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.usageSession.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });

    await app.close();
    await prisma.$disconnect();
  });

  it('requires authenticated agent bootstrap and event tokens', async function () {
    const user = await createUser('agent-user');
    const project = await prisma.project.create({
      data: {
        userId: user.id,
        name: `${testPrefix}-agent-project`,
        repoUrl: 'https://example.com/agent.git',
        defaultBranch: 'main',
        visibility: 'private',
      },
    });
    const run = await prisma.run.create({
      data: {
        userId: user.id,
        projectId: project.id,
        status: 'queued',
        gpuType: 'RTX_5090',
        gpuCount: 1,
        hoursMax: 1,
        command: 'python train.py',
      },
    });

    const refreshNoAuth = await app.inject({
      method: 'POST',
      url: '/v1/agent/token/refresh',
    });
    expect(refreshNoAuth.statusCode).to.equal(401);

    const handshakeNoAuth = await app.inject({
      method: 'POST',
      url: '/v1/agent/handshake',
      payload: { run_id: run.id, agent_version: 'test-agent' },
    });
    expect(handshakeNoAuth.statusCode).to.equal(401);

    const handshake = await app.inject({
      method: 'POST',
      url: '/v1/agent/handshake',
      headers: { authorization: `Bearer ${process.env.ALDARO_AGENT_SHARED_SECRET}` },
      payload: {
        run_id: run.id,
        agent_version: 'test-agent',
        capabilities: { repo_clone: true },
      },
    });
    expect(handshake.statusCode).to.equal(200);
    const handshakeBody = handshake.json();
    expect(handshakeBody.token).to.be.a('string').and.not.empty;

    const eventNoAuth = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/events`,
      payload: { type: 'STATUS', payload: { state: 'running' } },
    });
    expect(eventNoAuth.statusCode).to.equal(401);

    const eventRes = await app.inject({
      method: 'POST',
      url: `/v1/runs/${run.id}/events`,
      headers: { authorization: `Bearer ${handshakeBody.token}` },
      payload: { type: 'STATUS', payload: { state: 'running' } },
    });
    expect(eventRes.statusCode).to.equal(200);

    const updatedRun = await prisma.run.findUniqueOrThrow({ where: { id: run.id } });
    expect(updatedRun.status).to.equal('running');
  });

  it('supports CLI bearer auth on protected v1 routes', async function () {
    const user = await createUser('cli-user');

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { 'x-aldaro-client': 'cli' },
      payload: {
        email: user.email,
        password: 'ValidPassword123!@#',
      },
    });
    expect(loginRes.statusCode).to.equal(200);
    const token = loginRes.json().token;
    expect(token).to.be.a('string').and.not.empty;

    const projectsRes = await app.inject({
      method: 'GET',
      url: '/v1/projects',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(projectsRes.statusCode).to.equal(200);
    expect(projectsRes.json().items).to.be.an('array');
  });

  it('rejects pre-reset session cookies after password reset', async function () {
    const user = await createUser('pwreset-user');

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: user.email,
        password: 'ValidPassword123!@#',
      },
    });
    expect(loginRes.statusCode).to.equal(200);
    const sessionCookie = extractCookie(loginRes);

    const rawResetToken = `${testPrefix}-reset-token`;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordResetTokenHash: crypto.createHash('sha256').update(rawResetToken).digest('hex'),
        passwordResetExpiresAt: new Date(Date.now() + 60_000),
      },
    });

    const resetRes = await app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: {
        token: rawResetToken,
        newPassword: 'UpdatedPassword123!@#',
      },
    });
    expect(resetRes.statusCode).to.equal(200);

    const oldSessionRes = await app.inject({
      method: 'GET',
      url: '/auth/session',
      headers: { cookie: sessionCookie },
    });
    expect(oldSessionRes.statusCode).to.equal(401);
  });

  it('blocks reauth-protected mutations before they change state', async function () {
    const author = await createUser('author-user', {
      role: 'AUTHOR',
      isAlphaTester: false,
      customerAccessStatus: 'PENDING_REVIEW',
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: author.email,
        password: 'ValidPassword123!@#',
      },
    });
    expect(loginRes.statusCode).to.equal(200);
    const authorCookie = extractCookie(loginRes);

    const post = await prisma.authorPost.create({
      data: {
        title: 'Draft Post',
        slug: `${testPrefix}-draft-post`,
        bodyMarkdown: 'This is a valid draft post body with enough content.',
        visibility: 'IN_APP_ANNOUNCEMENT',
        status: 'DRAFT',
        tags: '[]',
        createdByUserId: author.id,
        updatedByUserId: author.id,
      },
    });
    const authorCsrf = await fetchCsrfContext(authorCookie);

    const publishRes = await app.inject({
      method: 'POST',
      url: `/api/author/posts/${post.id}/publish`,
      headers: {
        cookie: authorCsrf.cookie,
        'x-csrf-token': authorCsrf.token,
      },
    });
    expect(publishRes.statusCode).to.equal(403);

    const unchangedPost = await prisma.authorPost.findUniqueOrThrow({ where: { id: post.id } });
    expect(unchangedPost.status).to.equal('DRAFT');

    const billingUser = await createUser('billing-user');
    const billingLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: billingUser.email,
        password: 'ValidPassword123!@#',
      },
    });
    const billingCookie = extractCookie(billingLogin);
    const billingCsrf = await fetchCsrfContext(billingCookie);

    const setupIntentRes = await app.inject({
      method: 'POST',
      url: '/billing/setup-intent',
      headers: {
        cookie: billingCsrf.cookie,
        'x-csrf-token': billingCsrf.token,
      },
    });
    expect(setupIntentRes.statusCode).to.equal(403);

    const unchangedBillingUser = await prisma.user.findUniqueOrThrow({ where: { id: billingUser.id } });
    expect(unchangedBillingUser.stripeCustomerId).to.equal(null);
  });

  it('returns approved status for legacy alpha-approved accounts on join-alpha', async function () {
    const user = await createUser('legacy-approved', {
      customerAccessStatus: 'PENDING_REVIEW',
      isAlphaTester: true,
    });

    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/public/join-alpha',
      payload: {
        fullName: 'Legacy Approved',
        email: user.email,
        password: 'ValidPassword123!@#',
      },
    });
    expect(joinRes.statusCode).to.equal(200);
    expect(joinRes.json().customerAccessStatus).to.equal('APPROVED');
  });

  it('internal alpha allow updates the canonical customer approval state', async function () {
    const author = await createUser('author-approver', {
      role: 'AUTHOR',
      isAlphaTester: false,
      customerAccessStatus: 'PENDING_REVIEW',
    });
    const customer = await createUser('pending-customer', {
      customerAccessStatus: 'PENDING_REVIEW',
      isAlphaTester: false,
    });
    const application = await prisma.customerApplication.create({
      data: {
        userId: customer.id,
        fullName: 'Pending Customer',
        email: customer.email,
      },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: {
        email: author.email,
        password: 'ValidPassword123!@#',
      },
    });
    const authorCookie = extractCookie(loginRes);
    const authorCsrf = await fetchCsrfContext(authorCookie);

    const allowRes = await app.inject({
      method: 'POST',
      url: '/api/admin/alpha/allow',
      headers: {
        cookie: authorCsrf.cookie,
        'x-csrf-token': authorCsrf.token,
      },
      payload: { email: customer.email },
    });
    expect(allowRes.statusCode).to.equal(200);

    const updatedCustomer = await prisma.user.findUniqueOrThrow({ where: { id: customer.id } });
    const reviewedApplication = await prisma.customerApplication.findUniqueOrThrow({ where: { id: application.id } });

    expect(updatedCustomer.customerAccessStatus).to.equal('APPROVED');
    expect(updatedCustomer.isAlphaTester).to.equal(true);
    expect(reviewedApplication.decision).to.equal('APPROVED');
  });
});
