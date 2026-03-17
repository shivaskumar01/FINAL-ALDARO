import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  getScalingEfficiency,
  getTrainingTokensPerSecondPerGpu,
  SUPPORTED_CUSTOMER_GPU_DEFAULTS,
  SUPPORTED_CUSTOMER_GPU_KEYS,
  SupportedCustomerGpuKey,
} from '../lib/supportedGpus';

const prisma = new PrismaClient();

const advancedSchema = z.object({
  modelFamily: z.string().optional(),
  paramsB: z.number().min(0.1).max(500).optional(),
  method: z.enum(['LoRA', 'QLoRA', 'FULL_FINETUNE']).optional(),
  samples: z.number().int().min(1).max(1_000_000_000).optional(),
  tokensPerSample: z.number().int().min(1).max(100_000).optional(),
  epochs: z.number().min(0.1).max(100).optional(),
  contextLen: z.number().int().min(256).max(1_000_000).optional(),
  batchSize: z.number().int().min(1).max(1024).optional(),
  effectiveBatchSize: z.number().int().min(1).max(16_384).optional(),
  precision: z.enum(['bf16', 'fp16', 'int8', 'nf4']).optional(),
  packingMode: z.enum(['ENABLED', 'DISABLED']).optional(),
  gradientCheckpointing: z.boolean().optional(),
  maxGpus: z.number().int().min(1).max(64).optional(),
  maxTotalBudgetUsd: z.number().min(1).max(10_000_000).optional(),
});

const requestSchema = z.object({
  inputText: z.string().min(1).max(5000),
  advanced: advancedSchema.nullable().optional(),
  objective: z.enum(['SUCCESS_RATE', 'LOWEST_COST', 'FASTEST', 'SMALLEST_CLUSTER']).optional(),
  showRisky: z.boolean().optional(),
});

type RecommendationObjective = z.infer<typeof requestSchema>['objective'] extends infer T
  ? Exclude<T, undefined>
  : never;

type Parsed = {
  modelFamily: string | null;
  paramsB: number | null;
  paramsEstimateAssumed: boolean;
  method: 'LoRA' | 'QLoRA' | 'FULL_FINETUNE' | null;
  samples: number | null;
  sampleEstimateAssumed: boolean;
  tokensPerSample: number;
  contextLen: number;
  epochs: number;
  microBatchPerGpu: number;
  effectiveBatchSize: number | null;
  gradientAccumulationSteps: number | null;
  loraRank: number | null;
  precision: 'bf16' | 'fp16' | 'int8' | 'nf4';
  zeroStage: number | null;
  distributedRequested: boolean;
  packingMode: 'ENABLED' | 'DISABLED' | 'UNSPECIFIED';
  gradientCheckpointing: boolean | null;
  confidence: number;
};

type WorkloadAnalysis = {
  estimatedSingleGpuVramGb: number;
  tokensLow: number;
  tokensHigh: number;
  packingAssumption: string;
  checkpointingAssumption: string;
  warnings: string[];
};

type Recommendation = {
  gpuType: SupportedCustomerGpuKey;
  rank: number | null;
  variant: 'BEST_FIT' | 'MINIMUM_GPUS' | 'LOWEST_COST' | 'FASTEST';
  variantLabel: string;
  objective: RecommendationObjective;
  promptIntentMatch: boolean;
  vramGb: number;
  perGpuVramGb: number;
  fitMarginGb: number;
  fitRisk: 'SAFE' | 'MODERATE' | 'TIGHT' | 'NO_FIT';
  gpuCount: number;
  timeHoursLow: number;
  timeHoursHigh: number;
  costUsdLow: number;
  costUsdHigh: number;
  clusterHourlyUsd: number;
  podTemplateId: string;
  podTemplateName: string;
  reason: string;
  launchable: boolean;
  scoreBreakdown: {
    objective: RecommendationObjective;
    weights: {
      risk: number;
      cost: number;
      time: number;
      cluster: number;
      distributedMismatch: number;
    };
    riskComponent: number;
    costComponent: number;
    timeComponent: number;
    clusterComponent: number;
    intentMismatchComponent: number;
    weightedRisk: number;
    weightedCost: number;
    weightedTime: number;
    weightedCluster: number;
    weightedIntentMismatch: number;
    distributedPenalty: number;
    total: number;
  } | null;
  assumptions: {
    tokensPerSecondPerGpu: number;
    clusterTokensPerSecond: number;
    scalingEfficiency: number;
    totalTokensLow: number;
    totalTokensHigh: number;
    safetyMargin: number;
    method: string;
    warmCount: number;
    hourlyRateUsd: number | null;
    packingMode: string;
    packingAssumption: string;
    checkpointingAssumption: string;
    distributedRequested: boolean;
    rangeLowLabel: string;
    rangeHighLabel: string;
  };
};

type ScoreBreakdown = NonNullable<Recommendation['scoreBreakdown']>;
type ObjectiveWeights = ScoreBreakdown['weights'];
const DEFAULT_ASSUMED_TRAINING_SAMPLES = 50_000;

