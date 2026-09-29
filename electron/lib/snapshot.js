const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');
const { isInside, SKIP } = require('./workspace');

// 命令前后扫描工作区时额外跳过的目录（避免 Library/bin 等大目录拖慢备份）
const SCAN_SKIP = new Set([
  ...SKIP,
  'bin', 'obj', 'Library', 'Temp', 'Logs', 'Build', 'Builds',
  '.vs', '.idea', 'target', '.gradle', 'DerivedDataCache', 'Packages'
]);
const SCAN_MAX_DEPTH = 12;
const SCAN_MAX_FILES = 8000;

// 快照只用于源码回滚。模型权重、压缩包、可执行文件这类大二进制不进快照，
// 否则 run_command 前的整工作区备份会把 GB 级权重反复拷进 C 盘 userData，撑爆系统盘
const SNAP_SKIP_EXT = new Set([
  '.gguf', '.safetensors', '.bin', '.pt', '.pth', '.ckpt', '.onnx', '.msgpack',
  '.exe', '.dll', '.so', '.dylib', '.node', '.zip', '.7z', '.rar', '.gz', '.tar', '.iso',
  '.mp4', '.mov', '.avi', '.mkv', '.wav', '.mp3', '.flac',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.pdf'
]);
// 单文件超过这个体积也不进快照：源码文件几乎不会这么大
const SNAP_MAX_BYTES = 100 * 1024 * 1024;

// 判断某个文件是否跳过快照备份（按扩展名或体积）
function shouldSkipSnapshotFile(abs) {
  const ext = path.extname(String(abs || '')).toLowerCase();
  if (SNAP_SKIP_EXT.has(ext)) return true;
  try {
    const st = fs.statSync(abs);
    return !st.isFile() || st.size > SNAP_MAX_BYTES;
  } catch {
    return true;
  }
}

const DEFAULT_MAX_SNAPSHOTS = 20;
const MIN_MAX = 1;
const MAX_MAX = 500;

// 旧版快照目录：系统盘 userData 下按项目哈希分目录
function legacyRootDir(workspace) {
  return path.join(app.getPath('userData'), 'snapshots', workspaceKey(workspace));
}

// 快照根目录：优先放项目内 .sinpo-snapshots（跟项目走，不会写满系统盘）；
// 项目目录不可写时退回系统盘旧目录，避免无法写文件
function rootDir(workspace) {
  if (workspace) {
    const local = path.join(path.resolve(String(workspace)), '.sinpo-snapshots');
    try {
      fs.mkdirSync(local, { recursive: true });
      return local;
    } catch {
      /* 项目目录不可写，退回系统盘 */
    }
  }
  return legacyRootDir(workspace);
}

function workspaceKey(workspace) {
  const n = path.resolve(String(workspace || '')).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha1').update(n).digest('hex').slice(0, 12);
}

function snapDir(workspace, id) {
  return path.join(rootDir(workspace), id);
}

// 每个项目每次运行只迁移一次，避免反复扫系统盘
const migratedWorkspaces = new Set();

// 递归复制目录（跨盘 rename 失败时用），单文件失败跳过不影响其他文件
function copyDirRecursive(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      copyDirRecursive(src, dest);
      continue;
    }
    fs.copyFileSync(src, dest);
  }
}

// 项目内已有同名快照时：把系统盘那份缺失的内容补进项目内那份，再删掉系统盘那份。
// 同名直接跳过会让系统盘旧目录永远清不掉（曾造成 C 盘残留快照）
function mergeSnapshotDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name);
    const dest = path.join(to, name);
    const st = fs.statSync(src);
    if (st.isDirectory()) {
      mergeSnapshotDir(src, dest);
      continue;
    }
    // 清单特殊处理：取 changes 更多的那份，保住更完整的回滚记录
    if (name === 'manifest.json' && fs.existsSync(dest)) {
      try {
        const a = JSON.parse(fs.readFileSync(src, 'utf8'));
        const b = JSON.parse(fs.readFileSync(dest, 'utf8'));
        const na = Array.isArray(a.changes) ? a.changes.length : 0;
        const nb = Array.isArray(b.changes) ? b.changes.length : 0;
        if (na > nb) fs.copyFileSync(src, dest);
      } catch {
        /* 清单损坏时保留项目内那份 */
      }
      continue;
    }
    // 项目内已有的文件不覆盖，只补缺失的
    if (fs.existsSync(dest)) continue;
    fs.copyFileSync(src, dest);
  }
}

