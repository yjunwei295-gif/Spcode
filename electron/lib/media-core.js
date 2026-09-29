const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const MAX_IMAGES = 12;
const MAX_EACH = 2.5 * 1024 * 1024;
const MIN_EACH = 800;

const DOC_EXTS = new Set([
  '.pdf', '.doc', '.docx', '.docm',
  '.ppt', '.pptx', '.pptm',
  '.xls', '.xlsx', '.xlsm', '.csv'
]);

const RASTER_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

function isImageExt(ext) {
  return Object.prototype.hasOwnProperty.call(RASTER_MIME, String(ext || '').toLowerCase());
}

function mimeOf(ext) {
  return RASTER_MIME[ext] || 'application/octet-stream';
}

function isDocumentExt(ext) {
  return DOC_EXTS.has(String(ext || '').toLowerCase());
}

function clipText(s) {
  return String(s || '');
}

function decodeXml(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function imageKey(buf) {
  return crypto.createHash('md5').update(buf.subarray(0, Math.min(buf.length, 4096))).update(String(buf.length)).digest('hex');
}

function toImage(buf, name, mime) {
  if (!buf || buf.length < MIN_EACH || buf.length > MAX_EACH) return null;
  return { name, dataUrl: `data:${mime};base64,${Buffer.from(buf).toString('base64')}`, key: imageKey(buf) };
}

function mergeImages(into, extra) {
  const seen = new Set(into.map((x) => x.key).filter(Boolean));
  for (const img of extra || []) {
    if (!img || into.length >= MAX_IMAGES) break;
    if (img.key && seen.has(img.key)) continue;
    if (img.key) seen.add(img.key);
    into.push(img);
  }
  return into;
}

function extractRasterImages(buf, prefix = 'img') {
  const images = [];
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const soi = Buffer.from([0xFF, 0xD8, 0xFF]);
  const eoi = Buffer.from([0xFF, 0xD9]);
  let start = 0;
  while (images.length < MAX_IMAGES) {
    const i = b.indexOf(soi, start);
    if (i < 0) break;
    const end = b.indexOf(eoi, i + 3);
    if (end < 0) break;
    const img = toImage(b.subarray(i, end + 2), `${prefix}-${images.length + 1}.jpg`, 'image/jpeg');
    if (img) images.push(img);
    start = end + 2;
  }
  const pngSig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const pngEnd = Buffer.from([0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
  start = 0;
  while (images.length < MAX_IMAGES) {
    const i = b.indexOf(pngSig, start);
    if (i < 0) break;
    const end = b.indexOf(pngEnd, i + 8);
    if (end < 0) break;
    const img = toImage(b.subarray(i, end + 8), `${prefix}-${images.length + 1}.png`, 'image/png');
    if (img) images.push(img);
    start = end + 8;
  }
  return images;
}

async function imagesFromZip(zip, prefix) {
  const images = [];
  const names = Object.keys(zip.files).filter((n) => {
    if (zip.files[n].dir) return false;
    const ext = path.extname(n).toLowerCase();
    return RASTER_MIME[ext] && /\/(media|embeddings)\//i.test(n.replace(/\\/g, '/'));
  });
  names.sort((a, b) => a.localeCompare(b, 'en'));
  for (const n of names) {
    if (images.length >= MAX_IMAGES) break;
    try {
      const buf = await zip.file(n).async('nodebuffer');
      const ext = path.extname(n).toLowerCase();
      const img = toImage(buf, path.basename(n), mimeOf(ext));
      if (img) images.push(img);
    } catch {
      /* 跳过损坏的嵌入图 */
    }
  }
  return images;
}

async function loadZip(absOrBuf) {
  const JSZip = require('jszip');
  const buf = Buffer.isBuffer(absOrBuf) ? absOrBuf : fs.readFileSync(absOrBuf);
  return JSZip.loadAsync(buf);
}

function readPdf(abs) {
  try {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    const buf = fs.readFileSync(abs);
    return pdfParse(buf).then((d) => d.text || '');
  } catch (e) {
    return Promise.resolve(`[PDF 解析失败：${e.message}]`);
  }
}

function readDocxText(abs) {
  const mammoth = require('mammoth');
  return mammoth.extractRawText({ path: abs }).then((r) => r.value || '');
}

function readXlsxText(abs) {
  const xlsx = require('xlsx');
  const wb = xlsx.readFile(abs);
  const parts = [];
  for (const name of wb.SheetNames) {
    const csv = xlsx.utils.sheet_to_csv(wb.Sheets[name]);
    parts.push(`# 工作表 ${name}\n${csv}`);
  }
  return parts.join('\n\n');
}

async function readPptxText(abs) {
  const zip = await loadZip(abs);
  const slides = Object.keys(zip.files)
    .filter((n) => /ppt\/slides\/slide\d+\.xml$/i.test(n.replace(/\\/g, '/')))
    .sort((a, b) => {
      const na = Number((a.match(/slide(\d+)/i) || [])[1] || 0);
      const nb = Number((b.match(/slide(\d+)/i) || [])[1] || 0);
      return na - nb;
    });
  const parts = [];
  for (const name of slides) {
    const xml = await zip.file(name).async('string');
    const bits = [];
    xml.replace(/<a:t[^>]*>([^<]*)<\/a:t>/g, (_, t) => {
      bits.push(decodeXml(t));
      return '';
    });
    const n = (name.match(/slide(\d+)/i) || [])[1] || parts.length + 1;
    parts.push(`# 幻灯片 ${n}\n${bits.join('')}`);
  }
  return parts.join('\n\n') || '';
}

async function officeImages(abs) {
  const images = [];
  try {
    const zip = await loadZip(abs);
    mergeImages(images, await imagesFromZip(zip, path.basename(abs)));
  } catch {
    /* 不是 zip 或损坏时改从二进制抠图 */
  }
  mergeImages(images, extractRasterImages(fs.readFileSync(abs), path.basename(abs, path.extname(abs))));
  return images;
}

function findSoffice() {
  const env = process.env.LIBREOFFICE || process.env.SOFFICE;
  if (env && fs.existsSync(env)) return env;
  const dirs = [];
  if (process.platform === 'win32') {
    for (const root of ['C:\\Program Files', 'C:\\Program Files (x86)']) {
      if (!fs.existsSync(root)) continue;
      try {
        for (const name of fs.readdirSync(root)) {
          if (/^LibreOffice/i.test(name)) dirs.push(path.join(root, name, 'program'));
        }
      } catch {
        /* 忽略不可读目录 */
      }
    }
    dirs.push('C:\\Program Files\\LibreOffice\\program');
  } else if (process.platform === 'darwin') {
    dirs.push('/Applications/LibreOffice.app/Contents/MacOS');
  } else {
    dirs.push('/usr/bin', '/usr/lib/libreoffice/program');
  }
  for (const dir of dirs) {
    const com = path.join(dir, process.platform === 'win32' ? 'soffice.com' : 'soffice');
    const exe = path.join(dir, process.platform === 'win32' ? 'soffice.exe' : 'soffice');
    if (fs.existsSync(com)) return com;
    if (fs.existsSync(exe)) return exe;
  }
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const r = spawnSync(cmd, ['soffice'], { encoding: 'utf8', windowsHide: true });
  const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return first && fs.existsSync(first) ? first : null;
}

function escapePs(s) {
  return String(s || '').replace(/'/g, "''");
}

function convertWithLibreOffice(abs, toExt, outDir) {
  const soffice = findSoffice();
  if (!soffice) return null;
  fs.mkdirSync(outDir, { recursive: true });
  const r = spawnSync(soffice, [
    '--headless', '--norestore', '--nolockcheck', '--nodefault',
    '--convert-to', toExt, '--outdir', outDir, abs
  ], { encoding: 'utf8', timeout: 90000, windowsHide: true });
  if (r.error) return null;
  const expected = path.join(outDir, `${path.basename(abs, path.extname(abs))}.${toExt}`);
  if (fs.existsSync(expected)) return expected;
  const found = fs.readdirSync(outDir).find((f) => f.toLowerCase().endsWith(`.${toExt}`));
  return found ? path.join(outDir, found) : null;
}

function convertWithOfficeCom(abs, dest, kind) {
  if (process.platform !== 'win32') return false;
  const src = escapePs(abs);
  const out = escapePs(dest);
  const script = kind === 'ppt'
    ? `
$ErrorActionPreference = 'Stop'
$ppt = New-Object -ComObject PowerPoint.Application
try {
  try {
    $pres = $ppt.Presentations.Open('${src}', $true, $false, $false)
  } catch {
    $pres = $ppt.Presentations.Open('${src}', $true, $false, $true)
  }
  $pres.SaveAs('${out}', 24)
  $pres.Close()
} finally {
  $ppt.Quit()
}
`
    : `
$ErrorActionPreference = 'Stop'
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Open('${src}', $false, $true)
  $doc.SaveAs2('${out}', 16)
  $doc.Close($false)
} finally {
  $word.Quit()
}
`;
  const ps1 = path.join(os.tmpdir(), `simple-ole-${Date.now()}.ps1`);
  fs.writeFileSync(ps1, `\uFEFF${script}`, 'utf8');
  try {
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1
    ], { encoding: 'utf8', timeout: 90000, windowsHide: true });
    return !r.error && r.status === 0 && fs.existsSync(dest);
  } catch {
    return false;
  } finally {
    try { fs.unlinkSync(ps1); } catch { /* 忽略临时脚本 */ }
  }
}

function convertLegacy(abs, toExt) {
  const outDir = path.join(os.tmpdir(), `simple-office-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(outDir, { recursive: true });
  try {
    const viaLo = convertWithLibreOffice(abs, toExt, outDir);
    if (viaLo && fs.existsSync(viaLo)) return { dest: viaLo, tmp: outDir };
    const dest = path.join(outDir, `${path.basename(abs, path.extname(abs))}.${toExt}`);
    const kind = toExt === 'pptx' ? 'ppt' : 'doc';
    if (convertWithOfficeCom(abs, dest, kind)) return { dest, tmp: outDir };
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return null;
  } catch {
    try { fs.rmSync(outDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
    return null;
  }
}

function cleanupTmp(tmp) {
  if (!tmp) return;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略临时目录 */ }
}

async function readDocFallback(abs) {
  try {
    const WordExtractor = require('word-extractor');
    const doc = await new WordExtractor().extract(abs);
    const body = [doc.getBody(), doc.getHeaders(), doc.getFootnotes()].filter(Boolean).join('\n');
    return body || '';
  } catch (e) {
    return `[旧版 Word 文字抽取失败：${e.message}]`;
  }
}

function extractOleText(buf) {
  const chunks = [];
  let run = '';
  for (let i = 0; i + 1 < buf.length; i += 2) {
    const c = buf[i] | (buf[i + 1] << 8);
    const ok = c === 10 || c === 13 || c === 9 || (c >= 32 && c < 0xD800) || (c >= 0xE000 && c <= 0xFFFD);
    if (ok && buf[i + 1] < 0xD8) {
      run += String.fromCharCode(c);
    } else {
      if (run.trim().length >= 8) chunks.push(run.trim());
      run = '';
    }
  }
  if (run.trim().length >= 8) chunks.push(run.trim());
  const uniq = [];
  const seen = new Set();
  for (const t of chunks) {
    if (seen.has(t)) continue;
    seen.add(t);
    uniq.push(t);
  }
  return uniq.join('\n');
}

async function parseOfficeOpenXml(abs, ext) {
  const images = await officeImages(abs);
  let text = '';
  if (ext === '.docx' || ext === '.docm') text = await readDocxText(abs);
  else if (ext === '.pptx' || ext === '.pptm') text = await readPptxText(abs);
  else text = readXlsxText(abs);
  const note = images.length ? `\n\n[文档内含 ${images.length} 张图]` : '';
  return { kind: 'document', name: path.basename(abs), text: clipText(text + note), images };
}

async function parseLegacy(abs, ext) {
  const name = path.basename(abs);
  const toExt = ext === '.ppt' ? 'pptx' : 'docx';
  const converted = convertLegacy(abs, toExt);
  if (converted) {
    try {
      const parsed = await parseOfficeOpenXml(converted.dest, `.${toExt}`);
      parsed.name = name;
      parsed.text = `（已从旧格式转换为 .${toExt} 再读取）\n${parsed.text}`;
      return parsed;
    } finally {
      cleanupTmp(converted.tmp);
    }
  }
  const buf = fs.readFileSync(abs);
  const images = extractRasterImages(buf, path.basename(abs, ext));
  let text = ext === '.doc' ? await readDocFallback(abs) : extractOleText(buf);
  if (!text || text.startsWith('[')) {
    const ole = extractOleText(buf);
    if (ole) text = `${text || ''}\n${ole}`.trim();
  }
  const hint = '未检测到 LibreOffice / Microsoft Office，旧格式可能抽不全图。安装其一后会转换得更完整。';
  const note = images.length ? `\n\n[尽量抽取到 ${images.length} 张嵌入图]` : `\n\n[${hint}]`;
  return { kind: 'document', name, text: clipText((text || hint) + note), images };
}

function ffmpegAvailable() {
  const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  return !r.error && r.status === 0;
}

function ffprobeDuration(abs) {
  const r = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', abs],
    { encoding: 'utf8', timeout: 15000 }
  );
  if (r.error || !r.stdout) return 0;
  const n = parseFloat(String(r.stdout).trim());
  return Number.isFinite(n) ? n : 0;
}

function extractVideoFrames(abs) {
  if (!ffmpegAvailable()) {
    const stat = fs.statSync(abs);
    return {
      kind: 'video',
      name: path.basename(abs),
      text: `视频文件：${path.basename(abs)}，大小 ${(stat.size / 1024 / 1024).toFixed(2)} MB。未检测到 ffmpeg，无法抽帧。`
    };
  }
  const duration = ffprobeDuration(abs);
  const stamps = duration > 0
    ? [duration * 0.1, duration * 0.5, duration * 0.9]
    : [1, 3, 5];
  const images = [];
  const tmp = path.join(path.dirname(abs), `.simple-frames-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    stamps.forEach((t, i) => {
      const out = path.join(tmp, `frame-${i}.jpg`);
      const r = spawnSync('ffmpeg', ['-ss', String(Math.max(0, t)), '-i', abs, '-frames:v', '1', '-q:v', '3', '-y', out], {
        encoding: 'utf8', timeout: 30000
      });
      if (r.error) return;
      if (fs.existsSync(out)) {
        const buf = fs.readFileSync(out);
        const img = toImage(buf, `frame-${i}.jpg`, 'image/jpeg');
        if (img) images.push(img);
      }
    });
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 忽略临时目录清理失败 */
    }
  }
  const stat = fs.statSync(abs);
  return {
    kind: 'video',
    name: path.basename(abs),
    text: `视频：${path.basename(abs)}，时长约 ${duration.toFixed(1)} 秒，大小 ${(stat.size / 1024 / 1024).toFixed(2)} MB。以下为抽帧画面。`,
    images
  };
}

async function parsePdf(abs) {
  const buf = fs.readFileSync(abs);
  const text = await readPdf(abs);
  const images = extractRasterImages(buf, path.basename(abs, '.pdf'));
  const note = images.length ? `\n\n[PDF 内含 ${images.length} 张图]` : '';
  return { kind: 'document', name: path.basename(abs), text: clipText(text + note), images };
}

async function parseAttachment(abs) {
  const ext = path.extname(abs).toLowerCase();
  const name = path.basename(abs);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${name}`);

  if (RASTER_MIME[ext]) {
    const buf = fs.readFileSync(abs);
    return { kind: 'image', name, dataUrl: `data:${mimeOf(ext)};base64,${buf.toString('base64')}` };
  }
  if (ext === '.pdf') return parsePdf(abs);
  if (['.docx', '.docm', '.pptx', '.pptm', '.xlsx', '.xlsm'].includes(ext)) {
    return parseOfficeOpenXml(abs, ext);
  }
  if (ext === '.doc' || ext === '.ppt') return parseLegacy(abs, ext);
  if (['.xls', '.csv'].includes(ext)) {
    const text = ext === '.csv' ? fs.readFileSync(abs, 'utf8') : String(readXlsxText(abs));
    const images = ext === '.xls' ? extractRasterImages(fs.readFileSync(abs), path.basename(abs, ext)) : [];
    const note = images.length ? `\n\n[表格内含 ${images.length} 张图]` : '';
    return { kind: 'document', name, text: clipText(text + note), images };
  }
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'].includes(ext)) {
    return extractVideoFrames(abs);
  }
  try {
    const text = fs.readFileSync(abs, 'utf8');
    if (text.includes('\u0000')) {
      return { kind: 'file', name, text: `二进制文件：${name}，大小 ${fs.statSync(abs).size} 字节。` };
    }
    return { kind: 'text', name, text };
  } catch {
    return { kind: 'file', name, text: `无法按文本读取：${name}` };
  }
}

module.exports = { parseAttachment, isDocumentExt, isImageExt };
