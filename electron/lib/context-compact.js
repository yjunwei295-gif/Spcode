const assembly = require('./assembly');
const crypto = require('crypto');

const SOFT_LIMIT = 24000;
const KEEP_TURNS = 3;
const SUMMARY_MAX = 4000;

function emptyWorking() {
  return {
    goal: '',
    openQuestions: [],
    focusPaths: [],
    scratch: []
  };
}

function normalizeWorking(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  return {
    goal: String(w.goal || '').slice(0, 300),
    openQuestions: Array.isArray(w.openQuestions)
      ? w.openQuestions.map(String).filter(Boolean).slice(0, 12)
      : [],
    focusPaths: Array.isArray(w.focusPaths)
      ? [...new Set(w.focusPaths.map((p) => String(p).replace(/\\/g, '/')))].slice(0, 30)
      : [],
    scratch: Array.isArray(w.scratch)
      ? w.scratch.map(String).filter(Boolean).slice(0, 12)
      : [],
    todos: Array.isArray(w.todos) ? w.todos.map(normalizeTodo).filter(Boolean).slice(0, TODO_MAX) : []
  };
}

const TODO_MAX = 30;
const TODO_STATUS = new Set(['pending', 'in_progress', 'completed', 'cancelled']);

function normalizeTodo(t) {
  if (!t || typeof t !== 'object') return null;
  const id = String(t.id || '').trim().slice(0, 60);
  const content = String(t.content || '').trim().slice(0, 300);
  if (!id || !content) return null;
  return { id, content, status: TODO_STATUS.has(t.status) ? t.status : 'pending' };
}

/** merge=true 按 id 更新已有条目、追加新条目；merge=false 整份替换 */
function mergeTodos(current, incoming, merge) {
  const list = Array.isArray(incoming) ? incoming : [];
  if (!merge) return list.map(normalizeTodo).filter(Boolean).slice(0, TODO_MAX);
  const out = current.map((t) => ({ ...t }));
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const id = String(raw.id || '').trim();
    const hit = out.find((t) => t.id === id);
    if (hit) {
      if (typeof raw.content === 'string' && raw.content.trim()) hit.content = raw.content.trim().slice(0, 300);
      if (TODO_STATUS.has(raw.status)) hit.status = raw.status;
    } else {
      const t = normalizeTodo(raw);
      if (t) out.push(t);
    }
  }
  return out.slice(0, TODO_MAX);
}

const TODO_TAG = { pending: '待办', in_progress: '进行中', completed: '完成', cancelled: '取消' };

function formatWorking(w, { english = false } = {}) {
  const m = normalizeWorking(w);
  if (!m.goal && !m.openQuestions.length && !m.focusPaths.length && !m.scratch.length && !m.todos.length) return '';
  const lines = [];
  if (english) {
    if (m.goal) lines.push(`Goal: ${m.goal}`);
    if (m.openQuestions.length) lines.push(`Open: ${m.openQuestions.join(' | ')}`);
    if (m.focusPaths.length) lines.push(`Focus files: ${m.focusPaths.join(', ')}`);
    if (m.scratch.length) lines.push(`Notes: ${m.scratch.join(' | ')}`);
    if (m.todos.length) lines.push(`Todos:\n${m.todos.map((t) => `- [${t.status}] ${t.id}: ${t.content}`).join('\n')}`);
    return `## Working memory (this chat)\n${lines.join('\n')}`;
  }
  if (m.goal) lines.push(`目标：${m.goal}`);
  if (m.openQuestions.length) lines.push(`未决：${m.openQuestions.join(' ｜ ')}`);
  if (m.focusPaths.length) lines.push(`焦点文件：${m.focusPaths.join(', ')}`);
  if (m.scratch.length) lines.push(`要点：${m.scratch.join(' ｜ ')}`);
  if (m.todos.length) lines.push(`任务清单：\n${m.todos.map((t) => `- [${TODO_TAG[t.status]}] ${t.id}：${t.content}`).join('\n')}`);
  return `## 工作记忆（本会话）\n${lines.join('\n')}`;
}

