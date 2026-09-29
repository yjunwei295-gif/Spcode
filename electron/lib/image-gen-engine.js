const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { app, net: eNet } = require('electron');
const JSZip = require('jszip');
const downloader = require('./downloader');
const hardware = require('./hardware');
const modelMeta = require('./model-meta');
const diag = require('./diag');

const GEN_TIMEOUT_MS = 20 * 60 * 1000;
// [铆钉优化] 连不上 GitHub API 时用的版本，master-929 已在 RTX 5060 + Vulkan 上实测跑通 Qwen-Image 2.1。其他 AI 请勿改回旧版本
const FALLBACK_TAG = 'master-929-3f8527a';
const GH_MIRRORS = [
  (u) => u,
  (u) => `https://ghfast.top/${u}`,
  (u) => `https://mirror.ghproxy.com/${u}`
];

const QWEN_VAE_NAME = 'qwen_image_vae.safetensors';

function enginesRoot() {
  return path.join(app.getPath('userData'), 'engines', 'stable-diffusion.cpp');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function findNamed(dir, want) {
  const target = want.toLowerCase();
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop();
    let names = [];
    try { names = fs.readdirSync(cur); } catch { continue; }
    for (const name of names) {
      const abs = path.join(cur, name);
      let st;
      try { st = fs.statSync(abs); } catch { continue; }
      if (st.isDirectory()) stack.push(abs);
      else if (name.toLowerCase() === target) return abs;
    }
  }
  return '';
}

function listFiles(dir, acc = []) {
  if (!dir || !fs.existsSync(dir)) return acc;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return acc; }
  for (const name of names) {
    const abs = path.join(dir, name);
    try {
      const st = fs.statSync(abs);
      if (st.isDirectory()) listFiles(abs, acc);
      else acc.push(abs);
    } catch { /* skip */ }
  }
  return acc;
}

function detectRecipe(modelPath, modelsDir) {
  if (modelsDir) {
    const meta = modelMeta.resolveMeta(modelsDir, modelPath);
    if (meta?.recipe) return meta.recipe;
    if ((meta?.purposes || []).includes('imageGen') && !meta.recipe) return 'single';
  }
  return modelMeta.inferRecipe(modelPath) || 'single';
}

function isQwenImage21(modelPath) {
  return /qwen[-_.]?image[-_.]?2(?:\.1)?/i.test(path.basename(String(modelPath || '')));
}

function findQwenVae(modelsDir, modelPath) {
  const files = listFiles(modelsDir).filter((f) => /\.safetensors$/i.test(f));
  if (isQwenImage21(modelPath)) {
    return files.find((f) => /qwen[-_.]?image[-_.]?2(?:\.1)?.*vae|vae.*qwen[-_.]?image[-_.]?2/i.test(path.basename(f)))
      || files.find((f) => path.basename(f).toLowerCase() === 'qwen_image_2.1_vae_bf16.safetensors')
      || '';
  }
  return files.find((f) => path.basename(f).toLowerCase() === QWEN_VAE_NAME)
    || files.find((f) => /qwen.*image.*vae/i.test(path.basename(f)) && !/2(?:\.1)?/i.test(path.basename(f)))
    || '';
}

function findQwenLlm(modelsDir, modelPath) {
  const files = listFiles(modelsDir);
  if (isQwenImage21(modelPath)) {
    // Qwen-Image 2.1 的文本编码器是 Qwen3-VL-8B，只能用 GGUF：ComfyUI 那套 int8 comfy_quant safetensors
    // 会让 sd.cpp 把词表维当成 hidden（151936）并在 ggml_block 断言 scale 元素数，加载即失败
    return files.find((f) => /qwen3[-_.]?vl.*8b.*\.gguf$/i.test(path.basename(f)) && !/mmproj/i.test(path.basename(f)))
      || files.find((f) => /qwen3[-_.]?vl.*\.gguf$/i.test(path.basename(f)) && !/mmproj/i.test(path.basename(f)))
      || '';
  }
  return files.find((f) => /qwen2\.5-vl.*instruct.*\.gguf$/i.test(f) && !/mmproj/i.test(f))
    || files.find((f) => /qwen.*vl.*instruct.*\.gguf$/i.test(f) && !/mmproj/i.test(f) && !/qwen3/i.test(f))
    || '';
}

