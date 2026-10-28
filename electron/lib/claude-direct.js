// Claude 直通：Claude Agent SDK 驱动会话，SpCode 工具注册成进程内 MCP 服务（spcode），在本进程里执行。
// Claude Code 自带工具全部关掉；同一对话靠 resume 接上一轮的会话编号。
const diag = require('./diag');
const claudeModel = require('./claude-model');

const MAX_SESSIONS = 8;
const MCP_PREFIX = 'mcp__spcode__';

/** key → { sig, sessionId, ctx, turns } ；ctx 是本轮的执行上下文，工具回调从这里取 */
const sessions = new Map();
let activeRuns = 0;

function busy() { return activeRuns > 0; }

function closeSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  s.ctx = null;
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

let mcpMods = null;
async function mcp() {
  if (!mcpMods) {
    const [{ Server }, types] = await Promise.all([
      import('@modelcontextprotocol/sdk/server/index.js'),
      import('@modelcontextprotocol/sdk/types.js')
    ]);
    mcpMods = { Server, ListToolsRequestSchema: types.ListToolsRequestSchema, CallToolRequestSchema: types.CallToolRequestSchema };
  }
  return mcpMods;
}

/** 每次 query 新建一个 MCP 服务实例（一个实例只能连一次），工具列表和执行都取本轮 ctx */
async function spcodeServer(session) {
  const { Server, ListToolsRequestSchema, CallToolRequestSchema } = await mcp();
  const server = new Server({ name: 'spcode', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: (session.ctx?.tools || []).map((tool) => ({
      name: tool.name,
      description: String(tool.description || ''),
      inputSchema: tool.parameters || { type: 'object', properties: {} }
    }))
  }));
  server.setRequestHandler(CallToolRequestSchema, async (call) => {
    const ctx = session.ctx;
    const name = String(call.params?.name || '');
    if (!ctx) return { content: [{ type: 'text', text: '本轮已结束，工具没有执行。' }], isError: true };
    if (!ctx.tools.some((tool) => tool.name === name)) {
      return { content: [{ type: 'text', text: '当前轮没有开放这个工具。' }], isError: true };
    }
    try {
      const result = await ctx.runTool(name, call.params?.arguments || {}, String(call.params?._meta?.progressToken || ''));
      if (ctx.stats) ctx.stats.calls.push(name);
      if (result && Array.isArray(result.spcodeContent)) return { content: result.spcodeContent };
      return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? '') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `工具失败：${e?.message || e}` }], isError: true };
    }
  });
  return server;
}

const TOOL_GUIDANCE = '【本轮 SpCode 工具规则】你只能使用 MCP 服务器 spcode 提供的工具，Claude Code 内置的文件、命令、搜索工具都不可用；项目文件只能通过 SpCode 工具读取或修改，能否写入以本轮 SpCode 授权和实际工具结果为准。需要查看或修改项目、查询本地信息、执行已确认操作时，必须实际调用工具并根据结果继续，不得只口头描述或凭猜测汇报。用户只问原理或闲聊时，不要为了调用工具而调用。修改代码后要核对目标行为，写入成功不等于功能修复。';

