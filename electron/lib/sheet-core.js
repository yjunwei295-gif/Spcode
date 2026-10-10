// 「看图建表」核心模块：读表格图片 → 结构化 JSON → 写成 .xlsx。
// 只管三件事：调看图模型、解析回包、写文件。工具开关（AGI 关着不给模型）留在 agent.js 的 DESKTOP_TOOLS 里，本模块不碰。
// 写法沿用项目老风格：全部具名函数 + for 循环，不写箭头函数，老引擎也能跑。

const fs = require('fs');
const path = require('path');
const localLlmCore = require('./local-llm-core');
const { parseAttachment } = require('./media-core');

// 提示词：硬要求模型只吐一个固定结构的 JSON（行列、合并单元格都从 0 起算）。
// 要求 cells 是 rows×cols 的规整二维数组、空单元格写空字符串，模型才不容易漏行漏格。
const SHEET_PROMPT = [
  '你是表格识别器。看清这张表格图片，只输出一个 JSON 对象，不要输出任何解释、前言、后缀或多余文字。',
  'JSON 结构固定如下（行列号、合并区域全都从 0 开始数）：',
  '{ "rows": 表格行数, "cols": 表格列数,',
  '  "merges": [ { "r1": 左上角行, "c1": 左上角列, "r2": 右下角行, "c2": 右下角列 } ],',
  '  "cells": [ [ "第0行第0列的文字", "第0行第1列的文字" ], [ "第1行第0列的文字", "" ] ] }',
  '要求：',
  '1. cells 必须正好是 rows 行，每行正好 cols 个字符串；空单元格写空字符串 ""，一格都不能省、不能少。',
  '2. 单元格文字按原图照抄，数字、单位、标点都保留；看不清的格子写空字符串，不要编造内容。',
  '3. merges 只写确实合并过的矩形区域，用左上角 (r1,c1) 和右下角 (r2,c2) 表示；没有合并就写空数组 []。',
  '4. 合并区域里的文字只写在它左上角那一格，被合并覆盖的其他格子写空字符串。',
  '5. 只输出这一个 JSON 对象本身，不要用 ``` 代码块包裹，不要写注释。'
].join('\n');

/** 截一段原文放进报错里（太长就截断，避免把整段回包塞进错误信息）。 */
function clip(text, max) {
  const s = String(text == null ? '' : text).trim();
  const n = Number(max) > 0 ? Number(max) : 300;
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}

/** 去掉模型回包外面的 ```json / ``` 围栏（只去首尾成对的那种，正文里的反引号不动）。 */
function stripFence(text) {
  let t = String(text == null ? '' : text).trim();
  if (t.slice(0, 3) === '```') {
    const nl = t.indexOf('\n');
    t = nl >= 0 ? t.slice(nl + 1) : t.slice(3);
  }
  const end = t.lastIndexOf('```');
  if (end >= 0 && t.slice(end + 3).trim() === '') t = t.slice(0, end);
  return t.trim();
}

/** 从回包里取出 JSON 文本：先脱围栏；前面还带闲话时，截第一个 { 到最后一个 }。 */
function extractJsonText(text) {
  const body = stripFence(text);
  if (!body) return '';
  if (body.charAt(0) === '{') return body;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start >= 0 && end > start) return body.slice(start, end + 1);
  return body;
}

