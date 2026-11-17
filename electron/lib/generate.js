const path = require('path');
const fs = require('fs');
const { httpFetch } = require('./http-fetch');
const localLlm = require('./local-llm');
const imageGenEngine = require('./image-gen-engine');
const mxapi = require('./mxapi');

const DEFAULTS = {
  imageGen: { size: '1024x1024', paths: ['images/generations'] },
  videoGen: { seconds: 5, paths: ['videos/generations', 'video/generations', 'videos'] },
  model3d: { paths: ['meshes/generations', '3d/generations', 'models/generations'] }
};

function isApiCfg(modelCfg) {
  return !!(modelCfg && modelCfg.baseUrl && modelCfg.model);
}

/** 判断是否为 MXAPI 的 Nano 直接生图端点；该接口只接收 prompt，不走 OpenAI images/generations 路径。 */
function isMxApiNano(modelCfg) {
  return /(^|\/)api\/v2\/nano(?:\/?$)/i.test(String(modelCfg?.baseUrl || '').replace(/\/$/, ''));
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
  const baseUrl = String(modelCfg.baseUrl).replace(/\/$/, '');
  const pathPart = String(relPath || '').replace(/^\//, '');
  const url = pathPart ? `${baseUrl}/${pathPart}` : baseUrl;
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

/** 查询 MXAPI Nano 异步任务；状态完成后下载结果图片，失败或超时直接报告原因。 */
async function waitMxApiNano(modelCfg, taskId, signal) {
  const baseUrl = String(modelCfg.baseUrl).replace(/\/$/, '');
  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  const timer = setTimeout(() => ctl.abort(), 8 * 60 * 1000);
  try {
    const deadline = Date.now() + 8 * 60 * 1000;
    while (Date.now() < deadline) {
      const res = await httpFetch(`${baseUrl}/task?task_id=${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers: modelCfg.apiKey ? { Authorization: `Bearer ${modelCfg.apiKey}` } : {},
        signal: ctl.signal
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : {}; } catch { json = null; }
      if (!res.ok) throw new Error(errText({ status: res.status, text, json }));
      const data = json?.data || {};
      if (data.status === 'failed') throw new Error(data.error_msg || 'MXAPI Nano 生图任务失败');
      if (data.status === 'completed') {
        const result = data.result || {};
        const fileUrl = firstString(
          Array.isArray(result.images) ? result.images[0] : '',
          Array.isArray(result.proxy_images) ? result.proxy_images[0] : '',
          result.url,
          result.image_url
        );
        if (!fileUrl) throw new Error('MXAPI Nano 已完成但没有返回图片地址');
        return fromUrl(fileUrl, '.png', signal);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error('MXAPI Nano 生图任务等待超时');
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
 * 用 GPT 图片编辑接口按参考图重绘，上传真实图片字节而非仅发送本机路径。
 * imagePath 为上游已解析的图片路径；返回生成文件与实际模型、参考图记录。
 * 请求沿用生图接口的八分钟超时；鉴权、取消、接口错误均向上传递，不改用文生图。
 */
async function generateGptImageEdit(modelCfg, prompt, imagePath, signal, background, size) {
  const mimeTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  const mime = mimeTypes[path.extname(imagePath).toLowerCase()];
  if (!mime) throw new Error('GPT 参考图只支持 PNG、JPEG 或 WebP');
  const bytes = await fs.promises.readFile(imagePath);
  const form = new FormData();
  form.append('model', modelCfg.model);
  form.append('prompt', String(prompt).trim());
  form.append('image[]', new Blob([bytes], { type: mime }), path.basename(imagePath));
  form.append('n', '1');
  form.append('size', size);
  // 透明背景必须传接口字段；只在提示词中描述可能得到画进图片的棋盘格。
  if (background !== undefined) form.append('background', background);
  const headers = {};
  if (modelCfg.apiKey) headers.Authorization = `Bearer ${modelCfg.apiKey}`;
  const ctl = new AbortController();
  function abortEdit() { ctl.abort(); }
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', abortEdit, { once: true });
  }
  const timer = setTimeout(abortEdit, 8 * 60 * 1000);
  try {
    // 由 FormData 写入带 boundary 的 Content-Type，避免手写 JSON 头导致图片丢失。
    const baseUrl = String(modelCfg.baseUrl).replace(/\/$/, '');
    const res = await httpFetch(`${baseUrl}/images/edits`, { method: 'POST', headers, body: form, signal: ctl.signal });
    const text = await res.text();
    const isJson = String(res.headers.get('content-type') || '').includes('json');
    const json = isJson && text ? JSON.parse(text) : null;
    if (!res.ok) throw new Error(errText({ status: res.status, text, json }));
    if (!json) throw new Error('GPT 图片编辑接口没有返回 JSON 图片数据');
    const asset = await extractAsset(json, '.png', ctl.signal);
    if (!asset?.buf?.length) throw new Error('GPT 图片编辑接口没有返回图片');
    asset.generation = { model: modelCfg.model, mode: 'image-edit', imagePath, background, size };
    return asset;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', abortEdit);
  }
}

/**
 * 根据槽位生成媒体；GPT 参考图走图片编辑，MXAPI 视频透传参考图与时长，本地参数完整透传。
 * @returns {{ buf: Buffer, ext: string, generation?: object }}
 */
async function generateMedia({ role, modelCfg, prompt, signal, modelsDir, onWait, onProgress, imagePath, duration, background, imageOptions = {} }) {
  // 背景字段只接入 GPT 参考图编辑，其他路径明确拒绝，避免把透明请求悄悄丢弃。
  if (background !== undefined && !(role === 'imageGen' && imagePath && isApiCfg(modelCfg) && /^gpt-image-/i.test(modelCfg.model))) {
    throw new Error('background 仅支持 GPT 参考图编辑');
  }
  if (role === 'imageGen') {
    const modelPath = localLlm.resolveGgufPath(modelCfg, modelsDir);
    const looksLocal = modelCfg?.type === 'local' || modelPath || /\.gguf$/i.test(modelCfg?.model || '');
    if (looksLocal) {
      if (!modelPath) throw new Error(localGenHint('生图'));
      return imageGenEngine.generate({ modelPath, prompt, modelsDir, onWait, onProgress, signal, imagePath, imageOptions });
    }
  }
  // GPT 的参考图使用 multipart 图片编辑；尺寸映射为接口 size，拒绝本地采样参数。
  if (role === 'imageGen' && imagePath && isApiCfg(modelCfg) && /^gpt-image-/i.test(modelCfg.model)) {
    for (const key of Object.keys(imageOptions)) {
      if (key !== 'width' && key !== 'height') throw new Error('GPT 图片编辑不接收本地采样参数，仅支持参考图、宽高和提示词');
    }
    const hasWidth = imageOptions.width !== undefined;
    const hasHeight = imageOptions.height !== undefined;
    if (hasWidth !== hasHeight) throw new Error('GPT 图片编辑须同时指定 width 与 height');
    const size = hasWidth ? `${imageOptions.width}x${imageOptions.height}` : DEFAULTS.imageGen.size;
    return generateGptImageEdit(modelCfg, prompt, imagePath, signal, background, size);
  }
  // 其他接口尚未接入参考图，保持明确拒绝，不退回无参考图生成。
  if (role === 'imageGen' && (imagePath || Object.keys(imageOptions).length)) {
    throw new Error('图生图及这些生成参数当前仅接入本地生图模型，请在模型组合挂本地生图模型');
  }
  if (!isApiCfg(modelCfg)) {
    const names = { imageGen: '生图', videoGen: '生视频', model3d: '生 3D' };
    throw new Error(localGenHint(names[role] || '生成'));
  }
  const text = String(prompt || '').trim() || 'a simple scene';
  if (role === 'imageGen') {
    if (isMxApiNano(modelCfg)) {
      // MXAPI Nano 先返回 task_id，再轮询 /task 直到结果图片可下载。
      const hit = await postJson(modelCfg, '', { prompt: text }, signal);
      if (!hit.ok || !hit.json) throw new Error(errText(hit));
      const taskId = hit.json?.data?.task_id;
      if (taskId) return waitMxApiNano(modelCfg, taskId, signal);
      const direct = await extractAsset(hit.json, '.png', signal);
      if (direct?.buf?.length) return direct;
      throw new Error('MXAPI Nano 没有返回任务 ID 或图片');
    }
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
    // MXAPI 原生视频为异步任务，不能送进仅接受直接文件结果的通用路径。
    if (mxapi.isMxApi(modelCfg)) return mxapi.generateVideo({ modelCfg, prompt: text, signal, onWait, imagePath, duration });
    // 通用视频路径尚未接入参考图，明确失败，避免丢图后仍发生付费生成。
    if (imagePath) throw new Error('此视频厂商尚未接入参考图上传，不能忽略参考图生成');
    return tryPaths(modelCfg, DEFAULTS.videoGen.paths, {
      model: modelCfg.model,
      prompt: text,
      seconds: duration === undefined ? DEFAULTS.videoGen.seconds : duration,
      duration: duration === undefined ? DEFAULTS.videoGen.seconds : duration
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
