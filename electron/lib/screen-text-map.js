// 本地屏幕 OCR。截图只在主进程内存中处理，不写盘、不发起网络请求。
// [铆钉优化] AGI（原「活过来」）重做：常驻 OCR 引擎、按需观察（画面没变复用结果）、行级中心坐标、帧编号锁定点击坐标系，其他 AI 请勿改回每 2.5 秒轮询/每次新建引擎/字符画。
const fs = require('fs');
const path = require('path');

const MAX_LINES = 120;
const MAX_TEXT_CHARS = 5000;
const MAX_CAPTURE_EDGE = 1920;
const MIN_CONFIDENCE = 45;
const REUSE_MS = 20000;
const OCR_IDLE_MS = 5 * 60 * 1000;
const OCR_RETRY_MS = 60 * 1000;
const HASH_W = 128;
const HASH_H = 72;

const SCREEN_BEGIN = '【屏幕文字】';
const SCREEN_END = '【屏幕文字结束】';

function localTessdataPath() {
  const { app } = require('electron');
  const asarAt = __dirname.search(/[\\/]app\.asar[\\/]/);
  const candidates = [
    ...(app.isPackaged ? [path.join(process.resourcesPath, 'app-root', 'ocr', 'tessdata')] : []),
    // 从 app.asar 里加载时，模型在同级 resources/app-root/ocr
    ...(asarAt >= 0 ? [path.join(__dirname.slice(0, asarAt), 'app-root', 'ocr', 'tessdata')] : []),
    path.join(__dirname, '..', '..', 'resources', 'ocr', 'tessdata')
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir, 'eng.traineddata')) &&
    fs.existsSync(path.join(dir, 'chi_sim.traineddata'))) || candidates[0];
}

// ---------- OCR 引擎：常驻几个 worker，把屏幕切成横条并行识别，闲置 5 分钟关掉 ----------
// 实测 1920×1080：单 worker 约 5 秒，4 条并行约 2.3 秒
const BAND_OVERLAP = 40;
let ocrWorkers = null;
let ocrStarting = null;
let ocrQueue = Promise.resolve();
let ocrIdleTimer = null;
let ocrBrokenAt = 0;
let ocrBrokenMsg = '';

function workerCount() {
  const cpus = require('os').cpus().length || 2;
  return Math.max(1, Math.min(4, Math.floor(cpus / 3)));
}

async function startOcr() {
  const tessdata = localTessdataPath();
  for (const name of ['eng.traineddata', 'chi_sim.traineddata']) {
    if (!fs.existsSync(path.join(tessdata, name))) {
      throw new Error(`离线 OCR 模型缺失：${path.join(tessdata, name)}`);
    }
  }
  const { createWorker } = require('tesseract.js');
  const diag = require('./diag');
  const make = async () => {
    // Electron 里 tesseract.js 判定环境为 electron，会把 langPath 当网址去 fetch 直接崩；
    // 改用 cachePath 读本地文件，readOnly 保证初始化失败时不会删掉模型文件。
    const worker = await createWorker('chi_sim+eng', 1, {
      langPath: tessdata,
      cachePath: tessdata,
      cacheMethod: 'readOnly',
      gzip: false,
      errorHandler: (err) => {
        diag.log('desktop', 'OCR 引擎报错', { message: String(err && err.message ? err.message : err).slice(0, 300) });
      }
    });
    // 11 = 稀疏文本：按界面元素切块，不会把多栏窗口拼成一整行
    await worker.setParameters({ tessedit_pageseg_mode: '11' });
    return worker;
  };
  return Promise.all(Array.from({ length: workerCount() }, make));
}

async function getOcr() {
  if (ocrWorkers) return ocrWorkers;
  if (ocrBrokenAt && Date.now() - ocrBrokenAt < OCR_RETRY_MS) throw new Error(ocrBrokenMsg);
  if (!ocrStarting) {
    ocrStarting = startOcr().then((list) => {
      ocrWorkers = list;
      ocrBrokenAt = 0;
      ocrBrokenMsg = '';
      return list;
    }).catch((err) => {
      ocrBrokenAt = Date.now();
      ocrBrokenMsg = `文字识别不可用：${err && err.message ? err.message : err}`;
      throw new Error(ocrBrokenMsg);
    }).finally(() => { ocrStarting = null; });
  }
  return ocrStarting;
}

