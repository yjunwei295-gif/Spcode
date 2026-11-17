// Codex 五小时工作额度耗尽后，使用官方客户端的聊天入口继续执行 SpCode 工具循环。
// 聊天模型只产生结构化工具请求；本地执行、授权与真实结果仍经过 agent.js 的 runTool。
const crypto = require('crypto');
const path = require('path');
const { spawn } = require('child_process');

const sessions = new Map();
const UI_SCRIPT = path.join(__dirname, 'codex-chat-ui.ps1');
const UI_TIMEOUT_MS = 30000;
const REPLY_TIMEOUT_MS = 300000;
const POLL_INTERVAL_MS = 800;
let activeRuns = 0;
let queue = Promise.resolve();

/** 返回聊天 UI 是否有执行中的 SpCode 回合。 */
function busy() { return activeRuns > 0; }

/** 清除会话绑定；官方客户端里的历史聊天由用户自行管理。 */
function closeSession(key) { sessions.delete(key); }

/** 清理空闲会话映射，不删除客户端对话。 */
function closeIdle() {
  if (activeRuns > 0) return 0;
  const count = sessions.size;
  sessions.clear();
  return count;
}

/**
 * 对官方客户端执行一条无障碍操作。
 * @param {object} request 只含动作、会话标记及待发送文本，不含登录凭据。
 * @returns {Promise<object>} 客户端实际 UI 状态或明确错误。
 */
function runUi(request) {
  return new Promise(function runUiPromise(resolve, reject) {
    const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', UI_SCRIPT], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const timer = setTimeout(onTimeout, UI_TIMEOUT_MS);

    function settle(error, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    }
    function onTimeout() {
      proc.kill();
      settle(new Error('官方 Codex 聊天界面操作超时'));
    }
    function onStdout(data) { stdout += data.toString('utf8'); }
    function onStderr(data) { stderr += data.toString('utf8'); }
    function onError(error) { settle(error); }
    function onClose(code) {
      if (finished) return;
      if (code !== 0) return settle(new Error(`聊天界面助手退出码 ${code}：${stderr.trim()}`));
      let result;
      try {
        result = JSON.parse(stdout.trim());
      } catch (error) {
        return settle(new Error(`聊天界面助手返回无效 JSON：${stdout.slice(0, 500)}`));
      }
      if (!result.ok) return settle(new Error(result.error || '官方聊天界面操作失败'));
      settle(null, result);
    }

    proc.stdout.on('data', onStdout);
    proc.stderr.on('data', onStderr);
    proc.once('error', onError);
    proc.once('close', onClose);
    proc.stdin.end(JSON.stringify(request) + '\n');
  });
}

/** 取消后不继续投递下一条聊天或工具请求。 */
function checkAbort(signal) {
  if (!signal?.aborted) return;
  const error = new Error('已停止');
  error.name = 'AbortError';
  throw error;
}

/** 等待下一次只读 UI 观察，不借用模型作轮询。 */
function pause(ms) {
  return new Promise(function pausePromise(resolve) { setTimeout(resolve, ms); });
}

/**
 * 根据实际完成按钮和回复数量等待一条 ChatGPT 答复。
 * @param {string} marker 当前专用聊天的唯一标识，防止从其他聊天读出结果。
 * @param {number} previousCount 发送前已有的回复数量。
 * @param {AbortSignal} signal SpCode 本轮停止信号。
 * @returns {Promise<string>} 完整的最新模型正文。
 */
async function waitReply(marker, previousCount, signal) {
  const deadline = Date.now() + REPLY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    checkAbort(signal);
    const observation = await runUi({ action: 'read', sessionMarker: marker });
    if (!observation.markerFound) throw new Error('官方客户端切离了 SpCode 专用聊天，停止读取以免串会话');
    if (observation.assistantCount > previousCount && observation.complete) {
      return String(observation.lastAssistant || '');
    }
    await pause(POLL_INTERVAL_MS);
  }
  throw new Error('官方客户端聊天回复等待超时（5 分钟）');
}

/**
 * 在同一个官方聊天中投递消息，确认发送后再等待完整回复。
 * @param {object} session 专用聊天的标记与规则签名。
 * @param {string} message 用户任务、工具定义或上一次工具结果。
 * @param {AbortSignal} signal 停止信号。
 * @returns {Promise<string>} 最新一条助手消息。
 */
