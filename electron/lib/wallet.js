/**
 * 厂商手动余额 + 按 token 估价。
 * 1 USD = 1,000,000 Credits（B.AI 官方换算）。
 */

const CREDITS_PER_USD = 1000000;

/** B.AI 文档公开单价：美元 / 百万 tokens。DeepSeek 分时取忙时（偏保守）。 */
const BAI_USD_PER_M = {
  minimaxm3: { input: 0.30, output: 1.20 },
  minimaxm27: { input: 0.30, output: 1.20 },
  kimik3: { input: 3.00, output: 15.00 },
  kimik26: { input: 0.95, output: 4.00 },
  kimik25: { input: 0.59, output: 3.00 },
  qwen38flash: { input: 0.16, output: 0.47 },
  qwen3827b: { input: 0.22, output: 1.60 },
  qwen38max: { input: 2.00, output: 6.00 },
  qwen37max: { input: 1.65, output: 4.951 },
  qwen3627b: { input: 0.19, output: 2.99 },
  hy4preview: { input: 0.834, output: 2.501 },
  hy3: { input: 0.132, output: 0.528 },
  mimov25pro: { input: 0.435, output: 0.87 },
  mimov25: { input: 0.14, output: 0.28 },
  glm53flash: { input: 0.15, output: 0.50 },
  glm53: { input: 1.40, output: 4.40 },
  glm52: { input: 1.40, output: 4.40 },
  glm51: { input: 1.40, output: 4.40 },
  deepseekv41flash: { input: 0.30, output: 1.20 },
  deepseekv32: { input: 0.29, output: 0.44 },
  deepseekv4flash: { input: 0.30, output: 1.20 },
  deepseekv4flashvisionexp: { input: 0.30, output: 1.20 },
  deepseekv4pro: { input: 1.32, output: 3.96 },
  grok46: { input: 2.00, output: 6.00 },
  grok45: { input: 2.00, output: 6.00 },
  gpt6astra: { input: 10.00, output: 50.00 },
  gpt56sol: { input: 4.00, output: 20.00 },
  gpt56terra: { input: 2.00, output: 12.00 },
  gpt56luna: { input: 0.20, output: 1.20 },
  gpt54: { input: 2.50, output: 15.00 },
  gpt55: { input: 5.00, output: 30.00 },
  gpt55instant: { input: 5.00, output: 30.00 },
  gpt54pro: { input: 30.00, output: 180.00 },
  gpt52: { input: 1.75, output: 14.00 },
  gpt54mini: { input: 0.75, output: 4.50 },
  gpt5mini: { input: 0.25, output: 2.00 },
  gpt54nano: { input: 0.20, output: 1.25 },
  gpt5nano: { input: 0.05, output: 0.40 },
  claudeopus5: { input: 5.00, output: 25.00 },
  claudefable51: { input: 10.00, output: 50.00 },
  claudefable5: { input: 10.00, output: 50.00 },
  claudeopus48: { input: 5.00, output: 25.00 },
  claudeopus47: { input: 5.00, output: 25.00 },
  claudeopus46: { input: 5.00, output: 25.00 },
  claudeopus45: { input: 5.00, output: 25.00 },
  claudesonnet5: { input: 2.00, output: 10.00 },
  claudesonnet46: { input: 3.00, output: 15.00 },
  claudesonnet45: { input: 3.00, output: 15.00 },
  claudehaiku45: { input: 1.00, output: 5.00 },
  musespark13: { input: 1.25, output: 4.25 },
  gemini38flash: { input: 0.75, output: 3.75 },
  gemini36flash: { input: 1.50, output: 7.50 },
  gemini35flash: { input: 1.50, output: 9.00 },
  gemini35flashlite: { input: 0.30, output: 2.50 },
  gemini31pro: { input: 2.00, output: 12.00 },
  gemini3flash: { input: 0.50, output: 3.00 }
};