function armIdleStop() {
  if (ocrIdleTimer) clearTimeout(ocrIdleTimer);
  ocrIdleTimer = setTimeout(() => { stopOcr(); }, OCR_IDLE_MS);
}

function stopOcr() {
  if (ocrIdleTimer) { clearTimeout(ocrIdleTimer); ocrIdleTimer = null; }
  const list = ocrWorkers;
  ocrWorkers = null;
  for (const w of list || []) w.terminate().catch(() => {});
}

function flattenLines(data) {
  const out = [];
  for (const block of (Array.isArray(data?.blocks) ? data.blocks : [])) {
    for (const para of (Array.isArray(block?.paragraphs) ? block.paragraphs : [])) {
      for (const line of (Array.isArray(para?.lines) ? para.lines : [])) out.push(line);
    }
  }
  return out;
}

// 重叠区里同一行会被两条各识别一次：框重叠过半就只留置信度高的
function dedupeOverlap(pieces) {
  const kept = [];
  for (const p of pieces.sort((a, b) => b.conf - a.conf)) {
    const area = Math.max(1, (p.x1 - p.x0) * (p.y1 - p.y0));
    const dup = kept.some((k) => {
      const w = Math.min(k.x1, p.x1) - Math.max(k.x0, p.x0);
      const h = Math.min(k.y1, p.y1) - Math.max(k.y0, p.y0);
      if (w <= 0 || h <= 0) return false;
      const small = Math.min(area, Math.max(1, (k.x1 - k.x0) * (k.y1 - k.y0)));
      return (w * h) / small > 0.6;
    });
    if (!dup) kept.push(p);
  }
  return kept;
}

// 返回原图像素坐标下的行片段 {text, x0, y0, x1, y1, conf}
function recognize(image) {
  const job = ocrQueue.then(async () => {
    const workers = await getOcr();
    armIdleStop();
    const { width, height } = image.getSize();
    const n = workers.length;
    const bandH = Math.ceil(height / n);
    const bands = [];
    for (let i = 0; i < n; i++) {
      const top = i * bandH;
      if (top >= height) break;
      const y = Math.max(0, top - BAND_OVERLAP);
      const h = Math.min(height, top + bandH + BAND_OVERLAP) - y;
      bands.push({ y, h, cutTop: i > 0, cutBottom: y + h < height });
    }
    const results = await Promise.all(bands.map((b, i) =>
      workers[i].recognize(image.crop({ x: 0, y: b.y, width, height: b.h }).toPNG())));
    const pieces = [];
    results.forEach((res, i) => {
      const b = bands[i];
      for (const line of flattenLines(res?.data)) {
        const box = line?.bbox;
        if (!box) continue;
        // 碰到切口的行在相邻条里是完整的，这里丢掉，避免半截字和重复
        if (b.cutTop && box.y0 <= 1) continue;
        if (b.cutBottom && box.y1 >= b.h - 1) continue;
        pieces.push({
          text: String(line.text || ''),
          conf: Number.isFinite(line.confidence) ? line.confidence : 100,
          x0: box.x0, x1: box.x1, y0: b.y + box.y0, y1: b.y + box.y1
        });
      }
    });
    return dedupeOverlap(pieces);
  });
  ocrQueue = job.catch(() => {});
  return job;
}

// ---------- 画面抓取 ----------
function pickDisplay() {
  const { screen } = require('electron');
  const desktopHand = require('./desktop-hand');
  const displays = screen.getAllDisplays();
  const locked = desktopHand.currentFrame && desktopHand.currentFrame();
  // AI 正在操作时锁定它上一次看的那块屏幕，避免用户鼠标挪到别的屏幕后坐标系跟着跳
  if (locked && desktopHand.isBusy && desktopHand.isBusy()) {
    const same = displays.find((d) => String(d.id) === String(locked.displayId));
    if (same) return same;
  }
  const point = screen.getCursorScreenPoint();
  return screen.getDisplayNearestPoint(point) || displays[0];
}

