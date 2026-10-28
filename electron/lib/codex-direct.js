// Codex 直通：Codex SDK 驱动会话，工具调用通过 MCP 回到 SpCode 当前轮的工具链。
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const diag = require('./diag');
const codexEnv = require('./codex-env');

const sessions = new Map();
let activeRuns = 0;
const MAX_SESSIONS = 8;
const CODEX_TOOL_RESTRICTIONS = {
  features: { shell_tool: false, unified_exec: false, multi_agent: false, view_image_tool: false },
  include_apply_patch_tool: false,
  tools: { web_search: false }
};
// 这些 MCP 工具只读取本地项目或会话数据；明确标注为只读，避免 Codex 把默认未标注的工具当成需要批准的操作。
const READ_ONLY_TOOLS = new Set([
  'list_dir',
  'read_file',
  'search_text',
  'semantic_search',
  'map_lookup',
  'goto_definition',
  'dialog_lookup',
  'process_memory'
]);

function busy() { return activeRuns > 0; }

function closeSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  s.ctx = null;
  s.server.close();
}

function closeIdle() {
  if (activeRuns > 0) return 0;
  const keys = [...sessions.keys()];
  for (const key of keys) closeSession(key);
  return keys.length;
}

function toolDefs(tools) {
  return (tools || []).map((tool) => tool?.function || tool).filter((tool) => tool?.name);
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('request too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function startBridge(session) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return sendJson(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      if (req.method !== 'POST' || req.url !== '/mcp') return sendJson(res, 404, { error: 'not found' });
      if (body.method === 'tools/list') {
        return sendJson(res, 200, { tools: toolDefs(session.ctx?.tools).map((tool) => ({
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
        })) });
      }
      if (body.method === 'tools/call') {
        const name = String(body.params?.name || '');
        if (!toolDefs(session.ctx?.tools).some((tool) => tool.name === name)) {
          return sendJson(res, 200, { content: [{ type: 'text', text: '当前轮没有开放这个工具。' }], isError: true });
        }
        const ctx = session.ctx;
        const result = await ctx.runTool(name, body.params?.arguments || {}, body.params?.toolCallId || '');
        if (ctx.stats) ctx.stats.calls.push(name);
        if (result && Array.isArray(result.spcodeContent)) return sendJson(res, 200, { content: result.spcodeContent });
        return sendJson(res, 200, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? '') }] });
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

async function createSession(key, sig, modelCfg, tools, onEvent, agiMode) {
  const session = { sig, server: null, ctx: { tools, runTool: null }, thread: null, codex: null };
  const bridge = await startBridge(session);
  session.server = bridge.server;
  try {
    const { Codex } = await import('@openai/codex-sdk');
    const helper = path.join(__dirname, 'codex-mcp-bridge.mjs');
    const codex = new Codex({
      ...(modelCfg.apiKey ? { apiKey: String(modelCfg.apiKey).trim() } : {}),
      env: codexEnv(),
      config: {
        ...CODEX_TOOL_RESTRICTIONS,
        mcp_servers: {
          spcode: {
            command: process.execPath,
            args: [helper, String(bridge.port), bridge.token],
            env: { ELECTRON_RUN_AS_NODE: '1' },
            // 这是 SpCode 自己的本地桥；写入和桌面风险由 agent.js 工具层单独把关。
            // 显式批准 MCP 调用，避免 approvalPolicy=never 把全部写工具都拒绝掉。
            default_tools_approval_mode: 'approve'
          }
        }
      }
    });
    const cwd = path.join(os.tmpdir(), `spcode-codex-sandbox-${process.pid}`);
    fs.mkdirSync(cwd, { recursive: true });
    session.codex = codex;
    session.thread = codex.startThread({
      model: modelCfg.model && modelCfg.model !== 'default' ? String(modelCfg.model) : undefined,
      modelReasoningEffort: 'high',
      workingDirectory: cwd,
      skipGitRepoCheck: true,
      // AGI 已由用户开启自主执行，不再声明整个会话只读。
      // 原生工具仍关闭，实际操作继续经 SpCode 工具桥追踪和执行。
      sandboxMode: agiMode ? 'danger-full-access' : 'read-only',
      approvalPolicy: 'never',
      webSearchMode: 'disabled'
    });
    sessions.set(key, session);
    while (sessions.size > MAX_SESSIONS) closeSession(sessions.keys().next().value);
    diag.log('codex', 'Codex 直通会话已创建', { model: modelCfg.model || 'default', reasoningEffort: 'high', cwd, tools: tools.length });
    onEvent({ type: 'status', text: 'Codex 直通会话已接通。' });
    return session;
  } catch (e) {
    bridge.server.close();
    throw e;
  }
}

function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  const files = [];
  const matches = [];
  for (const part of content) {
    const url = part?.type === 'image_url' ? (part.image_url?.url || part.image_url) : '';
    const m = /^data:([^;]+);base64,(.+)$/s.exec(String(url || ''));
    if (!m) continue;
    matches.push(m);
  }
  try {
    // 先限制数量再落盘，确保每个临时文件都在最终清理名单中。
    for (const m of matches.slice(-8)) {
      const ext = m[1].split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'bin';
      const file = path.join(os.tmpdir(), `spcode-codex-${process.pid}-${crypto.randomBytes(8).toString('hex')}.${ext}`);
      files.push(file);
      fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    }
    return files;
  } catch (err) {
    for (const file of files) { try { fs.unlinkSync(file); } catch { /* 文件可能尚未写入 */ } }
    throw err;
  }
}

