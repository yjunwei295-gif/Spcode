// Codex 直通：Codex SDK 驱动会话，工具调用通过 MCP 回到 SpCode 当前轮的工具链。
const http = require('http');
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { channel } = require('node:diagnostics_channel');
const diag = require('./diag');
const codexEnv = require('./codex-env');
const codexModel = require('./codex-model');
const codexChatDirect = require('./codex-chat-direct');

const sessions = new Map();
// 同一会话只能有一个 SDK 写入者；队列尾在真实执行收尾后释放，不把不同会话串行化。
const turnQueues = new Map();
let activeRuns = 0;
// 只关联 SDK 事件流启动的子进程，其他会话和工具执行器不进入该作用域。
const sdkProcessScope = new AsyncLocalStorage();
const childProcessEvents = channel('child_process');
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

/** 工作 SDK、排队请求和聊天模式都算作正在执行，空闲清理不得跨过排队边界。 */
function busy() { return activeRuns > 0 || turnQueues.size > 0 || codexChatDirect.busy(); }

/** 只关闭工作 SDK 会话；额度切换时保留聊天模式自己的对话上下文。 */
function closeSdkSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  s.ctx = null;
  s.server.close();
}

/** 用户主动关闭会话时，两个额度通道的上下文一并解除绑定。 */
function closeSession(key) {
  closeSdkSession(key);
  codexChatDirect.closeSession(key);
}

function closeIdle() {
  if (busy()) return 0;
  const keys = [...sessions.keys()];
  for (const key of keys) closeSdkSession(key);
  return keys.length + codexChatDirect.closeIdle();
}

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

