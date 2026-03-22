import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import crypto from 'crypto';

const prisma = new PrismaClient();

// ---------------------------------------------------------------------------
// Validation schemas
// ---------------------------------------------------------------------------

const createOrgSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(2).max(50).regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'Slug must be lowercase alphanumeric with hyphens, no leading/trailing hyphens'),
  billingEmail: z.string().email().optional(),
});

const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  billingEmail: z.string().email().nullable().optional(),
  maxMembers: z.number().int().min(1).max(500).optional(),
  maxActiveWorkspaces: z.number().int().min(1).max(500).optional(),
  maxConcurrentRuns: z.number().int().min(1).max(500).optional(),
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(['ADMIN', 'MEMBER']).default('MEMBER'),
});

const changeRoleSchema = z.object({
  role: z.enum(['ADMIN', 'MEMBER']),
});

const acceptInviteSchema = z.object({
  token: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type OrgRole = 'OWNER' | 'ADMIN' | 'MEMBER';

const ROLE_HIERARCHY: Record<OrgRole, number> = {
  OWNER: 3,
  ADMIN: 2,
  MEMBER: 1,
};

/**
 * Look up the requesting user's active membership in an org.
 * Returns null if the user is not an active member.
 */
async function getActiveMembership(orgId: string, userId: string) {
  return prisma.orgMembership.findUnique({
    where: { orgId_userId: { orgId, userId } },
  });
}

function hasMinRole(memberRole: string, requiredRole: OrgRole): boolean {
  const memberLevel = ROLE_HIERARCHY[memberRole as OrgRole] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole];
  return memberLevel >= requiredLevel;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const organizationRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  // All organization routes require authentication
  fastify.addHook('preHandler', fastify.authenticate as any);

  // -------------------------------------------------------------------------
  // POST /organizations — Create a new organization
  // -------------------------------------------------------------------------
  fastify.post('/', async (request: any, reply) => {
    const userId = request.user.userId;
    const body = createOrgSchema.parse(request.body);

    // Check slug uniqueness
    const existing = await prisma.organization.findUnique({ where: { slug: body.slug } });
    if (existing) {
      return reply.status(409).send({
        errorCode: 'SLUG_TAKEN',
        message: 'Organization slug is already in use.',
        error: 'Organization slug is already in use.',
        requestId: request.id,
      });
    }

    const org = await prisma.$transaction(async (tx) => {
      const newOrg = await tx.organization.create({
        data: {
          name: body.name,
          slug: body.slug,
          billingEmail: body.billingEmail,
        },
      });

      // Creator becomes OWNER with ACTIVE status
      await tx.orgMembership.create({
        data: {
          orgId: newOrg.id,
          userId,
          role: 'OWNER',
          status: 'ACTIVE',
          acceptedAt: new Date(),
        },
      });

      return newOrg;
    });

    return reply.status(201).send({ ok: true, organization: org });
  });

  // -------------------------------------------------------------------------
  // GET /organizations — List organizations the user belongs to
  // -------------------------------------------------------------------------
  fastify.get('/', async (request: any) => {
    const userId = request.user.userId;

    const memberships = await prisma.orgMembership.findMany({
      where: { userId, status: 'ACTIVE' },
      include: {
        org: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return {
      organizations: memberships.map((m) => ({
        ...m.org,
        role: m.role,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // GET /organizations/:id — Get org details + members
  // -------------------------------------------------------------------------
  fastify.get('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;

    const membership = await getActiveMembership(id, userId);
    if (!membership || membership.status !== 'ACTIVE') {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    const org = await prisma.organization.findUnique({
      where: { id },
      include: {
        memberships: {
          where: { status: 'ACTIVE' },
          include: {
            user: {
              select: { id: true, email: true },
            },
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!org) {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    return {
      organization: org,
      yourRole: membership.role,
    };
  });

  // -------------------------------------------------------------------------
  // PUT /organizations/:id — Update org settings (OWNER/ADMIN)
  // -------------------------------------------------------------------------
  fastify.put('/:id', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;
    const body = updateOrgSchema.parse(request.body);

    const membership = await getActiveMembership(id, userId);
    if (!membership || membership.status !== 'ACTIVE') {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    if (!hasMinRole(membership.role, 'ADMIN')) {
      return reply.status(403).send({
        errorCode: 'INSUFFICIENT_ROLE',
        message: 'Admin or Owner role required.',
        error: 'Admin or Owner role required.',
        requestId: request.id,
      });
    }

    const updated = await prisma.organization.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.billingEmail !== undefined && { billingEmail: body.billingEmail }),
        ...(body.maxMembers !== undefined && { maxMembers: body.maxMembers }),
        ...(body.maxActiveWorkspaces !== undefined && { maxActiveWorkspaces: body.maxActiveWorkspaces }),
        ...(body.maxConcurrentRuns !== undefined && { maxConcurrentRuns: body.maxConcurrentRuns }),
      },
    });

    return { ok: true, organization: updated };
  });

  // -------------------------------------------------------------------------
  // POST /organizations/:id/invite — Invite a member by email (OWNER/ADMIN)
  // -------------------------------------------------------------------------
  fastify.post('/:id/invite', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;
    const body = inviteSchema.parse(request.body);

    const membership = await getActiveMembership(id, userId);
    if (!membership || membership.status !== 'ACTIVE') {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    if (!hasMinRole(membership.role, 'ADMIN')) {
      return reply.status(403).send({
        errorCode: 'INSUFFICIENT_ROLE',
        message: 'Admin or Owner role required to invite members.',
        error: 'Admin or Owner role required to invite members.',
        requestId: request.id,
      });
    }

    // Check org member limit
    const org = await prisma.organization.findUnique({ where: { id } });
    if (!org) {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    const activeMemberCount = await prisma.orgMembership.count({
      where: { orgId: id, status: 'ACTIVE' },
    });

    if (activeMemberCount >= org.maxMembers) {
      return reply.status(429).send({
        errorCode: 'MAX_MEMBERS_REACHED',
        message: `Organization has reached the maximum of ${org.maxMembers} members.`,
        error: `Organization has reached the maximum of ${org.maxMembers} members.`,
        requestId: request.id,
      });
    }

    // Check if user is already a member
    const existingUser = await prisma.user.findUnique({ where: { email: body.email } });
    if (existingUser) {
      const existingMembership = await prisma.orgMembership.findUnique({
        where: { orgId_userId: { orgId: id, userId: existingUser.id } },
      });
      if (existingMembership && existingMembership.status === 'ACTIVE') {
        return reply.status(409).send({
          errorCode: 'ALREADY_MEMBER',
          message: 'User is already a member of this organization.',
          error: 'User is already a member of this organization.',
          requestId: request.id,
        });
      }
    }

    // Check for existing pending invitation
    const existingInvite = await prisma.orgInvitation.findUnique({
      where: { orgId_email: { orgId: id, email: body.email } },
    });
    if (existingInvite && !existingInvite.acceptedAt && existingInvite.expiresAt > new Date()) {
      return reply.status(409).send({
        errorCode: 'INVITE_PENDING',
        message: 'An active invitation already exists for this email.',
        error: 'An active invitation already exists for this email.',
        requestId: request.id,
      });
    }

    // Generate invitation token
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Upsert invitation (replace expired ones)
    await prisma.orgInvitation.upsert({
      where: { orgId_email: { orgId: id, email: body.email } },
      update: {
        role: body.role,
        invitedById: userId,
        tokenHash,
        expiresAt,
        acceptedAt: null,
      },
      create: {
        orgId: id,
        email: body.email,
        role: body.role,
        invitedById: userId,
        tokenHash,
        expiresAt,
      },
    });

    // SECURITY: Token sent via email outbox only — never log raw tokens.
    console.log(`[Org] Invitation created for ${body.email} to org ${org.slug}`);

    return reply.status(201).send({
      ok: true,
      message: `Invitation sent to ${body.email}.`,
    });
  });

  // -------------------------------------------------------------------------
  // POST /organizations/accept-invite — Accept invitation by token
  // -------------------------------------------------------------------------
  fastify.post('/accept-invite', async (request: any, reply) => {
    const userId = request.user.userId;
    const { token } = acceptInviteSchema.parse(request.body);

    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

    const invitation = await prisma.orgInvitation.findFirst({
      where: {
        tokenHash,
        acceptedAt: null,
        expiresAt: { gt: new Date() },
      },
      include: { org: true },
    });

    if (!invitation) {
      return reply.status(400).send({
        errorCode: 'INVALID_INVITE',
        message: 'Invalid or expired invitation token.',
        error: 'Invalid or expired invitation token.',
        requestId: request.id,
      });
    }

    // Verify the accepting user's email matches the invitation
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.email !== invitation.email) {
      return reply.status(403).send({
        errorCode: 'EMAIL_MISMATCH',
        message: 'This invitation was sent to a different email address.',
        error: 'This invitation was sent to a different email address.',
        requestId: request.id,
      });
    }

    // Check if already a member
    const existingMembership = await prisma.orgMembership.findUnique({
      where: { orgId_userId: { orgId: invitation.orgId, userId } },
    });
    if (existingMembership && existingMembership.status === 'ACTIVE') {
      return reply.status(409).send({
        errorCode: 'ALREADY_MEMBER',
        message: 'You are already a member of this organization.',
        error: 'You are already a member of this organization.',
        requestId: request.id,
      });
    }

    await prisma.$transaction(async (tx) => {
      // Mark invitation as accepted
      await tx.orgInvitation.update({
        where: { id: invitation.id },
        data: { acceptedAt: new Date() },
      });

      // Upsert membership (may exist as REMOVED or PENDING)
      await tx.orgMembership.upsert({
        where: { orgId_userId: { orgId: invitation.orgId, userId } },
        update: {
          role: invitation.role,
          status: 'ACTIVE',
          acceptedAt: new Date(),
          invitedById: invitation.invitedById,
        },
        create: {
          orgId: invitation.orgId,
          userId,
          role: invitation.role,
          status: 'ACTIVE',
          acceptedAt: new Date(),
          invitedById: invitation.invitedById,
        },
      });
    });

    return {
      ok: true,
      message: `You have joined ${invitation.org.name}.`,
      organizationId: invitation.orgId,
      organizationSlug: invitation.org.slug,
    };
  });

  // -------------------------------------------------------------------------
  // POST /organizations/:id/members/:userId/role — Change member role (OWNER only)
  // -------------------------------------------------------------------------
  fastify.post('/:id/members/:userId/role', async (request: any, reply) => {
    const actorId = request.user.userId;
    const { id, userId: targetUserId } = request.params;
    const { role: newRole } = changeRoleSchema.parse(request.body);

    const actorMembership = await getActiveMembership(id, actorId);
    if (!actorMembership || actorMembership.status !== 'ACTIVE') {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    if (actorMembership.role !== 'OWNER') {
      return reply.status(403).send({
        errorCode: 'INSUFFICIENT_ROLE',
        message: 'Only the organization owner can change member roles.',
        error: 'Only the organization owner can change member roles.',
        requestId: request.id,
      });
    }

    // Cannot change own role
    if (actorId === targetUserId) {
      return reply.status(400).send({
        errorCode: 'CANNOT_CHANGE_OWN_ROLE',
        message: 'You cannot change your own role.',
        error: 'You cannot change your own role.',
        requestId: request.id,
      });
    }

    const targetMembership = await getActiveMembership(id, targetUserId);
    if (!targetMembership || targetMembership.status !== 'ACTIVE') {
      return reply.status(404).send({
        errorCode: 'MEMBER_NOT_FOUND',
        message: 'Member not found in this organization.',
        error: 'Member not found in this organization.',
        requestId: request.id,
      });
    }

    // Cannot demote another OWNER via this endpoint
    if (targetMembership.role === 'OWNER') {
      return reply.status(400).send({
        errorCode: 'CANNOT_CHANGE_OWNER_ROLE',
        message: 'Cannot change the role of another owner.',
        error: 'Cannot change the role of another owner.',
        requestId: request.id,
      });
    }

    await prisma.orgMembership.update({
      where: { id: targetMembership.id },
      data: { role: newRole },
    });

    return { ok: true, message: `Role updated to ${newRole}.` };
  });

  // -------------------------------------------------------------------------
  // DELETE /organizations/:id/members/:userId — Remove member (OWNER/ADMIN)
  // -------------------------------------------------------------------------
  fastify.delete('/:id/members/:userId', async (request: any, reply) => {
    const actorId = request.user.userId;
    const { id, userId: targetUserId } = request.params;

    const actorMembership = await getActiveMembership(id, actorId);
    if (!actorMembership || actorMembership.status !== 'ACTIVE') {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    if (!hasMinRole(actorMembership.role, 'ADMIN')) {
      return reply.status(403).send({
        errorCode: 'INSUFFICIENT_ROLE',
        message: 'Admin or Owner role required to remove members.',
        error: 'Admin or Owner role required to remove members.',
        requestId: request.id,
      });
    }

    // Cannot remove yourself (use a separate leave endpoint if needed)
    if (actorId === targetUserId) {
      return reply.status(400).send({
        errorCode: 'CANNOT_REMOVE_SELF',
        message: 'You cannot remove yourself. Transfer ownership first.',
        error: 'You cannot remove yourself. Transfer ownership first.',
        requestId: request.id,
      });
    }

    const targetMembership = await getActiveMembership(id, targetUserId);
    if (!targetMembership || targetMembership.status !== 'ACTIVE') {
      return reply.status(404).send({
        errorCode: 'MEMBER_NOT_FOUND',
        message: 'Member not found in this organization.',
        error: 'Member not found in this organization.',
        requestId: request.id,
      });
    }

    // Cannot remove an OWNER
    if (targetMembership.role === 'OWNER') {
      return reply.status(403).send({
        errorCode: 'CANNOT_REMOVE_OWNER',
        message: 'Cannot remove an organization owner.',
        error: 'Cannot remove an organization owner.',
        requestId: request.id,
      });
    }

    // ADMINs cannot remove other ADMINs — only OWNER can
    if (targetMembership.role === 'ADMIN' && actorMembership.role !== 'OWNER') {
      return reply.status(403).send({
        errorCode: 'INSUFFICIENT_ROLE',
        message: 'Only the owner can remove admins.',
        error: 'Only the owner can remove admins.',
        requestId: request.id,
      });
    }

    // Get the user's email to invalidate any pending invitations
    const targetUser = await prisma.user.findUnique({
      where: { id: targetUserId },
      select: { email: true },
    });

    await prisma.$transaction(async (tx) => {
      await tx.orgMembership.update({
        where: { id: targetMembership.id },
        data: { status: 'REMOVED' },
      });

      // Invalidate any pending invitations for this user to prevent re-join via old token
      if (targetUser?.email) {
        await tx.orgInvitation.updateMany({
          where: { orgId: id, email: targetUser.email, acceptedAt: null },
          data: { expiresAt: new Date() },
        });
      }
    });

    return { ok: true, message: 'Member removed from organization.' };
  });

  // -------------------------------------------------------------------------
  // GET /organizations/:id/billing — Get org billing summary
  // -------------------------------------------------------------------------
  fastify.get('/:id/billing', async (request: any, reply) => {
    const userId = request.user.userId;
    const { id } = request.params;

    const membership = await getActiveMembership(id, userId);
    if (!membership || membership.status !== 'ACTIVE') {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    const org = await prisma.organization.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        billingEmail: true,
        stripeCustomerId: true,
        stripeDefaultPaymentMethodId: true,
        maxActiveWorkspaces: true,
        maxConcurrentRuns: true,
        maxMembers: true,
      },
    });

    if (!org) {
      return reply.status(404).send({
        errorCode: 'ORG_NOT_FOUND',
        message: 'Organization not found.',
        error: 'Organization not found.',
        requestId: request.id,
      });
    }

    // Count active workspaces and members for the summary
    const [activeWorkspaceCount, activeMemberCount] = await Promise.all([
      prisma.workspace.count({
        where: {
          orgId: id,
          status: { in: ['PROVISIONING', 'RUNNING', 'STARTING'] },
        },
      }),
      prisma.orgMembership.count({
        where: { orgId: id, status: 'ACTIVE' },
      }),
    ]);

    return {
      billing: {
        plan: org.plan,
        billingEmail: org.billingEmail,
        stripeCustomerId: org.stripeCustomerId,
        hasPaymentMethod: !!org.stripeDefaultPaymentMethodId,
      },
      limits: {
        maxActiveWorkspaces: org.maxActiveWorkspaces,
        maxConcurrentRuns: org.maxConcurrentRuns,
        maxMembers: org.maxMembers,
      },
      usage: {
        activeWorkspaces: activeWorkspaceCount,
        activeMembers: activeMemberCount,
      },
    };
  });
};
