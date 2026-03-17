/**
 * GPU hourly pricing algorithm.
 * One unit = one physical GPU for one hour.
 * See rubric: cost-based floor, optional market anchor, optional real-time multiplier.
 */

const HOURS_PER_MONTH = 24 * 30.4375;

/** Per-GPU-model inputs (set once per SKU). */
export interface GpuPricingInputs {
  gpuName: string;
  capexUsd: number;
  residualUsd: number;
  lifeMonths: number;
  avgPowerW: number;
  pue: number;
  electricityUsdPerKwh: number;
  targetUtilization: number;
  downtimeRate: number;
  monthlyFacilityUsd: number;
  monthlyOpsUsd: number;
  annualFailureReservePct: number;
  paymentPct: number;
  targetGrossMarginPct: number;
  /** Optional: median street price to track. */
  marketAnchorUsdPerGpuHr?: number;
  /** Optional: e.g. 0.95 to undercut, 1.10 for premium. */
  positioningFactor?: number;
}

/** Real-time inputs for dynamic pricing (optional). */
export interface GpuPricingRealTimeInputs {
  freeGpuCount: number;
  totalGpuCount: number;
  queueMinutes?: number;
  targetQueueMinutes?: number;
  /** 0 = fixed price, 1 = fully spot/dynamic. */
  spotness?: number;
}

