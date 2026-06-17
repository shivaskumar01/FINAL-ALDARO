import { PrismaClient } from '@prisma/client';

/**
 * Budget Monitor Job
 *
 * Runs every 15 minutes under leader lock. For each user (and org) with a
 * monthlySoftLimitCents set, calculates real-time month-to-date spend from
 * UsageSessions and triggers alerts or auto-termination.
 *
 * Thresholds:
 *  - 90%: warning alert (webhook + email outbox)
 *  - 100%: if hardLimitAction === 'AUTO_TERMINATE', kill all active workspaces
 *
 * Dedup: will not re-alert a user within 4 hours for the same threshold.
 */

const ALERT_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

export async function budgetMonitorTick(prisma: PrismaClient) {
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // Find users with budget limits
  const usersWithLimits = await prisma.user.findMany({
    where: { monthlySoftLimitCents: { not: null } },
    select: {
      id: true,
      email: true,
      monthlySoftLimitCents: true,
      hardLimitAction: true,
      lastBudgetAlertAt: true,
    },
  });

  for (const user of usersWithLimits) {
    if (!user.monthlySoftLimitCents || user.monthlySoftLimitCents <= 0) continue;

    try {
      await checkUserBudget(prisma, user, monthStart, now);
    } catch (err) {
      console.error(`[BudgetMonitor] Error checking budget for user ${user.id}:`, err);
    }
  }

  // -------------------------------------------------------------------------
  // Organization budgets, same logic but scoped to org-owned workspaces
  // -------------------------------------------------------------------------
  const orgsWithLimits = await prisma.organization.findMany({
    where: { monthlySoftLimitCents: { not: null } },
    select: {
      id: true,
      name: true,
      slug: true,
      billingEmail: true,
      monthlySoftLimitCents: true,
      hardLimitAction: true,
      lastBudgetAlertAt: true,
    },
  });

  for (const org of orgsWithLimits) {
    if (!org.monthlySoftLimitCents || org.monthlySoftLimitCents <= 0) continue;

    try {
      await checkOrgBudget(prisma, org, monthStart, now);
    } catch (err) {
      console.error(`[BudgetMonitor] Error checking budget for org ${org.slug}:`, err);
    }
  }
}