function patchWorking(current, patch) {
  const w = normalizeWorking(current);
  if (!patch || typeof patch !== 'object') return w;
  if (typeof patch.goal === 'string') w.goal = patch.goal.slice(0, 300);
  if (Array.isArray(patch.openQuestions)) {
    w.openQuestions = patch.openQuestions.map(String).filter(Boolean).slice(0, 12);
  }
  if (Array.isArray(patch.focusPaths)) {
    w.focusPaths = [...new Set(patch.focusPaths.map((p) => String(p).replace(/\\/g, '/')))].slice(0, 30);
  }
  if (Array.isArray(patch.scratch)) {
    w.scratch = patch.scratch.map(String).filter(Boolean).slice(0, 12);
  }
  if (typeof patch.addScratch === 'string' && patch.addScratch.trim()) {
    w.scratch = [...w.scratch, patch.addScratch.trim()].slice(-12);
  }
  if (typeof patch.addQuestion === 'string' && patch.addQuestion.trim()) {
    w.openQuestions = [...new Set([...w.openQuestions, patch.addQuestion.trim()])].slice(0, 12);
  }
  if (Array.isArray(patch.todos)) w.todos = mergeTodos(w.todos, patch.todos, !!patch.todoMerge);
  return w;
}

function msgChars(m) {
  if (!m) return 0;
  if (typeof m.content === 'string') return m.content.length;
  if (typeof m.text === 'string') return m.text.length;
  if (Array.isArray(m.content)) {
    return m.content.map((p) => (p?.text || p?.image_url?.url || '')).join('').length;
  }
  return 0;
}

function estimateSize({ systemText = '', history = [], userText = '' }) {
  let n = String(systemText || '').length + String(userText || '').length;
  for (const m of history || []) n += msgChars(m) + 16;
  return n;
}

function needsCompact({ systemText, history, userText, contextSummary }) {
  const base = estimateSize({ systemText, history, userText }) + String(contextSummary || '').length;
  return base > SOFT_LIMIT;
}

function splitHistory(history, keepTurns = KEEP_TURNS) {
  const list = (history || []).filter((m) => m.role === 'user' || m.role === 'assistant');
  if (list.length <= keepTurns * 2) {
    return { keep: list, older: [] };
  }
  const keepCount = keepTurns * 2;
  return {
    older: list.slice(0, list.length - keepCount),
    keep: list.slice(list.length - keepCount)
  };
}

const KEEP_ASST_CHARS = 2500;
const KEEP_USER_CHARS = 4000;
const TOOL_RESULT_CAP = 8000;
const OLD_TOOL_CHARS = 400;

const INDEX_MAX_CHARS = 6000;
function oneLine(t) { return String(t || '').replace(/\s+/g, ' ').trim(); }

// 一轮的索引行：有总结出来的索引就用，没有就拿原话和回复开头拼一条简易索引
function roundIndexLine(r) {
  const idx = r.index && (r.index.title || r.index.summary) ? r.index : null;
  if (idx) {
    const title = oneLine(idx.title);
    const summary = oneLine(idx.summary);
    return `#R${r.round} ${title}${summary ? ' — ' + summary : ''}`.slice(0, 400);
  }
  const u = oneLine(r.user).slice(0, 80);
  const a = oneLine(r.assistant).slice(0, 120);
  return `#R${r.round} ${u}${a ? ' — ' + a : ''}`;
}

// 按轮次分组：消息带 round 就用，没带就按用户消息计数
function roundsOf(messages) {
  const map = new Map();
  let n = 0;
  for (const m of messages || []) {
    if (m.role === 'user') n += 1;
    const round = Number(m.round) || n || 1;
    if (!map.has(round)) map.set(round, { round, user: '', assistant: '', index: null });
    const r = map.get(round);
    const text = String(m.content || m.text || '');
    if (m.role === 'user') r.user = r.user ? `${r.user}\n${text}` : text;
    else r.assistant = r.assistant ? `${r.assistant}\n${text}` : text;
    if (m.index) r.index = m.index;
  }
  return Array.from(map.values());
}

