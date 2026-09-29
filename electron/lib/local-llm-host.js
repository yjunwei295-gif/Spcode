const core = require('./local-llm-core');

// 推理子进程入口：父进程发任务，这里跑模型，把 token 回传。
// 生成期间即使吃满 CPU，主进程仍然空闲，界面和「停止」按钮照常响应。

const running = new Map();

function send(msg) {
  if (process.parentPort) process.parentPort.postMessage(msg);
}

async function runComplete(id, payload) {
  const ctl = new AbortController();
  running.set(id, ctl);
  try {
    const result = await core.complete({
      modelPath: payload.modelPath,
      messages: payload.messages,
      tools: payload.tools,
      signal: ctl.signal,
      onDelta: (text) => send({ t: 'delta', id, text }),
      onReason: (text) => send({ t: 'reason', id, text }),
      onWait: (sec) => send({ t: 'wait', id, sec })
    });
    send({ t: 'ok', id, result });
  } catch (e) {
    send({ t: 'err', id, message: (e && e.message) || String(e), code: e && e.code, name: e && e.name });
  } finally {
    running.delete(id);
  }
}

async function runVisionStart(id, payload) {
  try {
    const result = await core.ensureVision(payload.modelPath, payload.mmproj);
    send({ t: 'ok', id, result: { ok: true, name: payload.modelPath } });
  } catch (e) {
    send({ t: 'err', id, message: (e && e.message) || String(e) });
  }
}

async function runVision(id, payload) {
  const ctl = new AbortController();
  running.set(id, ctl);
  try {
    const result = await core.visionComplete({
      modelPath: payload.modelPath,
      mmproj: payload.mmproj,
      dataUrl: payload.dataUrl,
      prompt: payload.prompt,
      signal: ctl.signal,
      onWait: (sec) => send({ t: 'wait', id, sec })
    });
    send({ t: 'ok', id, result });
  } catch (e) {
    send({ t: 'err', id, message: (e && e.message) || String(e), code: e && e.code, name: e && e.name });
  } finally {
    running.delete(id);
  }
}

async function runProbe(id, payload) {
  try {
    send({ t: 'ok', id, result: await core.probe(payload.modelPath) });
  } catch (e) {
    send({ t: 'err', id, message: (e && e.message) || String(e) });
  }
}

function onMessage(msg) {
  if (!msg || !msg.t) return;
  if (msg.t === 'complete') runComplete(msg.id, msg.payload || {});
  else if (msg.t === 'visionStart') runVisionStart(msg.id, msg.payload || {});
  else if (msg.t === 'vision') runVision(msg.id, msg.payload || {});
  else if (msg.t === 'probe') runProbe(msg.id, msg.payload || {});
  else if (msg.t === 'abort') running.get(msg.id)?.abort();
}

if (process.parentPort) {
  process.parentPort.on('message', (e) => onMessage(e && e.data));
}
