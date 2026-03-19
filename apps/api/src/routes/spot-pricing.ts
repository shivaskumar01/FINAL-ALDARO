import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { SUPPORTED_CUSTOMER_GPU_KEYS } from '../lib/supportedGpus';

const prisma = new PrismaClient();

function computeStatus(multiplier: number): string {
  if (multiplier >= 1.25) return 'SURGE';
  if (multiplier > 1.0) return 'HIGH_DEMAND';
  if (multiplier < 1.0) return 'DISCOUNT';
  return 'NORMAL';
}

export const spotPricingRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  /**
   * GET /spot-pricing
   * Public endpoint — returns current spot prices for all GPU types.
   * No auth required for pricing transparency.
   */
  fastify.get('/', async () => {
    const configs = await prisma.warmPoolConfig.findMany();
    const skus = await prisma.gpuSku.findMany({
      where: { enabled: true, key: { in: [...SUPPORTED_CUSTOMER_GPU_KEYS] } },
    });
    const skuMap = new Map(skus.map(s => [s.key, s]));

    const prices = await Promise.all(
      configs.map(async (cfg) => {
        const available = await prisma.workspace.count({
          where: {
            status: 'WARM_AVAILABLE',
            gpuType: cfg.gpuType,
            region: cfg.region,
            isWarmPool: true,
            assignedUserId: null,
          },
        });

        const sku = skuMap.get(cfg.gpuType);
        const multiplier = sku?.spotMultiplier ?? 1.0;

        return {
          gpuType: cfg.gpuType,
          region: cfg.region,
          basePriceCents: cfg.basePriceCents,
          spotPriceCents: cfg.currentSpotPriceCents,
          multiplier: Math.round(multiplier * 100) / 100,
          status: computeStatus(multiplier),
          availableWarm: available,
          targetPool: cfg.targetCount,
          lastUpdatedAt: cfg.lastPriceUpdateAt?.toISOString() ?? null,
        };
      })
    );

    return { prices };
  });

  /**
   * GET /spot-pricing/:gpuType
   * Public endpoint — returns spot price for a specific GPU type.
   */
  fastify.get('/:gpuType', async (request: any, reply: any) => {
    const { gpuType } = request.params as { gpuType: string };

    const cfg = await prisma.warmPoolConfig.findFirst({
      where: { gpuType },
    });

    if (!cfg) {
      return reply.status(404).send({
        errorCode: 'GPU_TYPE_NOT_FOUND',
        message: `No pricing configuration found for GPU type: ${gpuType}`,
        error: `No pricing configuration found for GPU type: ${gpuType}`,
      });
    }

    const sku = await prisma.gpuSku.findUnique({ where: { key: gpuType } });
    const multiplier = sku?.spotMultiplier ?? 1.0;

    const available = await prisma.workspace.count({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType: cfg.gpuType,
        region: cfg.region,
        isWarmPool: true,
        assignedUserId: null,
      },
    });

    return {
      gpuType: cfg.gpuType,
      region: cfg.region,
      basePriceCents: cfg.basePriceCents,
      spotPriceCents: cfg.currentSpotPriceCents,
      multiplier: Math.round(multiplier * 100) / 100,
      status: computeStatus(multiplier),
      availableWarm: available,
      targetPool: cfg.targetCount,
      lastUpdatedAt: cfg.lastPriceUpdateAt?.toISOString() ?? null,
    };
  });
};
