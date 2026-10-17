// Cursor 直通：提示词、技能、工具全用 SpCode 的，只把「多轮调工具」的循环交给 Cursor Agent 的连续会话。
// Cursor 自带工具全部关掉，只开 MCP 通道；SpCode 的工具注册成 customTools，在本进程里执行
const cursorModel = require('./cursor-model');
const diag = require('./diag');

const MAX_SESSIONS = 8;
// 本轮结束后 run 迟迟不收尾时最多再等这么久，然后丢掉这个会话
const RUN_SETTLE_MS = 15000;
const STALL_MS = 5 * 60 * 1000;
const MAX_IMAGES = 8;

/** key → { agent, sig, model, workspace, ctx } ；ctx 是本轮的执行上下文，工具回调从这里取 */
const sessions = new Map();
let activeRuns = 0;
function busy() {
  return activeRuns > 0;
}

function closeSession(key) {
  const s = sessions.get(key);
  if (!s) return;
  sessions.delete(key);
  cursorModel.releaseAgent(s.agent);
}

// 配置里已经没有角色用 Cursor 模型时调用：把还留着的直通会话全断掉，别在 Cursor 那边一直挂着。
// 有一轮正在跑时不动，免得把进行中的直通打断（下一轮结束后由配置变更或模型判断再收）
function closeIdle() {
  if (activeRuns > 0) return 0;
  const keys = [...sessions.keys()];
  for (const key of keys) closeSession(key);
  return keys.length;
}

function toolResultText(result) {
  if (result == null) return '';
  return typeof result === 'string' ? result : JSON.stringify(result);
}

function buildCustomTools(tools, session) {
  const out = {};
  for (const f of tools || []) {
    if (!f || !f.name) continue;
    out[f.name] = {
      description: String(f.description || ''),
      inputSchema: f.parameters || { type: 'object', properties: {} },
      execute: async (args, context) => {
        const ctx = session.ctx;
        if (!ctx) return { content: [{ type: 'text', text: '本轮已结束，工具没有执行。' }], isError: true };
        try {
          const text = toolResultText(await ctx.runTool(f.name, args || {}, context?.toolCallId || ''));
          return { content: [{ type: 'text', text }] };
        } catch (e) {
          return { content: [{ type: 'text', text: `工具失败：${e?.message || e}` }], isError: true };
        }
      }
    };
  }
  return out;
}

function imagesOf(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    const url = p?.type === 'image_url' ? (p.image_url?.url || p.image_url) : '';
    const m = /^data:([^;]+);base64,(.+)$/s.exec(String(url || ''));
    if (m) out.push({ data: m[2], mimeType: m[1] });
  }
  return out.slice(-MAX_IMAGES);
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((p) => (p && typeof p.text === 'string' ? p.text : '')).join('');
}

function abortError() {
  const err = new Error('已停止');
  err.name = 'AbortError';
  return err;
}

/** 用户点停止时不等 Cursor 回应，p 还在跑也立刻抛出已停止 */
function untilAbort(p, signal) {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(abortError());
  let onAbort;
  const stop = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([p, stop]).finally(() => signal.removeEventListener('abort', onAbort));
}

/**
 * 跑一轮。会话按 key 复用；sig（模型、项目、技能、规则等）变了或 fresh 为真时新开会话，
 * 新会话的第一条消息带上 firstPrefix（SpCode 系统提示 + 之前对话），之后每轮只发本轮内容。
 */