async function captureDisplay(display, maxEdge) {
  const { desktopCapturer } = require('electron');
  if (!display) throw new Error('没有可用的屏幕。');
  const dipWidth = Math.max(1, Math.round(display.size.width));
  const dipHeight = Math.max(1, Math.round(display.size.height));
  const scale = Math.min(1, (maxEdge || MAX_CAPTURE_EDGE) / Math.max(dipWidth, dipHeight));
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(dipWidth * scale), height: Math.round(dipHeight * scale) }
  });
  const source = sources.find((item) => String(item.display_id) === String(display.id)) || sources[0];
  if (!source || !source.thumbnail || source.thumbnail.isEmpty()) throw new Error('没有截到屏幕。');
  const size = source.thumbnail.getSize();
  return {
    image: source.thumbnail,
    width: size.width,
    height: size.height,
    originX: display.bounds.x,
    originY: display.bounds.y,
    dipWidth,
    dipHeight,
    displayId: display.id
  };
}

// 低分辨率灰度指纹，用来判断画面有没有变化
function frameHash(image) {
  const small = image.resize({ width: HASH_W, height: HASH_H, quality: 'good' });
  const bmp = small.toBitmap();
  const out = new Uint8Array(HASH_W * HASH_H);
  for (let i = 0, j = 0; j < out.length && i + 2 < bmp.length; i += 4, j++) {
    out[j] = (bmp[i + 2] * 299 + bmp[i + 1] * 587 + bmp[i] * 114) / 1000;
  }
  return out;
}

// 变化格子占比（0~1）。用占比而不是平均差：小弹窗、勾选框也能被发现
function hashDiff(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 8) changed++;
  return changed / a.length;
}

// 同一行上间距小的片段合并成一段（PSM 11 会把一句话切碎），间距大的是不同控件，保持分开
function mergeRow(pieces) {
  const rows = pieces.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const merged = [];
  for (const p of rows) {
    const h = p.y1 - p.y0;
    const cy = (p.y0 + p.y1) / 2;
    const host = merged.find((m) => {
      const mh = m.y1 - m.y0;
      const mcy = (m.y0 + m.y1) / 2;
      const gap = p.x0 - m.x1;
      return Math.abs(mcy - cy) < Math.min(h, mh) * 0.5 && gap >= -4 && gap < Math.max(h, mh) * 0.9;
    });
    if (host) {
      host.text = `${host.text}${/[\u4e00-\u9fff]$/.test(host.text) || /^[\u4e00-\u9fff]/.test(p.text) ? '' : ' '}${p.text}`;
      host.x1 = Math.max(host.x1, p.x1);
      host.y0 = Math.min(host.y0, p.y0);
      host.y1 = Math.max(host.y1, p.y1);
      host.conf = Math.min(host.conf, p.conf);
    } else {
      merged.push({ ...p });
    }
  }
  return merged;
}

// 行级文字 + 中心点坐标（图内坐标，单位与屏幕 DIP 一致）
function normalizeLines(pieces, scaleX, scaleY) {
  const clean = [];
  for (const p of pieces || []) {
    const text = String(p.text || '').replace(/\s+/g, ' ').trim();
    if (!text || p.conf < MIN_CONFIDENCE) continue;
    // 太扁的是下划线、分隔线被误认成字
    if ((p.y1 - p.y0) * scaleY < 5) continue;
    if (!/[\p{L}\p{N}]/u.test(text)) continue;
    // 单个拉丁字母或数字多半是图标被误认
    if (text.length === 1 && /[A-Za-z0-9]/.test(text)) continue;
    clean.push({ ...p, text });
  }
  const lines = mergeRow(clean).map((p) => ({
    text: p.text.slice(0, 160),
    x: Math.round(((p.x0 + p.x1) / 2) * scaleX),
    y: Math.round(((p.y0 + p.y1) / 2) * scaleY),
    w: Math.max(1, Math.round((p.x1 - p.x0) * scaleX)),
    h: Math.max(1, Math.round((p.y1 - p.y0) * scaleY))
  }));
  lines.sort((a, b) => (Math.abs(a.y - b.y) < 8 ? a.x - b.x : a.y - b.y));
  const kept = [];
  let chars = 0;
  for (const l of lines) {
    if (kept.length >= MAX_LINES || chars + l.text.length > MAX_TEXT_CHARS) break;
    chars += l.text.length;
    kept.push(l);
  }
  return kept;
}

