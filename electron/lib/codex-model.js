// Codex 的普通模型调用复用本机 Codex SDK；需要连续工具循环时由 codex-direct 驱动 SpCode MCP 工具。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRequire } = require('module');
const { spawn } = require('child_process');
const readline = require('readline');
const codexEnv = require('./codex-env');

const CODEX_PROTOCOL = 'codex';
const CODEX_BASE_URL = 'codex://sdk';
const DEFAULT_MODEL = 'default';
const RATE_LIMIT_CACHE_MS = 30 * 1000;
const MODEL_LIST_CACHE_MS = 15 * 1000;
let rateLimitCache = null;
let rateLimitCacheAt = 0;
let rateLimitInFlight = null;
let modelListCache = null;
let modelListCacheAt = 0;
let modelListInFlight = null;
const CODEX_TOOL_RESTRICTIONS = {
  features: { shell_tool: false, unified_exec: false, multi_agent: false, view_image_tool: false },
  include_apply_patch_tool: false,
  tools: { web_search: false }
};

function imagesOf(messages) {
  const files = [];
  for (const message of messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      const url = part?.type === 'image_url' ? (part.image_url?.url || part.image_url) : '';
      const m = /^data:([^;]+);base64,(.+)$/s.exec(String(url || ''));
      if (!m) continue;
      const ext = m[1].split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
      const file = path.join(os.tmpdir(), `spcode-codex-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.${ext}`);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
      files.push(file);
    }
  }
  return files.slice(-8);
}

function promptOf(messages) {
  return (messages || []).filter(Boolean).map((message) => {
    const content = typeof message.content === 'string'
      ? message.content
      : Array.isArray(message.content)
        ? message.content.map((part) => part?.text || '').join('')
        : '';
    if (message.role === 'system') return `[系统]\n${content}`;
    if (message.role === 'assistant') return `[助手]\n${content}`;
    if (message.role === 'tool') return `[工具结果 ${message.name || ''}]\n${content}`;
    return `[用户]\n${content}`;
  }).filter(Boolean).join('\n\n');
}

async function makeCodex(modelCfg) {
  const { Codex } = await import('@openai/codex-sdk');
  return new Codex({
    ...(modelCfg?.apiKey ? { apiKey: String(modelCfg.apiKey).trim() } : {}),
    env: codexEnv(),
    config: CODEX_TOOL_RESTRICTIONS
  });
}

function codexBinaryPath() {
  const targets = {
    'win32-x64': ['@openai/codex-win32-x64', 'x86_64-pc-windows-msvc', 'codex.exe'],
    'win32-arm64': ['@openai/codex-win32-arm64', 'aarch64-pc-windows-msvc', 'codex.exe'],
    'darwin-x64': ['@openai/codex-darwin-x64', 'x86_64-apple-darwin', 'codex'],
    'darwin-arm64': ['@openai/codex-darwin-arm64', 'aarch64-apple-darwin', 'codex'],
    'linux-x64': ['@openai/codex-linux-x64', 'x86_64-unknown-linux-musl', 'codex'],
    'linux-arm64': ['@openai/codex-linux-arm64', 'aarch64-unknown-linux-musl', 'codex']
  };
  const target = targets[`${process.platform}-${process.arch}`];
  if (!target) return '';
  const codexRequire = createRequire(require.resolve('@openai/codex/package.json'));
  const nativePackage = codexRequire.resolve(`${target[0]}/package.json`);
  return path.join(path.dirname(nativePackage), 'vendor', target[1], 'bin', target[2]);
}

/**
 * 启动本机 Codex app-server 并完成一次 RPC；保留启动、权限、协议及超时错误。
 * @param {string} method RPC 方法名
 * @param {object} params RPC 参数
 * @returns {Promise<object>} 服务端原始结果；异常直接交给调用方，不伪装成空目录
 */