function startBridge(session) {
  const token = crypto.randomBytes(32).toString('hex');
  const server = http.createServer(async (req, res) => {
    if (req.socket.remoteAddress !== '127.0.0.1' && req.socket.remoteAddress !== '::1') {
      return sendJson(res, 403, { error: 'forbidden' });
    }
    if (req.headers.authorization !== `Bearer ${token}`) return sendJson(res, 401, { error: 'unauthorized' });
    // HTTP 请求跨越等待正文的边界时仍归属原轮次，不能借用下一次插话的工具授权。
    const ctx = session.ctx;
    try {
      if (req.method !== 'POST' || req.url !== '/mcp') return sendJson(res, 404, { error: 'not found' });
      const commandRequest = req.headers['x-spcode-command'] === '1'
        && toolDefs(ctx?.tools).some(function allowsCommand(tool) { return tool.name === 'run_command'; });
      const body = await readJson(req, commandRequest);
      if (body.method === 'tools/list') {
        return sendJson(res, 200, { tools: toolDefs(ctx?.tools).map((tool) => ({
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
        if (!toolDefs(ctx?.tools).some((tool) => tool.name === name)) {
          return sendJson(res, 200, { content: [{ type: 'text', text: '当前轮没有开放这个工具。' }], isError: true });
        }
        // 回包提交前计作在途，插话不能中断正在执行的工具。
        if (ctx.stats) ctx.stats.activeTools++;
        try {
          const result = await ctx.runTool(name, body.params?.arguments || {}, body.params?.toolCallId || '');
          if (ctx.stats) ctx.stats.calls.push(name);
          if (result && Array.isArray(result.spcodeContent)) return sendJson(res, 200, { content: result.spcodeContent });
          return sendJson(res, 200, { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result ?? '') }] });
        } finally {
          if (ctx.stats) ctx.stats.activeTools--;
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
    const cwd = codexModel.sandboxDirectory();
    session.codex = codex;
    session.thread = codex.startThread({
      model: modelCfg.model && modelCfg.model !== 'default' ? String(modelCfg.model) : undefined,
      modelReasoningEffort: modelCfg.reasoningEffort || undefined,
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
    diag.log('codex', 'Codex 直通会话已创建', { model: modelCfg.model || 'default', reasoningEffort: modelCfg.reasoningEffort || 'default', cwd, tools: tools.length });
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

/**
 * 在调用任何 Codex 工作模型之前读取服务端五小时额度。
 * @param {object} modelCfg 当前 Codex 账号配置，API Key 请求不使用订阅配额。
 * @returns {Promise<boolean>} 只有服务端明确显示五小时已耗尽才切聊天；查询失败记录诊断并保持原有工作路由。
 */
async function isWorkQuotaExhausted(modelCfg) {
  try {
    const snapshot = await codexModel.readRateLimitsFromAppServer(modelCfg);
    return codexModel.fiveHourQuotaExhausted(snapshot);
  } catch (error) {
    diag.log('codex', '五小时额度查询失败，继续原工作路由', { message: error?.message || String(error) });
    return false;
  }
}

/**
 * 等待前序请求真正收尾；排队者取消时立即返回，前序任务仍由自己的信号控制。
 * @param {Promise<void>} previous 同一 key 的前序队列尾，只在前序执行结束后兑现。
 * @param {AbortSignal} signal 当前等待者的取消信号，不传时直接等待前序。
 * @returns {Promise<void>} 前序结束后兑现；取消时以 AbortError 拒绝，并移除本次监听。
 */
function waitForTurn(previous, signal) {
  if (!signal) return previous;
  return new Promise(function wait(resolve, reject) {
    /** 仅结束当前等待者，不能让后继越过仍在运行的前序。 */
    function cancelled() {
      signal.removeEventListener('abort', cancelled);
      const error = new Error('已停止');
      error.name = 'AbortError';
      reject(error);
    }
    /** 前序结束后释放取消监听，再允许当前请求进入执行。 */
    function ready() {
      signal.removeEventListener('abort', cancelled);
      resolve();
    }
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) cancelled();
    previous.then(ready);
  });
}

/**
 * 按会话 key 串行执行 Codex 请求，防止线程双写和 MCP 工具上下文被后一次调用覆盖。
 * @param {object} args 沿用原直通参数；不同 key 并行，同 key 按进入顺序执行，取消只作用于自身请求。
 * @returns {Promise<object>} 原请求结果；真实失败原样传给调用方，不重投已经执行的工具。
 * 排队者取消可以提前返回，但内部队列仍等前序真正收尾，保证后继不会抢占旧写入者。
 */
async function runTurn(args) {
  const previous = turnQueues.get(args.key);
  let release;
  /**
   * 保存本段队列的兑现入口，供请求退出时释放后继。
   * @param {function():void} resolve gate 的兑现函数，保存到外层 release 后由 finally 调用。
   * @returns {void} 不提前兑现 gate；后继仍须等待当前请求真正收尾。
   */
  function capture(resolve) { release = resolve; }
  const gate = new Promise(capture);
  /** 当前执行结束后才兑现本段队列，排队取消也不能跳过前序。 */
  function waitForCurrent() { return gate; }
  const tail = previous ? previous.then(waitForCurrent) : gate;
  turnQueues.set(args.key, tail);
  activeRuns += 1;
  try {
    if (previous) await waitForTurn(previous, args.signal);
    if (args.signal?.aborted) {
      const error = new Error('已停止');
      error.name = 'AbortError';
      throw error;
    }
    return await runSdkTurn(args);
  } finally {
    activeRuns -= 1;
    release();
    /** 仅删除仍属于自己的队列尾，前序不能移除已经登记的后继。 */
    function forget() {
      if (turnQueues.get(args.key) === tail) turnQueues.delete(args.key);
    }
    tail.then(forget);
  }
}

/**
 * 在 Windows 上等待旧 SDK 子进程实际退出，再结束它的输出流。
 * @param {AbortSignal} handoff 只标记当前请求是否因用户插话交接。
 * @param {Function} consume 消费当前 SDK 事件的函数。
 * @returns {Promise<unknown>} 事件消费结果或原始错误。
 * 子进程退出时管道可能仍保持打开，SDK 的逐行读取需要明确的流结束信号。
 */
async function consumeWithHandoff(handoff, consume) {
  const owner = {};
  /** 只记录当前作用域中启动的 SDK 子进程。 */
  function bindSdkChild({ process: child }) {
    if (sdkProcessScope.getStore() !== owner || owner.child) return;
    owner.child = child;
    child.once('exit', finishSdkPipes);
    /** 确认旧进程退出后，令 SDK 在已计划的交接中结束读取。 */
    function finishSdkPipes() {
      if (!handoff.aborted) return;
      child.stdout.push(null);
      child.stderr.destroy();
    }
  }
  childProcessEvents.subscribe(bindSdkChild);
  try {
    return await sdkProcessScope.run(owner, consume);
  } finally {
    childProcessEvents.unsubscribe(bindSdkChild);
  }
}

/**
 * 执行已取得会话写入权的一轮请求，配额路由、SDK 上下文与工具回传均沿用原语义。
 * @param {object} args 由 runTurn 按 key 排队后的调用参数。
 * @param {Function} [args.onInterjectionSent] SDK 开始传输或官方客户端确认发送时显示处理进度，已看另等模型回执。
 * @param {Function} [args.onInterjectionDelivered] 模型活动或成功完成时确认 AI 已看，切换官方聊天时沿用。
 * @returns {Promise<object>} 模型正文或交接结果；SDK 真实失败仍在事件流收尾后抛出。
 */
async function runSdkTurn({ key, sig, fresh, modelCfg, firstPrefix, systemContext, turnText, userContent, tools, runTool, onEvent, signal, requiredToolNames = [], agiMode = false, shouldYield, watchInterjections, onInterjectionSent, onInterjectionDelivered, sdkOnly = false }) {
  // 额度触顶的判定与 UI 切换由本地代码完成，无需等待已耗尽的模型作决定。
  if (await isWorkQuotaExhausted(modelCfg)) {
    // 并发分支的父请求可能正占用官方聊天队列，不能再次入队等父请求退出。
    if (sdkOnly) throw new Error('Codex 工作额度已耗尽，官方聊天模式使用单一前台，无法启动并发分支。');
    closeSdkSession(key);
    return codexChatDirect.runTurn({ key, sig, fresh, modelCfg, firstPrefix, systemContext, turnText, userContent, tools, runTool, onEvent, signal, requiredToolNames, agiMode, shouldYield, onInterjectionSent, onInterjectionDelivered });
  }
  const chatSig = sig;
  // 模式改变必须重建 SDK 会话，不能复用旧的只读权限。
  sig = `${sig}\nagi:${!!agiMode}\nreasoning:${modelCfg.reasoningEffort || 'default'}`;
  const specs = toolDefs(tools);
  let session = sessions.get(key);
  if (session && (fresh || session.sig !== sig)) {
    closeSession(key);
    session = null;
  }
  if (!session) session = await createSession(key, sig, modelCfg, specs, onEvent, agiMode);
  const stats = { calls: [], activeTools: 0 };
  session.ctx = { tools: specs, runTool, stats };
  const handoff = watchInterjections ? new AbortController() : null;
  const streamSignal = handoff && signal ? AbortSignal.any([signal, handoff.signal]) : handoff?.signal || signal;
  const toolItems = new Set();
  let acceptingHandoff = false;
  let unwatch;
  /**
   * 只结束已开始的本次 SDK 流，保留会话和用户的整轮取消信号。
   * 等待在途工具回传及下一次模型活动，才允许接手该请求。
   */
  function yieldToInterjections() {
    if (acceptingHandoff && !signal?.aborted && !stats.activeTools && !toolItems.size && shouldYield()) handoff.abort();
  }
  let images = [];
  const prefix = session.turns ? '' : `${firstPrefix || ''}\n\n`;
  const prompt = `${prefix}${systemContext ? `【本轮 SpCode 当前规则与上下文；与旧指令冲突时以本段为准】\n${systemContext}\n\n` : ''}${turnText || ''}`.trim();
  let content = '';
  try {
    if (watchInterjections) unwatch = watchInterjections(yieldToInterjections);
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
      acceptingHandoff = false;
      let streamError = null;
      /** 消费 SDK 事件，保留工具结果确认和进程退出的顺序。 */
      async function consumeSdkEvents() {
        const { events } = await session.thread.runStreamed(nextInput, { signal: streamSignal });
        // 请求已交给 SDK，等待首个模型事件期间就展示处理中。
        onInterjectionSent?.();
        for await (const event of events) {
          // 原样留存 SDK 实际返回的事件，包含公开推理摘要、消息及调用状态。
          require('./training-recorder').note('sdk-event', { provider: 'codex', event });
          if (signal?.aborted) {
            streamError = new Error('已停止');
            streamError.name = 'AbortError';
            continue;
          }
          // 终止事件不提前关闭生成器；消费到 SDK 真正退出后再交付错误，期间不再展示后续正文。
          if (streamError || handoff?.signal.aborted) continue;
          // turn.started 不代表原始用户消息已写入会话，必须等模型活动才能安全续接。
          const itemType = event.item?.type;
          // 启动事件只说明 SDK 建立了轮次；模型活动或成功完成才确认用户消息送达。
          if (itemType === 'reasoning' || itemType === 'agent_message' || itemType === 'mcp_tool_call' || event.type === 'turn.completed') {
            onInterjectionDelivered?.();
          }
          if (itemType === 'reasoning' || itemType === 'agent_message') acceptingHandoff = !!handoff;
          if (event.type === 'turn.completed' || event.type === 'turn.failed' || event.type === 'error') acceptingHandoff = false;
          if (event.type === 'item.started' && event.item?.type === 'mcp_tool_call') {
            toolItems.add(event.item.id);
            onEvent({ type: 'status', text: `Codex 正在调用 ${event.item.tool}` });
          } else if (event.type === 'item.completed' && event.item?.type === 'mcp_tool_call') {
            // 工具完成事件可以先于结果进入会话历史；等模型再活动才能结束旧流。
            acceptingHandoff = false;
            toolItems.delete(event.item.id);
            const message = String(event.item.error?.message || '');
            if (/requires approval|approval policy.*never|需要审批|审批策略.*never/i.test(message)) {
              streamError = new Error(`Codex 拒绝调用 SpCode 工具：${message}`);
            }
          } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && !shouldYield?.()) {
            content = String(event.item.text || '');
            // SDK 的 agent_message 是一条完整消息，不是增量片段；工具往返时后续消息应替换前文。
            onEvent({ type: 'rewrite_text', text: content });
          } else if (event.type === 'turn.failed') {
            streamError = new Error(event.error?.message || 'Codex 运行失败');
          } else if (event.type === 'error') {
            // 顶层 error 也承载重试次数和等待网络的通知，继续消费到正文或最终失败。
            const reconnect = /^Reconnecting\.\.\. (\d+\/\d+|waiting for network)(?: \(|$)/.exec(event.message);
            if (reconnect) {
              const progress = reconnect[1];
              const text = progress === 'waiting for network' ? 'Codex 正在等待网络恢复…' : `Codex 正在重连（${progress}）…`;
              onEvent({ type: 'status', text });
            } else {
              streamError = new Error(event.message || 'Codex 运行失败');
            }
          }
          if (streamError) acceptingHandoff = false;
          else yieldToInterjections();
        }
      }
      if (handoff && process.platform === 'win32') await consumeWithHandoff(handoff.signal, consumeSdkEvents);
      else await consumeSdkEvents();
      acceptingHandoff = false;
      if (streamError) throw streamError;
      // 插话已改变范围时将控制权交还宿主，停止后的模型请求只投递最新用户要求。
      if (shouldYield?.() || !required.length || required.some((name) => stats.calls.includes(name))) break;
      if (attempt >= 2) throw new Error('Codex 未调用本轮要求的 SpCode 工具，无法确认任务已执行。');
      onEvent({ type: 'status', text: 'Codex 还没有调用完成任务所需的 SpCode 工具，正在继续…' });
      nextInput = [{
        type: 'text',
        text: `上一轮只回复了文字，尚未执行任务。请立即调用当前提供的 SpCode 工具完成任务，再汇报实际结果。需要调用的工具之一：${required.join('、')}。不要重复计划或解释限制。`
      }];
    }
    return { content, reasoning: '' };
  } catch (e) {
    // 仅接管主动结束的旧流；整轮停止或 SDK 真实错误仍走原失败路径。
    if (handoff?.signal.aborted && !signal?.aborted && e?.name === 'AbortError') return { content: '', reasoning: '' };
    closeSdkSession(key);
    // 只有尚未执行任何工具、且服务端确认五小时刚好耗尽时，才安全地重投当前任务。
    if (!sdkOnly && !stats.calls.length && !signal?.aborted && await isWorkQuotaExhausted(modelCfg)) {
      onEvent({ type: 'status', text: 'Codex 工作额度在本轮耗尽，自动转入官方聊天模式…' });
      return codexChatDirect.runTurn({ key, sig: chatSig, fresh, modelCfg, firstPrefix, systemContext, turnText, userContent, tools, runTool, onEvent, signal, requiredToolNames, agiMode, shouldYield, onInterjectionSent, onInterjectionDelivered });
    }
    throw e;
  } finally {
    if (unwatch) unwatch();
    session.ctx = null;
    for (const file of images) { try { fs.unlinkSync(file); } catch { /* 临时图已清理 */ } }
  }
}

module.exports = { runTurn, closeSession, closeIdle, busy };