function normModel(id) {
  return String(id || '').toLowerCase().replace(/^models\//, '').replace(/[^a-z0-9]+/g, '');
}

function isBaiHost(baseUrl) {
  return /b\.ai|bankofai/i.test(String(baseUrl || ''));
}

function lookupBaiPrice(modelId) {
  const n = normModel(modelId);
  if (BAI_USD_PER_M[n]) return BAI_USD_PER_M[n];
  const hit = Object.keys(BAI_USD_PER_M).find((k) => n.includes(k) || k.includes(n));
  return hit ? BAI_USD_PER_M[hit] : null;
}

function firstFinite(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function parseTokenUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw.usage || raw.usageMetadata || raw.message?.usage || raw;
  const input = firstFinite(
    u.prompt_tokens, u.input_tokens, u.promptTokenCount,
    u.prompt_token_count, u.inputTokens, u.input
  );
  const output = firstFinite(
    u.completion_tokens, u.output_tokens, u.candidatesTokenCount,
    u.completionTokenCount, u.outputTokens, u.candidates_token_count, u.output
  );
  const credits = firstFinite(u.credits, u.credit, u.consumed_credits);
  const costRaw = firstFinite(u.cost, u.total_cost, u.cost_usd, u.usd, u.total_usd, u.costRaw);
  if (input == null && output == null && credits == null && costRaw == null) return null;
  const total = firstFinite(u.total_tokens, u.totalTokenCount, u.total_token_count);
  return {
    input: input || 0,
    output: output || 0,
    total: total != null ? total : (input || 0) + (output || 0),
    credits: credits != null ? credits : null,
    usd: null,
    costRaw: costRaw != null ? costRaw : null
  };
}

/** 把接口里的 cost 字段解释成积分或美元 */
function interpretBilled(usage, modelCfg) {
  const u = usage && typeof usage === 'object' ? { ...usage } : null;
  if (!u) return null;
  if (u.credits == null && u.usd == null && u.costRaw != null) {
    if (isBaiHost(modelCfg?.baseUrl)) u.credits = u.costRaw;
    else u.usd = u.costRaw;
  }
  return u;
}

/** 优先用接口实扣，否则按官网单价估算，单位与钱包一致 */
function spendAmount(usage, modelCfg, unit) {
  const u = interpretBilled(usage, modelCfg);
  if (!u) return null;
  if (unit === 'CREDITS') {
    if (u.credits > 0) return u.credits;
    if (u.usd > 0) return u.usd * CREDITS_PER_USD;
    return costInUnit(estimateUsd(modelCfg, u), 'CREDITS');
  }
  if (u.usd > 0) return u.usd;
  if (u.credits > 0) return u.credits / CREDITS_PER_USD;
  return costInUnit(estimateUsd(modelCfg, u), 'USD');
}

/** 已记 token 但花费仍是 0 时，按单价补算一次 */
function recoverSpend(w, modelCfg) {
  const wallet = normalizeWallet(w);
  if (!wallet || wallet.spent > 0) return wallet || w;
  if (!(wallet.tokensIn > 0 || wallet.tokensOut > 0)) return wallet;
  const cost = spendAmount(
    { input: wallet.tokensIn, output: wallet.tokensOut },
    modelCfg,
    wallet.unit
  );
  if (cost != null && cost > 0) wallet.spent = cost;
  return wallet;
}

function normalizeWallet(raw) {
  if (!raw || typeof raw !== 'object') return undefined;
  const start = Number(raw.remainingStart);
  if (!Number.isFinite(start) || start < 0) return undefined;
  const unit = String(raw.unit || 'USD').toUpperCase() === 'CREDITS' ? 'CREDITS' : 'USD';
  return {
    remainingStart: start,
    spent: Math.max(0, Number(raw.spent) || 0),
    unit,
    tokensIn: Math.max(0, Number(raw.tokensIn) || 0),
    tokensOut: Math.max(0, Number(raw.tokensOut) || 0),
    filledAt: Number(raw.filledAt) || Date.now()
  };
}

function snapshotFromWallet(wallet, providerId) {
  const w = normalizeWallet(wallet);
  if (!w || !(w.remainingStart > 0)) return null;
  const remaining = Math.max(0, w.remainingStart - w.spent);
  return {
    available: true,
    source: 'manual',
    providerId: providerId || '',
    used: w.spent,
    remaining,
    total: w.remainingStart,
    currency: w.unit,
    tokensIn: w.tokensIn,
    tokensOut: w.tokensOut
  };
}

function ratesFor(modelCfg) {
  const p = modelCfg?.pricing || {};
  const input = firstFinite(p.input, p.prompt);
  const output = firstFinite(p.output, p.completion);
  if (input != null || output != null) {
    return { input: input || 0, output: output || 0 };
  }
  if (isBaiHost(modelCfg?.baseUrl)) return lookupBaiPrice(modelCfg?.model);
  return null;
}

/** @returns {number|null} 本次花费的美元；没有单价则 null（仍可记 token） */
function estimateUsd(modelCfg, usage) {
  const rates = ratesFor(modelCfg);
  if (!rates) return null;
  const inn = Number(usage?.input) || 0;
  const out = Number(usage?.output) || 0;
  return (inn / 1e6) * rates.input + (out / 1e6) * rates.output;
}

function costInUnit(usd, unit) {
  if (usd == null || !Number.isFinite(usd)) return null;
  return unit === 'CREDITS' ? usd * CREDITS_PER_USD : usd;
}

module.exports = {
  CREDITS_PER_USD,
  parseTokenUsage,
  normalizeWallet,
  snapshotFromWallet,
  lookupBaiPrice,
  estimateUsd,
  costInUnit,
  interpretBilled,
  spendAmount,
  recoverSpend,
  isBaiHost,
  ratesFor
};
