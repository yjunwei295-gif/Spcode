'use strict';

/**
 * 在独立 Electron 进程和临时用户目录中验证生产主进程、preload、IPC 与界面真实重载。
 * 原业务源码保持不变；只在临时 renderer 副本末尾附加测试访问口，不连接模型或修改现有 SpCode 实例。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');

const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-hot-reload-app-'));
const userData = path.join(output, 'user-data');
const workspace = path.join(output, 'workspace');
const rendererCopy = path.join(output, 'renderer');
const evidence = { output, pid: process.pid, passed: [], notifications: [], errors: [] };
let mainWindow = null;
let runtime = null;
let navigationCount = 0;
let finished = false;
let watchdog = null;
/** 测试专用业务提交闸门，精确停留在真实 pending 阶段，不影响现有用户进程。 */
let holdBusinessUpdates = false;

for (const dir of [userData, workspace, path.join(output, 'models'), path.join(output, 'session-data'), path.join(output, 'crash-dumps')]) {
  fs.mkdirSync(dir, { recursive: true });
}
app.setName('SpCodeHotReloadVerification');
app.setPath('userData', userData);
app.setPath('sessionData', path.join(output, 'session-data'));
app.setPath('crashDumps', path.join(output, 'crash-dumps'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  locale: 'zh', theme: 'dark', autoSave: false, onboardingCompleted: true,
  trainingDataEnabled: false, desktopAlive: false, cursorDirect: false,
  providers: [], currentModelId: 'local-gguf', modelsDir: path.join(output, 'models'),
  models: [{ id: 'local-gguf', name: '本地模型', type: 'local', model: '', enabled: true }],
  capabilityDefaults: {}, assemblies: {}, recents: []
}), 'utf8');
fs.writeFileSync(path.join(workspace, 'reference.txt'), '临时参考附件', 'utf8');
fs.cpSync(path.join(root, 'renderer'), rendererCopy, { recursive: true });
// 界面跨目录导入这一份浏览器/主进程共用参数模块，临时副本保留同样的相对布局。
fs.mkdirSync(path.join(output, 'electron', 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'electron', 'lib', 'image-gen-options.js'), path.join(output, 'electron', 'lib', 'image-gen-options.js'));
for (const name of ['icons.png', 'icons.ico']) {
  const source = path.join(root, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(output, name));
}
const appSource = path.join(rendererCopy, 'app.js');
// 只增加访问口；生产初始化、状态采集、控制器、preload 和 IPC 均照常执行。
fs.appendFileSync(appSource, '\nwindow.__hotReloadAppTest = { state, newTab, switchToTab, rememberComposer, send, hotReloadController, retryHotReload, openModal, closeModal, refreshMeta };\n', 'utf8');

/** 记录行为断言，失败保留现场目录与诊断，不覆盖生产文件。 */
function check(value, message) {
  assert.ok(value, message);
  evidence.passed.push(message);
  console.log('PASS ' + message);
}

/** 只结束本测试创建的进程；保存报告以便复查真实窗口与通知轨迹。 */
function finish(error) {
  if (finished) return;
  finished = true;
  if (watchdog) clearTimeout(watchdog);
  if (error) {
    evidence.failure = String(error.stack || error);
    console.error('FAIL ' + evidence.failure);
  }
  evidence.navigationCount = navigationCount;
  if (runtime) runtime.close();
  const report = path.join(output, 'report.json');
  fs.writeFileSync(report, JSON.stringify(evidence, null, 2), 'utf8');
  console.log('REPORT ' + report);
  app.exit(error ? 1 : 0);
}

/** 有界等待实际状态，不以命令返回或固定延时冒充加载完成。 */
function waitFor(predicate, label, timeoutMs = 15000) {
  return new Promise(begin);
  function begin(resolve, reject) {
    const deadline = Date.now() + timeoutMs;
    inspect();
    async function inspect() {
      try {
        const value = await predicate();
        if (value) { resolve(value); return; }
        if (Date.now() >= deadline) throw new Error(label + ' 等待超时；错误：' + JSON.stringify(evidence.errors));
        setTimeout(inspect, 25);
      } catch (error) { reject(error); }
    }
  }
}