// 更早轮次的索引文字；太长时只留最近的
function indexTextOf(older) {
  const lines = roundsOf(older).map(roundIndexLine);
  const out = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 1;
    if (size > INDEX_MAX_CHARS) {
      out.unshift(`（更早的 ${i + 1} 轮没列出）`);
      break;
    }
    out.unshift(lines[i]);
  }
  return out.join('\n');
}

// 本地裁历史：只留最近几轮全文，更早的轮次换成对话索引。不调模型，避免再等一轮。
function trimHistoryLocal(history, contextSummary) {
  const { older, keep } = splitHistory(history);
  const clipped = (keep || []).map((m) => {
    const t = String(m.content || m.text || '');
    const cap = m.role === 'assistant' ? KEEP_ASST_CHARS : KEEP_USER_CHARS;
    if (t.length <= cap) return { role: m.role, content: t };
    if (t.includes('【文件】') || t.includes('【全文】')) return { role: m.role, content: t };
    return { role: m.role, content: t.slice(0, cap) + '\n…（本条已截断）' };
  });
  const prev = String(contextSummary || '');
  if (!older.length) {
    return { history: clipped, contextSummary: prev, indexText: '', didTrim: clipped.length !== (history || []).length };
  }
  return { history: clipped, contextSummary: prev, indexText: indexTextOf(older), didTrim: true };
}

// 一轮只留标题；总结模型还没出标题时拿用户原话开头顶上
function roundTitleLine(r) {
  const title = oneLine(r.index && r.index.title);
  return `#R${r.round} ${(title || oneLine(r.user).slice(0, 60) || '（空）')}`.slice(0, 120);
}

// 历史全部换成标题索引，不发任何全文；太长时只留最近的
function titleIndexOf(history) {
  const lines = roundsOf(history).map(roundTitleLine);
  const out = [];
  let size = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    size += lines[i].length + 1;
    if (size > INDEX_MAX_CHARS) {
      out.unshift(`（更早的 ${i + 1} 轮没列出）`);
      break;
    }
    out.unshift(lines[i]);
  }
  return out.join('\n');
}

function formatIndexForPrompt(indexText, { english = false } = {}) {
  const s = String(indexText || '').trim();
  if (!s) return '';
  return english
    ? `## Conversation index\nPrevious rounds are NOT included in the messages; only their titles are listed here, one per line: #id title. When you need what was said in a round (including the latest one), call dialog_lookup with the id first; never guess from the title. Rounds the user marked as not applicable are removed; do not bring them up.\n${s}`
    : `## 对话索引\n之前的对话不在消息里，这里只列每轮标题，每行一轮：#编号 标题。需要某一轮说了什么（包括最近一轮）就先用 dialog_lookup 传编号查原文，禁止凭标题猜。用户标了不适用的轮次已经去掉，不要提起。\n${s}`;
}

