const {
  app, BrowserWindow, ipcMain, dialog, nativeTheme, clipboard, shell, crashReporter, session, globalShortcut
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const store = require('./lib/store');
const snapshot = require('./lib/snapshot');
const agent = require('./lib/agent');
const skillsLib = require('./lib/skills');
const localLlm = require('./lib/local-llm');
const zbaingAi = require('./lib/zbaingAi');
const diag = require('./lib/diag');
const downloader = require('./lib/downloader');
const hardware = require('./lib/hardware');
const modelMeta = require('./lib/model-meta');
const assembly = require('./lib/assembly');
const { migrateUserData } = require('./lib/migrate-userdata');
const mmprojLib = require('./lib/mmproj');
const visionEngine = require('./lib/vision-engine');
const memory = require('./lib/memory');
const memoryGlobal = require('./lib/memory-global');
const apiProtocol = require('./lib/api-protocol');
const { applyProxy } = require('./lib/http-fetch');
const milestone = require('./lib/milestone');
const codeIndex = require('./lib/code-index');
const codeEmbed = require('./lib/code-embed');
const desktopHand = require('./lib/desktop-hand');
const contextPreview = require('./lib/context-preview');
const { createFloatBar } = require('./lib/float-bar');
const { parseAttachment, isDocumentExt } = require('./lib/media');
// 文件树、@ 搜索、预览都走这里。漏导入时列目录会抛错，侧栏被收成空目录
const {
  listTree, listChildren, readForPreview, SKIP,
  isAbsPath, extraRoots, resolveRead
} = require('./lib/workspace');
function listLocalFilesEnriched(dir) {
  return localLlm.listGguf(dir).map((f) => modelMeta.enrichFile(dir, f, { writeBack: true }));
}

/** 开发态=仓库根；打包后=userData/app-root（可写 skills/rules/persona） */
let APP_ROOT = path.join(__dirname, '..');
/** 代码/资源根（asar 内只读即可：图标、renderer） */
const CODE_ROOT = path.join(__dirname, '..');
const windows = new Set();
/** 常驻置顶悬浮对话栏（主进程持有，退出流程里 destroy） */
let floatBar = null;
/** 已建出来的小窗实例，广播时逐个推，单实例时也走这里 */
const floatBars = [];
/** 主窗身份编号：窗口 ↔ 编号双向表，会话键靠它找到该发给哪个窗口 */
let winSeq = 0;
const winIdByWin = new Map();
const winById = new Map();
/** 本进程占用的悬浮栏槽位号（多开进程时各占一个，免得小窗叠在一起） */
let mySlot = 1;
/** 全局快捷键是否注册成功：失败时小窗不给隐藏入口 */
let shortcutOk = false;
/** turnId -> { win, tabId }：这一轮属于哪个窗口的哪个标签页 */
const turnOwner = new Map();
/** winId -> Set<turnId>：哪些窗口还有轮次在跑（原全局 runningTurns 的按窗口版本） */
const runningByWin = new Map();
/** sessionKey -> 显示名，小窗的会话清单用 */
const sessionsByKey = new Map();
/** sessionKey -> { canStart, options }：能不能新起一轮，以及开始按钮可选的方案清单 */
const canStartByKey = new Map();
/** 小窗当前绑定的会话键 */
let boundKey = '';
/** 最近一次被主窗激活的会话键：小窗发空键时用它兜底 */
let lastActiveKey = '';
/** 窗口 -> 最近上报的标签页编号，can-start 不带 key 时靠它补出会话键 */
const lastTabIdByWin = new Map();
/** 小窗「开始」回调（由 registerFloatBarIpc 里的 startFromFloatBar 赋值） */
let floatBarStartHandler = null;
/** 小窗「绑定」回调（由 registerFloatBarIpc 里的 bindFromFloatBar 赋值） */
let floatBarBindHandler = null;
const workspaceByWin = new WeakMap();
/** win -> Map(turnId, AbortController) */
const abortByWin = new WeakMap();
/** win -> Map(turnId, { resolve, reject, ask }) */
const pendingAskByWin = new WeakMap();
const watchByWin = new WeakMap();

function abortMap(win) {
  let m = abortByWin.get(win);
  if (!m) {
    m = new Map();
    abortByWin.set(win, m);
  }
  return m;
}

function pendingAskMap(win) {
  let m = pendingAskByWin.get(win);
  if (!m) {
    m = new Map();
    pendingAskByWin.set(win, m);
  }
  return m;
}

// 视觉代理启动状态（主进程内记录，重启后重新按需启动）
let visionStarted = false;
let visionStartError = '';

function ensureAppRoot() {
  if (!app.isPackaged) {
    APP_ROOT = CODE_ROOT;
    return APP_ROOT;
  }
  const dest = path.join(app.getPath('userData'), 'app-root');
  const marker = path.join(dest, '.seeded');
  const src = path.join(process.resourcesPath, 'app-root');
  fs.mkdirSync(dest, { recursive: true });
  if (!fs.existsSync(marker)) {
    try {
      if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
    } catch (e) {
      diag.log('app', '种子 app-root 失败', { message: e && e.message });
    }
    fs.mkdirSync(path.join(dest, 'skills'), { recursive: true });
    fs.mkdirSync(path.join(dest, 'rules'), { recursive: true });
    try { fs.writeFileSync(marker, new Date().toISOString(), 'utf8'); } catch { /* ignore */ }
  }
  APP_ROOT = dest;
  return APP_ROOT;
}

function sessionDir() {
  return path.join(app.getPath('userData'), 'sessions');
}

function sendTo(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/** 会话键：窗口编号 + 标签页编号。拿不到窗口编号时给空串，小窗侧会丢弃这条 */
function makeSessionKey(win, tabId) {
  const wid = winIdByWin.get(win);
  if (!wid) return '';
  return wid + ':' + (tabId || '');
}

/** 一轮对应的会话键 */
function sessionKeyOfTurn(turnId) {
  const o = turnOwner.get(turnId);
  if (!o) return '';
  return makeSessionKey(o.win, o.tabId);
}

/**
 * 这一轮该记在哪个标签页上：先用渲染层报上来的 tabId，没报就回落到这个窗口上次上报的标签页。
 * 渲染层 sendOne 的载荷里没有 tabId，这里若直接取空串，事件键会算成「窗口N:」，
 * 跟小窗那边由 floatbar:bind-from-window 上报得到的「窗口N:真实tabId」永远不相等，
 * 小窗会一条事件都收不到、插话也进不了正在跑的那一轮，所以必须有这次兜底。
 */
function resolveTurnTabId(win, payload) {
  const raw = String((payload && payload.tabId) || '');
  if (raw) return raw;
  const last = win ? lastTabIdByWin.get(win) : '';
  return String(last || '');
}

/** 会话键长这样「3:tab-1」，用它前半段解析窗口编号，绝不猜「第一个窗口」 */
function looksLikeSessionKey(s) {
  return /^\d+:/.test(String(s == null ? '' : s));
}

/** 从会话键定位主窗；窗口已关或键非法都返回 null */
function winFromKey(key) {
  const raw = String(key == null ? '' : key);
  if (!looksLikeSessionKey(raw)) return null;
  const wid = Number(raw.split(':')[0]);
  if (!Number.isFinite(wid) || wid <= 0) return null;
  const win = winById.get(wid);
  if (!win || win.isDestroyed()) return null;
  return win;
}

/** 按 winId 记/删一轮的存活状态 */
function setTurnRunning(win, turnId, on) {
  const wid = winIdByWin.get(win);
  if (!wid) return;
  let s = runningByWin.get(wid);
  if (!s) {
    s = new Set();
    runningByWin.set(wid, s);
  }
  const id = turnId || '';
  if (on) s.add(id);
  else s.delete(id);
  if (!s.size) runningByWin.delete(wid);
}

/** 这个窗口还有没有轮次在跑（有就按插话处理，不新起一轮） */
function turnIsRunning(win) {
  const wid = winIdByWin.get(win);
  if (!wid) return false;
  const s = runningByWin.get(wid);
  return !!(s && s.size > 0);
}

/** 向所有小窗实例推同一条事件；小窗自己按 sessionKey 过滤 */
function broadcastToFloatBars(payload) {
  if (!payload) return;
  for (const bar of floatBars) {
    if (bar && typeof bar.pushEvent === 'function') bar.pushEvent(payload);
  }
}

/** 危险确认卡片和普通事件分开走，这里对每个小窗实例推一次 */
function broadcastAskToFloatBars(payload) {
  if (!payload) return;
  for (const bar of floatBars) {
    if (bar && typeof bar.pushAsk === 'function') bar.pushAsk(payload);
  }
}

/** 小窗回传参数的兼容写法：既支持 (key, value)，也支持 ({ key, value, turnId, tabId }) */
function parseFloatBarCallback(a, b) {
  if (a && typeof a === 'object' && !Array.isArray(a)) {
    const value = a.value !== undefined ? a.value : (a.answer !== undefined ? a.answer : a.text);
    return {
      key: String(a.key || ''),
      value,
      turnId: String(a.turnId || ''),
      tabId: String(a.tabId || '')
    };
  }
  const first = String(a == null ? '' : a);
  // 只传一个字符串时：像会话键就当键，否则当值（旧调用形态兜底）
  if (b === undefined) {
    return { key: looksLikeSessionKey(first) ? first : '', value: first, turnId: '', tabId: '' };
  }
  return { key: first, value: b, turnId: '', tabId: '' };
}

/** canStart 或绑定变化时，把各小窗自己的 start-ready 回推一次 */
function pushStartReady(keyHint) {
  const key = String(keyHint || boundKey || '');
  const state = canStartByKey.get(key);
  // 兼容旧形态：这里历史上存过纯布尔值，读的时候两种都要认
  const canStart = state === true || !!(state && state.canStart === true);
  // options 一律给数组，缺省空数组，小窗自己决定要不要多摆几颗方案按钮
  const options = state && Array.isArray(state.options) ? state.options : [];
  broadcastToFloatBars({ kind: 'start-ready', sessionKey: key, canStart, options });
}

/** 小窗会话清单：窗口编号 + 渲染层报上来的标题 */
function sessionsPayload() {
  const list = [];
  for (const [key, label] of sessionsByKey) list.push({ key, label });
  return list;
}

function broadcastSessions() {
  broadcastToFloatBars({ kind: 'sessions', sessions: sessionsPayload() });
}

// 一轮里的状态、当前步骤、危险确认顺手转给常驻悬浮栏，原来的下发逻辑不动
// 每条推送都带 turnId + sessionKey，小窗按会话键认领，不会串到别的窗口的对话
function forwardTurnEventToFloatBar(ev, turnId) {
  if (!ev || !floatBars.length) return;
  const tid = turnId || '';
  const sessionKey = tid ? sessionKeyOfTurn(tid) : '';
  const base = { turnId: tid, sessionKey };
  if (ev.type === 'rewrite_text') {
    // AI 的正文（最终回答的那种），非空字符串才推给悬浮栏，字段名沿用事件里的 text
    if (typeof ev.text === 'string' && ev.text) {
      broadcastToFloatBars({ ...base, kind: 'ai', text: ev.text });
    }
    return;
  }
  if (ev.type === 'text') {
    // AI 的流式增量正文，同样只推非空字符串，字段名沿用事件里的 text
    if (typeof ev.text === 'string' && ev.text) {
      broadcastToFloatBars({ ...base, kind: 'ai-delta', text: ev.text });
    }
    return;
  }
  if (ev.type === 'status') {
    broadcastToFloatBars({ ...base, kind: 'status', text: String(ev.text || '') });
    return;
  }
  if (ev.type === 'tool') {
    const step = String(ev.text || ev.detail || ev.name || '');
    if (step) broadcastToFloatBars({ ...base, kind: 'tool', text: step });
    return;
  }
  if (ev.type === 'ask') {
    // 危险确认同样要带轮次和会话键，不然小窗不知道这条答复该送回哪一轮
    broadcastAskToFloatBars({
      ...base,
      kind: 'ask',
      question: String(ev.question || ''),
      options: Array.isArray(ev.options) ? ev.options : []
    });
    return;
  }
  if (ev.type === 'error') {
    broadcastToFloatBars({ ...base, kind: 'error', text: String(ev.message || ev.text || '') });
  }
}

// 悬浮栏发送入口：按小窗带来的会话键定位窗口；空闲时交给那个窗口的发送流程，跑着就插话
function handleFloatBarSend(payload) {
  const incoming = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const key = String(incoming.key || '');
  const raw = payload && typeof payload === 'object' && !Array.isArray(payload) ? incoming.text : payload;
  const msg = String(raw == null ? '' : raw).trim();
  // 小窗发来的图片附件：只认真实存在的本地路径，键名统一成 { path, name }，最多留 6 张
  var list = Array.isArray(incoming.attachments) ? incoming.attachments : [];
  const attList = list
    .filter((item) => item && typeof item.path === 'string' && fs.existsSync(item.path))
    .map((item) => ({ path: item.path, name: String(item.name || path.basename(item.path) || '') }))
    .slice(0, 6);
  // 纯图消息也算消息：只有「既没字也没图」才什么都不做
  if (!msg && attList.length === 0) return;
  if (!key) {
    // 没有会话键就不知道发给谁，宁可提示也不塞进别人的对话
    broadcastToFloatBars({ kind: 'error', text: '小窗还没绑定对话，先在主窗里打开一个对话' });
    return;
  }
  const target = winFromKey(key);
  if (!target) {
    broadcastToFloatBars({ kind: 'error', sessionKey: key, text: '对应的主界面已关闭，这条没发出去' });
    return;
  }
  // 主窗正在跑一轮时，带图的消息不插队（插话只能带文本、图会丢）：
  // 不广播成正式消息，只提示一句，并把文本与附件原样退回，让小窗自己留着重建
  if (attList.length > 0 && turnIsRunning(target)) {
    broadcastToFloatBars({ kind: 'status', sessionKey: key, text: '带图片的消息等这一轮结束再发' });
    broadcastToFloatBars({ kind: 'attachments-back', sessionKey: key, attachments: attList, text: msg });
    return;
  }
  // 小窗要显示带了几张图，所以广播文案里带上张数；images 只是占位，小窗不渲染图片本身
  const userText = attList.length > 0 ? msg + `（附 ${attList.length} 张图）` : msg;
  broadcastToFloatBars({ kind: 'user', sessionKey: key, text: userText, images: attList.map((a) => a.path) });
  if (turnIsRunning(target)) {
    let pushed = false;
    try {
      pushed = agent.pushInterjection(key, msg) === true;
    } catch (e) {
      diag.log('floatbar', '插话失败', { message: e && e.message });
    }
    if (pushed) {
      broadcastToFloatBars({ kind: 'status', sessionKey: key, text: '已插话，下一轮就能读到' });
      return;
    }
    // AGI 没开：插话不成立，这条改成排队——本轮跑完再发。
    // 只提示一句，然后借主窗现有的 send() 走它自己的排队流程，不另起队列
    broadcastToFloatBars({ kind: 'status', sessionKey: key, text: 'AGI 没开，这条先排队，这一轮跑完就发' });
    sendTo(target, 'chat:float-user-message', { text: msg, attachments: attList });
    return;
  }
  // 会话历史由渲染层维护，所以这条提示转发给那个主窗，复用现有的发送流程，不另起一套
  sendTo(target, 'chat:float-user-message', { text: msg, attachments: attList });
}

// 小窗的答复：key 定位窗口，把答复送进那个窗口里对应的一轮
function handleFloatBarAnswer(a, b, c) {
  const p = parseFloatBarCallback(a, b);
  if (!p.turnId && c) p.turnId = String(c);
  const target = winFromKey(p.key);
  if (!target) {
    broadcastToFloatBars({ kind: 'error', sessionKey: p.key, text: '这条答复没找到对应的主界面，已丢弃' });
    return;
  }
  handleChatAnswer(target, { answer: p.value, turnId: p.turnId, tabId: p.tabId });
}

// 小窗的停止：同样只停它绑定的那个窗口，不再猜第一个窗口
function handleFloatBarAbort(a, b, c) {
  const p = parseFloatBarCallback(a, b);
  if (!p.turnId && c) p.turnId = String(c);
  const target = winFromKey(p.key);
  if (!target) {
    broadcastToFloatBars({ kind: 'error', sessionKey: p.key, text: '停止没找到对应的主界面，已忽略' });
    return;
  }
  // 带轮次就只停那一轮，不带就停这个窗口当前在等的所有轮次
  handleChatAbort(target, p.turnId);
}

function createWindow() {
  // 每个主窗一个身份编号，会话键和轮次归属都靠它分辨，窗口标题也用它
  winSeq += 1;
  const winId = winSeq;
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    title: `窗口${winId}`,
    icon: path.join(CODE_ROOT, 'icons.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#f3f3f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  winIdByWin.set(win, winId);
  winById.set(winId, win);
  windows.add(win);
  workspaceByWin.set(win, '');
  win.on('closed', () => {
    diag.log('window', '窗口已关闭');
    stopWorkspaceWatch(win);
    windows.delete(win);
    // 这个窗口的身份和会话一起撤掉，免得小窗还挂着一个已经没了的会话
    winIdByWin.delete(win);
    winById.delete(winId);
    runningByWin.delete(winId);
    lastTabIdByWin.delete(win);
    const prefix = winId + ':';
    for (const k of [...sessionsByKey.keys()]) {
      if (k.startsWith(prefix)) sessionsByKey.delete(k);
    }
    for (const k of [...canStartByKey.keys()]) {
      if (k.startsWith(prefix)) canStartByKey.delete(k);
    }
    if (boundKey.startsWith(prefix)) boundKey = '';
    broadcastSessions();
    // 主窗全关了就顺手收掉悬浮栏窗口，否则常驻小窗会让 window-all-closed 永远不触发、进程白白挂着
    if (windows.size === 0 && floatBar) floatBar.destroy();
  });
  win.on('unresponsive', () => diag.log('window', '窗口无响应'));
  win.on('responsive', () => diag.log('window', '窗口恢复响应'));
  win.webContents.on('render-process-gone', (_e, details) => diag.log('crash', '渲染进程退出', details));
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    diag.log('crash', 'preload 出错', { preloadPath, message: error && error.message });
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F5') {
      event.preventDefault();
      sendTo(win, 'ui:refresh', {});
    }
  });
  win.loadFile(path.join(CODE_ROOT, 'renderer', 'index.html'));
  return win;
}