async function hfBases() {
  const { sources } = await downloader.resolveSources();
  const bases = (sources || []).map((s) => s.base).filter(Boolean);
  const mirror = 'https://hf-mirror.com';
  const official = 'https://huggingface.co';
  return [...new Set([mirror, ...bases.filter((b) => b !== official), official])];
}

async function downloadHf({ repo, filePath, dir, name, label, onWait, signal }) {
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return dest;
  let last = '';
  const bases = await hfBases();
  for (const base of bases) {
    if (signal?.aborted) throw abortErr();
    const url = `${String(base).replace(/\/$/, '')}/${repo}/resolve/main/${filePath}`;
    onWait?.(`正在从 ${base.includes('mirror') ? '镜像' : '官方'} 下载${label}…`);
    const r = await downloader.download({
      id: `${label}-${Date.now()}`,
      url,
      dir,
      name,
      // 配套文件经常是数 GB，按大小自动决定并发分片数，单连接太慢会被重试上限掐死
      threads: 'auto',
      onProgress: (p) => {
        if (!p?.total) return;
        onWait?.(`正在下载${label} ${Math.min(99, Math.round((p.downloaded / p.total) * 100))}%`);
      }
    });
    if (r.ok) return r.path || dest;
    last = r.message || '下载失败';
    // 半成品留着。下一个源若支持续传会接着下，不支持时下载器自己从头写
  }
  throw new Error(`${label}下载失败：${last}。已尝试 ${bases.join('、')}`);
}

async function ensureQwenVae(modelsDir, modelPath, onWait, signal) {
  const existing = findQwenVae(modelsDir, modelPath);
  if (existing) return existing;
  if (isQwenImage21(modelPath)) {
    return downloadHf({
      repo: 'Comfy-Org/Qwen-Image-2.1',
      filePath: 'vae/qwen_image_2.1_vae_bf16.safetensors',
      dir: modelsDir,
      name: 'qwen_image_2.1_vae_bf16.safetensors',
      label: 'Qwen-Image 2.1 VAE',
      onWait,
      signal
    });
  }
  return downloadHf({
    repo: 'Comfy-Org/Qwen-Image_ComfyUI',
    filePath: 'split_files/vae/qwen_image_vae.safetensors',
    dir: modelsDir,
    name: QWEN_VAE_NAME,
    label: 'Qwen-Image VAE',
    onWait,
    signal
  });
}

async function ensureQwenLlm(modelsDir, modelPath, onWait, signal) {
  const found = findQwenLlm(modelsDir, modelPath);
  if (found) return found;
  if (isQwenImage21(modelPath)) {
    // Qwen3-VL-8B 的 GGUF 文本编码器；qwen3.5_9b_..._pe_t2i 是 prompt enhancer，ComfyUI 的 int8
    // comfy_quant safetensors 也加载不了，只有 GGUF 这条 sd.cpp 能吃（与 Qwen-Image 1.0 路径一致）
    const repo = 'bartowski/Qwen3-VL-8B-Instruct-GGUF';
    const name = 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf';
    return downloadHf({
      repo,
      filePath: name,
      dir: modelsDir,
      name,
      label: 'Qwen-Image 2.1 文本编码器',
      onWait,
      signal
    });
  }
  const repo = 'lmstudio-community/Qwen2.5-VL-3B-Instruct-GGUF';
  const name = 'Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf';
  return downloadHf({
    repo,
    filePath: name,
    dir: modelsDir,
    name,
    label: '文本编码器',
    onWait,
    signal
  });
}

function abortErr() {
  const err = new Error('已停止');
  err.name = 'AbortError';
  return err;
}

async function pickFlavor() {
  // [铆钉优化] 装了 NVIDIA 驱动就直接用显卡，不依赖 nvidia-smi 当下能否及时返回。其他 AI 请勿删
  if (process.platform === 'win32' && fs.existsSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'))) {
    return 'vulkan';
  }
  try {
    const gpu = await hardware.detectGpu();
    if (gpu && (gpu.vramGB >= 6 || /nvidia|amd|radeon|intel|arc|geforce|rtx/i.test(gpu.name || ''))) {
      return 'vulkan';
    }
  } catch { /* cpu */ }
  return 'cpu';
}

