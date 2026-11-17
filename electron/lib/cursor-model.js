// Cursor 模型适配：SpCode 的大脑 / 规划 / 代码 / 总结流水线不变，只把「调模型」这一步交给 Cursor SDK。
// Cursor 自带工具全部关掉（tools: []），模型只回文字；工具调用写成 <tool_call>{...}</tool_call>，
// 由 tool-xml 解析成 tool_calls 后照常交给 SpCode 自己执行
const fs = require('fs');
const os = require('os');
const path = require('path');

const CURSOR_PROTOCOL = 'cursor';
const CURSOR_BASE_URL = 'cursor://sdk';
const MAX_IMAGES = 8;
// 缓存参数目录，避免每次规划/总结都重新请求；按登录凭据隔离。
const modelParameterCache = new Map();
const modelParameterPending = new Map();
const MODEL_PARAMETER_CACHE_MS = 5 * 60 * 1000;
// Cursor 按网络出口地区拒绝某些模型厂商；SDK 没有专门的错误码，只能认错误原文
const REGION_BLOCK_RE = /not supported in your region|not available in your region|cursor\.com\/docs\/account\/regions/i;
// 新用量池挂在 Pro 上。SDK 把免费账号的本地会话也判成 Cloud Agent，原文里没有单独错误码
const PLAN_REQUIRED_RE = /plan_required|not available for free users|upgrade to Pro/i;
// 套餐用量走 Cursor 后台的非公开接口（SDK 没有账号额度接口），改版后会失效，失效时显示额度未知
const USAGE_URL = 'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage';
const USAGE_CACHE_MS = 30 * 1000;
let usageCache = null;
let usageCacheAt = 0;
let usageInFlight = null;

/** SpCode 设置里的网络代理，规范成 http://host:port；没填返回空 */
function configuredProxy() {
  let proxy = '';
  try { proxy = String(require('./store').load()?.proxy || '').trim(); } catch { return ''; }
  if (!proxy) return '';
  try {
    const url = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    return `${url.protocol}//${url.host}`;
  } catch {
    return '';
  }
}

// 设置里写了代理，但代理软件没开时，连上去会 ECONNREFUSED。先探一下端口，没在听就保持直连。
// 探测放在子线程里：主线程一旦 Atomics.wait，自己的 socket 回调就跑不了
function proxyListening(proxy) {
  let url;
  try { url = new URL(proxy); } catch { return false; }
  const port = Number(url.port);
  if (!port) return false;
  const sab = new SharedArrayBuffer(4);
  const flag = new Int32Array(sab);
  const { Worker } = require('worker_threads');
  const worker = new Worker(
    `const { workerData } = require('worker_threads');
     const net = require('net');
     const flag = new Int32Array(workerData.sab);
     const socket = net.connect({ host: workerData.host, port: workerData.port });
     const done = (ok) => {
       if (Atomics.compareExchange(flag, 0, 0, ok ? 1 : 2) === 0) Atomics.notify(flag, 0);
       socket.destroy();
     };
     socket.once('connect', () => done(true));
     socket.once('error', () => done(false));
     socket.setTimeout(400, () => done(false));`,
    { eval: true, workerData: { host: url.hostname, port, sab } }
  );
  try { Atomics.wait(flag, 0, 0, 500); } catch { /* 主线程不能等待时当作代理没开 */ }
  worker.terminate();
  return Atomics.load(flag, 0) === 1;
}