function getWin(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

function settingsWithTheme() {
  const s = store.load();
  return { ...s, resolvedTheme: store.resolveTheme(s.theme) };
}

function stopWorkspaceWatch(win) {
  const rec = watchByWin.get(win);
  if (!rec) return;
  try { rec.watcher.close(); } catch { /* 忽略 */ }
  if (rec.timer) clearTimeout(rec.timer);
  watchByWin.delete(win);
}

function watchIsNoise(filename) {
  if (!filename) return true;
  const parts = String(filename).split(/[\\/]/);
  return parts.some((p) => SKIP.has(p) || p === '.sinpo' || p === '.simple' || (p.startsWith('.') && p !== '.'));
}

function startWorkspaceWatch(win, dir) {
  stopWorkspaceWatch(win);
  if (!dir || !fs.existsSync(dir)) return;
  try {
    const rec = { watcher: null, timer: null };
    rec.watcher = fs.watch(dir, { recursive: true }, (_ev, filename) => {
      if (watchIsNoise(filename)) return;
      try { codeIndex.noteDiskChange(dir, filename); } catch { /* 地图脏标记失败不影响界面刷新 */ }
      if (rec.timer) return;
      rec.timer = setTimeout(() => {
        rec.timer = null;
        sendTo(win, 'workspace:changed', {});
      }, 300);
    });
    rec.watcher.on('error', () => {
      try { codeIndex.noteWatching(dir, false); } catch { /* 监听失败时查询仍会整树对齐 */ }
      stopWorkspaceWatch(win);
    });
    watchByWin.set(win, rec);
    try { codeIndex.noteWatching(dir, true); } catch { /* 地图模块未就绪时忽略 */ }
  } catch {
    try { codeIndex.noteWatching(dir, false); } catch { /* 不支持监听时查询仍会整树对齐 */ }
  }
}

function addRecent(dir) {
  const s = store.load();
  const name = path.basename(dir);
  s.recents = [{ name, path: dir, openedAt: Date.now() }, ...s.recents.filter((r) => r.path !== dir)].slice(0, 20);
  store.save(s);
}

codeIndex.onStatus((st) => {
  for (const win of windows) {
    const ws = workspaceByWin.get(win) || '';
    if (ws && st?.workspace && codeIndex.sameWorkspace(ws, st.workspace)) {
      sendTo(win, 'index:progress', st);
    }
  }
});

// 崩溃诊断：闪退时窗口和控制台一起消失，只能靠这份日志回溯
// 本地留存崩溃转储，用来区分「原生崩溃」和「被外部杀掉」
crashReporter.start({ submitURL: '', uploadToServer: false, compress: false });

try {
  const mig = migrateUserData();
  if (mig.copied) console.log(`[migrate] 已从 ${mig.from} 迁到 ${mig.to}`);
} catch (e) {
  console.log('[migrate] 迁移失败', e && e.message);
}

diag.log('app', '主进程启动', { pid: process.pid, electron: process.versions.electron, node: process.versions.node });

function crashDumpDir() {
  return path.join(app.getPath('crashDumps'), 'reports');
}

/** 启动时把上次留下的崩溃转储列出来，有转储就说明上次是原生崩溃 */
function reportPreviousCrashes() {
  try {
    const dir = crashDumpDir();
    const dumps = fs.readdirSync(dir)
      .filter((n) => n.toLowerCase().endsWith('.dmp'))
      .map((n) => ({ name: n, mtime: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 5);
    if (!dumps.length) {
      diag.log('crash', '未发现崩溃转储', { dir });
      return;
    }
    for (const d of dumps) {
      diag.log('crash', '发现崩溃转储', { file: path.join(dir, d.name), time: new Date(d.mtime).toLocaleString('zh-CN') });
    }
  } catch {
    diag.log('crash', '崩溃转储目录不存在', { dir: crashDumpDir() });
  }
}

/** 心跳：记录内存曲线，闪退前的最后一条能看出是否内存耗尽 */
function startHeartbeat() {
  setInterval(() => {
    const mem = process.memoryUsage();
    diag.log('heartbeat', '存活', {
      主进程rssMB: Math.round(mem.rss / 1048576),
      堆已用MB: Math.round(mem.heapUsed / 1048576),
      外部内存MB: Math.round((mem.external || 0) / 1048576),
      系统可用MB: Math.round(os.freemem() / 1048576),
      窗口数: windows.size
    });
  }, 5000).unref();
}

process.on('uncaughtException', (err) => {
  diag.log('crash', '主进程未捕获异常', { message: err && err.message, stack: err && err.stack });
});
process.on('unhandledRejection', (err) => {
  diag.log('crash', '主进程未处理的 Promise 拒绝', { message: err && err.message, stack: err && err.stack });
});
process.on('exit', (code) => diag.log('app', '主进程退出', { code }));

app.on('child-process-gone', (_e, details) => diag.log('crash', '子进程退出', details));
app.on('before-quit', () => {
  diag.log('app', '收到退出请求 before-quit');
  downloader.cancelAll();
  try { visionEngine.stop(); } catch { /* 退出时忽略 */ }
});
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch { /* 退出时忽略 */ }
  if (floatBar) floatBar.destroy();
  releaseFloatBarSlot();
  diag.log('app', '即将退出 will-quit');
});
app.on('quit', (_e, code) => diag.log('app', '已退出 quit', { code }));

ipcMain.on('log:client', (_e, payload) => {
  diag.log('renderer', (payload && payload.message) || '界面异常', payload && payload.detail);
});

// ── 悬浮栏槽位：多开进程时每个进程占一个，免得两个小窗叠在同一处互相打架 ──
function floatBarSlotDir() {
  return path.join(app.getPath('userData'), 'floatbar-slots');
}

/** pid 还活着吗；EPERM 说明进程在只是不归自己管，也算活着 */
function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !!(e && e.code === 'EPERM');
  }
}

