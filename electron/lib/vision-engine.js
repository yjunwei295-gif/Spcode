const fs = require('fs');
const path = require('path');
const net = require('net');
const os = require('os');
const { spawn } = require('child_process');
const { app, net: eNet } = require('electron');
const JSZip = require('jszip');
const downloader = require('./downloader');
const hardware = require('./hardware');
const diag = require('./diag');
const replyLang = require('./reply-lang');

// 内置看图引擎：后台拉起 llama-server（带 mmproj），对界面不是另一个产品。
// GitHub 拿不到最新版时用这个已知能看图的构建号。
const FALLBACK_TAG = 'b10167';
const LOAD_TIMEOUT_MS = 180 * 1000;
const CHAT_TIMEOUT_MS = 180 * 1000;
const GH_MIRRORS = [
  (u) => u,
  (u) => `https://ghfast.top/${u}`,
  (u) => `https://mirror.ghproxy.com/${u}`
];

let proc = null;
let serving = null; // { key, port, modelPath, mmproj, flavor }
let bootPromise = null;
let logTail = '';

function enginesRoot() {
  return path.join(app.getPath('userData'), 'engines', 'llama-cpp');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close((err) => (err ? reject(err) : resolve(port)));
    });
    s.on('error', reject);
  });
}

function findNamed(dir, want) {
  const target = want.toLowerCase();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let names = [];
    try {
      names = fs.readdirSync(cur);
    } catch {
      continue;
    }
    for (const name of names) {
      const abs = path.join(cur, name);
      let st;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(abs);
      else if (name.toLowerCase() === target) return abs;
    }
  }
  return '';
}

function killProc(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    /* 退出时忽略 */
  }
}

function stop() {
  if (proc) {
    killProc(proc);
    proc = null;
  }
  serving = null;
}

function zipName(tag, flavor) {
  return `llama-${tag}-bin-win-${flavor}-x64.zip`;
}

