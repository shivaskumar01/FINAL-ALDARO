import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { SUPPORTED_CUSTOMER_GPU_KEYS, isSupportedCustomerGpu } from '../../lib/supportedGpus';

const prisma = new PrismaClient();

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

// GET /api/ops/fleet/daily?days=45
// Returns FleetDailyAgg rows
export const opsFleetRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.addHook('preHandler', fastify.authenticate as any);
  fastify.addHook('preHandler', fastify.requireAuthor as any);

  fastify.get('/daily', async (request: any) => {
    const days = clamp(parseInt((request.query?.days ?? '45') as string, 10) || 45, 1, 365);
    const end = startOfDayUTC(new Date());
    const start = addDaysUTC(end, -days + 1);

    const rows = await prisma.fleetDailyAgg.findMany({
      where: { date: { gte: start, lte: end }, gpuType: { in: [...SUPPORTED_CUSTOMER_GPU_KEYS] } },
      orderBy: [{ date: 'asc' }, { gpuType: 'asc' }],
    });

    return {
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      items: rows.map((r) => ({
        date: r.date.toISOString(),
        gpuType: r.gpuType,
        gpuCount: r.gpuCount,
        gpuHoursAvailable: Number(r.gpuHoursAvailable),
        gpuHoursUsed: Number(r.gpuHoursUsed),
        utilizationPct: Number(r.utilizationPct),
        revenueUsd: Number(r.revenueUsd),
        sessionsCount: r.sessionsCount,
        uniqueCustomers: r.uniqueCustomers,
        newSignups: r.newSignups,
        newApprovals: r.newApprovals,
      })),
    };
  });

  // GET /api/ops/fleet/forecast?horizon=7&gpuType=RTX_5090
  fastify.get('/forecast', async (request: any, reply: any) => {
    const q = z.object({
      horizon: z.coerce.number().int().min(1).max(30).default(7),
      gpuType: z.string().min(1),
    }).safeParse(request.query);
    if (!q.success) return reply.status(400).send({ error: 'Invalid query.' });
    if (!isSupportedCustomerGpu(q.data.gpuType)) {
      return reply.status(400).send({ error: 'Unsupported GPU type.' });
    }

    const today = startOfDayUTC(new Date());
    const startHist = addDaysUTC(today, -28);
    const rows = await prisma.fleetDailyAgg.findMany({
      where: { gpuType: q.data.gpuType, date: { gte: startHist, lt: today } },
      orderBy: { date: 'asc' },
    });

    const actual = rows.map((r) => ({
      date: r.date,
      used: Number(r.gpuHoursUsed),
      available: Number(r.gpuHoursAvailable),
      rate: Number(r.gpuHoursUsed) > 0 ? Number(r.revenueUsd) / Number(r.gpuHoursUsed) : null,
    }));

    const last7 = actual.slice(-7);
    const base = last7.length ? (last7.reduce((s, x) => s + x.used, 0) / last7.length) : 0;

    // day-of-week multipliers from last 28 days
    const byDow: Record<number, { sum: number; n: number }> = {};
    for (const a of actual) {
      const dow = a.date.getUTCDay();
      byDow[dow] = byDow[dow] || { sum: 0, n: 0 };
      byDow[dow].sum += a.used;
      byDow[dow].n += 1;
    }
    const overallAvg = actual.length ? (actual.reduce((s, x) => s + x.used, 0) / actual.length) : 0;
    const multiplier = (dow: number) => {
      const v = byDow[dow];
      if (!v || v.n === 0 || overallAvg === 0) return 1;
      return clamp((v.sum / v.n) / overallAvg, 0.6, 1.6);
    };

    // error estimate from last 14 days using same model (MAE)
    const last14 = actual.slice(-14);
    let absErrSum = 0;
    let absErrN = 0;
    for (let i = 7; i < last14.length; i++) {
      const window = last14.slice(i - 7, i);
      const b = window.reduce((s, x) => s + x.used, 0) / window.length;
      const pred = b * multiplier(last14[i].date.getUTCDay());
      absErrSum += Math.abs(last14[i].used - pred);
      absErrN += 1;
    }
    const mae = absErrN ? absErrSum / absErrN : 0;

    // projected hourly rate: average of last 7 non-null rates (fallback to sku pricing)
    const lastRates = last7.map((x) => x.rate).filter((x) => typeof x === 'number') as number[];
    let projectedHourlyRate = lastRates.length ? (lastRates.reduce((s, x) => s + x, 0) / lastRates.length) : null;
    if (projectedHourlyRate == null) {
      const sku = await prisma.gpuSku.findUnique({ where: { key: q.data.gpuType } });
      projectedHourlyRate = sku ? sku.pricePerHourCents / 100 : 0;
    }

    const forecast = [];
    for (let i = 1; i <= q.data.horizon; i++) {
      const date = addDaysUTC(today, i);
      const f = base * multiplier(date.getUTCDay());
      const low = Math.max(0, f - mae);
      const high = f + mae;
      forecast.push({
        date: date.toISOString(),
        gpuType: q.data.gpuType,
        forecastGpuHoursUsed: round2(f),
        low: round2(low),
        high: round2(high),
        projectedHourlyRate: round2(projectedHourlyRate || 0),
        revenueUsd: round2(f * (projectedHourlyRate || 0)),
      });
    }

    return reply.send({
      gpuType: q.data.gpuType,
      horizon: q.data.horizon,
      base7dAvg: round2(base),
      mae: round2(mae),
      forecast,
    });
  });

  // GET /api/ops/fleet/pricing-suggestions?horizon=7
  fastify.get('/pricing-suggestions', async (request: any, reply: any) => {
    const q = z.object({
      horizon: z.coerce.number().int().min(1).max(30).default(7),
    }).safeParse(request.query);
    if (!q.success) return reply.status(400).send({ error: 'Invalid query.' });

    const today = startOfDayUTC(new Date());
    const end = addDaysUTC(today, q.data.horizon);

    const skus = await prisma.gpuSku.findMany({
      where: {
        enabled: true,
        key: { in: [...SUPPORTED_CUSTOMER_GPU_KEYS] },
      },
    });
    const suggestions = [];

    for (const sku of skus) {
      const rows = await prisma.fleetDailyAgg.findMany({
        where: { gpuType: sku.key, date: { gte: today, lt: end } },
        orderBy: { date: 'asc' },
      });

      // If no aggs yet for future, skip (job will fill; UI can call forecast endpoint per type)
      // For v1, use last 7 days utilization as proxy if future missing.
      let projected = rows.map((r) => Number(r.utilizationPct));
      if (projected.length === 0) {
        const hist = await prisma.fleetDailyAgg.findMany({
          where: { gpuType: sku.key, date: { gte: addDaysUTC(today, -7), lt: today } },
          orderBy: { date: 'asc' },
        });
        projected = hist.map((r) => Number(r.utilizationPct));
      }
      const avgUtil = projected.length ? projected.reduce((s, x) => s + x, 0) / projected.length : 0;

      const currentRate = sku.pricePerHourCents / 100;
      let suggestedRate = currentRate;
      let reason = '';
      if (avgUtil > 85) {
        suggestedRate = currentRate * 1.05;
        reason = 'Projected utilization > 85%';
      } else if (avgUtil < 40) {
        suggestedRate = currentRate * 0.95;
        reason = 'Projected utilization < 40%';
      } else {
        continue;
      }

      // conservative bounds
      const minRate = currentRate * 0.7;
      const maxRate = currentRate * 1.5;
      suggestedRate = clamp(suggestedRate, minRate, maxRate);

      suggestions.push({
        gpuType: sku.key,
        currentRate: round2(currentRate),
        suggestedRate: round2(suggestedRate),
        reason,
        projectedUtilizationPct: round2(avgUtil),
      });
    }

    return reply.send({ horizon: q.data.horizon, items: suggestions });
  });
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