/** 依次试 slot-1 .. slot-9，全被占也退回 1 号继续跑，不崩 */
function claimFloatBarSlot() {
  const dir = floatBarSlotDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    diag.log('floatbar', '创建槽位目录失败', { message: e && e.message });
  }
  for (let n = 1; n <= 9; n += 1) {
    const file = path.join(dir, `slot-${n}.pid`);
    let holder = 0;
    try {
      holder = Number(String(fs.readFileSync(file, 'utf8')).trim());
    } catch { holder = 0; }
    if (holder && holder !== process.pid && pidAlive(holder)) continue;
    try {
      fs.writeFileSync(file, String(process.pid), 'utf8');
      return n;
    } catch (e) {
      diag.log('floatbar', `占用槽位 slot-${n} 失败`, { message: e && e.message });
    }
  }
  diag.log('floatbar', '没有空闲的悬浮栏槽位，退回 slot-1', { pid: process.pid });
  return 1;
}

/** 退出时把自己的 slot 文件删掉，只删还写着自己 pid 的那个 */
function releaseFloatBarSlot() {
  if (!mySlot) return;
  try {
    const file = path.join(floatBarSlotDir(), `slot-${mySlot}.pid`);
    const holder = Number(String(fs.readFileSync(file, 'utf8')).trim());
    if (holder === process.pid) fs.unlinkSync(file);
  } catch { /* 文件不在或读不了就算了，退出时不折腾 */ }
}

// 小窗新增的四个通道都在这里绑一次：语义都是新增，原有通道一个没动
function registerFloatBarIpc() {
  // 小窗点「开始」：由 lib/float-bar.js 的 onStart 回调触发。
  // 注意：小窗内部已经自己监听 floatbar:start / floatbar:bind 两个通道，这里绝不能再绑一次，
  // 否则同一次点击会被处理两遍。原先的 ipcMain.handle/on 注册已按此删除。
  // key 定位哪个会话，value 是用户点的那颗方案字母（单颗「开始」是空串 = 点默认那颗；
  // 多选「一起开工」是勾中的 value 字符串数组）；
  // 第三位 note 是用户在开工选项下面填的补充说明，空串表示没填，同样原样转发；
  // 这里只管转发，错误返回 no-key / no-window 与原样一致，判定仍只有 renderer/app.js 一份
  function startFromFloatBar(key, value, note) {
    const k = String(key == null ? '' : key);
    if (!looksLikeSessionKey(k)) return { ok: false, error: 'no-key' };
    const target = winFromKey(k);
    if (!target) return { ok: false, error: 'no-window' };
    // value 原样带上：数组就是数组，只有 undefined/null 才兜底成空串。
    // 这里禁止 String()/join()，否则「一起开工」的三个勾选项会被压成 "[object Object]" 或 "a,b"
    sendTo(target, 'floatbar:do-start', { sessionKey: k, value: value == null ? '' : value, note: note == null ? '' : String(note) });
    return { ok: true };
  }
  floatBarStartHandler = startFromFloatBar;

  // 小窗绑定会话键：记下来，并立刻回推一次这个键的 start-ready
  function bindFromFloatBar(key) {
    const raw = String(key == null ? '' : key);
    const k = raw || lastActiveKey;          // 小窗发空键时用主进程记的最近会话兜底
    boundKey = k;
    diag.log('floatbar', `小窗绑定会话 ${k || '(空)'}`);
    // 关键：小窗页面发空键时不会自己认领，默认绑定必须由主进程主动灌回去
    for (const bar of floatBars) {
      if (bar && typeof bar.setBoundKey === 'function') bar.setBoundKey(k);
    }
    pushStartReady(k);
    return { ok: true };
  }
  floatBarBindHandler = bindFromFloatBar;

  /** 主窗报上来的开始方案：必须是数组，每项只留 { value, label } 两个字符串字段，其余一律丢掉 */
  function readStartOptions(payload) {
    const raw = payload && payload.options;
    if (!Array.isArray(raw)) return [];   // 非数组一律当没有方案，别让小窗拿到乱七八糟的东西
    const out = [];
    for (const one of raw) {
      if (!one || typeof one !== 'object') continue;
      // value 留空是合法的（表示默认那颗），这里只做类型收敛，不替主窗做取舍
      out.push({
        value: String(one.value == null ? '' : one.value),
        label: String(one.label == null ? '' : one.label)
      });
    }
    return out;
  }

  // 主窗渲染层回报「这个会话此刻能不能新起一轮」，顺带带上可选的开始方案
  function noteCanStart(e, payload) {
    const win = getWin(e);
    if (!win) return;
    const tabId = String((payload && payload.tabId) || lastTabIdByWin.get(win) || '');
    const key = String((payload && payload.key) || makeSessionKey(win, tabId));
    if (!key) return;
    canStartByKey.set(key, {
      canStart: !!(payload && payload.canStart),
      options: readStartOptions(payload)
    });
    pushStartReady(key);
  }
  ipcMain.on('floatbar:can-start', noteCanStart);
  ipcMain.handle('floatbar:can-start', (e, payload) => {
    noteCanStart(e, payload);
    return { ok: true };
  });

  // 主窗渲染层回报它绑定的标签页标题：更新会话清单后广播给小窗
  function noteBindFromWindow(e, payload) {
    const win = getWin(e);
    const tabId = String((payload && payload.tabId) || '');
    // 收到空键（这次回报没带标签页）时不更新会话，只把小窗当前的绑定键和该键已缓存的事件回灌一次，
    // 让小窗页面自己校准绑定键，免得顶栏一直停在「未绑定会话」
    if (!tabId) {
      for (const bar of floatBars) {
        if (bar && typeof bar.setBoundKey === 'function') bar.setBoundKey(boundKey);
      }
      return;
    }
    const key = makeSessionKey(win, tabId);
    if (!key) return;
    const wid = winIdByWin.get(win);
    const title = String((payload && payload.title) || '').trim();
    lastTabIdByWin.set(win, tabId);
    lastActiveKey = key;
    sessionsByKey.set(key, `窗口${wid} · ${title || '对话'}`);
    // 只有主窗真的开工（active=true）才把绑定切过来；单纯切标签只更新会话清单，不抢绑定
    if (payload && payload.active === true) {
      boundKey = key;
      console.log('[floatbar] 主窗开工，小窗切到会话 ' + key);
      for (const bar of floatBars) {
        if (bar && typeof bar.setBoundKey === 'function') bar.setBoundKey(key);
      }
      pushStartReady(key);
    }
    broadcastSessions();
  }
  ipcMain.on('floatbar:bind-from-window', noteBindFromWindow);
  ipcMain.handle('floatbar:bind-from-window', (e, payload) => {
    noteBindFromWindow(e, payload);
    return { ok: true };
  });

  // 小窗顶栏的「最小化 / 还原」：页面发来 on=true 表示收成紧凑态，false 表示还原展开态。
  // 定位方式跟别的小窗通道一样，先从 event.sender 找回发出这条消息的那个小窗窗口，再落到对应的实例上；
  // 认不出实例就静默忽略，绝不抛错，也绝不误调别的小窗
  ipcMain.on('floatbar:compact', (event, on) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return;
    for (const bar of floatBars) {
      if (!bar || typeof bar.setCompact !== 'function') continue;
      // 本进程里小窗实例与窗口一一对应：只有一个实例时 sender 就是它的；
      // 实例若自带归属判定就优先用判定结果，认不出来直接跳过
      const mine = typeof bar.ownsWindow === 'function' ? bar.ownsWindow(senderWin) : floatBars.length === 1;
      if (!mine) continue;
      bar.setCompact(on === true);
      return;
    }
  });

  // 主窗顶栏那颗「小窗」开关：切换小窗显隐，切完把新可见性回给调用方，并广播给所有主窗
  ipcMain.handle('floatbar:toggle', () => {
    try {
      if (!floatBar) return { ok: false, visible: false };
      if (typeof floatBar.toggle === 'function') {
        // 实例自带切换能力（lib/float-bar.js 的返回值里确实有 toggle()），优先用它
        floatBar.toggle();
      } else if (typeof floatBar.show === 'function' && typeof floatBar.hide === 'function') {
        // 没有 toggle() 时退回 show/hide 自行组合成一次切换
        if (floatBarVisibleNow()) floatBar.hide();
        else floatBar.show();
      } else {
        return { ok: false, visible: false };
      }
      const visible = floatBarVisibleNow();
      broadcastFloatBarVisibility(visible);
      return { ok: true, visible: visible };
    } catch (e) {
      // 切换失败不往外抛，只回一份 ok:false，免得渲染层 invoke 直接 reject
      diag.log('floatbar', '切换小窗失败', { message: e && e.message });
      return { ok: false, visible: false };
    }
  });

  // 只读小窗当前可见性：主窗按钮初始化时用它对齐状态，异常同样不抛
  ipcMain.handle('floatbar:visible', () => {
    try {
      return { ok: true, visible: floatBarVisibleNow() };
    } catch (e) {
      return { ok: false, visible: false };
    }
  });

  // 小窗右下角自制抓柄请求改尺寸：页面把算好的目标宽高 { w, h } 发过来，这里落到对应实例的 resizeBy。
  // 定位方式与本函数里其它小窗通道完全一致：先由 event.sender 找回发出消息的那个小窗窗口，再按实例归属判定，
  // 认不出实例、实例没有这个方法、或 resizeBy 自己抛错，统一回 { ok:false, error }，绝不抛错、也绝不误改别的小窗
  ipcMain.handle('floatbar:resize', (event, payload) => {
    const senderWin = BrowserWindow.fromWebContents(event.sender);
    if (!senderWin) return { ok: false, error: 'no-window' };
    for (const bar of floatBars) {
      if (!bar || typeof bar.resizeBy !== 'function') continue;
      // 本进程里小窗实例与窗口一一对应：只有一个实例时 sender 就是它的；
      // 实例若自带归属判定就优先用判定结果，认不出来直接跳过
      const mine = typeof bar.ownsWindow === 'function' ? bar.ownsWindow(senderWin) : floatBars.length === 1;
      if (!mine) continue;
      try {
        // 返回值（{ ok:true, w, h } 或 { ok:false, error }）原样回给渲染端，这里不再包一层
        return bar.resizeBy(payload);
      } catch (e) {
        diag.log('floatbar', '小窗改尺寸失败', { message: e && e.message });
        return { ok: false, error: 'resize-failed' };
      }
    }
    return { ok: false, error: 'no-window' };
  });
}

/**
 * 判定某个窗口是不是任意一个已登记小窗实例的窗口。
 * 小窗实例自带归属判定（lib/float-bar.js 返回的 ownsWindow()）时优先用它；
 * 实例没有该方法时退回兜底判定：把它内部的窗口对象拿出来与传入窗口做引用比较。
 */
function floatBarOwnsWindow(win) {
  for (let i = 0; i < floatBars.length; i++) {
    const bar = floatBars[i];
    if (!bar) continue;
    if (typeof bar.ownsWindow === 'function') {
      try {
        if (bar.ownsWindow(win) === true) return true;
      } catch (e) {
        // 判定本身报错就当认不出这个小窗，继续比下一个
      }
      continue;
    }
    const inner = bar.window || bar.win || bar.browserWindow;
    if (inner && inner === win) return true;
  }
  return false;
}

