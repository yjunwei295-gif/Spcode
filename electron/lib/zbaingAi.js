const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join('D:', 'Ai', 'zai', 'zbaingAi');

/** @type {Map<string, { child: import('child_process').ChildProcess, buf: string, pending: Array<{resolve:Function,reject:Function,onDelta:Function,onThink:Function}> }>} */
const daemons = new Map();

function resolveRoot(modelCfg) {
  const r = String(modelCfg?.zbaingRoot || process.env.ZAI_ZBAING_ROOT || DEFAULT_ROOT).trim();
  return path.resolve(r);
}

function resolvePython() {
  return process.env.ZBAING_PYTHON || 'python';
}

function stoppedError() {
  const e = new Error('已停止');
  e.name = 'AbortError';
  return e;
}

function killDaemon(root) {
  const d = daemons.get(root);
  if (!d) return;
  try { d.child.kill(); } catch { /* ignore */ }
  daemons.delete(root);
}

function _brainStamp(root) {
  // 只盯源码/配置。latest.pt 和 chunks.jsonl 每轮都会被写，算进 stamp
  // 等于守护进程醒来就把自己杀掉。
  const files = ['serve.py', 'agent.py', 'router.py', 'zlm_brain.py', 'zlm_chat.py', 'chat_data.py', 'workspace_bridge.py', 'config.json', 'brain.py', 'context_brief.py', 'zabing.py'];
  let max = 0;
  for (const f of files) {
    const p = path.join(root, f);
    try {
      if (fs.existsSync(p)) max = Math.max(max, fs.statSync(p).mtimeMs);
    } catch { /* ignore */ }
  }
  for (const f of ['lm_train/model.py', 'lm_train/trainer.py']) {
    const p = path.join(root, f);
    try {
      if (fs.existsSync(p)) max = Math.max(max, fs.statSync(p).mtimeMs);
    } catch { /* ignore */ }
  }
  const retDir = path.join(root, 'retrieval');
  try {
    if (fs.existsSync(retDir)) {
      for (const name of fs.readdirSync(retDir)) {
        if (!name.endsWith('.py')) continue;
        max = Math.max(max, fs.statSync(path.join(retDir, name)).mtimeMs);
      }
    }
  } catch { /* ignore */ }
  const modDir = path.join(root, 'modules');
  try {
    if (fs.existsSync(modDir)) {
      for (const name of fs.readdirSync(modDir)) {
        if (!name.endsWith('.py')) continue;
        max = Math.max(max, fs.statSync(path.join(modDir, name)).mtimeMs);
      }
    }
  } catch { /* ignore */ }
  return max;
}

function _daemonAlive(state) {
  return !!(state && state.child && state.child.exitCode == null && !state.child.killed);
}