async function checkUserBudget(
  prisma: PrismaClient,
  user: {
    id: string;
    email: string;
    monthlySoftLimitCents: number | null;
    hardLimitAction: string;
    lastBudgetAlertAt: Date | null;
  },
  monthStart: Date,
  now: Date,
) {
  const limitCents = user.monthlySoftLimitCents!;

  // Calculate MTD spend
  const sessions = await prisma.usageSession.findMany({
    where: {
      userId: user.id,
      startTime: { gte: monthStart },
    },
    select: {
      billedCents: true,
      status: true,
      startTime: true,
      pricePerHourCents: true,
    },
  });

  let mtdSpendCents = 0;
  for (const s of sessions) {
    if (s.status === 'ENDED') {
      mtdSpendCents += s.billedCents;
    } else if (s.status === 'RUNNING') {
      const elapsed = Math.max(0, (now.getTime() - s.startTime.getTime()) / 1000);
      mtdSpendCents += Math.ceil((elapsed * s.pricePerHourCents) / 3600);
    }
  }

  const pct = Math.round((mtdSpendCents / limitCents) * 100);

  // Check cooldown
  const recentlyCooled = user.lastBudgetAlertAt &&
    (now.getTime() - user.lastBudgetAlertAt.getTime()) < ALERT_COOLDOWN_MS;

  // 100% threshold, auto-terminate if configured
  if (pct >= 100 && user.hardLimitAction === 'AUTO_TERMINATE') {
    const activeWorkspaces = await prisma.workspace.findMany({
      where: {
        assignedUserId: user.id,
        status: { in: ['RUNNING_ASSIGNED', 'CREATING', 'WAITING_FOR_AGENT', 'ASSIGNING'] },
      },
      select: { id: true },
    });

    if (activeWorkspaces.length > 0) {
      // Set all to TERMINATING + enqueue cleanup
      for (const ws of activeWorkspaces) {
        await prisma.workspace.update({
          where: { id: ws.id },
          data: {
            status: 'TERMINATING',
            terminationReason: 'budget_limit',
            cleanupNextRetryAt: now,
          },
        });

        await prisma.workspaceCleanupJob.upsert({
          where: { workspaceId: ws.id },
          update: {
            reasonCode: 'budget_limit',
            status: 'PENDING',
            nextAttemptAt: now,
          },
          create: {
            workspaceId: ws.id,
            reasonCode: 'budget_limit',
            status: 'PENDING',
            nextAttemptAt: now,
          },
        });
      }

      console.log(`[BudgetMonitor] AUTO_TERMINATE: killed ${activeWorkspaces.length} workspace(s) for user ${user.email} (${pct}% of $${(limitCents / 100).toFixed(2)} limit)`);

      await prisma.budgetAlert.create({
        data: {
          userId: user.id,
          mtdSpendCents,
          limitCents,
          thresholdPct: 100,
          action: 'AUTO_TERMINATE',
          workspacesTerminated: activeWorkspaces.length,
        },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { lastBudgetAlertAt: now },
      });
    }
    return;
  }

  // 90% threshold, warning alert
  if (pct >= 90 && !recentlyCooled) {
    console.log(`[BudgetMonitor] WARNING: user ${user.email} at ${pct}% of $${(limitCents / 100).toFixed(2)} monthly limit (MTD: $${(mtdSpendCents / 100).toFixed(2)})`);

    await prisma.budgetAlert.create({
      data: {
        userId: user.id,
        mtdSpendCents,
        limitCents,
        thresholdPct: pct >= 100 ? 100 : 90,
        action: 'ALERT',
      },
    });

    // Enqueue webhook notification
    const webhooks = await prisma.webhookEndpoint.findMany({
      where: {
        userId: user.id,
        enabled: true,
        events: { contains: 'budget.warning' },
      },
    });

    for (const wh of webhooks) {
      await prisma.webhookDelivery.create({
        data: {
          endpointId: wh.id,
          event: 'budget.warning',
          payload: JSON.stringify({
            userId: user.id,
            mtdSpendCents,
            limitCents,
            pct,
            hardLimitAction: user.hardLimitAction,
          }),
          status: 'PENDING',
        },
      });
    }

    // Enqueue email alert
    const dedupeKey = `BUDGET_WARNING:${user.id}:${now.toISOString().slice(0, 7)}:${pct >= 100 ? 100 : 90}`;
    const existingEmail = await prisma.emailOutbox.findUnique({
      where: { dedupeKey },
      select: { id: true },
    });

    if (!existingEmail) {
      await prisma.emailOutbox.create({
        data: {
          type: 'BUDGET_WARNING',
          toEmail: user.email,
          userId: user.id,
          subject: `Aldaro.AI: You've reached ${pct}% of your monthly budget`,
          bodyText: `Your month-to-date GPU spend is $${(mtdSpendCents / 100).toFixed(2)}, which is ${pct}% of your $${(limitCents / 100).toFixed(2)} monthly limit.\n\n${user.hardLimitAction === 'AUTO_TERMINATE' ? 'Your workspaces will be automatically terminated if you exceed your limit.' : 'Consider reviewing your active workspaces.'}\n\nManage your budget: ${process.env.PORTAL_URL || 'https://app.aldaro.ai'}/app/billing`,
          status: 'PENDING',
          dedupeKey,
        },
      });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { lastBudgetAlertAt: now },
    });
  }
}