/** 跑一次 query：同一会话用 resume 接上；返回本次输出的文字 */
async function runQuery(session, modelCfg, text, images, onEvent, signal) {
  const { query } = await claudeModel.sdk();
  const model = claudeModel.modelOf(modelCfg);
  const abortController = new AbortController();
  const onAbort = () => abortController.abort();
  if (signal) {
    if (signal.aborted) throw claudeModel.abortError();
    signal.addEventListener('abort', onAbort, { once: true });
  }
  const allowed = new Set((session.ctx?.tools || []).map((tool) => `${MCP_PREFIX}${tool.name}`));
  let content = '';
  let reasoning = '';
  try {
    const q = query({
      prompt: claudeModel.promptInput(text, images),
      options: claudeModel.baseOptions(modelCfg, {
        ...(session.sessionId ? { resume: session.sessionId } : {}),
        mcpServers: { spcode: { type: 'sdk', name: 'spcode', instance: await spcodeServer(session) } },
        // 内置工具已由 tools: [] 关掉；只预先放行本轮开放的 SpCode 工具，其它没有批准入口一律拒绝
        allowedTools: [...allowed],
        includePartialMessages: true,
        abortController
      })
    });
    for await (const msg of q) {
      if (msg.session_id) session.sessionId = msg.session_id;
      const d = claudeModel.streamDelta(msg);
      if (d?.text) {
        content += d.text;
        onEvent({ type: 'text', text: d.text });
      } else if (d?.reason) {
        reasoning += d.reason;
        onEvent({ type: 'reason', text: d.reason });
      }
      if (msg.type === 'assistant' && msg.error) {
        throw claudeModel.runError(model, claudeModel.partsText(msg.message?.content) || msg.error);
      }
      if (msg.type === 'result') {
        const failure = claudeModel.resultFailure(msg);
        if (failure) throw claudeModel.runError(model, failure);
        if (!content && msg.result) content = String(msg.result);
      }
    }
    return { content, reasoning };
  } catch (e) {
    if (signal?.aborted) throw claudeModel.abortError();
    throw claudeModel.regionError(model, e?.message) || e;
  } finally {
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

async function runTurn({ key, sig, fresh, modelCfg, firstPrefix, systemContext, turnText, userContent, tools, runTool, onEvent, signal, requiredToolNames = [], agiMode = false }) {
  sig = `${sig}\nagi:${!!agiMode}`;
  const specs = toolDefs(tools);
  let session = sessions.get(key);
  if (session && (fresh || session.sig !== sig)) {
    closeSession(key);
    session = null;
  }
  const isNew = !session;
  if (isNew) {
    session = { sig, sessionId: '', ctx: null, turns: 0 };
    sessions.set(key, session);
    while (sessions.size > MAX_SESSIONS) closeSession(sessions.keys().next().value);
    diag.log('claude', 'Claude 直通会话已创建', { model: modelCfg.model || 'default', tools: specs.length });
  }
  const stats = { calls: [] };
  session.ctx = { tools: specs, runTool, stats };
  const prefix = session.sessionId ? '' : `${firstPrefix || ''}\n\n`;
  const prompt = `${prefix}${systemContext ? `【本轮 SpCode 当前规则与上下文；与旧指令冲突时以本段为准】\n${systemContext}\n\n` : ''}${turnText || ''}`.trim();
  const required = [...new Set((requiredToolNames || []).map((name) => String(name || '').trim()).filter(Boolean))];
  activeRuns += 1;
  try {
    onEvent({ type: 'think', text: isNew ? 'Claude 直通：新开会话，已带上 SpCode 规则' : 'Claude 直通：沿用本对话的会话' });
    let text = `${TOOL_GUIDANCE}\n\n${prompt}`;
    let images = claudeModel.imageBlocks(userContent);
    for (let attempt = 0; ; attempt += 1) {
      session.turns += 1;
      const out = await runQuery(session, modelCfg, text, images, onEvent, signal);
      if (!required.length || required.some((name) => stats.calls.includes(name))) return out;
      if (attempt >= 2) throw new Error('Claude 未调用本轮要求的 SpCode 工具，无法确认任务已执行。');
      onEvent({ type: 'rewrite_text', text: '' });
      onEvent({ type: 'status', text: 'Claude 还没有调用完成任务所需的 SpCode 工具，正在继续…' });
      text = `上一轮只回复了文字，尚未执行任务。请立即调用当前提供的 SpCode 工具完成任务，再汇报实际结果。需要调用的工具之一：${required.join('、')}。不要重复计划或解释限制。`;
      images = [];
    }
  } catch (e) {
    closeSession(key);
    throw e;
  } finally {
    activeRuns = Math.max(0, activeRuns - 1);
    session.ctx = null;
  }
}

module.exports = { runTurn, closeSession, closeIdle, busy };