/** 在测试进程的主窗口执行真实页面表达式。 */
function page(source) {
  return mainWindow.webContents.executeJavaScript(source);
}

/** 判断页面已经恢复可用界面，重载期间不向已销毁的文档发送脚本。 */
async function initializedPage() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
  return page('Boolean(window.__hotReloadAppTest && window.__hotReloadAppTest.state.workspace && window.__hotReloadAppTest.state.tabs.length && document.getElementById("modal").classList.contains("hidden"))');
}

/** 隐藏本测试的新窗口，不操作任何其他进程或用户现有窗口。 */
function observeWindow(_event, win) {
  win.hide();
  win.on('show', hideWindow);
  function hideWindow() { win.hide(); }
  if (!mainWindow) {
    mainWindow = win;
    win.webContents.on('did-start-loading', countNavigation);
    function countNavigation() { navigationCount++; }
  }
  win.webContents.on('console-message', consoleMessage);
  function consoleMessage(event) {
    if (event.level === 'error') evidence.errors.push({ type: 'console', message: event.message, line: event.lineNumber, sourceId: event.sourceId });
  }
  win.webContents.on('preload-error', preloadFailed);
  function preloadFailed(_event, file, error) {
    evidence.errors.push({ type: 'preload', file, message: String(error && error.message) });
  }
  win.webContents.on('render-process-gone', rendererGone);
  function rendererGone(_event, details) {
    if (!finished) evidence.errors.push({ type: 'renderer-gone', details });
  }
}

/** 收集实际界面异常，确保测试不会把脚本启动失败误判成没有发生重载。 */
function recordClientError(_event, payload) {
  // restart 通知是生产明确报告的边界，单独留证；脚本异常和加载错误仍让测试失败。
  if (payload && payload.detail && payload.detail.kind === 'restart') {
    if (!evidence.restartNotices) evidence.restartNotices = [];
    evidence.restartNotices.push(payload);
    return;
  }
  evidence.errors.push({ type: 'renderer', payload });
}

/**
 * 保留生产热更新实例，记录通知并允许测试停留在保存后待校验阶段。
 * @param {object} options 生产工厂参数；通知仍转发原回调，canApply 额外受测试闸门控制。
 * @returns {object} 实际生产热更新实例，不替换状态查询、校验或重载 IPC。
 */
function captureRuntime(options) {
  const productionNotify = options.notify;
  const productionCanApply = options.canApply;
  options.canApply = canApply;
  /** 无参数；返回宿主空闲且测试未暂停提交，只读取闸门和真实宿主状态。 */
  function canApply() { return !holdBusinessUpdates && productionCanApply(); }
  options.notify = notify;
  /**
   * 记录并转发生产通知。
   * @param {object} update 真实热更新事件，按发生顺序加入测试报告。
   * @returns {unknown} 原通知回调的实际返回值；不改变候选或版本。
   */
  function notify(update) {
    evidence.notifications.push(update);
    return productionNotify(update);
  }
  runtime = productionCreate(options);
  return runtime;
}

app.on('browser-window-created', observeWindow);
ipcMain.on('log:client', recordClientError);
const hotReloadModule = require('../electron/lib/hot-reload');
const productionCreate = hotReloadModule.createHotReload;
hotReloadModule.createHotReload = captureRuntime;

/** 让完整生产模块图实际初始化，再验证稳定导出没有循环加载或类型错误。 */
function startProduction() {
  require('../electron/main.js');
  hotReloadModule.createHotReload = productionCreate;
  const modules = ['agent', 'aesthetic-review', 'aesthetic-reference', 'assembly', 'module-prompts', 'api-protocol',
    'cursor-model', 'codex-model', 'claude-model', 'grok-model', 'skills', 'generate', 'media', 'prompt-preview'];
  for (const name of modules) {
    const value = require(path.join(root, 'electron', 'lib', name + '.js'));
    assert.ok(value && typeof value === 'object', name + ' 导出对象');
    assert.ok(Reflect.ownKeys(value).length, name + ' 导出不能为空');
  }
  check(typeof require('../electron/lib/agent').runTurn === 'function', '生产 Agent 与全部受管模块图成功加载');
  check(typeof require('../electron/lib/assembly').assemblyKey === 'function', '稳定代理保留生产具名导出');
}

