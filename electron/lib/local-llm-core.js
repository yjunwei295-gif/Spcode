const fs = require('fs');
const path = require('path');

// 本地 GGUF 推理内核。这里不依赖 electron，方便放到子进程里跑，
// 避免模型加载/生成占满主进程导致界面点不动。

let lib = null;
let loaded = {
  path: '',
  llama: null,
  model: null,
  context: null
};
// 视觉模型独立缓存槽：与文本模型分开驻留，
// 这样主模型生成和视觉代理识别可以同时加载，互不挤掉。
let visionLoaded = {
  path: '',
  mmproj: '',
  llama: null,
  model: null,
  context: null
};

function asText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((p) => {
      if (typeof p === 'string') return p;
      if (p?.type === 'text') return p.text || '';
      if (p?.type === 'image_url') return '[图片附件]';
      return p?.text || p?.content || '';
    }).filter(Boolean).join('\n');
  }
  return String(value);
}

function toolsToFunctions(tools) {
  const out = {};
  for (const t of tools || []) {
    const f = t.function || t;
    if (!f?.name) continue;
    const params = f.parameters && Object.keys(f.parameters.properties || {}).length
      ? {
        type: 'object',
        properties: f.parameters.properties,
        required: f.parameters.required
      }
      : undefined;
    out[f.name] = { description: f.description || '', params };
  }
  return out;
}

function toHistory(messages) {
  const history = [];
  for (const m of messages || []) {
    const role = m.role;
    if (role === 'system') {
      history.push({ type: 'system', text: asText(m.content) });
      continue;
    }
    if (role === 'user') {
      history.push({ type: 'user', text: asText(m.content) || '请继续' });
      continue;
    }
    if (role === 'assistant') {
      const response = [];
      const text = asText(m.content);
      if (text) response.push(text);
      for (const tc of m.tool_calls || []) {
        let params = {};
        try {
          params = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          params = {};
        }
        response.push({
          type: 'functionCall',
          name: tc.function?.name || '',
          params,
          result: '',
          id: tc.id
        });
      }
      history.push({ type: 'model', response: response.length ? response : [''] });
      continue;
    }
    if (role === 'tool') {
      const last = history[history.length - 1];
      if (last?.type !== 'model') continue;
      const calls = last.response.filter((x) => x && x.type === 'functionCall');
      const hit = calls.find((c) => c.id === m.tool_call_id && !c.result)
        || calls.find((c) => !c.result);
      if (hit) hit.result = asText(m.content);
    }
  }
  for (const item of history) {
    if (item.type !== 'model' || !Array.isArray(item.response)) continue;
    for (const part of item.response) {
      if (part && part.type === 'functionCall') {
        if (!part.result) part.result = '（无结果）';
        delete part.id;
      }
    }
  }
  return history;
}

async function loadLib() {
  if (!lib) lib = await import('node-llama-cpp');
  return lib;
}

async function disposeLoaded() {
  try {
    if (loaded.context) await loaded.context.dispose();
  } catch { /* 忽略 */ }
  try {
    if (loaded.model) await loaded.model.dispose();
  } catch { /* 忽略 */ }
  loaded = { path: '', llama: null, model: null, context: null };
}

async function disposeVision() {
  try {
    if (visionLoaded.context) await visionLoaded.context.dispose();
  } catch { /* 忽略 */ }
  try {
    if (visionLoaded.model) await visionLoaded.model.dispose();
  } catch { /* 忽略 */ }
  visionLoaded = { path: '', mmproj: '', llama: null, model: null, context: null };
}

async function ensureModel(modelPath, onWait) {
  if (loaded.path === modelPath && loaded.model && loaded.context) return loaded;
  await disposeLoaded();
  const { getLlama } = await loadLib();
  onWait?.(0);
  const llama = await getLlama();
  try {
    const model = await llama.loadModel({ modelPath });
    const context = await model.createContext();
    loaded = { path: modelPath, llama, model, context };
    return loaded;
  } catch (e) {
    const name = path.basename(modelPath);
    throw new Error(`加载模型「${name}」失败：${e.message}。可能是内存不足，或内置推理引擎不支持这个模型（多模态模型通常需要额外的投影文件）。请换一个 .gguf 再试。`);
  }
}

// 加载视觉模型（模型 + mmproj 投影）。幂等：同一模型+投影已加载时直接复用。
// 视觉模型与文本模型分开缓存，互不影响。
async function ensureVision(modelPath, mmproj, onWait) {
  if (
    visionLoaded.path === modelPath
    && visionLoaded.mmproj === mmproj
    && visionLoaded.model
    && visionLoaded.context
  ) {
    return visionLoaded;
  }
  await disposeVision();
  const { getLlama } = await loadLib();
  onWait?.(0);
  const llama = await getLlama();
  const sameFile = mmproj && path.resolve(mmproj) === path.resolve(modelPath);
  const usable = mmproj && fs.existsSync(mmproj) && !sameFile && /mmproj/i.test(path.basename(mmproj));
  try {
    const model = await llama.loadModel(usable ? { modelPath, mmproj } : { modelPath });
    const context = await model.createContext();
    visionLoaded = { path: modelPath, mmproj: usable ? mmproj : '', llama, model, context };
    return visionLoaded;
  } catch (e) {
    const name = path.basename(modelPath);
    if (usable) {
      throw new Error(`加载视觉模型「${name}」失败：${e.message}。请确认投影文件与模型匹配。`);
    }
    throw new Error(`加载视觉模型「${name}」失败：缺少投影文件（mmproj）。${e.message}`);
  }
}

function stoppedError() {
  const err = new Error('已停止');
  err.name = 'AbortError';
  err.code = 'aborted';
  return err;
}

