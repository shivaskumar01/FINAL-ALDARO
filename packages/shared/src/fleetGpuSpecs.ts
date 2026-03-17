import { getBasePriceCentsPerGpuHour } from './gpuPricing';

export const FLEET_GPU_SPECS = {
  RTX_5090: {
    key: 'RTX_5090',
    displayName: 'RTX 5090',
    customerDisplayName: 'RTX 5090',
    gpuName: 'NVIDIA GeForce RTX 5090',
    vramGb: 32,
    pricePerHourCents: getBasePriceCentsPerGpuHour('RTX_5090') ?? 55,
    shortBadge: 'Best value',
    descriptionLines: ['Fine-tuning', 'Inference', 'Fast iteration'],
  },
  A100_80GB: {
    key: 'A100_80GB',
    displayName: 'A100 80GB',
    customerDisplayName: 'A100N',
    gpuName: 'NVIDIA A100-SXM4-80GB',
    vramGb: 80,
    pricePerHourCents: getBasePriceCentsPerGpuHour('A100_80GB') ?? 249,
    shortBadge: 'Max VRAM',
    descriptionLines: ['Large batch training', 'Bigger checkpoints', 'VRAM-heavy pipelines'],
  },
} as const;

export type FleetGpuKey = keyof typeof FLEET_GPU_SPECS;
