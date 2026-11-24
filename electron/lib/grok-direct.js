// Grok 直通：本机 grok agent stdio（ACP）驱动会话，SpCode 工具经 stdio MCP 桥挂到 session/new。
// Grok 内置文件/联网尽量关掉；同一对话复用 ACP 进程与 sessionId。
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const diag = require('./diag');
const grokModel = require('./grok-model');

const MAX_SESSIONS = 8;
const READ_ONLY_TOOLS = new Set([
  'list_dir', 'read_file', 'search_text', 'semantic_search',
  'map_lookup', 'goto_definition', 'dialog_lookup', 'process_memory'
]);

const TOOL_GUIDANCE = '【本轮 SpCode 工具规则】你只能使用 MCP 服务器 spcode 提供的工具；Grok CLI 内置的文件、命令、搜索工具都不可用。项目文件只能通过 SpCode 工具读取或修改，能否写入以本轮 SpCode 授权和实际工具结果为准。需要查看或修改项目、查询本地信息、执行已确认操作时，必须实际调用工具并根据结果继续，不得只口头描述或凭猜测汇报。用户只问原理或闲聊时，不要为了调用工具而调用。修改代码后要核对目标行为，写入成功不等于功能修复。';

/** key → { sig, proc, sessionId, ctx, turns, bridge, client } */
const sessions = new Map();
let activeRuns = 0;

function busy() { return activeRuns > 0; }

function toolDefs(tools) {
  return (tools || []).map((tool) => tool?.function || tool).filter((tool) => tool?.name);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

/**
 * 读取本机工具桥的 JSON 请求。
 * @param {import('http').IncomingMessage} req 已验证会话令牌的 HTTP 请求。
 * @param {boolean} commandRequest 当前轮已开放运行命令，且发送方标记了命令请求。
 * @returns {Promise<object>} 请求正文；命令正文大小不限，其他请求按原有上限处理。
 */
async function readJson(req, commandRequest) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (!commandRequest && size > 8 * 1024 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (commandRequest && (body.method !== 'tools/call' || body.params?.name !== 'run_command')) {
    throw new Error('invalid command request');
  }
  return body;
}

/** 本进程 HTTP 桥：stdio MCP 子进程把 tools/list、tools/call 转回来 */
function startBridge(session) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return sendJson(res, 401, { error: 'unauthorized' });
    try {
      if (req.method !== 'POST' || req.url !== '/mcp') return sendJson(res, 404, { error: 'not found' });
      const commandRequest = req.headers['x-spcode-command'] === '1'
        && toolDefs(session.ctx?.tools).some(function allowsCommand(tool) { return tool.name === 'run_command'; });
      const body = await readJson(req, commandRequest);
      if (body.method === 'tools/list') {
        return sendJson(res, 200, {
          tools: toolDefs(session.ctx?.tools).map((tool) => ({
            name: tool.name,
            description: String(tool.description || ''),
            inputSchema: tool.parameters || { type: 'object', properties: {} },
            ...(READ_ONLY_TOOLS.has(tool.name) ? {
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false
              }
            } : {})
          }))
        });
      }
      if (body.method === 'tools/call') {
        const name = String(body.params?.name || '');
        if (!toolDefs(session.ctx?.tools).some((tool) => tool.name === name)) {
          return sendJson(res, 200, { content: [{ type: 'text', text: '当前轮没有开放这个工具。' }], isError: true });
        }
        const ctx = session.ctx;
        if (!ctx?.runTool) {
          return sendJson(res, 200, { content: [{ type: 'text', text: '本轮已结束，工具没有执行。' }], isError: true });
        }
        try {
          const result = await ctx.runTool(name, body.params?.arguments || {}, body.params?.toolCallId || '');
          if (ctx.stats) ctx.stats.calls.push(name);
          if (result && Array.isArray(result.spcodeContent)) return sendJson(res, 200, { content: result.spcodeContent });
          return sendJson(res, 200, {
            content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? '') }]
          });
        } catch (e) {
          return sendJson(res, 200, { content: [{ type: 'text', text: `工具失败：${e?.message || e}` }], isError: true });
        }
      }
      return sendJson(res, 400, { error: 'unsupported method' });
    } catch (e) {
      return sendJson(res, 500, { error: e?.message || String(e) });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({ server, port: server.address().port, token });
    });
  });
}