// ---------------------------------------------------------------------------
// Organization budget check, aggregates spend across ALL org-owned workspaces
// ---------------------------------------------------------------------------
async function checkOrgBudget(
  prisma: PrismaClient,
  org: {
    id: string;
    name: string;
    slug: string;
    billingEmail: string | null;
    monthlySoftLimitCents: number | null;
    hardLimitAction: string;
    lastBudgetAlertAt: Date | null;
  },
  monthStart: Date,
  now: Date,
) {
  const limitCents = org.monthlySoftLimitCents!;

  // Get all org member user IDs to aggregate their sessions on org workspaces
  const memberships = await prisma.orgMembership.findMany({
    where: { orgId: org.id, status: 'ACTIVE' },
    select: { userId: true },
  });
  const memberUserIds = memberships.map(m => m.userId);

  // MTD spend: all usage sessions on workspaces owned by this org
  const sessions = await prisma.usageSession.findMany({
    where: {
      startTime: { gte: monthStart },
      workspace: { orgId: org.id },
    },
    select: {
      billedCents: true,
      status: true,
      startTime: true,
      pricePerHourCents: true,
      userId: true,
    },
  });

  let mtdSpendCents = 0;
  for (const s of sessions) {
    if (s.status === 'ENDED') {
      mtdSpendCents += s.billedCents;
    } else if (s.status === 'RUNNING') {
      const elapsed = Math.max(0, (now.getTime() - s.startTime.getTime()) / 1000);
      mtdSpendCents += Math.ceil((elapsed * s.pricePerHourCents) / 3600);
    }
  }

  const pct = Math.round((mtdSpendCents / limitCents) * 100);

  // Cooldown check
  const recentlyCooled = org.lastBudgetAlertAt &&
    (now.getTime() - org.lastBudgetAlertAt.getTime()) < ALERT_COOLDOWN_MS;

  // 100%, auto-terminate the org's entire fleet
  if (pct >= 100 && org.hardLimitAction === 'AUTO_TERMINATE') {
    const activeWorkspaces = await prisma.workspace.findMany({
      where: {
        orgId: org.id,
        status: { in: ['RUNNING_ASSIGNED', 'CREATING', 'WAITING_FOR_AGENT', 'ASSIGNING'] },
      },
      select: { id: true },
    });

    if (activeWorkspaces.length > 0) {
      for (const ws of activeWorkspaces) {
        await prisma.workspace.update({
          where: { id: ws.id },
          data: {
            status: 'TERMINATING',
            terminationReason: 'budget_limit',
            cleanupNextRetryAt: now,
          },
        });

        await prisma.workspaceCleanupJob.upsert({
          where: { workspaceId: ws.id },
          update: {
            reasonCode: 'org_budget_limit',
            status: 'PENDING',
            nextAttemptAt: now,
          },
          create: {
            workspaceId: ws.id,
            reasonCode: 'org_budget_limit',
            status: 'PENDING',
            nextAttemptAt: now,
          },
        });
      }

      console.log(`[BudgetMonitor] AUTO_TERMINATE ORG: killed ${activeWorkspaces.length} workspace(s) for org "${org.slug}" (${pct}% of $${(limitCents / 100).toFixed(2)} limit)`);

      // Pick an owner to attribute the alert to
      const ownerMembership = await prisma.orgMembership.findFirst({
        where: { orgId: org.id, role: 'OWNER', status: 'ACTIVE' },
        select: { userId: true },
      });
      const alertUserId = ownerMembership?.userId || memberUserIds[0];

      if (alertUserId) {
        await prisma.budgetAlert.create({
          data: {
            userId: alertUserId,
            mtdSpendCents,
            limitCents,
            thresholdPct: 100,
            action: 'AUTO_TERMINATE',
            workspacesTerminated: activeWorkspaces.length,
          },
        });
      }

      await prisma.organization.update({
        where: { id: org.id },
        data: { lastBudgetAlertAt: now },
      });
    }
    return;
  }

  // 90%, warning alert
  if (pct >= 90 && !recentlyCooled) {
    console.log(`[BudgetMonitor] WARNING ORG: "${org.slug}" at ${pct}% of $${(limitCents / 100).toFixed(2)} monthly limit (MTD: $${(mtdSpendCents / 100).toFixed(2)})`);

    const ownerMembership = await prisma.orgMembership.findFirst({
      where: { orgId: org.id, role: 'OWNER', status: 'ACTIVE' },
      select: { userId: true, user: { select: { email: true } } },
    });

    if (ownerMembership) {
      await prisma.budgetAlert.create({
        data: {
          userId: ownerMembership.userId,
          mtdSpendCents,
          limitCents,
          thresholdPct: pct >= 100 ? 100 : 90,
          action: 'ALERT',
        },
      });

      // Enqueue webhook for org owner
      const webhooks = await prisma.webhookEndpoint.findMany({
        where: {
          userId: ownerMembership.userId,
          enabled: true,
          events: { contains: 'budget.warning' },
        },
      });

      for (const wh of webhooks) {
        await prisma.webhookDelivery.create({
          data: {
            endpointId: wh.id,
            event: 'budget.warning',
            payload: JSON.stringify({
              orgId: org.id,
              orgSlug: org.slug,
              mtdSpendCents,
              limitCents,
              pct,
              hardLimitAction: org.hardLimitAction,
            }),
            status: 'PENDING',
          },
        });
      }

      // Email to billing email or org owner
      const alertEmail = org.billingEmail || ownerMembership.user?.email;
      if (alertEmail) {
        const dedupeKey = `BUDGET_WARNING_ORG:${org.id}:${now.toISOString().slice(0, 7)}:${pct >= 100 ? 100 : 90}`;
        const existingEmail = await prisma.emailOutbox.findUnique({
          where: { dedupeKey },
          select: { id: true },
        });

        if (!existingEmail) {
          await prisma.emailOutbox.create({
            data: {
              type: 'BUDGET_WARNING',
              toEmail: alertEmail,
              userId: ownerMembership.userId,
              subject: `Aldaro.AI: Team "${org.name}" has reached ${pct}% of monthly budget`,
              bodyText: `Your team "${org.name}" month-to-date GPU spend is $${(mtdSpendCents / 100).toFixed(2)}, which is ${pct}% of the $${(limitCents / 100).toFixed(2)} monthly limit.\n\n${org.hardLimitAction === 'AUTO_TERMINATE' ? 'All team workspaces will be automatically terminated if the limit is exceeded.' : 'Consider reviewing active team workspaces.'}\n\nManage your budget: ${process.env.PORTAL_URL || 'https://app.aldaro.ai'}/app/billing`,
              status: 'PENDING',
              dedupeKey,
            },
          });
        }
      }
    }

    await prisma.organization.update({
      where: { id: org.id },
      data: { lastBudgetAlertAt: now },
    });
  }
}