/** Unit economics (cost per billable GPU-hour). */
export interface UnitEconomics {
  billableHoursPerMonth: number;
  capexPerHr: number;
  fixedOpexPerHr: number;
  powerPerHr: number;
  failureReservePerHr: number;
  costPerHr: number;
  priceFloorPerGpuHr: number;
  priceAnchoredPerGpuHr: number | null;
  basePricePerGpuHr: number;
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/**
 * Compute unit economics and cost per billable hour.
 */
export function computeUnitEconomics(inputs: GpuPricingInputs): UnitEconomics {
  const billableHoursPerMonth =
    HOURS_PER_MONTH * inputs.targetUtilization * (1 - inputs.downtimeRate);

  const capexPerHr =
    (inputs.capexUsd - inputs.residualUsd) /
    (inputs.lifeMonths * billableHoursPerMonth);

  const fixedOpexPerHr =
    (inputs.monthlyFacilityUsd + inputs.monthlyOpsUsd) / billableHoursPerMonth;

  const powerPerHr =
    (inputs.avgPowerW / 1000) *
    inputs.pue *
    inputs.electricityUsdPerKwh;

  const failureReservePerHr =
    (inputs.capexUsd * inputs.annualFailureReservePct) /
    (365 * 24 * inputs.targetUtilization * (1 - inputs.downtimeRate));

  const costPerHr =
    capexPerHr + fixedOpexPerHr + powerPerHr + failureReservePerHr;

  const priceFloorPerGpuHr =
    (costPerHr * (1 + inputs.targetGrossMarginPct)) / (1 - inputs.paymentPct);

  const priceAnchoredPerGpuHr =
    inputs.marketAnchorUsdPerGpuHr != null && inputs.positioningFactor != null
      ? inputs.marketAnchorUsdPerGpuHr * inputs.positioningFactor
      : null;

  const basePricePerGpuHr =
    priceAnchoredPerGpuHr != null
      ? Math.max(priceFloorPerGpuHr, priceAnchoredPerGpuHr)
      : priceFloorPerGpuHr;

  return {
    billableHoursPerMonth,
    capexPerHr,
    fixedOpexPerHr,
    powerPerHr,
    failureReservePerHr,
    costPerHr,
    priceFloorPerGpuHr,
    priceAnchoredPerGpuHr,
    basePricePerGpuHr,
  };
}

/**
 * Price floor (one GPU for one hour): cost + margin, adjusted for payment fees.
 */
export function computePriceFloor(inputs: GpuPricingInputs): number {
  return computeUnitEconomics(inputs).priceFloorPerGpuHr;
}

/**
 * Base unit price before real-time changes: max(floor, market-anchored).
 */
export function computeBasePrice(inputs: GpuPricingInputs): number {
  return computeUnitEconomics(inputs).basePricePerGpuHr;
}

/**
 * Dynamic multiplier from scarcity and queue pressure.
 * Clamped to [0.80, 2.00].
 */
export function computeDynamicMultiplier(
  rt: GpuPricingRealTimeInputs
): number {
  const scarcity =
    rt.totalGpuCount <= 0 ? 0 : 1 - rt.freeGpuCount / rt.totalGpuCount;
  const targetQueue = rt.targetQueueMinutes ?? 0;
  const queuePressure =
    targetQueue <= 0 || rt.queueMinutes == null
      ? 0
      : Math.max(0, rt.queueMinutes / targetQueue - 1);
  return clamp(1 + 0.6 * scarcity + 0.4 * queuePressure, 0.8, 2.0);
}

/**
 * Full unit price per GPU-hour (optionally with real-time adjustment).
 */
export function priceGpuHour(
  inputs: GpuPricingInputs,
  realTime?: GpuPricingRealTimeInputs
): number {
  const { basePricePerGpuHr } = computeUnitEconomics(inputs);
  if (realTime == null || (realTime.spotness ?? 0) <= 0) {
    return basePricePerGpuHr;
  }
  const spotness = realTime.spotness ?? 0;
  const dynamicMult = computeDynamicMultiplier(realTime);
  return basePricePerGpuHr * (1 - 0.2 * spotness + spotness * dynamicMult);
}

/**
 * Volume discount factor by number of GPUs g.
 */
export function volDisc(g: number): number {
  if (g < 4) return 1.0;
  if (g < 8) return 0.97;
  return 0.94;
}

/**
 * Commitment discount for prepaid hours per GPU per month.
 */
export function commitDisc(commitHours: number): number {
  if (commitHours < 50) return 1.0;
  if (commitHours <= 200) return 0.95;
  return 0.9;
}

/**
 * Subtotal for g GPUs for h hours at unitPricePerGpuHr.
 * Optional: apply volume and commitment discounts.
 */
export function subtotal(
  unitPricePerGpuHr: number,
  g: number,
  h: number,
  options?: { volumeDiscount?: boolean; commitHoursPerGpuPerMonth?: number }
): number {
  let total = unitPricePerGpuHr * g * h;
  if (options?.volumeDiscount) total *= volDisc(g);
  if (options?.commitHoursPerGpuPerMonth != null)
    total *= commitDisc(options.commitHoursPerGpuPerMonth);
  return total;
}

// ---------------------------------------------------------------------------
// Presets (example inputs; adjust capex, colo, utilization to your reality)
// ---------------------------------------------------------------------------

/** Default facility/ops and market assumptions (override per GPU if needed). */
const DEFAULTS = {
  pue: 1.58,
  electricityUsdPerKwh: 0.1343, // EIA Nov 2025 US average
  targetUtilization: 0.75,
  downtimeRate: 0.05,
  monthlyFacilityUsd: 80,
  monthlyOpsUsd: 40,
  annualFailureReservePct: 0.02,
  paymentPct: 0.03,
  targetGrossMarginPct: 0.35,
  positioningFactor: 1.0,
};

/** Preset inputs keyed by GPU SKU key (e.g. RTX_5090, A100_80GB). */
export const GPU_PRICING_PRESETS: Record<string, GpuPricingInputs> = {
  RTX_5090: {
    gpuName: 'NVIDIA GeForce RTX 5090',
    capexUsd: 1999,
    residualUsd: 400,
    lifeMonths: 42,
    avgPowerW: 400,
    pue: DEFAULTS.pue,
    electricityUsdPerKwh: DEFAULTS.electricityUsdPerKwh,
    targetUtilization: DEFAULTS.targetUtilization,
    downtimeRate: DEFAULTS.downtimeRate,
    monthlyFacilityUsd: DEFAULTS.monthlyFacilityUsd,
    monthlyOpsUsd: DEFAULTS.monthlyOpsUsd,
    annualFailureReservePct: DEFAULTS.annualFailureReservePct,
    paymentPct: DEFAULTS.paymentPct,
    targetGrossMarginPct: DEFAULTS.targetGrossMarginPct,
    marketAnchorUsdPerGpuHr: 0.55,
    positioningFactor: DEFAULTS.positioningFactor,
  },
  A100_80GB: {
    gpuName: 'NVIDIA A100 80GB',
    capexUsd: 12000,
    residualUsd: 2000,
    lifeMonths: 36,
    avgPowerW: 350,
    pue: DEFAULTS.pue,
    electricityUsdPerKwh: DEFAULTS.electricityUsdPerKwh,
    targetUtilization: DEFAULTS.targetUtilization,
    downtimeRate: DEFAULTS.downtimeRate,
    monthlyFacilityUsd: 120,
    monthlyOpsUsd: 60,
    annualFailureReservePct: DEFAULTS.annualFailureReservePct,
    paymentPct: DEFAULTS.paymentPct,
    targetGrossMarginPct: DEFAULTS.targetGrossMarginPct,
    marketAnchorUsdPerGpuHr: 2.49,
    positioningFactor: DEFAULTS.positioningFactor,
  },
};

/**
 * Get base price per GPU-hour in dollars for a preset SKU key.
 * Returns undefined if key is not in presets.
 */
export function getBasePriceUsdPerGpuHour(skuKey: string): number | undefined {
  const preset = GPU_PRICING_PRESETS[skuKey];
  if (!preset) return undefined;
  return priceGpuHour(preset);
}

/**
 * Get base price per GPU-hour in cents (for DB storage / display).
 */
export function getBasePriceCentsPerGpuHour(skuKey: string): number | undefined {
  const usd = getBasePriceUsdPerGpuHour(skuKey);
  if (usd == null) return undefined;
  return Math.round(usd * 100);
}
