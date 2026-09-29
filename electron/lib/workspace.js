const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const SKIP = new Set([
  'node_modules', '.git', 'dist', 'out', '.sinpo-snapshots', '.simple', '.sinpo',
  '.next', 'coverage', '__pycache__', '.venv', 'venv'
]);

function isInside(root, target) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

const FOREIGN_AI_DIRS = new Set(['.cursor', '.claude', '.codex', '.windsurf', '.continue', '.aider']);
const FOREIGN_AI_FILES = new Set([
  'agents.md', 'claude.md', 'gemini.md', 'copilot-instructions.md', '.cursorrules', '.windsurfrules'
]);

// 只认 SpCode 自己的技能目录。其他 AI 的规则、技能文件不读
function isForeignAiSkill(abs, ownRoots) {
  const resolved = path.resolve(String(abs || ''));
  const parts = resolved.split(/[\\/]/).filter(Boolean);
  const lower = parts.map((p) => p.toLowerCase());
  if (lower.some((p) => FOREIGN_AI_DIRS.has(p))) return true;
  const base = lower[lower.length - 1] || '';
  if (FOREIGN_AI_FILES.has(base)) return true;
  if (base !== 'skill.md') return false;
  const norm = resolved.replace(/\\/g, '/').toLowerCase();
  if (/\/\.(simple|sinpo)\/skills\/[^/]+\/skill\.md$/.test(norm)) return false;
  return !(ownRoots || []).some((root) => {
    try { return isInside(root, resolved); } catch { return false; }
  });
}

function safeJoin(root, relPath) {
  const abs = path.resolve(root, relPath || '');
  if (!isInside(root, abs)) throw new Error('路径超出工作目录');
  return abs;
}

function isAbsPath(p) {
  const s = String(p || '').trim();
  return path.isAbsolute(s) || /^[A-Za-z]:[\\/]/.test(s);
}

function samePath(a, b) {
  const n = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) && n(a) === n(b);
}

function normalizeFolders(folders) {
  const out = [];
  const seen = new Set();
  for (const f of folders || []) {
    const abs = path.resolve(String(f || '').trim());
    if (!abs) continue;
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) continue;
    } catch {
      continue;
    }
    const key = abs.replace(/\\/g, '/').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(abs);
  }
  return out;
}

function extraRoots(appRoot, workspace, extraFolders) {
  const roots = [];
  if (appRoot) {
    roots.push(path.join(appRoot, 'skills'));
    roots.push(path.join(appRoot, 'rules'));
  }
  if (workspace) {
    roots.push(path.join(workspace, '.simple', 'skills'));
    roots.push(path.join(workspace, '.simple', 'rules'));
    roots.push(path.join(workspace, '.sinpo', 'skills'));
    roots.push(path.join(workspace, '.sinpo', 'rules'));
  }
  const resolved = roots.map((r) => path.resolve(r));
  for (const abs of normalizeFolders(extraFolders)) {
    if (workspace && (samePath(workspace, abs) || isInside(workspace, abs))) continue;
    if (resolved.some((r) => samePath(r, abs))) continue;
    resolved.push(abs);
  }
  return resolved;
}

function resolveAllowed(workspace, extra, relPath) {
  const raw = String(relPath || '').trim();
  if (!raw) throw new Error('路径为空');
  const roots = [];
  if (workspace) roots.push(path.resolve(workspace));
  for (const r of extra || []) roots.push(path.resolve(r));
  const tries = [];
  if (isAbsPath(raw)) tries.push(path.resolve(raw));
  for (const r of roots) tries.push(path.resolve(r, raw));
  const allowed = (abs) => roots.some((r) => isInside(r, abs));
  for (const abs of tries) {
    if (allowed(abs) && fs.existsSync(abs)) return abs;
  }
  // [铆钉优化] 模型常把工作目录末尾几级再拼一遍（工作目录是 …/Assets/Script，却写 Assets/Script/X.cs），
  // 从上几级目录再解析一次，落回工作目录内就用它，避免读不到或新建出重复的嵌套目录。其他 AI 请勿删除
  const overlap = [];
  if (!isAbsPath(raw)) {
    for (const r of roots) {
      let up = r;
      for (let i = 0; i < 4; i++) {
        const parent = path.dirname(up);
        if (parent === up) break;
        up = parent;
        const abs = path.resolve(up, raw);
        if (abs !== r && isInside(r, abs)) overlap.push(abs);
      }
    }
  }
  for (const abs of overlap) {
    if (fs.existsSync(abs)) return abs;
  }
  for (const abs of overlap) {
    if (fs.existsSync(path.dirname(abs)) && !tries.some((t) => allowed(t) && fs.existsSync(path.dirname(t)))) return abs;
  }
  for (const abs of tries) {
    if (allowed(abs)) return abs;
  }
  throw new Error('路径超出允许范围（工作目录、附加目录或技能/规则目录）');
}

// 工作区外已经存在的文件，读得到就必须能写回。不能读完又说找不到。
function resolveWrite(workspace, extra, relPath) {
  try {
    return resolveAllowed(workspace, extra, relPath);
  } catch (err) {
    const raw = String(relPath || '').trim();
    if (!isAbsPath(raw)) throw err;
    const abs = path.resolve(raw);
    if (isForeignAiSkill(abs, extra)) throw err;
    let st;
    try { st = fs.statSync(abs); } catch { throw err; }
    if (!st.isFile()) throw err;
    return abs;
  }
}

