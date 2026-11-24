const {
  app, BrowserWindow, ipcMain, dialog, nativeTheme, clipboard, shell, crashReporter, session, globalShortcut
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
// 在业务模块首次加载前建立稳定导出入口；源码只在用户点击手动重载后经状态交接重新加载。
const hotReload = require('./lib/hot-reload').createHotReload({
  root: path.join(__dirname, '..'),
  canApply: canApplyHotReload,
  notify: notifyHotReload,
  afterReload: restoreHotReloadHooks
});
const store = require('./lib/store');
const externalLinks = require('./lib/external-links');
/** 所有应用窗口创建时接入系统浏览器；隐藏渲染器仍可保留自己拒绝新窗的处理。 */
app.on('web-contents-created', function bindDefaultBrowser(_event, contents) {
  externalLinks.bindExternalLinks(contents);
});
const { mergeCatalogEdits } = require('./lib/model-catalog');
// 每个渲染窗口保留它最后收到的目录快照，用来区分用户编辑和过期的本地副本。
const modelCatalogBySender = new WeakMap();
const snapshot = require('./lib/snapshot');
const agent = require('./lib/agent');
const skillsLib = require('./lib/skills');
const localLlm = require('./lib/local-llm');
const zbaingAi = require('./lib/zbaingAi');
const newZabingAi = require('./lib/newZabingAi');
const diag = require('./lib/diag');
const downloader = require('./lib/downloader');
const hardware = require('./lib/hardware');
const modelMeta = require('./lib/model-meta');
const assembly = require('./lib/assembly');
const { migrateUserData } = require('./lib/migrate-userdata');
const mmprojLib = require('./lib/mmproj');
const visionEngine = require('./lib/vision-engine');
const memoryGlobal = require('./lib/memory-global');
const apiProtocol = require('./lib/api-protocol');
const { applyProxy } = require('./lib/http-fetch');
const milestone = require('./lib/milestone');
const codeIndex = require('./lib/code-index');
const codeEmbed = require('./lib/code-embed');
const desktopHand = require('./lib/desktop-hand');
const contextPreview = require('./lib/context-preview');
const { distillSubmittedRequirements } = require('./lib/composer-requirements');
const trainingArchive = require('./lib/training-recorder');
// 发送前预览：只读拼一遍本轮 system 文本给预览面板，模块内不发模型请求、不写盘
const promptPreview = require('./lib/prompt-preview');
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
/** 稳定窗口身份独立于本次启动的编号；整组退出保留所有打开的窗口及各自标签清单。 */
const windowLayouts = require('./lib/session-layout').createWindowLayouts({
  /** 无参数；返回当前用户数据的窗口登记目录，不受源码或安装包位置变化影响。 */
  directory: function sessionLayoutDirectory() { return path.join(app.getPath('userData'), 'window-layouts'); },
  ownerAlive: pidAlive
});
/** 主窗到其持久化身份的映射；不使用进程槽位或运行时窗口编号作为磁盘身份。 */
const layoutByWin = new WeakMap();
/** 用户请求手动重载后等待全部主窗空闲再重启；交接按稳定窗口身份隔离。 */
const codeRestart = require('./lib/restart-reload').createRestartReload({
  app, argv: process.argv, directory: codeRestartDirectory, windows: codeRestartWindows,
  status: codeRestartStatus, isBusy: codeRestartBusy, canApply: canApplyHotReload,
  notify: notifyHotReload, failed: codeRestartFailed
});
/** 无参数；返回当前用户数据中的一次性交接目录，不依赖安装位置。 */
function codeRestartDirectory() { return path.join(app.getPath('userData'), 'code-reload'); }
/** 无参数；只列出本进程存活的主窗及其稳定身份，不包含桌宠和作品窗。 */
function codeRestartWindows() {
  const owners = [];
  for (const win of windows) if (!win.isDestroyed()) owners.push({ key: layoutByWin.get(win), win });
  return owners;
}
/** 无参数；读取真实候选版本，不将已保存源码当作运行成功。 */
function codeRestartStatus() { return hotReload.status(); }
/** 无参数；返回业务调用、更新预检或失败是否仍阻止自动重启。 */
function codeRestartBusy() { return hotReload.isBusy(); }
/** 接收交接保存或 relaunch 异常；通过原更新通道报告，应用保持运行。 */
function codeRestartFailed(error) { hotReload.rejectRestart(error); }
/** 整体退出期间的关闭事件只释放运行资源，不能移除待恢复的窗口身份。 */
let quitting = false;
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
// 作品主窗入口沿用当前窗口的项目绑定，作品页面自身不持有主窗接口。
require('./lib/artifact-window').registerIpc({
  ipcMain,
  getWorkspace: function artifactWorkspace(event) { return workspaceByWin.get(getWin(event)) || ''; },
  getOwner: getWin
});
/** win -> Map(turnId, AbortController) */
const abortByWin = new WeakMap();
/** win -> Map(turnId, { resolve, reject, ask }) */
const pendingAskByWin = new WeakMap();
const watchByWin = new WeakMap();
/** 每个页面已经确认加载的资源版本，以及 Agent 重建后须恢复的宿主引用。 */
const hotReloadVersions = new WeakMap();
let hotReloadAgentHooks = null;

/** AGI 后台接单只属于开启它的窗口和会话；回执防止无效会话吞掉请求。 */
let screenWatchOwner = null;
let screenWatchDelivery = null;
let screenRequestSeq = 0;
const screenWatcher = require('./lib/agi-screen-watch').createScreenWatcher({
  observe: observeScreenRequest,
  ready: screenRequestReady,
  deliver: deliverScreenRequest,
  interval: screenRequestInterval,
  onError: screenRequestError
});

/** 沿用桌面资源档位间隔，空闲等待不产生任何模型请求。 */
function screenRequestInterval() { return require('./lib/agi-throttle').profile().minGapMs; }
/** 调用独立的前台裁剪 OCR，不刷新工具操作中的坐标帧。 */
function observeScreenRequest() { return require('./lib/screen-text-map').observeForegroundRequest(); }
/** 有轮次运行、会话切换或窗口失效时暂停，避免抢正在执行的任务。 */
function screenRequestReady() {
  const owner = screenWatchOwner;
  if (!owner || owner.win.isDestroyed() || !desktopHand.isAlive() || desktopHand.isBusy()) return false;
  if (lastTabIdByWin.get(owner.win) !== owner.tabId || !workspaceByWin.get(owner.win)) return false;
  for (const turns of runningByWin.values()) if (turns.size) return false;
  return true;
}
/** 识别错误在界面和诊断日志中明确展示；不把错误当作需求提交给模型。 */
function screenRequestError(error) {
  diag.log('desktop', 'AGI 后台接单已停止', { message: error.message });
  if (screenWatchOwner && !screenWatchOwner.win.isDestroyed()) {
    sendTo(screenWatchOwner.win, 'desktop:screen-status', '后台接单已停止：' + error.message);
  }
}
/** 投递一条屏幕需求；等待渲染层入队确认，不触碰输入框里的草稿。 */
function deliverScreenRequest(request) {
  const owner = screenWatchOwner;
  if (!screenRequestReady()) return Promise.resolve(false);
  function accepted(resolve) {
    const id = ++screenRequestSeq;
    screenWatchDelivery = { id, win: owner.win, resolve };
    sendTo(owner.win, 'chat:screen-request', { id, tabId: owner.tabId,
      text: request.text, source: request.source });
  }
  return new Promise(accepted);
}
/** 停止后台观察并结束尚未交付的回执等待；在途 OCR 不再触发任务。 */
function stopScreenRequests() {
  screenWatcher.stop();
  if (screenWatchDelivery) {
    screenWatchDelivery.resolve(false);
    screenWatchDelivery = null;
  }
  screenWatchOwner = null;
}
/** 绑定开启 AGI 的确切会话，不猜测其它窗口或其它项目。 */
function startScreenRequests(win, tabId) {
  stopScreenRequests();
  screenWatchOwner = { win, tabId };
  screenWatcher.start(makeSessionKey(win, tabId));
}

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

/** 长时存活复用既有会话入口；资源只属于绑定窗口，桌面任务全局串行。 */
const longAliveHost = require('./lib/long-alive-host').registerLongAlive({
  app, ipcMain, getWin, send: sendTo, abort: handleChatAbort,
  activeTab: function activeTab(win) { return lastTabIdByWin.get(win); },
  workspace: function workspace(win) { return workspaceByWin.get(win); },
  busy: function busy() {
    if (desktopHand.isBusy()) return true;
    for (const turns of runningByWin.values()) if (turns.size) return true;
    return false;
  },
  turnTab: function turnTab(turnId) { return turnOwner.get(turnId)?.tabId; }
});

function sendTo(win, channel, data) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, data);
}

