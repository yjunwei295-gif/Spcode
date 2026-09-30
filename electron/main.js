const {
  app, BrowserWindow, ipcMain, dialog, nativeTheme, clipboard, shell, crashReporter, session
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

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    icon: path.join(CODE_ROOT, 'icons.png'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#141414' : '#f3f3f3',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  windows.add(win);
  workspaceByWin.set(win, '');
  win.on('closed', () => {
    diag.log('window', '窗口已关闭');
    stopWorkspaceWatch(win);
    windows.delete(win);
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
app.on('will-quit', () => diag.log('app', '即将退出 will-quit'));
app.on('quit', (_e, code) => diag.log('app', '已退出 quit', { code }));

ipcMain.on('log:client', (_e, payload) => {
  diag.log('renderer', (payload && payload.message) || '界面异常', payload && payload.detail);
});

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
  createWindow();
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

ipcMain.handle('chat:abort', (e, turnId) => {
  const win = getWin(e);
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
});

ipcMain.handle('chat:answer', (e, payload) => {
  const win = getWin(e);
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
  return true;
});

ipcMain.handle('chat:contextPreview', (_e, turnId) => contextPreview.get(turnId));

ipcMain.handle('chat:send', async (e, payload) => {
  const win = getWin(e);
  const ws = String(payload?.workspace || workspaceByWin.get(win) || '');
  const s = store.load();
  const modelCfg = store.resolveModelCfg(payload.modelId || s.currentModelId, s);
  const ctl = new AbortController();
  const turnId = String(payload?.turnId || '');
  if (turnId) abortMap(win).set(turnId, ctl);
  const order = store.load().skillOrder || [];
  const skills = agent.listSkills(APP_ROOT, ws, order);
  const allSkills = skillsLib.listDetailed(path.join(APP_ROOT, 'skills'), ws, order);
  const onEvent = (ev) => sendTo(win, 'chat:event', turnId ? { ...ev, turnId } : ev);
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
      unlimitedRounds: !!payload.unlimitedRounds
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
    pendingAskMap(win).delete(turnId);
    abortMap(win).delete(turnId);
  }
});