function attachAcpClient(proc, session) {
  const pending = new Map();
  let nextId = 1;
  const rl = readline.createInterface({ input: proc.stdout });
  const client = {
    pending,
    request(method, params, timeoutMs = 120000) {
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
    },
    notify(method, params) {
      try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); } catch { /* */ }
    },
    respond(id, result) {
      try { proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'); } catch { /* */ }
    },
    respondError(id, message) {
      try {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: String(message || 'error') } }) + '\n');
      } catch { /* */ }
    },
    close() {
      try { rl.close(); } catch { /* */ }
    }
  };

  rl.on('line', (line) => {
    const raw = String(line || '').trim();
    if (!raw) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    require('./training-recorder').note('sdk-event', { provider: 'grok', event: msg });

    // 流式更新
    if (msg.method === 'session/update') {
      const update = msg.params?.update || msg.params;
      const onEvent = session.ctx?.onEvent;
      if (!onEvent || !update) return;
      if (update.sessionUpdate === 'agent_message_chunk' && update.content?.text) {
        session._streamContent = (session._streamContent || '') + update.content.text;
        onEvent({ type: 'text', text: update.content.text });
      } else if (update.sessionUpdate === 'agent_thought_chunk' && update.content?.text) {
        session._streamReason = (session._streamReason || '') + update.content.text;
        onEvent({ type: 'reason', text: update.content.text });
      } else if (update.sessionUpdate === 'tool_call') {
        const title = update.title || update.toolCallId || update._meta?.['x.ai/tool'] || 'tool';
        onEvent({ type: 'status', text: `Grok 正在调用 ${title}` });
      }
      return;
    }

    // 反向：工具批准 — 只放行 spcode MCP，其它拒绝（逼它走 SpCode）
    if (msg.id != null && msg.method === 'session/request_permission') {
      const toolName = String(
        msg.params?.toolCall?.title
        || msg.params?.toolCall?.kind
        || msg.params?._meta?.['x.ai/tool']
        || msg.params?.toolCall?.rawInput?.name
        || ''
      );
      const allow = /spcode|mcp__spcode__/i.test(toolName)
        || /mcp/i.test(String(msg.params?.toolCall?.kind || ''))
        || true; // yolo 下多数已自动批；这里默认放行以免误杀 MCP
      client.respond(msg.id, {
        outcome: allow
          ? { outcome: 'selected', optionId: 'allow-once' }
          : { outcome: 'rejected' }
      });
      return;
    }

    // PreToolUse hook：非 spcode 工具可 deny（若 CLI 发来）
    if (msg.id != null && (msg.method === 'x.ai/hooks/run' || msg.method === 'ext_method')) {
      const name = String(msg.params?.name || msg.params?.toolName || msg.params?.tool || '');
      const isSpcode = !name || /spcode|mcp__spcode__/i.test(name);
      if (msg.method === 'x.ai/hooks/run' && !isSpcode && /bash|shell|edit|write|read_file|Glob|Grep|WebSearch/i.test(name)) {
        client.respond(msg.id, { decision: 'deny', reason: '请改用 SpCode MCP 工具 spcode' });
        return;
      }
      client.respond(msg.id, { decision: 'allow' });
      return;
    }

    // 其它反向请求：空结果兜底，避免挂死
    if (msg.id != null && msg.method && !Object.prototype.hasOwnProperty.call(msg, 'result') && !msg.error) {
      client.respond(msg.id, {});
      return;
    }

    if (msg.id == null) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else p.resolve(msg.result ?? {});
  });

  proc.on('exit', () => {
    for (const [, p] of pending) p.reject(new Error('Grok CLI 进程已退出'));
    pending.clear();
  });

  return client;
}

function mcpServerDescriptor(bridge) {
  // 复用 Codex 的 stdio MCP 桥脚本（把 HTTP 桥转成标准 MCP stdio）
  const helper = path.join(__dirname, 'codex-mcp-bridge.mjs');
  return {
    type: 'stdio',
    name: 'spcode',
    command: process.execPath,
    args: [helper, String(bridge.port), bridge.token],
    env: [
      { name: 'ELECTRON_RUN_AS_NODE', value: '1' }
    ]
  };
}

function closeSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  s.ctx = null;
  try { s.client?.close(); } catch { /* */ }
  try { s.proc?.kill(); } catch { /* */ }
  try { s.bridge?.server?.close(); } catch { /* */ }
}

function closeIdle() {
  if (activeRuns > 0) return 0;
  const keys = [...sessions.keys()];
  for (const key of keys) closeSession(key);
  return keys.length;
}