// ---------- 观察 ----------
let frameSeq = 0;
let last = null;
let observing = null;

// 控件编号在一轮里保持稳定：同一控件（类型+名字+ID+大致位置）重读后还是同一个 [c编号]，
// 否则模型拿着上一次的编号去操作会点错控件
let controlIds = new Map();
let controlSeq = 0;
const MAX_CONTROLS_SHOWN = 120;

function controlKey(c) {
  return `${c.type}|${c.name}|${c.aid}|${Math.round(c.left / 12)}|${Math.round(c.top / 12)}`;
}

function buildControls(scan, shot) {
  if (!scan || !scan.ok) return [];
  if (controlIds.size > 5000) resetControlIds();
  const out = [];
  const used = new Set();
  for (const c of scan.items) {
    // 换成画面内坐标，只留落在这块屏幕上的
    const left = Math.round(c.left - shot.originX);
    const top = Math.round(c.top - shot.originY);
    const right = Math.round(c.right - shot.originX);
    const bottom = Math.round(c.bottom - shot.originY);
    const x = Math.round((left + right) / 2);
    const y = Math.round((top + bottom) / 2);
    if (x < 0 || y < 0 || x >= shot.dipWidth || y >= shot.dipHeight) continue;
    // 没名字的按钮对模型没用；输入框、文档区没名字也要留，用来点进去打字
    if (!c.name && !c.aid && !['Edit', 'Document', 'ComboBox'].includes(c.type)) continue;
    const item = { ...c, left, top, right, bottom, x, y, w: right - left, h: bottom - top, seq: scan.seq };
    const key = controlKey(item);
    let id = controlIds.get(key);
    if (!id || used.has(id)) {
      id = `c${++controlSeq}`;
      controlIds.set(key, id);
    }
    used.add(id);
    item.id = id;
    out.push(item);
  }
  out.sort((a, b) => (Math.abs(a.y - b.y) < 8 ? a.x - b.x : a.y - b.y));
  return out;
}

// OCR 读到的字如果就是某个控件的名字，只保留控件那条，省 token 也避免模型挑错
function dropCoveredLines(lines, controls) {
  if (!controls.length) return lines;
  const sq = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
  return lines.filter((l) => {
    const t = sq(l.text);
    return !controls.some((c) => l.x >= c.left && l.x <= c.right && l.y >= c.top && l.y <= c.bottom &&
      c.name && (sq(c.name).includes(t) || t.includes(sq(c.name))));
  });
}

function resetControlIds() {
  controlIds = new Map();
  controlSeq = 0;
}

