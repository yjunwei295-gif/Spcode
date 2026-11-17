// Grok CLI 适配：找本机 grok、列模型、测连接；连续工具循环由 grok-direct 经 ACP 挂 SpCode 工具。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const codexEnv = require('./codex-env');

const GROK_PROTOCOL = 'grok';
const GROK_BASE_URL = 'grok://cli';
const DEFAULT_MODEL = 'default';
const STATIC_MODELS = [
  { id: DEFAULT_MODEL, name: 'Grok CLI 默认模型', priceText: 'Grok CLI 默认模型' },
  { id: 'grok-4.6', name: 'grok-4.6', priceText: '默认推荐' },
  { id: 'grok-4.5', name: 'grok-4.5', priceText: '' },
  { id: 'grok-4', name: 'grok-4', priceText: '' },
  { id: 'grok-4.7', name: 'grok-4.7', priceText: '' }
];

function abortError() {
  const err = new Error('已停止');
  err.name = 'AbortError';
  return err;
}

function apiKeyOf(modelCfg) {
  return String(modelCfg?.apiKey || process.env.XAI_API_KEY || '').trim();
}

function modelOf(modelCfg) {
  const id = String(modelCfg?.model || '').trim();
  return id && !['default', 'ping'].includes(id) ? id : undefined;
}

/** PATH 上的 grok，或 npm 全局 @xai-official/grok 里的入口 */
function findGrokExecutable() {
  const fromPath = whichGrok();
  if (fromPath) return fromPath;
  const candidates = [];
  try {
    const npmRoot = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', shell: true, windowsHide: true });
    const root = String(npmRoot.stdout || '').trim();
    if (root) {
      candidates.push(
        path.join(root, '@xai-official', 'grok', 'bin', 'grok.js'),
        path.join(root, '@xai-official', 'grok', 'dist', 'cli.js'),
        path.join(root, '@xai-official', 'grok', 'cli.js')
      );
    }
  } catch { /* npm 不可用时继续试常见路径 */ }
  const home = os.homedir();
  candidates.push(
    path.join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@xai-official', 'grok', 'bin', 'grok.js'),
    path.join(home, '.npm-global', 'lib', 'node_modules', '@xai-official', 'grok', 'bin', 'grok.js'),
    '/usr/local/lib/node_modules/@xai-official/grok/bin/grok.js'
  );
  for (const file of candidates) {
    if (file && fs.existsSync(file)) return file;
  }
  return '';
}

function whichGrok() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const r = spawnSync(cmd, ['grok'], { encoding: 'utf8', shell: true, windowsHide: true });
    const line = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (line && fs.existsSync(line)) return line;
    // Windows where 可能给出 grok.cmd；优先返回 .cmd 以便 shell 启动
    if (line) return line;
  } catch { /* 未安装 */ }
  return '';
}

function missingCliError() {
  return new Error('未找到本机 Grok CLI。请先执行 npm i -g @xai-official/grok，再运行 grok login（或在服务商里填写 XAI API Key）。');
}

function authError(message) {
  const msg = String(message || '');
  if (/not authenticated|run `?grok login`|cached_token|grok\.com|auth/i.test(msg)) {
    return new Error('Grok CLI 还没登录：请在本机运行 grok login，或在服务商里填写 XAI API Key / 设置环境变量 XAI_API_KEY。');
  }
  return null;
}

function authJsonPath() {
  return path.join(os.homedir(), '.grok', 'auth.json');
}

function hasCachedAuth() {
  try { return fs.existsSync(authJsonPath()); } catch { return false; }
}

let loginPromise = null;

/** 未登录时弹出浏览器跑 grok login --oauth，等到 auth.json 出现或超时 */
function beginBrowserLogin(modelCfg) {
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const exe = findGrokExecutable();
    if (!exe) throw missingCliError();
    const env = grokEnv(modelCfg);
    const args = ['--no-auto-update', 'login', '--oauth'];
    // 独立窗口，让 CLI 自己弹浏览器；不劫持 stdout，否则设备码/链接出不来
    const child = /\.js$/i.test(exe)
      ? spawn(process.execPath, [exe, ...args], { env, detached: true, stdio: 'ignore', windowsHide: false })
      : spawn(exe, args, { env, detached: true, stdio: 'ignore', windowsHide: false, shell: process.platform === 'win32' });
    try { child.unref(); } catch { /* */ }
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline) {
      if (hasCachedAuth()) return true;
      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error('浏览器登录超时（5 分钟）。请在本机终端再跑一次 grok login，或填写 XAI API Key。');
  })().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function ensureLogin(modelCfg, { interactive = true } = {}) {
  if (apiKeyOf(modelCfg)) return { via: 'apiKey' };
  if (hasCachedAuth()) return { via: 'cached' };
  if (!interactive) throw new Error('Run `grok login` first, or set XAI_API_KEY.');
  // 尽量用 Electron 提示；真正登录靠 grok login --oauth 弹浏览器
  try {
    const { BrowserWindow } = require('electron');
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    if (win) {
      // 非阻塞提示：登录窗口由 CLI 打开
      require('electron').dialog.showMessageBox(win, {
        type: 'info',
        title: 'Grok 登录',
        message: '即将打开浏览器登录 Grok。完成后回到本窗口，测试会自动继续。',
        buttons: ['好的']
      }).catch(() => {});
    }
  } catch { /* 非 Electron 环境跳过对话框 */ }
  await beginBrowserLogin(modelCfg);
  if (!hasCachedAuth()) throw new Error('登录未完成：仍未找到 ~/.grok/auth.json');
  return { via: 'browser' };
}

