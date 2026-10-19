// Cursor 模型适配：SpCode 的大脑 / 规划 / 代码 / 总结流水线不变，只把「调模型」这一步交给 Cursor SDK。
// Cursor 自带工具全部关掉（tools: []），模型只回文字；工具调用写成 <tool_call>{...}</tool_call>，
// 由 tool-xml 解析成 tool_calls 后照常交给 SpCode 自己执行
const fs = require('fs');
const os = require('os');
const path = require('path');

const CURSOR_PROTOCOL = 'cursor';
const CURSOR_BASE_URL = 'cursor://sdk';
const MAX_IMAGES = 8;

let sdkMod = null;
function sdk() {
  if (!sdkMod) sdkMod = require('@cursor/sdk');
  return sdkMod;
}

// 模型跑在空目录里：就算后端多给了工具，也碰不到用户项目。按进程分目录，SDK 的对话库也就按进程分开，多开时互不占用
const SANDBOX_PREFIX = 'spcode-cursor-sandbox';
function sandboxDir() {
  const dir = path.join(os.tmpdir(), `${SANDBOX_PREFIX}-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function apiKeyOf(modelCfg) {
  return String(modelCfg?.apiKey || '').trim() || undefined;
}

// SDK 默认的 SQLite 对话库在本机写不进去（unable to open database file），一轮答完就卡住、被自动重试整轮重答。
// 换成自己的内存对话库并关掉自动重试后 run 能正常结束、同一会话可以连续用。
// storeRoot 下是以前 JSONL 存储按进程留下的目录，只剩清理用途
function storeRoot() {
  try {
    return path.join(require('electron').app.getPath('userData'), 'cursor-agent-store');
  } catch {
    return path.join(os.tmpdir(), 'spcode-cursor-agent-store');
  }
}

let memStore = null;
function agentStore() {
  if (!memStore) memStore = require('./cursor-store').createMemoryStore(sdk());
  return memStore.store;
}

/** Agent 关掉后释放它在对话库里的记录；稍等再删，免得 SDK 收尾时还在写 */
function releaseAgent(agent) {
  const id = agent && agent.agentId;
  try { agent.close(); } catch { /* 已关闭 */ }
  if (id && memStore) setTimeout(() => memStore.dropAgent(id), 30000).unref?.();
}

function pidAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// 会话不跨进程复用，已退出进程留下的记录直接删
function clearStaleStores() {
  const root = storeRoot();
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return; }
  for (const d of dirs) {
    if (d === String(process.pid) || (/^\d+$/.test(d) && pidAlive(d))) continue;
    try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch { /* 删不掉下次再清 */ }
  }
}

/** Agent.create 的 local 选项：不加载 Cursor 自己的规则 / 技能 / AGENTS.md */
function localOptions(cwd, extra) {
  return { cwd, settingSources: [], enableAgentRetries: false, store: agentStore(), ...(extra || {}) };
}

// 没填 Key 时用 SDK 浏览器登录，凭据由 SDK 存在 ~/.cursor/sdk/auth.json
async function ensureLogin(modelCfg) {
  if (apiKeyOf(modelCfg)) return;
  const { Cursor } = sdk();
  const st = await Cursor.auth.status();
  if (st.status === 'logged-in') return;
  await Cursor.auth.login({
    apiKeyName: 'SpCode',
    openBrowser: (url) => require('electron').shell.openExternal(url)
  });
}

async function listModels(modelCfg) {
  await ensureLogin(modelCfg);
  const rows = await sdk().Cursor.models.list({ apiKey: apiKeyOf(modelCfg) });
  const models = [];
  const catalog = Object.create(null);
  for (const m of rows || []) {
    if (!m?.id || catalog[m.id]) continue;
    models.push(m.id);
    catalog[m.id] = { id: m.id, name: m.displayName || m.id, priceText: m.displayName || '', input: null, output: null };
  }
  return { ok: true, protocol: CURSOR_PROTOCOL, models, catalog, balance: { available: false } };
}

function partsText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content == null ? '' : String(content);
  return content.map((p) => (p && (p.type === 'text' || typeof p.text === 'string') ? p.text || '' : '')).join('');
}

function partsImages(content) {
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const p of content) {
    const url = p?.type === 'image_url' ? (p.image_url?.url || p.image_url) : '';
    const m = /^data:([^;]+);base64,(.+)$/s.exec(String(url || ''));
    if (m) out.push({ data: m[2], mimeType: m[1] });
    else if (/^https?:\/\//i.test(String(url || ''))) out.push({ url: String(url) });
  }
  return out;
}

function toolProtocolText(tools) {
  const list = (tools || []).map((t) => t?.function || t).filter((f) => f && f.name);
  if (!list.length) return '';
  const specs = list.map((f) => `- ${f.name}：${String(f.description || '').trim()}\n  参数 JSON Schema：${JSON.stringify(f.parameters || {})}`).join('\n');
  return [
    '## 工具调用协议（必须遵守）',
    '你没有原生工具接口。需要调用工具时，在回复里每个调用单独写一行：',
    '<tool_call>{"name":"工具名","arguments":{参数对象}}</tool_call>',
    '- arguments 必须是合法 JSON，字段按下面的 Schema 填写。',
    '- 一次回复可以写多条互不依赖的调用；写完调用就停止输出，等待工具结果，禁止自己编造结果。',
    '- 不需要工具时直接用正文回答，不要写 <tool_call>。',
    '',
    '可用工具：',
    specs
  ].join('\n');
}

function toolCallLines(tcs) {
  return (tcs || []).map((tc) => {
    let args = tc?.function?.arguments ?? '{}';
    if (typeof args !== 'string') args = JSON.stringify(args);
    return `<tool_call>{"name":${JSON.stringify(tc?.function?.name || '')},"arguments":${args || '{}'}}</tool_call>`;
  }).join('\n');
}

/** OpenAI 风格消息 → { system, transcript, images }：多轮对话压成一段文字，保持原有顺序 */
function flatten(messages, tools) {
  const sys = [];
  const blocks = [];
  let images = [];
  for (const m of messages || []) {
    if (!m) continue;
    if (m.role === 'system') {
      sys.push(partsText(m.content));
    } else if (m.role === 'user') {
      blocks.push(`[用户]\n${partsText(m.content)}`);
      images = images.concat(partsImages(m.content));
    } else if (m.role === 'assistant') {
      const body = [partsText(m.content), toolCallLines(m.tool_calls)].filter((s) => s && s.trim()).join('\n');
      blocks.push(`[助手]\n${body}`);
    } else if (m.role === 'tool') {
      blocks.push(`[工具结果 ${m.name || ''} ${m.tool_call_id || ''}]\n${partsText(m.content)}`);
    }
  }
  const proto = toolProtocolText(tools);
  return {
    system: [sys.join('\n\n'), proto].filter(Boolean).join('\n\n'),
    transcript: `${blocks.join('\n\n')}\n\n[轮到你]\n以助手身份继续，只写这一步的回复。`,
    images: images.slice(-MAX_IMAGES)
  };
}

// 一轮答完（turn-ended）就收单，不等 run 的收尾；写完工具调用后停笔这么久也收单，不等它重复调用
const TOOL_CALL_IDLE_MS = 800;
const TOOL_CALL_RE = /<tool_call>[\s\S]*?<\/tool_call>/g;

// 截到第一次出现重复调用之前；没有重复返回 null
function cutAtRepeat(content) {
  const seen = new Set();
  for (const m of content.matchAll(TOOL_CALL_RE)) {
    const key = m[0].replace(/\s+/g, '');
    if (seen.has(key)) return content.slice(0, m.index);
    seen.add(key);
  }
  return null;
}

function trimAfterLastCall(content) {
  const end = content.lastIndexOf('</tool_call>');
  return end < 0 ? content : content.slice(0, end + '</tool_call>'.length);
}

async function complete({ modelCfg, messages, tools, onDelta, onReason, signal }) {
  if (!modelCfg?.model) throw new Error('请选择 Cursor 模型');
  await ensureLogin(modelCfg);
  const emit = onDelta || (() => {});
  const emitReason = onReason || (() => {});
  const { system, transcript, images } = flatten(messages, tools);
  // 服务端不认 systemPrompt（unknown option '--system-prompt'），系统提示并进正文
  const text = system ? `[系统]\n${system}\n\n${transcript}` : transcript;
  const { Agent } = sdk();
  const agent = await Agent.create({
    apiKey: apiKeyOf(modelCfg),
    model: { id: String(modelCfg.model) },
    tools: [],
    name: 'SpCode',
    local: localOptions(sandboxDir())
  });
  let content = '';
  let reasoning = '';
  let run = null;
  let collected = false;
  let idleTimer = null;
  let markCollected;
  const collectedP = new Promise((r) => { markCollected = r; });
  const cancelRun = () => { if (run && run.supports('cancel')) run.cancel().catch(() => {}); };
  // 收单后 run.wait() 不一定返回，所以靠 collectedP 结束等待
  const collect = () => {
    if (collected) return;
    collected = true;
    clearTimeout(idleTimer);
    cancelRun();
    markCollected({ status: 'collected' });
  };
  const onAbort = () => { cancelRun(); markCollected({ status: 'aborted' }); };
  try {
    run = await agent.send(images.length ? { text, images } : text, {
      onDelta: ({ update }) => {
        if (collected) return;
        if (update?.type === 'turn-ended') {
          collect();
        } else if (update?.type === 'text-delta' && update.text) {
          content += update.text;
          emit(update.text);
          if (!content.includes('</tool_call>')) return;
          const cut = cutAtRepeat(content);
          if (cut != null) {
            content = cut;
            collect();
            return;
          }
          clearTimeout(idleTimer);
          idleTimer = setTimeout(collect, TOOL_CALL_IDLE_MS);
        } else if (update?.type === 'thinking-delta' && update.text) {
          reasoning += update.text;
          emitReason(update.text);
        }
      }
    });
    if (collected) cancelRun();
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
    const res = await Promise.race([run.wait(), collectedP]);
    if (signal?.aborted) {
      const err = new Error('已停止');
      err.name = 'AbortError';
      throw err;
    }
    if (collected) content = trimAfterLastCall(content);
    else if (res.status !== 'finished') {
      throw new Error(`Cursor 模型「${modelCfg.model}」没有完成：${res.error?.message || res.status}`);
    }
    if (!content && res.result) content = String(res.result);
    return { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) };
  } finally {
    clearTimeout(idleTimer);
    if (signal) signal.removeEventListener('abort', onAbort);
    releaseAgent(agent);
  }
}

// SDK 把每次调用的完整对话存进 ~/.cursor/projects/<沙盒目录>/sdk-agent-store，SpCode 不复用这些记录，
// 不清会无限增长（测试一小时就到 100MB）。启动预热时清掉别的进程留下的库，还在用的会删除失败、留到下次
function clearAgentStore() {
  const root = path.join(os.homedir(), '.cursor', 'projects');
  const mine = `${SANDBOX_PREFIX}-${process.pid}`;
  let dirs = [];
  try { dirs = fs.readdirSync(root); } catch { return; }
  for (const d of dirs) {
    if (!d.includes(SANDBOX_PREFIX) || d.endsWith(mine)) continue;
    try { fs.rmSync(path.join(root, d), { recursive: true, force: true }); } catch { /* 被占用就下次再清 */ }
  }
}

// 进程里第一次建 Agent + 第一次 send 合计要多等约 8 秒，之后几乎为 0；启动时先空跑一次，发出去立刻取消。
// 没登录也没填 Key 时跳过，启动阶段不弹浏览器
let warmed = null;
function warmUp(modelCfg) {
  if (warmed) return warmed;
  warmed = (async () => {
    const t0 = Date.now();
    clearAgentStore();
    clearStaleStores();
    if (!apiKeyOf(modelCfg)) {
      const st = await sdk().Cursor.auth.status();
      if (st.status !== 'logged-in') return { skipped: 'not-logged-in' };
    }
    const agent = await sdk().Agent.create({
      apiKey: apiKeyOf(modelCfg),
      model: { id: String(modelCfg?.model || 'default') },
      tools: [],
      name: 'SpCode',
      local: localOptions(sandboxDir())
    });
    try {
      const run = await agent.send('.');
      if (run.supports('cancel')) await run.cancel().catch(() => {});
    } finally {
      releaseAgent(agent);
    }
    return { ms: Date.now() - t0 };
  })().catch((e) => ({ error: e?.message || String(e) }));
  return warmed;
}

module.exports = {
  CURSOR_PROTOCOL, CURSOR_BASE_URL, complete, listModels, ensureLogin, flatten, warmUp,
  sdk, apiKeyOf, localOptions, sandboxDir, releaseAgent
};