function replaceFullBlock(text, filePath) {
  const esc = String(filePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const note = '【全文】' + filePath + '\n（文件未改，全文见较新一轮）\n【全文结束】' + filePath;
  const closed = new RegExp('【全文】' + esc + '\\n[\\s\\S]*?【全文结束】' + esc, 'g');
  const next = text.replace(closed, note);
  if (next !== text) return next;
  const legacy = new RegExp('【全文】' + esc + '\\n[\\s\\S]*?(?=\\n【全文】|\\n`|\\n【项目|$)');
  return text.replace(legacy, '【全文】' + filePath + '\n（文件未改，全文见较新一轮）\n');
}

// 同一文件的全文只留最新一份。本轮已经附上的，历史里不再复制一份
function collapseDuplicateFullText(history, currentText) {
  const list = history || [];
  const seen = new Set();
  const head = /【全文】([^\n]*)/g;
  let m;
  const cur = String(currentText || '');
  while ((m = head.exec(cur))) {
    const p = m[1].trim();
    if (p) seen.add(p);
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const raw = String(list[i].content || list[i].text || '');
    if (raw.indexOf('【全文】') < 0) continue;
    const paths = [];
    const r = /【全文】([^\n]*)/g;
    let mm;
    while ((mm = r.exec(raw))) paths.push(mm[1].trim());
    const kill = [];
    for (const p of paths) {
      if (!p || p.indexOf('文件未改') >= 0) continue;
      if (seen.has(p)) kill.push(p);
      else seen.add(p);
    }
    if (!kill.length) continue;
    let t = raw;
    for (const p of kill) t = replaceFullBlock(t, p);
    list[i] = { role: list[i].role, content: t };
  }
  return list;
}

// 按路径和文件版本折叠重复整读，避免重复正文占用历史上下文。
function collapseRepeatReads(history) {
  const list = history || [];
  const seen = new Set();
  let changed = false;
  for (let i = list.length - 1; i >= 0; i--) {
    const item = list[i];
    if (!item || typeof item.content !== 'string') continue;
    const content = item.content;
    const fileTag = '【文件】';
    const fileAt = content.indexOf(fileTag);
    if (fileAt < 0 || content.indexOf('全文', fileAt) < 0) continue;
    const lineEnd = content.indexOf('\n', fileAt);
    const header = content.slice(fileAt, lineEnd < 0 ? content.length : lineEnd);
    if (header.indexOf('全文') < 0) continue;
    const mtimeLabel = 'mtimeMs';
    const bytesLabel = 'bytes';
    const mtimeAt = header.indexOf(mtimeLabel);
    const bytesAt = header.indexOf(bytesLabel);
    if (mtimeAt < 0 || bytesAt < 0) continue;

    let pathEnd = header.length;
    if (mtimeAt < pathEnd) pathEnd = mtimeAt;
    if (bytesAt < pathEnd) pathEnd = bytesAt;
    const fullTextAt = header.indexOf('全文');
    if (fullTextAt >= 0 && fullTextAt < pathEnd) pathEnd = fullTextAt;
    let filePath = header.slice(fileTag.length, pathEnd).trim();
    while (filePath && ' ：:|，,;；-'.indexOf(filePath[filePath.length - 1]) >= 0) {
      filePath = filePath.slice(0, -1).trim();
    }
    if (!filePath) continue;

    function readNumber(labelAt, label) {
      let pos = labelAt + label.length;
      while (pos < header.length && (' ：:=|，,;；'.indexOf(header[pos]) >= 0 || header.charCodeAt(pos) <= 32)) pos++;
      const start = pos;
      while (pos < header.length && header.charCodeAt(pos) >= 48 && header.charCodeAt(pos) <= 57) pos++;
      return pos > start ? header.slice(start, pos) : '';
    }

    const mtimeMs = readNumber(mtimeAt, mtimeLabel);
    const byteCount = readNumber(bytesAt, bytesLabel);
    if (!mtimeMs || !byteCount) continue;
    const key = filePath + '|' + mtimeMs + '|' + byteCount;
    if (seen.has(key)) {
      item.content = '【同一版本，未改动】' + filePath + ' 的整读结果已在新一轮出现，内容同上';
      changed = true;
    } else {
      seen.add(key);
    }
  }
  return changed;
}

function toolResultKey(name, args) {
  const n = String(name || '');
  const a = args || {};
  if (n === 'read_file') {
    return 'read|' + String(a.path || '').replace(/\\/g, '/').toLowerCase() + '|' + (Number(a.startLine) || 0) + '|' + (Number(a.endLine) || 0);
  }
  if (n === 'map_lookup') {
    return 'map|' + JSON.stringify([a.module || '', a.symbol || '', a.startLine ?? null, a.endLine ?? null, a.query || '', a.path || '', a.limit ?? null]);
  }
  if (n === 'search_text' || n === 'map_lookup' || n === 'semantic_search' || n === 'goto_definition') {
    return n + '|' + String(a.symbol || a.query || a.q || '') + '|' + String(a.path || a.module || '');
  }
  if (n === 'list_dir') {
    return 'list|' + String(a.path || '') + '|' + String(a.query || '');
  }
  return '';
}

function clipToolResult(name, args, result, seen) {
  const key = toolResultKey(name, args);
  let text = String(result ?? '');
  const digest = key ? crypto.createHash('sha256').update(text).digest('hex') : '';
  if (key && seen && seen.get(key) === digest) {
    return '（与本轮先前同参数的结果相同，未重复附上。若要看细节，请换 startLine/endLine 或换关键词。）';
  }
  // 读文件的结果原样交给模型，截断标记会让它把半截内容当成全文
  // 地图条目详情与 read_file 一样返回完整区间，不能被普通工具输出上限截成半个方法。
  const isRead = String(name || '') === 'read_file'
    || (name === 'map_lookup' && text.startsWith('【原文·可直接用】'));
  if (!isRead && text.length > TOOL_RESULT_CAP) {
    text = text.slice(0, TOOL_RESULT_CAP) + '\n…（已截断，请缩小范围再读）';
  }
  // 同参数读到新内容必须返回；否则改完再读会被误当重复，诱发额外搜索/回改。
  if (key && seen) seen.set(key, digest);
  return text;
}

// 本轮较早的工具结果压短，下一轮请求不再带着整份大文件
// [铆钉优化] 整文件结果只保留最近几份全文，更早的截短，每轮少发很多 token。其他 AI 请勿改回全部保留
const KEEP_FULL_FILES = 3;
const OLD_FILE_CHARS = 1500;
function shrinkOlderToolMessages(messages, keepLast) {
  const keep = keepLast == null ? 2 : keepLast;
  const list = messages || [];
  const toolIdx = [];
  const fileIdx = [];
  list.forEach((m, i) => {
    if (!m || m.role !== 'tool') return;
    toolIdx.push(i);
    const t = String(m.content || '');
    if (t.includes('【文件】') || t.includes('【全文】') || t.startsWith('【原文·可直接用】')) fileIdx.push(i);
  });
  const keepFrom = toolIdx.length > keep ? toolIdx[toolIdx.length - keep] : -1;
  const fileKeepFrom = fileIdx.length > KEEP_FULL_FILES ? fileIdx[fileIdx.length - KEEP_FULL_FILES] : -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || m.role !== 'tool' || i >= keepFrom) continue;
    const t = String(m.content || '');
    if (t.includes('【文件】') || t.includes('【全文】') || t.startsWith('【原文·可直接用】')) {
      if (i < fileKeepFrom && t.length > OLD_FILE_CHARS) {
        m.content = t.slice(0, OLD_FILE_CHARS) + '\n…（较早读过的文件已截短，要改这个文件请重新 read_file）';
      }
      continue;
    }
    if (t.length > OLD_TOOL_CHARS) m.content = t.slice(0, OLD_TOOL_CHARS) + '\n…（较早的工具结果已省略）';
  }
  return list;
}