function readAppServerRpc(method, params) {
  let binary;
  try { binary = codexBinaryPath(); }
  catch (error) { return Promise.reject(new Error('Codex 原生程序定位失败：' + error.message, { cause: error })); }
  if (!binary || !fs.existsSync(binary)) return Promise.reject(new Error('Codex 原生程序不存在：' + binary));

  return new Promise(function start(resolve, reject) {
    let child;
    try {
      child = spawn(binary, ['app-server', '--stdio'], {
        env: codexEnv(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
      });
    } catch (error) { reject(error); return; }
    let settled = false;
    let stderr = '';
    const pending = new Map();
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });

    /** 清理当前 RPC 的进程和等待者，只交付一次真实结果或错误。 */
    function finish(value, error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      for (const waiter of pending.values()) waiter.reject(error || new Error('Codex app-server request ended'));
      pending.clear();
      child.kill();
      if (error) reject(error);
      else resolve(value);
    }
    /** stderr 仅用于故障定位，不包含模型配置或认证参数。 */
    function diagnostic(data) { stderr += data.toString(); }
    /** 启动拒绝时保留 EACCES 等错误码，让 Mac 执行权限问题可定位。 */
    function failed(error) {
      const detail = new Error('Codex app-server 启动或通信失败：' + (error.code || '') + ' ' + error.message, { cause: error });
      detail.code = error.code;
      finish(null, detail);
    }
    /** 退出码、信号和 CLI 自己的 stderr 比泛化的登录提示更准确。 */
    function exited(code, signal) {
      finish(null, new Error('Codex app-server 提前退出：code=' + code + ' signal=' + signal + (stderr ? '\n' + stderr.trim() : '')));
    }
    /** 既有 12 秒边界继续生效，超时必须明确报错。 */
    function timedOut() { finish(null, new Error('Codex app-server 请求超时：' + method + (stderr ? '\n' + stderr.trim() : ''))); }
    const timer = setTimeout(timedOut, 12000);
    child.stderr.on('data', diagnostic);
    child.once('error', failed);
    child.stdin.once('error', failed);
    child.once('exit', exited);
    /** 按 RPC 编号交付响应；通知与非 JSON 进度行不属于请求结果。 */
    function received(line) {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message || 'Codex app-server request failed'));
      else waiter.resolve(message.result || {});
    }
    lines.on('line', received);
    /** 写入一条 RPC 请求并登记对应的 Promise。 */
    function request(id, requestMethod, requestParams) {
      function send(resolveRequest, rejectRequest) {
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
        try {
          child.stdin.write(JSON.stringify({ method: requestMethod, id, params: requestParams }) + '\n');
        } catch (error) {
          pending.delete(id);
          rejectRequest(error);
        }
      }
      return new Promise(send);
    }
    /** 先握手再请求模型或额度，顺序与 Codex app-server 协议一致。 */
    async function handshake() {
      try {
        await request(1, 'initialize', {
          clientInfo: { name: 'spcode', title: 'SpCode', version: '1.0.0' },
          capabilities: { experimentalApi: true }
        });
        child.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n');
        finish(await request(2, method, params));
      } catch (error) { finish(null, error); }
    }
    handshake();
  });
}

function readRateLimitsFromAppServer(modelCfg) {
  // API key 模式不是 ChatGPT 订阅额度；沿用本机登录态仅在没有 API key 时查询。
  if (String(modelCfg?.apiKey || process.env.CODEX_API_KEY || '').trim()) return Promise.resolve(null);
  return readAppServerRpc('account/rateLimits/read', {}).catch(() => null);
}

/** 包含服务端标记隐藏的条目，并读取全部游标页；只缓存成功取全的目录。 */
async function fetchModelCatalog() {
  if (modelListCache && Date.now() - modelListCacheAt < MODEL_LIST_CACHE_MS) return modelListCache;
  if (modelListInFlight) return modelListInFlight;
  modelListInFlight = (async () => {
    const models = [];
    let cursor = null;
    const visited = new Set();
    const deadline = Date.now() + 120000;
    while (true) {
      if (Date.now() >= deadline) throw new Error('Codex 模型分页超时，未能拉取完整列表');
      const page = await readAppServerRpc('model/list', {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {})
      });
      if (!Array.isArray(page?.data)) throw new Error('Codex 模型目录读取失败，请检查本机登录状态和 Codex 版本');
      models.push(...page.data);
      if (!page.nextCursor) break;
      if (visited.has(page.nextCursor)) throw new Error('Codex 模型分页游标重复，未能拉取完整列表');
      visited.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    modelListCache = models
      .filter((item) => item)
      .map((item) => ({
        id: String(item.model || item.id || '').trim(),
        name: String(item.displayName || item.model || item.id || '').trim(),
        description: String(item.description || '').trim(),
        isDefault: !!item.isDefault,
        hidden: !!item.hidden,
        // 保留服务端声明的推理档位，供设置界面展示，不能靠模型名字猜能力。
        reasoningOptions: (item.supportedReasoningEfforts || []).map(function reasoningOption(option) {
          return { value: option.reasoningEffort, label: option.reasoningEffort, description: option.description || '' };
        })
      }))
      .filter((item) => item.id);
    modelListCacheAt = Date.now();
    return modelListCache;
  })();
  try { return await modelListInFlight; }
  finally { modelListInFlight = null; }
}

function remainingPercent(window) {
  const used = Number(window?.usedPercent);
  if (!Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - used)));
}

/**
 * 判断 Codex 工作模式的五小时窗口是否已由服务端确认耗尽。
 * @param {object} data account/rateLimits/read 返回的原始额度数据。
 * @returns {boolean} 仅五小时窗口明确达到 100% 时为 true，不把周额度当作工作额度。
 */
function fiveHourQuotaExhausted(data) {
  const limits = data?.rateLimitsByLimitId?.codex || data?.rateLimits;
  const primary = limits?.primary;
  return Number(primary?.windowDurationMins) === 300 && Number(primary?.usedPercent) >= 100;
}

