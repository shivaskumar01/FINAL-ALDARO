import { getBasePriceCentsPerGpuHour, GPU_PRICING_PRESETS } from './gpuPricing';

/** Cents per hour by GPU display name. Derived from gpuPricing algorithm; use getBasePriceCentsPerGpuHour(skuKey) when you have the key. */
export const PRICING: Record<string, number> = {};
for (const [key, preset] of Object.entries(GPU_PRICING_PRESETS)) {
  const cents = getBasePriceCentsPerGpuHour(key);
  if (cents != null) PRICING[preset.gpuName] = cents;
}
const a100Cents = getBasePriceCentsPerGpuHour('A100_80GB');
if (a100Cents != null) PRICING['NVIDIA A100 80GB PCIe'] = a100Cents;

export const QUOTAS = {
  DEFAULT_MAX_ACTIVE_WORKSPACES: 1,
  DEFAULT_DAILY_RUNTIME_LIMIT_MINUTES: 360,
  DEFAULT_LAUNCHES_PER_HOUR_LIMIT: 3,
};