async function runTurn({ key, sig, fresh, modelCfg, firstPrefix, systemContext, turnText, userContent, tools, runTool, onEvent, signal, requiredToolNames = [], agiMode = false }) {
  // 模式改变必须重建 SDK 会话，不能复用旧的只读权限。
  sig = `${sig}\nagi:${!!agiMode}\nreasoning:high`;
  const specs = toolDefs(tools);
  let session = sessions.get(key);
  if (session && (fresh || session.sig !== sig)) {
    closeSession(key);
    session = null;
  }
  if (!session) session = await createSession(key, sig, modelCfg, specs, onEvent, agiMode);
  const stats = { calls: [] };
  session.ctx = { tools: specs, runTool, stats };
  let images = [];
  const prefix = session.turns ? '' : `${firstPrefix || ''}\n\n`;
  const prompt = `${prefix}${systemContext ? `【本轮 SpCode 当前规则与上下文；与旧指令冲突时以本段为准】\n${systemContext}\n\n` : ''}${turnText || ''}`.trim();
  activeRuns += 1;
  let content = '';
  try {
    images = imagesOf(userContent);
    onEvent({ type: 'think', text: session.turns ? 'Codex 直通：沿用本对话会话' : 'Codex 直通：新会话已载入 SpCode 规则' });
    const toolGuidance = '【本轮 SpCode 工具规则】是否需要工具取决于用户任务：需要查看或修改项目、查询本地信息、执行已确认操作时，必须实际调用本轮提供的 spcode MCP 工具，并根据工具结果继续；不得只口头描述将要操作、凭猜测汇报结果，或把工具限制说成用户需要处理的步骤。用户只问原理或闲聊时，不要为了调用工具而调用。每次只调用当前任务最相关的工具，成功后复用结果，避免重复读取或重复操作。修改代码后必须核对目标行为：语法检查只证明语法有效，不等于功能已修复；优先用相关测试、运行命令或可用的桌面工具验证。若运行中的页面不会热更新，或当前无法重启/构建验证，必须明确说明文件修改与运行效果的区别及用户需要采取的重启/更新步骤，不得把写入成功当作修复完成。';
    let nextInput = [
      { type: 'text', text: `你只能使用 MCP 服务器 spcode 提供的工具。Codex CLI 内置文件和命令能力均不可用于此任务；项目文件只能通过 SpCode 工具读取或修改。CLI 原生文件沙盒不代表外部 SpCode MCP 工具只读；这些工具由 SpCode 执行，能否写入以本轮 SpCode 授权状态及实际工具结果为准，不要凭 CLI 沙盒标签自行拒绝调用。\n${toolGuidance}\n\n${prompt}` },
      ...images.map((file) => ({ type: 'local_image', path: file }))
    ];
    const required = [...new Set((requiredToolNames || []).map((name) => String(name || '').trim()).filter(Boolean))];
    for (let attempt = 0; ; attempt += 1) {
      session.turns = (session.turns || 0) + 1;
      const { events } = await session.thread.runStreamed(nextInput, { signal });
      for await (const event of events) {
        if (signal?.aborted) {
          const err = new Error('已停止');
          err.name = 'AbortError';
          throw err;
        }
        if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call') {
          onEvent({ type: 'status', text: `Codex 正在调用 ${event.item.tool}` });
        } else if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item?.error?.message) {
          const message = String(event.item.error.message);
          if (/requires approval|approval policy.*never|需要审批|审批策略.*never/i.test(message)) {
            throw new Error(`Codex 拒绝调用 SpCode 工具：${message}`);
          }
        } else if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
          content = String(event.item.text || '');
          // SDK 的 agent_message 是一条完整消息，不是增量片段；工具往返时后续消息应替换前文。
          onEvent({ type: 'rewrite_text', text: content });
        } else if (event.type === 'turn.failed') {
          throw new Error(event.error?.message || 'Codex 运行失败');
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Codex 运行失败');
        }
      }
      if (!required.length || required.some((name) => stats.calls.includes(name))) break;
      if (attempt >= 2) throw new Error('Codex 未调用本轮要求的 SpCode 工具，无法确认任务已执行。');
      onEvent({ type: 'status', text: 'Codex 还没有调用完成任务所需的 SpCode 工具，正在继续…' });
      nextInput = [{
        type: 'text',
        text: `上一轮只回复了文字，尚未执行任务。请立即调用当前提供的 SpCode 工具完成任务，再汇报实际结果。需要调用的工具之一：${required.join('、')}。不要重复计划或解释限制。`
      }];
    }
    return { content, reasoning: '' };
  } catch (e) {
    closeSession(key);
    throw e;
  } finally {
    activeRuns = Math.max(0, activeRuns - 1);
    session.ctx = null;
    for (const file of images) { try { fs.unlinkSync(file); } catch { /* 临时图已清理 */ } }
  }
}

module.exports = { runTurn, closeSession, closeIdle, busy };