async function pickReleaseAsset(flavor) {
  let json = null;
  try {
    const res = await eNet.fetch('https://api.github.com/repos/leejet/stable-diffusion.cpp/releases/latest', {
      headers: { 'User-Agent': 'SimpleCode', Accept: 'application/vnd.github+json' }
    });
    if (res.ok) json = await res.json();
  } catch { /* fallback */ }
  const tag = String(json?.tag_name || FALLBACK_TAG);
  const assets = Array.isArray(json?.assets) ? json.assets : [];
  const want = flavor === 'cpu' ? 'win-cpu-x64' : (flavor === 'cuda12' ? 'win-cuda12-x64' : 'win-vulkan-x64');
  let hit = assets.find((a) => String(a.name || '').includes(want) && /\.zip$/i.test(a.name));
  if (!hit) {
    const suffix = tag.replace(/^master-/, 'master-').split('-').slice(-1)[0] || 'c678dfe';
    hit = { name: `sd-master-${suffix}-bin-${want}.zip`, browser_download_url: `https://github.com/leejet/stable-diffusion.cpp/releases/download/${tag}/sd-master-${suffix}-bin-${want}.zip` };
  }
  return { tag, name: hit.name, url: hit.browser_download_url || hit.url };
}

async function unzipTo(zipPath, outDir, onWait) {
  onWait?.('正在解压本地生图引擎…');
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  const zip = await JSZip.loadAsync(fs.readFileSync(zipPath));
  for (const rel of Object.keys(zip.files)) {
    const entry = zip.files[rel];
    if (!entry || entry.dir) continue;
    const dest = path.join(outDir, rel.replace(/\\/g, '/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, await entry.async('nodebuffer'));
  }
}

async function downloadZip(asset, flavor, onWait) {
  const destDir = enginesRoot();
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, asset.name);
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 * 1024) return dest;
  let lastErr = null;
  for (const wrap of GH_MIRRORS) {
    const url = wrap(asset.url);
    onWait?.(`正在下载本地生图引擎（${flavor}）…`);
    const r = await downloader.download({
      id: `sd-engine-${asset.tag}-${flavor}`,
      url,
      dir: destDir,
      name: asset.name,
      threads: 4,
      onProgress: (p) => {
        if (!p?.total) return;
        onWait?.(`正在下载生图引擎 ${Math.min(99, Math.round((p.downloaded / p.total) * 100))}%`);
      }
    });
    if (r.ok && r.path) return r.path;
    lastErr = new Error(r.message || '下载失败');
    try {
      fs.rmSync(dest, { force: true });
      fs.rmSync(`${dest}.part`, { force: true });
    } catch { /* ignore */ }
  }
  throw lastErr || new Error('生图引擎下载失败');
}

async function ensureBinary(flavor, onWait) {
  const root = enginesRoot();
  fs.mkdirSync(root, { recursive: true });
  const markerPath = path.join(root, `ready-${flavor}.json`);
  if (fs.existsSync(markerPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
      if (m.exe && fs.existsSync(m.exe)) return m;
    } catch { /* reinstall */ }
  }
  const asset = await pickReleaseAsset(flavor);
  const zipPath = await downloadZip(asset, flavor, onWait);
  const outDir = path.join(root, `${asset.tag}-${flavor}`);
  await unzipTo(zipPath, outDir, onWait);
  const exeName = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
  const exe = findNamed(outDir, exeName);
  if (!exe) throw new Error('生图引擎压缩包里没有 sd-cli，请重试下载');
  const marker = { tag: asset.tag, flavor, exe, dir: path.dirname(exe) };
  fs.writeFileSync(markerPath, JSON.stringify(marker, null, 2), 'utf8');
  diag.log('image-gen-engine', '引擎已就绪', marker);
  return marker;
}