// 与 Cursor 同轮策略一致：只读可并行，写入/删除/命令/提问必须串行
const PARALLEL_TOOLS = new Set([
  'read_file',
  'list_dir',
  'search_text',
  'semantic_search',
  'map_lookup',
  'goto_definition',
]);

function isParallelTool(name) {
  return PARALLEL_TOOLS.has(String(name || ''));
}

// 改代码才算实现；思考轮数只卡只读，一旦写/删/建目录就不再吃用户设的轮数上限
const IMPLEMENT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'delete_file',
  'create_dir',
  'mkdir'
]);

function isImplementTool(name) {
  return IMPLEMENT_TOOLS.has(String(name || ''));
}

function callsIncludeImplement(calls) {
  return (calls || []).some((tc) => isImplementTool(tc?.function?.name || tc?.name || ''));
}

/** 思考预算：未开始改代码时，thinkUsed 用尽就该收尾；实现中始终放开（另有安全上限） */
function thinkBudgetOpen({ thinkUsed, thinkLimit, implementing }) {
  if (implementing) return true;
  const used = Number(thinkUsed) || 0;
  const limit = Number(thinkLimit) || 0;
  return used < limit;
}

const FILE_KEY_EXT = 'js|jsx|ts|tsx|mjs|cjs|cs|json|css|html|vue|py|cpp|h|hpp|cc|prefab|unity|xml|yml|yaml|shader|hlsl|ps1|java|go|rs|lua|sql|md|php|rb';
const FILE_KEY_RE = new RegExp(
  '(?:[A-Za-z]:[\\\\/])?(?:[\\w.@(){}\\[\\]-]+[\\\\/])*[\\w.@(){}\\[\\]-]+\\.(?:' + FILE_KEY_EXT + ')',
  'gi'
);

