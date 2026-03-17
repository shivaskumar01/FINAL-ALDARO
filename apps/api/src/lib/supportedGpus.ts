import { FLEET_GPU_SPECS } from '@aldaro/shared';

export const SUPPORTED_CUSTOMER_GPU_KEYS = ['RTX_5090', 'A100_80GB'] as const;

export type SupportedCustomerGpuKey = (typeof SUPPORTED_CUSTOMER_GPU_KEYS)[number];
export type RecommenderMethodKey = 'LoRA' | 'QLoRA' | 'FULL';
export type RecommenderModelBracket = '<=8B' | '9-20B' | '21-70B' | '71B+';

type SupportedCustomerGpuProfile = {
  key: SupportedCustomerGpuKey;
  displayName: string;
  customerDisplayName: string;
  pricePerHourCents: number;
  vramGb: number;
  shortBadge: string;
  descriptionLines: readonly string[];
  recommender: {
    throughputByBracket: Record<RecommenderModelBracket, Record<RecommenderMethodKey, number>>;
    scalingEfficiencyByCount: Record<number, number>;
    defaultSuccessBias: number;
  };
};

export const SUPPORTED_CUSTOMER_GPU_DEFAULTS: Record<
  SupportedCustomerGpuKey,
  SupportedCustomerGpuProfile
> = {
  RTX_5090: {
    ...FLEET_GPU_SPECS.RTX_5090,
    recommender: {
      throughputByBracket: {
        '<=8B': { LoRA: 4200, QLoRA: 3600, FULL: 2300 },
        '9-20B': { LoRA: 1800, QLoRA: 1500, FULL: 900 },
        '21-70B': { LoRA: 560, QLoRA: 500, FULL: 240 },
        '71B+': { LoRA: 320, QLoRA: 280, FULL: 120 },
      },
      scalingEfficiencyByCount: {
        1: 1,
        2: 0.84,
        3: 0.77,
        4: 0.71,
        5: 0.65,
        6: 0.6,
        7: 0.57,
        8: 0.54,
      },
      defaultSuccessBias: 0.92,
    },
  },
  A100_80GB: {
    ...FLEET_GPU_SPECS.A100_80GB,
    recommender: {
      throughputByBracket: {
        '<=8B': { LoRA: 3800, QLoRA: 3400, FULL: 2400 },
        '9-20B': { LoRA: 2100, QLoRA: 1800, FULL: 1150 },
        '21-70B': { LoRA: 900, QLoRA: 820, FULL: 420 },
        '71B+': { LoRA: 520, QLoRA: 460, FULL: 210 },
      },
      scalingEfficiencyByCount: {
        1: 1,
        2: 0.86,
        3: 0.8,
        4: 0.75,
        5: 0.71,
        6: 0.68,
        7: 0.65,
        8: 0.62,
      },
      defaultSuccessBias: 1,
    },
  },
};

export function isSupportedCustomerGpu(gpuType: string): gpuType is SupportedCustomerGpuKey {
  return SUPPORTED_CUSTOMER_GPU_KEYS.includes(gpuType as SupportedCustomerGpuKey);
}

export function toCustomerGpuDisplayName(gpuType: string): string {
  if (!isSupportedCustomerGpu(gpuType)) return gpuType;
  return SUPPORTED_CUSTOMER_GPU_DEFAULTS[gpuType].customerDisplayName;
}

export function getRecommendedModelBracket(paramsB: number): RecommenderModelBracket {
  if (paramsB <= 8) return '<=8B';
  if (paramsB <= 20) return '9-20B';
  if (paramsB <= 70) return '21-70B';
  return '71B+';
}

export function getTrainingTokensPerSecondPerGpu(
  gpuType: SupportedCustomerGpuKey,
  paramsB: number,
  method: RecommenderMethodKey,
  contextLen: number,
): number {
  const profile = SUPPORTED_CUSTOMER_GPU_DEFAULTS[gpuType];
  const bracket = getRecommendedModelBracket(paramsB);
  const base = profile.recommender.throughputByBracket[bracket][method];
  const contextPenalty = contextLen <= 4096 ? 1 : Math.pow(4096 / contextLen, 0.35);
  return Math.round(base * contextPenalty * 100) / 100;
}

export function getScalingEfficiency(
  gpuType: SupportedCustomerGpuKey,
  gpuCount: number,
  zeroStage: number | null,
): number {
  const profile = SUPPORTED_CUSTOMER_GPU_DEFAULTS[gpuType];
  const base =
    profile.recommender.scalingEfficiencyByCount[gpuCount] ??
    profile.recommender.scalingEfficiencyByCount[
      Math.max(...Object.keys(profile.recommender.scalingEfficiencyByCount).map(Number))
    ];
  const zeroPenalty = zeroStage === 3 && gpuCount > 1 ? 0.02 : 0;
  return Math.max(0.5, Math.round((base - zeroPenalty) * 100) / 100);
}
