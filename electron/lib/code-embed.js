const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { SKIP, isInside, isForeignAiSkill } = require('./workspace');
const retrieve = require('./memory-retrieve');
const diag = require('./diag');

const INDEX_VERSION = 1;
const CHUNK_LINES = 50;
const CHUNK_OVERLAP = 8;
const MAX_FILE_BYTES = 400 * 1024;
const MAX_FILES = 2000;
const MAX_CHUNKS = 6000;
const DEFAULT_TOP = 8;
const MAX_TOP = 16;

const SKIP_DIR = new Set([
  ...SKIP, 'bin', 'obj', '.vs', 'target', 'vendor', 'Pods', '.idea', '.gradle', 'build'
]);
const SKIP_NAME = new Set([
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum', 'composer.lock'
]);
const TEXT_EXT = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.json', '.md', '.mdc', '.txt', '.css', '.scss', '.less', '.html', '.htm',
  '.vue', '.svelte', '.py', '.cs', '.go', '.rs', '.java', '.kt', '.kts',
  '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf',
  '.sh', '.ps1', '.bat', '.cmd', '.sql', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.swift', '.rb', '.php', '.lua', '.gradle', '.cmake', '.proto',
  '.graphql', '.gql', '.r', '.m', '.mm', '.scala', '.dart'
]);

const jobs = new Map();
const controllers = new Map();

function userDataDir() {
  try { return app.getPath('userData'); } catch { return path.join(process.cwd(), '.simple-userdata'); }
}
function hashPath(p) {
  const n = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return crypto.createHash('sha1').update(n).digest('hex').slice(0, 16);
}
function indexDir(workspace) {
  return path.join(userDataDir(), 'code-embed', hashPath(workspace));
}
function metaPath(workspace) { return path.join(indexDir(workspace), 'meta.json'); }
function chunksPath(workspace) { return path.join(indexDir(workspace), 'chunks.json'); }
function vectorsFile(workspace) { return path.join(indexDir(workspace), 'vectors.json'); }

function loadJson(file, fallback) {
  if (!file || !fs.existsSync(file)) return fallback;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || fallback; } catch { return fallback; }
}
function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data), 'utf8');
}
function contentHash(text) {
  return crypto.createHash('sha1').update(String(text || ''), 'utf8').digest('hex');
}

function parseIgnoreLines(text) {
  return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}
function globToRegExp(glob) {
  let g = String(glob || '').replace(/\\/g, '/');
  let out = '';
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') { out += '.*'; i++; if (g[i + 1] === '/') i++; }
      else out += '[^/]*';
    } else if (ch === '?') out += '[^/]';
    else if ('+.^${}()|[]\\'.includes(ch)) out += `\\${ch}`;
    else out += ch;
  }
  return out;
}
function matchIgnorePattern(rel, isDir, pattern) {
  let p = String(pattern || '').replace(/\\/g, '/');
  const dirOnly = p.endsWith('/');
  if (dirOnly) { if (!isDir) return false; p = p.slice(0, -1); }
  const fromRoot = p.startsWith('/');
  if (fromRoot) p = p.slice(1);
  if (!p) return false;
  const body = globToRegExp(p);
  const re = fromRoot || p.includes('/')
    ? new RegExp(`^${body}(?:/.*)?$`)
    : new RegExp(`(?:^|/)${body}(?:/.*)?$`);
  return re.test(rel);
}
function isIgnored(rel, isDir, rules) {
  const posix = String(rel || '').replace(/\\/g, '/');
  if (!posix || posix === '.') return false;
  let ignored = false;
  for (const raw of rules || []) {
    const neg = raw.startsWith('!');
    const pat = neg ? raw.slice(1) : raw;
    if (matchIgnorePattern(posix, isDir, pat)) ignored = !neg;
  }
  return ignored;
}
function loadIgnoreRules(root) {
  const rules = [];
  for (const name of ['.gitignore', '.simpleignore']) {
    const p = path.join(root, name);
    try { if (fs.existsSync(p)) rules.push(...parseIgnoreLines(fs.readFileSync(p, 'utf8'))); } catch { /* 忽略规则读失败就跳过 */ }
  }
  return rules;
}