/** 通过真实界面访问口准备未保存标签，业务函数只被调用，不被替换。 */
async function seedTabs() {
  return page('(async function seed() {'
    + 'const test = window.__hotReloadAppTest; const state = test.state; state.autoSave = false;'
    + 'test.newTab(); const first = state.tabs[state.tabs.length - 1]; first.title = "热重载标签甲";'
    + 'document.getElementById("input").value = "甲：未发送草稿"; state.contextPaths = ["reference.txt"];'
    + 'state.attachments = [{ path: ' + JSON.stringify(path.join(workspace, 'reference.txt')) + ', name: "reference.txt" }];'
    + 'test.rememberComposer(first);'
    + 'test.newTab(); const second = state.tabs[state.tabs.length - 1]; second.title = "热重载标签乙";'
    + 'document.getElementById("input").value = "乙：关闭自动保存也要保留"; state.contextPaths = ["reference.txt"];'
    + 'state.attachments = [{ path: ' + JSON.stringify(path.join(workspace, 'reference.txt')) + ', name: "reference.txt" }];'
    + 'test.rememberComposer(second); second.sending = true; second.draining = true;'
    + 'return { first: first.id, second: second.id, count: state.tabs.length }; })()');
}

/**
 * 在真实页面连续切换 A→B→A，并通过生产文件读取 IPC 核对主进程最终项目归属。
 * @returns {Promise<void>} 三轮快速往返均保持标签、工作区及草稿一致后兑现；仅写测试临时目录。
 */
async function verifyWorkspaceRoundTrip() {
  const alternate = path.join(output, 'workspace-b');
  fs.mkdirSync(alternate, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'workspace-owner.txt'), 'workspace-a', 'utf8');
  fs.writeFileSync(path.join(alternate, 'workspace-owner.txt'), 'workspace-b', 'utf8');
  const result = await page('(/** 连续切换真实标签并读取主进程归属；无参数，返回Promise<Array>，仅改变本测试页面及临时项目。 */ async function roundTrip() {'
    + 'const test = window.__hotReloadAppTest; const state = test.state; const api = window.simple || window.sinpo;'
    + 'state.autoSave = false; const a = state.tabs.find(/** tab为已加载标签；返回是否当前标签，不修改状态。 */ function active(tab) { return tab.id === state.activeTab; });'
    // 标签首次创建即属于 B，避免先绑定 A 的长存档案后再篡改所属项目。
    + 'state.workspace = ' + JSON.stringify(alternate) + '; test.newTab(); const b = state.tabs[state.tabs.length - 1]; state.workspace = a.workspace;'
    + 'await test.switchToTab(a.id); const rounds = [];'
    + 'for (let i = 0; i < 3; i++) {'
    + 'const going = test.switchToTab(b.id); const returning = test.switchToTab(a.id);'
    + 'document.getElementById("input").value = "A的新草稿" + i;'
    + 'await Promise.all([going, returning]); const owner = await api.readWorkspaceFile("workspace-owner.txt");'
    + 'rounds.push({ active: state.activeTab === a.id, workspace: state.workspace, owner, draft: document.getElementById("input").value });'
    + '} return rounds; })()');
  evidence.workspaceRoundTrips = result;
  for (let i = 0; i < result.length; i++) {
    const item = result[i];
    check(item.active && item.workspace === workspace && item.owner.content === 'workspace-a' && item.draft === 'A的新草稿' + i, '真实IPC快速A→B→A第' + (i + 1) + '轮保持项目归属与新草稿');
  }
}

/**
 * 打开真实重发确认弹窗，等待时切换历史，点击确认后核对原会话队列和前台草稿。
 * @returns {Promise<void>} DOM、队列载荷与原会话归属检查通过后兑现；测试任务只排队，不请求模型或恢复文件。
 */
