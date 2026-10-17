// JSON 格式化与分段：项目地图和 read_file 共用。
// 原文本来就是多行的用原文行号；压缩成几行的先格式化成两格缩进的视图，行号按视图算
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SEG_LINES = 300;
const JSON_MAX_BYTES = 20 * 1024 * 1024;
// 只给这么深的节点留子项；更深的大节点整块算一段
const MAX_DEPTH = 12;
const VIEW_MEMO_MAX = 3;

function userDataDir() {
  try { return require('electron').app.getPath('userData'); } catch { return path.join(process.cwd(), '.simple-userdata'); }
}

function countLines(s) {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n += 1;
  return n;
}

/** 解析并决定用哪份文字分段；不是合法 JSON 返回 null */
function prepare(text) {
  const raw = String(text || '').replace(/^\uFEFF/, '');
  if (!raw.trim()) return null;
  let data;
  try { data = JSON.parse(raw); } catch { return null; }
  if (!data || typeof data !== 'object') return null;
  const formatted = JSON.stringify(data, null, 2);
  const minified = countLines(raw) * 2 < countLines(formatted);
  return { minified, view: minified ? formatted : raw };
}

function lineIndex(s) {
  const starts = [0];
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** 扫一遍合法 JSON，得到每个值的起止位置；小节点用完就丢掉子项，只留可能要往下拆的 */
function scanTree(s, lineOf, segLines) {
  let i = 0;
  const skipWs = () => {
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i += 1; else break;
    }
  };
  const readString = () => {
    const from = i;
    i += 1;
    while (i < s.length) {
      const c = s.charCodeAt(i);
      if (c === 92) i += 2;
      else if (c === 34) { i += 1; break; } else i += 1;
    }
    return s.slice(from, i);
  };
  function value(depth) {
    skipWs();
    const start = i;
    const c = s[i];
    if (c === '{' || c === '[') {
      const obj = c === '{';
      const close = obj ? '}' : ']';
      i += 1;
      const kids = depth < MAX_DEPTH ? [] : null;
      skipWs();
      if (s[i] === close) {
        i += 1;
        return { start, end: i - 1, obj, kids: null };
      }
      let idx = 0;
      while (i < s.length) {
        skipWs();
        let label = idx;
        if (obj) {
          const rawKey = readString();
          try { label = JSON.parse(rawKey); } catch { label = rawKey.slice(1, -1); }
          skipWs();
          i += 1;
        }
        const node = value(depth + 1);
        if (kids) kids.push({ label, node });
        idx += 1;
        skipWs();
        if (s[i] === ',') { i += 1; continue; }
        i += 1;
        break;
      }
      const node = { start, end: i - 1, obj, kids };
      // 根节点的子项总留着：小文件也按顶层键分段，地图能按键名搜到
      if (depth > 0 && lineOf(node.end) - lineOf(node.start) + 1 <= segLines) node.kids = null;
      return node;
    }
    if (c === '"') {
      readString();
      return { start, end: i - 1, kids: null };
    }
    while (i < s.length && !/[,\]}\s]/.test(s[i])) i += 1;
    return { start, end: i - 1, kids: null };
  }
  return value(0);
}

function childPath(base, obj, label) {
  if (!obj) return `${base}[${label}]`;
  return /^[A-Za-z_$][\w$]*$/.test(String(label)) ? `${base}.${label}` : `${base}[${JSON.stringify(String(label))}]`;
}

function cut(node, name, lineOf, segLines, out) {
  const a = lineOf(node.start);
  const b = lineOf(node.end);
  if (b - a + 1 <= segLines || !node.kids || !node.kids.length) {
    out.push({ name, line: a, endLine: b });
    return;
  }
  let group = [];
  const flush = () => {
    if (!group.length) return;
    const first = group[0];
    const last = group[group.length - 1];
    const label = group.length === 1
      ? childPath(name, node.obj, first.label)
      : (node.obj ? `${name}.{${first.label} … ${last.label}}` : `${name}[${first.label}-${last.label}]`);
    out.push({ name: label, line: lineOf(first.node.start), endLine: lineOf(last.node.end) });
    group = [];
  };
  for (const k of node.kids) {
    const kLines = lineOf(k.node.end) - lineOf(k.node.start) + 1;
    if (kLines > segLines) {
      flush();
      cut(k.node, childPath(name, node.obj, k.label), lineOf, segLines, out);
      continue;
    }
    if (group.length && lineOf(k.node.end) - lineOf(group[0].node.start) + 1 > segLines) flush();
    group.push(k);
  }
  flush();
}

