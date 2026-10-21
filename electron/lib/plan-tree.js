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
  // 只兜底无编号头、只在标准格式零命中时触发：字段块 → 列表格式 → 章节标题式，逐级尝试
  if (!good.length) {
    const loose = parseLooseItems(text, keep.join('\n'));
    if (loose.ok) return loose;
    const bullets = parseFileBullets(text);
    if (bullets.ok) return bullets;
    return parseFileSections(text);
  }
  return { items: good, keep: keep.join('\n'), ok: good.length > 0 };
}

/**
 * 兜底解析「缺编号条目头」的字段块：把以「文件：」开头的行当成新条目起点，其余字段按 FIELD_RE/readField 读取。
 * 只兜底无编号头、只在 parseItems 标准格式零命中时由 parseItems 调用；正常写了编号的方案不会走到这里，
 * 以免把正文里的零散字段误当成条目。赋值规则和 parseItems 保持一致（含「（新建）」去尾、反引号/星号清理）。
 * @param {string} text 整段方案正文
 * @param {string} keepText parseItems 已经收到的「不动范围」原文；没收到时传空串
 * @returns {{items: Array, keep: string, ok: boolean}} 只保留带 file 的条目（导图条目没有文件就对不上出处），ok 由条目数决定
 * 副作用：无。遇到「不动范围」行即停止建条目，它后面的非空行并入 keep。
 */
function parseLooseItems(text, keepText) {
  const lines = lf(text).split('\n');
  const items = [];
  const base = String(keepText || '').trim();
  const keep = [];
  if (base) keep.push(base);
  const tail = [];
  let stop = false;
  let cur = null;
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    // 见到「不动范围」就封口：后面的内容只当原文保留，不再开新条目
    if (KEEP_HEAD_RE.test(line)) {
      stop = true;
      cur = null;
      const rest = line.replace(KEEP_HEAD_RE, '').replace(/^[\s*:：]+/, '').trim();
      if (rest) tail.push(rest);
      i++;
      continue;
    }
    if (stop) {
      if (line.trim()) tail.push(line.trim());
      i++;
      continue;
    }
    if (!FIELD_RE.test(line)) { i++; continue; }
    const name = line.match(FIELD_RE)[1];
    const f = readField(lines, i);
    if (name === '文件') {
      // 「文件：」既是字段也是条目起点，编号按已拆出的条数往后排
      cur = { no: items.length + 1, title: '', file: '', method: '', requirement: '', before: '', beforeIsCode: false, after: '', afterIsCode: false, verify: '' };
      // 「a/b.cs（新建）」这类括号说明不是路径的一部分，去掉后记成新建文件
      let file = f.value.split('\n')[0].replace(/[`*]/g, '').trim();
      const note = file.match(NEW_NOTE_RE);
      if (note) { file = file.slice(0, note.index).trim(); cur.newFile = true; }
      cur.file = file;
      // 导图条目文件夹名不能为空，标题取文件路径最后一段
      const segs = file.split(/[\\/]/);
      cur.title = String(segs[segs.length - 1] || file).trim();
      items.push(cur);
    }
    else if (cur && name === '方法') cur.method = f.value.split('\n')[0].replace(/[`*]/g, '').trim();
    else if (cur && name === '需求') cur.requirement = f.value;
    else if (cur && name === '现状原文') { cur.before = f.value; cur.beforeIsCode = f.code; }
    else if (cur && name === '改成') { cur.after = f.value; cur.afterIsCode = f.code; }
    else if (cur && name === '验证') cur.verify = f.value;
    i = f.next;
  }
  // parseItems 可能已经把「不动范围」正文收进 keepText，这里只补它没收到的行，避免重复
  for (let i = 0; i < tail.length; i++) {
    if (!base || base.indexOf(tail[i]) < 0) keep.push(tail[i]);
  }
  const good = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].file) good.push(items[i]);
  }
  return { items: good, keep: keep.join('\n'), ok: good.length > 0 };
}

// 列表条目认得的文件后缀；与实际方案里会点名的源码/资源类型保持一致
const BULLET_EXT_RE = 'cs|js|mjs|cjs|ts|tsx|jsx|vue|py|lua|java|kt|go|rs|c|cc|cpp|h|hpp|swift|json|ya?ml|xml|md|txt|css|scss|html|shader|hlsl|compute|uss|uxml|prefab|unity|asset|ps1|bat|sh';
/**
 * 列表条目头：列表符号/序号 + 文件路径 + 分隔冒号 + 改动要求。
 * 路径外面允许四种包法：裸路径、`反引号`、**粗体**、**`粗体＋反引号`**（真实方案里常出现最后一种）；
 * 路径和冒号之间还允许一段「→ 方法名」，写成「1. `a.js` → `fn`：要求」时把箭头后点到的内容记成定位提示。
 * 分组：1=文件路径，2=箭头后点到的方法或范围（可能没有，也可能写了几个用顿号隔开），3=改动要求。
 */