function indexRoots(workspace, extra) {
  const roots = [];
  const seen = new Set();
  const add = (dir) => {
    if (!dir) return;
    const abs = path.resolve(dir);
    const key = abs.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) return;
    try { if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) return; } catch { return; }
    seen.add(key);
    roots.push(abs);
  };
  add(workspace);
  for (const root of extra || []) {
    if (workspace && isInside(workspace, root)) continue;
    if (/[\\/](skills|rules)$/i.test(String(root || ''))) continue;
    add(root);
  }
  return roots;
}
function fileKey(workspace, extra, abs) {
  if (workspace && isInside(workspace, abs)) return path.relative(workspace, abs).replace(/\\/g, '/');
  for (const root of extra || []) {
    if (root && isInside(root, abs)) {
      return `@${path.basename(root)}/${path.relative(root, abs).replace(/\\/g, '/')}`;
    }
  }
  return abs.replace(/\\/g, '/');
}
function shouldSkipName(name) {
  if (!name) return true;
  if (SKIP_DIR.has(name) || SKIP_NAME.has(name)) return true;
  if (name.startsWith('.')) return true;
  if (/\.min\.(js|css)$/i.test(name)) return true;
  return false;
}
function isIndexableFile(name) {
  return TEXT_EXT.has(path.extname(name).toLowerCase());
}
function chunkText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const chunks = [];
  let i = 0;
  while (i < lines.length) {
    const start = i;
    const end = Math.min(lines.length, i + CHUNK_LINES);
    const body = lines.slice(start, end).join('\n').trim();
    if (body) chunks.push({ startLine: start + 1, endLine: end, text: body.slice(0, 1500) });
    if (end >= lines.length) break;
    i = Math.max(start + 1, end - CHUNK_OVERLAP);
  }
  return chunks;
}
function yieldTick() { return new Promise((r) => setImmediate(r)); }

function collectFiles(roots, signal) {
  const files = [];
  const own = (roots || []).filter((r) => /[\\/](\.(simple|sinpo)[\\/])?skills$/i.test(path.resolve(r)));
  function walk(root, dir, rules, depth) {
    if (signal?.aborted) throw new Error('已停止');
    if (files.length >= MAX_FILES || depth > 12) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= MAX_FILES) return;
      if (shouldSkipName(ent.name)) continue;
      const abs = path.join(dir, ent.name);
      if (isForeignAiSkill(abs, own)) continue;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (isIgnored(rel, ent.isDirectory(), rules)) continue;
      if (ent.isDirectory()) { walk(root, abs, rules, depth + 1); continue; }
      if (!ent.isFile() || !isIndexableFile(ent.name)) continue;
      try {
        const st = fs.statSync(abs);
        if (st.size > 0 && st.size <= MAX_FILE_BYTES) files.push({ abs, size: st.size });
      } catch { /* 跳过 */ }
    }
  }
  for (const root of roots) walk(root, root, loadIgnoreRules(root), 0);
  return files;
}

function persistIndex(workspace, meta, chunksMap, vectorsMap) {
  if (!workspace || !meta) return false;
  meta.updatedAt = Date.now();
  try { saveJson(metaPath(workspace), meta); } catch (e) {
    diag.log('embed', '写入 meta 失败', { message: e && e.message });
    return false;
  }
  try { saveJson(chunksPath(workspace), chunksMap || {}); } catch (e) {
    diag.log('embed', '写入 chunks 失败', { message: e && e.message });
  }
  try { retrieve.saveVectors(vectorsFile(workspace), vectorsMap || {}); } catch (e) {
    diag.log('embed', '写入向量失败', { message: e && e.message });
  }
  return true;
}

function dropFileChunks(metaFile, chunksMap, vectorsMap) {
  for (const id of metaFile?.chunkIds || []) {
    delete chunksMap[id];
    delete vectorsMap[id];
  }
}

async function indexFile(workspace, extra, abs, body, chunksMap, vectorsMap) {
  const key = fileKey(workspace, extra, abs);
  if (!body?.text || body.text.includes('\u0000')) return { key, chunkIds: [] };
  const parts = chunkText(body.text);
  const chunkIds = [];
  for (const part of parts) {
    if (Object.keys(chunksMap).length + chunkIds.length >= MAX_CHUNKS) break;
    const id = `${key}#${part.startLine}`;
    chunksMap[id] = {
      path: key,
      abs: abs.replace(/\\/g, '/'),
      startLine: part.startLine,
      endLine: part.endLine,
      text: part.text
    };
    vectorsMap[id] = await retrieve.embedText(part.text);
    chunkIds.push(id);
  }
  return { key, chunkIds };
}

