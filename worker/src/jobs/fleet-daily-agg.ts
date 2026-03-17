import { PrismaClient } from '@prisma/client';

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
}

function addDaysUTC(d: Date, days: number): Date {
  const nd = new Date(d.getTime());
  nd.setUTCDate(nd.getUTCDate() + days);
  return nd;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function overlapSeconds(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  const s = Math.max(aStart.getTime(), bStart.getTime());
  const e = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, Math.floor((e - s) / 1000));
}

export async function fleetDailyAggBackfill(prisma: PrismaClient, days: number): Promise<void> {
  const today = startOfDayUTC(new Date());
  const start = addDaysUTC(today, -Math.max(1, days - 1));
  for (let d = start; d <= today; d = addDaysUTC(d, 1)) {
    await computeFleetDailyAggForDate(prisma, d);
  }
}

export async function fleetDailyAggTodayRefresh(prisma: PrismaClient): Promise<void> {
  const today = startOfDayUTC(new Date());
  await computeFleetDailyAggForDate(prisma, today);
}

async function computeFleetDailyAggForDate(prisma: PrismaClient, day: Date): Promise<void> {
  const dayStart = startOfDayUTC(day);
  const dayEnd = addDaysUTC(dayStart, 1);

  // GPU inventory counts (healthy-ish: any gpu with a type)
  const gpus = await prisma.fleetGpu.findMany({
    where: { gpuType: { not: null } },
    select: { gpuType: true },
  });
  const gpuCounts = new Map<string, number>();
  for (const g of gpus) {
    const t = g.gpuType || 'UNKNOWN';
    gpuCounts.set(t, (gpuCounts.get(t) || 0) + 1);
  }

  // Usage sessions overlapping this day
  const sessions = await prisma.usageSession.findMany({
    where: {
      startTime: { lt: dayEnd },
      OR: [{ endTime: null }, { endTime: { gt: dayStart } }],
    },
    select: {
      userId: true,
      gpuType: true,
      startTime: true,
      endTime: true,
      totalSeconds: true,
      billedCents: true,
    },
  });

  type Agg = {
    sessionsCount: number;
    uniqueCustomers: Set<string>;
    usedSeconds: number;
    revenueUsd: number;
  };

  const byGpu = new Map<string, Agg>();
  const getAgg = (gpuType: string): Agg => {
    const key = gpuType || 'UNKNOWN';
    const existing = byGpu.get(key);
    if (existing) return existing;
    const created: Agg = { sessionsCount: 0, uniqueCustomers: new Set(), usedSeconds: 0, revenueUsd: 0 };
    byGpu.set(key, created);
    return created;
  };

  for (const s of sessions) {
    const gpuType = s.gpuType || 'UNKNOWN';
    const end = s.endTime || new Date();
    const ov = overlapSeconds(s.startTime, end, dayStart, dayEnd);
    if (ov <= 0) continue;
    const agg = getAgg(gpuType);
    agg.sessionsCount += 1;
    agg.uniqueCustomers.add(s.userId);
    agg.usedSeconds += ov;

    // revenue allocation: proportion of billedCents by overlap / totalSeconds (fallback to overlap)
    const denom = s.totalSeconds > 0 ? s.totalSeconds : ov;
    const frac = denom > 0 ? ov / denom : 0;
    agg.revenueUsd += (s.billedCents / 100) * frac;
  }

  // New signups in this day
  const newSignups = await prisma.user.count({
    where: { createdAt: { gte: dayStart, lt: dayEnd } },
  });

  // New approvals in this day (manual customer approval)
  const newApprovals = await prisma.user.count({
    where: {
      customerAccessStatus: 'APPROVED',
      customerAccessUpdatedAt: { gte: dayStart, lt: dayEnd },
    },
  });

  // For GPU types not seen in usage, still write rows based on inventory.
  const gpuTypes = new Set<string>([...gpuCounts.keys(), ...byGpu.keys()]);

  for (const gpuType of gpuTypes) {
    const count = gpuCounts.get(gpuType) || 0;
    const availableHours = count * 24;
    const agg = byGpu.get(gpuType);
    const usedHours = agg ? agg.usedSeconds / 3600 : 0;
    const util = availableHours > 0 ? (usedHours / availableHours) * 100 : 0;

    await prisma.fleetDailyAgg.upsert({
      where: { date_gpuType: { date: dayStart, gpuType } },
      update: {
        gpuCount: count,
        gpuHoursAvailable: availableHours,
        gpuHoursUsed: usedHours,
        utilizationPct: clamp(util, 0, 100),
        revenueUsd: agg ? agg.revenueUsd : 0,
        sessionsCount: agg ? agg.sessionsCount : 0,
        uniqueCustomers: agg ? agg.uniqueCustomers.size : 0,
        newSignups,
        newApprovals,
      },
      create: {
        date: dayStart,
        gpuType,
        gpuCount: count,
        gpuHoursAvailable: availableHours,
        gpuHoursUsed: usedHours,
        utilizationPct: clamp(util, 0, 100),
        revenueUsd: agg ? agg.revenueUsd : 0,
        sessionsCount: agg ? agg.sessionsCount : 0,
        uniqueCustomers: agg ? agg.uniqueCustomers.size : 0,
        newSignups,
        newApprovals,
      },
    });
  }
}