async function observeOnce(force, threshold) {
  const desktopHand = require('./desktop-hand');
  if (!desktopHand.isAlive()) throw new Error('「AGI」没开。');
  const display = pickDisplay();
  const shot = await captureDisplay(display);
  const hash = frameHash(shot.image);
  if (!force && last && String(last.displayId) === String(shot.displayId) &&
      Date.now() - last.at < REUSE_MS && hashDiff(hash, last.hash) <= threshold && !last.ocrNote) {
    last.at = Date.now();
    desktopHand.noteLook(last);
    return last;
  }
  const scaleX = shot.dipWidth / shot.width;
  const scaleY = shot.dipHeight / shot.height;
  let lines = [];
  let ocrNote = '';
  // OCR 在 tesseract 线程里跑，控件和窗口列表在 PowerShell 助手里跑，两边并行
  const ocrJob = recognize(shot.image).then((pieces) => {
    lines = normalizeLines(pieces, scaleX, scaleY);
  }).catch((err) => {
    ocrNote = err && err.message ? err.message : String(err);
  });
  let windows = null;
  let scan = null;
  const helperJob = (async () => {
    try { windows = await desktopHand.listWindows(); } catch { windows = null; }
    try { scan = await desktopHand.scanControls(); } catch { scan = null; }
  })();
  await Promise.all([ocrJob, helperJob]);
  const controls = buildControls(scan, shot);
  lines = dropCoveredLines(lines, controls);
  const frame = {
    id: `F${++frameSeq}`,
    at: Date.now(),
    displayId: shot.displayId,
    originX: shot.originX,
    originY: shot.originY,
    width: shot.dipWidth,
    height: shot.dipHeight,
    hash,
    lines,
    windows,
    controls,
    target: scan && scan.ok ? { title: scan.title, proc: scan.proc, pid: scan.pid } : null,
    controlNote: scan && !scan.ok ? scan.message : '',
    ocrNote
  };
  last = frame;
  desktopHand.noteLook(frame);
  return frame;
}

// 同一时刻只跑一次观察，后来的直接等前一次结果。
// threshold 是变化格子占比，越小越灵敏：操作后回看用 0，任何变化都重新识别
function observe(opts = {}) {
  if (observing) return observing;
  const threshold = Number.isFinite(opts.threshold) ? opts.threshold : 0.01;
  observing = observeOnce(!!opts.force, threshold).finally(() => { observing = null; });
  return observing;
}

function lastFrame() {
  return last;
}

function windowLines(windows) {
  if (!Array.isArray(windows) || !windows.length) return '';
  const fg = windows.find((w) => w.fg);
  const others = windows.filter((w) => !w.fg).slice(0, 12).map((w) => `${w.title}（${w.proc}）`);
  return `前台窗口：${fg ? `${fg.title}（${fg.proc}）` : '未知'}\n其他窗口：${others.join('；') || '无'}\n`;
}

function controlLine(c) {
  const desktopHand = require('./desktop-hand');
  const type = desktopHand.TYPE_ZH[c.type] || c.type;
  const name = c.name || c.aid || '无名';
  const state = [
    c.toggle === 'On' ? '☑' : (c.toggle === 'Off' ? '☐' : ''),
    c.value && c.value !== c.name ? `="${c.value.slice(0, 40)}"` : '',
    c.enabled ? '' : '（灰）'
  ].filter(Boolean).join(' ');
  return `- [${c.id}] ${type} "${name.slice(0, 60)}"${state ? ` ${state}` : ''} @(${c.x},${c.y})`;
}

function experienceLines(frame) {
  const proc = frame.target && frame.target.proc;
  if (!proc) return '';
  let notes = [];
  try { notes = require('./agi-memory').notesFor(proc); } catch { notes = []; }
  if (!notes.length) return '';
  return `操作经验（${proc}，以前记下的）：\n${notes.map((n) => `- ${n}`).join('\n')}\n`;
}

function formatBlock(frame) {
  const lines = (frame.lines || []).map((l) => `- "${l.text}" @(${l.x},${l.y}) ${l.w}×${l.h}`);
  const note = frame.ocrNote ? `${frame.ocrNote}\n` : '';
  const controls = (frame.controls || []).slice(0, MAX_CONTROLS_SHOWN).map(controlLine);
  const target = frame.target ? `「${frame.target.title}」（${frame.target.proc}）` : '';
  const controlPart = controls.length
    ? `控件（${target}，用 ui_act 按编号直接操作，比按坐标点更准）：\n${controls.join('\n')}\n`
    : (frame.controlNote ? `控件读取失败：${frame.controlNote}，只能按文字坐标操作。\n` : '');
  return `${SCREEN_BEGIN}
画面 ${frame.id}：屏幕 ${frame.width}×${frame.height}，左上角 0,0 对应系统坐标 (${frame.originX}, ${frame.originY})。@(x,y) 是中心点，mouse_click 等直接用。
${windowLines(frame.windows)}${experienceLines(frame)}${controlPart}${note}其他文字（OCR）：
${lines.join('\n') || '（没有识别到文字）'}
${SCREEN_END}`;
}

