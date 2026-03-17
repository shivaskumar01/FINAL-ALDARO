import Anthropic from '@anthropic-ai/sdk';

/**
 * LLM-based workload parameter extractor.
 *
 * Sends the user's free-text workload description to Claude Haiku
 * and extracts structured training parameters. Falls back to null
 * on any failure so the caller can use the regex parser instead.
 *
 * The scoring math remains 100% deterministic — only parameter
 * extraction uses the LLM.
 */

type LlmParsedParams = {
  modelFamily: string | null;
  paramsB: number | null;
  method: 'LoRA' | 'QLoRA' | 'FULL_FINETUNE' | null;
  samples: number | null;
  tokensPerSample: number | null;
  epochs: number | null;
  contextLen: number | null;
  batchSize: number | null;
  effectiveBatchSize: number | null;
  precision: 'bf16' | 'fp16' | 'int8' | 'nf4' | null;
  packingMode: 'ENABLED' | 'DISABLED' | null;
  gradientCheckpointing: boolean | null;
  distributedRequested: boolean;
  loraRank: number | null;
  zeroStage: number | null;
};

const SYSTEM_PROMPT = `You are a workload parameter extractor for a GPU rental platform. Given a user's free-text description of their ML training workload, extract structured parameters.

Return ONLY a JSON object with these fields (use null for any field you cannot confidently determine):

{
  "modelFamily": string | null,       // e.g. "LLaMA", "Mistral", "Mixtral", "Qwen", "GPT", "BERT", etc.
  "paramsB": number | null,           // model size in billions of parameters (e.g. 7, 13, 70)
  "method": string | null,            // one of: "LoRA", "QLoRA", "FULL_FINETUNE"
  "samples": number | null,           // number of training samples/examples
  "tokensPerSample": number | null,   // average tokens per sample
  "epochs": number | null,            // number of training epochs
  "contextLen": number | null,        // context/sequence length in tokens
  "batchSize": number | null,         // micro batch size per GPU
  "effectiveBatchSize": number | null, // global/effective batch size
  "precision": string | null,         // one of: "bf16", "fp16", "int8", "nf4"
  "packingMode": string | null,       // one of: "ENABLED", "DISABLED"
  "gradientCheckpointing": boolean | null,
  "distributedRequested": boolean,    // true if user mentions multi-gpu, distributed, deepspeed, fsdp, ddp
  "loraRank": number | null,          // LoRA rank if mentioned
  "zeroStage": number | null          // DeepSpeed ZeRO stage if mentioned
}

Rules:
- Only extract values explicitly stated or strongly implied. Do not guess.
- For "samples": look for dataset sizes, number of examples/documents/records/rows/conversations.
- For "method": if they mention "qlora" -> "QLoRA", "lora" -> "LoRA", "full fine-tune/finetune" -> "FULL_FINETUNE".
- For "precision": "4-bit" or "nf4" -> "nf4", "8-bit" or "int8" -> "int8", "fp16" -> "fp16", "bf16" -> "bf16". QLoRA implies "nf4" unless stated otherwise.
- "distributedRequested" should be true if user mentions multi-gpu, distributed training, deepspeed, zero stage, fsdp, ddp, or requests multiple GPUs.
- Return ONLY the JSON object, no markdown, no explanation.`;

let client: Anthropic | null = null;

function getClient(): Anthropic | null {
  if (client) return client;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  client = new Anthropic({ apiKey });
  return client;
}

export async function llmParseWorkload(
  inputText: string,
): Promise<{ params: LlmParsedParams; latencyMs: number } | null> {
  const anthropic = getClient();
  if (!anthropic) return null;

  const start = Date.now();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await anthropic.messages.create(
      {
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: inputText.slice(0, 3000),
          },
        ],
      },
      { signal: controller.signal },
    );

    clearTimeout(timeout);

    const text =
      response.content[0]?.type === 'text' ? response.content[0].text : null;
    if (!text) return null;

    // Strip markdown fences if present
    const cleaned = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();

    const raw = JSON.parse(cleaned);
    const latencyMs = Date.now() - start;

    const params: LlmParsedParams = {
      modelFamily: typeof raw.modelFamily === 'string' ? raw.modelFamily : null,
      paramsB: typeof raw.paramsB === 'number' && raw.paramsB > 0 ? raw.paramsB : null,
      method: ['LoRA', 'QLoRA', 'FULL_FINETUNE'].includes(raw.method) ? raw.method : null,
      samples: typeof raw.samples === 'number' && raw.samples > 0 ? raw.samples : null,
      tokensPerSample:
        typeof raw.tokensPerSample === 'number' && raw.tokensPerSample > 0
          ? raw.tokensPerSample
          : null,
      epochs: typeof raw.epochs === 'number' && raw.epochs > 0 ? raw.epochs : null,
      contextLen:
        typeof raw.contextLen === 'number' && raw.contextLen > 0 ? raw.contextLen : null,
      batchSize:
        typeof raw.batchSize === 'number' && raw.batchSize > 0 ? raw.batchSize : null,
      effectiveBatchSize:
        typeof raw.effectiveBatchSize === 'number' && raw.effectiveBatchSize > 0
          ? raw.effectiveBatchSize
          : null,
      precision: ['bf16', 'fp16', 'int8', 'nf4'].includes(raw.precision)
        ? raw.precision
        : null,
      packingMode: ['ENABLED', 'DISABLED'].includes(raw.packingMode)
        ? raw.packingMode
        : null,
      gradientCheckpointing:
        typeof raw.gradientCheckpointing === 'boolean'
          ? raw.gradientCheckpointing
          : null,
      distributedRequested: raw.distributedRequested === true,
      loraRank:
        typeof raw.loraRank === 'number' && raw.loraRank > 0 ? raw.loraRank : null,
      zeroStage:
        typeof raw.zeroStage === 'number' && raw.zeroStage >= 0 ? raw.zeroStage : null,
    };

    return { params, latencyMs };
  } catch (err: any) {
    const latencyMs = Date.now() - start;
    console.warn(`[LlmParser] Failed in ${latencyMs}ms:`, err.message || err);
    return null;
  }
}
