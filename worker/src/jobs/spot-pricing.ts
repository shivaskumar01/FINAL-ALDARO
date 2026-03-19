import { PrismaClient } from '@prisma/client';

/**
 * Spot Pricing Worker Job
 *
 * Dynamically adjusts GPU spot prices based on warm pool utilization.
 *
 * Pricing tiers:
 * - SURGE:       ratio < 0.25  -> 1.25x to 1.5x
 * - HIGH_DEMAND: ratio < 0.50  -> 1.0x to 1.25x
 * - NORMAL:      ratio 0.5-1.0 -> 1.0x
 * - DISCOUNT:    ratio >= 1.0 + idle > 12h -> 0.85x to 1.0x
 *
 * Floor: $0.40/hr (40 cents)
 * Ceiling: $2.00/hr for RTX_5090, $5.00/hr for A100_80GB
 */

export async function updateSpotPrices(prisma: PrismaClient) {
  const configs = await prisma.warmPoolConfig.findMany();

  for (const cfg of configs) {
    // Count available warm workspaces
    const available = await prisma.workspace.count({
      where: {
        status: 'WARM_AVAILABLE',
        gpuType: cfg.gpuType,
        region: cfg.region,
        isWarmPool: true,
        assignedUserId: null,
      },
    });

    const ratio = cfg.targetCount > 0 ? available / cfg.targetCount : 1;

    let multiplier = 1.0;
    let status = 'NORMAL';

    // High Demand: ratio < 0.25 -> surge up to 1.5x
    if (ratio < 0.25) {
      multiplier = 1.25 + (0.25 * (1 - ratio / 0.25)); // scales 1.25x to 1.5x
      status = 'SURGE';
    } else if (ratio < 0.5) {
      multiplier = 1.0 + (0.25 * (1 - (ratio - 0.25) / 0.25)); // scales 1.0x to 1.25x
      status = 'HIGH_DEMAND';
    }

    // Idle Saturated: ratio >= 1.0 AND no rental in 12 hours
    if (ratio >= 1.0 && cfg.lastRentalAt) {
      const hoursSinceLastRental = (Date.now() - cfg.lastRentalAt.getTime()) / 3_600_000;
      if (hoursSinceLastRental > 12) {
        multiplier = Math.max(0.85, 1.0 - (0.05 * Math.min(3, Math.floor((hoursSinceLastRental - 12) / 6))));
        status = 'DISCOUNT';
      }
    } else if (ratio >= 1.0 && !cfg.lastRentalAt) {
      multiplier = 0.90;
      status = 'DISCOUNT';
    }

    // Calculate spot price with floor and ceiling
    const rawSpotCents = Math.round(cfg.basePriceCents * multiplier);
    const FLOOR_CENTS = 40; // $0.40/hr minimum
    const CEILING_CENTS = 200; // $2.00/hr maximum for RTX_5090
    // A100 has higher ceiling
    const ceilingForGpu = cfg.gpuType === 'A100_80GB' ? 500 : CEILING_CENTS;
    const spotPriceCents = Math.min(ceilingForGpu, Math.max(FLOOR_CENTS, rawSpotCents));

    const oldPrice = cfg.currentSpotPriceCents;

    await prisma.warmPoolConfig.update({
      where: { id: cfg.id },
      data: {
        currentSpotPriceCents: spotPriceCents,
        lastPriceUpdateAt: new Date(),
      },
    });

    // Update GpuSku for API consumption
    await prisma.gpuSku.updateMany({
      where: { key: cfg.gpuType },
      data: {
        spotPriceCents,
        spotMultiplier: Math.round(multiplier * 100) / 100,
      },
    });

    // Log to PricingSuggestion for admin audit trail
    if (oldPrice !== spotPriceCents) {
      await prisma.pricingSuggestion.create({
        data: {
          gpuType: cfg.gpuType,
          currentRate: oldPrice,
          suggestedRate: spotPriceCents,
          reason: `Auto spot pricing: ratio=${ratio.toFixed(2)}, multiplier=${multiplier.toFixed(2)}, status=${status}`,
          inputsJson: JSON.stringify({
            ratio: Math.round(ratio * 100) / 100,
            multiplier: Math.round(multiplier * 100) / 100,
            available,
            targetCount: cfg.targetCount,
            status,
          }),
          status: 'APPLIED', // AUTO_APPLIED for audit
        },
      });

      console.log(`[SpotPricing] ${cfg.gpuType}: ${oldPrice}c -> ${spotPriceCents}c (${status}, ratio=${ratio.toFixed(2)}, mult=${multiplier.toFixed(2)})`);
    }
  }
}