// 把旧版存在系统盘的快照搬进项目内 .sinpo-snapshots，避免继续占 C 盘
function migrateLegacySnapshots(workspace) {
  if (!workspace) return { moved: 0 };
  const key = path.resolve(String(workspace)).toLowerCase();
  if (migratedWorkspaces.has(key)) return { moved: 0 };
  migratedWorkspaces.add(key);
  const legacy = legacyRootDir(workspace);
  const local = path.join(path.resolve(String(workspace)), '.sinpo-snapshots');
  if (legacy === local || !fs.existsSync(legacy)) return { moved: 0 };
  try {
    fs.mkdirSync(local, { recursive: true });
  } catch {
    return { moved: 0 };
  }
  let moved = 0;
  for (const id of fs.readdirSync(legacy)) {
    const from = path.join(legacy, id);
    const to = path.join(local, id);
    if (fs.existsSync(to)) {
      // 项目内已有同名快照：先合并系统盘那份的缺失内容再删掉它，
      // 否则同名直接跳过会让系统盘旧目录永远清不掉
      try {
        mergeSnapshotDir(from, to);
        fs.rmSync(from, { recursive: true, force: true });
        moved += 1;
      } catch {
        /* 合并失败则保留系统盘那份，不丢数据 */
      }
      continue;
    }
    try {
      fs.renameSync(from, to);
      moved += 1;
    } catch {
      try {
        copyDirRecursive(from, to);
        fs.rmSync(from, { recursive: true, force: true });
        moved += 1;
      } catch {
        /* 单份迁移失败不影响其他快照 */
      }
    }
  }
  // 旧目录已空则删掉，不留空壳占系统盘
  try {
    if (fs.readdirSync(legacy).length === 0) {
      fs.rmSync(legacy, { recursive: true, force: true });
      // 上一级 snapshots 目录也空了就一并删掉，避免系统盘留空壳
      const parent = path.dirname(legacy);
      if (fs.existsSync(parent) && fs.readdirSync(parent).length === 0) {
        fs.rmSync(parent, { recursive: true, force: true });
      }
    }
  } catch {
    /* 忽略清理失败 */
  }
  return { moved };
}

function configPath(workspace) {
  if (!workspace) return null;
  const neu = path.join(workspace, '.simple', 'snapshot.json');
  const old = path.join(workspace, '.sinpo', 'snapshot.json');
  if (fs.existsSync(neu)) return neu;
  if (fs.existsSync(old)) return old;
  return neu;
}

function clampMax(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return DEFAULT_MAX_SNAPSHOTS;
  return Math.min(MAX_MAX, Math.max(MIN_MAX, v));
}

/** 读取当前项目的快照上限（默认 20） */
function getMax(workspace) {
  const p = configPath(workspace);
  if (!p || !fs.existsSync(p)) return DEFAULT_MAX_SNAPSHOTS;
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return clampMax(data?.max ?? data?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS);
  } catch {
    return DEFAULT_MAX_SNAPSHOTS;
  }
}

/** 设置当前项目的快照上限，并立刻按新上限淘汰旧快照 */
function setMax(workspace, max) {
  if (!workspace) throw new Error('请先打开项目');
  const limit = clampMax(max);
  const p = configPath(workspace);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ max: limit }, null, 2), 'utf8');
  prune(workspace, limit);
  return limit;
}