function ensureDaemon(root) {
  const existing = daemons.get(root);
  const stamp = _brainStamp(root);
  if (_daemonAlive(existing)) {
    const busy = !!(existing.pending && existing.pending.length);
    if (existing.stamp === stamp || busy) return existing;
    killDaemon(root);
  } else if (existing) {
    daemons.delete(root);
  }

  const script = path.join(root, 'serve.py');
  const py = resolvePython();
  const child = spawn(py, [script, '--daemon'], {
    cwd: root,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ZBAING_DAEMON: '1', PYTHONUNBUFFERED: '1' }
  });

  const state = { child, buf: '', pending: [], ready: false, stamp: _brainStamp(root) };
  daemons.set(root, state);

  child.stderr.on('data', (d) => {
    const msg = d.toString().trim();
    if (msg) console.error('[zbaingAi]', msg);
  });

  child.stdout.on('data', (chunk) => {
    state.buf += chunk.toString();
    let idx;
    while ((idx = state.buf.indexOf('\n')) >= 0) {
      const line = state.buf.slice(0, idx).trim();
      state.buf = state.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }

      if (msg.t === 'ready') {
        state.ready = true;
        continue;
      }

      const job = state.pending[0];
      if (msg.t === 'modules' && job && job.expectModules) {
        state.pending.shift();
        job.resolve(msg.modules || []);
        continue;
      }
      if (!job) continue;

      if (msg.t === 'think' && msg.text) job.onThink(msg.text);
      if (msg.t === 'reason' && msg.text) job.onReason(msg.text);
      if (msg.t === 'delta' && msg.text) job.onDelta(msg.text);
      if (msg.t === 'ok') {
        state.pending.shift();
        job.resolve({
          role: 'assistant',
          content: msg.content || msg.message || '',
          zbaingMeta: {
            source: msg.source || 'guess',
            prompt: msg.prompt || '',
            minConf: msg.min_conf,
            retried: !!msg.retried,
            message: msg.message || '',
            thinking: msg.thinking || ''
          }
        });
      }
      if (msg.t === 'error') {
        state.pending.shift();
        job.reject(new Error(msg.message || 'zbaingAi 错误'));
      }
    }
  });

  child.on('close', (code) => {
    daemons.delete(root);
    const hint = code && code !== 0
      ? `zbaingAi 守护进程已退出（码 ${code}）。若正在训练请稍后再试；否则重发一条消息会自动重启。`
      : 'zbaingAi 守护进程已退出。重发一条消息会自动重启。';
    while (state.pending.length) {
      const job = state.pending.shift();
      job.reject(new Error(hint));
    }
  });

  return state;
}

function waitReady(state, timeoutMs) {
  if (state.ready) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (state.ready) {
        clearInterval(iv);
        resolve();
        return;
      }
      if (!_daemonAlive(state)) {
        clearInterval(iv);
        reject(new Error('zbaingAi 守护进程启动失败。'));
        return;
      }
      if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        reject(new Error('zbaingAi 守护进程启动超时。'));
      }
    }, 50);
  });
}

function completeViaDaemon({ root, payload, onDelta, onThink, onReason, signal }) {
  const state = ensureDaemon(root);
  return waitReady(state, 120000).then(() => new Promise((resolve, reject) => {
    const job = {
      resolve,
      reject,
      onDelta,
      onThink: onThink || (() => {}),
      onReason: onReason || (() => {})
    };
    const onAbort = () => {
      const i = state.pending.indexOf(job);
      if (i >= 0) state.pending.splice(i, 1);
      reject(stoppedError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    state.pending.push(job);
    state.child.stdin.write(payload + '\n', 'utf8', (err) => {
      if (err) reject(err);
    });
    const finish = (fn) => (...args) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(...args);
    };
    const origResolve = job.resolve;
    const origReject = job.reject;
    job.resolve = finish(origResolve);
    job.reject = finish(origReject);
  }));
}

function requestViaDaemon({ root, body, onDelta, signal, expectModules }) {
  const state = ensureDaemon(root);
  return waitReady(state, 120000).then(() => new Promise((resolve, reject) => {
    const job = { resolve, reject, onDelta: onDelta || (() => {}), expectModules: !!expectModules };
    const onAbort = () => {
      const i = state.pending.indexOf(job);
      if (i >= 0) state.pending.splice(i, 1);
      reject(stoppedError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    state.pending.push(job);
    state.child.stdin.write(JSON.stringify(body) + '\n', 'utf8', (err) => {
      if (err) reject(err);
    });
    const finish = (fn) => (...args) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(...args);
    };
    job.resolve = finish(job.resolve);
    job.reject = finish(job.reject);
  }));
}

function listModulesFromDisk(root) {
  const reg = path.join(root, 'modules', 'registry.json');
  if (!fs.existsSync(reg)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(reg, 'utf8'));
    const mods = Array.isArray(data.modules) ? data.modules : [];
    return mods.map((m) => {
      const row = { ...m };
      if (m && m.kind === 'zlm' && m.id) {
        const ck = path.join(root, 'modules', String(m.id), 'brain', 'zlm', 'latest.pt');
        row.trained = fs.existsSync(ck);
      } else {
        row.trained = false;
      }
      return row;
    });
  } catch {
    return [];
  }
}

async function listModules(modelCfg) {
  return listModulesFromDisk(resolveRoot(modelCfg || {}));
}

async function complete({ modelCfg, messages, onDelta, onThink, onReason, signal, forceWeb, dislike, module, role, workspace }) {
  onDelta = onDelta || (() => {});
  onThink = onThink || (() => {});
  onReason = onReason || (() => {});
  const root = resolveRoot(modelCfg);
  const script = path.join(root, 'serve.py');
  if (!fs.existsSync(script)) {
    throw new Error(`未找到 zbaingAi：${script}。请运行 zai\\scripts\\zbaing.ps1 -Install`);
  }

  const body = { messages: messages || [] };
  if (forceWeb) body.force_web = true;
  if (dislike) body.dislike = dislike;
  if (module) body.module = module;
  if (role) body.role = role;
  if (workspace) body.workspace = String(workspace);
  const payload = JSON.stringify(body);
  const useDaemon = process.env.ZBAING_NO_DAEMON !== '1';

  if (useDaemon) {
    return completeViaDaemon({ root, payload, onDelta, onThink, onReason, signal });
  }

  const py = resolvePython();
  return new Promise((resolve, reject) => {
    const child = spawn(py, [script], {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stderr = '';
    let content = '';
    let meta = {};
    let buf = '';

    const onAbort = () => {
      try { child.kill(); } catch { /* ignore */ }
      reject(stoppedError());
    };
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.t === 'think' && msg.text) onThink(msg.text);
          if (msg.t === 'reason' && msg.text) onReason(msg.text);
          if (msg.t === 'delta' && msg.text) onDelta(msg.text);
          if (msg.t === 'ok') {
            content = msg.content || content;
            meta = {
              source: msg.source || 'guess',
              prompt: msg.prompt || '',
              minConf: msg.min_conf,
              thinking: msg.thinking || ''
            };
          }
        } catch {
          /* 非 JSON 行忽略 */
        }
      }
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', onAbort);
      if (signal?.aborted) return;
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `zbaingAi 退出码 ${code}`));
      }
      resolve({
        role: 'assistant',
        content: content || '',
        zbaingMeta: meta
      });
    });

    child.stdin.write(payload, 'utf8');
    child.stdin.end();
  });
}