/** 读取：工作区内相对路径，或任意存在的绝对路径（与 Cursor 一样） */
function resolveRead(workspace, extra, relPath) {
  const raw = String(relPath || '').trim();
  if (!raw) throw new Error('路径为空');
  if (isAbsPath(raw)) {
    const abs = path.resolve(raw);
    if (!fs.existsSync(abs)) throw new Error('路径不存在：' + abs);
    return abs;
  }
  return resolveAllowed(workspace, extra, raw);
}

function listTree(root, { max = 400, query = '' } = {}) {
  const out = [];
  const q = (query || '').toLowerCase();

  function walk(dir, depth) {
    if (out.length >= max || depth > 8) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (out.length >= max) return;
      if (SKIP.has(ent.name) || ent.name.startsWith('.')) continue;
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (ent.isDirectory()) {
        walk(abs, depth + 1);
      } else if (!q || rel.toLowerCase().includes(q) || ent.name.toLowerCase().includes(q)) {
        out.push({ path: rel, name: ent.name });
      }
    }
  }

  walk(root, 0);
  return out;
}

function listChildren(root, rel = '', { absolute = false } = {}) {
  const dir = rel ? path.join(root, rel) : root;
  if (!isInside(root, dir)) throw new Error('路径超出工作目录');
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const hide = new Set(['.git', '.sinpo-snapshots', '.simple', '.sinpo']);
  const items = [];
  for (const ent of entries) {
    if (hide.has(ent.name)) continue;
    const childRel = rel ? `${String(rel).replace(/\\/g, '/')}/${ent.name}` : ent.name;
    const itemPath = absolute
      ? path.join(dir, ent.name).replace(/\\/g, '/')
      : childRel;
    items.push({ name: ent.name, path: itemPath, dir: ent.isDirectory() });
  }
  items.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh');
  });
  return items;
}

// 按行读出指定范围。先扫完整文件再切行，避免只读开头导致后半段行号对不上。
function readLineRange(abs, startLine, endLine) {
  const start = Math.max(1, Number(startLine) || 1);
  const endWanted = Number(endLine) > 0 ? Number(endLine) : 0;
  const fd = fs.openSync(abs, 'r');
  const buf = Buffer.alloc(64 * 1024);
  const decoder = new StringDecoder('utf8');
  let pending = '';
  let lineNo = 0;
  const lines = [];
  const take = (line) => {
    lineNo += 1;
    if (lineNo >= start && (endWanted === 0 || lineNo <= endWanted)) lines.push(line);
  };
  try {
    while (true) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      pending += decoder.write(buf.subarray(0, n));
      let cut;
      while ((cut = pending.indexOf('\n')) >= 0) {
        let line = pending.slice(0, cut);
        pending = pending.slice(cut + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        take(line);
      }
    }
    pending += decoder.end();
    if (pending.length) {
      if (pending.endsWith('\r')) pending = pending.slice(0, -1);
      take(pending);
    }
  } finally {
    fs.closeSync(fd);
  }
  const end = endWanted > 0 ? Math.min(endWanted, lineNo) : lineNo;
  return { lines, total: lineNo, start, end };
}

const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// 给模型的文本按原文件返回，不截断
function readTextFile(abs) {
  const buf = fs.readFileSync(abs);
  if (isProbablyBinary(buf)) return { binary: true, text: '' };
  return { binary: false, text: buf.toString('utf8') };
}

/**
 * 只读预览：文本 / 图片 / 二进制
 * @param {string} root 工作目录
 * @param {string} rel 相对路径
 * @returns {{ kind: string, path: string, name: string, content?: string, truncated?: boolean }}
 */
function readForPreview(root, rel, maxBytes = 512 * 1024) {
  const raw = String(rel || '');
  const abs = isAbsPath(raw) ? path.resolve(raw) : safeJoin(root, raw);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('文件不存在');
  const name = path.basename(abs);
  const filePath = String(rel || '').replace(/\\/g, '/');
  const ext = path.extname(abs).toLowerCase();
  const mime = IMAGE_MIME[ext];
  const stat = fs.statSync(abs);
  if (mime) {
    if (stat.size > 8 * 1024 * 1024) throw new Error('图片过大');
    const buf = fs.readFileSync(abs);
    return { kind: 'image', path: filePath, name, content: `data:${mime};base64,${buf.toString('base64')}` };
  }
  const truncated = stat.size > maxBytes;
  let buf;
  if (truncated) {
    buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(abs, 'r');
    fs.readSync(fd, buf, 0, maxBytes, 0);
    fs.closeSync(fd);
  } else {
    buf = fs.readFileSync(abs);
  }
  if (isProbablyBinary(buf)) return { kind: 'binary', path: filePath, name };
  let content = buf.toString('utf8');
  if (truncated) content += '\n\n[文件过大，已截断]';
  return { kind: 'text', path: filePath, name, content, truncated };
}

module.exports = {
  isInside, safeJoin, isAbsPath, samePath, normalizeFolders, isForeignAiSkill,
  resolveAllowed, resolveRead, resolveWrite, extraRoots, listTree, listChildren,
  readTextFile, readLineRange, readForPreview, SKIP
};