function runError(model, message) {
  return authError(message) || new Error(`Grok 模型「${model || DEFAULT_MODEL}」没有完成：${message}`);
}

/** 子进程环境：带上 SpCode 代理；Key 写入 XAI_API_KEY 供 ACP authenticate */
function grokEnv(modelCfg) {
  const env = { ...codexEnv() };
  const key = apiKeyOf(modelCfg);
  if (key) env.XAI_API_KEY = key;
  env.GROK_CLIENT_VERSION = env.GROK_CLIENT_VERSION || 'spcode';
  return env;
}

/**
 * 启动 grok agent stdio 的参数。
 * --no-auto-update 避免脚本环境后台升级；--always-approve 让 MCP 工具不被询问卡住；
 * --disable-web-search 必须放在 agent 之前（全局选项）；agent 子命令不认这个参数。
 */
function stdioArgs(modelCfg) {
  const args = ['--no-auto-update', '--disable-web-search', 'agent', '--always-approve'];
  const model = modelOf(modelCfg);
  if (model) args.push('--model', model);
  args.push('stdio');
  return args;
}

function spawnGrokStdio(modelCfg) {
  const exe = findGrokExecutable();
  if (!exe) throw missingCliError();
  const env = grokEnv(modelCfg);
  const args = stdioArgs(modelCfg);
  // Windows 上 grok.cmd 需要 shell；.js 入口用 node 跑更稳
  if (/\.js$/i.test(exe)) {
    return spawn(process.execPath, [exe, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  }
  return spawn(exe, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
}

/** 极简 ACP 客户端：一行一条 JSON-RPC，用于 list/test/complete */
function createAcpClient(proc) {
  const pending = new Map();
  let nextId = 1;
  let buf = '';
  const updates = [];
  const onStdout = (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.method === 'session/update') {
        updates.push(msg.params);
        continue;
      }
      // 反向请求：测试/单轮场景一律允许，避免卡死
      if (msg.id != null && msg.method) {
        const result = msg.method === 'session/request_permission'
          ? { outcome: { outcome: 'selected', optionId: 'allow-once' } }
          : {};
        try {
          proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
        } catch { /* 进程已关 */ }
        continue;
      }
      if (msg.id == null) continue;
      const p = pending.get(msg.id);
      if (!p) continue;
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result ?? {});
    }
  };
  proc.stdout.on('data', onStdout);
  const request = (method, params, timeoutMs = 30000) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      pending.set(id, {
        resolve(v) { clearTimeout(timer); resolve(v); },
        reject(e) { clearTimeout(timer); reject(e); }
      });
      try {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch (e) {
        clearTimeout(timer);
        pending.delete(id);
        reject(e);
      }
    });
  };
  const notify = (method, params) => {
    try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* 忽略 */ }
  };
  return { request, notify, updates, dispose() { proc.stdout.off('data', onStdout); } };
}

async function handshake(proc, modelCfg) {
  const client = createAcpClient(proc);
  const init = await client.request('initialize', {
    protocolVersion: 1,
    clientInfo: { name: 'spcode', version: '1.0.0' },
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
  });
  const authMethods = new Set((init.authMethods || []).map((m) => m.id));
  const key = apiKeyOf(modelCfg);
  let methodId = null;
  if (key && (authMethods.has('xai.api_key') || !authMethods.size)) methodId = 'xai.api_key';
  else if (authMethods.has('cached_token') && hasCachedAuth()) methodId = 'cached_token';
  else if (authMethods.has('grok.com') && hasCachedAuth()) methodId = 'grok.com';
  else if (authMethods.has('cached_token')) methodId = 'cached_token';
  else if (authMethods.has('grok.com')) methodId = 'grok.com';
  else if (key) methodId = 'xai.api_key';
  if (!methodId && (!init.authMethods || !init.authMethods.length)) {
    // 部分版本已用环境凭据，无需再 authenticate
    return { client, init };
  }
  if (!methodId) throw new Error('Run `grok login` first, or set XAI_API_KEY.');
  // grok.com / cached_token：有本地凭据时用 headless；否则外层 ensureLogin 已弹过浏览器
  const headless = methodId === 'xai.api_key' || hasCachedAuth() || !!key;
  await client.request('authenticate', { methodId, _meta: { headless } });
  return { client, init };
}