async function verifyResendConfirmation() {
  await page('(/** 准备A的重发并打开真实确认；无参数，返回true，将等待Promise保存在测试访问口。 */ function prepareResend() {'
    + 'const test = window.__hotReloadAppTest; const state = test.state; const a = state.tabs.find(/** tab为已加载标签，返回是否当前标签，只读。 */ function active(tab) { return tab.id === state.activeTab; });'
    + 'const b = state.tabs.find(/** tab为已加载标签，返回是否另一历史，只读。 */ function other(tab) { return tab.id !== a.id; });'
    + 'a.messages = [{role:"user",text:"A旧正文"},{role:"assistant",text:"A旧回复"}]; a.refillFromIndex = 1; state.refillFromIndex = 1; a.sending = true;'
    + 'document.getElementById("input").value = "A的重发正文"; state.attachments = [{path:"attachment-a.txt",name:"A附件"}]; state.contextPaths = ["reference-a"];'
    + 'test.resendOwners = {a:a.id,b:b.id}; test.resending = test.send(); return true; })()');
  check(await page('!document.getElementById("modal").classList.contains("hidden") && Boolean(document.getElementById("m-keep-files"))'), '生产页面实际打开重发确认弹窗');
  const result = await page('(/** 切到B再点击原确认；无参数，返回Promise<object>的真实DOM及队列证据，仅操作本测试窗口。 */ async function confirmAfterSwitch() {'
    + 'const test = window.__hotReloadAppTest; const state = test.state; await test.switchToTab(test.resendOwners.b);'
    + 'document.getElementById("input").value = "B的新草稿"; state.attachments = [{path:"attachment-b.txt",name:"B附件"}]; state.contextPaths = ["reference-b"];'
    + 'document.getElementById("m-keep-files").click(); await test.resending;'
    + 'const a = state.tabs.find(/** tab为标签，返回是否发起确认者，只读。 */ function original(tab) {return tab.id === test.resendOwners.a;});'
    + 'const item = a.queue.shift(); a.sending = false;'
    + 'return {active:state.activeTab,expected:test.resendOwners.b,text:document.getElementById("input").value,attachments:state.attachments,paths:state.contextPaths,item,modalClosed:document.getElementById("modal").classList.contains("hidden")}; })()');
  evidence.resendConfirmation = result;
  check(result.active === result.expected && result.text === 'B的新草稿' && result.attachments[0].path === 'attachment-b.txt' && result.paths[0] === 'reference-b' && result.modalClosed, '真实确认返回不清空B的输入附件与引用');
  check(result.item.text === 'A的重发正文' && result.item.attachments[0].path === 'attachment-a.txt' && result.item.contextPaths[0] === 'reference-a', '真实确认仅把A原始载荷排入A队列');
}

/**
 * 通过真实历史快照侧栏、preload 和主进程验证单文件及整份操作。
 * @returns {Promise<void>} 临时项目的文件状态、快照历史和界面确认全部核对后兑现。
 */