function formatRateLimits(data) {
  const limits = data?.rateLimitsByLimitId?.codex || data?.rateLimits;
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary].filter(Boolean);
  const parts = windows.map((window) => {
    const remaining = remainingPercent(window);
    if (remaining == null) return '';
    const duration = Number(window.windowDurationMins);
    const label = duration >= 10000 ? '7 天' : duration > 0 && duration <= 360 ? '5 小时' : duration ? `${duration} 分钟` : '额度';
    return `${label}剩余 ${remaining}%`;
  }).filter(Boolean);
  return parts.length ? { available: true, kind: 'rate-limits', text: parts.join(' · ') } : null;
}

async function listModels(modelCfg) {
  const [balance, remoteModels] = await Promise.all([
    fetchRateLimitBalance(modelCfg),
    fetchModelCatalog()
  ]);
  const models = [DEFAULT_MODEL];
  const catalog = Object.assign(Object.create(null), {
    [DEFAULT_MODEL]: { id: DEFAULT_MODEL, name: 'Codex CLI 默认模型', priceText: 'Codex CLI 默认模型', input: null, output: null }
  });
  for (const item of remoteModels || []) {
    if (!item.id || item.id === DEFAULT_MODEL || models.includes(item.id)) continue;
    models.push(item.id);
    catalog[item.id] = {
      id: item.id,
      name: item.name || item.id,
      priceText: item.hidden ? 'Codex 模型 · 厂商标记隐藏' : 'Codex 模型',
      input: null,
      output: null,
      isDefault: item.isDefault,
      hidden: item.hidden,
      reasoningOptions: item.reasoningOptions
    };
    // default 是 CLI 的模型别名，档位必须跟随服务端标记的默认模型。
    if (item.isDefault) catalog[DEFAULT_MODEL].reasoningOptions = item.reasoningOptions;
  }
  return {
    ok: true,
    protocol: CODEX_PROTOCOL,
    models,
    catalog,
    balance: balance || { available: false }
  };
}

async function fetchRateLimitBalance(modelCfg) {
  if (String(modelCfg?.apiKey || process.env.CODEX_API_KEY || '').trim()) return { available: false };
  if (rateLimitCache && Date.now() - rateLimitCacheAt < RATE_LIMIT_CACHE_MS) return rateLimitCache;
  if (rateLimitInFlight) return rateLimitInFlight;
  rateLimitInFlight = (async () => {
    let result = { available: false };
    try { result = formatRateLimits(await readRateLimitsFromAppServer(modelCfg)) || result; }
    catch { /* 限额读取失败不应挡住模型列表或聊天 */ }
    rateLimitCache = result;
    rateLimitCacheAt = Date.now();
    return result;
  })();
  try { return await rateLimitInFlight; }
  finally { rateLimitInFlight = null; }
}

async function testConnection(modelCfg) {
  const codex = await makeCodex(modelCfg);
  const cwd = path.join(os.tmpdir(), `spcode-codex-sandbox-${process.pid}`);
  fs.mkdirSync(cwd, { recursive: true });
  const thread = codex.startThread({
    model: modelCfg?.model && !['ping', 'default'].includes(String(modelCfg.model)) ? String(modelCfg.model) : undefined,
    modelReasoningEffort: modelCfg?.reasoningEffort || undefined,
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    webSearchMode: 'disabled'
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Codex 连接测试超时（30 秒）')), 30000);
  try {
    const result = await thread.run('Reply with exactly OK.', { signal: controller.signal });
    return { name: result.finalResponse || DEFAULT_MODEL };
  } catch (e) {
    if (controller.signal.aborted) throw new Error('Codex 连接测试超时（30 秒），请检查本机 Codex 登录状态和网络连接。');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function complete({ modelCfg, messages, onDelta, onReason, signal }) {
  const codex = await makeCodex(modelCfg);
  const cwd = path.join(os.tmpdir(), `spcode-codex-sandbox-${process.pid}`);
  fs.mkdirSync(cwd, { recursive: true });
  const thread = codex.startThread({
    model: modelCfg?.model && modelCfg.model !== 'default' ? String(modelCfg.model) : undefined,
    modelReasoningEffort: modelCfg?.reasoningEffort || undefined,
    workingDirectory: cwd,
    skipGitRepoCheck: true,
    sandboxMode: 'read-only',
    approvalPolicy: 'never',
    webSearchMode: 'disabled'
  });
  const files = imagesOf(messages);
  try {
    const input = [{ type: 'text', text: promptOf(messages) }, ...files.map((file) => ({ type: 'local_image', path: file }))];
    const result = await thread.run(input, { signal });
    const text = String(result.finalResponse || '');
    onDelta?.(text);
    return { role: 'assistant', content: text };
  } finally {
    for (const file of files) { try { fs.unlinkSync(file); } catch { /* 已清理 */ } }
  }
}

module.exports = { CODEX_PROTOCOL, CODEX_BASE_URL, DEFAULT_MODEL, listModels, fetchRateLimitBalance, readRateLimitsFromAppServer, fiveHourQuotaExhausted, testConnection, complete };