// 启动时代理没开会一直直连，直连 api2.cursor.sh 在这里会超时，SDK 只报 [unavailable]。
// 每轮重新看端口：开了就切到代理。Node 的 fetch 不认 https.globalAgent，要同时写环境变量。
let cursorRoute = '';
let savedProxyEnv = null;
function refreshCursorRoute(mod) {
  const proxy = configuredProxy();
  const up = !!(proxy && proxyListening(proxy));
  const next = up ? proxy : '';
  if (next === cursorRoute) return next ? 'proxy' : 'direct';
  const sdkMod = mod || sdk();
  if (savedProxyEnv == null) {
    savedProxyEnv = {
      HTTPS_PROXY: process.env.HTTPS_PROXY,
      HTTP_PROXY: process.env.HTTP_PROXY,
      NODE_USE_ENV_PROXY: process.env.NODE_USE_ENV_PROXY
    };
  }
  const https = require('https');
  const http = require('http');
  if (up) {
    process.env.HTTPS_PROXY = proxy;
    process.env.HTTP_PROXY = proxy;
    process.env.NODE_USE_ENV_PROXY = '1';
    const env = { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, NO_PROXY: 'localhost,127.0.0.1,::1' };
    https.globalAgent = new https.Agent({ keepAlive: true, proxyEnv: env });
    http.globalAgent = new http.Agent({ keepAlive: true, proxyEnv: env });
    try { sdkMod.Cursor.configure({ local: { useHttp1ForAgent: true } }); } catch { /* 旧 SDK 没有这个开关 */ }
    // 换 Key 用的是全局 fetch。只改环境变量时，已经初始化过的 fetch 仍会直连。
    try {
      const undici = require('undici');
      undici.setGlobalDispatcher(new undici.ProxyAgent(proxy));
    } catch (e) {
      require('./diag').log('cursor', 'fetch 代理设置失败', { message: e && e.message });
    }
    require('./diag').log('cursor', 'Cursor 直通改走网络代理', { proxy });
  } else {
    for (const key of Object.keys(savedProxyEnv)) {
      if (savedProxyEnv[key] == null) delete process.env[key];
      else process.env[key] = savedProxyEnv[key];
    }
    https.globalAgent = new https.Agent({ keepAlive: true });
    http.globalAgent = new http.Agent({ keepAlive: true });
    try {
      const undici = require('undici');
      undici.setGlobalDispatcher(new undici.Agent());
    } catch { /* 没有 undici 时沿用默认 fetch */ }
    require('./diag').log('cursor', '网络代理没开，Cursor 改为直连', { proxy: proxy || '' });
  }
  cursorRoute = next;
  return next ? 'proxy' : 'direct';
}

