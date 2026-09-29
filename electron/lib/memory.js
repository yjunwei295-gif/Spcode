const fs = require('fs');
const path = require('path');
const retrieve = require('./memory-retrieve');

const META_DIR = '.simple';
const LEGACY_META = '.sinpo';
const MAX_ACTIVE = 80;
const RECALL_TOP = 8;

function memoryDir(workspace) {
  if (!workspace) return null;
  const neu = path.join(workspace, META_DIR, 'memory');
  const old = path.join(workspace, LEGACY_META, 'memory');
  if (fs.existsSync(neu)) return neu;
  if (fs.existsSync(old)) return old;
  return neu;
}

function entriesPath(workspace) {
  const dir = memoryDir(workspace);
  return dir ? path.join(dir, 'entries.json') : null;
}

function archivePath(workspace) {
  const dir = memoryDir(workspace);
  return dir ? path.join(dir, 'archive.jsonl') : null;
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `mem-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.map((p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()).filter(Boolean))];
}

function normalizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return [...new Set(tags.map((t) => String(t || '').trim()).filter(Boolean))];
}

function normalizeKind(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'invariant' || k === 'decision' || k === 'pin') return k;
  return 'decision';
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = String(raw.summary || '').trim();
  if (!summary) return null;
  const pinned = !!(raw.pinned || raw.kind === 'pin');
  return {
    id: String(raw.id || newId()),
    createdAt: String(raw.createdAt || nowIso()),
    updatedAt: String(raw.updatedAt || nowIso()),
    kind: pinned && raw.kind !== 'invariant' && raw.kind !== 'decision' ? 'pin' : normalizeKind(raw.kind),
    summary: summary.slice(0, 400),
    paths: normalizePaths(raw.paths),
    tags: normalizeTags(raw.tags),
    source: raw.source === 'user' ? 'user' : 'auto',
    pinned,
    superseded: !!raw.superseded
  };
}

function emptyStore() {
  return { version: 1, entries: [] };
}

function load(workspace) {
  const p = entriesPath(workspace);
  if (!p || !fs.existsSync(p)) return emptyStore();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const entries = Array.isArray(data?.entries)
      ? data.entries.map(normalizeEntry).filter(Boolean)
      : [];
    return { version: 1, entries };
  } catch {
    return emptyStore();
  }
}

function ensureDir(workspace) {
  const dir = memoryDir(workspace);
  if (!dir) throw new Error('请先打开项目，才能保存项目记忆');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function appendArchive(workspace, entries) {
  if (!entries.length) return;
  const p = archivePath(workspace);
  if (!p) return;
  ensureDir(workspace);
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  fs.appendFileSync(p, lines, 'utf8');
}

function vectorsPath(workspace) {
  const dir = memoryDir(workspace);
  return dir ? path.join(dir, 'vectors.json') : null;
}

function save(workspace, store) {
  ensureDir(workspace);
  const p = entriesPath(workspace);
  const active = (store.entries || []).filter((e) => !e.superseded);
  const pinned = active.filter((e) => e.pinned);
  let keep = active.filter((e) => !e.pinned);
  keep.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  if (keep.length > MAX_ACTIVE) {
    const drop = keep.slice(MAX_ACTIVE);
    keep = keep.slice(0, MAX_ACTIVE);
    appendArchive(workspace, drop);
    for (const d of drop) retrieve.removeVector(vectorsPath(workspace), d.id);
  }
  const entries = [...pinned, ...keep].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
  return { version: 1, entries };
}

function list(workspace) {
  return load(workspace).entries.filter((e) => !e.superseded);
}

function similarSummary(a, b) {
  const x = String(a || '').replace(/\s+/g, '').toLowerCase();
  const y = String(b || '').replace(/\s+/g, '').toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  return false;
}

function pathOverlap(a, b) {
  const pa = normalizePaths(a);
  const pb = normalizePaths(b);
  if (!pa.length || !pb.length) return false;
  return pa.some((p) => pb.some((q) => p === q || p.endsWith('/' + q) || q.endsWith('/' + p) || p.includes(q) || q.includes(p)));
}

/**
 * 合并新条目：路径+摘要近似则更新，否则追加
 */
function mergeEntries(workspace, incoming, { source = 'auto' } = {}) {
  if (!workspace) throw new Error('请先打开项目');
  const store = load(workspace);
  const added = [];
  for (const raw of incoming || []) {
    const item = normalizeEntry({
      ...raw,
      source: raw.source || source,
      pinned: !!(raw.pinned || raw.kind === 'pin'),
      id: raw.id || newId(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    });
    if (!item) continue;
    if (source === 'auto' && isAutoBlocked(workspace, item.summary, item.paths)) continue;
    const hit = store.entries.find((e) =>
      !e.superseded
      && similarSummary(e.summary, item.summary)
      && (pathOverlap(e.paths, item.paths) || (!e.paths.length && !item.paths.length))
    );
    if (hit) {
      hit.summary = item.summary;
      hit.paths = normalizePaths([...hit.paths, ...item.paths]);
      hit.tags = normalizeTags([...hit.tags, ...item.tags]);
      hit.kind = item.kind === 'pin' ? 'pin' : (item.kind || hit.kind);
      hit.pinned = hit.pinned || item.pinned;
      hit.updatedAt = nowIso();
      hit.source = item.source === 'user' ? 'user' : hit.source;
      added.push(hit);
      retrieve.upsertVector(vectorsPath(workspace), hit.id, retrieve.docText(hit)).catch(() => {});
    } else {
      store.entries.push(item);
      added.push(item);
      retrieve.upsertVector(vectorsPath(workspace), item.id, retrieve.docText(item)).catch(() => {});
    }
  }
  save(workspace, store);
  return added;
}

function addUserMemory(workspace, { summary, paths, tags, pinned = true, kind } = {}) {
  return mergeEntries(workspace, [{
    kind: pinned ? (kind || 'pin') : (kind || 'invariant'),
    summary,
    paths,
    tags,
    pinned: pinned !== false,
    source: 'user'
  }], { source: 'user' });
}

function setPinned(workspace, id, pinned) {
  const store = load(workspace);
  const e = store.entries.find((x) => x.id === id);
  if (!e) throw new Error('记忆不存在');
  e.pinned = !!pinned;
  if (e.pinned && e.kind !== 'invariant' && e.kind !== 'decision') e.kind = 'pin';
  e.updatedAt = nowIso();
  save(workspace, store);
  return e;
}

function blocklistPath(workspace) {
  const dir = memoryDir(workspace);
  return dir ? path.join(dir, 'deleted-blocklist.json') : null;
}

const BLOCKLIST_MAX = 200;

function loadBlocklist(workspace) {
  const p = blocklistPath(workspace);
  if (!p || !fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

// 用户手动删过的记忆：自动提炼不得再次写入（用户新建除外）
function pushBlocklist(workspace, entry) {
  const p = blocklistPath(workspace);
  if (!p || !entry) return;
  ensureDir(workspace);
  const items = loadBlocklist(workspace);
  items.push({
    summary: String(entry.summary || '').slice(0, 400),
    paths: normalizePaths(entry.paths),
    deletedAt: nowIso(),
    id: String(entry.id || '')
  });
  fs.writeFileSync(p, JSON.stringify({ version: 1, items: items.slice(-BLOCKLIST_MAX) }, null, 2), 'utf8');
}

function isAutoBlocked(workspace, summary, paths) {
  const items = loadBlocklist(workspace);
  for (const x of items) {
    if (!similarSummary(x.summary, summary)) continue;
    if (pathOverlap(x.paths, paths) || (!normalizePaths(x.paths).length && !normalizePaths(paths).length)) return true;
  }
  return false;
}

function remove(workspace, id) {
  const store = load(workspace);
  const idx = store.entries.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error('记忆不存在');
  const [gone] = store.entries.splice(idx, 1);
  appendArchive(workspace, [{ ...gone, deletedAt: nowIso(), userDeleted: true }]);
  pushBlocklist(workspace, gone);
  save(workspace, store);
  retrieve.removeVector(vectorsPath(workspace), id);
  return true;
}

/** 批量删除；返回实际删除条数 */
function removeMany(workspace, ids) {
  if (!workspace) throw new Error('请先打开项目');
  const want = new Set((ids || []).map(String).filter(Boolean));
  if (!want.size) return 0;
  const store = load(workspace);
  const gone = [];
  store.entries = store.entries.filter((e) => {
    if (!want.has(e.id)) return true;
    gone.push(e);
    return false;
  });
  if (!gone.length) return 0;
  appendArchive(workspace, gone.map((e) => ({ ...e, deletedAt: nowIso(), userDeleted: true })));
  for (const e of gone) {
    pushBlocklist(workspace, e);
    retrieve.removeVector(vectorsPath(workspace), e.id);
  }
  save(workspace, store);
  return gone.length;
}

/**
 * 清空项目长期记忆
 * @param {{ keepPinned?: boolean }} opts keepPinned=true 时保留钉住的条目
 */
function clearAll(workspace, { keepPinned = false } = {}) {
  if (!workspace) throw new Error('请先打开项目');
  const store = load(workspace);
  const gone = store.entries.filter((e) => !e.superseded && (!keepPinned || !e.pinned));
  if (!gone.length) return 0;
  const removeIds = new Set(gone.map((e) => e.id));
  store.entries = store.entries.filter((e) => !removeIds.has(e.id));
  appendArchive(workspace, gone.map((e) => ({ ...e, deletedAt: nowIso(), userDeleted: true })));
  for (const e of gone) {
    pushBlocklist(workspace, e);
    retrieve.removeVector(vectorsPath(workspace), e.id);
  }
  save(workspace, store);
  return gone.length;
}

/**
 * 混合召回：pinned 全进 + BM25/向量 Top
 */
async function recall(workspace, { userText = '', paths = [], limit = RECALL_TOP } = {}) {
  const entries = list(workspace);
  if (!entries.length) return [];
  const pinned = entries.filter((e) => e.pinned);
  const rest = await retrieve.hybridRecall(entries, {
    query: userText,
    paths: normalizePaths(paths),
    limit,
    vectorsPath: vectorsPath(workspace)
  });
  const seen = new Set();
  const out = [];
  for (const e of [...pinned, ...rest]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/** 同步兜底召回（向量未就绪时） */
function recallSync(workspace, opts) {
  const entries = list(workspace);
  if (!entries.length) return [];
  const pathHints = normalizePaths(opts?.paths || []);
  const q = String(opts?.userText || '').toLowerCase();
  const pinned = entries.filter((e) => e.pinned);
  const scored = entries.filter((e) => !e.pinned).map((e) => {
    let score = 0;
    const text = `${e.summary} ${(e.tags || []).join(' ')} ${(e.paths || []).join(' ')}`.toLowerCase();
    for (const w of q.split(/\s+/).filter((x) => x.length > 1)) {
      if (text.includes(w)) score += 2;
    }
    for (const p of e.paths || []) {
      if (pathHints.some((h) => p.includes(h) || h.includes(p))) score += 10;
    }
    return { e, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score).slice(0, opts?.limit || RECALL_TOP).map((x) => x.e);
  const seen = new Set();
  const out = [];
  for (const e of [...pinned, ...scored]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function formatForPrompt(entries, { english = false } = {}) {
  if (!entries?.length) return '';
  const lines = entries.map((e, i) => {
    const kind = e.kind === 'invariant'
      ? (english ? 'must-keep' : '勿破坏')
      : e.kind === 'pin'
        ? (english ? 'pinned' : '钉死')
        : (english ? 'decision' : '决策');
    const paths = (e.paths || []).length ? ` [${(e.paths || []).join(', ')}]` : '';
    const pin = e.pinned ? (english ? ' (always)' : '（每轮强制）') : '';
    return `${i + 1}. (${kind}${pin}) ${e.summary}${paths}`;
  });
  if (english) {
    return `## Confirmed project conventions
These were already settled. When adding features, keep them. Do not silently rewrite or undo them. If a new request conflicts, tell the user and ask before breaking them.
${lines.join('\n')}`;
  }
  return `## 项目已确认约定
下列约定已确认正确。实现新功能时必须在保留它们的前提下增量修改；禁止默默推倒重写或改坏。若新需求与约定冲突，先向用户说明并征求确认。
${lines.join('\n')}`;
}

function extractPrompt({ userText, changePaths, assistantText, lang }) {
  const paths = normalizePaths(changePaths).join('\n') || '(无)';
  const en = !!(lang && lang.code && lang.code !== 'zh' && lang.code !== 'zh-Hant');
  if (en) {
    return `From this coding turn, extract durable project conventions only (why a change was made, what must not break).
Return ONLY a JSON array. Each item: {"kind":"invariant"|"decision","summary":"one sentence","paths":["rel/path"],"tags":["optional"]}.
If nothing durable, return [].
No markdown fences.

User request:
${String(userText || '').slice(0, 4000)}

Changed files:
${paths}

Assistant summary:
${String(assistantText || '').slice(0, 3000)}`;
  }
  return `根据本轮改代码对话，只提炼「长期有效、下次改相关功能时不能忘掉」的项目约定。
只输出 JSON 数组，每项：{"kind":"invariant"|"decision","summary":"一句话中文（原因+结论）","paths":["相对路径"],"tags":["可选关键词"]}。
没有可沉淀的约定就输出 []。不要 markdown 代码围栏，不要解释。

用户需求：
${String(userText || '').slice(0, 4000)}

改动文件：
${paths}

助手收尾：
${String(assistantText || '').slice(0, 3000)}`;
}

function parseExtractJson(text) {
  const s = String(text || '').trim();
  if (!s) return [];
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1].trim() : s;
  const start = body.indexOf('[');
  const end = body.lastIndexOf(']');
  if (start < 0 || end < start) return [];
  try {
    const arr = JSON.parse(body.slice(start, end + 1));
    if (!Array.isArray(arr)) return [];
    return arr.map((x) => normalizeEntry({
      ...x,
      source: 'auto',
      pinned: false,
      id: newId(),
      createdAt: nowIso(),
      updatedAt: nowIso()
    })).filter(Boolean);
  } catch {
    return [];
  }
}

/** 从用户话里抓「记住：…」类显式指令 */
function parseRememberDirective(userText) {
  const t = String(userText || '');
  const m = t.match(/(?:记住|别再改掉|不要改掉|请记住)[：:\s]+(.+)/i)
    || t.match(/remember(?:\s+that)?[：:\s]+(.+)/i);
  if (!m) return null;
  const summary = String(m[1] || '').trim().slice(0, 400);
  if (!summary || summary.length < 2) return null;
  return summary;
}

module.exports = {
  load,
  list,
  save,
  mergeEntries,
  addUserMemory,
  setPinned,
  remove,
  removeMany,
  clearAll,
  recall,
  recallSync,
  formatForPrompt,
  extractPrompt,
  parseExtractJson,
  parseRememberDirective,
  memoryDir,
  vectorsPath,
  MAX_ACTIVE,
  RECALL_TOP
};