const BULLET_HEAD_RE = new RegExp(
  '^\\s*(?:[-*+]|\\d+[.、)）])\\s+' +                 // 列表符号，或「1.」「2、」这类序号
  '[`*]{0,4}' +                                       // 路径前面的反引号/粗体标记
  '([^`\\n*]+?\\.(?:' + BULLET_EXT_RE + '))' +        // 路径本体：不含反引号和星号，免得把标记吃进路径
  '[`*]{0,4}' +                                       // 路径后面的反引号/粗体标记
  '(?:\\s*(?:→|->)\\s*([^\\n:：]{0,120}?))?' +        // 可选：箭头右边点到的方法或范围
  '\\s*[:：]\\s*\\*{0,2}\\s*(.*)$',                    // 分隔冒号，冒号后是改动要求
  'i'
);

/**
 * 读取聊天里已有的“文件名：改动要求”列表，保留原文而不调用模型重写。
 * 仅当标准条目格式未命中时使用；文件前的约束和列表后的说明保留到不动范围。
 * 支持裸路径、反引号、粗体、粗体＋反引号四种路径包法，以及「路径 → 方法：要求」的写法；
 * 箭头后点到的方法只作定位提示（多个方法之间保留原文分隔符），完整说法仍留在改动要求里。
 */
function parseFileBullets(text) {
  const head = BULLET_HEAD_RE;
  const items = [];
  const shared = [];
  let cur = null;
  let footer = false;
  let fenced = false;
  let verify = '';
  for (const line of lf(text).split('\n')) {
    if (/^\s*```/.test(line)) fenced = !fenced;
    const hit = !fenced && !footer ? line.match(head) : null;
    if (hit) {
      const file = hit[1].trim();
      // 箭头右边点到的方法可能写成 `a`、`b`（用顿号隔开），去掉反引号/星号后只留文字作定位提示
      const arrowMethod = String(hit[2] || '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
      cur = { no: items.length + 1, title: file, file, method: arrowMethod, requirement: String(hit[3] || '').trim(), before: '', beforeIsCode: false, after: '', afterIsCode: false, verify: '' };
      items.push(cur);
      continue;
    }
    if (!fenced && /^(?:\*\*)?(?:验证|验收|结果区分|不动范围)\s*[:：]/.test(line)) footer = true;
    if (footer || !cur) {
      shared.push(line);
      if (/^(?:\*\*)?(?:验证|验收)\s*[:：]/.test(line)) verify = line.replace(/^(?:\*\*)?(?:验证|验收)\s*[:：]\s*/, '');
    } else {
      cur.requirement += `\n${line}`;
    }
  }
  for (const it of items) {
    it.requirement = it.requirement.trim();
    // 箭头已指出方法时以它为准；否则只取明确标注的第一个方法作定位提示，多个方法的完整需求仍在原文中。
    if (!it.method) {
      const method = it.requirement.match(/(?:在|方法\s*[:：])\s*`([\w.]+)`/);
      it.method = method ? method[1] : '';
    }
    it.verify = verify;
  }
  return { items, keep: shared.join('\n').trim(), ok: items.length > 0 };
}

// 章节标题行：「一、`a/b.cs`」「三、验收」「1. `OnEnable`（56-83）：…」这类行首带序号的标题。
// 序号允许中文数字、ASCII 数字，也允许「（一）」「(1)」「[2]」这种括起来的写法；序号后跟顿号/句点/右括号，再接标题正文。
const SECTION_HEAD_RE = new RegExp(
  '^\\s*#{0,4}\\s*[*_]{0,2}\\s*' +
  '(?:[(（\\[]\\s*(?:[一二三四五六七八九十]{1,3}|\\d{1,3})\\s*[)）\\]]\\s*' +   // 「（一）」「(1)」「[2]」
  '|(?:[一二三四五六七八九十]{1,3}|\\d{1,3})\\s*[、.．)）])\\s*' +            // 「一、」「1.」「2)」
  '(.+?)\\s*$'                                                              // 标题正文
);
// 标题正文里第一个带后缀的路径；后缀直接沿用 BULLET_EXT_RE，保证章节标题与列表两种写法认得同一批文件类型
const SECTION_PATH_RE = new RegExp('([^\\s`*:：，,]+?\\.(?:' + BULLET_EXT_RE + '))', 'i');

/**
 * 章节标题式方案的第四级兜底：标题里点名文件，标题下面的行整段记成该条需求。
 * 真实方案常写成「一、`Script/x/Foo.cs`」当章节标题，标题下面用「1. `OnEnable`（56-83）：删除日志」列方法改动，
 * 前三路（标准条目 / 无编号字段块 / 列表）全零命中时，靠这一级按「点名文件的标题」切出条目。
 * @param {string} text 整段方案正文
 * @returns {{items: Array, keep: string, ok: boolean}} items 只保留 file 非空的条目（导图条目没有文件就对不上出处）；
 *   keep 是不属于任何条目的原文（开头的说明、「不动范围」及其之后的内容）；ok 由条目数决定
 * 只在 parseItems 的前三级全部零命中时由 parseItems 调用，不改动其它解析器的判定与优先级。
 * 副作用：无。``` 围起来的代码块里的行一律不判标题，免得把示例正文当成条目标题。
 */
function parseFileSections(text) {
  const lines = lf(text).split('\n');
  const items = [];
  const keep = [];
  let cur = null;      // 当前条目：标题点名文件时新建，遇到下一个点名文件的标题再换
  let stop = false;    // 已进入「不动范围」，后面只作原文保留
  let fenced = false;  // 是否处在 ``` 代码块里
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 只有围栏行本身切换代码块状态；围栏行按普通内容处理（它不可能是标题）
    const isFence = /^\s*```/.test(line);
    if (isFence) fenced = !fenced;
    // 见到「不动范围」就封口：后面的内容只当原文保留，不再开新条目（与 parseItems/parseLooseItems 一致）
    if (!isFence && !fenced && KEEP_HEAD_RE.test(line)) {
      stop = true;
      cur = null;
      const rest = line.replace(KEEP_HEAD_RE, '').replace(/^[\s*:：]+/, '').trim();
      if (rest) keep.push(rest);
      continue;
    }
    if (stop) {
      if (line.trim()) keep.push(line.trim());
      continue;
    }
    const head = !isFence && !fenced ? line.match(SECTION_HEAD_RE) : null;
    if (head) {
      const rest = String(head[1] || '');
      // 「四、不动范围：…」这种带序号的收尾标题，KEEP_HEAD_RE 认不出前面的序号，这里拿标题正文再判一次
      if (KEEP_HEAD_RE.test(rest)) {
        stop = true;
        cur = null;
        const tailText = rest.replace(KEEP_HEAD_RE, '').replace(/^[\s*:：]+/, '').trim();
        if (tailText) keep.push(tailText);
        continue;
      }
      // 「三、验收：…」这类整份方案的收尾标题不属于某个文件的改动，收进原文，不再并进当前条目
      if (/^(?:\*\*)?(?:验证|验收|结果区分)\s*(?:[:：]|$)/.test(rest)) {
        cur = null;
        if (line.trim()) keep.push(line.trim());
        continue;
      }
      const hitPath = rest.match(SECTION_PATH_RE);
      if (!hitPath) {
        // 标题没点文件：当前条目已开着时它是条目内的子标题（如「1. `OnEnable`（56-83）：…」），整行并进需求；
        // 还没开条目就只当原文保留，不伪造条目
        if (cur) cur.requirement += '\n' + line;
        else if (line.trim()) keep.push(line.trim());
        continue;
      }
      // 标题点名了文件：开新条目；标题取文件路径最后一段（导图条目文件夹名不能为空，与另外两个解析器一致）
      const file = hitPath[1].replace(/[`*]/g, '').trim();
      const segs = file.split(/[\\/]/);
      cur = { no: items.length + 1, title: String(segs[segs.length - 1] || file).trim(), file, method: '', requirement: '', before: '', beforeIsCode: false, after: '', afterIsCode: false, verify: '' };
      items.push(cur);
      continue;
    }
    // 普通行：条目开着就整行并进需求（保留原换行与缩进），否则留给原文
    if (cur) cur.requirement += '\n' + line;
    else if (line.trim()) keep.push(line.trim());
  }
  const good = [];
  for (let i = 0; i < items.length; i++) {
    items[i].requirement = String(items[i].requirement || '').trim();
    if (items[i].file) good.push(items[i]);
  }
  return { items: good, keep: keep.join('\n').trim(), ok: good.length > 0 };
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
  const nodes = [{ id: '需求', path: '需求', desc: String(tree.requirement || ''), requirement: tree.requirement || '', keep: tree.keep || '', status: '' }];
  const edges = [];
  for (const it of tree.items.filter((item) => !DONE_STATUS.has(item.status))) {
    const id = itemDirName(it);
    // 列表格式原来只用文件名作标题；展示时取需求首句，不改变已保存条目的身份或执行内容。
    const summary = String(it.requirement || '').replace(/[`*]/g, '').split(/[\n。；]/)[0].trim();
    const title = it.title === it.file && summary ? summary : it.title;
    // 将原有方案详情完整传给导图，不再只传文件名与状态。
    nodes.push({
      id, path: id, no: it.no, title, desc: title, status: it.status, file: it.file,
      method: it.method || '', requirement: it.requirement || '', verify: it.verify || '',
      before: it.before || '', after: it.after || '', keep: tree.keep || '',
      reason: it.reason || '', verdict: it.verdict || ''
    });
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
 * 删除条目后把编号压实成 1..n：先按 no 升序排，再依次重编号。
 * 方案的「### N.」是条目标识，删掉中间一条会留下空号，方案文件、导图侧栏和派单里说的“第 N 条”就对不上了。
 * 参数 items：方案条目数组；返回重排并重编号后的数组（条目对象本身被原地改 no，其余字段不动）。
 */
function renumber(items) {
  const list = (items || []).slice().sort((a, b) => (Number(a.no) || 0) - (Number(b.no) || 0));
  for (let i = 0; i < list.length; i += 1) list[i].no = i + 1;
  return list;
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

module.exports = { STATUS, DONE_STATUS, NEW_FILE, parseItems, locate, acceptItem, build, recheck, save, load, mapOf, mismatches, itemDirName, isNewFile, squash, merge, serializeTree, renumber };
