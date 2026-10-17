// 方案树：把锁定的方案拆成一条一条的文件夹，每条都要程序对上出处才算数。
// 开工前核对「现状原文」真在点名文件里；做完核对「改成」进了文件、原文被替换。AI 说了不算。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const NEW_FILE = '新建文件';
const STATUS = {
  check: '待核对',
  ready: '可开工',
  mismatch: '不一致',
  running: '进行中',
  pass: '通过',
  back: '退回'
};
const DONE_STATUS = new Set([STATUS.pass]);

function safeName(s) {
  return String(s || '').replace(/[<>:"/\\|?*\r\n\t]/g, '').trim().slice(0, 40) || '未名';
}
function squash(s) { return String(s || '').replace(/\s+/g, ''); }
function lf(s) { return String(s || '').replace(/\r\n/g, '\n'); }
function sha1(s) { return crypto.createHash('sha1').update(String(s)).digest('hex'); }
function countOf(hay, needle) {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

// 字段后面紧跟的代码块；没有代码块就取到下一个字段前的文字
const FIELD_RE = /^\s*(?:[-*]\s*)?(文件|方法|需求|现状原文|改成|验证)\s*[:：]\s*(.*)$/;
function readField(lines, i) {
  const first = lines[i].match(FIELD_RE)[2].trim();
  // 值是代码块：同一行就是 ```，或者下面跳过空行后是 ```
  let k = i;
  if (!first) { k = i + 1; while (k < lines.length && !lines[k].trim()) k++; }
  const openLine = first || lines[k] || '';
  if (/^```/.test(openLine.trim())) {
    const body = [];
    let m = k + 1;
    while (m < lines.length && !/^\s*```\s*$/.test(lines[m])) { body.push(lines[m]); m++; }
    return { value: body.join('\n'), code: true, next: m + 1 };
  }
  const out = first ? [first] : [];
  let j = i + 1;
  while (j < lines.length && !FIELD_RE.test(lines[j]) && !ITEM_HEAD_RE.test(lines[j]) && !KEEP_HEAD_RE.test(lines[j])) {
    out.push(lines[j]);
    j++;
  }
  return { value: out.join('\n').trim(), code: false, next: j };
}

const ITEM_HEAD_RE = /^\s*#{0,4}\s*(\d{1,3})\s*[.、)）]\s*(.+?)\s*$/;
const KEEP_HEAD_RE = /^\s*#{0,4}\s*(?:\*\*)?\s*不动范围/;

/** 按固定格式拆条目：### 1. 标题 / 文件 / 方法 / 现状原文 / 改成 / 验证；最后「不动范围」。至少一条带文件才算拆得出 */
function parseItems(text) {
  const lines = lf(text).split('\n');
  const items = [];
  let cur = null;
  let keep = [];
  let inKeep = false;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (KEEP_HEAD_RE.test(line)) {
      inKeep = true;
      cur = null;
      const rest = line.replace(KEEP_HEAD_RE, '').replace(/^[\s*:：]+/, '').trim();
      if (rest) keep.push(rest);
      i++;
      continue;
    }
    const head = line.match(ITEM_HEAD_RE);
    // 编号行后面几行内有「文件：」才算条目头，防止把字段里的编号列表当成新条目
    if (head && !inKeep && lines.slice(i + 1, i + 8).some((l) => /^\s*(?:[-*]\s*)?文件\s*[:：]/.test(l))) {
      cur = { no: Number(head[1]), title: head[2].replace(/[*#]/g, '').trim(), file: '', method: '', requirement: '', before: '', beforeIsCode: false, after: '', afterIsCode: false, verify: '' };
      items.push(cur);
      i++;
      continue;
    }
    if (inKeep) { if (line.trim()) keep.push(line.trim()); i++; continue; }
    if (cur && FIELD_RE.test(line)) {
      const name = line.match(FIELD_RE)[1];
      const f = readField(lines, i);
      if (name === '文件') {
        // 「a/b.cs（新建）」这类括号说明不是路径的一部分，去掉后记成新建文件
        let file = f.value.split('\n')[0].replace(/[`*]/g, '').trim();
        const note = file.match(NEW_NOTE_RE);
        if (note) { file = file.slice(0, note.index).trim(); cur.newFile = true; }
        cur.file = file;
      }
      else if (name === '方法') cur.method = f.value.split('\n')[0].replace(/[`*]/g, '').trim();
      else if (name === '需求') cur.requirement = f.value;
      else if (name === '现状原文') { cur.before = f.value; cur.beforeIsCode = f.code; }
      else if (name === '改成') { cur.after = f.value; cur.afterIsCode = f.code; }
      else if (name === '验证') cur.verify = f.value;
      i = f.next;
      continue;
    }
    i++;
  }
  const good = items.filter((it) => it.file);
  return { items: good, keep: keep.join('\n'), ok: good.length > 0 };
}

const NEW_NOTE_RE = /\s*[(（【\[][^()（）【】\[\]]*(?:新建|新增|新文件)[^()（）【】\[\]]*[)）】\]]\s*$/;
const NEW_WORDS = new Set(['新文件', '新建文件', '新增文件', '新建', '新增', '无', '空']);

/** 现状原文写的是新建文件的说法（带不带括号、代码块都认），或留空而文件行/标题/方法说了新建 */
function isNewFile(item) {
  if (item.newFile) return true;
  const word = String(item.before || '').replace(/[()（）【】\[\]「」"'`。.,，:：\s-]/g, '');
  if (NEW_WORDS.has(word)) return true;
  return !word && /新建|新增|新文件/.test(`${item.title || ''} ${item.method || ''}`);
}

/** 在文件里定位现状原文：精确找；找不到按逐行去首尾空白再找。返回行号或不一致原因 */
function locate(item, resolve) {
  const abs = resolve(item.file);
  if (isNewFile(item)) {
    if (abs && fs.existsSync(abs)) return { ok: false, abs, reason: '方案说是新文件，但文件已经存在' };
    return { ok: true, abs: abs || '', isNew: true };
  }
  if (!abs || !fs.existsSync(abs)) return { ok: false, abs: abs || '', missing: true, reason: `文件不存在：${item.file}。要新建这个文件就在现状原文写「新建文件」，改成里写完整内容` };
  if (!item.before.trim()) return { ok: false, abs, reason: '没写现状原文（要放在代码块里）' };
  let text = '';
  try { text = lf(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return { ok: false, abs, reason: `读不了文件：${e.message}` }; }
  const want = lf(item.before);
  const lines = text.split('\n');
  const n = countOf(text, want);
  const wantLines = want.split('\n');
  if (n === 1) {
    const line = text.slice(0, text.indexOf(want)).split('\n').length;
    return { ok: true, abs, line, endLine: line + wantLines.length - 1, finger: sha1(text), count: countOf(squash(text), squash(want)) };
  }
  if (n > 1) return { ok: false, abs, reason: `现状原文在文件里出现了 ${n} 处，要多带几行让它唯一` };
  const wantT = wantLines.map((l) => l.trim());
  const hits = [];
  for (let i = 0; i + wantT.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < wantT.length; j++) if (lines[i + j].trim() !== wantT[j]) { ok = false; break; }
    if (ok) hits.push(i);
  }
  if (hits.length === 1) return { ok: true, abs, line: hits[0] + 1, endLine: hits[0] + wantT.length, finger: sha1(text), count: countOf(squash(text), squash(want)) };
  if (hits.length > 1) return { ok: false, abs, reason: `现状原文在文件里出现了 ${hits.length} 处，要多带几行让它唯一` };
  return { ok: false, abs, reason: '现状原文不在这个文件里（可能是凭印象写的，或代码已经变了）' };
}

/** 做完一条后的机械验收：改成进了文件、原文被替换（改成本身包含原文时不要求原文消失）、文件确实动过 */
function acceptItem(item, resolve, changedAbs) {
  const abs = resolve(item.file);
  if (!abs || !fs.existsSync(abs)) return { pass: false, reason: `文件不存在：${item.file}` };
  let text = '';
  try { text = lf(fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return { pass: false, reason: `读不了文件：${e.message}` }; }
  const touched = changedAbs ? changedAbs(abs) : true;
  const flat = squash(text);
  if (!item.afterIsCode) {
    if (!touched) return { pass: false, reason: '点名的文件没有改动' };
    return { pass: true, semantic: true, reason: '改成是说明，程序只核了文件有改动，需总结模型核对内容是否符合需求' };
  }
  const after = squash(item.after);
  if (after && !flat.includes(after)) return { pass: false, reason: '「改成」的内容不在文件里' };
  if (!isNewFile(item)) {
    const before = squash(item.before);
    if (before && !after.includes(before)) {
      const now = countOf(flat, before);
      const was = Number(item.beforeCount) || 1;
      if (now >= was) return { pass: false, reason: '现状原文还在，没有被替换' };
    }
  }
  if (!touched && !(after && flat.includes(after))) return { pass: false, reason: '点名的文件没有改动' };
  return { pass: true, semantic: false, reason: '改成已在文件里，现状原文已替换' };
}

function itemDirName(it) { return `${String(it.no).padStart(2, '0')}-${safeName(it.title)}`; }

function itemMd(it) {
  return [
    `# ${it.no}. ${it.title}`,
    '',
    `状态：${it.status}`,
    it.reason ? `说明：${it.reason}` : '',
    `文件：${it.file}`,
    it.method ? `方法：${it.method}` : '',
    it.requirement ? `需求：${it.requirement}` : '',
    it.verify ? `验证：${it.verify}` : ''
  ].filter((l) => l !== '').join('\n') + '\n';
}

/** 状态落盘：每条一个文件夹 + state.json + 待办.jsonl + 导图 JSON。state.json 是程序的依据，其余是给人看的镜像 */
function save(dir, tree) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '需求.md'), `# 需求\n\n${tree.requirement || ''}\n\n## 不动范围\n\n${tree.keep || '（没写）'}\n`, 'utf8');
  const keepDirs = new Set();
  for (const it of tree.items.filter((item) => !DONE_STATUS.has(item.status))) {
    const d = path.join(dir, itemDirName(it));
    keepDirs.add(path.basename(d));
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '条目.md'), itemMd(it), 'utf8');
    fs.writeFileSync(path.join(d, '现状原文.txt'), it.before || '', 'utf8');
    fs.writeFileSync(path.join(d, '改成.txt'), it.after || '', 'utf8');
    fs.writeFileSync(path.join(d, '出处.txt'), it.abs ? `${it.abs}${it.line ? `:${it.line}-${it.endLine}` : ''}\n指纹：${it.finger || ''}\n` : '', 'utf8');
    fs.writeFileSync(path.join(d, '验收.md'), it.verdict || '（还没验收）\n', 'utf8');
  }
  // 方案重拆后旧条目的文件夹删掉，避免导图里留着过期节点
  try {
    for (const n of fs.readdirSync(dir)) {
      const p = path.join(dir, n);
      if (/^\d{2}-/.test(n) && !keepDirs.has(n) && fs.statSync(p).isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    }
  } catch { /* 目录读不了就不清 */ }
  const pending = tree.items.filter((it) => !DONE_STATUS.has(it.status)).map((it) => JSON.stringify({ no: it.no, title: it.title, status: it.status }));
  fs.writeFileSync(path.join(dir, '待办.jsonl'), pending.length ? pending.join('\n') + '\n' : '', 'utf8');
  fs.writeFileSync(path.join(dir, 'PLAN_MAP.auto.json'), JSON.stringify(mapOf(tree), null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(tree, null, 2), 'utf8');
}

function load(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; }
}

function mapOf(tree) {
  const nodes = [{ id: '需求', path: '需求', desc: String(tree.requirement || '').slice(0, 80), status: '' }];
  const edges = [];
  for (const it of tree.items.filter((item) => !DONE_STATUS.has(item.status))) {
    const id = itemDirName(it);
    // 节点附带条目编号 no，前端删除条目时按编号精确定位
    nodes.push({ id, path: id, no: it.no, desc: it.title, status: it.status, file: it.file, reason: it.reason || '' });
    edges.push({ from: '需求', to: id });
  }
  return { version: 1, name: '方案', generatedAt: new Date().toISOString(), nodes, edges };
}

/** 拆方案：每条写的是需求。拆不出条目返回 null，调用方退回单文件方案。定方案阶段不做现状比对，统一标「可开工」 */
function build(planText, requirement, resolve) {
  const parsed = parseItems(planText);
  if (!parsed.ok) return null;
  const tree = { version: 1, hash: sha1(planText), requirement: String(requirement || '').slice(0, 2000), keep: parsed.keep, items: [] };
  for (const it of parsed.items) {
    tree.items.push(Object.assign(it, { status: STATUS.ready, reason: '', abs: resolve(it.file) || '', line: 0, endLine: 0, finger: '', beforeCount: 1 }));
  }
  return tree;
}

/** 开始时复核：做完的条目复核还对得上；没做完的条目不再比对现状原文，统一回「可开工」，执行时才定位、验收时才比对 */
function recheck(tree, resolve) {
  for (const it of tree.items) {
    if (DONE_STATUS.has(it.status)) {
      const acc = acceptItem(it, resolve, null);
      if (!acc.pass) { it.status = STATUS.back; it.reason = `之前通过，现在对不上了：${acc.reason}`; }
      continue;
    }
    it.status = STATUS.ready;
    it.reason = '';
  }
  return tree;
}

function mismatches(tree) { return tree.items.filter((it) => it.status === STATUS.mismatch); }

function itemKey(it) {
  return `${squash(it.file).toLowerCase()}\0${squash(it.before)}\0${squash(it.requirement || '')}`;
}

/** 把条目写成固定格式，写入方案文件后锁的 hash 和树一致。写需求（没给现状原文）的条目不补「新建文件」，避免重读时被误判成新文件 */
function serializeItem(it) {
  const lines = [
    `### ${it.no}. ${it.title}`,
    `文件：${it.file}`,
    it.method ? `方法：${it.method}` : '',
    it.requirement ? `需求：${it.requirement}` : ''
  ];
  // 现状原文只在真的给了代码、或确实是新文件时才写
  if (isNewFile(it)) {
    lines.push(`现状原文：${NEW_FILE}`);
  } else if (it.before && String(it.before).trim()) {
    lines.push(it.beforeIsCode ? `现状原文：\n\`\`\`\n${it.before}\n\`\`\`` : `现状原文：${it.before}`);
  }
  // 改成只在真的写了内容时才输出
  if (it.after && String(it.after).trim()) {
    lines.push(it.afterIsCode ? `改成：\n\`\`\`\n${it.after}\n\`\`\`` : `改成：${it.after}`);
  }
  if (it.verify) lines.push(`验证：${it.verify}`);
  return lines.filter(Boolean).join('\n');
}

function serializeTree(tree) {
  const parts = (tree.items || []).map(serializeItem);
  if (tree.keep) parts.push(`不动范围：${tree.keep}`);
  return parts.join('\n\n');
}

/**
 * 有未完成旧条目时：新方案追加进去（同文件+同现状原文则更新改成/验证），已通过的保留。
 * 没有未完成旧条目时整份重建。返回的 tree.serialized 是应写入方案文件的全文。
 */
function merge(oldTree, planText, requirement, resolve) {
  const pending = (oldTree && oldTree.items || []).filter((it) => !DONE_STATUS.has(it.status));
  // 只有完全没有旧树时才整份重建；旧树还在就一律合并（已通过的旧条目也保留），
  // 免得用户写入新方案时把上一版方案整份抹掉——清理只发生在整体验收通过 retirePlanFile
  if (!oldTree || !(oldTree.items || []).length) {
    const tree = build(planText, requirement, resolve);
    if (tree) tree.serialized = serializeTree(tree);
    return tree;
  }
  const parsed = parseItems(planText);
  if (!parsed.ok) return null;
  const done = (oldTree.items || []).filter((it) => DONE_STATUS.has(it.status)).map((it) => ({ ...it }));
  const live = pending.map((it) => ({ ...it }));
  const byKey = new Map(live.map((it) => [itemKey(it), it]));
  let maxNo = Math.max(0, ...oldTree.items.map((it) => Number(it.no) || 0));
  let added = 0;
  let updated = 0;
  for (const neu of parsed.items) {
    const hit = byKey.get(itemKey(neu));
    if (hit) {
      hit.after = neu.after;
      hit.afterIsCode = neu.afterIsCode;
      hit.verify = neu.verify || hit.verify;
      hit.title = neu.title || hit.title;
      hit.method = neu.method || hit.method;
      if (neu.before) { hit.before = neu.before; hit.beforeIsCode = neu.beforeIsCode; }
      hit.requirement = neu.requirement || hit.requirement;
      hit.newFile = !!neu.newFile || hit.newFile;
      updated += 1;
    } else {
      maxNo += 1;
      const copy = Object.assign({}, neu, { no: maxNo });
      live.push(copy);
      byKey.set(itemKey(copy), copy);
      added += 1;
    }
  }
  const keep = [oldTree.keep, parsed.keep].filter(Boolean).join('\n');
  const req = [
    oldTree.requirement,
    requirement,
    ...pending.map((it) => `未完成：第 ${it.no} 条 ${it.title}`)
  ].filter(Boolean).join('\n').slice(0, 2000);
  const all = [...done, ...live].sort((a, b) => a.no - b.no);
  const items = [];
  for (const it of all) {
    if (DONE_STATUS.has(it.status)) items.push(it);
    else items.push(Object.assign(it, { status: STATUS.ready, reason: '', abs: resolve(it.file) || '', line: 0, endLine: 0, finger: '' }));
  }
  const tree = { version: 1, hash: '', requirement: req, keep, items, merged: { added, updated } };
  tree.serialized = serializeTree(tree);
  tree.hash = sha1(tree.serialized);
  return tree;
}

module.exports = { STATUS, DONE_STATUS, NEW_FILE, parseItems, locate, acceptItem, build, recheck, save, load, mapOf, mismatches, itemDirName, isNewFile, squash, merge, serializeTree };