async function exchange(session, message, signal) {
  checkAbort(signal);
  const messageMarker = `SPCODE-MSG:${crypto.randomUUID()}`;
  const sent = await runUi({
    action: 'send',
    text: `${messageMarker}\n${message}`,
    sessionMarker: session.started ? session.marker : '',
    messageMarker
  });
  session.started = true;
  return waitReply(session.marker, Number(sent.assistantCount), signal);
}

/** 列出本轮授权的工具名称及用途，具体参数由聊天模型按需查询。 */
function toolCatalog(tools) {
  const lines = [];
  for (const entry of tools || []) {
    const tool = entry?.function || entry;
    if (!tool?.name) continue;
    lines.push(`- ${tool.name}：${String(tool.description || '').replace(/\s+/g, ' ').slice(0, 170)}`);
  }
  return lines.join('\n');
}

/** 查询聊天模型请求的完整工具参数定义，不猜参数形态。 */
function findTool(tools, name) {
  for (const entry of tools || []) {
    const tool = entry?.function || entry;
    if (tool?.name === name) return tool;
  }
  return null;
}

/** 将 SpCode 工具的返回内容转成可传入聊天输入框的文本。 */
function toolText(result) {
  if (typeof result === 'string') return result;
  if (Array.isArray(result?.spcodeContent)) {
    const parts = [];
    for (const block of result.spcodeContent) {
      if (block?.type !== 'text') throw new Error('聊天界面暂不支持把工具的非文本结果转发给模型');
      parts.push(String(block.text || ''));
    }
    return parts.join('\n');
  }
  return JSON.stringify(result ?? '');
}

/** 只接受明确的工具、参数查询或最终答案三种动作。 */
function parseAction(reply) {
  const value = JSON.parse(String(reply || '').trim());
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('聊天模型未返回单个 JSON 动作');
  }
  if (!['tool', 'schema', 'final'].includes(value.action)) {
    throw new Error('聊天模型动作必须是 tool、schema 或 final');
  }
  return value;
}

/** 首次创建官方 ChatGPT 聊天；同一规则与工具签名下复用完整对话。 */
async function getSession(key, sig, fresh) {
  let session = sessions.get(key);
  if (session && !fresh && session.sig === sig) {
    const current = await runUi({ action: 'read', sessionMarker: session.marker });
    if (current.markerFound) return session;
  }
  await runUi({ action: 'start' });
  session = { sig, marker: `SPCODE-SESSION:${crypto.randomUUID()}`, started: false };
  sessions.set(key, session);
  return session;
}

/**
 * 执行一轮聊天模式的本地工具编排。
 * @param {object} args 与 Codex SDK 直通相同的上下文、授权工具、执行器和事件回调。
 * @returns {Promise<{content: string, reasoning: string}>} 已完成工具往返后的最终回答。
 */