/** 单元格值转字符串：null/undefined 记空串，数字与布尔照字面，其他强制转字符串。 */
function cellText(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

/** 下标转非负整数；不是整数（含小数、非法值、负数）返回 -1。 */
function toIndex(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return -1;
  if (!Number.isInteger(n)) return -1;
  if (n < 0) return -1;
  return n;
}

/**
 * 单个合并项 → { r1, c1, r2, c2 }（左上角 + 右下角，都已归正）。
 * 认 {r1,c1,r2,c2}，也顺手认 xlsx 自己的 {s:{r,c},e:{r,c}}；不合法或只覆盖一格时返回 null。
 */
function mergeBox(m) {
  if (!m || typeof m !== 'object') return null;
  let r1 = toIndex(m.r1);
  let c1 = toIndex(m.c1);
  let r2 = toIndex(m.r2);
  let c2 = toIndex(m.c2);
  if (r1 < 0 || c1 < 0 || r2 < 0 || c2 < 0) {
    const s = m.s && typeof m.s === 'object' ? m.s : null;
    const e = m.e && typeof m.e === 'object' ? m.e : null;
    if (!s || !e) return null;
    r1 = toIndex(s.r);
    c1 = toIndex(s.c);
    r2 = toIndex(e.r);
    c2 = toIndex(e.c);
    if (r1 < 0 || c1 < 0 || r2 < 0 || c2 < 0) return null;
  }
  const top = Math.min(r1, r2);
  const left = Math.min(c1, c2);
  const bottom = Math.max(r1, r2);
  const right = Math.max(c1, c2);
  if (top === bottom && left === right) return null; // 只覆盖一格不算合并
  return { r1: top, c1: left, r2: bottom, c2: right };
}

/** {r1,c1,r2,c2} 形式的合并项 → xlsx 要的 { s:{r,c}, e:{r,c} }；不合法返回 null。 */
function mergeOf(m) {
  const box = mergeBox(m);
  if (!box) return null;
  return { s: { r: box.r1, c: box.c1 }, e: { r: box.r2, c: box.c2 } };
}

/**
 * 基本校验：cells 是数组、每行长度等于 cols、rows 与 cells.length 一致。
 * 只做结构校验，不改内容；不通过返回 false。
 */
function isSheetSpecOk(spec) {
  if (!spec || typeof spec !== 'object') return false;
  if (!Array.isArray(spec.cells)) return false;
  if (spec.merges !== undefined && spec.merges !== null && !Array.isArray(spec.merges)) return false;
  const rows = Number(spec.rows);
  const cols = Number(spec.cols);
  if (!Number.isInteger(rows) || !Number.isInteger(cols)) return false;
  if (rows <= 0 || cols <= 0) return false;
  if (rows !== spec.cells.length) return false;
  let i = 0;
  for (i = 0; i < spec.cells.length; i++) {
    const line = spec.cells[i];
    if (!Array.isArray(line)) return false;
    if (line.length !== cols) return false;
  }
  return true;
}

/**
 * 归一化模型回包：把 cells 修成规整的二维字符串数组（rows/cols 以 cells 为准），
 * 越界或非法的 merges 丢掉。这一步只补结构，不猜内容：没有的格子补空字符串。
 */
function normalizeSpec(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rawCells = Array.isArray(src.cells) ? src.cells : [];
  const rows = [];
  let cols = toIndex(src.cols);
  if (cols < 0) cols = 0;
  let i = 0;
  for (i = 0; i < rawCells.length; i++) {
    const line = Array.isArray(rawCells[i]) ? rawCells[i] : [rawCells[i]];
    const out = [];
    let j = 0;
    for (j = 0; j < line.length; j++) out.push(cellText(line[j]));
    if (out.length > cols) cols = out.length;
    rows.push(out);
  }
  let r = 0;
  for (r = 0; r < rows.length; r++) {
    while (rows[r].length < cols) rows[r].push(''); // 短行补齐，保证 rows×cols 规整
  }
  const merges = [];
  const rawMerges = Array.isArray(src.merges) ? src.merges : [];
  for (i = 0; i < rawMerges.length; i++) {
    const box = mergeBox(rawMerges[i]);
    if (!box) continue;
    if (box.r2 >= rows.length || box.c2 >= cols) continue; // 越界合并直接丢，别写坏文件
    merges.push(box);
  }
  return { rows: rows.length, cols: cols, merges: merges, cells: rows };
}

/** 取当前配置里的看图槽位：解析出本地 GGUF 的绝对路径与 mmproj 路径。 */
function visionModel() {
  // 配置模块按需加载：这样没跑在 Electron 里（例如单测）也能只用本文件的解析/写表功能。
  let store = null;
  let assembly = null;
  try {
    store = require('./store');
    assembly = require('./assembly');
  } catch (e) {
    return { modelPath: '', mmproj: '' };
  }
  let s = null;
  try {
    s = store.load();
  } catch (e) {
    s = null;
  }
  if (!s || typeof s !== 'object') return { modelPath: '', mmproj: '' };
  let dir = String(s.modelsDir || '');
  if (!dir) {
    try {
      dir = String(store.defaultModelsDir() || '');
    } catch (e) {
      dir = '';
    }
  }
  let vis = null;
  try {
    vis = assembly.visionFrom(s);
  } catch (e) {
    vis = null;
  }
  const model = String((vis && vis.model) || '').trim();
  let mmproj = String((vis && vis.mmproj) || '').trim();
  let modelPath = '';
  if (model) {
    if (fs.existsSync(model)) modelPath = model; // 槽位里存的是绝对路径
    else if (dir) {
      const guess = path.join(dir, model); // 槽位里只存文件名时到本地模型目录里拼
      if (fs.existsSync(guess)) modelPath = guess;
    }
  }
  if (mmproj && !fs.existsSync(mmproj) && dir) {
    const guess = path.join(dir, mmproj);
    if (fs.existsSync(guess)) mmproj = guess;
  }
  return { modelPath: modelPath, mmproj: mmproj };
}

/**
 * 读一张表格图片，交给本地看图模型读出行列、合并单元格和每格文字。
 * @param {string} imagePath 图片路径（绝对路径最稳，相对路径按当前目录解析）
 * @param {object} [opts] 可选：{ modelPath, mmproj, dataUrl, prompt, signal, onWait }
 * @returns {Promise<object>} { rows, cols, merges: [{r1,c1,r2,c2}], cells: [[文字,...],...] }
 *   —— 行列与合并区域都从 0 起算，空单元格是空字符串。
 * 说明：图片读不出来、模型没配、回包不是 JSON 都直接 throw（错误信息带模型原文），由上层转成给模型看的中文串。
 */
async function parseSheetImage(imagePath, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const given = String(imagePath == null ? '' : imagePath).trim();
  if (!given) throw new Error('没有给表格图片的路径。');
  let abs = given;
  if (!path.isAbsolute(abs)) abs = path.resolve(abs);
  let st = null;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    st = null;
  }
  if (!st || !st.isFile()) throw new Error(`图片不存在或不是文件：${abs}`);

  let dataUrl = String(options.dataUrl || '');
  if (!dataUrl) {
    const parsed = await parseAttachment(abs);
    dataUrl = String((parsed && parsed.dataUrl) || '');
    if (!dataUrl && parsed && Array.isArray(parsed.images) && parsed.images.length) {
      dataUrl = String(parsed.images[0].dataUrl || '');
    }
  }
  if (!dataUrl) {
    throw new Error(`图片「${path.basename(abs)}」不是可识别的图片格式（支持 png/jpg/bmp/webp 等）。`);
  }

  const vis = visionModel();
  const modelPath = String(options.modelPath || vis.modelPath || '').trim();
  const mmprojPath = String(options.mmproj || vis.mmproj || '').trim();
  if (!modelPath) {
    throw new Error('没有可用的本地看图模型。请在「文件 → 模型组合」里给看图槽位挂上带 mmproj 的视觉 GGUF。');
  }

  const text = await localLlmCore.visionComplete({
    modelPath: modelPath,
    mmproj: mmprojPath,
    dataUrl: dataUrl,
    prompt: String(options.prompt || SHEET_PROMPT),
    signal: options.signal,
    onWait: options.onWait
  });

  const jsonText = extractJsonText(text);
  if (!jsonText || jsonText.charAt(0) !== '{') {
    throw new Error(`看图模型没有按要求只返回 JSON，原文：${clip(text, 400)}`);
  }
  let raw = null;
  try {
    raw = JSON.parse(jsonText);
  } catch (e) {
    throw new Error(`看图模型返回的 JSON 解析失败（${e && e.message ? e.message : e}），原文：${clip(jsonText, 400)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`看图模型返回的不是表格 JSON 对象，原文：${clip(text, 400)}`);
  }
  return normalizeSpec(raw);
}

/** 粗略算显示宽度：中文等宽字符按 2 格算，用来估列宽。 */
function displayWidth(text) {
  const s = String(text == null ? '' : text);
  let w = 0;
  let i = 0;
  for (i = 0; i < s.length; i++) {
    w += s.charCodeAt(i) > 0x2e80 ? 2 : 1;
  }
  return w;
}

/**
 * 把结构化表格写成 .xlsx：先按 cells 建 sheet，再按 merges 补合并单元格。
 * @param {object} spec { rows, cols, merges, cells }
 * @param {string} outPath 输出路径（没有 .xlsx 后缀会自动补上，父目录不存在会自动建）
 * @returns {Promise<string>} 写出的绝对路径
 */
async function writeSheetFile(spec, outPath) {
  const xlsx = require('xlsx');
  const want = String(outPath == null ? '' : outPath).trim();
  if (!want) throw new Error('没有给出要写出的文件路径。');
  if (!isSheetSpecOk(spec)) {
    throw new Error('表格数据不完整：需要 { rows, cols, cells }，cells 要是 rows 行、每行 cols 格的二维数组。');
  }
  let abs = path.resolve(want);
  if (!/\.xlsx$/i.test(abs)) abs = `${abs}.xlsx`;
  const dir = path.dirname(abs);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const rows = [];
  let r = 0;
  let c = 0;
  for (r = 0; r < spec.cells.length; r++) {
    const line = [];
    for (c = 0; c < spec.cols; c++) line.push(cellText(spec.cells[r][c]));
    rows.push(line);
  }
  const ws = xlsx.utils.aoa_to_sheet(rows);

  const merges = [];
  const rawMerges = Array.isArray(spec.merges) ? spec.merges : [];
  for (r = 0; r < rawMerges.length; r++) {
    const m = mergeOf(rawMerges[r]);
    if (!m) continue;
    if (m.e.r >= spec.rows || m.e.c >= spec.cols) continue; // 越界的合并丢掉，别写坏文件
    merges.push(m);
  }
  if (merges.length) ws['!merges'] = merges;

  // 顺手估个列宽，WPS/Excel 打开就能看清，不用手动拉
  const widths = [];
  for (c = 0; c < spec.cols; c++) {
    let w = 6;
    for (r = 0; r < rows.length; r++) {
      const len = displayWidth(rows[r][c]);
      if (len > w) w = len;
    }
    widths.push({ wch: Math.min(40, w + 2) });
  }
  ws['!cols'] = widths;

  const wb = xlsx.utils.book_new();
  let sheetName = String(spec.sheetName || 'Sheet1').trim();
  if (!sheetName) sheetName = 'Sheet1';
  xlsx.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
  xlsx.writeFile(wb, abs);
  return abs;
}

/**
 * 把表格结构转成制表符分隔文本（TSV），供粘贴进 WPS/Excel 用。
 * 表格软件按 Tab 分列、按换行分行，所以这里格与格之间用 '\t'、行与行之间用 '\n'，末尾不加多余换行。
 * 注意：合并单元格信息 TSV 表达不了（粘贴出来是一格格散开的），需要用户手动设置。
 * @param {object} spec 表格数据 { rows, cols, cells, merges }
 * @returns {string} TSV 文本
 */
function specToTsv(spec) {
  if (!isSheetSpecOk(spec)) {
    throw new Error('表格数据不完整：需要 { rows, cols, cells }，cells 要是 rows 行、每行 cols 格的二维数组。');
  }
  const lines = [];
  for (let r = 0; r < spec.cells.length; r++) {
    const line = [];
    for (let c = 0; c < spec.cols; c++) {
      // 单元格文字里本身带制表符或换行时替换成单个空格，避免把行列结构冲乱
      let text = cellText(spec.cells[r][c]);
      text = text.split('\t').join(' ');
      text = text.split('\n').join(' ');
      line.push(text);
    }
    lines.push(line.join('\t'));
  }
  return lines.join('\n');
}

module.exports = { parseSheetImage, writeSheetFile, isSheetSpecOk, specToTsv };