/** 业务更新等所有窗口轮次和桌面动作空闲，保留仍在运行的任务及会话。 */
function canApplyHotReload() {
  if (runningByWin.size) return false;
  return !desktopHand.isBusy();
}

/** 将真实更新状态送到主窗；已经确认加载的界面版本不重复触发重载。 */
function notifyHotReload(update) {
  codeRestart.observe(update);
  if (update.kind === 'restart') update = Object.assign({}, update, { phase: codeRestart.phase() });
  diag.log('hot-reload', update.message, { kind: update.kind, paths: update.paths, revision: update.revision });
  for (const win of windows) {
    if (update.kind === 'renderer' && (hotReloadVersions.get(win) || 0) >= update.revision) continue;
    sendTo(win, 'app:hot-reload', update);
  }
}

/** Agent 重建后恢复主进程提供的小窗操作引用，其他常驻服务不重建。 */
function restoreHotReloadHooks(files) {
  if (hotReloadAgentHooks && files.includes(path.join(__dirname, 'lib', 'agent.js'))) {
    agent.setFloatBarHooks(hotReloadAgentHooks);
  }
}

/** 初始化补取通知时沿用该窗口已经确认的界面版本，防止刷新循环。 */
ipcMain.handle('app:hotReloadStatus', function hotReloadStatus(event) {
  const update = hotReload.status();
  const win = getWin(event);
  if (update && update.kind === 'renderer' && (hotReloadVersions.get(win) || 0) >= update.revision) return null;
  if (update && update.kind === 'restart') return Object.assign({}, update, { phase: codeRestart.phase() });
  return update;
});

/**
 * 接收主窗口的手动重载请求，校验源码后沿用全部窗口的状态交接。
 * @param {Electron.IpcMainInvokeEvent} event 点击重载按钮的窗口，由发送者核对主窗身份。
 * @returns {{ok:boolean}} 是否接收本次请求；预检失败通过更新通知报告，不退出旧进程。
 */
ipcMain.handle('app:reload', function manualReload(event) {
  const win = getWin(event);
  if (!win || !windows.has(win)) return { ok: false };
  return hotReload.requestReload();
});

/**
 * 渲染层保存临时快照后请求真正重载；主进程再次检查聊天与业务调用。
 * @param {Electron.IpcMainInvokeEvent} event 发起确认的主窗口 IPC，不能替其他窗口登记版本。
 * @param {number} revision 渲染层已经保存快照的预检版本，必须与最新可加载版本一致。
 * @param {object} snapshot 结构性代码重启需要交接的本窗完整状态；普通界面刷新仍使用 sessionStorage。
 * @param {number} phase 自动重启的就绪或最终采集阶段；其他窗口的回执不能替代本窗。
 * @returns {{ok:boolean}} 当前确认是否接受；返回 true 后仍在下一事件循环复核版本和忙状态。
 * IPC 应答先送达旧页面，新保存或错误会取消最终重载并通知页面清除临时快照。
 */
ipcMain.handle('app:hotReloadReady', function hotReloadReady(event, revision, snapshot, phase) {
  const win = getWin(event);
  const update = hotReload.status();
  if (update && update.kind === 'restart') return codeRestart.ready(win, revision, snapshot, phase);
  if (!win || !windows.has(win) || !update || update.kind !== 'renderer' || update.revision !== revision) return { ok: false };
  if (!canApplyHotReload() || hotReload.isBusy()) return { ok: false };
  hotReloadVersions.set(win, revision);
  setImmediate(function reloadIdlePage() {
    if (win.isDestroyed()) return;
    // IPC 确认后仍可能发生保存或预检失败；只允许同一已校验版本最终进入页面重载。
    const latest = hotReload.status();
    if (!latest || latest.kind !== 'renderer' || latest.revision !== revision || !canApplyHotReload() || hotReload.isBusy()) {
      hotReloadVersions.delete(win);
      if (latest) sendTo(win, 'app:hot-reload', latest.kind === 'renderer' ? Object.assign({}, latest, { deferred: true }) : latest);
      return;
    }
    win.webContents.reloadIgnoringCache();
  });
  return { ok: true };
});


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
  if (!on) {
    hotReload.flush();
    const update = hotReload.status();
    if (update && update.kind === 'renderer') notifyHotReload(update);
  }
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

/**
 * 销毁悬浮栏实例并从广播注册表移除，避免主进程长期持有已关闭实例的闭包。
 * @param {object|null} bar 要释放的悬浮栏实例。
 * @returns {void} 无返回值；重复调用安全，正常窗口关闭和应用退出共用此入口。
 */
function destroyFloatBarInstance(bar) {
  if (!bar) return;
  if (typeof bar.destroy === 'function') bar.destroy();
  const index = floatBars.indexOf(bar);
  if (index >= 0) floatBars.splice(index, 1);
  if (floatBar === bar) floatBar = null;
}

/** 余额按来源主窗缓存，切换绑定时恢复该窗口的账户数据；弱引用随主窗释放。 */
const accountQuotaByWin = new WeakMap();

/** 将来源主窗的最新余额发给指定会话；未收到数据时显式显示待同步。 */
function pushAccountQuota(key) {
  const owner = winFromKey(key);
  const snapshot = owner && accountQuotaByWin.has(owner) ? accountQuotaByWin.get(owner) : null;
  broadcastToFloatBars({ kind: 'quota', sessionKey: key, snapshot });
}

