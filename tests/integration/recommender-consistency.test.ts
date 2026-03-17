import { expect } from 'chai';
import request from 'supertest';
import { app } from '../../apps/api/src/index';
import { SUPPORTED_CUSTOMER_GPU_DEFAULTS } from '../../apps/api/src/lib/supportedGpus';

describe('Recommender consistency', () => {
  before(async () => {
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  it('keeps hardware specs aligned with the supported fleet', () => {
    expect(SUPPORTED_CUSTOMER_GPU_DEFAULTS.RTX_5090.vramGb).to.equal(32);
    expect(SUPPORTED_CUSTOMER_GPU_DEFAULTS.A100_80GB.vramGb).to.equal(80);
    expect(SUPPORTED_CUSTOMER_GPU_DEFAULTS.RTX_5090.pricePerHourCents).to.equal(55);
    expect(SUPPORTED_CUSTOMER_GPU_DEFAULTS.A100_80GB.pricePerHourCents).to.equal(249);
  });

  it('returns internally consistent cluster throughput for long-context 70B QLoRA', async () => {
    const prompt = [
      'Fine-tune LLaMA 3 70B using QLoRA for a financial analysis assistant.',
      'Dataset: 350,000 financial documents, earnings transcripts, and analyst reports.',
      'Average sequence length: 2,000 tokens.',
      'Method: QLoRA 4-bit base model.',
      'LoRA rank: 32.',
      'Context length: 8,192 tokens.',
      'Batch size: 2 per GPU with gradient accumulation to simulate batch size 32.',
      'Epochs: 2.',
      'Multi-GPU distributed training using DeepSpeed ZeRO Stage 3.',
      'Mixed precision training (bf16).',
    ].join(' ');

    const res = await request(app.server)
      .post('/api/recommend/workload')
      .send({ inputText: prompt, objective: 'SUCCESS_RATE' });

    expect(res.status).to.equal(200);
    expect(res.body.parsed.samples).to.equal(350000);
    expect(res.body.recommendations).to.have.length.greaterThan(0);
    expect(res.body.recommendations.every((rec: any) => ['RTX_5090', 'A100_80GB'].includes(rec.gpuType))).to.equal(true);

    for (const rec of res.body.recommendations) {
      const expected =
        rec.assumptions.tokensPerSecondPerGpu * rec.gpuCount * rec.assumptions.scalingEfficiency;
      expect(rec.assumptions.clusterTokensPerSecond).to.be.closeTo(expected, 0.02 * expected + 0.5);
      const gpuVram = SUPPORTED_CUSTOMER_GPU_DEFAULTS[rec.gpuType as 'RTX_5090' | 'A100_80GB'].vramGb;
      expect(rec.fitMarginGb).to.be.closeTo(gpuVram - rec.perGpuVramGb, 0.05);
    }
  });

  it('keeps success-rate mode on safe plans by default and labels the top pick accordingly', async () => {
    const prompt = [
      'Fine-tune LLaMA 3 70B using QLoRA for a financial analysis assistant.',
      'Dataset: 350,000 financial documents, earnings transcripts, and analyst reports.',
      'Average sequence length: 2,000 tokens.',
      'Method: QLoRA 4-bit base model.',
      'LoRA rank: 32.',
      'Context length: 8,192 tokens.',
      'Batch size: 2 per GPU with gradient accumulation to simulate batch size 32.',
      'Epochs: 2.',
      'Multi-GPU distributed training using DeepSpeed ZeRO Stage 3.',
      'Mixed precision training (bf16).',
    ].join(' ');

    const res = await request(app.server)
      .post('/api/recommend/workload')
      .send({ inputText: prompt, objective: 'SUCCESS_RATE' });

    expect(res.status).to.equal(200);
    expect(res.body.recommendations).to.have.length.greaterThan(0);
    expect(res.body.recommendations.every((rec: any) => rec.fitRisk === 'SAFE')).to.equal(true);
    expect(res.body.recommendations[0].variantLabel).to.equal('Recommended plan');
    expect(res.body.recommendations[0].promptIntentMatch).to.equal(true);
    const fallbacks = res.body.recommendations.filter((rec: any) => !rec.promptIntentMatch);
    expect(fallbacks.every((rec: any) => rec.rank === null && rec.scoreBreakdown === null)).to.equal(true);
  });

  it('changes the top pick when the ranking objective changes', async () => {
    const prompt = [
      'Fine-tune LLaMA 3 70B using QLoRA for a financial analysis assistant.',
      'Dataset: 350,000 financial documents, earnings transcripts, and analyst reports.',
      'Average sequence length: 2,000 tokens.',
      'Method: QLoRA 4-bit base model.',
      'LoRA rank: 32.',
      'Context length: 8,192 tokens.',
      'Batch size: 2 per GPU with gradient accumulation to simulate batch size 32.',
      'Epochs: 2.',
      'Multi-GPU distributed training using DeepSpeed ZeRO Stage 3.',
      'Mixed precision training (bf16).',
    ].join(' ');

    const lowestCost = await request(app.server)
      .post('/api/recommend/workload')
      .send({ inputText: prompt, objective: 'LOWEST_COST' });

    const smallestCluster = await request(app.server)
      .post('/api/recommend/workload')
      .send({ inputText: prompt, objective: 'SMALLEST_CLUSTER' });

    expect(lowestCost.status).to.equal(200);
    expect(smallestCluster.status).to.equal(200);
    expect(lowestCost.body.recommendations[0].scoreBreakdown.objective).to.equal('LOWEST_COST');
    expect(smallestCluster.body.recommendations[0].scoreBreakdown.objective).to.equal('SMALLEST_CLUSTER');
    expect(lowestCost.body.recommendations[0].variantLabel).to.equal('Lowest-cost plan');

    const lowestCostTop = lowestCost.body.recommendations[0];
    const smallestClusterTop = smallestCluster.body.recommendations[0];

    const lowestCostTopMid =
      (lowestCostTop.costUsdLow + lowestCostTop.costUsdHigh) / 2;
    const allLowestCostMids = lowestCost.body.recommendations.map(
      (rec: any) => (rec.costUsdLow + rec.costUsdHigh) / 2,
    );
    expect(lowestCostTopMid).to.equal(Math.min(...allLowestCostMids));

    const rankEligibleClusterSizes = smallestCluster.body.recommendations
      .filter((rec: any) => rec.promptIntentMatch)
      .map((rec: any) => rec.gpuCount);
    expect(smallestClusterTop.gpuCount).to.equal(Math.min(...rankEligibleClusterSizes));
  });

  it('respects max GPU and max budget constraints from advanced fields', async () => {
    const prompt = [
      'Fine-tune LLaMA 3 70B using QLoRA for a financial analysis assistant.',
      'Dataset: 350,000 financial documents, earnings transcripts, and analyst reports.',
      'Average sequence length: 2,000 tokens.',
      'Method: QLoRA 4-bit base model.',
      'LoRA rank: 32.',
      'Context length: 8,192 tokens.',
      'Batch size: 2 per GPU with gradient accumulation to simulate batch size 32.',
      'Epochs: 2.',
      'Multi-GPU distributed training using DeepSpeed ZeRO Stage 3.',
      'Mixed precision training (bf16).',
    ].join(' ');

    const constrained = await request(app.server)
      .post('/api/recommend/workload')
      .send({
        inputText: prompt,
        objective: 'FASTEST',
        advanced: {
          maxGpus: 2,
          maxTotalBudgetUsd: 2500,
        },
      });

    expect(constrained.status).to.equal(200);
    expect(constrained.body.recommendations).to.have.length.greaterThan(0);
    for (const rec of constrained.body.recommendations) {
      expect(rec.gpuCount).to.be.at.most(2);
      expect(rec.costUsdLow).to.be.at.most(2500);
    }
  });

  it('uses the explicit stable fit-risk thresholds', async () => {
    const prompt = [
      'Fine-tune LLaMA 3 70B using QLoRA for a financial analysis assistant.',
      'Dataset: 350,000 financial documents.',
      'Average sequence length: 2,000 tokens.',
      'Context length: 8,192 tokens.',
      'Batch size: 2 per GPU with gradient accumulation to simulate batch size 32.',
      'Epochs: 2.',
      'Multi-GPU distributed training using DeepSpeed ZeRO Stage 3.',
    ].join(' ');

    const res = await request(app.server)
      .post('/api/recommend/workload')
      .send({ inputText: prompt, objective: 'LOWEST_COST', showRisky: true });

    expect(res.status).to.equal(200);
    for (const rec of res.body.recommendations.filter((item: any) => item.promptIntentMatch)) {
      if (rec.fitMarginGb <= 0.5) expect(rec.fitRisk).to.equal('TIGHT');
      else if (rec.fitMarginGb <= 5) expect(rec.fitRisk).to.equal('MODERATE');
      else expect(rec.fitRisk).to.equal('SAFE');
    }
  });
});
