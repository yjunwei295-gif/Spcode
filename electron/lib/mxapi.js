/**
 * MXAPI 文档模型目录与原生视频：提交、查询并下载 Seedance / Veo 文生或参考图视频。
 * 文档：https://open.mxapi.org/api-test、https://open.mxapi.org/api-guide（2026-11-11 核对）。
 * 厂商派生选项只携带 providerId 与模型名，密钥在实际调用时从本机厂商配置取得。
 */
const { httpFetch } = require('./http-fetch');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');

/** 官方视频模型与各自任务路径；时长、比例等未传参数使用服务端的文档默认值。 */
const VIDEO_MODELS = [
  { model: 'doubao-seedance-1-0-pro-fast-251015', name: 'Seedance 1.0 Pro Fast', route: 'video' },
  { model: 'doubao-seedance-1-5-pro-251215', name: 'Seedance 1.5 Pro', route: 'video' },
  { model: 'veo-3.1-fast', name: 'Veo 3.1 Fast', route: 'veo' },
  { model: 'veo-3.1-quality', name: 'Veo 3.1 Quality', route: 'veo' },
  { model: 'veo-3.1-lite', name: 'Veo 3.1 Lite', route: 'veo' },
  { model: 'omni-flash', name: 'Omni Flash', route: 'veo' }
];
/**
 * OpenAI 生图入口的官方模型名，来自 https://open.mxapi.org/api-test（2026-11-11 核对）。
 * 仅列出 /v1/images/generations 文档明确支持的模型，不将其他原生绘图接口混入。
 */
const IMAGE_MODELS = [
  { model: 'nano-banana', name: 'Nano Banana' },
  { model: 'nano-banana-pro', name: 'Nano Banana Pro' },
  { model: 'nano-banana-2', name: 'Nano Banana 2' },
  { model: 'nano-banana-2-lite', name: 'Nano Banana 2 Lite' },
  { model: 'nano-banana-2.1', name: 'Nano Banana 2.1' },
  { model: 'gpt-image-2', name: 'GPT Image 2' },
  { model: 'gpt-image-2.5-sunburst', name: 'GPT Image 2.5 Sunburst' },
  { model: 'gpt-image-2.5-flare', name: 'GPT Image 2.5 Flare' },
  { model: 'gpt-image-2.6-sunburst', name: 'GPT Image 2.6 Sunburst' },
  { model: 'gpt-image-2.6-flare', name: 'GPT Image 2.6 Flare' }
];
/** 轮询遵循文档的 5~10 秒间隔，总时限沿用现有媒体生成的八分钟。 */
const POLL_INTERVAL_MS = 5000;
const GENERATION_TIMEOUT_MS = 8 * 60 * 1000;
const MODEL_ID_PREFIX = 'mxapi-video/';

/** 仅识别 MXAPI 官方入口，不按模型名称将其他厂商的请求转到 MXAPI。 */
function isMxApi(config) {
  return /^https:\/\/open\.mxapi\.org(?:\/|$)/i.test(String(config?.baseUrl || ''));
}

/** 为已添加的 MXAPI 厂商列出可直接选择的视频模型，不写配置、不自动绑定槽位。 */
function videoModels(providers) {
  const models = [];
  for (const provider of providers) {
    if (!isMxApi(provider)) continue;
    for (const entry of VIDEO_MODELS) {
      models.push({
        id: MODEL_ID_PREFIX + encodeURIComponent(provider.id) + '/' + encodeURIComponent(entry.model),
        name: provider.name + ' · ' + entry.name,
        type: 'api',
        providerId: provider.id,
        model: entry.model
      });
    }
  }
  return models;
}

/** 解析厂商派生的模型引用；厂商删除后返回 null，不使用旧密钥或其他厂商代替。 */
function resolveModel(id, providers) {
  if (!String(id).startsWith(MODEL_ID_PREFIX)) return null;
  for (const model of videoModels(providers)) {
    if (model.id === id) return model;
  }
  return null;
}

/** 调用官方原生 JSON 接口，HTTP 与业务状态失败均保留接口原因。 */
async function request(config, route, body, signal) {
  const url = new URL('/api/v2/' + route, config.baseUrl).href;
  const options = { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + config.apiKey }, signal };
  if (body !== undefined) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const response = await httpFetch(url, options);
  const json = await response.json();
  if (!response.ok || json.code !== 200) {
    throw new Error('MXAPI HTTP ' + response.status + ': ' + (json.message || json.error || '请求失败'));
  }
  return json.data;
}

/**
 * 按厂商入口提供官方文档目录，替代 MXAPI 未提供的 /models 接口。
 * config 使用已保存的地址与凭据；免费余额接口验证成功后才返回模型 ID 和展示目录。
 * 不发送生成请求、不保存模型、不绑定能力槽；未知入口和认证失败直接报告原因。
 */
