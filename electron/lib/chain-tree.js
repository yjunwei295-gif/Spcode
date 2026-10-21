// 链路导图：把回复正文里的【链路】段拆成一条从左到右的调用链，落盘到方案目录，重开程序还能取回。
// 只负责「解析 / 组装 / 存取」，着色和绘制在 renderer/chain-map.js。
// 与 plan-tree.js 分开：节点字段、文件名、画法都不共用，避免方案导图的改动影响链路图。
const fs = require('fs');
const path = require('path');

// 【链路】段的起始标记；结束标记允许省略，省略时取到下一个独立标签行（如【方案验收】）之前
const CHAIN_OPEN = '【链路】';
const CHAIN_CLOSE = '【/链路】';

// 步骤行里字段之间的分隔符：模型写成全角竖线或半角竖线都能切开
const FIELD_SPLIT = /[｜|]/;
// 字段名别名：同一个含义在不同回复里叫法不同，统一映射到固定字段
const FIELD_ALIAS = {
  作用: 'role',
  具体实现: 'impl',
  实现: 'impl',
  影响: 'impact',
  会改变什么: 'impact',
  位置: 'file',
  文件: 'file',
  '文件·方法': 'file',
  文件方法: 'file',
  上游: 'up',
  上游调用者: 'up',
  调用者: 'up'
};
// 三类节点：入口列 → 中间列 → 展示列
const KIND_ENTRY = '入口';
const KIND_MIDDLE = '中间';
const KIND_SHOW = '展示';

/** 独立成行的标签（如「【方案验收：未通过】」），用来判断【链路】段在哪结束 */
function isTagLine(line) {
  return /^\s*【[^】]+】\s*$/.test(String(line || ''));
}

/**
 * 取出回复正文里的【链路】段正文（不含起止标记）。
 * 有【/链路】就取到它之前；没写结束标记时逐行取到下一个独立标签行为止，
 * 这样后面接【方案验收】之类段落时不会把那些行误当成链路步骤。
 * @param {string} text 助手回复正文；空或非字符串时返回空串
 * @returns {string} 段内正文；没有【链路】标记时返回空串
 */
function chainBlockOf(text) {
  const raw = String(text || '');
  const start = raw.indexOf(CHAIN_OPEN);
  if (start < 0) return '';
  const body = raw.slice(start + CHAIN_OPEN.length);
  const closeAt = body.indexOf(CHAIN_CLOSE);
  if (closeAt >= 0) return body.slice(0, closeAt);
  const lines = body.split(/\r?\n/);
  const kept = [];
  for (let i = 0; i < lines.length; i++) {
    if (isTagLine(lines[i])) break;
    kept.push(lines[i]);
  }
  return kept.join('\n');
}

/**
 * 判断步骤标题里写明的节点类型。
 * 模型一般写成「打开按钮（入口）」，也接受开头直接写类型；没写就返回空串，由调用方按位置推断。
 * @param {string} title 步骤标题原文
 * @returns {string} 入口 / 中间 / 展示；认不出返回空串
 */
function kindOfTitle(title) {
  const s = String(title || '');
  if (/[（(]入口[)）]/.test(s) || /^入口/.test(s)) return KIND_ENTRY;
  if (/[（(]展示[)）]/.test(s) || /[（(]出口[)）]/.test(s) || /^展示/.test(s)) return KIND_SHOW;
  if (/[（(]中间[)）]/.test(s) || /^中间/.test(s)) return KIND_MIDDLE;
  return '';
}

/** 去掉标题里的类型括号，标题只留步骤自身的名字 */
function titleOfStep(title) {
  return String(title || '')
    .replace(/[（(](入口|中间|展示|出口)[)）]/g, '')
    .trim();
}

/**
 * 把一行步骤解析成节点字段。
 * 行格式：「1. 步骤名（入口）｜作用：…｜实现：…｜影响：…｜位置：文件:行号｜上游：…」
 * 行首编号、列表符号先剥掉；整行没有竖线时退回用分号切，模型偶尔会用分号分隔字段。
 * @param {string} raw 原始行
 * @param {number} no 步骤编号（1 起，调用方给）
 * @returns {object|null} 解析出的节点；空行、纯标记行返回 null
 */
function parseStepLine(raw, no) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return null;
  if (isTagLine(trimmed)) return null;
  const clean = trimmed.replace(/^[-*•]\s*/, '').replace(/^\d+\s*[.、)]\s*/, '').trim();
  if (!clean) return null;
  let parts = clean.split(FIELD_SPLIT);
  if (parts.length === 1) parts = clean.split(/[；;]/);
  const head = String(parts[0] || '').trim();
  if (!head) return null;
  const node = {
    id: `c${no}`,
    no: no,
    index: no - 1,
    kind: kindOfTitle(head),
    title: titleOfStep(head),
    role: '',
    impl: '',
    impact: '',
    file: '',
    up: ''
  };
  // 标题被分号切成「步骤名」以外的东西时，把没带字段名的段并回标题，避免丢信息
  for (let i = 1; i < parts.length; i++) {
    const piece = String(parts[i] || '').trim();
    if (!piece) continue;
    const m = piece.match(/^([^:：]{1,12})\s*[:：]\s*([\s\S]*)$/);
    const key = m ? FIELD_ALIAS[m[1].trim()] : '';
    if (key) {
      node[key] = String(m[2] || '').trim();
      continue;
    }
    node.title = `${node.title} ${piece}`.trim();
  }
  return node;
}

