// Claude Code 适配：普通调用、模型列表、测试连接都交给 Claude Agent SDK（内置 Claude Code 可执行文件）。
// 需要连续工具循环时由 claude-direct 驱动 SpCode 工具。Claude Code 自带工具全部关闭，只回文字。
const fs = require('fs');
const os = require('os');
const path = require('path');
const codexEnv = require('./codex-env');

const CLAUDE_PROTOCOL = 'claudecode';
const CLAUDE_BASE_URL = 'claudecode://sdk';
const DEFAULT_MODEL = 'default';
const MAX_IMAGES = 8;
// Anthropic 按网络出口地区拒绝请求时没有专门的错误码，只能认错误原文
const REGION_BLOCK_RE = /unsupported_country|country, region, or territory|not (?:available|supported) in your (?:region|country)|Request not allowed/i;

let sdkPromise = null;
function sdk() {
  if (!sdkPromise) sdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return sdkPromise;
}

function sandboxDir() {
  const dir = path.join(os.tmpdir(), `spcode-claude-sandbox-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 打包后可执行文件在 app.asar.unpacked 里，SDK 自己找会落到 asar 包内而启动失败 */
function executablePath() {
  try {
    const pkg = require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    const file = path.join(path.dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude')
      .replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
    return fs.existsSync(file) ? file : undefined;
  } catch {
    return undefined;
  }
}

/** 填了真实地址时改走该地址（DeepSeek 等兼容接口、本机代理），否则走 Anthropic 官方 */
function customBaseUrl(modelCfg) {
  const url = String(modelCfg?.baseUrl || '').trim();
  return /^https?:\/\//i.test(url) ? url.replace(/\/+$/, '') : '';
}

/** 子进程环境：带上 SpCode 网络代理；Key 走官方时作 API Key，走第三方地址时作 Bearer 令牌 */
function claudeEnv(modelCfg) {
  const env = { ...codexEnv(), CLAUDE_AGENT_SDK_CLIENT_APP: 'spcode' };
  const key = String(modelCfg?.apiKey || '').trim();
  const baseUrl = customBaseUrl(modelCfg);
  if (baseUrl) {
    env.ANTHROPIC_BASE_URL = baseUrl;
    if (key) {
      env.ANTHROPIC_AUTH_TOKEN = key;
      delete env.ANTHROPIC_API_KEY;
    }
  } else if (key) {
    env.ANTHROPIC_API_KEY = key;
  }
  return env;
}

function modelOf(modelCfg) {
  const id = String(modelCfg?.model || '').trim();
  return id && !['default', 'ping'].includes(id) ? id : undefined;
}

/** 各处共用的 query 选项：空目录、不读本机 Claude 设置、关掉内置工具 */
function baseOptions(modelCfg, extra) {
  return {
    cwd: sandboxDir(),
    env: claudeEnv(modelCfg),
    settingSources: [],
    tools: [],
    model: modelOf(modelCfg),
    pathToClaudeCodeExecutable: executablePath(),
    ...(extra || {})
  };
}

/** 地区限制属于永久性错误，重试或发「继续」都没用；是这类错误时返回中文错误，否则返回 null */
function regionError(model, message) {
  if (!REGION_BLOCK_RE.test(String(message || ''))) return null;
  const err = new Error(`Claude Code 模型「${model || DEFAULT_MODEL}」在当前地区不可用，请在设置里配置网络代理，或在服务商里填兼容的接口地址（例如 DeepSeek 的 Anthropic 接口）。`);
  err.code = 'claude_region_blocked';
  return err;
}

function runError(model, message) {
  if (/Not logged in|Please run \/login/i.test(String(message || ''))) {
    return new Error('Claude Code 还没登录：请在服务商里填 API Key（或兼容接口的 Key），或先在本机登录 Claude Code。');
  }
  return regionError(model, message) || new Error(`Claude Code 模型「${model || DEFAULT_MODEL}」没有完成：${message}`);
}

/** result 消息出错时取出可读原因 */
function resultFailure(msg) {
  if (!msg || msg.type !== 'result') return '';
  if (msg.subtype === 'success' && !msg.is_error) return '';
  return String((msg.errors && msg.errors.join('\n')) || msg.result || msg.subtype || '运行失败');
}

function abortError() {
  const err = new Error('已停止');
  err.name = 'AbortError';
  return err;
}

function partsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
}

/** OpenAI 风格图片转 Anthropic 图片块，只认 data URL */
function imageBlocks(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    const url = p?.type === 'image_url' ? (p.image_url?.url || p.image_url) : '';
    const m = /^data:([^;]+);base64,(.+)$/s.exec(String(url || ''));
    if (m) out.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
  }
  return out.slice(-MAX_IMAGES);
}

/** 文字加图片组成一条流式输入；没图时直接用字符串 */
function promptInput(text, images) {
  if (!images || !images.length) return text;
  return (async function* single() {
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }, ...images] },
      parent_tool_use_id: null
    };
  })();
}

function promptOf(messages) {
  return (messages || []).filter(Boolean).map((m) => {
    const body = partsText(m.content);
    if (m.role === 'system') return `[系统]\n${body}`;
    if (m.role === 'assistant') return `[助手]\n${body}`;
    if (m.role === 'tool') return `[工具结果 ${m.name || ''}]\n${body}`;
    return `[用户]\n${body}`;
  }).join('\n\n');
}

/** 流式事件里的增量文字 / 思考 */
function streamDelta(msg) {
  if (msg?.type !== 'stream_event' || msg.parent_tool_use_id) return null;
  const ev = msg.event;
  if (ev?.type !== 'content_block_delta') return null;
  if (ev.delta?.type === 'text_delta') return { text: ev.delta.text || '' };
  if (ev.delta?.type === 'thinking_delta') return { reason: ev.delta.thinking || '' };
  return null;
}

/** 跑一次单轮问答，返回最终文字；signal 停止时抛已停止 */
async function runOnce({ modelCfg, text, images, onDelta, onReason, signal, extraOptions }) {
  const { query } = await sdk();
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal) {
    if (signal.aborted) throw abortError();
    signal.addEventListener('abort', onAbort, { once: true });
  }
  let content = '';
  let streamed = '';
  let reasoning = '';
  try {
    const q = query({
      prompt: promptInput(text, images),
      options: baseOptions(modelCfg, { maxTurns: 1, includePartialMessages: true, persistSession: false, abortController, ...(extraOptions || {}) })
    });
    for await (const msg of q) {
      const d = streamDelta(msg);
      if (d?.text) { streamed += d.text; onDelta?.(d.text); }
      if (d?.reason) { reasoning += d.reason; onReason?.(d.reason); }
      if (msg.type === 'assistant' && msg.error) {
        throw runError(modelOf(modelCfg), partsText(msg.message?.content) || msg.error);
      }
      if (msg.type === 'result') {
        const failure = resultFailure(msg);
        if (failure) throw runError(modelOf(modelCfg), failure);
        content = String(msg.result || streamed);
      }
    }
    return { content: content || streamed, reasoning };
  } catch (e) {
    if (signal?.aborted) throw abortError();
    throw regionError(modelOf(modelCfg), e?.message) || e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function listModels(modelCfg) {
  const { query } = await sdk();
  const abortController = new AbortController();
  // 流式输入一直不给消息，只为拿到会话后查询可用模型
  const idle = (async function* wait() { await new Promise(() => {}); })();
  const q = query({ prompt: idle, options: baseOptions(modelCfg, { abortController, persistSession: false }) });
  let rows = [];
  try {
    rows = await Promise.race([
      q.supportedModels(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('读取 Claude Code 模型列表超时（30 秒）')), 30000))
    ]);
  } finally {
    abortController.abort();
    try { q.close(); } catch { /* 已关闭 */ }
  }
  const models = [DEFAULT_MODEL];
  const catalog = Object.assign(Object.create(null), {
    [DEFAULT_MODEL]: { id: DEFAULT_MODEL, name: 'Claude Code 默认模型', priceText: 'Claude Code 默认模型', input: null, output: null }
  });
  for (const m of rows || []) {
    const id = String(m?.value || '').trim();
    if (!id || catalog[id]) continue;
    models.push(id);
    catalog[id] = { id, name: m.displayName || id, priceText: m.description || m.displayName || '', input: null, output: null };
  }
  return { ok: true, protocol: CLAUDE_PROTOCOL, models, catalog, balance: { available: false } };
}

async function testConnection(modelCfg) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 60000);
  try {
    const out = await runOnce({ modelCfg, text: 'Reply with exactly OK.', signal: ctl.signal });
    return { name: out.content || modelOf(modelCfg) || DEFAULT_MODEL };
  } catch (e) {
    if (ctl.signal.aborted) throw new Error('Claude Code 连接测试超时（60 秒），请检查登录状态、网络代理或接口地址。');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function complete({ modelCfg, messages, onDelta, onReason, signal }) {
  const last = [...(messages || [])].reverse().find((m) => m && m.role === 'user');
  const out = await runOnce({
    modelCfg,
    text: promptOf(messages),
    images: imageBlocks(last?.content),
    onDelta,
    onReason,
    signal
  });
  return { role: 'assistant', content: out.content, ...(out.reasoning ? { reasoning_content: out.reasoning } : {}) };
}

module.exports = {
  CLAUDE_PROTOCOL, CLAUDE_BASE_URL, DEFAULT_MODEL,
  sdk, baseOptions, modelOf, regionError, runError, resultFailure, streamDelta, imageBlocks, promptInput, partsText, abortError,
  listModels, testConnection, complete
};
