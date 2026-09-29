const path = require('path');
const { httpFetch } = require('./http-fetch');
const localLlm = require('./local-llm');
const imageGenEngine = require('./image-gen-engine');

const DEFAULTS = {
  imageGen: { size: '1024x1024', paths: ['images/generations'] },
  videoGen: { seconds: 5, paths: ['videos/generations', 'video/generations', 'videos'] },
  model3d: { paths: ['meshes/generations', '3d/generations', 'models/generations'] }
};

function isApiCfg(modelCfg) {
  return !!(modelCfg && modelCfg.baseUrl && modelCfg.model);
}

function localGenHint(roleName) {
  if (roleName === '生图') {
    return '未找到可用的本地生图模型。请把 Qwen-Image / FLUX / SD 等 .gguf 下载到模型目录，并在「文件 → 模型组合」挂到生图槽位；首次运行会自动下载生图引擎与配套文件。';
  }
  return `本地 GGUF 不能${roleName}。请在「文件 → 模型组合」把该槽位改挂接口模型。`;
}

/**
 * 向兼容接口 POST JSON，失败返回 { status, text }，成功返回解析后的对象
 */
async function postJson(modelCfg, relPath, body, signal) {
  const url = `${String(modelCfg.baseUrl).replace(/\/$/, '')}/${String(relPath).replace(/^\//, '')}`;
  const headers = { 'Content-Type': 'application/json' };
  if (modelCfg.apiKey) headers.Authorization = `Bearer ${modelCfg.apiKey}`;
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), 8 * 60 * 1000);
  try {
    const res = await httpFetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctl.signal
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
    return { ok: res.ok, status: res.status, url, text, json };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function extFromMime(mime, fallback) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('png')) return '.png';
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('webm')) return '.webm';
  if (m.includes('gltf')) return '.gltf';
  if (m.includes('glb')) return '.glb';
  if (m.includes('obj')) return '.obj';
  return fallback;
}

function fromB64(raw, fallbackExt) {
  const s = String(raw || '');
  const data = s.match(/^data:([^;]+);base64,(.+)$/i);
  if (data) {
    return { buf: Buffer.from(data[2], 'base64'), ext: extFromMime(data[1], fallbackExt) };
  }
  return { buf: Buffer.from(s, 'base64'), ext: fallbackExt };
}

async function fromUrl(fileUrl, fallbackExt, signal) {
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), 8 * 60 * 1000);
  try {
    const res = await httpFetch(fileUrl, { signal: ctl.signal });
    if (!res.ok) throw new Error(`下载生成文件失败（HTTP ${res.status}）`);
    const mime = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    let fromPath = '';
    try { fromPath = path.extname(new URL(fileUrl).pathname); } catch { fromPath = ''; }
    return { buf, ext: fromPath || extFromMime(mime, fallbackExt) };
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

function firstString(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * 从常见生图/生视频/3D 返回结构里抽出文件
 */
async function extractAsset(json, fallbackExt, signal) {
  if (!json || typeof json !== 'object') return null;
  const item = Array.isArray(json.data) ? json.data[0] : json;
  if (!item || typeof item !== 'object') return null;
  if (item.task_id || item.taskId || json.task_id || json.taskId) {
    const err = new Error('该接口是排队出片，这一版只支持直接返回文件的接口。');
    err.code = 'async_job';
    throw err;
  }
  const b64 = firstString(item.b64_json, item.b64, item.image_base64, item.base64, json.b64_json);
  if (b64) return fromB64(b64, fallbackExt);
  let fileUrl = firstString(
    item.url, item.image_url, item.video_url, item.model_url, item.mesh_url,
    json.url, json.image_url, json.video_url
  );
  if (fileUrl.startsWith('//')) fileUrl = `https:${fileUrl}`;
  if (fileUrl) return fromUrl(fileUrl, fallbackExt, signal);
  const nested = item.image || item.video || item.mesh || item.model;
  if (typeof nested === 'string' && nested.startsWith('http')) {
    return fromUrl(nested, fallbackExt, signal);
  }
  if (typeof nested === 'string' && nested.length > 80) return fromB64(nested, fallbackExt);
  return null;
}

function errText(hit) {
  const j = hit.json;
  const msg = j && (j.error?.message || j.message || j.msg);
  if (msg) return String(msg);
  const t = String(hit.text || '').trim();
  if (t && t.length < 400) return t;
  if (hit.status === 401) {
    return 'HTTP 401（接口鉴权失败：请检查「设置→模型管理」里该 API 的密钥/地址，或改在「文件→模型组合→生图」挂本地 GGUF）';
  }
  return `HTTP ${hit.status}`;
}

async function tryPaths(modelCfg, paths, body, fallbackExt, signal) {
  const tried = [];
  let last = null;
  for (const p of paths) {
    const hit = await postJson(modelCfg, p, body, signal);
    last = hit;
    if (hit.ok && hit.json) {
      const asset = await extractAsset(hit.json, fallbackExt, signal);
      if (asset?.buf?.length) return asset;
    }
    tried.push(`${p}（${errText(hit)}）`);
    if (hit.status && hit.status !== 404 && hit.status !== 405) {
      throw new Error(errText(hit));
    }
  }
  throw new Error(`该接口没有可用的生成端点。已尝试：${tried.join('；')}`);
}

/**
 * 用接口模型生成媒体文件
 * @returns {{ buf: Buffer, ext: string }}
 */
async function generateMedia({ role, modelCfg, prompt, signal, modelsDir, onWait }) {
  if (role === 'imageGen') {
    const modelPath = localLlm.resolveGgufPath(modelCfg, modelsDir);
    const looksLocal = modelCfg?.type === 'local' || modelPath || /\.gguf$/i.test(modelCfg?.model || '');
    if (looksLocal) {
      if (!modelPath) throw new Error(localGenHint('生图'));
      return imageGenEngine.generate({ modelPath, prompt, modelsDir, onWait, signal });
    }
  }
  if (!isApiCfg(modelCfg)) {
    const names = { imageGen: '生图', videoGen: '生视频', model3d: '生 3D' };
    throw new Error(localGenHint(names[role] || '生成'));
  }
  const text = String(prompt || '').trim() || 'a simple scene';
  if (role === 'imageGen') {
    const bodies = [
      {
        model: modelCfg.model,
        prompt: text,
        n: 1,
        size: DEFAULTS.imageGen.size,
        response_format: 'b64_json'
      },
      {
        model: modelCfg.model,
        prompt: text,
        n: 1,
        size: DEFAULTS.imageGen.size
      }
    ];
    let lastErr;
    for (const body of bodies) {
      try {
        return await tryPaths(modelCfg, DEFAULTS.imageGen.paths, body, '.png', signal);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        lastErr = e;
      }
    }
    throw lastErr || new Error('生图接口没有返回图片');
  }
  if (role === 'videoGen') {
    return tryPaths(modelCfg, DEFAULTS.videoGen.paths, {
      model: modelCfg.model,
      prompt: text,
      seconds: DEFAULTS.videoGen.seconds,
      duration: DEFAULTS.videoGen.seconds
    }, '.mp4', signal);
  }
  if (role === 'model3d') {
    return tryPaths(modelCfg, DEFAULTS.model3d.paths, {
      model: modelCfg.model,
      prompt: text
    }, '.glb', signal);
  }
  throw new Error('未知生成用途');
}

module.exports = { generateMedia, isApiCfg, localGenHint };