function extractNumber(regex: RegExp, txt: string): number | null {
  const match = txt.match(regex);
  if (!match) return null;
  const raw = match[1].replace(/[,_.]/g, '');
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractSampleCount(txt: string): number | null {
  const candidates: number[] = [];
  const regex =
    /(\d[\d,_.]*)(?:\s*(k))?\s*(?:financial\s+)?(documents|docs|records|items|rows|samples|examples|pairs|pair|tickets|conversations|transcripts)\b/gi;

  for (const match of txt.matchAll(regex)) {
    const raw = Number(match[1].replace(/[,_.]/g, ''));
    if (!Number.isFinite(raw)) continue;

    const start = Math.max(0, (match.index ?? 0) - 48);
    const end = Math.min(txt.length, (match.index ?? 0) + match[0].length + 48);
    const window = txt.slice(start, end);
    if (/(validation|eval(?:uation)?|test|holdout)/i.test(window)) continue;

    const scaled = match[2] ? raw * 1000 : raw;
    candidates.push(scaled);
  }

  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function normalizeMethod(raw: string): Parsed['method'] {
  const t = raw.toLowerCase();
  if (t.includes('qlora')) return 'QLoRA';
  if (t.includes('lora')) return 'LoRA';
  if (t.includes('full')) return 'FULL_FINETUNE';
  return null;
}

function parseTextWorkload(inputText: string): Parsed {
  const txt = inputText.trim();

  let modelFamily: string | null = null;
  if (/llama/i.test(txt)) modelFamily = 'LLaMA';
  else if (/mixtral/i.test(txt)) modelFamily = 'Mixtral';
  else if (/qwen/i.test(txt)) modelFamily = 'Qwen';
  else if (/mistral/i.test(txt)) modelFamily = 'Mistral';

  const extractedParamsB = extractNumber(/(\d+(?:\.\d+)?)\s*(?:b|bn)\b/i, txt);
  const hasTrainingSignal = /train|training|fine-?tune|qlora|lora|epoch|batch|deepspeed|zero stage|gradient/i.test(txt);
  const hasLlmSignal = /llm|transformers|vllm|qlora|lora|llama|qwen|mistral|mixtral/i.test(txt);
  const paramsEstimateAssumed = extractedParamsB == null && hasTrainingSignal && hasLlmSignal;
  const paramsB = extractedParamsB ?? (paramsEstimateAssumed ? 8 : null);
  const method = normalizeMethod(txt);

  const extractedSamples =
    extractSampleCount(txt) ??
    (() => {
      const short = txt.match(/\b(\d[\d,_.]*)\s*k\b/i);
      if (!short) return null;
      const raw = Number(short[1].replace(/[,_.]/g, ''));
      return Number.isFinite(raw) ? raw * 1000 : null;
    })();
  const sampleEstimateAssumed = extractedSamples == null && hasTrainingSignal;
  const samples = extractedSamples ?? (sampleEstimateAssumed ? DEFAULT_ASSUMED_TRAINING_SAMPLES : null);

  const tokensPerSample =
    extractNumber(/(?:average|avg)\s*sample\s*length[^\d]*(\d[\d,_.]*)\s*tokens?/i, txt) ??
    extractNumber(/(?:average|avg)\s*(?:sequence\s*length|seq(?:uence)?\s*length)[^\d]*(\d[\d,_.]*)\s*tokens?/i, txt) ??
    extractNumber(/(?:sequence\s*length|seq(?:uence)?\s*length)[^\d]*(\d[\d,_.]*)\s*tokens?/i, txt) ??
    1024;

  const contextLen =
    extractNumber(/(?:context(?:\s*length)?|ctx(?:\s*len)?)[^\d]*(\d[\d,_.]*)/i, txt) ??
    4096;

  const epochs = extractNumber(/epochs?[^\d]*(\d+(?:\.\d+)?)/i, txt) ?? 3;

  const microBatchPerGpu =
    extractNumber(/(?:batch(?:\s*size)?|micro-?batch)[^\d]*(\d[\d,_.]*)\s*(?:per\s*gpu|\/gpu|each gpu)/i, txt) ??
    extractNumber(/(?:batch(?:\s*size)?|micro-?batch)[^\d]*(\d[\d,_.]*)/i, txt) ??
    1;

  const effectiveBatchSize =
    extractNumber(/(?:effective|global|simulat(?:e|ed))\s*batch(?:\s*size)?[^\d]*(\d[\d,_.]*)/i, txt);

  const explicitGradientAccumulationSteps =
    extractNumber(/gradient accumulation(?:\s*steps?)?[^\d]*(\d[\d,_.]*)/i, txt);

  const loraRank = extractNumber(/lora\s*rank[^\d]*(\d[\d,_.]*)/i, txt);

  const zeroStage = extractNumber(/zero(?:\s*stage)?[^\d]*(\d)/i, txt);

  let precision: Parsed['precision'] = method === 'QLoRA' ? 'nf4' : 'bf16';
  if (/\bnf4\b|4-bit/i.test(txt)) precision = 'nf4';
  else if (/\bint8\b|8-bit/i.test(txt)) precision = 'int8';
  else if (/\bfp16\b/i.test(txt)) precision = 'fp16';
  else if (/\bbf16\b/i.test(txt)) precision = 'bf16';

  const distributedRequested = /multi-?gpu|distributed training|deepspeed|zero stage|fsdp|ddp/i.test(txt);

  let packingMode: Parsed['packingMode'] = 'UNSPECIFIED';
  if (/packing enabled|packed sequences|packing on|packing\s*[:=]\s*(on|enabled|true|yes)/i.test(txt)) packingMode = 'ENABLED';
  else if (/packing disabled|no packing|padding-heavy|packing\s*[:=]\s*(off|disabled|false|no)/i.test(txt)) packingMode = 'DISABLED';

  let gradientCheckpointing: boolean | null = null;
  if (/gradient checkpoint(?:ing)? enabled|checkpointing enabled|gradient checkpoint(?:ing)?\s*[:=]\s*(on|enabled|true|yes)/i.test(txt)) gradientCheckpointing = true;
  else if (/gradient checkpoint(?:ing)? disabled|checkpointing disabled|gradient checkpoint(?:ing)?\s*[:=]\s*(off|disabled|false|no)/i.test(txt)) gradientCheckpointing = false;

  const gradientAccumulationSteps =
    explicitGradientAccumulationSteps ??
    (effectiveBatchSize && microBatchPerGpu > 0
      ? Math.max(1, Math.round(effectiveBatchSize / microBatchPerGpu))
      : null);

  let confidence = 0;
  if (modelFamily) confidence += 0.2;
  if (extractedParamsB) confidence += 0.25;
  else if (paramsEstimateAssumed) confidence += 0.09;
  if (method) confidence += 0.2;
  if (extractedSamples) confidence += 0.1;
  else if (sampleEstimateAssumed) confidence += 0.03;
  if (tokensPerSample !== 1024) confidence += 0.08;
  if (contextLen !== 4096) confidence += 0.08;
  if (microBatchPerGpu !== 1) confidence += 0.04;
  if (distributedRequested) confidence += 0.05;

  return {
    modelFamily,
    paramsB,
    paramsEstimateAssumed,
    method,
    samples,
    sampleEstimateAssumed,
    tokensPerSample,
    contextLen,
    epochs,
    microBatchPerGpu,
    effectiveBatchSize,
    gradientAccumulationSteps,
    loraRank,
    precision,
    zeroStage,
    distributedRequested,
    packingMode,
    gradientCheckpointing,
    confidence,
  };
}

function parseWorkload(inputText: string, advanced?: z.infer<typeof advancedSchema> | null): Parsed {
  const inferred = parseTextWorkload(inputText);
  if (!advanced) return inferred;

  const paramsB = advanced.paramsB ?? inferred.paramsB;
  const paramsEstimateAssumed = advanced.paramsB != null ? false : inferred.paramsEstimateAssumed;
  const samples = advanced.samples ?? inferred.samples;
  const sampleEstimateAssumed = advanced.samples != null ? false : inferred.sampleEstimateAssumed;

  return {
    ...inferred,
    modelFamily: advanced.modelFamily ?? inferred.modelFamily,
    paramsB,
    paramsEstimateAssumed,
    method: advanced.method ?? inferred.method,
    samples,
    sampleEstimateAssumed,
    tokensPerSample: advanced.tokensPerSample ?? inferred.tokensPerSample,
    contextLen: advanced.contextLen ?? inferred.contextLen,
    epochs: advanced.epochs ?? inferred.epochs,
    microBatchPerGpu: advanced.batchSize ?? inferred.microBatchPerGpu,
    effectiveBatchSize: advanced.effectiveBatchSize ?? inferred.effectiveBatchSize,
    precision: advanced.precision ?? inferred.precision,
    packingMode: advanced.packingMode ?? inferred.packingMode,
    gradientCheckpointing: advanced.gradientCheckpointing ?? inferred.gradientCheckpointing,
    confidence: Math.max(inferred.confidence, 0.95),
  };
}

function bytesPerParam(precision: Parsed['precision']): number {
  switch (precision) {
    case 'bf16':
    case 'fp16':
      return 2;
    case 'int8':
      return 1.05;
    case 'nf4':
      return 0.56;
  }
}

function activationOverheadGb(contextLen: number, microBatchPerGpu: number): number {
  const ctx = contextLen <= 2048 ? 2048 : contextLen <= 4096 ? 4096 : contextLen <= 8192 ? 8192 : 16384;
  const b = microBatchPerGpu <= 1 ? 1 : microBatchPerGpu <= 2 ? 2 : microBatchPerGpu <= 4 ? 4 : 8;
  const key = `${ctx}:${b}`;
  const table: Record<string, number> = {
    '2048:1': 2,
    '2048:2': 3,
    '2048:4': 5,
    '2048:8': 8,
    '4096:1': 3,
    '4096:2': 5,
    '4096:4': 8,
    '4096:8': 12,
    '8192:1': 5,
    '8192:2': 8,
    '8192:4': 12,
    '8192:8': 18,
    '16384:1': 8,
    '16384:2': 12,
    '16384:4': 18,
    '16384:8': 26,
  };
  return table[key] ?? 8;
}

function modelActivationScale(paramsB: number): number {
  if (paramsB <= 8) return 1;
  if (paramsB <= 20) return 1.4;
  if (paramsB <= 40) return 1.8;
  if (paramsB <= 70) return 2.1;
  return 2.4;
}

function checkpointingFactor(parsed: Parsed): number {
  if (parsed.gradientCheckpointing === true) return 0.68;
  if (parsed.gradientCheckpointing === false) return 1;
  return parsed.paramsB && (parsed.paramsB >= 40 || parsed.contextLen >= 8192) ? 0.72 : 0.88;
}

function adapterOverheadGb(parsed: Parsed): number {
  if (!parsed.paramsB || !parsed.method) return 0;
  if (parsed.method === 'FULL_FINETUNE') return parsed.paramsB * 3.2;
  const rankFactor = (parsed.loraRank ?? 16) / 32;
  return Math.max(0.8, parsed.paramsB * 0.03 * rankFactor);
}

function miscBufferGb(paramsB: number): number {
  if (paramsB >= 40) return 4.5;
  if (paramsB >= 20) return 3.5;
  return 2.5;
}

function estimateSingleGpuVramGb(parsed: Parsed): number {
  if (!parsed.paramsB || !parsed.method) return 0;
  const weightGb = parsed.paramsB * bytesPerParam(parsed.precision);
  const activationGb =
    activationOverheadGb(parsed.contextLen, parsed.microBatchPerGpu) *
    modelActivationScale(parsed.paramsB) *
    checkpointingFactor(parsed);
  const methodFactor = parsed.method === 'FULL_FINETUNE' ? 1.18 : 1;
  const total =
    weightGb +
    adapterOverheadGb(parsed) +
    activationGb * methodFactor +
    miscBufferGb(parsed.paramsB);
  return round2(total * 1.08);
}

function estimatePerGpuVramGb(parsed: Parsed, numGpus: number): number {
  if (!parsed.paramsB || !parsed.method) return 0;
  const weightGb = parsed.paramsB * bytesPerParam(parsed.precision);
  const activationGb =
    activationOverheadGb(parsed.contextLen, parsed.microBatchPerGpu) *
    modelActivationScale(parsed.paramsB) *
    checkpointingFactor(parsed);
  const adapterGb = adapterOverheadGb(parsed);
  const miscGb = miscBufferGb(parsed.paramsB);

  if (numGpus <= 1 || !parsed.distributedRequested) {
    return estimateSingleGpuVramGb(parsed);
  }

  const shardedWeightsGb = weightGb * 1.05 / numGpus;
  const shardedAdapterGb = adapterGb * 0.55 / numGpus;
  const commBufferGb = 1.2 + 0.45 * numGpus;
  const perGpu = activationGb + miscGb + shardedWeightsGb + shardedAdapterGb + commBufferGb;
  return round2(perGpu * 1.06);
}

function feasibleGpuCounts(parsed: Parsed, gpuVramGb: number): number[] {
  const counts: number[] = [];
  for (let count = 1; count <= 8; count += 1) {
    const perGpuNeed = estimatePerGpuVramGb(parsed, count);
    if (gpuVramGb - perGpuNeed >= 0) counts.push(count);
  }
  return counts;
}

function fitRiskFromMargin(fitMarginGb: number): 'SAFE' | 'MODERATE' | 'TIGHT' | 'NO_FIT' {
  if (fitMarginGb < 0) return 'NO_FIT';
  if (fitMarginGb <= 0.5) return 'TIGHT';
  if (fitMarginGb <= 5) return 'MODERATE';
  return 'SAFE';
}

function tokenWindow(parsed: Parsed): {
  low: number;
  high: number;
  packingAssumption: string;
  lowLabel: string;
  highLabel: string;
} {
  const rawTokens = (parsed.samples ?? 0) * parsed.tokensPerSample * parsed.epochs;
  const paddedTokens = (parsed.samples ?? 0) * Math.max(parsed.contextLen, parsed.tokensPerSample) * parsed.epochs;

  if (parsed.packingMode === 'ENABLED') {
    return {
      low: rawTokens * 1.03,
      high: rawTokens * 1.12,
      packingAssumption: 'Packing enabled or near-packed batches assumed.',
      lowLabel: 'Expected',
      highLabel: 'Worst-case',
    };
  }

  if (parsed.packingMode === 'DISABLED') {
    return {
      low: paddedTokens,
      high: paddedTokens * 1.05,
      packingAssumption: 'Packing disabled; assumes padding-heavy 8k batches.',
      lowLabel: 'Expected',
      highLabel: 'Worst-case',
    };
  }

  return {
    low: rawTokens * 1.05,
    high: paddedTokens,
    packingAssumption: 'Packing was not specified, so the time range spans packed vs padding-heavy batching.',
    lowLabel: 'Expected (packed)',
    highLabel: 'Worst-case (padding-heavy)',
  };
}

function buildWorkloadAnalysis(parsed: Parsed): WorkloadAnalysis {
  const { low, high, packingAssumption } = tokenWindow(parsed);
  const warnings: string[] = [];

  if (parsed.distributedRequested) {
    warnings.push('Prompt explicitly asks for distributed training, so GPU counts below are cluster sizes rather than single-GPU plans.');
  }
  if (parsed.packingMode === 'UNSPECIFIED' && parsed.tokensPerSample < parsed.contextLen) {
    warnings.push('Packing was not specified. The time range widens because 2k-token documents can be packed efficiently into 8k context windows or padded inefficiently.');
  }
  if (parsed.paramsEstimateAssumed) {
    warnings.push('Model parameter size was not found in the prompt. Assuming an 8B-class model. Set Params (B) in Advanced fields to tighten this estimate.');
  }
  if (parsed.sampleEstimateAssumed) {
    warnings.push(`Training sample count was not found in the prompt. Assuming ${DEFAULT_ASSUMED_TRAINING_SAMPLES.toLocaleString()} samples. Set Samples in Advanced fields to tighten this estimate.`);
  }
  if (parsed.gradientCheckpointing == null && ((parsed.paramsB ?? 0) >= 40 || parsed.contextLen >= 8192)) {
    warnings.push('VRAM estimates assume gradient checkpointing is enabled for this long-context large-model run. Disabling it would increase memory pressure.');
  }

  return {
    estimatedSingleGpuVramGb: estimateSingleGpuVramGb(parsed),
    tokensLow: Math.round(low),
    tokensHigh: Math.round(high),
    packingAssumption,
    checkpointingAssumption:
      parsed.gradientCheckpointing === true
        ? 'Gradient checkpointing explicitly enabled.'
        : parsed.gradientCheckpointing === false
          ? 'Gradient checkpointing explicitly disabled.'
          : 'Gradient checkpointing assumed enabled for this model/context size.',
    warnings,
  };
}

function objectiveLabel(objective: RecommendationObjective): string {
  if (objective === 'LOWEST_COST') return 'Lowest cost';
  if (objective === 'FASTEST') return 'Fastest training';
  if (objective === 'SMALLEST_CLUSTER') return 'Smallest cluster';
  return 'Success rate';
}

function planLabel(variant: Recommendation['variant']): string {
  if (variant === 'BEST_FIT') return 'Best fit';
  if (variant === 'MINIMUM_GPUS') return 'Minimum GPUs';
  if (variant === 'LOWEST_COST') return 'Lowest cost';
  return 'Fastest training';
}

function displayPlanLabel(
  variant: Recommendation['variant'],
  fitRisk: Recommendation['fitRisk'],
): string {
  if (variant === 'BEST_FIT' && fitRisk !== 'SAFE') return 'Recommended plan';
  return planLabel(variant);
}

function objectiveVariantOrder(
  objective: RecommendationObjective,
): Array<Recommendation['variant']> {
  if (objective === 'LOWEST_COST') {
    return ['LOWEST_COST', 'BEST_FIT', 'FASTEST', 'MINIMUM_GPUS'];
  }
  if (objective === 'FASTEST') {
    return ['FASTEST', 'BEST_FIT', 'LOWEST_COST', 'MINIMUM_GPUS'];
  }
  if (objective === 'SMALLEST_CLUSTER') {
    return ['MINIMUM_GPUS', 'BEST_FIT', 'LOWEST_COST', 'FASTEST'];
  }
  return ['BEST_FIT', 'LOWEST_COST', 'FASTEST', 'MINIMUM_GPUS'];
}

function objectiveAllowedRisks(
  objective: RecommendationObjective,
): Array<Recommendation['fitRisk']> {
  if (objective === 'SUCCESS_RATE') return ['SAFE'];
  if (objective === 'LOWEST_COST' || objective === 'FASTEST' || objective === 'SMALLEST_CLUSTER') {
    return ['SAFE', 'MODERATE'];
  }
  return ['SAFE', 'MODERATE'];
}

function candidateGpuCounts(
  gpuType: SupportedCustomerGpuKey,
  distributedRequested: boolean,
): number[] {
  if (!distributedRequested) {
    return gpuType === 'A100_80GB' ? [1, 2, 4, 6, 8] : [1, 2, 4, 6, 8];
  }

  return gpuType === 'A100_80GB' ? [1, 2, 4, 6, 8] : [1, 4, 6, 8];
}

function objectiveWeights(objective: RecommendationObjective): ObjectiveWeights {
  if (objective === 'LOWEST_COST') {
    return { risk: 1.6, cost: 4.5, time: 1.2, cluster: 0.8, distributedMismatch: 0.4 };
  }
  if (objective === 'FASTEST') {
    return { risk: 1.6, cost: 1.2, time: 4.5, cluster: 0.8, distributedMismatch: 0.4 };
  }
  if (objective === 'SMALLEST_CLUSTER') {
    return { risk: 1.6, cost: 1, time: 1, cluster: 5, distributedMismatch: 0.4 };
  }
  return { risk: 4.5, cost: 1.5, time: 1.4, cluster: 0.8, distributedMismatch: 3.5 };
}

function scoreRecommendation(params: {
  objective: RecommendationObjective;
  fitRisk: 'SAFE' | 'MODERATE' | 'TIGHT' | 'NO_FIT';
  normalizedCost: number;
  normalizedTime: number;
  normalizedCluster: number;
  gpuCount: number;
  warmCount: number;
  distributedRequested: boolean;
  promptIntentMatch: boolean;
}): ScoreBreakdown {
  const weights = objectiveWeights(params.objective);
  const riskComponent =
    params.fitRisk === 'NO_FIT' ? 10 : params.fitRisk === 'TIGHT' ? 8.5 : params.fitRisk === 'MODERATE' ? 4 : 0.5;
  const costComponent = params.normalizedCost;
  const timeComponent = params.normalizedTime;
  const clusterComponent = params.normalizedCluster;
  const intentMismatchComponent =
    params.distributedRequested && !params.promptIntentMatch ? 10 : 0;
  const weightedRisk = riskComponent * weights.risk;
  const weightedCost = costComponent * weights.cost;
  const weightedTime = timeComponent * weights.time;
  const weightedCluster = clusterComponent * weights.cluster;
  const weightedIntentMismatch = intentMismatchComponent * weights.distributedMismatch;
  const distributedPenalty = weightedIntentMismatch;
  const weightedTotal =
    weightedRisk +
    weightedCost +
    weightedTime +
    weightedCluster +
    distributedPenalty -
    (params.warmCount > 0 ? 0.3 : 0);
  const totalWeight =
    weights.risk +
    weights.cost +
    weights.time +
    weights.cluster +
    (params.distributedRequested ? weights.distributedMismatch : 0);
  const total = round2(Math.max(0, Math.min(10, weightedTotal / Math.max(1, totalWeight))));

  return {
    objective: params.objective,
    weights,
    riskComponent: round2(riskComponent),
    costComponent: round2(costComponent),
    timeComponent: round2(timeComponent),
    clusterComponent: round2(clusterComponent),
    intentMismatchComponent: round2(intentMismatchComponent),
    weightedRisk: round2(weightedRisk),
    weightedCost: round2(weightedCost),
    weightedTime: round2(weightedTime),
    weightedCluster: round2(weightedCluster),
    weightedIntentMismatch: round2(weightedIntentMismatch),
    distributedPenalty: round2(distributedPenalty),
    total,
  };
}

function reasonSummary(params: {
  displayName: string;
  variantLabel: string;
  gpuCount: number;
  fitRisk: 'SAFE' | 'MODERATE' | 'TIGHT' | 'NO_FIT';
  fitMarginGb: number;
  distributedRequested: boolean;
  scoreBreakdown: ScoreBreakdown;
  scalingEfficiency: number;
  cheaperThanOther: boolean;
  fasterThanOther: boolean;
}): string {
  if (params.distributedRequested && params.gpuCount === 1 && params.fitRisk === 'SAFE') {
    return `${params.displayName} (${params.variantLabel}) fits on a single GPU with safe headroom, but it deviates from the distributed-training plan requested in the prompt.`;
  }
  if (params.fitRisk === 'SAFE' && params.distributedRequested && params.gpuCount <= 2) {
    return `${params.displayName} (${params.variantLabel}) is the cleanest fit for this distributed workload: strong per-GPU headroom, ${params.gpuCount} GPU${params.gpuCount === 1 ? '' : 's'}, and ${Math.round(params.scalingEfficiency * 100)}% scaling efficiency.`;
  }
  if (params.fitRisk === 'SAFE' && params.fasterThanOther) {
    return `${params.displayName} (${params.variantLabel}) combines safe fit margin with the strongest expected throughput for this ranking objective.`;
  }
  if (params.fitRisk === 'MODERATE' && params.cheaperThanOther) {
    return `${params.displayName} (${params.variantLabel}) is the lower-cost option, but it needs a larger cluster and only moderate memory headroom (${round2(params.fitMarginGb)} GB).`;
  }
  if (params.fitRisk === 'TIGHT') {
    return `${params.displayName} (${params.variantLabel}) is a tight memory fit (${round2(params.fitMarginGb)} GB headroom) and carries higher OOM risk for a 70B long-context run.`;
  }
  if (params.fitRisk === 'NO_FIT') {
    return `${params.displayName} (${params.variantLabel}) does not fit this workload cleanly within the supported cluster size limit.`;
  }
  return `${params.displayName} (${params.variantLabel}) will run this workload; score drivers are normalized risk ${params.scoreBreakdown.riskComponent}/10, cost ${params.scoreBreakdown.costComponent}/10, time ${params.scoreBreakdown.timeComponent}/10, and cluster size ${params.scoreBreakdown.clusterComponent}/10.`;
}

function finalVariantLabel(params: {
  objective: RecommendationObjective;
  rank: number;
  fitRisk: Recommendation['fitRisk'];
  promptIntentMatch: boolean;
  isCheapest: boolean;
  isFastest: boolean;
  variant: Recommendation['variant'];
}): string {
  if (!params.promptIntentMatch) {
    return 'Single-GPU fallback';
  }

  if (params.rank === 1) {
    if (params.objective === 'SUCCESS_RATE') return 'Recommended plan';
    if (params.objective === 'LOWEST_COST') return 'Lowest-cost plan';
    if (params.objective === 'FASTEST') return 'Fastest plan';
    return 'Smallest-cluster plan';
  }

  if (params.objective === 'SUCCESS_RATE') {
    if (params.isCheapest) return 'Lower-cost alternative';
    if (params.isFastest) return 'Faster alternative';
    if (params.fitRisk === 'SAFE') return 'Safer alternative';
    return 'Alternative plan';
  }

  if (params.objective === 'LOWEST_COST') {
    if (params.fitRisk === 'SAFE') return 'Safer alternative';
    if (params.isFastest) return 'Faster alternative';
    if (params.variant === 'MINIMUM_GPUS') return 'Smaller-cluster alternative';
    return 'Alternative plan';
  }

  if (params.objective === 'FASTEST') {
    if (params.isCheapest) return 'Lower-cost alternative';
    if (params.fitRisk === 'SAFE') return 'Safer alternative';
    if (params.variant === 'MINIMUM_GPUS') return 'Smaller-cluster alternative';
    return 'Alternative plan';
  }

  if (params.isCheapest) return 'Lower-cost alternative';
  if (params.fitRisk === 'SAFE') return 'Safer alternative';
  if (params.isFastest) return 'Faster alternative';
  return 'Alternative plan';
}

export const recommendRoutes: FastifyPluginAsync = async (fastify: FastifyInstance) => {
  fastify.post('/workload', async (request: any, reply: any) => {
    const start = Date.now();
    const body = requestSchema.safeParse(request.body);
    if (!body.success) {
      request.log.warn({ validation: body.error.flatten() }, 'recommend validation failed');
      return reply.status(400).send({ error: 'Invalid request.' });
    }

    const parsed = parseWorkload(body.data.inputText, body.data.advanced ?? null);
    const analysis = buildWorkloadAnalysis(parsed);

    const hasMinimumEstimationInputs = Boolean(parsed.paramsB && parsed.method && parsed.samples);
    if (parsed.confidence < 0.55 && !body.data.advanced && !hasMinimumEstimationInputs) {
      const saved = await prisma.workloadRecommendationRequest.create({
        data: {
          userId: null,
          inputText: body.data.inputText,
          parsedJson: JSON.stringify(parsed),
          recommendationsJson: JSON.stringify([]),
          latencyMs: Date.now() - start,
          errorCode: 'PARSE_LOW_CONFIDENCE',
        },
      });
      return reply.send({ requestId: saved.id, parsed, analysis, recommendations: [] });
    }

    if (!parsed.paramsB || !parsed.method || !parsed.samples) {
      const saved = await prisma.workloadRecommendationRequest.create({
        data: {
          userId: null,
          inputText: body.data.inputText,
          parsedJson: JSON.stringify(parsed),
          recommendationsJson: JSON.stringify([]),
          latencyMs: Date.now() - start,
          errorCode: 'PARSE_INCOMPLETE',
        },
      });
      return reply.send({ requestId: saved.id, parsed, analysis, recommendations: [] });
    }

    const objective: RecommendationObjective = body.data.objective ?? 'SUCCESS_RATE';
    const paramsB = parsed.paramsB!;
    const dbSkus = await prisma.gpuSku.findMany({
      where: {
        enabled: true,
        key: { in: [...SUPPORTED_CUSTOMER_GPU_KEYS] },
      },
    });
    const dbSkuMap = new Map(dbSkus.map((sku) => [sku.key, sku]));
    const tokenRange = tokenWindow(parsed);
    const methodKey = parsed.method === 'FULL_FINETUNE' ? 'FULL' : parsed.method;
    const maxGpus = body.data.advanced?.maxGpus;
    const maxTotalBudgetUsd = body.data.advanced?.maxTotalBudgetUsd;
    const podTemplateName =
      parsed.method === 'QLoRA' ? 'llm-qlora-pytorch' :
      parsed.method === 'LoRA' ? 'llm-lora-pytorch' :
      'llm-fullfinetune-pytorch';
    const recs: Array<Omit<Recommendation, 'rank' | 'reason' | 'scoreBreakdown'> & { displayName: string }> = [];
    for (const key of SUPPORTED_CUSTOMER_GPU_KEYS) {
      const dbSku = dbSkuMap.get(key);
      const fallback = SUPPORTED_CUSTOMER_GPU_DEFAULTS[key];
      const sku = {
        key,
        displayName: fallback.customerDisplayName,
        vramGb: dbSku?.vramGb ?? fallback.vramGb,
        pricePerHourCents: dbSku?.pricePerHourCents ?? fallback.pricePerHourCents,
      };

      const warmCount = await prisma.workspace.count({
        where: {
          status: 'WARM_AVAILABLE',
          verificationStatus: 'PASS',
          assignedUserId: null,
          isWarmPool: true,
          gpuType: sku.key,
        },
      });

      const countsToEvaluate = candidateGpuCounts(sku.key, parsed.distributedRequested);
      const rawCandidatePlans = countsToEvaluate.map((gpuCount) => {
        const perGpuVramGb = estimatePerGpuVramGb(parsed, gpuCount);
        const fitMarginGb = round2(sku.vramGb - perGpuVramGb);
        const fitRisk = fitRiskFromMargin(fitMarginGb);
        const perGpuTps = getTrainingTokensPerSecondPerGpu(sku.key, paramsB, methodKey, parsed.contextLen);
        const scalingEfficiency = getScalingEfficiency(sku.key, gpuCount, parsed.zeroStage);
        const clusterTps = round2(perGpuTps * gpuCount * scalingEfficiency);
        const timeHoursLow = Math.max(0.1, tokenRange.low / Math.max(1, clusterTps) / 3600);
        const timeHoursHigh = Math.max(0.1, tokenRange.high / Math.max(1, clusterTps) / 3600);
        const hourlyUsd = sku.pricePerHourCents / 100;
        const clusterHourlyUsd = round2(hourlyUsd * gpuCount);
        const costUsdLow = round2(timeHoursLow * clusterHourlyUsd);
        const costUsdHigh = round2(timeHoursHigh * clusterHourlyUsd);

        return {
          gpuCount,
          perGpuVramGb,
          fitMarginGb,
          fitRisk,
          perGpuTps,
          scalingEfficiency,
          clusterTps,
          timeHoursLow: round2(timeHoursLow),
          timeHoursHigh: round2(timeHoursHigh),
          costUsdLow,
          costUsdHigh,
          clusterHourlyUsd,
          hourlyUsd,
        };
      });

      const candidatePlans = rawCandidatePlans.filter((plan) => {
        if (plan.fitRisk === 'NO_FIT') return false;
        if (maxGpus && plan.gpuCount > maxGpus) return false;
        if (maxTotalBudgetUsd && plan.costUsdLow > maxTotalBudgetUsd) return false;
        return true;
      });

      if (candidatePlans.length === 0) continue;

      for (const plan of candidatePlans) {
        const midCost = (plan.costUsdLow + plan.costUsdHigh) / 2;
        const midTime = (plan.timeHoursLow + plan.timeHoursHigh) / 2;
        const isMinGpu = plan.gpuCount === Math.min(...candidatePlans.map((candidate) => candidate.gpuCount));
        const isLowestCost = midCost === Math.min(...candidatePlans.map((candidate) => (candidate.costUsdLow + candidate.costUsdHigh) / 2));
        const isFastest = midTime === Math.min(...candidatePlans.map((candidate) => (candidate.timeHoursLow + candidate.timeHoursHigh) / 2));
        const hasBestFit = plan.fitRisk === 'SAFE' && plan.fitMarginGb === Math.max(...candidatePlans.filter((candidate) => candidate.fitRisk === 'SAFE').map((candidate) => candidate.fitMarginGb), -Infinity);
        const variant: Recommendation['variant'] =
          isMinGpu ? 'MINIMUM_GPUS' :
          isLowestCost ? 'LOWEST_COST' :
          isFastest ? 'FASTEST' :
          hasBestFit ? 'BEST_FIT' :
          'BEST_FIT';

        recs.push({
          gpuType: sku.key,
          displayName: sku.displayName,
          variant,
          variantLabel: displayPlanLabel(variant, plan.fitRisk),
          objective,
          promptIntentMatch: !parsed.distributedRequested || plan.gpuCount > 1,
          vramGb: analysis.estimatedSingleGpuVramGb,
          perGpuVramGb: plan.perGpuVramGb,
          fitMarginGb: plan.fitMarginGb,
          fitRisk: plan.fitRisk,
          gpuCount: plan.gpuCount,
          timeHoursLow: plan.timeHoursLow,
          timeHoursHigh: plan.timeHoursHigh,
          costUsdLow: plan.costUsdLow,
          costUsdHigh: plan.costUsdHigh,
          clusterHourlyUsd: plan.clusterHourlyUsd,
          podTemplateId: podTemplateName,
          podTemplateName,
          launchable: plan.gpuCount === 1,
          assumptions: {
            tokensPerSecondPerGpu: plan.perGpuTps,
            clusterTokensPerSecond: plan.clusterTps,
            scalingEfficiency: plan.scalingEfficiency,
            totalTokensLow: Math.round(tokenRange.low),
            totalTokensHigh: Math.round(tokenRange.high),
            safetyMargin: 1.08,
            method: methodKey.toLowerCase(),
            warmCount,
            hourlyRateUsd: plan.hourlyUsd,
            packingMode: parsed.packingMode,
            packingAssumption: tokenRange.packingAssumption,
            checkpointingAssumption: analysis.checkpointingAssumption,
            distributedRequested: parsed.distributedRequested,
            rangeLowLabel: tokenRange.lowLabel,
            rangeHighLabel: tokenRange.highLabel,
          },
        });
      }
    }

    if (recs.length === 0) {
      const saved = await prisma.workloadRecommendationRequest.create({
        data: {
          userId: null,
          inputText: body.data.inputText,
          parsedJson: JSON.stringify(parsed),
          recommendationsJson: JSON.stringify([]),
          latencyMs: Date.now() - start,
          errorCode: 'NO_SUPPORTED_PLAN',
        },
      });
      return reply.send({ requestId: saved.id, parsed, analysis, recommendations: [] });
    }

    const costMids = recs.map((rec) => (rec.costUsdLow + rec.costUsdHigh) / 2);
    const timeMids = recs.map((rec) => (rec.timeHoursLow + rec.timeHoursHigh) / 2);
    const clusterCounts = recs.map((rec) => rec.gpuCount);
    const cheapestMid = Math.min(...costMids);
    const priciestMid = Math.max(...costMids);
    const fastestMid = Math.min(...timeMids);
    const slowestMid = Math.max(...timeMids);
    const smallestCluster = Math.min(...clusterCounts);
    const largestCluster = Math.max(...clusterCounts);
    const allowedRisks = new Set(objectiveAllowedRisks(objective));

    const scored = recs
      .map((rec) => {
        const costMid = (rec.costUsdLow + rec.costUsdHigh) / 2;
        const timeMid = (rec.timeHoursLow + rec.timeHoursHigh) / 2;
        const normalizedCost =
          priciestMid === cheapestMid ? 0 : ((costMid - cheapestMid) / (priciestMid - cheapestMid)) * 10;
        const normalizedTime =
          slowestMid === fastestMid ? 0 : ((timeMid - fastestMid) / (slowestMid - fastestMid)) * 10;
        const normalizedCluster =
          largestCluster === smallestCluster ? 0 : ((rec.gpuCount - smallestCluster) / (largestCluster - smallestCluster)) * 10;
        const scoreBreakdown = scoreRecommendation({
          objective,
          fitRisk: rec.fitRisk,
          normalizedCost,
          normalizedTime,
          normalizedCluster,
          gpuCount: rec.gpuCount,
          warmCount: rec.assumptions.warmCount ?? 0,
          distributedRequested: parsed.distributedRequested,
          promptIntentMatch: rec.promptIntentMatch,
        });

        return {
          ...rec,
          scoreBreakdown,
          reason: reasonSummary({
            displayName: rec.displayName,
            variantLabel: rec.variantLabel,
            gpuCount: rec.gpuCount,
            fitRisk: rec.fitRisk,
            fitMarginGb: rec.fitMarginGb,
            distributedRequested: parsed.distributedRequested,
            scoreBreakdown,
            scalingEfficiency: rec.assumptions.scalingEfficiency,
            cheaperThanOther: costMid === cheapestMid,
            fasterThanOther: timeMid === fastestMid,
          }),
          _score: scoreBreakdown.total,
        };
      })
      .sort((a: any, b: any) => a._score - b._score);

    const filtered = body.data.showRisky
      ? scored
      : scored.filter((rec: any) => allowedRisks.has(rec.fitRisk));

    const rankingPool = (filtered.length > 0 ? filtered : scored).filter(
      (rec: any) => rec.promptIntentMatch || !parsed.distributedRequested,
    );
    const fallbackPool = (filtered.length > 0 ? filtered : scored).filter(
      (rec: any) => parsed.distributedRequested && !rec.promptIntentMatch,
    );

    const ranked = rankingPool.map((rec: any, index: number) => {
      const costMid = (rec.costUsdLow + rec.costUsdHigh) / 2;
      const timeMid = (rec.timeHoursLow + rec.timeHoursHigh) / 2;
      const finalLabel = finalVariantLabel({
        objective,
        rank: index + 1,
        fitRisk: rec.fitRisk,
        promptIntentMatch: rec.promptIntentMatch,
        isCheapest: Math.abs(costMid - cheapestMid) < 0.01,
        isFastest: Math.abs(timeMid - fastestMid) < 0.01,
        variant: rec.variant,
      });
      const scoreBreakdown = rec.scoreBreakdown;
      const reason = reasonSummary({
        displayName: rec.displayName,
        variantLabel: finalLabel,
        gpuCount: rec.gpuCount,
        fitRisk: rec.fitRisk,
        fitMarginGb: rec.fitMarginGb,
        distributedRequested: parsed.distributedRequested,
        scoreBreakdown,
        scalingEfficiency: rec.assumptions.scalingEfficiency,
        cheaperThanOther: Math.abs(costMid - cheapestMid) < 0.01,
        fasterThanOther: Math.abs(timeMid - fastestMid) < 0.01,
      });

      const { _score, displayName, ...rest } = rec;
      return {
        ...rest,
        variantLabel: finalLabel,
        reason,
        rank: index + 1,
      };
    });

    const fallbacks = fallbackPool.map((rec: any) => {
      const { _score, displayName, ...rest } = rec;
      return {
        ...rest,
        variantLabel: 'Single-GPU fallback',
        reason: `${displayName} fits on one GPU, but it does not match the distributed plan requested in the prompt.`,
        rank: null,
        scoreBreakdown: null,
      };
    });

    const saved = await prisma.workloadRecommendationRequest.create({
      data: {
        userId: null,
        inputText: body.data.inputText,
        parsedJson: JSON.stringify(parsed),
        recommendationsJson: JSON.stringify([...ranked, ...fallbacks]),
        latencyMs: Date.now() - start,
        errorCode: null,
      },
    });

    return reply.send({
      requestId: saved.id,
      parsed,
      analysis,
      recommendations: [...ranked, ...fallbacks],
    });
  });
};

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