/** 读小窗当前可见性：实例自带 isVisible() 就用它，否则问实例内部的窗口对象；取不到一律按不可见处理 */
function floatBarVisibleNow() {
  const bar = floatBar;
  if (!bar) return false;
  if (typeof bar.isVisible === 'function') {
    try {
      return bar.isVisible() === true;
    } catch (e) {
      return false;
    }
  }
  const inner = bar.window || bar.win || bar.browserWindow;
  if (inner && typeof inner.isDestroyed === 'function' && !inner.isDestroyed() && typeof inner.isVisible === 'function') {
    try {
      return inner.isVisible() === true;
    } catch (e) {
      return false;
    }
  }
  return false;
}

/**
 * 把小窗当前的可见性广播给所有主窗：主窗顶栏那颗「小窗」开关靠这条消息同步状态。
 * 遍历 BrowserWindow.getAllWindows()，跳过小窗自身的窗口，只给主窗发 floatbar:visibility。
 */
function broadcastFloatBarVisibility(visible) {
  const on = visible === true;
  const all = BrowserWindow.getAllWindows();
  for (let i = 0; i < all.length; i++) {
    const win = all[i];
    if (!win || win.isDestroyed()) continue;
    if (floatBarOwnsWindow(win)) continue;   // 小窗自己不收这条广播
    sendTo(win, 'floatbar:visibility', on);
  }
}

app.whenReady().then(async () => {
  ensureAppRoot();
  diag.log('app', `诊断日志位置：${diag.logFile()}`);
  diag.log('app', `APP_ROOT=${APP_ROOT}`, { packaged: app.isPackaged });
  try {
    const s = store.load();
    const proxy = await applyProxy(session.defaultSession, s.proxy || '');
    if (proxy.applied) diag.log('app', '已应用网络代理', { proxy: proxy.proxy });
  } catch (e) {
    diag.log('app', '应用代理失败', { message: e && e.message });
  }
  reportPreviousCrashes();
  startHeartbeat();
  // 小窗 IPC 必须赶在建主窗之前登记：主窗一开工就会回报绑定/开工状态，晚登记会漏掉首批消息。
  // 这些通道只用到模块级的表（floatBars / sessionsByKey / winIdByWin 等），不依赖 mySlot、floatBar、shortcutOk
  registerFloatBarIpc();
  createWindow();
  // 先注册快捷键：是否成功决定小窗要不要留「隐藏」入口，所以要在建小窗之前知道
  try {
    shortcutOk = globalShortcut.register('CommandOrControl+Alt+Space', function () {
      if (floatBar) floatBar.toggle();
      // 快捷键也能改小窗状态，切换完成后补一次广播，主窗那颗「小窗」开关跟着同步
      if (floatBar) broadcastFloatBarVisibility(floatBarVisibleNow());
    });
    if (!shortcutOk) diag.log('floatbar', '全局快捷键 Ctrl+Alt+Space 注册失败，可能已被别的程序占用，小窗不再提供隐藏入口');
  } catch (e) {
    shortcutOk = false;
    diag.log('floatbar', '全局快捷键注册异常', { message: e && e.message });
  }
  mySlot = claimFloatBarSlot();
  diag.log('floatbar', `本进程占用悬浮栏槽位 slot-${mySlot}`, { pid: process.pid });
  // 常驻置顶悬浮栏：回调都是主进程已有的逻辑，窗口自己收在 lib/float-bar.js 里
  floatBar = createFloatBar({
    slotIndex: mySlot,
    // 主窗有常备的「小窗」按钮可以随时唤出小窗，所以热键是否注册成功不再决定隐藏入口的有无
    canHide: true,
    // 第三位是小窗带来的图片附件清单，原样交给 handleFloatBarSend 去过滤和截断
    onSend: function (key, text, attachments) { handleFloatBarSend({ key: String(key || ''), text: String(text == null ? '' : text), attachments: attachments }); },
    onAnswer: function (a, b, c) { handleFloatBarAnswer(a, b, c); },
    onAbort: function (a, b, c) { handleFloatBarAbort(a, b, c); },
    // 小窗点「开始」：key 定位会话，value 是用户点的那颗方案字母或勾选项数组，
    // note 是开工选项下面填的补充说明（空串 = 没填），三个一起透传给 startFromFloatBar
    onStart: function (key, value, note) {
      // 兼容两种回调形态：键与值分两个参数传，或整份载荷当一个对象传
      // value 一律原样往下传：空串是单颗「开始」，数组是多选「一起开工」，
      // note 同样原样往下传，对象形态里带了就用对象里的，没带就用分参数那一路的
      // 这里不做任何 String()/join()，一转就把数组压坏了，后面再也分不出勾了哪几项
      if (key && typeof key === 'object') {
        const raw = key;
        const rawKey = raw.key == null ? raw.sessionKey : raw.key;
        const rawValue = raw.value == null ? value : raw.value;
        const rawNote = raw.note == null ? note : raw.note;
        if (floatBarStartHandler) floatBarStartHandler(rawKey, rawValue, rawNote);
        return;
      }
      if (floatBarStartHandler) floatBarStartHandler(key, value, note);
    },
    onBind: function (key) { if (floatBarBindHandler) floatBarBindHandler(key); },
    // 小窗自己收起（点关闭/隐藏）后补一次广播：hide 由 lib/float-bar.js 内部完成，这里只同步主窗那颗开关
    onHide: function () { broadcastFloatBarVisibility(floatBarVisibleNow()); }
  });
  floatBars.push(floatBar);
  // ===== AGI 小窗挪位接口（工具 float_bar_move）=====
  // floatBars 是普通数组（见文件顶部声明），元素就是 lib/float-bar.js 建出来的小窗实例，
  // 实例上已有 isVisible() / ownsWindow() 等方法，挪位由实例自己的 moveToPlace(place) 完成。
  // 这里只把「挪」和「读位置」两件事交给 agent 模块，窗口的创建与销毁逻辑一概不动。

  /** 小窗实例当前是否可见：没有可见性方法的实例按不可见处理，取异常也不抛错 */
  function floatBarIsVisible(bar) {
    if (!bar || typeof bar.isVisible !== 'function') return false;
    try {
      return bar.isVisible() === true;
    } catch (e) {
      return false;
    }
  }

  /**
   * 取一个小窗实例当前的窗口矩形 { x, y, width, height }：
   * 实例自带 getBounds() 就用它，否则按 ownsWindow() 在窗口表里找到它的小窗再用 win.getBounds()。
   * 认不出窗口或调用异常一律返回 null，绝不抛错。
   */
  function floatBarBoundsOf(bar) {
    if (!bar) return null;
    if (typeof bar.getBounds === 'function') {
      try {
        const own = bar.getBounds();
        if (own) return { x: own.x, y: own.y, width: own.width, height: own.height };
      } catch (e) {
        return null;
      }
    }
    if (typeof bar.ownsWindow !== 'function') return null;
    const allWins = BrowserWindow.getAllWindows();
    for (let i = 0; i < allWins.length; i++) {
      const win = allWins[i];
      if (!win || win.isDestroyed()) continue;
      if (!bar.ownsWindow(win)) continue;
      try {
        const b = win.getBounds();
        return { x: b.x, y: b.y, width: b.width, height: b.height };
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  /**
   * float_bar_move 的主进程实现：把所有「当前可见」的小窗挪到 place 指定的方位。
   * 某个小窗挪失败（回 ok:false 或抛异常）只跳过它，其它小窗照挪，绝不整批失败。
   * 返回 { ok:true, moved:[{ x, y, width, height }] }；一个可见小窗都没有时返回 no-float-bar。
   */
  function moveFloatBarsToPlace(place) {
    const moved = [];
    let visibleCount = 0;
    for (let i = 0; i < floatBars.length; i++) {
      const bar = floatBars[i];
      if (!floatBarIsVisible(bar)) continue;
      visibleCount++;
      if (typeof bar.moveToPlace !== 'function') continue;
      let res = null;
      try {
        res = bar.moveToPlace(place);
      } catch (e) {
        diag.log('floatbar', '挪小窗失败，跳过这一个', { place: place, message: e && e.message });
        continue;
      }
      // 单个小窗明确回了 ok:false 就跳过它，继续处理其它小窗
      if (res && res.ok === false) continue;
      const b = floatBarBoundsOf(bar);
      if (b) {
        moved.push({ x: b.x, y: b.y, width: b.width, height: b.height });
      } else if (res && typeof res.x === 'number' && typeof res.y === 'number') {
        // 取不到窗口矩形时退回实例回传的坐标，宁可少几个字段也不漏掉这一次成功的挪动
        moved.push({ x: res.x, y: res.y, width: res.width, height: res.height });
      }
    }
    if (visibleCount === 0) {
      return { ok: false, error: 'no-float-bar', message: '现在没有悬浮小窗可挪' };
    }
    return { ok: true, moved: moved };
  }

  /** 读所有可见小窗的窗口矩形，供 AGI 判断挪完之后画面还剩哪块被挡着 */
  function floatBarRects() {
    const out = [];
    for (let i = 0; i < floatBars.length; i++) {
      const bar = floatBars[i];
      if (!floatBarIsVisible(bar)) continue;
      const b = floatBarBoundsOf(bar);
      if (!b) continue;
      out.push({ x: b.x, y: b.y, width: b.width, height: b.height });
    }
    return out;
  }

  // 交给 agent 模块；版本不一致（拿不到 setFloatBarHooks）时静默跳过，不影响小窗本身。
  // 两个回调都用具名函数表达式传，方便在栈里认出是谁调的。
  if (agent && typeof agent.setFloatBarHooks === 'function') {
    agent.setFloatBarHooks({
      move: function move(place) { return moveFloatBarsToPlace(place); },
      rects: function rects() { return floatBarRects(); }
    });
  } else {
    diag.log('floatbar', 'agent 模块没有 setFloatBarHooks，AGI 挪小窗能力未注册');
  }
  // 小窗刚起来时先给它一份已有会话清单，免得等下一次变更才知道有什么可绑
  broadcastSessions();
  startClipboardWatch();
  if (store.load().desktopAlive) desktopHand.setAlive(true);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  diag.log('app', '所有窗口已关闭');
  desktopHand.setAlive(false);
  if (process.platform !== 'darwin') app.quit();
});

nativeTheme.on('updated', () => {
  const s = store.load();
  if (s.theme === 'system') {
    for (const win of windows) sendTo(win, 'chat:event', { type: 'theme', theme: store.resolveTheme('system') });
  }
});

function modelsDirOf(s) {
  const dir = (s && s.modelsDir) || store.defaultModelsDir();
  return localLlm.ensureDir(dir);
}

ipcMain.handle('app:state', async (e) => {
  const win = getWin(e);
  const s = settingsWithTheme();
  const modelsDir = modelsDirOf(s);
  return {
    ...s,
    modelsDir,
    workspace: workspaceByWin.get(win) || '',
    appRoot: APP_ROOT,
    localFiles: listLocalFilesEnriched(modelsDir),
    assemblyKey: assembly.assemblyKey(s)
  };
});

ipcMain.handle('app:theme', (_e, theme) => {
  const s = store.load();
  s.theme = theme;
  store.save(s);
  return store.resolveTheme(theme);
});

ipcMain.handle('app:locale', (_e, locale) => {
  const s = store.load();
  s.locale = locale === 'en' ? 'en' : 'zh';
  store.save(s);
  return s.locale;
});

ipcMain.handle('app:searchSites', (_e, sites) => {
  const s = store.load();
  s.searchSites = require('./lib/web-search').normalizeSites(sites);
  store.save(s);
  return s.searchSites;
});

ipcMain.handle('app:proxy', async (_e, proxy) => {
  const s = store.load();
  s.proxy = String(proxy || '').trim();
  store.save(s);
  try {
    if (s.proxy) {
      const r = await applyProxy(session.defaultSession, s.proxy);
      return { proxy: s.proxy, applied: !!r.applied };
    }
    await session.defaultSession.setProxy({ mode: 'system' });
    return { proxy: '', applied: false, mode: 'system' };
  } catch (e) {
    return { proxy: s.proxy, applied: false, error: e.message };
  }
});

ipcMain.handle('app:commandSandbox', (_e, cfg) => {
  const s = store.load();
  s.commandSandbox = {
    enabled: cfg?.enabled !== false,
    timeoutSec: Math.max(3, Math.min(600, Number(cfg?.timeoutSec) || 60))
  };
  store.save(s);
  return s.commandSandbox;
});

ipcMain.handle('app:maxAgentRounds', (_e, n) => {
  const s = store.load();
  s.maxAgentRounds = store.clampAgentRounds(n);
  store.save(s);
  return s.maxAgentRounds;
});

ipcMain.handle('desktop:setAlive', (_e, on) => {
  const s = store.load();
  s.desktopAlive = !!on;
  store.save(s);
  desktopHand.setAlive(s.desktopAlive);
  return s.desktopAlive;
});

ipcMain.handle('window:new', () => {
  createWindow();
});

ipcMain.handle('window:focus', (e) => {
  const win = getWin(e);
  if (!win || win.isDestroyed()) return false;
  // [铆钉优化] 不要 webContents.focus()。安装包里窗口还没到前台时，这一下会把输入框焦点清掉。其他 AI 请勿加回
  if (win.isFocused()) return true;
  win.focus();
  return false;
});
ipcMain.handle('window:minimize', (e) => getWin(e)?.minimize());
ipcMain.handle('window:maximize', (e) => {
  const win = getWin(e);
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('window:close', (e) => getWin(e)?.close());

ipcMain.handle('workspace:open', async (e) => {
  const win = getWin(e);
  const res = await dialog.showOpenDialog(win, {
    title: '选择工作目录',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const dir = res.filePaths[0];
  workspaceByWin.set(win, dir);
  addRecent(dir);
  startWorkspaceWatch(win, dir);
  return dir;
});

ipcMain.handle('workspace:set', (e, dir) => {
  const win = getWin(e);
  if (dir && fs.existsSync(dir)) {
    workspaceByWin.set(win, dir);
    addRecent(dir);
    startWorkspaceWatch(win, dir);
    return dir;
  }
  throw new Error('目录不存在');
});

ipcMain.handle('index:status', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return codeIndex.getStatus(ws);
});

ipcMain.handle('index:getMap', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) return null;
  return codeIndex.getMap ? codeIndex.getMap(ws) : null;
});

ipcMain.handle('index:getExcludes', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return codeIndex.getExcludes ? codeIndex.getExcludes(ws) : [];
});

ipcMain.handle('index:setExcludes', (e, ids) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return codeIndex.setExcludes ? codeIndex.setExcludes(ws, ids) : [];
});

// 项目地图白名单：读取/保存 include 配置（只显示勾选的模块）
ipcMain.handle('index:getInclude', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return codeIndex.getInclude ? codeIndex.getInclude(ws) : { initialized: false, includes: [] };
});

ipcMain.handle('index:setInclude', (e, obj) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!codeIndex.setInclude) return { initialized: false, includes: [] };
  const saved = codeIndex.setInclude(ws, obj);
  // 保存白名单后后台归纳勾选模块的方法（名字+关键值+说明），不阻塞界面
  if (ws && saved.includes.length && codeIndex.summarizeIncludes) {
    const s = store.load();
    const modelCfg = store.resolveModelCfg(s.currentModelId, s);
    if (modelCfg) {
      codeIndex.summarizeIncludes(ws, saved.includes, modelCfg)
        .catch((err) => diag.log('map', '方法归纳失败', { message: err && err.message }));
    }
  }
  return saved;
});