/** 接收主窗的展示快照并更新其全部会话，不跨窗口取数或再次请求账户接口。 */
function noteAccountQuota(event, snapshot) {
  const owner = getWin(event);
  if (!owner) return;
  accountQuotaByWin.set(owner, snapshot);
  for (const key of sessionsByKey.keys()) {
    if (winFromKey(key) === owner) pushAccountQuota(key);
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
  pushAccountQuota(key);
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
  // 思考提示与推理增量：桌宠标签要能显示思考全文，不能只剩「正在思考」。
  if (ev.type === 'think' || ev.type === 'reason') {
    if (typeof ev.text === 'string' && ev.text) {
      broadcastToFloatBars({ ...base, kind: ev.type, text: ev.text });
    }
    return;
  }
  if (ev.type === 'tool') {
    const step = String(ev.text || ev.detail || ev.name || '');
    if (step) broadcastToFloatBars({
      ...base, kind: 'tool', text: step,
      name: ev.name, status: ev.status, callId: ev.callId,
      activity: ev.activity, outcome: ev.outcome, activityOnly: ev.activityOnly
    });
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

/**
 * 把补充交给会话当前轮的收件箱。
 * @param {string} key 主窗标签与悬浮窗共用的会话键。
 * @param {string} text 本条插话正文。
 * @param {Array<object>} attachments 已校验的图片附件；允许纯图插话。
 * @returns {boolean} 当前轮接受时返回 true，并通知悬浮窗下一次模型请求会读取。
 */
function deliverChatInterjection(key, text, attachments) {
  if (!agent.pushInterjection(key, text, attachments)) return false;
  broadcastToFloatBars({ kind: 'status', sessionKey: key, text: '插话已接收，下一次模型请求将读取' });
  return true;
}

/**
 * 按悬浮窗绑定的会话键转交正文和图片。
 * @param {object} payload 本次提交的会话键、正文和图片列表。
 * @returns {void} 有活动收件箱时提交插话并通知主窗存档，其余请求交给原队列。
 */
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
    broadcastToFloatBars({ kind: 'error', text: '宠物还没绑定对话，先在主窗里打开一个对话' });
    return;
  }
  const target = winFromKey(key);
  if (!target) {
    broadcastToFloatBars({ kind: 'error', sessionKey: key, text: '对应的主界面已关闭，这条没发出去' });
    return;
  }
  // 小窗只显示附件数量，主窗绑定标签收到真实附件路径和预览地址。
  const userText = attList.length > 0 ? msg + `（附 ${attList.length} 张图）` : msg;
  broadcastToFloatBars({ kind: 'user', sessionKey: key, text: userText, images: attList.map(function attachmentPath(att) { return att.path; }) });
  const interjection = deliverChatInterjection(key, msg, attList);
  sendTo(target, 'chat:float-user-message', {
    tabId: key.slice(key.indexOf(':') + 1),
    text: msg,
    attachments: attList,
    images: attList.map(function imageUrl(att) { return require('url').pathToFileURL(att.path).href; }),
    interjection
  });
  if (!interjection && turnIsRunning(target)) {
    broadcastToFloatBars({ kind: 'status', sessionKey: key, text: '需求已交给绑定会话，任务结束后按队列处理' });
  }
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

/**
 * 创建主窗并绑定独立的持久化清单身份及本次运行编号。
 * @param {string} layoutId 冷启动恢复的稳定身份；省略时为用户新开的窗口分配新身份。
 * @returns {BrowserWindow} 已开始加载生产界面的窗口，关闭时同步登记是否仍需恢复。
 */
function createWindow(layoutId) {
  const layout = layoutId === undefined ? windowLayouts.create() : layoutId;
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
  layoutByWin.set(win, layout);
  winById.set(winId, win);
  windows.add(win);
  // 新窗口本来就读取当前磁盘资源，无须为此前已经发布的版本再重载一次。
  const initialHotVersion = hotReload.status();
  if (initialHotVersion && initialHotVersion.kind === 'renderer') hotReloadVersions.set(win, initialHotVersion.revision);
  workspaceByWin.set(win, '');
  win.on('closed', () => {
    diag.log('window', '窗口已关闭');
    windowLayouts.close(layout, quitting || windows.size === 1);
    longAliveHost.release(win);
    if (screenWatchOwner && screenWatchOwner.win === win) stopScreenRequests();
    stopWorkspaceWatch(win);
    windows.delete(win);
    codeRestart.check();
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
    if (windows.size === 0 && floatBar) destroyFloatBarInstance(floatBar);
  });
  win.on('unresponsive', () => diag.log('window', '窗口无响应'));
  win.on('responsive', () => diag.log('window', '窗口恢复响应'));
  win.webContents.on('render-process-gone', function rendererGone(_e, details) {
    longAliveHost.release(win);
    diag.log('crash', '渲染进程退出', details);
  });
  // 真实页面重载前释放旧调度；恢复页面后由绑定入口重新加载配置。
  win.webContents.on('did-start-loading', function releaseLongAlive() { longAliveHost.release(win); });
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

/** 界面真正恢复交接状态后才消费对应快照；IPC 不能指定别的窗口身份。 */
ipcMain.handle('app:hotReloadRestored', function hotReloadRestored(event) {
  const win = getWin(event);
  codeRestart.restored(layoutByWin.get(win));
  return true;
});

/**
 * 冷启动或重新激活时按稳定身份恢复原窗口组。
 * 无参数；首次启动没有登记时创建新主窗，有登记时按原顺序创建对应窗口。
 * @returns {void} 各主窗自行加载其标签清单；登记读取失败直接报告，不用另一窗口的数据代替。
 */
function restoreWindows() {
  const layouts = windowLayouts.restore(codeRestart.layouts());
  if (!layouts.length) createWindow();
  else {
    for (const layout of layouts) createWindow(layout);
  }
}

function getWin(e) {
  return BrowserWindow.fromWebContents(e.sender);
}

/** 返回用户设置及当前显示主题，并派生视频候选项供界面选择；不写入用户配置。 */
function settingsWithTheme() {
  const s = store.load();
  // 厂商派生的视频选项只给界面选择，密钥仍留在厂商配置中。
  return { ...s, resolvedTheme: store.resolveTheme(s.theme), videoProviderModels: require('./lib/mxapi').videoModels(s.providers) };
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
  quitting = true;
  hotReload.close();
  diag.log('app', '收到退出请求 before-quit');
  longAliveHost.dispose();
  downloader.cancelAll();
  try { visionEngine.stop(); } catch { /* 退出时忽略 */ }
});
app.on('will-quit', () => {
  try { globalShortcut.unregisterAll(); } catch { /* 退出时忽略 */ }
  if (floatBar) destroyFloatBarInstance(floatBar);
  releaseFloatBarSlot();
  diag.log('app', '即将退出 will-quit');
});
app.on('quit', (_e, code) => diag.log('app', '已退出 quit', { code }));

ipcMain.on('log:client', (_e, payload) => {
  diag.log('renderer', (payload && payload.message) || '界面异常', payload && payload.detail);
});
ipcMain.on('log:summary-trace', (_e, payload) => {
  const fields = ['stage', 'tabId', 'turnId', 'msgIndex', 'textLength', 'revealLength', 'finalTextLength', 'incomingLength', 'renderTargetFound', 'renderingMode', 'renderedLength'];
  const metadata = {};
  for (const key of fields) {
    if (payload && Object.prototype.hasOwnProperty.call(payload, key)) metadata[key] = payload[key];
  }
  diag.log('summary-render', '总结渲染链路', metadata);
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
  ipcMain.on('floatbar:account-quota', noteAccountQuota);
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
    // 持久化的 AGI 开关开启时，等真实会话恢复完成再绑定后台接单。
    if (!screenWatchOwner && store.load().desktopAlive) startScreenRequests(win, tabId);
    lastActiveKey = key;
    sessionsByKey.set(key, `窗口${wid} · ${title || '对话'}`);
    // 先公布存活集合，再投递新会话状态，避免首条消息被当作已关闭会话丢弃。
    broadcastSessions();
    // 只有主窗真的开工（active=true）才把绑定切过来；单纯切标签只更新会话清单，不抢绑定
    if (payload && payload.active === true) {
      boundKey = key;
      console.log('[floatbar] 主窗开工，小窗切到会话 ' + key);
      for (const bar of floatBars) {
        if (bar && typeof bar.setBoundKey === 'function') bar.setBoundKey(key);
      }
      pushStartReady(key);
    }
  }
  /** 关闭标签时释放该主窗的会话登记与开始选项；广播使桌宠同步回收历史和余额。 */
  function forgetWindowSession(event, tabId) {
    const win = getWin(event);
    const key = makeSessionKey(win, String(tabId));
    sessionsByKey.delete(key);
    canStartByKey.delete(key);
    if (boundKey === key) boundKey = '';
    if (lastActiveKey === key) lastActiveKey = '';
    if (lastTabIdByWin.get(win) === String(tabId)) lastTabIdByWin.delete(win);
    broadcastSessions();
  }
  ipcMain.on('floatbar:forget-session', forgetWindowSession);
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

// 当前是否还有角色在用 Cursor 模型：大脑是 Cursor 模型，或当前这套组合的槽位指向 Cursor 模型。
// 都没在用就既不预热、也不留直通会话，免得在 Cursor 那边一直挂着
function cursorInUse(s) {
  const models = s.models || [];
  const isCursorModel = (m) => {
    if (!m || m.type === 'local') return false;
    const p = (s.providers || []).find((x) => x && x.id === m.providerId);
    return !!p && apiProtocol.normalizeProtocol(p.protocol) === 'cursor';
  };
  if (isCursorModel(models.find((m) => m && m.id === s.currentModelId))) return true;
  const slots = assembly.slotsOf(s);
  for (const slot of slots) {
    if (!slot) continue;
    if (apiProtocol.normalizeProtocol(slot.protocol) === 'cursor') return true;
    if (isCursorModel(models.find((m) => m && m.id === slot.apiId))) return true;
  }
  return false;
}

function codexInUse(s) {
  const models = s.models || [];
  const isCodexModel = (m) => {
    if (!m || m.type === 'local') return false;
    const p = (s.providers || []).find((x) => x && x.id === m.providerId);
    return !!p && apiProtocol.normalizeProtocol(p.protocol) === 'codex';
  };
  if (isCodexModel(models.find((m) => m && m.id === s.currentModelId))) return true;
  return assembly.slotsOf(s).some((slot) => slot && (
    apiProtocol.normalizeProtocol(slot.protocol) === 'codex'
    || isCodexModel(models.find((m) => m && m.id === slot.apiId))
  ));
}

function claudeInUse(s) {
  const models = s.models || [];
  const isClaudeModel = (m) => {
    if (!m || m.type === 'local') return false;
    const p = (s.providers || []).find((x) => x && x.id === m.providerId);
    return !!p && apiProtocol.normalizeProtocol(p.protocol) === 'claudecode';
  };
  if (isClaudeModel(models.find((m) => m && m.id === s.currentModelId))) return true;
  return assembly.slotsOf(s).some((slot) => slot && (
    apiProtocol.normalizeProtocol(slot.protocol) === 'claudecode'
    || isClaudeModel(models.find((m) => m && m.id === slot.apiId))
  ));
}

function grokInUse(s) {
  const models = s.models || [];
  const isGrokModel = (m) => {
    if (!m || m.type === 'local') return false;
    const p = (s.providers || []).find((x) => x && x.id === m.providerId);
    return !!p && apiProtocol.normalizeProtocol(p.protocol) === 'grok';
  };
  if (isGrokModel(models.find((m) => m && m.id === s.currentModelId))) return true;
  return assembly.slotsOf(s).some((slot) => slot && (
    apiProtocol.normalizeProtocol(slot.protocol) === 'grok'
    || isGrokModel(models.find((m) => m && m.id === slot.apiId))
  ));
}


// 配了 Cursor 厂商就在后台预热 SDK，省掉第一次调用的冷启动；等主窗先起来再跑
function warmUpCursor() {
  try {
    const s = store.load();
    // 这个进程里没人用 Cursor 就不连过去
    if (!cursorInUse(s)) return;
    const prov = (s.providers || []).find((p) => p && p.protocol === 'cursor');
    if (!prov) return;
    const m = (s.models || []).find((x) => x && x.providerId === prov.id && x.model);
    setTimeout(() => {
      require('./lib/cursor-model').warmUp({ apiKey: prov.apiKey, model: m?.model })
        .then((r) => diag.log('cursor', 'Cursor 预热结束', r));
    }, 3000);
  } catch (e) {
    diag.log('cursor', 'Cursor 预热失败', { message: e && e.message });
  }
}

// 模型配置改完立刻对齐：还在用 Cursor 就预热，不用了就把残留的直通会话断掉
function syncCursorDirect() {
  try {
    const s = store.load();
    if (cursorInUse(s)) warmUpCursor();
    else require('./lib/cursor-direct').closeIdle();
    if (!codexInUse(s)) require('./lib/codex-direct').closeIdle();
    if (!claudeInUse(s)) require('./lib/claude-direct').closeIdle();
    if (!grokInUse(s)) require('./lib/grok-direct').closeIdle();
  } catch (e) {
    diag.log('cursor', 'Cursor 直通会话整理失败', { message: e && e.message });
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
  restoreWindows();
  warmUpCursor();
  // 全局快捷键直接控制屏幕上的独立输入框，不依赖宠物可见。
  try {
    shortcutOk = globalShortcut.register('CommandOrControl+Alt+Space', function () {
      // 全局快捷键只控制独立输入窗，不改变宠物和主窗「小窗」按钮的状态。
      if (floatBar) floatBar.toggleInput();
    });
    if (!shortcutOk) diag.log('floatbar', '独立输入框快捷键 Ctrl+Alt+Space 注册失败，可能已被别的程序占用');
  } catch (e) {
    shortcutOk = false;
    diag.log('floatbar', '全局快捷键注册异常', { message: e && e.message });
  }
  mySlot = claimFloatBarSlot();
  diag.log('floatbar', `本进程占用悬浮栏槽位 slot-${mySlot}`, { pid: process.pid });
  // 常驻置顶悬浮栏：回调都是主进程已有的逻辑，窗口自己收在 lib/float-bar.js 里
  /** 创建当前进程的悬浮栏；macOS 全部窗口关闭后重新激活时复用同一初始化路径。 */
  function createPrimaryFloatBar() {
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
  }
  createPrimaryFloatBar();
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
    hotReloadAgentHooks = {
      move: function move(place) { return moveFloatBarsToPlace(place); },
      rects: function rects() { return floatBarRects(); }
    };
    agent.setFloatBarHooks(hotReloadAgentHooks);
  } else {
    diag.log('floatbar', 'agent 模块没有 setFloatBarHooks，AGI 挪小窗能力未注册');
  }
  // 小窗刚起来时先给它一份已有会话清单，免得等下一次变更才知道有什么可绑
  broadcastSessions();
  startClipboardWatch();
  if (store.load().desktopAlive) desktopHand.setAlive(true);
  // 程序源码不再注册自动监听；保存 electron、renderer 或包清单不会自动应用代码或重启。
  // 外置技能与规则仅刷新资料，下一次请求读取新正文，不触发页面重载。
  const hotReloadDirectories = [
    { path: path.join(APP_ROOT, 'skills'), kind: 'data' },
    { path: path.join(APP_ROOT, 'rules'), kind: 'data' }
  ];
  hotReload.start(hotReloadDirectories);
  app.on('activate', function activateWindows() {
    if (BrowserWindow.getAllWindows().length !== 0) return;
    restoreWindows();
    createPrimaryFloatBar();
    broadcastSessions();
  });
});

app.on('window-all-closed', () => {
  diag.log('app', '所有窗口已关闭');
  stopScreenRequests();
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

/**
 * 返回请求窗口的设置、工作区及稳定标签清单键。
 * @param {Electron.IpcMainInvokeEvent} e 界面请求事件，用发送者定位对应主窗。
 * @returns {Promise<object>} 带当前窗口清单键的设置快照；不从运行编号猜测其他窗口的标签。
 */
ipcMain.handle('app:state', async function appState(e) {
  const win = getWin(e);
  const s = settingsWithTheme();
  modelCatalogBySender.set(e.sender, structuredClone({ models: s.models, providers: s.providers }));
  const modelsDir = modelsDirOf(s);
  return {
    ...s,
    modelsDir,
    workspace: workspaceByWin.get(win) || '',
    // 清单绑定跨重启保留的窗口身份，运行编号和多开进程槽位变化不会读到其他窗口的清单。
    sessionLayoutKey: `spcode:open-tabs:${layoutByWin.get(win)}`,
    codeReloadSnapshot: codeRestart.snapshot(layoutByWin.get(win)),
    appRoot: APP_ROOT,
    localFiles: listLocalFilesEnriched(modelsDir),
    assemblyKey: assembly.assemblyKey(s)
  };
});

/**
 * 保存界面请求的自动保存开关。
 * @param {Electron.IpcMainInvokeEvent} event 请求来源，由Electron传入，不改变其他窗口的内存状态。
 * @param {boolean} enabled 用户在界面选择的开关值。
 * @returns {boolean} 返回实际写入设置的值；标签与会话内容由调用方在开启后使用原保存入口落盘。
 */
ipcMain.handle('app:autoSave', function setAutoSave(event, enabled) {
  const settings = store.load();
  settings.autoSave = enabled;
  store.save(settings);
  return settings.autoSave;
});

/** 保存引导完成状态；只更新该标记，不改已有模型、供应商或会话。 */
ipcMain.handle('app:completeOnboarding', function completeOnboarding() {
  const s = store.load();
  s.onboardingCompleted = true;
  store.save(s);
  return true;
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

/** 保存用户选择的本地生图参数；共享校验失败时不写入设置。 */
ipcMain.handle('app:localImageGeneration', function saveLocalImageGeneration(_event, raw) {
  const options = require('./lib/image-gen-options').normalize(raw);
  const settings = store.load();
  settings.localImageGeneration = options;
  store.save(settings);
  return options;
});

// 用户点「写入方案」：把这条回复里的【方案】段写进本会话的方案文件
ipcMain.handle('dialog:index', (_e, payload) => agent.makeDialogIndex({
  userText: String(payload?.userText || ''),
  assistantText: String(payload?.assistantText || ''),
  modelId: String(payload?.modelId || '')
}));

ipcMain.handle('plan:write', (e, payload) => {
  const ws = String(payload?.workspace || workspaceByWin.get(getWin(e)) || '');
  return agent.writePlanFromChat({ workspace: ws, tabId: String(payload?.tabId || ''), text: String(payload?.text || '') });
});

ipcMain.handle('plan:tree', (e, payload) => {
  const ws = String(payload?.workspace || workspaceByWin.get(getWin(e)) || '');
  return agent.readPlanTree({ workspace: ws, tabId: String(payload?.tabId || '') });
});

// 参考资料按会话识别并持久化；注册层使用同一会话目录，不改变附件发送语义。
require('./lib/reference-tree').register({ ipcMain, sessionDir });

/**
 * 链路导图回读：按会话（tabId）与回复（turnId）取回已落盘的链路图。
 * 参数 payload：{ workspace?, tabId, turnId }；workspace 缺省时用当前窗口绑定的工作目录。
 * 返回 agent.readChainMap 的导图契约（nodes/edges 等），重开程序后前端仍可重绘链路图。
 * 这里只做转发，不做兜底：读盘异常照常抛给前端，避免掩盖链路数据缺失。
 */
ipcMain.handle('chain:tree', (e, payload) => {
  const ws = String(payload?.workspace || workspaceByWin.get(getWin(e)) || '');
  return agent.readChainMap({ workspace: ws, tabId: String(payload?.tabId || ''), turnId: String(payload?.turnId || '') });
});

// 删除方案条目：删除是用户自己的操作，方案锁不拦用户，删除后返回 {ok, notFound/map}
ipcMain.handle('plan:remove', (e, payload) => {
  const ws = String(payload?.workspace || workspaceByWin.get(getWin(e)) || '');
  return agent.removePlanItem({ workspace: ws, tabId: String(payload?.tabId || ''), no: payload?.no });
});

/**
 * 清空整个方案导图：把 plan-tree.js 的方案文件整体清掉（走 agent.clearPlanMap）。
 * 参数 payload：{ workspace?, tabId }；workspace 缺省时用当前窗口绑定的工作目录。
 * 返回 agent.clearPlanMap 的结果，前端据此判断是否需要重绘空导图。
 * 这里只做转发，不做兜底：清空失败/解析异常照常抛给前端，避免假装已清空。
 */
ipcMain.handle('plan:clear', (e, payload) => {
  const ws = String(payload?.workspace || workspaceByWin.get(getWin(e)) || '');
  return agent.clearPlanMap({ workspace: ws, tabId: String(payload?.tabId || '') });
});

ipcMain.handle('app:cursorDirect', (_e, on) => {
  const s = store.load();
  s.cursorDirect = !!on;
  store.save(s);
  return s.cursorDirect;
});

/** AGI 开启后监听当前会话的屏幕需求，不再需要额外的“开始”操作。 */
ipcMain.handle('desktop:setAlive', function setDesktopAlive(e, on, tabId) {
  const s = store.load();
  s.desktopAlive = !!on;
  store.save(s);
  desktopHand.setAlive(s.desktopAlive);
  if (s.desktopAlive && tabId) startScreenRequests(getWin(e), String(tabId));
  else stopScreenRequests();
  return s.desktopAlive;
});
/** 只接受接单目标窗口的回执，防止其它窗口误认领请求。 */
ipcMain.on('desktop:screen-result', function screenRequestResult(e, id, accepted) {
  const delivery = screenWatchDelivery;
  if (!delivery || delivery.id !== id || delivery.win !== getWin(e)) return;
  screenWatchDelivery = null;
  delivery.resolve(accepted === true);
});

ipcMain.handle('window:new', () => {
  createWindow();
});

/**
 * 为发起请求的主窗口恢复键盘焦点。
 * @param {Electron.IpcMainInvokeEvent} e 请求来源，用于定位所属窗口。
 * @param {boolean} restoreAfterDialog 仅原生提示框关闭后请求重置原生激活，普通面板关闭不重置。
 * @returns {boolean} 窗口已在前台时返回 true；窗口失效或刚请求激活时返回 false。
 * 原生错误弹窗关闭后，窗口与网页焦点标记可能仍为 true，实际文档却无法接收键盘；
 * 只在该弹窗恢复请求且窗口已在前台时重新激活，避免普通启动和面板关闭造成焦点闪断。
 */
ipcMain.handle('window:focus', function focusMainWindow(e, restoreAfterDialog) {
  const win = getWin(e);
  if (!win || win.isDestroyed()) return false;
  if (win.isFocused() && restoreAfterDialog === true) {
    // 原生 alert 会留下失配的焦点标记，必须先释放窗口焦点，才会重新触发网页的原生聚焦。
    win.blur();
    win.focus();
    win.webContents.focus();
    return true;
  }
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

// 用户展开单个地图条目时才取源码；这里只读本地文件，不触发模型调用。
ipcMain.handle('index:sourceItem', (e, request) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  return codeIndex.sourceItem(ws, [], request || {});
});

/** 读取发起窗口当前项目的扫描忽略清单，首次绘制之前也可配置。 */
ipcMain.handle('index:getIgnoredFolders', function getMapIgnoredFolders(e) {
  return codeIndex.getIgnoredFolders(workspaceByWin.get(getWin(e)));
});

/** 将单条目录选择应用到原项目；选择对话框打开期间切换项目时拒绝写入。 */
ipcMain.handle('index:changeIgnoredFolder', function changeMapIgnoredFolder(e, expected, folder, ignored, extra) {
  const ws = workspaceByWin.get(getWin(e));
  if (!ws || ws !== expected) throw new Error('当前项目已切换，请重新打开设置');
  return codeIndex.changeIgnoredFolder(ws, folder, ignored, extra);
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
  // 筛选只保存显示范围，不能隐式触发付费归纳。
  return saved;
});

ipcMain.handle('index:summarizeOne', (e, id) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws || !codeIndex.summarizeOne) return Promise.resolve({ ok: false, reason: 'no-map' });
  const s = store.load();
  const summary = assembly.resolveRole(s, 'summary');
  const modelCfg = (summary?.slot && assembly.slotToModelCfg(summary.slot, s)) || store.resolveModelCfg(s.currentModelId, s);
  if (!modelCfg) return Promise.resolve({ ok: false, reason: 'no-model' });
  return codeIndex.summarizeOne(ws, id, modelCfg);
});

ipcMain.handle('index:summarize', (e) => {
  const ws = workspaceByWin.get(getWin(e)) || '';
  if (!ws || !codeIndex.summarizeIncludes || !codeIndex.getInclude) return { ok: false };
  const inc = codeIndex.getInclude(ws);
  if (!inc || !inc.initialized || !inc.includes || !inc.includes.length) return { ok: false, reason: 'no-include' };
  const s = store.load();
  const summary = assembly.resolveRole(s, 'summary');
  const modelCfg = (summary?.slot && assembly.slotToModelCfg(summary.slot, s)) || store.resolveModelCfg(s.currentModelId, s);
  if (!modelCfg) return { ok: false, reason: 'no-model' };
  return codeIndex.summarizeIncludes(ws, inc.includes, modelCfg)
    .catch((err) => {
      diag.log('map', '方法归纳失败', { message: err && err.message });
      return { ok: false, reason: 'fail' };
    });
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

/**
 * 用系统默认程序打开用户从文件树或对话正文点击的本地文件。
 * 相对路径按发送窗口的项目解析，绝对路径沿用原值；系统拒绝时原样返回错误。
 * @returns {Promise<true>} 系统成功打开文件时兑现为 true；路径解析或系统启动失败时拒绝。
 */
ipcMain.handle('shell:openFile', async function openWorkspaceFile(event, rel) {
  const ws = workspaceByWin.get(getWin(event)) || '';
  if (!ws && !isAbsPath(rel)) throw new Error('未打开项目');
  const abs = resolveRead(ws, extraRoots(APP_ROOT, ws), rel);
  const error = await shell.openPath(abs);
  if (error) throw new Error(error);
  return true;
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

ipcMain.handle('models:save', (e, payload) => {
  const s = store.load();
  const models = payload?.models;
  const providers = payload?.providers;
  const currentModelId = payload?.currentModelId;
  const baseline = modelCatalogBySender.get(e.sender);
  // 窗口通过 app:state 取得目录后才能编辑；缺少快照时拒绝整表覆盖，避免误删其他窗口的模型。
  if (!baseline) throw new Error('模型目录尚未加载，请重新打开窗口后再保存。');
  if (Array.isArray(providers)) {
    const editedProviders = mergeCatalogEdits(s.providers, baseline.providers, providers);
    s.providers = editedProviders.map(store.normalizeProvider).filter(Boolean);
  }
  if (Array.isArray(models)) {
    const editedModels = mergeCatalogEdits(s.models, baseline.models, models);
    const migrated = store.migrateProvidersAndModels({
      providers: s.providers,
      models: editedModels
    });
    s.providers = migrated.providers;
    s.models = migrated.models;
  }
  if (currentModelId != null) s.currentModelId = currentModelId;
  if (!s.models.some((m) => m.id === s.currentModelId)) {
    s.currentModelId = s.models[0]?.id || 'local-gguf';
  }
  store.save(s);
  modelCatalogBySender.set(e.sender, structuredClone({ models: s.models, providers: s.providers }));
  syncCursorDirect();
  return { models: s.models, providers: s.providers, currentModelId: s.currentModelId, videoProviderModels: require('./lib/mxapi').videoModels(s.providers) };
});

/** 读取厂商目录中真实支持的推理档位；本地和未接入的协议不发送额外参数。 */
ipcMain.handle('models:reasoningOptions', async function modelReasoningOptions(_event, id) {
  const settings = store.load();
  const cfg = store.resolveModelCfg(id, settings);
  if (!cfg) throw new Error('模型已不存在');
  if (cfg.type !== 'api' || !['codex', 'cursor', 'openai'].includes(cfg.protocol || 'openai')) return [];
  const result = await apiProtocol.listModels(cfg);
  return result.catalog[cfg.model]?.reasoningOptions || [];
});

ipcMain.handle('providers:presets', () => store.PROVIDER_PRESETS);

ipcMain.handle('models:saveAssembly', (_e, { key, slots }) => {
  const s = store.load();
  s.assemblies = s.assemblies && typeof s.assemblies === 'object' ? s.assemblies : {};
  const k = String(key || assembly.assemblyKey(s));
  s.assemblies[k] = { slots: Array.isArray(slots) ? slots : [] };
  assembly.syncVisionFields(s, s.assemblies[k].slots);
  store.save(s);
  syncCursorDirect();
  return { key: k, slots: s.assemblies[k].slots };
});

ipcMain.handle('models:saveCapabilityDefaults', (_e, payload) => {
  const s = store.load();
  s.capabilityDefaults = assembly.normalizeCapabilityDefaults(payload || {});
  store.save(s);
  syncCursorDirect();
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
  else if (modelCfg?.id && !modelCfg.baseUrl && modelCfg.type !== 'local' && modelCfg.type !== 'zbaingAi' && modelCfg.type !== 'NewZabingAi') {
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
  if (cfg?.type === 'NewZabingAi' || cfg?.id === 'NewZabingAi') {
    return newZabingAi.probe(cfg);
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

/**
 * 还原用户确认的整份快照。
 * @param {object} _e IPC 发送事件；项目由用户打开确认框时捕获。
 * @param {{id: string, workspace: string}} payload 快照编号与所属工作区。
 * @returns {object} 实际处理结果；缺少工作区或还原失败时拒绝 IPC 请求。
 */
ipcMain.handle('snapshot:restore', function restoreOwnedSnapshot(_e, payload) {
  if (!payload.workspace) throw new Error('未选择工作目录');
  return snapshot.restore(payload.workspace, payload.id);
});

/**
 * 只还原用户选中的文件，通过专用通道避免旧主进程把单文件请求当成整份还原。
 * @param {object} _e IPC 发送事件；项目由历史快照的确认动作捕获。
 * @param {{id: string, workspace: string, path: string}} payload 快照编号、项目目录和所选文件相对路径。
 * @returns {object} 单文件处理结果；缺少文件路径或文件不在快照中时拒绝 IPC 请求。
 */
ipcMain.handle('snapshot:restoreFile', function restoreOwnedSnapshotFile(_e, payload) {
  if (!payload.workspace) throw new Error('未选择工作目录');
  if (typeof payload.path !== 'string' || !payload.path) throw new Error('未选择要还原的文件');
  return snapshot.restore(payload.workspace, payload.id, payload.path);
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
// 草稿走独立小文件，打字不再经 IPC 复制和重存整份历史。
const sessionComposers = require('./lib/session-composer').createComposerStore(sessionDir);
/**
 * 生成历史清单与缓存共用的轻量会话摘要。
 * @param {object} data 完整会话存档或独立草稿记录；未提交草稿只影响 hasComposer，不作为需求候选。
 * @returns {object} 原有历史元数据及已提交需求的正文、频次和最近索引，不携带助手回复。
 * 清单首次读盘和完整会话保存后都走这里，预测摘要随现有修改时间缓存更新，不新增全文 IPC。
 */
function sessionMetaOf(data) {
  return {
    id: data.id,
    title: data.title,
    workspace: data.workspace,
    updatedAt: data.updatedAt,
    messageCount: Array.isArray(data.messages) ? data.messages.length : 0,
    hasComposer: !!(data.composer && (data.composer.text || (data.composer.attachments && data.composer.attachments.length) || data.composer.refillFromIndex != null)),
    requirements: distillSubmittedRequirements(data)
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
        items.push({ ...hit.meta });
        continue;
      }
      const data = JSON.parse(await fs.promises.readFile(file, 'utf8'));
      const meta = sessionMetaOf(data);
      sessionMetaCache.set(file, { mtime: st.mtimeMs, size: st.size, meta });
      items.push({ ...meta });
    } catch {
      /* 忽略损坏会话 */
    }
  }
  for (const key of [...sessionMetaCache.keys()]) {
    if (!alive.has(key)) sessionMetaCache.delete(key);
  }
  // 草稿覆盖保存的输入状态；只有草稿的新对话也须在重开项目时恢复。
  const drafts = await sessionComposers.list();
  for (const draft of drafts) {
    const item = items.find(function sameSession(meta) { return meta.id === draft.id; });
    const hasComposer = sessionMetaOf(draft).hasComposer;
    if (item) {
      item.hasComposer = hasComposer;
      if (draft.updatedAt > item.updatedAt) item.updatedAt = draft.updatedAt;
    } else if (hasComposer) {
      items.push(sessionMetaOf(draft));
    }
  }
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return items;
});

// [铆钉优化] 对话存盘异步、不缩进，同一对话只写最新一份，大对话流式时主进程不卡。其他 AI 请勿改回同步 writeFileSync + 缩进
const sessionSaveQueue = new Map();
function flushSessionSave(id) {
  const job = sessionSaveQueue.get(id);
  if (!job) return Promise.resolve();
  // 重叠保存共享同一排空任务；删除历史的调用必须等到自己的新存档真正落盘。
  if (job.pending) return job.pending;
  job.running = true;
  job.pending = (async () => {
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
      if (sessionSaveQueue.get(id) === job) sessionSaveQueue.delete(id);
    }
  })();
  return job.pending;
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
  // 在完整保存入口立即登记草稿顺序，较晚到达的输入保存不得被旧正文覆盖。
  await Promise.all([flushSessionSave(id), sessionComposers.save(data)]);
  return true;
});

/** 高频输入仅保存草稿；会话正文仍由原有完整保存和流式保存负责。 */
ipcMain.handle('sessions:saveComposer', async function saveComposer(_e, draft) {
  if (!draft || !draft.id) throw new Error('会话无效');
  await sessionComposers.save({ ...draft, updatedAt: new Date().toISOString() });
  return true;
});

ipcMain.handle('sessions:delete', async (_e, id) => {
  const pending = sessionSaveQueue.get(String(id));
  if (pending) {
    pending.dead = true;
    pending.next = null;
  }
  const p = path.join(sessionDir(), `${id}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  await sessionComposers.remove(id);
  return true;
});

// [铆钉优化] 异步读对话文件，打开大对话时主进程不卡。其他 AI 请勿改回 readFileSync
ipcMain.handle('sessions:load', async (_e, id) => {
  if (!id) throw new Error('会话无效');
  const p = path.join(sessionDir(), `${id}.json`);
  const draft = await sessionComposers.load(id);
  if (!fs.existsSync(p)) {
    if (draft) return { ...draft, messages: [] };
    throw new Error('会话不存在');
  }
  const data = JSON.parse(await fs.promises.readFile(p, 'utf8'));
  if (draft) data.composer = draft.composer;
  return data;
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
  longAliveHost.stopForAbort(win, turnId);
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
  if (pending.archive) pending.archive.record('user-answer', { answer });
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

// 发送前预览：按 chat:send 同一批来源，在本地只读地把本轮要发给模型的 system 文本拼一遍。
// 只读文件，不落盘、不发模型请求；预览面板里的改动只用于展示，不写回磁盘，也不改变真正发送的内容。
ipcMain.handle('chat:promptPreview', (e, payload) => {
  const win = getWin(e);
  // 工作区与模型取值和 chat:send 完全同一口径：渲染层没上报工作区时用该窗口上次上报的
  const ws = String(payload?.workspace || workspaceByWin.get(win) || '');
  const s = store.load();
  const modelCfg = store.resolveModelCfg(payload.modelId || s.currentModelId, s);
  const order = s.skillOrder || [];
  const skills = agent.listSkills(APP_ROOT, ws, order);
  const allSkills = skillsLib.listDetailed(path.join(APP_ROOT, 'skills'), ws, order);
  const rules = agent.listRules(APP_ROOT, ws);
  // 勾中的技能按点选顺序合成一份，和 chat:send 同一算法；没上报勾选时默认 zabingsk
  const source = Array.isArray(payload.skillIds)
    ? payload.skillIds
    : (payload.skillId ? [payload.skillId] : ['zabingsk']);
  const payloadIds = [];
  for (const id of source) {
    const sid = String(id || '').trim();
    if (sid && !payloadIds.includes(sid)) payloadIds.push(sid);
  }
  const chosen = payloadIds.map((id) => skills.find((x) => x.id === id)).filter(Boolean);
  const skill = chosen.length
    ? {
      id: chosen.map((x) => x.id).join('+'),
      name: chosen.map((x) => x.name).join(' + '),
      body: chosen.map((x) => x.body).join('\n\n---\n\n')
    }
    : null;
  // build 原样返回：system 给面板展示，editable 给面板先改，notes 标出哪些内容要到发送时才现场生成。
  // skills / skill / rules / allSkills 一并透传，面板要按这些渲染勾选项；build 内部仍按 skillIds 自己重算同一份，结果一致。
  return promptPreview.build({
    ...payload,
    appRoot: APP_ROOT,
    workspace: ws,
    modelCfg,
    skills,
    skill,
    rules,
    allSkills
  });
});

ipcMain.handle('chat:send', async (e, payload) => {
  const win = getWin(e);
  // 只接受调度器对当前投递保存的授权目标，渲染层的轮次正文仅提供模型上下文。
  const longAliveGoal = payload.longAliveRunId
    ? longAliveHost.authorize(win, payload.longAliveRunId, payload.turnId)
    : undefined;
  if (longAliveGoal === null) {
    throw new Error('长时存活已停止，本轮未执行');
  }
  const ws = String(payload?.workspace || workspaceByWin.get(win) || '');
  const s = store.load();
  const modelCfg = store.resolveModelCfg(payload.modelId || s.currentModelId, s);
  // 外部授权配置只绑定到主进程确认的工作区；手动聊天不获得收发工具。
  const weixinProfile = process.env.SPCODE_WEIXIN_PROFILE;
  const weixinChannel = longAliveGoal !== undefined && weixinProfile
    ? require('./lib/weixin-channel').forWorkspace(weixinProfile, workspaceByWin.get(win), app.getPath('userData'))
    : null;
  const ctl = new AbortController();
  const turnId = String(payload?.turnId || '');
  // 这一轮挂在哪个窗口的哪个标签页上：渲染层没上报 tabId 时用该窗口上次上报的标签页兜底，
  // 否则事件键会变成「窗口N:」，与小窗的绑定键对不上，不新增协议字段
  const tabId = resolveTurnTabId(win, payload);
  // 内部开关严格为 true 才采集；关闭时不创建目录，不写任何训练档案。
  let archive = null;
  if (!app.isPackaged && s.trainingDataEnabled === true) {
    archive = trainingArchive.create(s.trainingDataDir, tabId, turnId, {
      workspace: ws, windowId: winIdByWin.get(win), model: trainingArchive.modelIdentity(modelCfg), request: payload
    });
    await archive.flush();
  }
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
  let turnOutcome = 'success';
  /** 聊天事件维持原出口，训练状态同时保留未抛异常的错误事件。 */
  function onEvent(ev) {
    if (ev.type === 'error') turnOutcome = 'error';
    if (archive) archive.record('event', ev);
    if (!ev.activityOnly) sendTo(win, 'chat:event', turnId ? { ...ev, turnId } : ev);
    forwardTurnEventToFloatBar(ev, turnId);
  }
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
  // 预览面板里这一轮改过的内容，只作用于本次发送：用户可能在「上下文」预览里改了规则、技能和人设。
  // 三项各自「有值才顶替」——缺失或为 null 时仍用上面从磁盘读到的原值，保证不带 sysOverrides 的常规发送完全不变；
  // 这里只改本轮内存里的取值，不写回磁盘，下一轮仍从文件重新读取。
  const overrides = (payload && payload.sysOverrides && typeof payload.sysOverrides === 'object') ? payload.sysOverrides : {};
  const rulesForTurn = Array.isArray(overrides.rules) ? overrides.rules : rules;
  // 预览面板里改过的技能正文是纯字符串（渲染层只传正文），这里补回 id 与 name，拼成 runTurn 需要的 { id, name, body }；
  // 传对象时按原样采用；没有覆盖值（undefined / null / 空串）时沿用上面从磁盘读到的技能
  let skillForTurn = skill;
  if (overrides.skill && typeof overrides.skill === 'object') {
    skillForTurn = overrides.skill;
  } else if (typeof overrides.skill === 'string' && overrides.skill) {
    skillForTurn = {
      id: skill ? skill.id : '',
      name: skill ? skill.name : '',
      body: overrides.skill
    };
  }
  // 较早摘要可以改成空串（表示本轮不带摘要），所以判 null 和 undefined，不用真假值判断
  const summaryForTurn = overrides.summary != null ? overrides.summary : payload.contextSummary;
  // 人设不在这里拼进提示词，交给 runTurn 的 personaOverride，那边只在非空字符串时才顶替磁盘人设
  const personaOverride = typeof overrides.persona === 'string' ? overrides.persona : undefined;
  const waitForUserAnswer = (ask, signal) => new Promise((resolve, reject) => {
    const onAbort = () => {
      pendingAskMap(win).delete(turnId);
      reject(Object.assign(new Error('已停止'), { name: 'AbortError' }));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    pendingAskMap(win).set(turnId, { resolve, reject, ask, archive });
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
  setTurnRunning(win, turnId, true);
  // 轮次状态按会话发送，其他标签页运行不会影响本会话的结束展示。
  broadcastToFloatBars({ kind: 'turn-start', turnId, sessionKey: makeSessionKey(win, tabId) });
  try {
    /** 上下文预览与训练采集共享同一轮异步边界。 */
    function executeAgent() { return agent.runTurn({
      workspace: ws,
      appRoot: APP_ROOT,
      modelCfg,
      history: payload.history || [],
      userText: payload.text || '',
      longAliveGoal,
      weixinChannel,
      action: payload.action === 'start-work' ? 'start-work' : undefined,
      attachments: payload.attachments || [],
      contextPaths: payload.contextPaths || [],
      // 规则、技能用本轮取值（预览里改过时是改后的，没改过就是磁盘读到的原值）
      skill: skillForTurn,
      rules: rulesForTurn,
      // 预览面板里改过的人设：runTurn 只在非空字符串时顶替磁盘人设，未改时传 undefined 走原流程
      personaOverride,
      allSkills,
      onEvent,
      signal: ctl.signal,
      workingMemory: payload.workingMemory,
      // 较早摘要同样允许预览面板改过，未改时仍是渲染层传上来的会话摘要
      contextSummary: summaryForTurn,
      contextRevision: payload.contextRevision,
      extraFolders: payload.extraFolders || [],
      waitForUserAnswer,
      maxAgentRounds: payload.maxAgentRounds,
      unlimitedRounds: !!payload.unlimitedRounds,
      interjectKey: makeSessionKey(win, resolveTurnTabId(win, payload)),
      turnId,
    }); }
    function executeWithArchive() { return trainingArchive.run(archive, executeAgent); }
    const result = await contextPreview.run(turnId, executeWithArchive);
    if (archive) archive.record('turn-result', result);
    return result;
  } catch (err) {
    turnOutcome = ctl.signal.aborted || err.name === 'AbortError' ? 'stopped' : 'error';
    if (archive) archive.record('turn-error', trainingArchive.errorData(err));
    diag.log('agent', '本轮失败', { message: err && err.message });
    const msg = /No sequences left/i.test(String(err && err.message))
      ? '本地模型上下文占满了。请新开一个对话再试，或把过长的历史清掉。'
      : (err.message || String(err));
    onEvent({ type: 'error', message: msg });
    throw err;
  } finally {
    if (ctl.signal.aborted) turnOutcome = 'stopped';
    broadcastToFloatBars({ kind: 'turn-end', turnId, sessionKey: makeSessionKey(win, tabId), outcome: turnOutcome });
    setTurnRunning(win, turnId, false);
    turnOwner.delete(turnId);
    pendingAskMap(win).delete(turnId);
    abortMap(win).delete(turnId);
    // 这个窗口的轮次都收工了，让悬浮栏顶栏回到「空闲」；同一窗口还有别的标签页在跑就别清
    if (!turnIsRunning(win)) {
      broadcastToFloatBars({ kind: 'idle', turnId, sessionKey: makeSessionKey(win, tabId) });
    }
    // 返回界面前确认全部事件落盘；写入失败明确报错，不冒充采集成功。
    if (archive) await archive.finish(turnOutcome);
  }
});

/**
 * 将主窗提交的补充放进绑定会话当前轮的收件箱。
 * @param {Electron.IpcMainInvokeEvent} e 来源事件，用于确定所属窗口。
 * @param {object} payload 提交快照，含可选 tabId、正文 text 和图片附件 attachments；支持纯图。
 * @returns {{ok: boolean, key?: string, reason?: string}} 只有收件箱接受时返回会话键；无效请求和非活动轮次返回原因。
 */
ipcMain.handle('chat:interject', function submitChatInterjection(e, payload) {
  const win = getWin(e);
  const text = payload && typeof payload.text === 'string' ? payload.text.trim() : '';
  const attachments = Array.isArray(payload && payload.attachments) ? payload.attachments : [];
  if (!text && !attachments.length) return { ok: false, reason: 'empty' };
  for (const att of attachments) {
    if (!att || typeof att.path !== 'string' || !fs.existsSync(att.path)) return { ok: false, reason: 'error' };
  }
  const key = makeSessionKey(win, resolveTurnTabId(win, payload));
  if (!deliverChatInterjection(key, text, attachments)) return { ok: false, reason: 'not-accepting' };
  return { ok: true, key };
});