async function verifySnapshotSelection() {
  const snapshot = require('../electron/lib/snapshot');
  const target = '脚本甲/同名.js';
  const other = '脚本乙/同名.js';
  const created = '新建.js';
  const removed = '被删除.js';
  // 用同名文件和不同操作验证路径精确匹配，保留中文及 CRLF 字节作为改前内容。
  const files = [
    { rel: target, before: '甲旧版\r\n', after: '甲新版\n' },
    { rel: other, before: '乙旧版\n', after: '乙新版\n' },
    { rel: created, before: null, after: '新建内容\n' },
    { rel: removed, before: '被删除的旧内容\n', after: null }
  ];
  const saved = snapshot.create(workspace, '单文件还原验收');
  for (const item of files) {
    const abs = path.join(workspace, item.rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, item.before === null ? item.after : item.before, 'utf8');
    snapshot.recordChange(workspace, saved, item.rel, item.before === null ? 'create' : item.after === null ? 'delete' : 'write', { existedBefore: item.before !== null });
    if (item.after === null) fs.unlinkSync(abs);
    else fs.writeFileSync(abs, item.after, 'utf8');
  }
  const manifest = path.join(saved.dir, 'manifest.json');
  const originalManifest = fs.readFileSync(manifest, 'utf8');
  const open = 'document.querySelector(' + JSON.stringify('#snap-list [data-restore="' + saved.id + '"]') + ').click()';
  await page('window.__hotReloadAppTest.refreshMeta()');
  await page('if (document.getElementById("sidebar").classList.contains("hidden")) document.getElementById("btn-sidebar").click()');
  await page(open);
  check(await page('document.activeElement.id === "m-cancel" && document.querySelectorAll("#m-restore-files input").length === 5'), '历史快照列出全部及四个文件，初始焦点在取消');
  await page('document.querySelector(\'#m-restore-files input[value="0"]\').click()');
  check(await page('document.getElementById("m-confirm").textContent === "仅还原此文件" && document.querySelector("#m-restore-files input:checked").parentElement.textContent.includes("脚本甲/同名.js")'), '同名脚本以完整路径区分，选择后显示单文件确认');
  // 测试窗口保持隐藏，直接记录 Chromium 实际计算的控件尺寸和文案。
  evidence.snapshotSelection = await page('(function selectionLayout() { const file = document.querySelector("#m-restore-files input:checked"); const confirm = document.getElementById("m-confirm"); return { file: file.parentElement.textContent, action: confirm.textContent, fileWidth: file.getBoundingClientRect().width, actionWidth: confirm.getBoundingClientRect().width }; })()');
  check(evidence.snapshotSelection.fileWidth > 0 && evidence.snapshotSelection.actionWidth > 0, '真实 Chromium 为单文件选项和确认按钮生成布局');
  await page('document.getElementById("m-cancel").click()');
  check(read(target) === files[0].after && read(other) === files[1].after && read(created) === files[2].after && !exists(removed), '取消单文件选择后所有工作区文件都未改变');

  await confirmFile(0);
  check(read(target) === files[0].before && read(other) === files[1].after && read(created) === files[2].after && !exists(removed), '实际单文件还原保留原字节，同名文件和其他脚本不受影响');
  check(await page('document.getElementById("modal-card").textContent.includes("脚本甲/同名.js")'), '单文件成功提示指出实际文件');
  await page('document.getElementById("m-ok").click()');
  await confirmFile(2);
  check(!exists(created) && read(other) === files[1].after && !exists(removed), '选中新建文件只删除该文件');
  await page('document.getElementById("m-ok").click()');
  await confirmFile(3);
  check(read(removed) === files[3].before && read(other) === files[1].after, '选中曾删除的文件从历史备份重建该文件');
  await page('document.getElementById("m-ok").click()');
  check(fs.readFileSync(manifest, 'utf8') === originalManifest, '逐文件操作不改写历史快照清单');

  await page(open);
  check(await page('document.getElementById("m-confirm").textContent === "还原全部"'), '同一历史快照保留整份还原入口');
  await page('document.getElementById("m-confirm").click()');
  await waitFor(restoreComplete, '整份还原成功提示');
  check(read(other) === files[1].before && read(target) === files[0].before && !exists(created) && read(removed) === files[3].before, '整份还原依然恢复所有历史条目');
  await page('document.getElementById("m-ok").click()');

  /**
   * 在历史侧栏确认还原一个文件。
   * @param {number} index 快照文件清单中从 0 开始的索引，全部文件选项不占索引。
   * @returns {Promise<void>} 主进程完成所选文件的还原且界面显示成功提示后兑现。
   */
  async function confirmFile(index) {
    await page(open);
    const selector = '#m-restore-files input[value="' + index + '"]';
    await page('document.querySelector(' + JSON.stringify(selector) + ').click(); document.getElementById("m-confirm").click()');
    await waitFor(restoreComplete, '单文件还原成功提示');
  }
  /**
   * 读取隔离项目中的文件内容。
   * @param {string} rel 相对于隔离项目根目录的文件路径。
   * @returns {string} 用于精确比较的 UTF-8 文本。
   */
  function read(rel) { return fs.readFileSync(path.join(workspace, rel), 'utf8'); }
  /**
   * 检查隔离项目中的路径是否存在。
   * @param {string} rel 相对于隔离项目根目录的路径。
   * @returns {boolean} 路径存在时为 true。
   */
  function exists(rel) { return fs.existsSync(path.join(workspace, rel)); }
  /** 检查已收到写入回执的成功弹窗。 */
  function restoreComplete() { return page('Boolean(document.getElementById("m-ok"))'); }
}

/**
 * 在隔离项目和用户目录中启动生产窗口，按命令行参数运行快照专项或完整热重载回归。
 * @returns {Promise<void>} 指定 --snapshot-selection 时，快照选择、文件状态及界面异常检查通过后提前结束。默认在项目切换、重发确认、业务待校验门禁、真实 IPC 和页面恢复以及主入口更新的断言完成后兑现。
 */