function readIndexable(abs, size) {
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  if (text.includes('\u0000')) return null;
  return { text, hash: contentHash(text), size };
}

async function buildIndex(workspace, extra, signal) {
  if (!workspace) return { ok: false, reason: 'no-workspace' };
  const roots = indexRoots(workspace, extra);
  fs.mkdirSync(indexDir(workspace), { recursive: true });
  let meta = loadJson(metaPath(workspace), null);
  const sameWs = String(meta?.workspace || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    === String(workspace).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  if (!meta || meta.version !== INDEX_VERSION || !sameWs) {
    meta = { version: INDEX_VERSION, workspace: String(workspace).replace(/\\/g, '/'), roots: [], files: {}, updatedAt: Date.now() };
  }
  const chunksMap = loadJson(chunksPath(workspace), {});
  const vectorsMap = retrieve.loadVectors(vectorsFile(workspace));
  const files = collectFiles(roots, signal);
  const seen = new Set();
  let changed = 0;
  let processed = 0;
  let lastPersist = 0;
  let hitCap = false;
  const flush = () => {
    if (!changed || changed === lastPersist) return;
    meta.roots = roots.map((r) => String(r).replace(/\\/g, '/'));
    if (persistIndex(workspace, meta, chunksMap, vectorsMap)) lastPersist = changed;
  };

  try {
    for (const f of files) {
      if (signal?.aborted) throw new Error('已停止');
      const key = fileKey(workspace, extra, f.abs);
      seen.add(key);
      const body = readIndexable(f.abs, f.size);
      processed++;
      if (!body) continue;
      const prev = meta.files[key];
      const intact = prev && prev.hash === body.hash && prev.size === f.size
        && (prev.chunkIds || []).every((id) => chunksMap[id] && vectorsMap[id]);
      if (intact) continue;
      dropFileChunks(prev, chunksMap, vectorsMap);
      try {
        const next = await indexFile(workspace, extra, f.abs, body, chunksMap, vectorsMap);
        meta.files[key] = { size: f.size, hash: body.hash, chunkIds: next.chunkIds };
        changed++;
      } catch (e) {
        if (e && e.message === '已停止') throw e;
        diag.log('embed', '单文件嵌入失败', { path: key, message: e && e.message });
      }
      if (changed && changed - lastPersist >= 16) flush();
      if (processed % 8 === 0) await yieldTick();
      if (Object.keys(chunksMap).length >= MAX_CHUNKS) { hitCap = true; break; }
    }
    if (!hitCap && processed >= files.length) {
      for (const key of Object.keys(meta.files)) {
        if (seen.has(key)) continue;
        dropFileChunks(meta.files[key], chunksMap, vectorsMap);
        delete meta.files[key];
        changed++;
      }
    }
    flush();
    diag.log('embed', '向量索引更新完成', { workspace, files: Object.keys(meta.files).length, chunks: Object.keys(chunksMap).length, changed });
    return { ok: true, files: Object.keys(meta.files).length, chunks: Object.keys(chunksMap).length, changed };
  } catch (e) {
    flush();
    throw e;
  }
}

function ensureIndex(workspace, extra, signal) {
  if (!workspace) return Promise.resolve({ ok: false, reason: 'no-workspace' });
  const key = hashPath(workspace);
  if (jobs.has(key)) return jobs.get(key);
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  controllers.set(key, ac);
  const p = buildIndex(workspace, extra, ac.signal).catch((e) => {
    if (e && e.message === '已停止') return { ok: false, reason: 'aborted' };
    diag.log('embed', '建索引失败', { message: e && e.message });
    throw e;
  }).finally(() => {
    if (jobs.get(key) === p) jobs.delete(key);
    if (controllers.get(key) === ac) controllers.delete(key);
    if (signal) signal.removeEventListener('abort', onAbort);
  });
  jobs.set(key, p);
  return p;
}

function kickIndex(workspace, extra) {
  if (!workspace) return;
  ensureIndex(workspace, extra).catch(() => {});
}

function formatHit(hit) {
  const head = `${hit.path}:${hit.startLine}-${hit.endLine}`;
  const body = String(hit.text || '').split(/\r?\n/).slice(0, 24).join('\n');
  return `${head}\n${body}`;
}

async function searchHits(workspace, extra, { query, within, limit, signal } = {}) {
  const q = String(query || '').trim();
  if (!q || !workspace) return [];
  const extra2 = Array.isArray(extra) ? extra.slice() : [];
  if (within) extra2.push(within);
  const chunksMap = loadJson(chunksPath(workspace), {});
  const vectorsMap = retrieve.loadVectors(vectorsFile(workspace));
  const ids = Object.keys(chunksMap);
  if (!ids.length) {
    kickIndex(workspace, extra2);
    return [];
  }
  let qVec;
  try { qVec = await retrieve.embedText(q); } catch { return []; }
  const withinAbs = within ? path.resolve(within) : '';
  const scored = [];
  for (const id of ids) {
    if (signal?.aborted) throw new Error('已停止');
    const ch = chunksMap[id];
    const vec = vectorsMap[id];
    if (!ch || !Array.isArray(vec) || !vec.length) continue;
    if (isForeignAiSkill(ch.abs || ch.path || '')) continue;
    if (withinAbs) {
      const abs = ch.abs ? path.resolve(ch.abs) : '';
      if (abs && !isInside(withinAbs, abs) && path.resolve(abs) !== withinAbs) continue;
    }
    const score = retrieve.cosine(qVec, vec);
    if (score > 0) scored.push({ path: ch.path, startLine: ch.startLine, endLine: ch.endLine, text: ch.text, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const topN = Math.max(1, Math.min(MAX_TOP, Number(limit) || DEFAULT_TOP));
  return scored.slice(0, topN);
}

async function search(workspace, extra, opts = {}) {
  const q = String(opts.query || '').trim();
  if (!q) return '查询为空';
  if (!workspace) return '请先打开项目';
  const hits = await searchHits(workspace, extra, opts);
  if (!hits.length) return '向量索引尚未就绪或无语义匹配。精确符号请用 search_text。';
  return hits.map(formatHit).join('\n\n');
}

function formatForPrompt(hits) {
  if (!hits?.length) return '';
  const body = hits.map(formatHit).join('\n\n');
  return `【代码库检索】下列片段由本地向量检索得到，请优先根据它们定位和改代码；不够再 semantic_search / search_text / read_file。\n\n${body}`;
}

async function upsertFile(workspace, abs, extra) {
  if (!workspace || !abs || !fs.existsSync(abs)) return;
  if (jobs.has(hashPath(workspace))) return;
  if (!fs.existsSync(metaPath(workspace))) { kickIndex(workspace, extra); return; }
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES || !isIndexableFile(path.basename(abs))) {
    await removeFile(workspace, abs, extra);
    return;
  }
  const extra2 = extra || [];
  const key = fileKey(workspace, extra2, abs);
  const body = readIndexable(abs, st.size);
  if (!body) { await removeFile(workspace, abs, extra); return; }
  const meta = loadJson(metaPath(workspace), { version: INDEX_VERSION, workspace, files: {}, roots: [] });
  const prev = meta.files[key];
  if (prev && prev.hash === body.hash) return;
  const chunksMap = loadJson(chunksPath(workspace), {});
  const vectorsMap = retrieve.loadVectors(vectorsFile(workspace));
  dropFileChunks(prev, chunksMap, vectorsMap);
  try {
    const next = await indexFile(workspace, extra2, abs, body, chunksMap, vectorsMap);
    meta.files[key] = { size: st.size, hash: body.hash, chunkIds: next.chunkIds };
    persistIndex(workspace, meta, chunksMap, vectorsMap);
  } catch (e) {
    diag.log('embed', '写入后更新索引失败', { path: key, message: e && e.message });
  }
}

async function removeFile(workspace, abs, extra) {
  if (!workspace || !abs || !fs.existsSync(metaPath(workspace))) return;
  if (jobs.has(hashPath(workspace))) return;
  const key = fileKey(workspace, extra || [], abs);
  const meta = loadJson(metaPath(workspace), null);
  if (!meta || !meta.files[key]) return;
  const chunksMap = loadJson(chunksPath(workspace), {});
  const vectorsMap = retrieve.loadVectors(vectorsFile(workspace));
  dropFileChunks(meta.files[key], chunksMap, vectorsMap);
  delete meta.files[key];
  persistIndex(workspace, meta, chunksMap, vectorsMap);
}

module.exports = {
  kickIndex,
  ensureIndex,
  search,
  searchHits,
  formatForPrompt,
  upsertFile,
  removeFile
};