async function runTurn({ key, sig, fresh, modelCfg, workspace, firstPrefix, turnText, userContent, tools, runTool, onEvent, signal }) {
  await untilAbort(cursorModel.ensureLogin(modelCfg), signal);
  let session = sessions.get(key);
  if (session && (fresh || session.sig !== sig)) {
    closeSession(key);
    session = null;
  }
  const isNew = !session;
  if (isNew) {
    session = { sig, ctx: null, agent: null };
    const { Agent } = cursorModel.sdk();
    // 模型进程只放空目录。cwd 若是整个 Unity 工程，Agent.create 会去扫盘，十几分钟没有任何输出
    const cwd = cursorModel.sandboxDir();
    onEvent({ type: 'status', text: '正在接通 Cursor 直通…' });
    diag.log('cursor', 'Cursor 直通开始建会话', { model: modelCfg.model, cwd, 工具数: (tools || []).length });
    const created = Agent.create({
      apiKey: cursorModel.apiKeyOf(modelCfg),
      model: { id: String(modelCfg.model) },
      tools: ['mcp'],
      name: 'SpCode',
      local: cursorModel.localOptions(cwd, {
        customTools: buildCustomTools(tools, session)
      })
    });
    try {
      session.agent = await untilAbort(created, signal);
    } catch (e) {
      if (e.name === 'AbortError') created.then((a) => cursorModel.releaseAgent(a), () => {});
      throw e;
    }
    sessions.set(key, session);
    while (sessions.size > MAX_SESSIONS) closeSession(sessions.keys().next().value);
  }
  onEvent({ type: 'think', text: isNew ? 'Cursor 直通：新开会话，已带上 SpCode 规则' : 'Cursor 直通：沿用本对话的会话' });

  const text = isNew ? `${firstPrefix}\n\n${turnText}` : turnText;
  const images = imagesOf(userContent);
  let content = '';
  let reasoning = '';
  let sendText = text;
  let sendImages = images;
  session.ctx = { runTool };
  activeRuns += 1;
  const transient = (message) => /stalled|ECONNRESET|socket|network|timeout|timed out/i.test(String(message || ''));
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let ended = false;
      let lastAt = Date.now();
      let run = null;
      const cancelRun = () => { if (run && run.supports('cancel')) run.cancel().catch(() => {}); };
      const onAbort = () => cancelRun();
      let stallTimer = null;
      let sending = null;
      try {
        sending = session.agent.send(sendImages.length ? { text: sendText, images: sendImages } : sendText, {
          onDelta: ({ update }) => {
            lastAt = Date.now();
            if (update?.type === 'text-delta' && update.text) {
              content += update.text;
              onEvent({ type: 'text', text: update.text });
            } else if (update?.type === 'thinking-delta' && update.text) {
              reasoning += update.text;
              onEvent({ type: 'reason', text: update.text });
            } else if (update?.type === 'turn-ended') {
              ended = true;
            }
          }
        });
        run = await untilAbort(sending, signal);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener('abort', onAbort, { once: true });
        }
        let stalled = false;
        const stallP = new Promise((resolve) => {
          stallTimer = setInterval(() => {
            const idle = Date.now() - lastAt;
            if ((ended && idle > RUN_SETTLE_MS) || idle > STALL_MS) {
              stalled = true;
              resolve({ status: ended ? 'finished' : 'stalled' });
            }
          }, 1000);
        });
        const res = await untilAbort(Promise.race([run.wait(), stallP]), signal);
        if (signal?.aborted) throw abortError();
        if (stalled) {
          diag.log('cursor', 'Cursor 直通 run 没有正常收尾', { ended, status: res.status, attempt });
          cancelRun();
          if (ended) return { content, reasoning };
          if (attempt < 2) {
            onEvent({ type: 'status', text: 'Cursor 连接中断，正在接上…' });
            sendText = '连接中断了。按已经完成的工具结果继续，不要重做已经成功的步骤。';
            sendImages = [];
            continue;
          }
          closeSession(key);
          throw new Error(`Cursor 模型「${modelCfg.model}」超过 ${Math.round(STALL_MS / 60000)} 分钟没有新内容，已中断。`);
        } else if (res.status !== 'finished') {
          const message = res.error?.message || res.status || '';
          if (transient(message) && attempt < 2) {
            diag.log('cursor', 'Cursor 直通连接中断，同一会话重试', { attempt, message });
            onEvent({ type: 'status', text: 'Cursor 连接中断，正在接上…' });
            sendText = '连接中断了。按已经完成的工具结果继续，不要重做已经成功的步骤。';
            sendImages = [];
            continue;
          }
          closeSession(key);
          throw new Error(`Cursor 模型「${modelCfg.model}」没有完成：${message}`);
        }
        if (!content && res.result) content = String(res.result);
        return { content, reasoning };
      } catch (e) {
        if (signal?.aborted || e.name === 'AbortError') {
          // 停止后这个会话可能还在收尾，丢掉它，下一轮新开会话
          if (run) cancelRun();
          else if (sending) sending.then((r) => { if (r && r.supports('cancel')) r.cancel().catch(() => {}); }, () => {});
          closeSession(key);
          throw abortError();
        }
        if (transient(e.message) && attempt < 2) {
          diag.log('cursor', 'Cursor 直通连接中断，同一会话重试', { attempt, message: e.message });
          onEvent({ type: 'status', text: 'Cursor 连接中断，正在接上…' });
          sendText = '连接中断了。按已经完成的工具结果继续，不要重做已经成功的步骤。';
          sendImages = [];
          continue;
        }
        closeSession(key);
        throw e;
      } finally {
        clearInterval(stallTimer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
    closeSession(key);
    throw new Error(`Cursor 模型「${modelCfg.model}」没有完成：Connection stalled`);
  } finally {
    activeRuns = Math.max(0, activeRuns - 1);
    if (session) session.ctx = null;
  }
}

module.exports = { runTurn, closeSession, closeIdle, textOf, busy };