ipcMain.handle('index:summarizeOne', (e, id) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws || !codeIndex.summarizeOne) return Promise.resolve({ ok: false, reason: 'no-map' });
  const s = store.load();
  const modelCfg = store.resolveModelCfg(s.currentModelId, s);
  if (!modelCfg) return Promise.resolve({ ok: false, reason: 'no-model' });
  return codeIndex.summarizeOne(ws, id, modelCfg);
});

ipcMain.handle('index:summarize', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws || !codeIndex.summarizeIncludes || !codeIndex.getInclude) return { ok: false };
  const inc = codeIndex.getInclude(ws);
  if (!inc || !inc.initialized || !inc.includes || !inc.includes.length) return { ok: false, reason: 'no-include' };
  const s = store.load();
  const modelCfg = store.resolveModelCfg(s.currentModelId, s);
  if (!modelCfg) return { ok: false, reason: 'no-model' };
  codeIndex.summarizeIncludes(ws, inc.includes, modelCfg)
    .catch((err) => diag.log('map', '方法归纳失败', { message: err && err.message }));
  return { ok: true };
});

ipcMain.handle('index:sync', (e, extraFolders) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) return codeIndex.getStatus('');
  const extra = Array.isArray(extraFolders) ? extraFolders : [];
  // 绘制只扫描依赖，不把聊天模型传进去做归纳
  codeIndex.kickIndex(ws, extra, {});
  codeEmbed.kickIndex(ws, extra);
  return codeIndex.getStatus(ws);
});

ipcMain.handle('index:delete', async (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) return codeIndex.getStatus('');
  return codeIndex.deleteIndex(ws);
});

ipcMain.handle('workspace:files', (e, payload) => {
  const query = typeof payload === 'string' ? payload : (payload?.query || '');
  const extras = Array.isArray(payload?.extraFolders) ? payload.extraFolders : [];
  const ws = workspaceByWin.get(getWin(e));
  const out = [];
  if (ws) out.push(...listTree(ws, { query, max: 200 }));
  for (const root of extras) {
    if (!root || !fs.existsSync(root)) continue;
    const files = listTree(root, { query, max: 80 });
    for (const f of files) {
      out.push({
        path: path.join(root, f.path).replace(/\\/g, '/'),
        name: f.name
      });
    }
  }
  return out;
});

ipcMain.handle('workspace:children', (e, payload) => {
  const rel = typeof payload === 'string' ? payload : (payload?.rel || '');
  const win = getWin(e);
  const ws = workspaceByWin.get(win);
  const root = (payload && typeof payload === 'object' && payload.root) || ws;
  const absolute = !!(payload && typeof payload === 'object' && payload.absolute);
  if (!root) return [];
  return listChildren(root, rel || '', { absolute });
});

ipcMain.handle('workspace:read', async (e, rel) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws && !isAbsPath(rel)) throw new Error('未打开项目');
  const extra = extraRoots(APP_ROOT, ws);
  const abs = resolveRead(ws, extra, rel || '');
  const ext = path.extname(abs).toLowerCase();
  const display = String(rel || '').replace(/\\/g, '/');
  if (isDocumentExt(ext)) {
    const parsed = await parseAttachment(abs);
    return {
      kind: 'document',
      path: display,
      name: parsed.name,
      content: parsed.text || '',
      images: (parsed.images || []).map((img) => ({ name: img.name, dataUrl: img.dataUrl }))
    };
  }
  return readForPreview(ws || path.dirname(abs), rel || '');
});

ipcMain.handle('shell:showInFolder', (e, rel) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws && !isAbsPath(rel)) throw new Error('未打开项目');
  const extra = extraRoots(APP_ROOT, ws);
  const abs = resolveRead(ws, extra, rel || '');
  if (!fs.existsSync(abs)) throw new Error('文件不存在');
  shell.showItemInFolder(abs);
  return true;
});

ipcMain.handle('file:preview', (_e, abs) => {
  if (!abs || !fs.existsSync(abs)) throw new Error('文件不存在');
  const ext = path.extname(abs).toLowerCase();
  const mime = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp'
  }[ext];
  if (!mime) throw new Error('不是图片');
  const stat = fs.statSync(abs);
  if (stat.size > 8 * 1024 * 1024) throw new Error('图片过大');
  const buf = fs.readFileSync(abs);
  return `data:${mime};base64,${buf.toString('base64')}`;
});

ipcMain.handle('git:clone', async (e, { url, dest }) => {
  if (!url || !dest) throw new Error('请填写仓库地址和目标目录');
  fs.mkdirSync(dest, { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['clone', url, dest], { windowsHide: true });
    let err = '';
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(err.slice(0, 800) || `git clone 失败，退出码 ${code}`));
    });
    child.on('error', (er) => reject(new Error('未找到 git，请先安装 Git')));
  });
  const win = getWin(e);
  workspaceByWin.set(win, dest);
  addRecent(dest);
  startWorkspaceWatch(win, dest);
  return dest;
});