/**
 * 按位置补齐没写类型的节点：第一条算入口，最后一条算展示，中间的都算中间。
 * 只有一条时按展示处理（单步链路就是一环落地）。
 * @param {object[]} nodes 已解析出的节点数组，原地修改
 * @returns {object[]} 传进来的同一个数组
 */
function fillMissingKinds(nodes) {
  const total = nodes.length;
  for (let i = 0; i < total; i++) {
    const n = nodes[i];
    if (n.kind) continue;
    if (total === 1) {
      n.kind = KIND_SHOW;
      continue;
    }
    if (i === 0) {
      n.kind = KIND_ENTRY;
      continue;
    }
    if (i === total - 1) {
      n.kind = KIND_SHOW;
      continue;
    }
    n.kind = KIND_MIDDLE;
  }
  return nodes;
}

/**
 * 解析回复正文里的【链路】段。
 * @param {string} text 助手回复正文
 * @returns {object[]} 链路节点数组（入口在前、展示在后）；没有段或拆不出步骤时返回空数组
 */
function parseChainItems(text) {
  const block = chainBlockOf(text);
  if (!block) return [];
  const lines = block.split(/\r?\n/);
  const nodes = [];
  for (let i = 0; i < lines.length; i++) {
    const node = parseStepLine(lines[i], nodes.length + 1);
    if (!node) continue;
    nodes.push(node);
  }
  return fillMissingKinds(nodes);
}

/**
 * 把节点组装成导图数据：节点带三类列信息，连线按相邻顺序串成一条链。
 * @param {object[]} items parseChainItems 的返回值
 * @returns {{nodes:object[], edges:object[], state:string}} 导图数据；state 固定为 chain，前端据此知道有内容
 */
function mapOf(items) {
  const list = Array.isArray(items) ? items : [];
  const nodes = [];
  const edges = [];
  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    nodes.push({
      id: it.id,
      no: it.no,
      index: it.index,
      kind: it.kind,
      title: it.title,
      role: it.role,
      impl: it.impl,
      impact: it.impact,
      file: it.file,
      up: it.up
    });
    if (i > 0) edges.push({ from: list[i - 1].id, to: it.id });
  }
  return { nodes, edges, state: 'chain' };
}

/**
 * 链路图的落盘文件名：会话 id + 本轮回复编号。
 * 两者都可能带路径分隔符等字符，统一替换成下划线并截断，避免拼出目录外的路径。
 * @param {string} tabId 会话 id
 * @param {string} turnId 本轮回复编号
 * @returns {string} 形如 chain_<tabId>_<turnId>.json 的文件名
 */
function chainFileName(tabId, turnId) {
  const safeId = String(tabId || '').replace(/[^\w-]+/g, '_').slice(0, 60) || 'default';
  const safeTurn = String(turnId || '').replace(/[^\w-]+/g, '_').slice(0, 60) || 'turn';
  return `chain_${safeId}_${safeTurn}.json`;
}

/**
 * 链路图落盘。
 * @param {string} dir 链路目录（agent.chainDirOf 给的方案会话目录），不存在时递归创建
 * @param {string} tabId 会话 id
 * @param {string} turnId 本轮回复编号
 * @param {object} map mapOf 的返回值
 * @returns {string} 写出的文件绝对路径
 * 副作用：在 dir 下写一个 JSON 文件，内容含 tabId / turnId / savedAt / nodes / edges。
 */
function save(dir, tabId, turnId, map) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, chainFileName(tabId, turnId));
  const payload = {
    tabId: String(tabId || ''),
    turnId: String(turnId || ''),
    savedAt: Date.now(),
    nodes: (map && map.nodes) || [],
    edges: (map && map.edges) || []
  };
  fs.writeFileSync(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return file;
}

/**
 * 读回链路图。
 * 文件不存在返回 null（表示这条回复没落过链路图，是正常情况）；
 * 文件在但内容坏掉时不吞异常，照原样抛给调用方，避免把损坏数据当成「没有链路」。
 * @param {string} dir 链路目录
 * @param {string} tabId 会话 id
 * @param {string} turnId 本轮回复编号
 * @returns {object|null} 落盘的导图数据；没有文件时 null
 */
function read(dir, tabId, turnId) {
  const file = path.join(dir, chainFileName(tabId, turnId));
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = { parseChainItems, mapOf, save, read, chainBlockOf };