function githubZipUrl(tag, flavor) {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${tag}/${zipName(tag, flavor)}`;
}

async function latestTag(onWait) {
  onWait?.('正在检测看图引擎版本…');
  try {
    const res = await eNet.fetch('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest', {
      headers: { 'User-Agent': 'SimpleCode', Accept: 'application/vnd.github+json' }
    });
    if (!res.ok) return FALLBACK_TAG;
    const json = await res.json();
    const tag = String(json.tag_name || '').trim();
    return /^b\d+$/i.test(tag) ? tag : FALLBACK_TAG;
  } catch {
    return FALLBACK_TAG;
  }
}

async function pickFlavor() {
  try {
    const gpu = await hardware.detectGpu();
    if (gpu && (gpu.vramGB > 0 || /nvidia|amd|radeon|intel|arc|geforce/i.test(gpu.name || ''))) {
      return 'vulkan';
    }
  } catch {
    /* 探测失败就用 CPU */
  }
  return 'cpu';
}

async function unzipTo(zipPath, outDir, onWait) {
  onWait?.('正在解压看图引擎…');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  const names = Object.keys(zip.files);
  for (const rel of names) {
    const entry = zip.files[rel];
    if (!entry || entry.dir) continue;
    const dest = path.join(outDir, rel.replace(/\\/g, '/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await entry.async('nodebuffer'));
  }
}

async function downloadZip(tag, flavor, onWait) {
  const destDir = enginesRoot();
  const name = zipName(tag, flavor);
  const dest = path.join(destDir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return dest;

  let lastErr = null;
  const official = githubZipUrl(tag, flavor);
  for (const wrap of GH_MIRRORS) {
    const url = wrap(official);
    onWait?.(`正在下载看图引擎（${flavor}）…`);
    diag.log('vision-engine', '开始下载引擎', { url, tag, flavor });
    const r = await downloader.download({
      id: `vision-engine-${tag}-${flavor}`,
      url,
      dir: destDir,
      name,
      threads: 4,
      onProgress: (p) => {
        if (!p || !p.total) return;
        const pct = Math.min(99, Math.round((p.downloaded / p.total) * 100));
        onWait?.(`正在下载看图引擎 ${pct}%`);
      }
    });
    if (r.ok && r.path) return r.path;
    lastErr = new Error(r.message || '下载失败');
    try {
      fs.rmSync(dest, { force: true });
      fs.rmSync(`${dest}.part`, { force: true });
    } catch {
      /* 清残留 */
    }
  }
  throw lastErr || new Error('看图引擎下载失败');
}

async function ensureBinary(flavor, onWait) {
  const root = enginesRoot();
  fs.mkdirSync(root, { recursive: true });
  const markerPath = path.join(root, `ready-${flavor}.json`);
  if (fs.existsSync(markerPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (m.exe && fs.existsSync(m.exe)) return m;
    } catch {
      /* 标记损坏则重装 */
    }
  }
  const tag = await latestTag(onWait);
  const zipPath = await downloadZip(tag, flavor, onWait);
  const outDir = path.join(root, `${tag}-${flavor}`);
  await unzipTo(zipPath, outDir, onWait);
  const exeName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const exe = findNamed(outDir, exeName);
  if (!exe) throw new Error('看图引擎压缩包里没有 llama-server，请重试下载');
  const marker = { tag, flavor, exe, dir: path.dirname(exe) };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
  diag.log('vision-engine', '引擎已就绪', marker);
  return marker;
}

function appendLog(buf) {
  logTail = (logTail + buf.toString('utf8')).slice(-8000);
}

async function waitReady(base, child, signal) {
  const start = Date.now();
  while (Date.now() - start < LOAD_TIMEOUT_MS) {
    if (signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      err.code = 'aborted';
      throw err;
    }
    if (child.exitCode != null) {
      throw new Error(`看图引擎启动失败：${(logTail || '进程已退出').slice(-600)}`);
    }
    for (const p of ['/health', '/v1/models']) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 2000);
        const res = await fetch(`${base}${p}`, { signal: ctl.signal });
        clearTimeout(t);
        if (res.ok) return;
      } catch {
        /* 还在加载 */
      }
    }
    await sleep(500);
  }
  throw new Error('看图引擎加载超时。模型较大时请再等一次，或换更小的看图 GGUF。');
}

async function spawnServer({ exe, cwd, modelPath, mmproj, flavor, signal, onWait }) {
  const port = await freePort();
  const ngl = flavor === 'cpu' ? '0' : '99';
  const args = [
    '-m', modelPath,
    '--mmproj', mmproj,
    '--host', '127.0.0.1',
    '--port', String(port),
    '-ngl', ngl,
    '-c', '4096',
    '--threads', String(Math.max(2, os.cpus().length)),
    '--no-webui'
  ];
  onWait?.('正在加载看图模型（首次较慢）…');
  logTail = '';
  diag.log('vision-engine', '启动 llama-server', { exe, port, flavor, modelPath, mmproj });
  const child = spawn(exe, args, {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', appendLog);
  child.stderr.on('data', appendLog);
  child.on('exit', (code) => {
    diag.log('vision-engine', 'llama-server 退出', { code, tail: logTail.slice(-400) });
    if (proc === child) {
      proc = null;
      serving = null;
    }
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    await waitReady(base, child, signal);
  } catch (e) {
    killProc(child);
    throw e;
  }
  return { child, port, base };
}

async function boot({ modelPath, mmproj, signal, onWait }) {
  if (!modelPath || !fs.existsSync(modelPath)) throw new Error('未找到看图模型文件');
  if (!mmproj || !fs.existsSync(mmproj)) throw new Error('缺少投影文件 mmproj，无法把图片送进模型');

  const key = `${modelPath}|${mmproj}`;
  if (serving && serving.key === key && proc && proc.exitCode == null) return serving;

  stop();

  const flavors = [];
  const prefer = await pickFlavor();
  flavors.push(prefer);
  if (prefer !== 'cpu') flavors.push('cpu');

  let lastErr = null;
  for (const flavor of flavors) {
    try {
      const bin = await ensureBinary(flavor, onWait);
      const started = await spawnServer({
        exe: bin.exe,
        cwd: bin.dir,
        modelPath,
        mmproj,
        flavor,
        signal,
        onWait
      });
      proc = started.child;
      serving = { key, port: started.port, base: started.base, modelPath, mmproj, flavor };
      onWait?.('看图引擎已就绪');
      diag.log('vision-engine', '看图引擎就绪', { port: started.port, flavor });
      return serving;
    } catch (e) {
      lastErr = e;
      diag.log('vision-engine', '该加速方式启动失败，尝试下一个', { flavor, message: e && e.message });
      stop();
    }
  }
  throw lastErr || new Error('看图引擎启动失败');
}

async function ensureServer(opts) {
  if (bootPromise) return bootPromise;
  bootPromise = boot(opts).finally(() => { bootPromise = null; });
  return bootPromise;
}

/**
 * 向本地视觉服务发送单图或带来源标签的多图，比较提示仅作用于当前请求。
 * @param {object} options 本次识别请求参数，不修改服务或模型配置
 * @param {string} options.base 已启动本地服务的地址
 * @param {string} options.model 模型名称；请求会使用服务实际公布的模型标识
 * @param {string} [options.dataUrl] 单图数据地址；未传 images 时发送此图
 * @param {Array<object>} [options.images] 多图内容块，按原顺序携带来源标签 text 和实际像素 image_url；传入时替代 dataUrl
 * @param {string} [options.prompt] 本次比较问题；未提供时使用 lang 对应的单图识别提示
 * @param {AbortSignal} [options.signal] 本轮取消信号，取消后中断请求
 * @param {function} [options.onWait] 接收识别进度提示的回调
 * @param {string} [options.lang] 默认识别提示的语言
 * @returns {Promise<string>} 去除首尾空白的识别正文；只有思考文本时使用该文本，空回包、接口失败或取消则拒绝
 */
async function chatVision({ base, model, dataUrl, images, prompt, signal, onWait, lang }) {
  const url = `${base.replace(/\/$/, '')}/v1/chat/completions`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CHAT_TIMEOUT_MS);
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  onWait?.('正在识别图片…');
  try {
    let modelId = String(model || '').replace(/\.gguf$/i, '') || 'vision';
    try {
      const list = await fetch(`${base.replace(/\/$/, '')}/v1/models`, { signal: ctl.signal });
      if (list.ok) {
        const j = await list.json();
        const id = j?.data?.[0]?.id;
        if (id) modelId = id;
      }
    } catch {
      /* 用文件名当模型名 */
    }
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        stream: false,
        temperature: 0.2,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt || replyLang.visionAsk(lang || replyLang.fromLocale('zh')) }]
              .concat(images || [{ type: 'image_url', image_url: { url: dataUrl } }])
          }
        ]
      }),
      signal: ctl.signal
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`看图请求失败 ${res.status}：${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const message = data.choices?.[0]?.message || {};
    const content = message.content;
    let text = Array.isArray(content)
      ? content.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
      : String(content || '');
    if (!String(text).trim()) {
      const reason = message.reasoning_content || message.reasoning || message.thinking || '';
      text = Array.isArray(reason)
        ? reason.map((p) => (typeof p === 'string' ? p : p?.text || '')).join('\n')
        : String(reason || '');
    }
    if (!text.trim()) throw new Error('看图引擎返回了空内容');
    return text.trim();
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(signal?.aborted ? '已停止' : '看图识别超时');
      err.name = 'AbortError';
      err.code = signal?.aborted ? 'aborted' : 'vision_timeout';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * 按已配置模型启动本地视觉引擎，再原样传递单图或多图及本次比较提示。
 * @param {object} options 本次引擎启动及识别参数；不更换用户配置的模型
 * @param {string} options.modelPath 本地 GGUF 模型路径
 * @param {string} options.mmproj 与模型配套的视觉投影文件路径
 * @param {string} [options.model] 请求模型名称；未提供时使用 modelPath 的文件名
 * @param {string} [options.dataUrl] 单图数据地址，未传 images 时使用
 * @param {Array<object>} [options.images] 带来源标签 text 与实际像素 image_url 的多图内容块；传入时替代 dataUrl
 * @param {string} [options.prompt] 仅用于本次请求的比较问题，未提供时沿用单图识别提示
 * @param {AbortSignal} [options.signal] 取消引擎启动或当前识别请求
 * @param {function} [options.onWait] 接收引擎准备及识别状态的回调
 * @param {string} [options.lang] 默认识别提示语言，未提供时使用中文
 * @returns {Promise<string>} 视觉服务返回的非空识别文本；引擎启动、识别失败或取消时直接拒绝
 */
async function describe({ modelPath, mmproj, model, dataUrl, images, prompt, signal, onWait, lang }) {
  const srv = await ensureServer({ modelPath, mmproj, signal, onWait });
  return chatVision({
    base: srv.base,
    model: model || path.basename(modelPath),
    dataUrl,
    images,
    prompt,
    signal,
    onWait,
    lang: lang || replyLang.fromLocale('zh')
  });
}

module.exports = { ensureServer, describe, stop };
