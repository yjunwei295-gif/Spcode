const fs = require('fs');
const path = require('path');
const { utilityProcess } = require('electron');
const core = require('./local-llm-core');

// 模型文件的扫描/定位在主进程里做（纯 fs，很快）；
// 真正的加载与生成交给子进程，避免主进程被推理占满、界面点不动。

const HOST_PATH = path.join(__dirname, 'local-llm-host.js');

let child = null;
let childUsable = true; // 子进程起不来时退回主进程内推理，至少还能用
let seq = 0;
const pending = new Map();

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listGguf(dir) {
  ensureDir(dir);
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.gguf')) continue;
    const abs = path.join(dir, name);
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) out.push({ name, path: abs, size: st.size });
    } catch {
      /* 跳过无法读取的文件 */
    }
  }
  out.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return out;
}

function resolveGgufPath(modelCfg, modelsDir) {
  const abs = String(modelCfg?.modelPath || '').trim();
  if (abs && fs.existsSync(abs)) return abs;
  const name = String(modelCfg?.model || '').trim();
  if (!name) return '';
  if (path.isAbsolute(name) && fs.existsSync(name)) return name;
  if (!modelsDir) return '';
  const joined = path.join(modelsDir, name);
  return fs.existsSync(joined) ? joined : '';
}

function rejectAllPending(message) {
  for (const [, task] of pending) {
    const err = new Error(message);
    err.code = 'host_down';
    task.reject(err);
  }
  pending.clear();
}

function handleMessage(msg) {
  if (!msg || !msg.t) return;
  const task = pending.get(msg.id);
  if (!task) return;
  if (msg.t === 'delta') task.onDelta?.(msg.text);
  else if (msg.t === 'reason') task.onReason?.(msg.text);
  else if (msg.t === 'wait') task.onWait?.(msg.sec);
  else if (msg.t === 'ok') {
    pending.delete(msg.id);
    task.resolve(msg.result);
  } else if (msg.t === 'err') {
    pending.delete(msg.id);
    const err = new Error(msg.message || '本地模型出错');
    if (msg.code) err.code = msg.code;
    if (msg.name) err.name = msg.name;
    task.reject(err);
  }
}

function ensureChild() {
  if (child) return child;
  if (!childUsable) return null;
  try {
    child = utilityProcess.fork(HOST_PATH, [], { serviceName: 'simple-local-llm' });
  } catch {
    childUsable = false;
    child = null;
    return null;
  }
  child.on('message', handleMessage);
  child.on('exit', () => {
    child = null;
    rejectAllPending('本地模型进程已退出，请重试。');
  });
  return child;
}

function callHost(type, payload, hooks = {}) {
  const proc = ensureChild();
  if (!proc) return null;
  const id = `t${++seq}`;
  const promise = new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, ...hooks });
    try {
      proc.postMessage({ t: type, id, payload });
    } catch (e) {
      pending.delete(id);
      reject(e);
    }
  });
  return { id, promise };
}

async function complete({ modelCfg, modelsDir, messages, onDelta, onReason, signal, onWait, tools }) {
  const modelPath = resolveGgufPath(modelCfg, modelsDir);
  if (!modelPath) {
    throw new Error('未找到本地 GGUF 模型。请把 .gguf 文件放到本地模型目录，并在输入框旁选择。');
  }
  if (signal?.aborted) throw core.stoppedError();

  const task = callHost('complete', { modelPath, messages, tools }, { onDelta, onReason, onWait });
  if (task) {
    const onAbort = () => {
      try { child?.postMessage({ t: 'abort', id: task.id }); } catch { /* 进程已退出 */ }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await task.promise;
    } catch (e) {
      if (signal?.aborted) throw core.stoppedError();
      if (e.code !== 'host_down') throw e;
      childUsable = false; // 子进程用不了就退回主进程内推理
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return core.complete({ modelPath, messages, tools, onDelta, onReason, onWait, signal });
}

// 预加载视觉模型（模型 + mmproj），让「完成」按钮能真正把本地视觉模型启动起来。
// 幂等：同一模型+投影已加载时直接返回。
async function startVision({ modelPath, mmproj }) {
  if (!modelPath) throw new Error('未找到视觉模型文件');
  if (!mmproj || !fs.existsSync(mmproj)) {
    throw new Error('投影文件不存在，请在「文件 → 视觉设置」中填写正确的 .mmproj 路径。');
  }
  const task = callHost('visionStart', { modelPath, mmproj });
  if (task) {
    try {
      return await task.promise;
    } catch (e) {
      if (e.code !== 'host_down') throw e;
      childUsable = false;
    }
  }
  return core.ensureVision(modelPath, mmproj);
}

// 图片识别：走子进程，识别期间主进程仍保持响应。
async function visionComplete({ modelPath, mmproj, dataUrl, prompt, signal, onWait }) {
  if (!modelPath) throw new Error('未找到本地视觉模型。请在「文件 → 视觉设置」中选择。');
  if (signal?.aborted) throw core.stoppedError();

  const task = callHost('vision', { modelPath, mmproj, dataUrl, prompt }, { onWait });
  if (task) {
    const onAbort = () => {
      try { child?.postMessage({ t: 'abort', id: task.id }); } catch { /* 进程已退出 */ }
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      return await task.promise;
    } catch (e) {
      if (signal?.aborted) throw core.stoppedError();
      if (e.code !== 'host_down') throw e;
      childUsable = false;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  }
  return core.visionComplete({ modelPath, mmproj, dataUrl, prompt, signal, onWait });
}

async function probe(modelPath) {
  if (!modelPath || !fs.existsSync(modelPath)) throw new Error('模型文件不存在');
  const task = callHost('probe', { modelPath });
  if (task) {
    try {
      return await task.promise;
    } catch (e) {
      if (e.code !== 'host_down') throw e;
      childUsable = false;
    }
  }
  return core.probe(modelPath);
}

function disposeLoaded() {
  if (child) {
    try { child.kill(); } catch { /* 忽略 */ }
    child = null;
  }
  return core.disposeLoaded();
}

module.exports = {
  ensureDir,
  listGguf,
  resolveGgufPath,
  complete,
  startVision,
  visionComplete,
  probe,
  disposeLoaded
};