function friendlyModelError(e) {
  const msg = String((e && e.message) || e || '');
  if (/No sequences left/i.test(msg)) {
    return new Error('本地模型上下文占满了。请新开一个对话再试，或把过长的历史清掉。');
  }
  return e instanceof Error ? e : new Error(msg);
}

async function resetContext(pack) {
  try {
    if (pack.context) await pack.context.dispose();
  } catch { /* 旧上下文可能已经坏了 */ }
  pack.context = await pack.model.createContext();
}

async function withChat(pack, fn, signal) {
  if (signal?.aborted) throw stoppedError();
  if (!pack.context || pack.context.sequencesLeft < 1) {
    await resetContext(pack);
  }
  let sequence;
  let chat;
  try {
    sequence = pack.context.getSequence();
    const { LlamaChat } = await loadLib();
    chat = new LlamaChat({ contextSequence: sequence, autoDisposeSequence: true });
    return await fn(chat);
  } catch (e) {
    if (/No sequences left/i.test(String(e && e.message))) {
      await resetContext(pack);
      sequence = pack.context.getSequence();
      const { LlamaChat } = await loadLib();
      chat = new LlamaChat({ contextSequence: sequence, autoDisposeSequence: true });
      return await fn(chat);
    }
    throw e;
  } finally {
    try { chat?.dispose?.(); } catch { /* 忽略 */ }
  }
}

const textSlot = { current: Promise.resolve() };
const visionSlot = { current: Promise.resolve() };

function withLock(slot, fn) {
  let release;
  const prev = slot.current;
  slot.current = new Promise((r) => { release = r; });
  return prev.then(fn, fn).finally(() => release());
}

async function complete({ modelPath, messages, onDelta, onReason, signal, onWait, tools }) {
  onDelta = onDelta || (() => {});
  onReason = onReason || (() => {});
  onWait = onWait || (() => {});
  if (signal?.aborted) throw stoppedError();
  if (!modelPath) {
    throw new Error('未找到本地 GGUF 模型。请把 .gguf 文件放到本地模型目录，并在输入框旁选择。');
  }

  const startAt = Date.now();
  const heartbeat = setInterval(() => {
    onWait(Math.floor((Date.now() - startAt) / 1000));
  }, 15000);
  try {
    const pack = await ensureModel(modelPath, onWait);
    if (signal?.aborted) throw stoppedError();
    const history = toHistory(messages);
    const functions = tools?.length ? toolsToFunctions(tools) : undefined;
    const result = await withLock(textSlot, () => withChat(pack, (chat) => chat.generateResponse(history, {
      signal,
      stopOnAbortSignal: true,
      functions,
      onTextChunk: (text) => {
        if (text) onDelta(text);
      },
      onResponseChunk: (chunk) => {
        if (chunk?.type === 'segment' && chunk.segmentType === 'thought' && chunk.text) {
          onReason(chunk.text);
        }
      }
    }), signal));
    const msg = { role: 'assistant', content: result.response || '' };
    const calls = result.functionCalls || [];
    if (calls.length) {
      msg.tool_calls = calls.map((c, i) => ({
        id: `call_${i}`,
        type: 'function',
        function: {
          name: c.functionName,
          arguments: JSON.stringify(c.params ?? {})
        }
      }));
      if (!msg.content) msg.content = null;
    }
    return msg;
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw stoppedError();
    throw friendlyModelError(e);
  } finally {
    clearInterval(heartbeat);
  }
}

// 图片识别（视觉模型）：模型 + mmproj + 图片 base64，返回识别文字。
// 全程本地推理，不依赖任何外部服务。
async function visionComplete({ modelPath, mmproj, dataUrl, prompt, signal, onWait }) {
  onWait = onWait || (() => {});
  if (signal?.aborted) throw stoppedError();
  if (!modelPath) {
    throw new Error('未找到本地视觉模型。请在「文件 → 视觉设置」中选择视觉模型（GGUF）。');
  }
  const base64 = String(dataUrl || '').replace(/^data:image\/[^;]+;base64,/, '');
  const image = Buffer.from(base64, 'base64');
  if (!image.length) throw new Error('图片数据为空，无法识别。');

  const startAt = Date.now();
  const heartbeat = setInterval(() => {
    onWait(Math.floor((Date.now() - startAt) / 1000));
  }, 15000);
  try {
    const pack = await ensureVision(modelPath, mmproj, onWait);
    if (signal?.aborted) throw stoppedError();
    const result = await withLock(visionSlot, () => withChat(pack, (chat) => chat.generateResponse([
      {
        type: 'user',
        text: prompt || '请识别这张图片，把图中的文字原样提取出来，并简要描述画面内容。',
        image: [image]
      }
    ], {
      signal,
      stopOnAbortSignal: true
    }), signal));
    const text = String(result.response || '').trim();
    if (!text) throw new Error('视觉模型没有返回识别内容。');
    return text;
  } catch (e) {
    if (signal?.aborted || e?.name === 'AbortError') throw stoppedError();
    throw friendlyModelError(new Error(`本地视觉模型识别失败：${e.message}`));
  } finally {
    clearInterval(heartbeat);
  }
}

async function probe(modelPath) {
  if (!modelPath || !fs.existsSync(modelPath)) {
    throw new Error('模型文件不存在');
  }
  const { readGgufFileInfo } = await loadLib();
  const info = await readGgufFileInfo(modelPath);
  const name = info?.metadata?.general?.name || path.basename(modelPath);
  return { ok: true, name, models: [name] };
}

module.exports = { complete, visionComplete, ensureVision, probe, disposeLoaded, stoppedError };