function runSdCli({ exe, cwd, args, signal, onWait }) {
  return new Promise((resolve, reject) => {
    onWait?.('本地生图模型推理中（首次较慢）…');
    let stderr = '';
    const child = spawn(exe, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => { try { child.kill(); } catch { /* ignore */ } };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('本地生图超时，可换更小模型或降低分辨率'));
    }, GEN_TIMEOUT_MS);
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-4000); });
    // [铆钉优化] sd-cli 的进度条写在 stdout，不读的话管道缓冲写满后进程会卡死直到超时。其他 AI 请勿删掉 stdout 的读取
    let lastStep = '';
    child.stdout.on('data', (d) => {
      const text = d.toString('utf8');
      stderr = (stderr + text).slice(-4000);
      const hits = [...text.matchAll(/\|\s*(\d+)\/(\d+)\s*-\s*([\d.]+)(s\/it|it\/s)/g)];
      const hit = hits[hits.length - 1];
      if (!hit) return;
      const step = `${hit[1]}/${hit[2]}`;
      if (step === lastStep) return;
      lastStep = step;
      onWait?.(`本地生图中：第 ${hit[1]}/${hit[2]} 步（${hit[3]}${hit[4]}）`);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(abortErr());
      if (code === 0) return resolve();
      const log = stderr.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\s*\|[#=> ]*\|\s*\d+\/\d+[^\n\[]*/g, '').trim();
      reject(new Error((log || `sd-cli 退出码 ${code}`).slice(-800)));
    });
  });
}

async function resolveQwenArgs(modelPath, modelsDir, prompt, outPath, onWait, signal) {
  const vae = await ensureQwenVae(modelsDir, modelPath, onWait, signal);
  const llm = await ensureQwenLlm(modelsDir, modelPath, onWait, signal);
  return [
    '--diffusion-model', modelPath,
    '--vae', vae,
    '--llm', llm,
    '--cfg-scale', '2.5',
    '--sampling-method', 'euler',
    '--steps', '28',
    '-H', '768',
    '-W', '768',
    '--flow-shift', '3',
    '--diffusion-fa',
    '--offload-to-cpu',
    '-p', String(prompt || '').trim() || 'a simple illustration',
    '-o', outPath
  ];
}

function resolveSimpleArgs(modelPath, prompt, outPath, recipe) {
  const text = String(prompt || '').trim() || 'a simple illustration';
  if (recipe === 'flux' || recipe === 'z-image') {
    return [
      '-m', modelPath,
      '--sampling-method', 'euler',
      '--steps', '20',
      '-H', '768',
      '-W', '768',
      '--offload-to-cpu',
      '-p', text,
      '-o', outPath
    ];
  }
  return [
    '-m', modelPath,
    '--steps', '20',
    '-H', '768',
    '-W', '768',
    '--offload-to-cpu',
    '-p', text,
    '-o', outPath
  ];
}

/**
 * 本地 GGUF 文生图（stable-diffusion.cpp）
 * @returns {{ buf: Buffer, ext: string }}
 */
async function generate({ modelPath, prompt, modelsDir, onWait, signal }) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error('未找到生图模型文件，请确认已下载到模型目录并在「模型组合」挂到生图槽位');
  }
  fs.mkdirSync(modelsDir, { recursive: true });
  const recipe = detectRecipe(modelPath, modelsDir);
  const outPath = path.join(os.tmpdir(), `sc-img-${Date.now()}.png`);

  const flavors = [];
  const prefer = await pickFlavor();
  flavors.push(prefer);
  if (prefer !== 'cpu') flavors.push('cpu');

  let lastErr = null;
  for (const flavor of flavors) {
    try {
      const bin = await ensureBinary(flavor, onWait);
      let args;
      if (recipe === 'qwen-image') {
        args = await resolveQwenArgs(modelPath, modelsDir, prompt, outPath, onWait, signal);
      } else {
        args = resolveSimpleArgs(modelPath, prompt, outPath, recipe);
      }
      diag.log('image-gen-engine', '运行 sd-cli', { recipe, flavor, model: path.basename(modelPath) });
      await runSdCli({ exe: bin.exe, cwd: bin.dir, args, signal, onWait });
      if (!fs.existsSync(outPath)) throw new Error('生图完成但未找到输出文件');
      const buf = fs.readFileSync(outPath);
      try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
      if (!buf.length) throw new Error('生图输出为空');
      return { buf, ext: '.png' };
    } catch (e) {
      lastErr = e;
      try { fs.rmSync(outPath, { force: true }); } catch { /* ignore */ }
      if (e.name === 'AbortError') throw e;
      diag.log('image-gen-engine', '该加速方式生图失败，尝试下一个', { flavor, message: e && e.message });
    }
  }
  throw lastErr || new Error('本地生图失败');
}

module.exports = { generate, detectRecipe: (modelPath, modelsDir) => detectRecipe(modelPath, modelsDir) };