function textKey(l) {
  return l.text.replace(/\s+/g, '');
}

// 操作前后对比用的条目：OCR 文字 + 控件（名字带上状态，勾选变化也能看出来）
function diffItems(frame) {
  const out = (frame?.lines || []).map((l) => ({ key: `t:${textKey(l)}`, show: `"${l.text}"@(${l.x},${l.y})`, short: `"${l.text}"` }));
  for (const c of frame?.controls || []) {
    const label = `${c.name || c.aid}`;
    if (!label) continue;
    const st = `${c.toggle}|${c.value}|${c.enabled}`;
    out.push({ key: `c:${c.type}|${label}|${st}`, show: `[${c.id}] "${label}"${c.toggle ? ` ${c.toggle}` : ''}@(${c.x},${c.y})`, short: `[${c.id}] "${label}"` });
  }
  return out;
}

// 操作前后画面对比：新出现、消失的文字和控件
function diffFrames(before, after) {
  if (!after) return '';
  if (after.ocrNote && !(after.controls || []).length) return after.ocrNote;
  if (before && before === after) return '画面没有变化。';
  const prevItems = diffItems(before);
  const nextItems = diffItems(after);
  const prev = new Set(prevItems.map((i) => i.key));
  const next = new Set(nextItems.map((i) => i.key));
  const added = nextItems.filter((i) => !prev.has(i.key)).slice(0, 18).map((i) => ({ text: i.show }));
  const gone = prevItems.filter((i) => !next.has(i.key)).slice(0, 12).map((i) => ({ text: i.short }));
  const fgBefore = before?.windows?.find((w) => w.fg);
  const fgAfter = after.windows?.find((w) => w.fg);
  const parts = [];
  if (fgAfter && (!fgBefore || fgBefore.title !== fgAfter.title)) parts.push(`前台窗口变为：${fgAfter.title}（${fgAfter.proc}）`);
  if (added.length) parts.push(`新出现：${added.map((i) => i.text).join('；')}`);
  if (gone.length) parts.push(`消失：${gone.map((i) => i.text).join('；')}`);
  if (!parts.length) parts.push('文字和控件都没有变化（可能操作没生效，或变化不含文字）。');
  return `画面 ${after.id}：${parts.join('\n')}`;
}

function currentBlock() {
  return last ? formatBlock(last) : '';
}

function stripFromMessages(messages) {
  const re = new RegExp(`\\n?${SCREEN_BEGIN}[\\s\\S]*?${SCREEN_END}\\n?`, 'g');
  for (const message of messages || []) {
    if (message && typeof message.content === 'string' && message.content.includes(SCREEN_BEGIN)) {
      message.content = message.content.replace(re, '\n').replace(/\n{3,}/g, '\n\n').trimEnd();
    }
  }
}

// 屏幕块只挂在最后一条消息上：系统提示词保持不变，前缀缓存不被每轮刷新打穿
function applyToMessages(messages, block) {
  stripFromMessages(messages);
  const text = block === undefined ? currentBlock() : block;
  if (!text || !Array.isArray(messages) || !messages.length) return;
  const tail = messages[messages.length - 1];
  if (tail && typeof tail.content === 'string' && tail.role !== 'assistant') {
    tail.content = `${tail.content}\n\n${text}`;
    return;
  }
  const sys = messages.find((m) => m && m.role === 'system' && typeof m.content === 'string');
  if (sys) sys.content = `${sys.content}\n\n${text}`;
}

function reset() {
  last = null;
  observing = null;
  stopOcr();
}

module.exports = {
  localTessdataPath, pickDisplay, captureDisplay, normalizeLines, observe, lastFrame, formatBlock,
  diffFrames, currentBlock, applyToMessages, stripFromMessages, reset, stopOcr
};