ipcMain.handle('ssh:connect', async (e, profile) => {
  const s = store.load();
  s.sshProfiles = [profile, ...(s.sshProfiles || []).filter((p) => p.host !== profile.host)].slice(0, 10);
  store.save(s);
  if (profile.localPath && fs.existsSync(profile.localPath)) {
    const win = getWin(e);
    workspaceByWin.set(win, profile.localPath);
    addRecent(profile.localPath);
    startWorkspaceWatch(win, profile.localPath);
    return { ok: true, workspace: profile.localPath, message: '已打开本地映射目录' };
  }
  const args = ['-p', String(profile.port || 22), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', `${profile.user}@${profile.host}`, 'echo', 'ok'];
  const result = await new Promise((resolve) => {
    const child = spawn('ssh', args, { windowsHide: true });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('close', (code) => resolve({ code, out, err }));
    child.on('error', () => resolve({ code: -1, err: '未找到 ssh 命令' }));
  });
  if (result.code === 0) {
    return { ok: true, workspace: null, message: 'SSH 连通。请把远程目录同步到本地后，用「打开项目」选择该目录。' };
  }
  return { ok: false, message: result.err || 'SSH 连接失败。第一版请先同步到本地再打开。' };
});

ipcMain.handle('models:save', (_e, payload) => {
  const s = store.load();
  const models = payload?.models;
  const providers = payload?.providers;
  const currentModelId = payload?.currentModelId;
  if (Array.isArray(providers)) {
    s.providers = providers.map(store.normalizeProvider).filter(Boolean);
  }
  if (Array.isArray(models)) {
    const migrated = store.migrateProvidersAndModels({
      providers: s.providers,
      models
    });
    s.providers = migrated.providers;
    s.models = migrated.models;
  }
  if (currentModelId != null) s.currentModelId = currentModelId;
  if (!s.models.some((m) => m.id === s.currentModelId)) {
    s.currentModelId = s.models[0]?.id || 'local-gguf';
  }
  store.save(s);
  return { models: s.models, providers: s.providers, currentModelId: s.currentModelId };
});

ipcMain.handle('providers:presets', () => store.PROVIDER_PRESETS);

ipcMain.handle('models:saveAssembly', (_e, { key, slots }) => {
  const s = store.load();
  s.assemblies = s.assemblies && typeof s.assemblies === 'object' ? s.assemblies : {};
  const k = String(key || assembly.assemblyKey(s));
  s.assemblies[k] = { slots: Array.isArray(slots) ? slots : [] };
  assembly.syncVisionFields(s, s.assemblies[k].slots);
  store.save(s);
  return { key: k, slots: s.assemblies[k].slots };
});

ipcMain.handle('models:saveCapabilityDefaults', (_e, payload) => {
  const s = store.load();
  s.capabilityDefaults = assembly.normalizeCapabilityDefaults(payload || {});
  store.save(s);
  return s.capabilityDefaults;
});

// 保存视觉代理配置：本地 GGUF 视觉模型 + mmproj 投影文件 + 可选本地 OpenAI 兼容端点
ipcMain.handle('models:saveVision', (_e, payload) => {
  const s = store.load();
  const p = payload && typeof payload === 'object' ? payload : { model: payload };
  s.visionAgentModel = typeof p.model === 'string' ? p.model : '';
  s.visionAgentMmproj = typeof p.mmproj === 'string' ? p.mmproj : '';
  s.visionAgentEndpoint = typeof p.endpoint === 'string' ? p.endpoint : '';
  const key = assembly.assemblyKey(s);
  s.assemblies = s.assemblies || {};
  if (!s.assemblies[key]) s.assemblies[key] = { slots: [] };
  const slots = s.assemblies[key].slots;
  const idx = slots.findIndex((x) => x.role === 'vision');
  const visionSlot = {
    id: idx >= 0 ? slots[idx].id : `slot-vision-${Date.now()}`,
    role: 'vision',
    type: 'local',
    model: s.visionAgentModel,
    mmproj: s.visionAgentMmproj,
    endpoint: s.visionAgentEndpoint
  };
  if (s.visionAgentModel) {
    if (idx >= 0) slots[idx] = { ...slots[idx], ...visionSlot };
    else slots.push(visionSlot);
  } else if (idx >= 0) {
    slots.splice(idx, 1);
  }
  store.save(s);
  return { model: s.visionAgentModel, mmproj: s.visionAgentMmproj, endpoint: s.visionAgentEndpoint };
});

// 启动本地视觉模型；缺 mmproj 时自动搜/下，并把进度推给当前窗口
ipcMain.handle('models:visionStart', async (e) => {
  const win = getWin(e);
  const s = store.load();
  const vis = assembly.visionFrom(s);
  const model = vis.model || '';
  if (!model) throw new Error('请先在「文件 → 模型组合」中给当前主模型挂上看图模型');
  const file = localLlm.resolveGgufPath({ model, modelPath: '' }, modelsDirOf(s));
  if (!file) throw new Error(`未找到视觉模型文件：${model}。请确认该模型在本地模型目录下。`);
  const en = s.locale === 'en';
  const say = (text, extra) => sendTo(win, 'vision:status', { text, ...(extra || {}) });
  let projector = vis.mmproj || '';
  projector = await mmprojLib.ensure(file, projector, say);
  say(en ? 'Loading vision engine…' : '投影文件已就绪，正在启动看图引擎…');
  try {
    await visionEngine.ensureServer({ modelPath: file, mmproj: projector, onWait: say });
    visionStarted = true;
    visionStartError = '';
    diag.log('vision', '看图引擎已启动', { model, mmproj: projector });
    return { ok: true, model, mmproj: projector };
  } catch (e) {
    visionStarted = false;
    visionStartError = (e && e.message) || String(e);
    diag.log('vision', '看图引擎启动失败', { model, message: visionStartError });
    throw e;
  }
});

ipcMain.handle('models:findMmproj', async (_e, modelName) => {
  const s = store.load();
  const dir = modelsDirOf(s);
  const file = localLlm.resolveGgufPath({ model: modelName, modelPath: '' }, dir);
  if (!file) return { path: '' };
  const found = mmprojLib.findLocal(path.dirname(file), path.basename(file));
  return { path: found || '' };
});

ipcMain.handle('models:visionStatus', () => {
  const s = store.load();
  const vis = assembly.visionFrom(s);
  return {
    started: visionStarted,
    error: visionStartError,
    model: vis.model || '',
    mmproj: vis.mmproj || ''
  };
});

ipcMain.handle('models:test', async (_e, modelCfg) => {
  const s = store.load();
  let cfg = modelCfg;
  if (typeof modelCfg === 'string') cfg = store.resolveModelCfg(modelCfg, s);
  else if (modelCfg?.id && !modelCfg.baseUrl && modelCfg.type !== 'local' && modelCfg.type !== 'zbaingAi') {
    cfg = store.resolveModelCfg(modelCfg.id, s) || modelCfg;
  } else if (modelCfg?.providerId && !modelCfg.baseUrl) {
    const p = store.findProvider(modelCfg.providerId, s);
    cfg = {
      ...modelCfg,
      type: 'api',
      baseUrl: p?.baseUrl || '',
      apiKey: p?.apiKey || '',
      protocol: p?.protocol || 'openai'
    };
  }
  if (cfg?.type === 'zbaingAi' || cfg?.id === 'zbaingAi') {
    return zbaingAi.probe(cfg);
  }
  if (cfg?.type === 'local' || (!cfg?.baseUrl && (cfg?.modelPath || /\.gguf$/i.test(cfg?.model || '')))) {
    const file = localLlm.resolveGgufPath(cfg, modelsDirOf(s));
    return localLlm.probe(file);
  }
  return apiProtocol.testConnection({
    ...cfg,
    protocol: apiProtocol.normalizeProtocol(cfg?.protocol)
  });
});

ipcMain.handle('zbaingAi:listModules', async () => {
  const s = store.load();
  const modelCfg = store.resolveModelCfg('zbaingAi', s);
  return zbaingAi.listModules(modelCfg);
});

ipcMain.handle('zbaingAi:correct', async (_e, payload) => {
  const s = store.load();
  const modelCfg = store.resolveModelCfg('zbaingAi', s);
  return zbaingAi.correct({
    modelCfg,
    prompt: payload?.prompt || '',
    actual: payload?.actual || '',
    expected: payload?.expected || ''
  });
});

ipcMain.handle('zbaingAi:retry', async (_e, payload) => {
  const s = store.load();
  const modelCfg = store.resolveModelCfg('zbaingAi', s);
  return zbaingAi.retry({
    modelCfg,
    messages: payload?.messages || [],
    badReply: payload?.badReply || '',
    badPrompt: payload?.badPrompt || '',
    onDelta: () => {}
  });
});

function resolveRemoteApiCfg(modelCfg) {
  const s = store.load();
  let cfg = modelCfg;
  if (typeof modelCfg === 'string') {
    const p = store.findProvider(modelCfg, s);
    if (p) cfg = { baseUrl: p.baseUrl, apiKey: p.apiKey, protocol: p.protocol };
    else cfg = store.resolveModelCfg(modelCfg, s);
  } else if (modelCfg?.providerId && !modelCfg.baseUrl) {
    const p = store.findProvider(modelCfg.providerId, s);
    cfg = {
      baseUrl: p?.baseUrl || modelCfg.baseUrl,
      apiKey: p?.apiKey || modelCfg.apiKey,
      protocol: p?.protocol || modelCfg.protocol
    };
  }
  return {
    ...cfg,
    protocol: apiProtocol.normalizeProtocol(cfg?.protocol)
  };
}

ipcMain.handle('models:listRemote', async (_e, modelCfg) => {
  return apiProtocol.listModels(resolveRemoteApiCfg(modelCfg));
});

ipcMain.handle('models:accountBalance', async (_e, modelCfg) => {
  const cfg = resolveRemoteApiCfg(modelCfg);
  if (!cfg?.baseUrl) return { available: false };
  return apiProtocol.fetchAccountBalance(cfg).catch(() => ({ available: false }));
});

ipcMain.handle('models:listLocal', () => {
  const dir = modelsDirOf(store.load());
  return { dir, files: listLocalFilesEnriched(dir) };
});

ipcMain.handle('models:pickDir', async (e) => {
  const win = getWin(e);
  const s = store.load();
  const res = await dialog.showOpenDialog(win, {
    title: '选择本地模型目录',
    defaultPath: modelsDirOf(s),
    properties: ['openDirectory', 'createDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return { dir: modelsDirOf(s), files: listLocalFilesEnriched(modelsDirOf(s)) };
  s.modelsDir = res.filePaths[0];
  store.save(s);
  const dir = localLlm.ensureDir(s.modelsDir);
  return { dir, files: listLocalFilesEnriched(dir) };
});

ipcMain.handle('models:openDir', async () => {
  const dir = modelsDirOf(store.load());
  await shell.openPath(dir);
  return dir;
});

/* ===== 本机配置检测与模型下载 ===== */

ipcMain.handle('hw:detect', async () => hardware.detect(modelsDirOf(store.load())));

ipcMain.handle('hw:advice', async (_e, purpose, opts = {}) => {
  const hw = opts.hardware || await hardware.detect(modelsDirOf(store.load()));
  if (opts.forceRefresh) hardware.clearPurposeRepoCache();
  if (opts.query) {
    return { hardware: hw, ...(await hardware.suggestQuery(purpose, hw, opts.query, opts)) };
  }
  return { hardware: hw, ...(await hardware.suggest(purpose, hw, opts)) };
});

ipcMain.handle('download:source', async (_e, opts) => {
  if (opts?.force) hardware.clearPurposeRepoCache();
  return downloader.resolveSources(opts || {});
});

ipcMain.handle('download:search', async (_e, query, opts) => downloader.searchRepos(query, 20, opts || {}));

ipcMain.handle('download:repoFiles', async (_e, repo, opts) => {
  const { source, files } = await downloader.listRepoFiles(repo, opts || {});
  return {
    source,
    repo,
    files: files.map((f) => ({ ...f, url: downloader.fileUrl(source.base, repo, f.name) }))
  };
});

/** 把候选模型解析成真实文件：仓库里的文件名会变，所以下载前才去查 */
ipcMain.handle('download:resolve', async (_e, { repo, quant, base }) => {
  const srcOpts = base ? { base } : {};
  const { source, files } = await downloader.listRepoFiles(repo, srcOpts);
  const picked = downloader.pickFile(files, quant);
  if (!picked) throw new Error(`仓库 ${repo} 里没有找到可用的 gguf 文件`);
  const url = downloader.fileUrl(source.base, repo, picked.name);
  const size = picked.size || await downloader.remoteSize(url);
  return { source, repo, name: picked.name, size, url };
});

ipcMain.handle('download:start', async (e, { id, url, name, threads, meta }) => {
  const win = getWin(e);
  const dir = modelsDirOf(store.load());
  const result = await downloader.download({
    id,
    url,
    dir,
    name,
    threads: Number(threads) || 4,
    onProgress: (p) => sendTo(win, 'download:progress', p)
  });
  if (result.ok && result.path && !result.skipped) {
    try {
      modelMeta.writeMeta(dir, result.path, meta || {});
    } catch (err) {
      diag.log('download', '写入模型元数据失败', { name, message: err && err.message });
    }
  } else if (result.ok && result.path && result.skipped && meta && (meta.purpose || meta.repo)) {
    try {
      modelMeta.writeMeta(dir, result.path, meta);
    } catch { /* 已有文件也尽量补写来源 */ }
  }
  return { ...result, files: listLocalFilesEnriched(dir), dir };
});

ipcMain.handle('download:cancel', (_e, id) => downloader.cancel(id));

function listedSkills(ws) {
  const list = skillsLib.listDetailed(path.join(APP_ROOT, 'skills'), ws || '', store.load().skillOrder || []);
  const enabled = new Set(store.load().enabledSkills || []);
  // 给每个技能标注是否被勾选启用（只有勾中的才会注入系统提示）
  return list.map((s) => ({ ...s, enabled: enabled.has(`${s.scope || 'app'}:${s.id}`) }));
}

function touchSkillOrder(payload, { remove } = {}) {
  const s = store.load();
  s.skillOrder = s.skillOrder || [];
  const scope = payload.scope || 'app';
  const id = String(payload.id || '').trim();
  if (remove) {
    s.skillOrder = s.skillOrder.filter((o) => !(o.id === id && (o.scope || 'app') === scope));
  } else {
    if (payload.oldId && payload.oldId !== id) {
      s.skillOrder = s.skillOrder.map((o) => (
        o.id === payload.oldId && (o.scope || 'app') === scope ? { ...o, id } : o
      ));
    }
    if (id && !s.skillOrder.some((o) => o.id === id && (o.scope || 'app') === scope)) {
      s.skillOrder.push({ id, scope });
    }
  }
  store.save(s);
}

ipcMain.handle('skills:list', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return listedSkills(ws);
});

ipcMain.handle('skills:save', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  skillsLib.saveSkill(APP_ROOT, ws, payload);
  touchSkillOrder(payload);
  return listedSkills(ws);
});

ipcMain.handle('skills:delete', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  skillsLib.deleteSkill(APP_ROOT, ws, payload);
  touchSkillOrder(payload, { remove: true });
  return listedSkills(ws);
});

ipcMain.handle('skills:reorder', (e, order) => {
  const s = store.load();
  s.skillOrder = Array.isArray(order) ? order : [];
  store.save(s);
  const ws = workspaceByWin.get(getWin(e)) || '';
  return listedSkills(ws);
});

ipcMain.handle('skills:setEnabled', (e, keys) => {
  const s = store.load();
  s.enabledSkills = Array.isArray(keys) ? keys.map(String) : [];
  store.save(s);
  const ws = workspaceByWin.get(getWin(e)) || '';
  return listedSkills(ws);
});

ipcMain.handle('rules:list', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return agent.listRules(APP_ROOT, ws);
});