/** 按视图文字分段；maxSegs 限制段数，大文件时每段放宽 */
function segmentsOf(view, maxSegs) {
  const total = countLines(view);
  const segLines = Math.max(SEG_LINES, Math.ceil(total / Math.max(1, maxSegs)));
  const lineOf = lineIndex(view);
  const root = scanTree(view, lineOf, segLines);
  const out = [];
  if (total <= segLines && root.obj && root.kids && root.kids.length && root.kids.length <= maxSegs) {
    for (const k of root.kids) out.push({ name: childPath('$', true, k.label), line: lineOf(k.node.start), endLine: lineOf(k.node.end) });
  } else {
    cut(root, '$', lineOf, segLines, out);
  }
  for (const s of out) if (s.name.length > 80) s.name = `${s.name.slice(0, 77)}...`;
  return { total, segLines, segments: out };
}

/** 项目地图用：返回 { minified, total, segments }，不是合法 JSON 返回 null */
function segmentsOfText(text, maxSegs) {
  const p = prepare(text);
  if (!p) return null;
  return Object.assign({ minified: p.minified }, segmentsOf(p.view, maxSegs || 400));
}

const memo = new Map();

function viewCachePath(abs) {
  const id = crypto.createHash('sha1').update(String(abs).toLowerCase()).digest('hex').slice(0, 20);
  return path.join(userDataDir(), 'json-view', `${id}.json`);
}

/** 格式化视图落到 SpCode 数据目录，下次同一版本的文件直接读 */
function cachedView(abs, stamp, text) {
  const file = viewCachePath(abs);
  const metaFile = `${file}.meta`;
  try {
    if (fs.readFileSync(metaFile, 'utf8') === stamp) return { minified: true, view: fs.readFileSync(file, 'utf8') };
  } catch { /* 没有缓存 */ }
  const p = prepare(text);
  if (p && p.minified) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, p.view, 'utf8');
      fs.writeFileSync(metaFile, stamp, 'utf8');
    } catch { /* 缓存写不了不影响本次 */ }
  }
  return p;
}

/** read_file 用：{ minified, total, segLines, segments, lines? }；不是合法 JSON 或太大返回 null */
function jsonView(abs) {
  let st;
  try { st = fs.statSync(abs); } catch { return null; }
  if (!st.isFile() || st.size <= 0 || st.size > JSON_MAX_BYTES) return null;
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = memo.get(abs);
  if (hit && hit.stamp === stamp) return hit.view;
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return null; }
  const p = cachedView(abs, stamp, text);
  if (!p) return null;
  const seg = segmentsOf(p.view, 300);
  const view = Object.assign({ minified: p.minified, lines: p.minified ? p.view.split(/\r?\n/) : null }, seg);
  memo.set(abs, { stamp, view });
  while (memo.size > VIEW_MEMO_MAX) memo.delete(memo.keys().next().value);
  return view;
}

/** 给模型看的分段目录 */
function outlineText(abs, view, spanMax) {
  const head = view.minified
    ? `【JSON 分段目录】${abs}\n原文件是压缩的 JSON，已格式化成两格缩进的视图，共 ${view.total} 行。下面的行号都是格式化视图的行号，read_file 带 startLine/endLine 读到的也是格式化视图。`
    : `【JSON 分段目录】${abs}\n共 ${view.total} 行，太长不整读。下面的行号就是原文件行号。`;
  const rows = view.segments.map((s) => `- ${s.name} :${s.line}-${s.endLine}`);
  const find = view.minified
    ? '原文件只有几行，search_text 命中的行号对不上格式化视图，按下面的路径挑段读。改这个文件时 edit_file 的 old_string 要按原文的压缩写法（没有换行和缩进）。'
    : '找具体键或值先用 search_text 拿行号。';
  return [
    head,
    `按需用 read_file 的 startLine/endLine 只读要用的段（一次最多 ${spanMax} 行），禁止从头到尾把整份读完。${find}`,
    ...rows
  ].join('\n');
}

module.exports = { SEG_LINES, JSON_MAX_BYTES, segmentsOfText, jsonView, outlineText };