let sdkMod = null;
function sdk() {
  if (!sdkMod) {
    const mod = require('@cursor/sdk');
    try { refreshCursorRoute(mod); } catch (e) { require('./diag').log('cursor', 'Cursor SDK 设置代理失败', { message: e && e.message }); }
    sdkMod = mod;
  }
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

/** 地区限制属于永久性错误，重试或发「继续」都没用；是这类错误时返回给用户看的中文错误，否则返回 null */
function regionError(model, message) {
  if (!REGION_BLOCK_RE.test(String(message || ''))) return null;
  const err = new Error(`Cursor 模型「${model}」在当前地区不可用（Cursor 按网络出口地区限制该模型厂商），请换用其它模型或更换网络出口。`);
  err.code = 'cursor_region_blocked';
  return err;
}

/** 本轮失败时统一出错：地区限制给中文说明，其它照旧带上原文 */
function runError(model, message) {
  return regionError(model, message) || new Error(`Cursor 模型「${model}」没有完成：${message}`);
}

function cursorStateDb() {
  const home = os.homedir();
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

/** 只读取本机 Cursor 编辑器的登录令牌，只留在内存里，不落盘、不写日志 */
function readCursorState(key) {
  const file = cursorStateDb();
  if (!fs.existsSync(file)) return '';
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(key);
    return row ? String(row.value || '').trim() : '';
  } finally {
    db.close();
  }
}

function readEditorToken() {
  return readCursorState('cursorAuth/accessToken');
}

/** 编辑器里已登录的账号。新用量池在这个 Pro 账号上，不读令牌 */
function editorAccountEmail() {
  return readCursorState('cursorAuth/cachedEmail');
}

function isPlanRequired(message) {
  return PLAN_REQUIRED_RE.test(String(message || ''));
}

function poolAccountError({ sdkEmail = '', editorEmail = '', hasApiKey = false, opened = false } = {}) {
  const editor = editorEmail || editorAccountEmail();
  const target = editor ? `「${editor}」` : 'Cursor 编辑器里已开通 Pro 的账号';
  const text = hasApiKey
    ? `Cursor 服务商里填的 Key 没有 Pro，用不上新的用量池。请换成 ${target} 的 Key。`
    : `Cursor 直通登录的是${sdkEmail ? `「${sdkEmail}」` : '当前账号'}，这个账号没有 Pro，用不上新的用量池。${opened ? '浏览器已打开，' : ''}请改登 ${target}，登完后再发一次。`;
  const err = new Error(text);
  err.code = 'cursor_plan_required';
  return err;
}

let reloginPromise = null;
/** 退出当前 SDK 登录并打开浏览器。同一时间只进行一次，凭据仍只写在 SDK 自己的登录文件里 */
function beginRelogin() {
  if (reloginPromise) return reloginPromise;
  const { Cursor } = sdk();
  reloginPromise = (async () => {
    try { await Cursor.auth.logout(); } catch { /* 本来就没登录 */ }
    return Cursor.auth.login({
      apiKeyName: 'SpCode',
      openBrowser: (url) => require('electron').shell.openExternal(url)
    });
  })().finally(() => { reloginPromise = null; });
  return reloginPromise;
}

/** 本计费周期剩余百分比，口径同 Cursor 设置页：已用 ÷ 套餐上限 */
async function readPlanRemaining() {
  const token = readEditorToken();
  if (!token) return null;
  const { httpFetch } = require('./http-fetch');
  const res = await httpFetch(USAGE_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) return null;
  const plan = (await res.json())?.planUsage;
  const limit = Number(plan?.limit);
  const used = Number(plan?.totalSpend);
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(used)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - (used / limit) * 100)));
}

/** 取不到百分比（接口失效、编辑器未登录）时显示额度未知，不抛错，免得挡住模型列表 */
async function fetchUsageBalance() {
  if (usageCache && Date.now() - usageCacheAt < USAGE_CACHE_MS) return usageCache;
  if (usageInFlight) return usageInFlight;
  usageInFlight = (async () => {
    let remaining = null;
    try { remaining = await readPlanRemaining(); } catch { /* 按额度未知显示 */ }
    usageCache = { available: true, kind: 'rate-limits', text: remaining == null ? '额度未知' : `本月剩余 ${remaining}%` };
    usageCacheAt = Date.now();
    return usageCache;
  })();
  try { return await usageInFlight; }
  finally { usageInFlight = null; }
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
  refreshCursorRoute();
  if (apiKeyOf(modelCfg)) return;
  if (reloginPromise) await reloginPromise;
  const { Cursor } = sdk();
  const st = await Cursor.auth.status();
  const editorEmail = editorAccountEmail();
  const sdkEmail = st.status === 'logged-in' ? String(st.email || '') : '';
  // 直通账号和编辑器 Pro 不是同一个时，新用量池不在这个登录上
  if (st.status === 'logged-in' && editorEmail && sdkEmail && sdkEmail.toLowerCase() !== editorEmail.toLowerCase()) {
    require('./diag').log('cursor', '直通账号和编辑器 Pro 不是同一个，打开改登', { sdkEmail, editorEmail });
    beginRelogin();
    throw poolAccountError({ sdkEmail, editorEmail, opened: true });
  }
  if (st.status === 'logged-in') return;
  await Cursor.auth.login({
    apiKeyName: 'SpCode',
    openBrowser: (url) => require('electron').shell.openExternal(url)
  });
}