function normFileKey(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase();
}

function fileKeysFromText(text) {
  const keys = [];
  const seen = new Set();
  const re = new RegExp(FILE_KEY_RE.source, 'gi');
  let m;
  while ((m = re.exec(String(text || '')))) {
    const key = normFileKey(m[0]);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function keysConflict(a, b) {
  if (!a.length || !b.length) return true;
  const set = new Set(a);
  return b.some((k) => set.has(k));
}

function argsOfCall(tc, readArgs) {
  if (typeof readArgs === 'function') {
    try { return readArgs(tc) || {}; } catch { return {}; }
  }
  const raw = tc?.function?.arguments ?? tc?.arguments;
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

// 不同文件的写入、或不同文件的代码派单，可以并成一波。看不出路径，或撞到同一文件，就单独排队
function fileParallelKeys(name, args) {
  args = args || {};
  if (name === 'write_file' || name === 'edit_file') {
    const key = normFileKey(args.path);
    return key ? [key] : [];
  }
  if (name === 'call_worker' && String(args.role || 'code') === 'code') {
    return fileKeysFromText(args.task);
  }
  return null;
}

/**
 * 把本轮 tool_calls 切开。
 * 连续只读并成一波。不同文件的 write_file，或不同文件的 code 派单，也并成一波。
 * 同一文件、删文件、命令、规划派单各自单独一波。
 */
function splitToolWaves(calls, readArgs) {
  const waves = [];
  for (const tc of calls || []) {
    const name = tc?.function?.name || tc?.name || '';
    if (isParallelTool(name)) {
      // search / semantic_search 单独串行：两路同时扫盘最容易把电脑卡死
      if (name === 'search_text' || name === 'semantic_search') {
        waves.push({ parallel: false, kind: 'serial', calls: [tc] });
        continue;
      }
      const last = waves[waves.length - 1];
      if (last && last.kind === 'read') last.calls.push(tc);
      else waves.push({ parallel: true, kind: 'read', calls: [tc] });
      continue;
    }
    const keys = fileParallelKeys(name, argsOfCall(tc, readArgs));
    if (keys && keys.length) {
      const last = waves[waves.length - 1];
      if (last && last.kind === 'file' && last.tool === name && !keysConflict(last.keys, keys)) {
        last.calls.push(tc);
        last.keys = last.keys.concat(keys);
      } else {
        waves.push({ parallel: true, kind: 'file', tool: name, calls: [tc], keys: keys.slice() });
      }
      continue;
    }
    waves.push({ parallel: false, kind: 'serial', calls: [tc] });
  }
  return waves;
}

function formatDialog(messages) {
  return (messages || []).map((m) => {
    const role = m.role === 'user' ? '用户' : '助手';
    const text = typeof m.content === 'string' ? m.content : (m.text || '');
    return `${role}：${String(text).slice(0, 2000)}`;
  }).join('\n\n');
}

function summarizePrompt({ oldSummary, olderMessages, lang }) {
  const en = lang && lang.code && lang.code !== 'zh' && lang.code !== 'zh-Hant';
  if (en) {
    return `Compress earlier chat into a rolling context summary for the coding agent.
Keep: goals, decisions, changed file paths, constraints, open questions. Do not invent.
Max ${SUMMARY_MAX} characters. Output plain text only.

Previous summary:
${String(oldSummary || '(none)').slice(0, 3000)}

Older messages:
${formatDialog(olderMessages).slice(0, 12000)}`;
  }
  return `把更早的对话压缩成滚动上下文摘要，供编程助手继续用。
必须保留：目标、结论、改过的路径、用户约束、未决问题。禁止编造。
不超过 ${SUMMARY_MAX} 字。只输出摘要正文。

旧摘要：
${String(oldSummary || '（无）').slice(0, 3000)}

更早对话：
${formatDialog(olderMessages).slice(0, 12000)}`;
}

function mergeSummary(oldSummary, newPart) {
  const s = String(newPart || '').trim() || String(oldSummary || '').trim();
  return s.slice(0, SUMMARY_MAX);
}

function formatSummaryForPrompt(summary, { english = false } = {}) {
  const s = String(summary || '').trim();
  if (!s) return '';
  return english
    ? `## Earlier conversation summary\n${s}`
    : `## 更早对话摘要\n${s}`;
}

function isContextOverflowError(err) {
  const msg = String(err && err.message || err || '');
  return /No sequences left|context.*(length|overflow|exceed)|maximum context|prompt.*(too long|too large)|上下文/i.test(msg);
}

/**
 * 压缩历史：返回 keep 消息 + 新摘要
 */
async function compactHistory({
  history,
  contextSummary,
  modelCfg,
  summarySlotCfg,
  completeFn,
  lang,
  signal,
  onEvent
}) {
  const { older, keep } = splitHistory(history);
  if (!older.length) {
    return { history: keep, contextSummary: contextSummary || '', didCompact: false };
  }
  if (onEvent) onEvent({ type: 'think', text: '上下文过长，已自动总结更早对话' });
  if (onEvent) onEvent({ type: 'context_compacted' });
  if (onEvent) onEvent({ type: 'status', text: '正在压缩更早对话…' });
  const cfg = summarySlotCfg || modelCfg;
  const prompt = summarizePrompt({ oldSummary: contextSummary, olderMessages: older, lang });
  const msg = await completeFn({
    modelCfg: cfg,
    messages: [{ role: 'user', content: prompt }],
    noTools: true,
    signal,
    onDelta: () => {},
    onWait: () => {}
  });
  const text = String(msg?.content || msg?.text || '').trim();
  const nextSummary = mergeSummary(contextSummary, text);
  return { history: keep, contextSummary: nextSummary, didCompact: true };
}

function pickSummaryCfg(vs, primaryCfg) {
  if (!vs) return primaryCfg;
  const hit = assembly.resolveRole(vs, 'summary');
  if (!hit?.slot) return primaryCfg;
  const cfg = assembly.slotToModelCfg(hit.slot, vs);
  return cfg || primaryCfg;
}

module.exports = {
  SOFT_LIMIT,
  KEEP_TURNS,
  TOOL_RESULT_CAP,
  emptyWorking,
  normalizeWorking,
  formatWorking,
  patchWorking,
  estimateSize,
  needsCompact,
  splitHistory,
  trimHistoryLocal,
  collapseDuplicateFullText,
  collapseRepeatReads,
  toolResultKey,
  clipToolResult,
  shrinkOlderToolMessages,
  PARALLEL_TOOLS,
  isParallelTool,
  IMPLEMENT_TOOLS,
  isImplementTool,
  callsIncludeImplement,
  thinkBudgetOpen,
  splitToolWaves,
  compactHistory,
  formatSummaryForPrompt,
  formatIndexForPrompt,
  titleIndexOf,
  roundsOf,
  isContextOverflowError,
  pickSummaryCfg
};