function sandboxDir() {
  const dir = path.join(os.tmpdir(), `spcode-grok-sandbox-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function catalogFromStatic() {
  const models = STATIC_MODELS.map((m) => m.id);
  const catalog = Object.create(null);
  for (const m of STATIC_MODELS) {
    catalog[m.id] = { id: m.id, name: m.name, priceText: m.priceText || m.name, input: null, output: null };
  }
  return { models, catalog };
}

async function listModels(modelCfg) {
  // 先给静态列表，保证设置页可用；若 CLI 能查到则合并
  const base = catalogFromStatic();
  try {
    const exe = findGrokExecutable();
    if (!exe) return { ok: true, protocol: GROK_PROTOCOL, ...base, balance: { available: false } };
    const r = spawnSync(exe, ['models'], {
      encoding: 'utf8',
      shell: process.platform === 'win32' && !/\.js$/i.test(exe),
      env: grokEnv(modelCfg),
      windowsHide: true,
      timeout: 15000
    });
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const found = [...out.matchAll(/\b(grok-[\w.-]+)\b/gi)].map((m) => m[1]);
    for (const id of found) {
      if (!base.catalog[id]) {
        base.models.push(id);
        base.catalog[id] = { id, name: id, priceText: '', input: null, output: null };
      }
    }
  } catch { /* 静态列表已足够 */ }
  return { ok: true, protocol: GROK_PROTOCOL, models: base.models, catalog: base.catalog, balance: { available: false } };
}

async function testConnection(modelCfg) {
  if (!findGrokExecutable()) throw missingCliError();
  // 没登录就弹浏览器；登完再测
  await ensureLogin(modelCfg, { interactive: true });
  const proc = spawnGrokStdio(modelCfg);
  let stderr = '';
  proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
  const timer = setTimeout(() => { try { proc.kill(); } catch { /* */ } }, 60000);
  try {
    const { client } = await handshake(proc, modelCfg);
    const cwd = sandboxDir();
    const { sessionId } = await client.request('session/new', {
      cwd,
      mcpServers: [],
      _meta: { yoloMode: true, rules: 'Reply with exactly OK.' }
    }, 30000);
    client.updates.length = 0;
    await client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with exactly OK.' }]
    }, 45000);
    let text = '';
    for (const u of client.updates) {
      const update = u?.update || u;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) text += update.content.text;
    }
    try { proc.kill(); } catch { /* */ }
    return { name: text.trim() || modelOf(modelCfg) || DEFAULT_MODEL };
  } catch (e) {
    try { proc.kill(); } catch { /* */ }
    if (/超时/.test(String(e?.message || ''))) {
      throw new Error(`Grok CLI 连接测试超时（60 秒）。${stderr.trim() ? `详情：${stderr.trim().slice(0, 200)}` : '请检查 grok login 状态或网络。'}`);
    }
    throw authError(e?.message) || runError(modelOf(modelCfg), e?.message || e);
  } finally {
    clearTimeout(timer);
  }
}

async function complete({ modelCfg, messages, onDelta, onReason, signal }) {
  if (!findGrokExecutable()) throw missingCliError();
  if (signal?.aborted) throw abortError();
  const proc = spawnGrokStdio(modelCfg);
  const onAbort = () => { try { proc.kill(); } catch { /* */ } };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    const { client } = await handshake(proc, modelCfg);
    const promptText = (messages || []).filter(Boolean).map((m) => {
      const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      if (m.role === 'system') return `[系统]\n${body}`;
      if (m.role === 'assistant') return `[助手]\n${body}`;
      if (m.role === 'tool') return `[工具结果]\n${body}`;
      return `[用户]\n${body}`;
    }).join('\n\n');
    const { sessionId } = await client.request('session/new', {
      cwd: sandboxDir(),
      mcpServers: [],
      _meta: {
        yoloMode: true,
        rules: '这是单轮文字补全，不要调用工具，直接回答。'
      }
    }, 30000);
    client.updates.length = 0;
    // 边收边推：轮询 updates（ACP 在 prompt 返回前持续推送）
    let content = '';
    let reasoning = '';
    const pump = setInterval(() => {
      while (client.updates.length) {
        const u = client.updates.shift();
        const update = u?.update || u;
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
          content += update.content.text;
          onDelta?.(update.content.text);
        } else if (update?.sessionUpdate === 'agent_thought_chunk' && update.content?.text) {
          reasoning += update.content.text;
          onReason?.(update.content.text);
        }
      }
    }, 50);
    try {
      await client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: promptText || '你好' }]
      }, 180000);
    } finally {
      clearInterval(pump);
    }
    for (const u of client.updates) {
      const update = u?.update || u;
      if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
        const t = update.content.text;
        if (!content.endsWith(t)) { content += t; onDelta?.(t); }
      }
    }
    return { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) };
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw authError(e?.message) || runError(modelOf(modelCfg), e?.message || e);
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
    try { proc.kill(); } catch { /* */ }
  }
}

module.exports = {
  GROK_PROTOCOL,
  GROK_BASE_URL,
  DEFAULT_MODEL,
  findGrokExecutable,
  spawnGrokStdio,
  handshake,
  createAcpClient,
  grokEnv,
  stdioArgs,
  sandboxDir,
  apiKeyOf,
  modelOf,
  abortError,
  missingCliError,
  authError,
  runError,
  listModels,
  testConnection,
  
  ensureLogin,
  beginBrowserLogin,
  hasCachedAuth,complete
};