ipcMain.handle('rules:save', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  skillsLib.saveRule(APP_ROOT, ws, payload);
  return agent.listRules(APP_ROOT, ws);
});

ipcMain.handle('rules:delete', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  skillsLib.deleteRule(APP_ROOT, ws, payload);
  return agent.listRules(APP_ROOT, ws);
});

ipcMain.handle('persona:load', () => skillsLib.loadPersona(APP_ROOT).body);

ipcMain.handle('persona:save', (_e, body) => {
  skillsLib.savePersona(APP_ROOT, body);
  return true;
});

ipcMain.handle('memory:list', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) return [];
  return memory.list(ws);
});

ipcMain.handle('memory:add', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) throw new Error('请先打开项目');
  memory.addUserMemory(ws, payload || {});
  return memory.list(ws);
});

ipcMain.handle('memory:delete', (e, id) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) throw new Error('请先打开项目');
  memory.remove(ws, id);
  return memory.list(ws);
});

ipcMain.handle('memory:clear', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) throw new Error('请先打开项目');
  const keepPinned = !!(payload && payload.keepPinned);
  memory.clearAll(ws, { keepPinned });
  return memory.list(ws);
});

ipcMain.handle('memory:pin', (e, { id, pinned }) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) throw new Error('请先打开项目');
  memory.setPinned(ws, id, pinned);
  return memory.list(ws);
});

ipcMain.handle('globalMemory:get', () => memoryGlobal.load());
ipcMain.handle('globalMemory:saveProfile', (_e, profile) => memoryGlobal.saveProfile(profile));
ipcMain.handle('globalMemory:addPref', async (_e, payload) => {
  await memoryGlobal.addPref(payload || {});
  return memoryGlobal.load();
});
ipcMain.handle('globalMemory:deletePref', (_e, id) => {
  memoryGlobal.removePref(id);
  return memoryGlobal.load();
});
ipcMain.handle('globalMemory:pinPref', (_e, { id, pinned }) => {
  memoryGlobal.setPrefPinned(id, pinned);
  return memoryGlobal.load();
});

ipcMain.handle('milestone:list', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) return [];
  return milestone.list(ws);
});

ipcMain.handle('milestone:create', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) throw new Error('请先打开项目');
  const entry = milestone.create(ws, payload || {});
  return { entry, list: milestone.list(ws) };
});

ipcMain.handle('milestone:rename', (e, { id, name }) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) throw new Error('请先打开项目');
  milestone.rename(ws, id, name);
  return milestone.list(ws);
});

ipcMain.handle('milestone:delete', (e, id) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) throw new Error('请先打开项目');
  milestone.remove(ws, id);
  return milestone.list(ws);
});

ipcMain.handle('milestone:match', (e, paths) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws) return [];
  return milestone.matchChanges(ws, paths || []);
});

ipcMain.handle('snapshot:list', (e) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) return [];
  return snapshot.list(ws);
});

ipcMain.handle('snapshot:getMax', (e) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) return snapshot.DEFAULT_MAX_SNAPSHOTS;
  return snapshot.getMax(ws);
});

ipcMain.handle('snapshot:setMax', (e, max) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('请先打开项目');
  const limit = snapshot.setMax(ws, max);
  return { max: limit, list: snapshot.list(ws) };
});

ipcMain.handle('snapshot:restore', (e, id) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未选择工作目录');
  return snapshot.restore(ws, id);
});

ipcMain.handle('snapshot:undo', (e, id) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未选择工作目录');
  return snapshot.undo(ws, id);
});

ipcMain.handle('snapshot:redo', (e, id) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未选择工作目录');
  return snapshot.redo(ws, id);
});

ipcMain.handle('snapshot:hunks', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未选择工作目录');
  const body = payload || {};
  return snapshot.listFileHunks(ws, body.id, body.path);
});

ipcMain.handle('snapshot:rejectHunk', (e, payload) => {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws) throw new Error('未选择工作目录');
  const body = payload || {};
  const result = snapshot.rejectFileHunk(ws, body.id, body.path, body.index);
  try {
    const abs = path.resolve(ws, String(body.path || ''));
    codeIndex.upsertFile(ws, abs, []);
  } catch { /* 拒绝后地图更新失败不影响文件已写回 */ }
  return result;
});