async function createSession(key, sig, modelCfg, tools, onEvent) {
  if (!grokModel.findGrokExecutable()) throw grokModel.missingCliError();
  const session = {
    sig,
    proc: null,
    client: null,
    sessionId: '',
    bridge: null,
    ctx: { tools, runTool: null, onEvent: null, stats: null },
    turns: 0,
    _streamContent: '',
    _streamReason: ''
  };
  const bridge = await startBridge(session);
  session.bridge = bridge;
  try {
    const proc = grokModel.spawnGrokStdio(modelCfg);
    session.proc = proc;
    let stderr = '';
    proc.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    session.client = attachAcpClient(proc, session);

    const init = await session.client.request('initialize', {
      protocolVersion: 1,
      clientInfo: { name: 'spcode', version: '1.0.0' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }
    }, 30000);

    const authMethods = new Set((init.authMethods || []).map((m) => m.id));
    const apiKey = grokModel.apiKeyOf(modelCfg);
    let methodId = null;
    if (apiKey && authMethods.has('xai.api_key')) methodId = 'xai.api_key';
    else if (authMethods.has('cached_token')) methodId = 'cached_token';
    else if (apiKey) methodId = 'xai.api_key';
    if (methodId) {
      await session.client.request('authenticate', { methodId, _meta: { headless: true } }, 30000);
    } else if (authMethods.size > 0) {
      throw new Error('Run `grok login` first, or set XAI_API_KEY.');
    }

    const cwd = grokModel.sandboxDir();
    const created = await session.client.request('session/new', {
      cwd,
      mcpServers: [mcpServerDescriptor(bridge)],
      _meta: {
        yoloMode: true,
        rules: `${TOOL_GUIDANCE}\n禁止使用 Grok 内置 bash/文件/联网工具；一律通过 MCP 服务器 spcode 提供的工具完成任务。`
      }
    }, 60000);

    session.sessionId = created.sessionId || created.session?.sessionId || '';
    if (!session.sessionId) throw new Error('Grok session/new 未返回 sessionId');

    sessions.set(key, session);
    while (sessions.size > MAX_SESSIONS) closeSession(sessions.keys().next().value);
    diag.log('grok', 'Grok 直通会话已创建', {
      model: modelCfg.model || 'default',
      tools: tools.length,
      sessionId: session.sessionId
    });
    onEvent({ type: 'status', text: 'Grok 直通会话已接通。' });
    return session;
  } catch (e) {
    try { bridge.server.close(); } catch { /* */ }
    try { session.proc?.kill(); } catch { /* */ }
    const msg = e?.message || String(e);
    throw grokModel.authError(msg) || grokModel.runError(grokModel.modelOf(modelCfg), msg);
  }
}

async function runTurn({
  key, sig, fresh, modelCfg, firstPrefix, systemContext, turnText, userContent,
  tools, runTool, onEvent, signal, requiredToolNames = [], agiMode = false, shouldYield
}) {
  await grokModel.ensureLogin(modelCfg, { interactive: true });
  sig = `${sig}\nagi:${!!agiMode}`;
  const specs = toolDefs(tools);
  let session = sessions.get(key);
  if (session && (fresh || session.sig !== sig)) {
    closeSession(key);
    session = null;
  }
  const isNew = !session;
  if (!session) session = await createSession(key, sig, modelCfg, specs, onEvent);

  const stats = { calls: [] };
  session.ctx = { tools: specs, runTool, onEvent, stats };
  const prefix = session.turns ? '' : `${firstPrefix || ''}\n\n`;
  const prompt = `${prefix}${systemContext ? `【本轮 SpCode 当前规则与上下文；与旧指令冲突时以本段为准】\n${systemContext}\n\n` : ''}${turnText || ''}`.trim();
  const required = [...new Set((requiredToolNames || []).map((name) => String(name || '').trim()).filter(Boolean))];

  const onAbort = () => {
    try { session.client?.notify('session/cancel', { sessionId: session.sessionId }); } catch { /* */ }
    try { session.proc?.kill(); } catch { /* */ }
  };
  if (signal) {
    if (signal.aborted) throw grokModel.abortError();
    signal.addEventListener('abort', onAbort, { once: true });
  }

  activeRuns += 1;
  try {
    onEvent({
      type: 'think',
      text: isNew ? 'Grok 直通：新开会话，已挂上 SpCode MCP 工具' : 'Grok 直通：沿用本对话的 ACP 会话'
    });

    let text = `${TOOL_GUIDANCE}\n\n${prompt}`;
    for (let attempt = 0; ; attempt += 1) {
      if (signal?.aborted) throw grokModel.abortError();
      session.turns += 1;
      session._streamContent = '';
      session._streamReason = '';
      await session.client.request('session/prompt', {
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text }]
      }, 600000);

      const content = session._streamContent || '';
      const reasoning = session._streamReason || '';
      // 优先投递停止或范围变更，跳过旧任务的必调工具重试。
      if (shouldYield?.() || !required.length || required.some((name) => stats.calls.includes(name))) {
        return { content, reasoning };
      }
      if (attempt >= 2) throw new Error('Grok 未调用本轮要求的 SpCode 工具，无法确认任务已执行。');
      onEvent({ type: 'rewrite_text', text: '' });
      onEvent({ type: 'status', text: 'Grok 还没有调用完成任务所需的 SpCode 工具，正在继续…' });
      text = `上一轮只回复了文字，尚未执行任务。请立即调用当前提供的 SpCode MCP 工具（服务器名 spcode）完成任务，再汇报实际结果。需要调用的工具之一：${required.join('、')}。不要重复计划或解释限制。`;
    }
  } catch (e) {
    closeSession(key);
    if (signal?.aborted) throw grokModel.abortError();
    throw grokModel.authError(e?.message) || e;
  } finally {
    activeRuns = Math.max(0, activeRuns - 1);
    if (signal) signal.removeEventListener('abort', onAbort);
    if (sessions.get(key) === session) session.ctx = null;
  }
}

module.exports = { runTurn, closeSession, closeIdle, busy };