async function listModels(modelCfg) {
  await ensureLogin(modelCfg);
  const rows = await sdk().Cursor.models.list({ apiKey: apiKeyOf(modelCfg) });
  modelParameterCache.set(apiKeyOf(modelCfg) || '', { at: Date.now(), rows: rows || [] });
  const models = [];
  const catalog = Object.create(null);
  for (const m of rows || []) {
    if (!m?.id || catalog[m.id]) continue;
    models.push(m.id);
    catalog[m.id] = { id: m.id, name: m.displayName || m.id, priceText: m.displayName || '', input: null, output: null,
      reasoningOptions: reasoningOptionsOf(m) };
  }
  return { ok: true, protocol: CURSOR_PROTOCOL, models, catalog, balance: await fetchUsageBalance() };
}

/** 提取 Cursor 目录声明的推理选项，保留原始参数名和值，供普通请求和直通共用。 */
function reasoningOptionsOf(row) {
  const options = [];
  for (const param of row?.parameters || []) {
    if (!/reason|think|effort|推理|思考/i.test(`${param.id} ${param.displayName || ''}`)) continue;
    for (const choice of param.values || []) {
      options.push({ value: String(choice.value), label: choice.displayName || String(choice.value),
        params: [{ id: param.id, value: choice.value }] });
    }
  }
  for (const variant of row?.variants || []) {
    const params = [];
    for (const param of variant.params || []) {
      if (/reason|think|effort|推理|思考/i.test(param.id)) params.push(param);
    }
    if (!params.length) continue;
    const value = String(params[0].value);
    if (options.some(function sameOption(option) { return option.value === value; })) continue;
    options.push({ value, label: variant.displayName || value, params });
  }
  return options;
}

/**
 * 按用户保存的推理强度构造 Cursor 模型参数；空值表示厂商默认。
 * 从目录取原始参数名和值，档位失效直接报错，不替用户换档或换模型。
 */
async function highModelSelection(modelCfg) {
  const id = String(modelCfg?.model || 'default');
  if (!modelCfg.reasoningEffort) return { id };
  const key = apiKeyOf(modelCfg) || '';
  let cached = modelParameterCache.get(key);
  if (!cached || Date.now() - cached.at > MODEL_PARAMETER_CACHE_MS) {
    if (!modelParameterPending.has(key)) {
      const pending = listModels(modelCfg).finally(function clearPending() { modelParameterPending.delete(key); });
      modelParameterPending.set(key, pending);
    }
    await modelParameterPending.get(key);
    cached = modelParameterCache.get(key);
  }
  const row = cached.rows.find(function sameModel(model) { return model.id === id || model.aliases?.includes(id); });
  const choice = reasoningOptionsOf(row).find(function selected(option) { return option.value === modelCfg.reasoningEffort; });
  if (!choice) throw new Error('该模型目录不支持已选推理强度：' + modelCfg.reasoningEffort);
  return { id, params: choice.params };
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
    model: await highModelSelection(modelCfg),
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
      throw runError(modelCfg.model, res.error?.message || res.status);
    }
    if (!content && res.result) content = String(res.result);
    return { role: 'assistant', content, ...(reasoning ? { reasoning_content: reasoning } : {}) };
  } catch (e) {
    if (isPlanRequired(e?.message) || e?.code === 'cursor_plan_required') {
      if (!apiKeyOf(modelCfg)) beginRelogin();
      throw e?.code === 'cursor_plan_required' ? e : poolAccountError({ hasApiKey: !!apiKeyOf(modelCfg), opened: !apiKeyOf(modelCfg) });
    }
    throw regionError(modelCfg.model, e?.message) || e;
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
    refreshCursorRoute();
    if (!apiKeyOf(modelCfg)) {
      const st = await sdk().Cursor.auth.status();
      if (st.status !== 'logged-in') return { skipped: 'not-logged-in' };
    }
    const agent = await sdk().Agent.create({
      apiKey: apiKeyOf(modelCfg),
      model: await highModelSelection(modelCfg),
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
  sdk, apiKeyOf, localOptions, sandboxDir, releaseAgent, highModelSelection,
  regionError, runError, fetchUsageBalance, isPlanRequired, poolAccountError, beginRelogin, refreshCursorRoute
};