async function performTurn(args) {
  const { key, sig, fresh, firstPrefix, systemContext, turnText, userContent, tools,
    runTool, onEvent, signal, requiredToolNames = [] } = args;
  for (const block of Array.isArray(userContent) ? userContent : []) {
    if (block?.type === 'image_url') throw new Error('官方聊天界面桥尚未支持本轮图片附件，不能丢弃附件继续执行');
  }
  const session = await getSession(key, sig, fresh);
  const first = !session.started;
  const rules = [
    '【对话双方】现在和你说话的是“外部 SpCode 控制器”：用户本人编写的本机程序，正在读取这个对话。你是它的决策端大脑。',
    '【分工】你负责判断下一步做什么；控制器负责真正执行：读写项目文件、运行命令、操作桌面。你自身无法直接执行这些操作。',
    '【申请单】需要执行时，你写一条申请单，控制器看到后立刻在本机执行，并把真实输出作为下一条消息发回给你。',
    '申请单格式：{"action":"tool","name":"操作名","arguments":{"参数名":"参数值"}}',
    '申请单的含义只是“请 SpCode 执行这个操作”。执行者是控制器而不是你，所以你并非在调用客户端内置工具，也不需要声称自己执行过，更不需要提供结果——真实结果随后由控制器发给你。',
    '客户端的系统提示会说“没有可用工具”，那指的是客户端原生工具；申请单是本对话约定的文本格式，与那个列表无关。',
    '查询操作参数：{"action":"schema","name":"操作名"}。参数不确定就先查，不要猜。',
    '最终答复：{"action":"final","text":"给用户的中文答复"}。只有任务完成或已如实报告真实阻碍时才 final。',
    '【格式】每条回复只能是单个有效 JSON 对象，禁止 Markdown 代码围栏，禁止 JSON 以外的任何文字。',
    '【示范】',
    '控制器：【当前任务】用 jisuan_shijian 取一次本机时间再告诉我。',
    '你：{"action":"tool","name":"jisuan_shijian","arguments":{}}',
    '控制器：【SpCode 工具 jisuan_shijian 的实际返回】工具返回：本机时间字符串 2026-11-03T15:40:00+08:00',
    '你：{"action":"final","text":"2026-11-03T15:40:00+08:00"}',
    '【本轮可申请的 SpCode 操作】',
    toolCatalog(tools)
  ].join('\n');
  const firstMessage = [
    session.marker,
    rules,
    systemContext ? `【SpCode 当前规则与上下文】\n${systemContext}` : '',
    firstPrefix ? `【最近的对话记录】\n${firstPrefix}` : '',
    `【当前任务】\n${turnText || ''}`
  ].filter(Boolean).join('\n\n');

  activeRuns += 1;
  try {
    onEvent({ type: 'status', text: 'Codex 五小时额度已耗尽，官方聊天模式继续执行…' });
    let reply = await exchange(session, first ? firstMessage : `【用户新一轮任务】\n${turnText || ''}`, signal);
    const called = new Set();
    let malformed = 0;
    let missedRequired = 0;
    while (true) {
      checkAbort(signal);
      let action;
      try {
        action = parseAction(reply);
      } catch (error) {
        malformed++;
        if (malformed > 2) throw new Error(`聊天工具协议连续解析失败：${error.message}`);
        reply = await exchange(session, `上条回复无法按 JSON 工具协议解析：${error.message}。请仅重新输出一个完整 JSON 动作。`, signal);
        continue;
      }
      malformed = 0;
      if (action.action === 'schema') {
        const definition = findTool(tools, String(action.name || ''));
        const result = definition
          ? JSON.stringify({ name: definition.name, description: definition.description, parameters: definition.parameters })
          : `当前轮没有开放工具 ${String(action.name || '')}`;
        reply = await exchange(session, `【SpCode 工具参数定义】\n${result}\n请继续输出下一个 JSON 动作。`, signal);
        continue;
      }
      if (action.action === 'tool') {
        const name = String(action.name || '');
        if (!findTool(tools, name)) {
          reply = await exchange(session, `当前轮没有开放工具 ${name}。请查看工具清单，再输出 JSON 动作。`, signal);
          continue;
        }
        if (!action.arguments || typeof action.arguments !== 'object' || Array.isArray(action.arguments)) {
          reply = await exchange(session, `工具 ${name} 缺少 JSON 对象参数，请先用 schema 查询定义。`, signal);
          continue;
        }
        onEvent({ type: 'status', text: `聊天模式正在调用 ${name}` });
        const result = await runTool(name, action.arguments, crypto.randomUUID());
        called.add(name);
        const actualText = toolText(result);
        reply = await exchange(session, `【SpCode 工具 ${name} 的实际返回】\n${actualText}\n根据真实结果继续，只输出下一个 JSON 动作。`, signal);
        continue;
      }
      if (typeof action.text !== 'string') {
        reply = await exchange(session, 'final 动作缺少 text 字符串。请重新输出完整 JSON。', signal);
        continue;
      }
      const required = (requiredToolNames || []).map(String).filter(Boolean);
      if (required.length && !required.some(function used(name) { return called.has(name); })) {
        missedRequired++;
        if (missedRequired > 2) throw new Error('聊天模式未执行本轮必须使用的 SpCode 工具');
        reply = await exchange(session, `本轮必须完成的操作是 ${required.join('、')}，只有控制器能执行它。请提交申请单：{"action":"tool","name":"${required[0]}","arguments":{}}，参数不确定时先输出 {"action":"schema","name":"${required[0]}"}。你不是执行者，不需要声称执行过，也不需要提供结果；提交后控制器会把真实输出发给你。`, signal);
        continue;
      }
      onEvent({ type: 'rewrite_text', text: action.text });
      return { content: action.text, reasoning: '' };
    }
  } finally {
    activeRuns = Math.max(0, activeRuns - 1);
    if (signal?.aborted) {
      try { await runUi({ action: 'stop' }); }
      catch (error) { /* 用户已停止，界面可能早已结束生成。 */ }
    }
  }
}

/** 串行执行官方客户端的聊天回合，避免多个 SpCode 标签同时写入同一界面。 */
function runTurn(args) {
  function execute() { return performTurn(args); }
  const task = queue.then(execute, execute);
  function continueQueue() {}
  queue = task.then(continueQueue, continueQueue);
  return task;
}

module.exports = { runTurn, closeSession, closeIdle, busy, runUi, parseAction };