async function probe(modelCfg) {
  const root = resolveRoot(modelCfg);
  const script = path.join(root, 'serve.py');
  if (!fs.existsSync(script)) {
    return { ok: false, message: `未找到 ${script}` };
  }
  try {
    const state = ensureDaemon(root);
    await waitReady(state, 120000);
    const msg = await requestViaDaemon({ root, body: { cmd: 'ping' } });
    const text = String(msg.content || msg.role || 'pong').slice(0, 80);
    return { ok: true, message: `zbaingAi 正常：${text}` };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

async function retry({ modelCfg, messages, badReply, badPrompt, onDelta, signal }) {
  return complete({
    modelCfg,
    messages,
    onDelta,
    signal,
    forceWeb: true,
    dislike: {
      actual: badReply || '',
      prompt: badPrompt || ''
    }
  });
}

async function correct({ modelCfg, prompt, actual, expected }) {
  const root = resolveRoot(modelCfg);
  const script = path.join(root, 'correct.py');
  if (!fs.existsSync(script)) {
    throw new Error(`未找到 zbaingAi 纠正脚本：${script}`);
  }
  const payload = JSON.stringify({
    prompt: prompt || '',
    actual: actual || '',
    expected: expected || ''
  });
  const py = resolvePython();
  return new Promise((resolve, reject) => {
    const child = spawn(py, [script], {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `zbaingAi 纠正失败，退出码 ${code}`));
      }
      try {
        resolve(JSON.parse(stdout.trim() || '{}'));
      } catch (e) {
        reject(new Error(stdout.trim() || stderr.trim() || String(e)));
      }
    });
    child.stdin.write(payload, 'utf8');
    child.stdin.end();
  });
}

module.exports = { complete, probe, correct, retry, resolveRoot, killDaemon, listModules };