async function verifyApplication() {
  await app.whenReady();
  await waitFor(windowCreated, '生产主窗口');
  function windowCreated() { return mainWindow && !mainWindow.webContents.isLoading(); }
  check(Boolean(runtime), '生产主进程创建真实热重载实例');
  const interfaces = await page('(function interfaces() { const api = window.simple || window.sinpo; return { subscribed: typeof api.onHotReload, status: typeof api.hotReloadStatus, ready: typeof api.hotReloadReady }; })()');
  check(interfaces.subscribed === 'function' && interfaces.status === 'function' && interfaces.ready === 'function', '真实 preload 暴露订阅、状态与重载确认接口');
  await page('(window.simple || window.sinpo).setWorkspace(' + JSON.stringify(workspace) + ')');
  await mainWindow.loadFile(path.join(rendererCopy, 'index.html'));
  await waitFor(initializedPage, '完整界面初始化');
  if (process.argv.includes('--snapshot-selection')) {
    await verifySnapshotSelection();
    check(evidence.errors.length === 0, '历史快照操作未发生 preload 或界面脚本异常');
    return;
  }
  await verifyWorkspaceRoundTrip();
  await verifyResendConfirmation();
  const ids = await seedTabs();
  const originalWindowId = mainWindow.id;
  const originalWebContents = mainWindow.webContents.id;
  const originalPid = process.pid;
  const before = navigationCount;
  runtime.changed(path.join(root, 'renderer', 'styles.css'));
  await waitFor(waitingForIdle, '任务繁忙时显示等待空闲的重载提示');
  /**
   * 读取任务繁忙时的界面重载状态，确认渲染进程已收到可重载的通知。
   * @returns {Promise<boolean>} 界面显示等待空闲提示时为真。
   */
  async function waitingForIdle() {
    return page('document.getElementById("status-hot-reload")?.textContent === "已请求界面重载，空闲后加载"');
  }
  check(navigationCount === before, '标签发送或队列执行期间不会重载页面');
  check(await page('sessionStorage.getItem("spcode:hot-reload") === null'), '繁忙状态没有提早保存过期快照');
  const changed = runtime.status();
  check(changed && changed.kind === 'renderer', '真实主进程持有可确认的界面更新版本');
  holdBusinessUpdates = true;
  runtime.changed(path.join(root, 'electron', 'lib', 'assembly.js'));
  check(runtime.isBusy(), '真实业务保存后待校验阶段立即阻止旧候选重载');
  const rejectedReady = await page('(window.simple || window.sinpo).hotReloadReady(' + changed.revision + ')');
  check(rejectedReady.ok === false && navigationCount === before, '生产重载IPC在业务仍待校验时实际拒绝旧候选');
  holdBusinessUpdates = false;
  await waitFor(applyPendingBusiness, '待校验业务实际提交');
  /** 尝试提交实际pending批次；无参数，返回是否提交，失败时继续等待真实宿主空闲。 */
  function applyPendingBusiness() { return runtime.flush(); }
  await page('(function finishTask() { const test = window.__hotReloadAppTest; for (const tab of test.state.tabs) { tab.sending = false; tab.draining = false; } test.retryHotReload(); })()');
  await waitFor(reloaded, '生产 IPC 确认后的真实页面重载');
  async function reloaded() {
    if (navigationCount <= before) return false;
    if (!await initializedPage()) return false;
    return page('window.__hotReloadAppTest.state.activeTab === ' + JSON.stringify(ids.second));
  }
  check(process.pid === originalPid && mainWindow.id === originalWindowId && mainWindow.webContents.id === originalWebContents, '热重载保留同一进程、BrowserWindow 和 WebContents');
  const restored = await page('(function restored() { const state = window.__hotReloadAppTest.state; return { autoSave: state.autoSave, count: state.tabs.length, active: state.activeTab, text: document.getElementById("input").value, tabs: state.tabs.map(function tab(item) { return { id: item.id, title: item.title, composer: item.composer }; }), attachments: state.attachments, paths: state.contextPaths, snapshot: sessionStorage.getItem("spcode:hot-reload") }; })()');
  check(restored.autoSave === false && restored.count === ids.count && restored.active === ids.second, '自动保存关闭时全部标签及当前标签恢复');
  check(restored.text === '乙：关闭自动保存也要保留', '当前输入框未发送草稿跨真实重载保留');
  const first = restored.tabs.find(matchesFirst);
  function matchesFirst(tab) { return tab.id === ids.first; }
  check(first && first.composer.text === '甲：未发送草稿', '后台标签未发送草稿跨真实重载保留');
  check(restored.attachments.length === 1 && restored.attachments[0].name === 'reference.txt' && restored.paths[0] === 'reference.txt', '当前草稿附件与上下文引用同时恢复');
  check(first.composer.attachments[0].name === 'reference.txt', '后台标签草稿附件保留');
  check(restored.snapshot === null, '临时快照恢复后仅消费一次');
  const sessions = path.join(userData, 'sessions');
  check(!fs.existsSync(sessions) || fs.readdirSync(sessions).length === 0, '热重载未绕过自动保存开关写会话磁盘');
  check(await page('(window.simple || window.sinpo).hotReloadStatus()') === null, '已加载版本通过生产状态 IPC 过滤，避免重载循环');
  const after = navigationCount;
  mainWindow.webContents.send('app:hot-reload', changed);
  await page('new Promise(function nextDocumentTurn(resolve) { setTimeout(resolve, 0); })');
  check(navigationCount === after, '同版本通知不会再次重载已恢复页面');
  await waitFor(runtimeIdle, '受管业务调用空闲');
  function runtimeIdle() { return !runtime.isBusy(); }
  runtime.changed(path.join(root, 'electron', 'lib', 'assembly.js'));
  check(runtime.flush(), '真实生产业务依赖闭包可在原进程重建');
  const assembly = require('../electron/lib/assembly');
  const store = require('../electron/lib/store');
  check(assembly.assemblyKey(store.load()) === 'local', '重建后的生产业务代理返回正确结果，无循环或类型错误');
  check(evidence.errors.length === 0, '完整生产启动及重载未发生 preload 或界面脚本异常');

  // 在真实生产入口的既有函数上修改执行结果，实际调用原热更新实例验证闭包已经切换。
  // 只修改测试进程的 V8 脚本正文，不触碰磁盘源码，不启动第二份主入口或服务。
  const mainFile = path.join(root, 'electron', 'main.js');
  const mainSource = fs.readFileSync(mainFile, 'utf8');
  const anchor = 'return !desktopHand.isBusy();';
  const position = mainSource.indexOf(anchor);
  assert.ok(position >= 0 && mainSource.lastIndexOf(anchor) === position, '生产空闲检查定位唯一');
  const liveEditor = require('../electron/lib/live-edit').createLiveEditor(root);
  try {
    const blocked = mainSource.slice(0, position) + 'return !desktopHand.isBusy() && false;' + mainSource.slice(position + anchor.length);
    await liveEditor.apply([{ file: mainFile, source: blocked }]);
    runtime.changed(path.join(root, 'electron', 'lib', 'assembly.js'));
    check(runtime.flush() === false, '主入口既有空闲检查实际切换为新实现，原运行实例拒绝更新');
    const allowed = mainSource.slice(0, position) + 'return !desktopHand.isBusy() && true;' + mainSource.slice(position + anchor.length);
    await liveEditor.apply([{ file: mainFile, source: allowed }]);
    check(runtime.flush(), '主入口下一版函数原位生效，原运行实例重新允许业务更新');
    check(process.pid === originalPid && mainWindow.id === originalWindowId, '主入口方法更新保留真实进程与原窗口');
  } finally {
    liveEditor.close();
  }
  evidence.restored = restored;
  evidence.window = { windowId: mainWindow.id, webContentsId: mainWindow.webContents.id, pid: process.pid };
}

/** 将测试失败写入独立报告，避免生产异常监听让进程悬挂而掩盖失败。 */
function fail(error) { finish(error); }

watchdog = setTimeout(timeout, 45000);
function timeout() { finish(new Error('真实应用热重载测试超时')); }
try {
  startProduction();
  verifyApplication().then(success, fail);
  function success() { finish(null); }
} catch (error) {
  finish(error);
}
