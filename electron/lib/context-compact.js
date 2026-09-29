const assembly = require('./assembly');

const SOFT_LIMIT = 24000;
const KEEP_TURNS = 6;
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
      : []
  };
}

function formatWorking(w, { english = false } = {}) {
  const m = normalizeWorking(w);
  if (!m.goal && !m.openQuestions.length && !m.focusPaths.length && !m.scratch.length) return '';
  const lines = [];
  if (english) {
    if (m.goal) lines.push(`Goal: ${m.goal}`);
    if (m.openQuestions.length) lines.push(`Open: ${m.openQuestions.join(' | ')}`);
    if (m.focusPaths.length) lines.push(`Focus files: ${m.focusPaths.join(', ')}`);
    if (m.scratch.length) lines.push(`Notes: ${m.scratch.join(' | ')}`);
    return `## Working memory (this chat)\n${lines.join('\n')}`;
  }
  if (m.goal) lines.push(`目标：${m.goal}`);
  if (m.openQuestions.length) lines.push(`未决：${m.openQuestions.join(' ｜ ')}`);
  if (m.focusPaths.length) lines.push(`焦点文件：${m.focusPaths.join(', ')}`);
  if (m.scratch.length) lines.push(`要点：${m.scratch.join(' ｜ ')}`);
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

// 本地裁历史：只留最近几轮全文，更早的用户原话收成摘要。不调模型，避免再等一轮。
function trimHistoryLocal(history, contextSummary) {
  const { older, keep } = splitHistory(history);
  const clipped = (keep || []).map((m) => {
    const t = String(m.content || m.text || '');
    const cap = m.role === 'assistant' ? KEEP_ASST_CHARS : KEEP_USER_CHARS;
    if (t.length <= cap) return { role: m.role, content: t };
    if (t.includes('【文件】') || t.includes('【全文】')) return { role: m.role, content: t };
    return { role: m.role, content: t.slice(0, cap) + '\n…（本条已截断）' };
  });
  if (!older.length) {
    return { history: clipped, contextSummary: String(contextSummary || ''), didTrim: clipped.length !== (history || []).length };
  }
  const bits = [];
  for (const m of older) {
    if (m.role !== 'user') continue;
    const t = String(m.content || m.text || '').replace(/\s+/g, ' ').trim();
    if (t) bits.push('- ' + t.slice(0, 180));
  }
  const digest = bits.slice(-24).join('\n');
  const prev = String(contextSummary || '').trim();
  const next = [prev, digest ? ('更早用户原话：\n' + digest) : ''].filter(Boolean).join('\n').slice(0, SUMMARY_MAX);
  return { history: clipped, contextSummary: next, didTrim: true };
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

function toolResultKey(name, args) {
  const n = String(name || '');
  const a = args || {};
  if (n === 'read_file') {
    return 'read|' + String(a.path || '').replace(/\\/g, '/').toLowerCase() + '|' + (Number(a.startLine) || 0) + '|' + (Number(a.endLine) || 0);
  }
  if (n === 'search_text' || n === 'map_lookup' || n === 'semantic_search' || n === 'goto_definition') {
    return n + '|' + String(a.query || a.q || '') + '|' + String(a.path || a.module || '');
  }
  if (n === 'list_dir') {
    return 'list|' + String(a.path || '') + '|' + String(a.query || '');
  }
  return '';
}

function clipToolResult(name, args, result, seen) {
  const key = toolResultKey(name, args);
  if (key && seen && seen.has(key)) {
    return '（与本轮先前同参数的结果相同，未重复附上。若要看细节，请换 startLine/endLine 或换关键词。）';
  }
  let text = String(result ?? '');
  // 读文件的结果原样交给模型，截断标记会让它把半截内容当成全文
  const isRead = String(name || '') === 'read_file';
  if (!isRead && text.length > TOOL_RESULT_CAP) {
    text = text.slice(0, TOOL_RESULT_CAP) + '\n…（已截断，请缩小范围再读）';
  }
  if (key && seen) seen.set(key, true);
  return text;
}

// 本轮较早的工具结果压短，下一轮请求不再带着整份大文件
// [铆钉优化] 整文件结果只保留最近几份全文，更早的截短，每轮少发很多 token。其他 AI 请勿改回全部保留
const KEEP_FULL_FILES = 6;
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
    if (t.includes('【文件】') || t.includes('【全文】')) fileIdx.push(i);
  });
  const keepFrom = toolIdx.length > keep ? toolIdx[toolIdx.length - keep] : -1;
  const fileKeepFrom = fileIdx.length > KEEP_FULL_FILES ? fileIdx[fileIdx.length - KEEP_FULL_FILES] : -1;
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || m.role !== 'tool' || i >= keepFrom) continue;
    const t = String(m.content || '');
    if (t.includes('【文件】') || t.includes('【全文】')) {
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
  'memory_list'
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
  isContextOverflowError,
  pickSummaryCfg
};