async function listModels(config) {
  const basePath = new URL(config.baseUrl).pathname.replace(/\/+$/, '');
  let entries;
  switch (basePath) {
    case '/v1':
      entries = IMAGE_MODELS;
      break;
    case '/api/v2/nano':
      // 此原生接口只接收提示词，模型固定为 Nano 标准版，不能列出 Pro 或 GPT 供误选。
      entries = [{ model: 'nano-banana', name: 'Nano Banana' }];
      break;
    case '':
    case '/api/v2':
      // 视频生成按官方域名和模型名分派，根地址与视频模板使用同一目录。
      entries = VIDEO_MODELS;
      break;
    default:
      throw new Error('MXAPI 模型目录不支持此入口，请使用厂商模板中的生图、Nano 异步生图或原生视频地址');
  }
  await request(config, 'points/balance', undefined, AbortSignal.timeout(30000));
  const models = [];
  const catalog = Object.create(null);
  for (const entry of entries) {
    models.push(entry.model);
    catalog[entry.model] = { id: entry.model, name: entry.name };
  }
  return { ok: true, protocol: 'openai', models, catalog, balance: { available: false } };
}

/**
 * 上传真实参考图到 MXAPI 官方临时图片接口，返回生成接口可读取的 URL。
 * 接口与 multipart 的 image 字段来自官方 api-test 首帧上传实现；不发送厂商 Key。
 * 上传失败立即终止，不能忽略参考图后产生一次付费文生视频。
 */
async function uploadReferenceImage(config, imagePath, signal) {
  const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(imagePath).toLowerCase()];
  if (!mime) throw new Error('MXAPI 视频参考图须为 PNG、JPG 或 WEBP');
  const bytes = await fs.promises.readFile(imagePath);
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: mime }), path.basename(imagePath));
  const response = await httpFetch(new URL('/api/v1/upload/temp-image', config.baseUrl).href, { method: 'POST', body: form, signal });
  const json = await response.json();
  if (!response.ok || json.code !== 200) throw new Error('MXAPI 参考图上传失败：' + (json.message || response.status));
  if (!json.data?.url) throw new Error('MXAPI 参考图上传未返回图片地址');
  return json.data.url;
}

/**
 * 按已选模型生成视频并返回 MP4；参考图先上传，再作为首帧进入同一次生成请求。
 * duration 为用户明确指定的秒数：Seedance 支持 2~12 秒，Veo 3.1 仅 8 秒，Omni 支持 4/6/8/10 秒。
 * 不支持的时长在上传和扣费前报告；不自动改模型、改时长或重复提交生成任务。
 */
async function generateVideo({ modelCfg, prompt, signal, onWait, imagePath, duration }) {
  let selected;
  for (const entry of VIDEO_MODELS) {
    if (entry.model === modelCfg.model) selected = entry;
  }
  if (!selected) throw new Error('尚未接入此 MXAPI 视频模型：' + modelCfg.model);
  if (duration !== undefined) {
    const valid = selected.route === 'video'
      ? Number.isInteger(duration) && duration >= 2 && duration <= 12
      : (selected.model === 'omni-flash' ? [4, 6, 8, 10] : [8]).includes(duration);
    if (!valid) throw new Error('MXAPI 模型 ' + selected.model + ' 不支持 ' + duration + ' 秒，请使用该模型支持的时长');
  }
  const timeout = AbortSignal.timeout(GENERATION_TIMEOUT_MS);
  const taskSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  taskSignal.throwIfAborted();
  const body = selected.route === 'video'
    ? { model: selected.model, content: [{ type: 'text', text: duration === undefined ? prompt : prompt + ' --dur ' + duration }] }
    : { model: selected.model, prompt };
  if (selected.route === 'veo' && duration !== undefined) body.duration = String(duration);
  if (imagePath) {
    if (onWait) onWait('正在上传 MXAPI 视频参考图');
    const imageUrl = await uploadReferenceImage(modelCfg, imagePath, taskSignal);
    if (selected.route === 'video') body.content.push({ type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' });
    else {
      body.reference_images = [imageUrl];
      body.generation_type = 'frame';
    }
  }
  const submitted = await request(modelCfg, selected.route + '/generate', body, taskSignal);
  if (!submitted?.task_id) throw new Error('MXAPI 视频接口未返回 task_id');
  if (onWait) onWait('MXAPI 视频任务已提交，正在等待生成');
  while (true) {
    await delay(POLL_INTERVAL_MS, undefined, { signal: taskSignal });
    const task = await request(modelCfg, selected.route + '/task?task_id=' + encodeURIComponent(submitted.task_id), undefined, taskSignal);
    if (task.status === 'failed') throw new Error(task.error_msg || task.error || 'MXAPI 视频生成失败');
    if (task.status !== 'completed') {
      if (task.status !== 'pending' && task.status !== 'processing') throw new Error('MXAPI 返回未知视频状态：' + task.status);
      if (onWait) onWait('MXAPI 视频' + (task.status === 'pending' ? '排队中' : '生成中'));
      continue;
    }
    // Veo 文档明确建议优先使用临时代理地址；Seedance 返回 video_url。
    const url = selected.route === 'veo' && task.proxy_url ? task.proxy_url : task.video_url;
    if (!url) throw new Error('MXAPI 视频任务已完成但没有返回视频地址');
    if (onWait) onWait('MXAPI 视频已生成，正在下载');
    const response = await httpFetch(url, { signal: taskSignal });
    if (!response.ok) throw new Error('下载 MXAPI 视频失败（HTTP ' + response.status + '）');
    const buf = Buffer.from(await response.arrayBuffer());
    if (!buf.length) throw new Error('MXAPI 视频下载为空');
    return { buf, ext: '.mp4' };
  }
}

module.exports = { isMxApi, videoModels, resolveModel, listModels, generateVideo, MODEL_ID_PREFIX };