function relParts(relPath) {
  return String(relPath || '').replace(/\\/g, '/').split('/').filter((p) => p && p !== '.');
}

function nestedUnder(root, relPath) {
  const parts = relParts(relPath);
  if (parts.some((p) => p === '..')) throw new Error('路径超出工作目录');
  return parts.length ? path.join(root, ...parts) : root;
}

function copyFileSafe(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function create(workspace, label) {
  migrateLegacySnapshots(workspace);
  // id 加随机短串，避免同一毫秒创建两条快照时撞车、复用旧目录导致覆盖
  const id = `snap_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const dir = snapDir(workspace, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    workspace,
    label: label || '自动更改快照',
    changes: []
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  prune(workspace);
  return { id, dir, manifest };
}

function recordChange(workspace, snapshot, relPath, action, opts = {}) {
  if (!snapshot) return;
  const parts = relParts(relPath);
  const norm = parts.join('/');
  if (!norm) return;
  const abs = path.resolve(workspace, ...parts);
  if (!isInside(workspace, abs)) throw new Error('路径超出工作目录');
  // 权重等大二进制不进快照：不记条目也不备份，避免还原语义被破坏
  if (shouldSkipSnapshotFile(abs)) return;
  const existed = opts.existedBefore != null
    ? !!opts.existedBefore
    : (fs.existsSync(abs) && fs.statSync(abs).isFile());
  const dest = nestedUnder(path.join(snapshot.dir, 'files'), norm);
  // 已有文件必须在第一次改之前备份；若记录已在但备份缺失则补上（此时可能已是新内容，尽量仍保留第一次备份）
  if (existed && !fs.existsSync(dest)) {
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) copyFileSafe(abs, dest);
    if (!fs.existsSync(dest)) throw new Error(`无法备份文件：${norm}`);
  }
  const already = snapshot.manifest.changes.find((c) => c.path === norm);
  if (already) {
    fs.writeFileSync(path.join(snapshot.dir, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2), 'utf8');
    return;
  }
  snapshot.manifest.changes.push({
    path: norm,
    action,
    existed
  });
  fs.writeFileSync(path.join(snapshot.dir, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2), 'utf8');
}

/** 扫描工作区普通文件的 mtime+size，供 run_command 前后 diff */
function scanFingerprints(workspace) {
  const map = new Map();
  const status = { complete: true, truncated: false, errors: [], missingPaths: [] };
  if (!workspace) {
    status.complete = false;
    map.truncated = false;
    map.scanStatus = status;
    return map;
  }
  const root = path.resolve(workspace);

  function noteError(abs, err) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (err && err.code === 'ENOENT') {
      if (rel) status.missingPaths.push(rel);
      else status.complete = false;
      return;
    }
    status.complete = false;
    status.errors.push({ path: rel, code: err?.code || '', message: String(err?.message || err || '') });
  }

  function walk(dir, depth) {
    if (depth > SCAN_MAX_DEPTH) {
      status.complete = false;
      status.truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      noteError(dir, err);
      return;
    }
    for (const ent of entries) {
      if (map.size >= SCAN_MAX_FILES) {
        status.complete = false;
        status.truncated = true;
        return;
      }
      if (SCAN_SKIP.has(ent.name)) continue;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (!isInside(root, abs)) continue;
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      try {
        const st = fs.statSync(abs);
        const ext = path.extname(abs).toLowerCase();
        if (SNAP_SKIP_EXT.has(ext) || st.size > SNAP_MAX_BYTES) continue;
        const rel = path.relative(root, abs).replace(/\\/g, '/');
        map.set(rel, { mtimeMs: st.mtimeMs, size: st.size });
      } catch (err) {
        noteError(abs, err);
      }
    }
  }

  walk(root, 0);
  status.missingPaths = [...new Set(status.missingPaths)];
  map.truncated = status.truncated;
  map.scanStatus = status;
  return map;
}

function diffFingerprints(before, after) {
  const modified = [];
  const created = [];
  const deleted = [];
  const beforeStatus = before?.scanStatus || { complete: !before?.truncated, missingPaths: [] };
  const afterStatus = after?.scanStatus || { complete: !after?.truncated, missingPaths: [] };
  const isMissing = (rel, paths) => (paths || []).some((p) => rel === p || rel.startsWith(p + '/'));
  for (const [rel, meta] of after || []) {
    if (rel === 'truncated' || rel === 'scanStatus') continue;
    const prev = before?.get(rel);
    if (!prev) {
      if (beforeStatus.complete || isMissing(rel, beforeStatus.missingPaths)) created.push(rel);
      continue;
    }
    if (prev.mtimeMs !== meta.mtimeMs || prev.size !== meta.size) modified.push(rel);
  }
  for (const rel of before?.keys() || []) {
    if (rel === 'truncated' || rel === 'scanStatus') continue;
    if (after?.has(rel)) continue;
    // 不完整扫描不能证明删除；只有扫描到明确 ENOENT 的路径/父目录可作为负向证据。
    if ((beforeStatus.complete && afterStatus.complete) || isMissing(rel, afterStatus.missingPaths)) deleted.push(rel);
  }
  return { modified, created, deleted };
}

/** run_command 执行前：把尚未备份的工作区文件拷进快照，避免脚本改完后备份到的是新内容 */
function preBackupWorkspace(workspace, snapshot) {
  const status = { complete: true, truncated: false, errors: [], missingPaths: [] };
  if (!workspace || !snapshot?.dir) return { backed: 0, ...status };
  const root = path.resolve(workspace);
  const filesRoot = path.join(snapshot.dir, 'files');
  let backed = 0;

  function noteError(abs, err) {
    const rel = path.relative(root, abs).replace(/\\/g, '/');
    if (err && err.code === 'ENOENT') {
      if (rel) status.missingPaths.push(rel);
      return;
    }
    status.complete = false;
    status.errors.push({ path: rel, code: err?.code || '', message: String(err?.message || err || '') });
  }

  function walk(dir, depth) {
    if (depth > SCAN_MAX_DEPTH) {
      status.complete = false;
      status.truncated = true;
      return;
    }
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      noteError(dir, err);
      return;
    }
    for (const ent of entries) {
      if (backed >= SCAN_MAX_FILES) {
        status.complete = false;
        status.truncated = true;
        return;
      }
      if (SCAN_SKIP.has(ent.name)) continue;
      if (ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      if (!isInside(root, abs)) continue;
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
        continue;
      }
      if (!ent.isFile()) continue;
      let st;
      try {
        st = fs.statSync(abs);
      } catch (err) {
        noteError(abs, err);
        continue;
      }
      const ext = path.extname(abs).toLowerCase();
      if (SNAP_SKIP_EXT.has(ext) || st.size > SNAP_MAX_BYTES) continue;
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      const dest = nestedUnder(filesRoot, rel);
      if (fs.existsSync(dest)) continue;
      try {
        copyFileSafe(abs, dest);
        backed += 1;
      } catch (err) {
        noteError(abs, err);
      }
    }
  }

  walk(root, 0);
  status.missingPaths = [...new Set(status.missingPaths)];
  return { backed, ...status };
}

function isMissingPath(paths, rel) {
  return (paths || []).some((p) => rel === p || rel.startsWith(p + '/'));
}

/** 对比 run_command 前后扫描结果，写入快照清单（可还原脚本改动） */
function recordCommandDiff(workspace, snapshot, before, after, preBackupStatus) {
  if (!snapshot) return [];
  const beforeStatus = before?.scanStatus || { complete: !before?.truncated };
  const afterStatus = after?.scanStatus || { complete: !after?.truncated };
  snapshot.manifest.commandScans = snapshot.manifest.commandScans || [];
  snapshot.manifest.commandScans.push({ before: beforeStatus, preBackup: preBackupStatus || null, after: afterStatus });
  fs.writeFileSync(path.join(snapshot.dir, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2), 'utf8');
  const { modified, created, deleted } = diffFingerprints(before, after);
  const out = [];
  for (const rel of modified) {
    recordChange(workspace, snapshot, rel, 'write', { existedBefore: true });
    out.push({ path: rel, action: 'write', source: 'command' });
  }
  for (const rel of created) {
    recordChange(workspace, snapshot, rel, 'write', { existedBefore: false });
    out.push({ path: rel, action: 'write', source: 'command' });
  }
  for (const rel of deleted) {
    const backup = nestedUnder(path.join(snapshot.dir, 'files'), rel);
    if (!fs.existsSync(backup)) continue;
    recordChange(workspace, snapshot, rel, 'delete', { existedBefore: true });
    out.push({ path: rel, action: 'delete', source: 'command' });
  }
  dropUnchangedBackups(snapshot.dir, snapshot.manifest);
  return out;
}

// [铆钉优化] run_command 前为了能还原，会先把整个工作区复制一份；命令跑完、比对出真正改过的文件后，
// 没改过的副本立刻删掉，快照里只留清单上的文件。否则每个「1 个文件」的快照实际存着整个项目。其他 AI 请勿删除
function dropUnchangedBackups(snapDirPath, manifest) {
  const filesRoot = path.join(snapDirPath, 'files');
  if (!manifest || !fs.existsSync(filesRoot)) return 0;
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  const key = (p) => (fold ? p.toLowerCase() : p);
  const keep = new Set((manifest.changes || []).map((c) => key(relParts(c.path).join('/'))));
  let removed = 0;
  function walk(dir) {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(abs);
        try { if (!fs.readdirSync(abs).length) fs.rmdirSync(abs); } catch { /* 忽略 */ }
        continue;
      }
      const rel = path.relative(filesRoot, abs).split(path.sep).join('/');
      if (keep.has(key(rel))) continue;
      try { fs.unlinkSync(abs); removed += 1; } catch { /* 忽略 */ }
    }
  }
  walk(filesRoot);
  return removed;
}

/** 旧快照里残留的整份工作区副本，列快照时清一次，清过的打标记不再重复扫 */
function cleanupLegacyBackups(workspace, items) {
  for (const m of items || []) {
    if (!m || !m.id || m.backupsPruned) continue;
    // 可能还有正在跑的轮次用着这份快照（命令前的整份备份还没比对），只清 3 小时前的
    if (!m.createdAt || Date.now() - Date.parse(m.createdAt) < 3 * 60 * 60 * 1000) continue;
    const dir = snapDir(workspace, m.id);
    try {
      dropUnchangedBackups(dir, m);
      m.backupsPruned = true;
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m, null, 2), 'utf8');
    } catch { /* 单份清理失败不影响列表 */ }
  }
}

function list(workspace) {
  migrateLegacySnapshots(workspace);
  prune(workspace);
  const items = readAll(workspace);
  cleanupLegacyBackups(workspace, items);
  return items;
}

function readAll(workspace) {
  const dir = rootDir(workspace);
  if (!dir || !fs.existsSync(dir)) return [];
  const ids = fs.readdirSync(dir);
  const items = [];
  for (const id of ids) {
    const m = path.join(dir, id, 'manifest.json');
    if (!fs.existsSync(m)) continue;
    try {
      items.push(JSON.parse(fs.readFileSync(m, 'utf8')));
    } catch {
      /* 忽略损坏快照 */
    }
  }
  items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return items;
}

/** 每个项目只保留最近 N 份改前备份，超出则删掉最早的整包 */
function prune(workspace, maxOverride) {
  if (!workspace) return;
  const limit = maxOverride != null ? clampMax(maxOverride) : getMax(workspace);
  const items = readAll(workspace);
  for (const old of items.slice(limit)) {
    const dir = snapDir(workspace, old.id);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略清理失败 */
    }
  }
}

function restore(workspace, snapshotId) {
  const dir = snapDir(workspace, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('快照不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const restored = [];
  for (const change of manifest.changes || []) {
    const parts = relParts(change.path);
    if (!parts.length) continue;
    const abs = path.resolve(workspace, ...parts);
    if (!isInside(workspace, abs)) continue;
    const backup = nestedUnder(path.join(dir, 'files'), change.path);
    if (change.existed) {
      if (!fs.existsSync(backup)) continue;
      copyFileSafe(backup, abs);
      restored.push({ path: change.path, action: 'restore' });
    } else if (fs.existsSync(abs)) {
      if (fs.statSync(abs).isFile()) fs.unlinkSync(abs);
      restored.push({ path: change.path, action: 'delete-created' });
    }
  }
  return { snapshotId, restored };
}

function captureAfter(workspace, snapshot) {
  if (!snapshot?.dir || !snapshot.manifest) return;
  for (const change of snapshot.manifest.changes || []) {
    const parts = relParts(change.path);
    if (!parts.length) continue;
    const abs = path.resolve(workspace, ...parts);
    if (shouldSkipSnapshotFile(abs)) continue;
    const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
    change.afterExisted = !!exists;
    if (exists) copyFileSafe(abs, nestedUnder(path.join(snapshot.dir, 'after'), change.path));
  }
  fs.writeFileSync(path.join(snapshot.dir, 'manifest.json'), JSON.stringify(snapshot.manifest, null, 2), 'utf8');
}

function ensureAfter(workspace, snapshotId) {
  const dir = snapDir(workspace, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('快照不存在');
  const snapshot = { id: snapshotId, dir, manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')) };
  const afterRoot = path.join(dir, 'after');
  if (!fs.existsSync(afterRoot)) captureAfter(workspace, snapshot);
  return snapshot;
}

function undo(workspace, snapshotId) {
  ensureAfter(workspace, snapshotId);
  return restore(workspace, snapshotId);
}

function redo(workspace, snapshotId) {
  const dir = snapDir(workspace, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('快照不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const redone = [];
  for (const change of manifest.changes || []) {
    const parts = relParts(change.path);
    if (!parts.length) continue;
    const abs = path.resolve(workspace, ...parts);
    if (!isInside(workspace, abs)) continue;
    const after = nestedUnder(path.join(dir, 'after'), change.path);
    if (change.afterExisted && fs.existsSync(after)) {
      copyFileSafe(after, abs);
      redone.push({ path: change.path, action: 'redo' });
    } else if (change.afterExisted === false && fs.existsSync(abs)) {
      if (fs.statSync(abs).isFile()) fs.unlinkSync(abs);
      redone.push({ path: change.path, action: 'redo-delete' });
    }
  }
  return { snapshotId, redone };
}

function splitKeep(text) {
  if (!text) return [];
  return String(text).split(/\r?\n/);
}

function readTextIf(file) {
  if (!file || !fs.existsSync(file)) return '';
  return fs.readFileSync(file, 'utf8');
}

function lcsTable(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  return dp;
}

function listChangeHunks(beforeLines, afterLines) {
  if (beforeLines.length > 1200 || afterLines.length > 1200) {
    return [{
      index: 0,
      removed: beforeLines.slice(0, 40),
      added: afterLines.slice(0, 40),
      truncated: true
    }];
  }
  const dp = lcsTable(beforeLines, afterLines);
  const hunks = [];
  let i = 0;
  let j = 0;
  let cur = null;
  const flush = () => {
    if (cur && (cur.removed.length || cur.added.length)) hunks.push(cur);
    cur = null;
  };
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (!cur) cur = { removed: [], added: [] };
      cur.removed.push(beforeLines[i]);
      i++;
    } else {
      if (!cur) cur = { removed: [], added: [] };
      cur.added.push(afterLines[j]);
      j++;
    }
  }
  while (i < beforeLines.length) {
    if (!cur) cur = { removed: [], added: [] };
    cur.removed.push(beforeLines[i]);
    i++;
  }
  while (j < afterLines.length) {
    if (!cur) cur = { removed: [], added: [] };
    cur.added.push(afterLines[j]);
    j++;
  }
  flush();
  return hunks.map((h, index) => ({ index, removed: h.removed, added: h.added }));
}

function mergeReject(beforeLines, afterLines, rejectIndex) {
  const dp = lcsTable(beforeLines, afterLines);
  const out = [];
  let i = 0;
  let j = 0;
  let hunk = -1;
  let inChange = false;
  const touch = () => {
    if (!inChange) {
      inChange = true;
      hunk++;
    }
  };
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      inChange = false;
      out.push(afterLines[j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      touch();
      if (hunk === rejectIndex) out.push(beforeLines[i]);
      i++;
    } else {
      touch();
      if (hunk !== rejectIndex) out.push(afterLines[j]);
      j++;
    }
  }
  while (i < beforeLines.length) {
    touch();
    if (hunk === rejectIndex) out.push(beforeLines[i]);
    i++;
  }
  while (j < afterLines.length) {
    touch();
    if (hunk !== rejectIndex) out.push(afterLines[j]);
    j++;
  }
  return out;
}

function fileEnds(workspace, snapshotId, relPath) {
  const dir = snapDir(workspace, snapshotId);
  const manifestPath = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) throw new Error('快照不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const change = (manifest.changes || []).find((c) => c.path === String(relPath || '').replace(/\\/g, '/'));
  if (!change) throw new Error('这份快照里没有该文件');
  const parts = relParts(change.path);
  const abs = path.resolve(workspace, ...parts);
  if (!isInside(workspace, abs)) throw new Error('路径超出工作目录');
  const backup = change.existed ? readTextIf(nestedUnder(path.join(dir, 'files'), change.path)) : '';
  const current = fs.existsSync(abs) && fs.statSync(abs).isFile() ? readTextIf(abs) : '';
  return { change, abs, beforeLines: splitKeep(backup), afterLines: splitKeep(current) };
}

function listFileHunks(workspace, snapshotId, relPath) {
  const { change, beforeLines, afterLines } = fileEnds(workspace, snapshotId, relPath);
  const hunks = listChangeHunks(beforeLines, afterLines).map((h) => ({
    index: h.index,
    removed: h.removed.slice(0, 40),
    added: h.added.slice(0, 40),
    removedMore: Math.max(0, h.removed.length - 40),
    addedMore: Math.max(0, h.added.length - 40),
    truncated: !!h.truncated
  }));
  return { path: change.path, hunks };
}

function rejectFileHunk(workspace, snapshotId, relPath, hunkIndex) {
  const { change, abs, beforeLines, afterLines } = fileEnds(workspace, snapshotId, relPath);
  if (beforeLines.length > 1200 || afterLines.length > 1200) {
    throw new Error('文件太大，请用整份还原');
  }
  const index = Number(hunkIndex);
  if (!Number.isInteger(index) || index < 0) throw new Error('代码块编号无效');
  const merged = mergeReject(beforeLines, afterLines, index);
  const text = merged.join('\n');
  if (!change.existed && !text) {
    if (fs.existsSync(abs)) fs.unlinkSync(abs);
  } else {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const body = text && !text.endsWith('\n') ? `${text}\n` : text;
    fs.writeFileSync(abs, body, 'utf8');
  }
  return listFileHunks(workspace, snapshotId, change.path);
}

module.exports = {
  create, recordChange, captureAfter, list, restore, undo, redo,
  scanFingerprints, diffFingerprints, preBackupWorkspace, recordCommandDiff,
  listFileHunks, rejectFileHunk, shouldSkipSnapshotFile,
  migrateLegacySnapshots,
  getMax, setMax, DEFAULT_MAX_SNAPSHOTS, MIN_MAX, MAX_MAX
};
