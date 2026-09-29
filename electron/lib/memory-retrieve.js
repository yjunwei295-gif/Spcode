const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const W_BM25 = 0.45;
const W_VEC = 0.55;
const PATH_BONUS = 0.15;
const TOP_CAND = 30;
const TOP_OUT = 6;

let embedPipeline = null;
let embedLoading = null;

function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  const en = s.match(/[a-z0-9_./-]+/g) || [];
  tokens.push(...en);
  const zh = s.replace(/[a-z0-9_./\s-]+/gi, '');
  for (let i = 0; i < zh.length; i++) {
    tokens.push(zh[i]);
    if (i + 1 < zh.length) tokens.push(zh[i] + zh[i + 1]);
  }
  return tokens.filter(Boolean);
}

function docText(entry) {
  return [
    entry.summary || '',
    ...(entry.tags || []),
    ...(entry.paths || [])
  ].join(' ');
}

function buildBm25(entries) {
  const docs = entries.map((e) => {
    const tokens = tokenize(docText(e));
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    return { id: e.id, entry: e, tokens, tf, len: tokens.length || 1 };
  });
  const N = docs.length || 1;
  const avgdl = docs.reduce((s, d) => s + d.len, 0) / N;
  const df = new Map();
  for (const d of docs) {
    for (const t of new Set(d.tokens)) df.set(t, (df.get(t) || 0) + 1);
  }
  return { docs, N, avgdl, df };
}

function bm25Scores(index, query) {
  const qTokens = tokenize(query);
  if (!qTokens.length || !index.docs.length) return new Map();
  const scores = new Map();
  for (const d of index.docs) {
    let score = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t) || 0;
      if (!f) continue;
      const n = index.df.get(t) || 0;
      const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
      const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (d.len / index.avgdl));
      score += idf * ((f * (BM25_K1 + 1)) / denom);
    }
    if (score > 0) scores.set(d.id, score);
  }
  return scores;
}

function cacheDir() {
  try {
    return path.join(app.getPath('userData'), 'transformers-cache');
  } catch {
    return path.join(process.cwd(), 'transformers-cache');
  }
}

async function getEmbedder() {
  if (embedPipeline) return embedPipeline;
  if (embedLoading) return embedLoading;
  embedLoading = (async () => {
    process.env.TRANSFORMERS_CACHE = cacheDir();
    const { pipeline, env } = require('@xenova/transformers');
    env.cacheDir = cacheDir();
    env.allowLocalModels = true;
    embedPipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    return embedPipeline;
  })().catch((e) => {
    embedLoading = null;
    throw e;
  });
  return embedLoading;
}

async function embedText(text) {
  const pipe = await getEmbedder();
  const out = await pipe(String(text || '').slice(0, 1500) || ' ', {
    pooling: 'mean',
    normalize: true
  });
  const data = out?.data || out;
  return Array.from(data);
}

function cosine(a, b) {
  if (!a?.length || !b?.length || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

function loadVectors(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveVectors(filePath, map) {
  if (!filePath) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(map), 'utf8');
}

function normalizeMap(scores) {
  const vals = [...scores.values()];
  if (!vals.length) return new Map();
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const out = new Map();
  if (hi <= lo) {
    for (const [k] of scores) out.set(k, 1);
    return out;
  }
  for (const [k, v] of scores) out.set(k, (v - lo) / (hi - lo));
  return out;
}

function pathOverlapBonus(entry, pathHints) {
  if (!pathHints?.length || !entry.paths?.length) return 0;
  const hints = pathHints.map((p) => String(p).replace(/\\/g, '/').toLowerCase());
  for (const p of entry.paths) {
    const pl = String(p).replace(/\\/g, '/').toLowerCase();
    if (hints.some((h) => h === pl || pl.includes(h) || h.includes(pl))) return PATH_BONUS;
  }
  return 0;
}

/**
 * 混合召回
 * @returns {Promise<object[]>} 按分数排序的条目（不含强制 pinned，调用方自行合并）
 */
async function hybridRecall(entries, { query, paths = [], limit = TOP_OUT, vectorsPath } = {}) {
  const list = (entries || []).filter((e) => e && !e.superseded && !e.pinned);
  if (!list.length) return [];
  const q = [query, ...(paths || [])].filter(Boolean).join(' ');
  const index = buildBm25(list);
  const bm25Raw = bm25Scores(index, q);
  const bm25N = normalizeMap(bm25Raw);

  const vectors = loadVectors(vectorsPath);
  const vecRaw = new Map();
  let qVec = null;
  try {
    qVec = await embedText(q);
    for (const e of list) {
      const v = vectors[e.id];
      if (Array.isArray(v) && v.length) {
        const c = cosine(qVec, v);
        if (c > 0) vecRaw.set(e.id, c);
      }
    }
  } catch {
    /* 向量不可用时仅用 BM25 */
  }
  const vecN = normalizeMap(vecRaw);

  const fused = list.map((e) => {
    const b = bm25N.get(e.id) || 0;
    const v = vecN.get(e.id) || 0;
    let score = W_BM25 * b + W_VEC * v;
    if (!vecRaw.size) score = b;
    score = Math.min(1, score + pathOverlapBonus(e, paths));
    return { e, score };
  });

  return fused
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.e);
}

async function upsertVector(vectorsPath, id, text) {
  if (!vectorsPath || !id) return;
  try {
    const map = loadVectors(vectorsPath);
    map[id] = await embedText(text);
    saveVectors(vectorsPath, map);
  } catch (e) {
    /* 嵌入失败不挡写入记忆 */
  }
}

function removeVector(vectorsPath, id) {
  if (!vectorsPath || !id) return;
  const map = loadVectors(vectorsPath);
  if (map[id]) {
    delete map[id];
    saveVectors(vectorsPath, map);
  }
}

async function ensureVectors(vectorsPath, entries) {
  const map = loadVectors(vectorsPath);
  let changed = false;
  for (const e of entries || []) {
    if (!e?.id || e.superseded) continue;
    if (Array.isArray(map[e.id]) && map[e.id].length) continue;
    try {
      map[e.id] = await embedText(docText(e));
      changed = true;
    } catch {
      break;
    }
  }
  if (changed) saveVectors(vectorsPath, map);
}

module.exports = {
  tokenize,
  hybridRecall,
  upsertVector,
  removeVector,
  ensureVectors,
  loadVectors,
  saveVectors,
  embedText,
  cosine,
  docText,
  TOP_OUT
};