ipcMain.handle('dialog:folder', async (e) => {
  const win = getWin(e);
  const res = await dialog.showOpenDialog(win, {
    title: '添加文件夹',
    properties: ['openDirectory']
  });
  if (res.canceled || !res.filePaths[0]) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:files', async (e) => {
  const win = getWin(e);
  const res = await dialog.showOpenDialog(win, {
    title: '选择附件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: '全部', extensions: ['*'] },
      { name: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
      { name: '文档', extensions: ['pdf', 'doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx', 'csv', 'txt', 'md'] },
      { name: '视频', extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm'] }
    ]
  });
  if (res.canceled) return [];
  return res.filePaths.map((p) => ({ path: p, name: path.basename(p) }));
});

function pasteTempDir() {
  const dir = path.join(app.getPath('temp'), 'simple-paste');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writePasteBuffer(name, buf) {
  const safe = String(name || 'clipboard.bin').replace(/[\\/:*?"<>|]/g, '_');
  const dest = path.join(pasteTempDir(), `${Date.now()}-${safe}`);
  fs.writeFileSync(dest, buf);
  return { path: dest, name: path.basename(dest) };
}

function readClipboardFilePaths() {
  const found = [];
  try {
    const buf = clipboard.readBuffer('FileNameW');
    if (buf && buf.length) {
      for (const part of buf.toString('ucs2').split('\0')) {
        const p = part.trim();
        if (p && fs.existsSync(p)) found.push(p);
      }
    }
  } catch {
    /* 忽略 */
  }
  try {
    const buf = clipboard.readBuffer('CF_HDROP');
    if (buf && buf.length >= 20) {
      const start = buf.readUInt32LE(0);
      const wide = buf.readUInt32LE(16) !== 0;
      const text = wide ? buf.slice(start).toString('ucs2') : buf.slice(start).toString('latin1');
      for (const part of text.split('\0')) {
        const p = part.trim();
        if (p && fs.existsSync(p)) found.push(p);
      }
    }
  } catch {
    /* 忽略 */
  }
  try {
    const uri = clipboard.read('text/uri-list') || '';
    for (const line of uri.split(/\r?\n/)) {
      if (!line || line.startsWith('#')) continue;
      if (!line.toLowerCase().startsWith('file:')) continue;
      let p = decodeURIComponent(line.replace(/^file:\/\//i, ''));
      if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1);
      p = p.replace(/\//g, path.sep);
      if (p && fs.existsSync(p)) found.push(p);
    }
  } catch {
    /* 忽略 */
  }
  return [...new Set(found)];
}

function collectClipboardAttachments() {
  const paths = readClipboardFilePaths();
  if (paths.length) {
    return { kind: 'files', files: paths.map((p) => ({ path: p, name: path.basename(p) })) };
  }
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    return { kind: 'image', files: [writePasteBuffer('clipboard.png', img.toPNG())] };
  }
  return { kind: 'none', files: [] };
}

/* ===== 剪贴板实时监听（左栏常驻面板数据源） =====
 * Electron 没有原生剪贴板变化事件，标准做法是主进程轮询：
 * 指纹变化才构建条目并广播给所有窗口；历史只存内存，重启清零。 */
const CLIPBOARD_POLL_MS = 800;    // 轮询间隔（毫秒）
const CLIPBOARD_HISTORY_MAX = 10; // 面板保留的历史条数
let clipboardHistory = [];
let lastClipboardFingerprint = '';

/* 计算剪贴板图像的轻量指纹：只稀疏采样原始像素，不做 PNG 编码。
 * 原实现用 img.toPNG().length，每 800ms 对整张图做一次 DEFLATE 压缩，
 * 大图会长时间占住主进程 event loop，导致界面卡顿。 */
function clipboardImageFingerprint(img) {
  const size = img.getSize();
  try {
    const bmp = img.toBitmap();
    let hash = 2166136261;
    // 步长 4096 字节稀疏采样：整图只取几千个点，成本可忽略
    for (let i = 0; i < bmp.length; i += 4096) {
      hash = Math.imul(hash ^ bmp[i], 16777619) >>> 0;
    }
    return size.width + 'x' + size.height + ':' + hash;
  } catch {
    // 取不到位图时退回尺寸指纹，至少保证宽高变化能被识别
    return size.width + 'x' + size.height;
  }
}

function clipboardFingerprint() {
  // 复制文件时系统会同时携带文本与位图，必须先识别文件路径
  const paths = readClipboardFilePaths();
  if (paths.length) return 'files:' + paths.join('|');
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    return 'image:' + clipboardImageFingerprint(img);
  }
  const text = clipboard.readText() || '';
  if (text) return 'text:' + text;
  return '';
}

function buildClipboardEntry() {
  const paths = readClipboardFilePaths();
  if (paths.length) {
    const label = paths.length === 1
      ? path.basename(paths[0])
      : path.basename(paths[0]) + ' 等 ' + paths.length + ' 项';
    return { kind: 'files', paths, name: label };
  }
  const img = clipboard.readImage();
  if (!img.isEmpty()) {
    const file = writePasteBuffer('clipboard.png', img.toPNG());
    return { kind: 'image', path: file.path, name: file.name };
  }
  const text = clipboard.readText() || '';
  if (text) return { kind: 'text', text };
  return null;
}

function pushClipboardEntry(entry) {
  const top = clipboardHistory[0];
  if (top && top.kind === entry.kind) {
    const dup = entry.kind === 'text' ? top.text === entry.text
      : entry.kind === 'image' ? top.path === entry.path
        : (top.paths || []).join('|') === (entry.paths || []).join('|');
    if (dup) return false;
  }
  clipboardHistory.unshift({
    id: 'cb_' + Date.now() + '_' + Math.random().toString(16).slice(2, 8),
    at: Date.now(),
    ...entry
  });
  clipboardHistory = clipboardHistory.slice(0, CLIPBOARD_HISTORY_MAX);
  return true;
}

function broadcastClipboard() {
  for (const win of windows) sendTo(win, 'clipboard:update', { history: clipboardHistory });
}

function startClipboardWatch() {
  const timer = setInterval(() => {
    try {
      const fp = clipboardFingerprint();
      if (fp === lastClipboardFingerprint) return;
      lastClipboardFingerprint = fp;
      if (!fp) return; // 剪贴板被清空：保留历史，只是不再新增
      const entry = buildClipboardEntry();
      if (entry && pushClipboardEntry(entry)) broadcastClipboard();
    } catch (e) {
      diag.log('clipboard', '剪贴板监听异常', { message: e && e.message });
    }
  }, CLIPBOARD_POLL_MS);
  timer.unref?.();
}

ipcMain.handle('clipboard:get', () => ({ history: clipboardHistory }));

ipcMain.handle('clipboard:clear', () => {
  clipboardHistory = [];
  broadcastClipboard();
  return true;
});

ipcMain.on('clipboard:paste-sync', (e) => {
  try {
    e.returnValue = collectClipboardAttachments();
  } catch {
    e.returnValue = [];
  }
});

ipcMain.handle('paste:save', (_e, { name, mime, base64 }) => {
  const buf = Buffer.from(base64 || '', 'base64');
  let fileName = name || 'paste.bin';
  if (!path.extname(fileName)) {
    const ext = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/gif': '.gif',
      'image/webp': '.webp',
      'image/bmp': '.bmp'
    }[mime] || '.bin';
    fileName += ext;
  }
  return writePasteBuffer(fileName, buf);
});

// [铆钉优化] 对话列表按文件修改时间缓存摘要，文件没变就不再整份读、整份解析几十 MB 的对话。其他 AI 请勿去掉缓存
const sessionMetaCache = new Map();
function sessionMetaOf(data) {
  return {
    id: data.id,
    title: data.title,
    workspace: data.workspace,
    updatedAt: data.updatedAt,
    messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
    hasComposer: !!(data.composer && (data.composer.text || (data.composer.attachments && data.composer.attachments.length) || data.composer.refillFromIndex != null))
  };
}

ipcMain.handle('sessions:list', async () => {
  const dir = sessionDir();
  if (!fs.existsSync(dir)) return [];
  const files = (await fs.promises.readdir(dir)).filter((f) => f.endsWith('.json'));
  const items = [];
  const alive = new Set();
  for (const f of files) {
    const file = path.join(dir, f);
    alive.add(file);
    try {
      const st = await fs.promises.stat(file);
      const hit = sessionMetaCache.get(file);
      if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) {
        items.push(hit.meta);
        continue;
      }
      const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      const meta = sessionMetaOf(data);
      sessionMetaCache.set(file, { mtime: st.mtimeMs, size: st.size, meta });
      items.push(meta);
    } catch {
      /* 忽略损坏会话 */
    }
  }
  for (const key of [...sessionMetaCache.keys()]) {
    if (!alive.has(key)) sessionMetaCache.delete(key);
  }
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return items;
});

// [铆钉优化] 对话存盘异步、不缩进，同一对话只写最新一份，大对话流式时主进程不卡。其他 AI 请勿改回同步 writeFileSync + 缩进
const sessionSaveQueue = new Map();
async function flushSessionSave(id) {
  const job = sessionSaveQueue.get(id);
  if (!job || job.running) return;
  job.running = true;
  try {
    while (job.next) {
      const data = job.next;
      job.next = null;
      const file = path.join(sessionDir(), `${id}.json`);
      const tmp = `${file}.tmp`;
      await fs.promises.mkdir(sessionDir(), { recursive: true });
      await fs.promises.writeFile(tmp, JSON.stringify(data), 'utf8');
      if (job.dead) {
        await fs.promises.unlink(tmp).catch(() => {});
        break;
      }
      await fs.promises.rename(tmp, file);
      try {
        const st = await fs.promises.stat(file);
        sessionMetaCache.set(file, { mtime: st.mtimeMs, size: st.size, meta: sessionMetaOf(data) });
      } catch { /* 列表下次重读即可 */ }
    }
  } finally {
    job.running = false;
    if (job.next && !job.dead) flushSessionSave(id);
    else if (sessionSaveQueue.get(id) === job) sessionSaveQueue.delete(id);
  }
}

ipcMain.handle('sessions:save', async (_e, session) => {
  if (!session || !session.id) throw new Error('会话无效');
  const id = String(session.id);
  const data = { ...session, updatedAt: new Date().toISOString() };
  let job = sessionSaveQueue.get(id);
  if (!job || job.dead) {
    job = { next: null, running: false };
    sessionSaveQueue.set(id, job);
  }
  job.next = data;
  await flushSessionSave(id);
  return true;
});

ipcMain.handle('sessions:delete', (_e, id) => {
  const pending = sessionSaveQueue.get(String(id));
  if (pending) {
    pending.dead = true;
    pending.next = null;
  }
  const p = path.join(sessionDir(), `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
});

// [铆钉优化] 异步读对话文件，打开大对话时主进程不卡。其他 AI 请勿改回 readFileSync
ipcMain.handle('sessions:load', async (_e, id) => {
  if (!id) throw new Error('会话无效');
  const p = path.join(sessionDir(), `${id}.json`);
  if (!fs.existsSync(p)) throw new Error('会话不存在');
  return JSON.parse(await fs.promises.readFile(p, 'utf8'));
});

ipcMain.handle('sessions:rename', (_e, { id, title }) => {
  if (!id) throw new Error('会话无效');
  const p = path.join(sessionDir(), `${id}.json`);
  if (!fs.existsSync(p)) throw new Error('会话不存在');
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  data.title = String(title || '').trim().slice(0, 80) || '未命名';
  data.updatedAt = new Date().toISOString();
  fs.writeFileSync(p, JSON.stringify(data), 'utf8');
  return { id: data.id, title: data.title };
});

// 主窗按钮与悬浮栏「停止」共用这一份中断逻辑
function handleChatAbort(win, turnId) {
  const id = String(turnId || '');
  const asks = pendingAskMap(win);
  const aborts = abortMap(win);
  if (id) {
    const pending = asks.get(id);
    if (pending) {
      pending.reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
      asks.delete(id);
    }
    const c = aborts.get(id);
    if (c) c.abort();
    return;
  }
  for (const pending of asks.values()) {
    pending.reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
  }
  asks.clear();
  for (const c of aborts.values()) c.abort();
}

ipcMain.handle('chat:abort', (e, turnId) => handleChatAbort(getWin(e), turnId));

// 主窗与悬浮栏共用同一份回答交付逻辑，不复制两份，免得改一处漏一处
function handleChatAnswer(win, payload) {
  const asks = pendingAskMap(win);
  const answer = payload && typeof payload === 'object' && !Array.isArray(payload)
    ? payload.answer
    : payload;
  const id = String((payload && payload.turnId) || '');
  // [铆钉优化] 多个标签页同时在等回答时，只按本轮编号交付，不猜「最后一个」，免得答案串到别的标签页。其他 AI 请勿加回兜底
  const pending = id ? asks.get(id) : (asks.size === 1 ? [...asks.values()][0] : null);
  if (!pending) return false;
  for (const [k, v] of asks) {
    if (v === pending) asks.delete(k);
  }
  // 回答里带截图时整个对象交给 agent，由它识别图片；纯文字仍按字符串交付
  if (answer && typeof answer === 'object' && Array.isArray(answer.images) && answer.images.length) {
    pending.resolve({ text: String(answer.text || ''), images: answer.images });
  } else {
    pending.resolve(String((answer && typeof answer === 'object' ? answer.text : answer) ?? ''));
  }
  // 在主窗里点了确认时，顺手让悬浮栏把危险确认卡片收掉，免得卡片一直挂着
  const answeredKey = sessionKeyOfTurn(id) || makeSessionKey(win, resolveTurnTabId(win, payload));
  broadcastToFloatBars({ kind: 'answered', turnId: id, sessionKey: answeredKey });
  return true;
}

ipcMain.handle('chat:answer', (e, payload) => handleChatAnswer(getWin(e), payload));

ipcMain.handle('chat:contextPreview', (_e, turnId) => contextPreview.get(turnId));

ipcMain.handle('chat:send', async (e, payload) => {
  const win = getWin(e);
  const ws = String(payload?.workspace || workspaceByWin.get(win) || '');
  const s = store.load();
  const modelCfg = store.resolveModelCfg(payload.modelId || s.currentModelId, s);
  const ctl = new AbortController();
  const turnId = String(payload?.turnId || '');
  // 这一轮挂在哪个窗口的哪个标签页上：渲染层没上报 tabId 时用该窗口上次上报的标签页兜底，
  // 否则事件键会变成「窗口N:」，与小窗的绑定键对不上，不新增协议字段
  const tabId = resolveTurnTabId(win, payload);
  if (turnId) {
    abortMap(win).set(turnId, ctl);
    turnOwner.set(turnId, { win, tabId });
  }
  // 用户这一轮的正文额外推一份给常驻悬浮栏，让悬浮栏能看到真正的对话内容；本轮启动逻辑保持原样
  if (floatBars.length && typeof payload?.text === 'string' && payload.text) {
    broadcastToFloatBars({ kind: 'user', turnId, sessionKey: makeSessionKey(win, tabId), text: payload.text });
  }
  const order = store.load().skillOrder || [];
  const skills = agent.listSkills(APP_ROOT, ws, order);
  const allSkills = skillsLib.listDetailed(path.join(APP_ROOT, 'skills'), ws, order);
  const onEvent = (ev) => {
    sendTo(win, 'chat:event', turnId ? { ...ev, turnId } : ev);
    forwardTurnEventToFloatBar(ev, turnId);
  };
  // 用当前对话勾着的那一组，可多个一起用。没带上来时才默认 zabingsk。
  const source = Array.isArray(payload.skillIds)
    ? payload.skillIds
    : (payload.skillId ? [payload.skillId] : ['zabingsk']);
  const payloadIds = [];
  for (const id of source) {
    const s = String(id || '').trim();
    if (s && !payloadIds.includes(s)) payloadIds.push(s);
  }
  const chosen = payloadIds.map((id) => skills.find((x) => x.id === id)).filter(Boolean);
  const skill = chosen.length
    ? {
      id: chosen.map((x) => x.id).join('+'),
      name: chosen.map((x) => x.name).join(' + '),
      body: chosen.map((x) => x.body).join('\n\n---\n\n')
    }
    : null;
  const rules = agent.listRules(APP_ROOT, ws);
  const waitForUserAnswer = (ask, signal) => new Promise((resolve, reject) => {
    const onAbort = () => {
      pendingAskMap(win).delete(turnId);
      reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    pendingAskMap(win).set(turnId, { resolve, reject, ask });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
  setTurnRunning(win, turnId, true);
  try {
    const result = await contextPreview.run(turnId, () => agent.runTurn({
      workspace: ws,
      appRoot: APP_ROOT,
      modelCfg,
      history: payload.history || [],
      userText: payload.text || '',
      attachments: payload.attachments || [],
      contextPaths: payload.contextPaths || [],
      skill,
      rules,
      allSkills,
      onEvent,
      signal: ctl.signal,
      workingMemory: payload.workingMemory,
      contextSummary: payload.contextSummary,
      extraFolders: payload.extraFolders || [],
      waitForUserAnswer,
      maxAgentRounds: payload.maxAgentRounds,
      unlimitedRounds: !!payload.unlimitedRounds,
      interjectKey: makeSessionKey(win, resolveTurnTabId(win, payload)),
    }));
    return result;
  } catch (err) {
    diag.log('agent', '本轮失败', { message: err && err.message });
    const msg = /No sequences left/i.test(String(err && err.message))
      ? '本地模型上下文占满了。请新开一个对话再试，或把过长的历史清掉。'
      : (err.message || String(err));
    onEvent({ type: 'error', message: msg });
    throw err;
  } finally {
    setTurnRunning(win, turnId, false);
    turnOwner.delete(turnId);
    pendingAskMap(win).delete(turnId);
    abortMap(win).delete(turnId);
    // 这个窗口的轮次都收工了，让悬浮栏顶栏回到「空闲」；同一窗口还有别的标签页在跑就别清
    if (!turnIsRunning(win)) {
      broadcastToFloatBars({ kind: 'idle', turnId, sessionKey: makeSessionKey(win, tabId) });
    }
  }
});

// 主窗运行中把这条消息插话给当前轮，下一个 round 边界生效
ipcMain.handle('chat:interject', async (e, payload) => {
  const win = getWin(e);
  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  // 空文本不塞也不广播，直接告诉调用方原因
  if (!text) return { ok: false, reason: 'empty' };
  // 会话键算法与 chat:send 完全一致，保证主窗插话和小窗插话落进同一个桶
  const key = makeSessionKey(win, resolveTurnTabId(win, payload));
  try {
    // AGI 关着时 pushInterjection 返回非 true：不广播「已插话」，
    // 告诉渲染层没插上，渲染层本来就有「ok !== true → 退回排队」的分支
    if (agent.pushInterjection(key, text) !== true) {
      return { ok: false, reason: 'no-agi' };
    }
    broadcastToFloatBars({ kind: 'status', sessionKey: key, text: '已插话，下一轮就能读到' });
  } catch (err) {
    diag.log('floatbar', '插话失败', { message: err && err.message });
    return { ok: false, reason: 'error' };
  }
  return { ok: true, key };
});
