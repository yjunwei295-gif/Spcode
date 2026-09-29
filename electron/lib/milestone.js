const fs = require('fs');
const path = require('path');

const META_DIR = '.simple';
const LEGACY_META = '.sinpo';

function milestonesDir(workspace) {
  if (!workspace) return null;
  const neu = path.join(workspace, META_DIR, 'milestones');
  const old = path.join(workspace, LEGACY_META, 'milestones');
  if (fs.existsSync(neu)) return neu;
  if (fs.existsSync(old)) return old;
  return neu;
}

function entriesPath(workspace) {
  const dir = milestonesDir(workspace);
  return dir ? path.join(dir, 'entries.json') : null;
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `ms-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(
    paths.map((p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim()).filter(Boolean)
  )];
}

function normalizeName(name) {
  const s = String(name || '').trim().slice(0, 80);
  if (!s) throw new Error('请填写里程碑名称');
  return s;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  let name;
  try {
    name = normalizeName(raw.name);
  } catch {
    return null;
  }
  return {
    id: String(raw.id || newId()),
    name,
    createdAt: String(raw.createdAt || nowIso()),
    updatedAt: String(raw.updatedAt || nowIso()),
    snapshotId: raw.snapshotId ? String(raw.snapshotId) : '',
    paths: normalizePaths(raw.paths)
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
  const dir = milestonesDir(workspace);
  if (!dir) throw new Error('请先打开项目');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function save(workspace, store) {
  ensureDir(workspace);
  const p = entriesPath(workspace);
  const entries = (store.entries || []).map(normalizeEntry).filter(Boolean)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  fs.writeFileSync(p, JSON.stringify({ version: 1, entries }, null, 2), 'utf8');
  return { version: 1, entries };
}

function list(workspace) {
  if (!workspace) return [];
  return load(workspace).entries;
}

/**
 * 从某次变更创建里程碑（必须命名）
 */
function create(workspace, { name, paths, snapshotId } = {}) {
  const store = load(workspace);
  const entry = normalizeEntry({
    id: newId(),
    name: normalizeName(name),
    paths: normalizePaths(paths),
    snapshotId: snapshotId || '',
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  if (!entry.paths.length) throw new Error('没有可绑定的改动文件');
  store.entries.push(entry);
  save(workspace, store);
  return entry;
}

function rename(workspace, id, name) {
  const store = load(workspace);
  const e = store.entries.find((x) => x.id === id);
  if (!e) throw new Error('里程碑不存在');
  e.name = normalizeName(name);
  e.updatedAt = nowIso();
  save(workspace, store);
  return e;
}

function remove(workspace, id) {
  const store = load(workspace);
  const idx = store.entries.findIndex((x) => x.id === id);
  if (idx < 0) throw new Error('里程碑不存在');
  store.entries.splice(idx, 1);
  save(workspace, store);
  return true;
}

function pathMatches(milestonePath, changePath) {
  const a = String(milestonePath || '').replace(/\\/g, '/').toLowerCase();
  const b = String(changePath || '').replace(/\\/g, '/').toLowerCase();
  if (!a || !b) return false;
  return a === b || b.endsWith('/' + a) || a.endsWith('/' + b) || b.includes(a) || a.includes(b);
}

/**
 * 根据本轮改动路径，找出碰到了哪些里程碑
 * @returns {{ id, name, hitPaths: string[] }[]}
 */
function matchChanges(workspace, changePaths) {
  const paths = normalizePaths(changePaths);
  if (!workspace || !paths.length) return [];
  const out = [];
  for (const m of list(workspace)) {
    const hitPaths = paths.filter((p) => (m.paths || []).some((mp) => pathMatches(mp, p)));
    if (hitPaths.length) {
      out.push({ id: m.id, name: m.name, hitPaths });
    }
  }
  return out;
}

module.exports = {
  list,
  create,
  rename,
  remove,
  matchChanges,
  load,
  milestonesDir
};
