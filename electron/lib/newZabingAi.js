// NewZabingAi 的嘴巴。优先启动同目录的 NewZabingAi.exe，没有 exe 时才直接叫 python。
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const DEFAULT_ROOT = path.join('D:', 'Ai', 'NewZabingAi');

function rootOf(modelCfg) {
  return path.resolve(String(modelCfg?.newZabingRoot || DEFAULT_ROOT).trim());
}

function run(root, args, stdinBuf, signal) {
  const exe = path.join(root, 'NewZabingAi.exe');
  const script = path.join(root, 'mouth.py');
  const useExe = fs.existsSync(exe);
  if (!useExe && !fs.existsSync(script)) {
    return Promise.reject(new Error(`未找到 NewZabingAi.exe 或 mouth.py：${root}`));
  }
  const cmd = useExe ? exe : (process.env.NEWZABING_PYTHON || 'python');
  const argv = useExe ? args : ['-X', 'utf8', script, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, argv, {
      cwd: root,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    const out = [];
    const err = [];
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const stop = () => {
      try { child.kill(); } catch { /* 进程已经结束 */ }
      const e = new Error('已停止');
      e.name = 'AbortError';
      finish(reject, e);
    };
    if (signal) {
      if (signal.aborted) return stop();
      signal.addEventListener('abort', stop, { once: true });
    }
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (signal) signal.removeEventListener('abort', stop);
      if (signal?.aborted) return;
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8').trim();
      if (code !== 0) finish(reject, new Error(stderr || `NewZabingAi 退出码 ${code}`));
      else finish(resolve, stdout);
    });
    if (stdinBuf) child.stdin.write(stdinBuf);
    child.stdin.end();
  });
}

async function complete({ modelCfg, userText, workspace, signal }) {
  const payload = Buffer.from(JSON.stringify({
    text: String(userText || ''),
    workspace: workspace ? String(workspace) : ''
  }), 'utf8');
  const text = await run(rootOf(modelCfg), ['--json'], payload, signal);
  return { role: 'assistant', content: text };
}

async function probe(modelCfg) {
  try {
    const text = (await run(rootOf(modelCfg), ['--ping'], null, null)).trim();
    return { ok: text === 'ok', message: text === 'ok' ? 'NewZabingAi 正常' : (text || '没有回应') };
  } catch (e) {
    return { ok: false, message: e.message || String(e) };
  }
}

module.exports = { complete, probe, rootOf };
