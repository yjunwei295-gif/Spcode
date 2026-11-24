'use strict';

/**
 * 使用真实 Electron relaunch 验证源码保存不自动加载、按钮手动重载及双窗口状态交接。
 * 生产源码先复制到系统临时目录；所有文件变更、窗口和进程均属于本测试。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');

/** 等待明确的真实条件；超时保留现场，不把经过一段时间当作加载成功。 */
async function waitFor(predicate, description, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(next);
  }
  throw new Error('等待失败：' + description);
  /** 有限采样间隔，仅用于本测试读取状态，不触发生产更新器轮询。 */
  function next(resolve) { setTimeout(resolve, 40); }
}

/**
 * 监督首次进程与 relaunch 后的新进程；只有新进程写入实际行为断言才认为通过。
 * @returns {Promise<void>} 失败保留日志和临时应用；不会操作用户正在使用的实例。
 */
async function supervise() {
  const { spawn } = require('child_process');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-code-restart-'));
  const code = path.join(output, 'app');
  fs.mkdirSync(code, { recursive: true });
  for (const directory of ['electron', 'renderer']) fs.cpSync(path.join(root, directory), path.join(code, directory), { recursive: true });
  fs.copyFileSync(path.join(root, 'package.json'), path.join(code, 'package.json'));
  fs.symlinkSync(path.join(root, 'node_modules'), path.join(code, 'node_modules'), 'junction');
  for (const name of ['icons.png', 'icons.ico']) if (fs.existsSync(path.join(root, name))) fs.copyFileSync(path.join(root, name), path.join(code, name));
  fs.appendFileSync(path.join(code, 'renderer', 'app.js'), '\nwindow.__codeReloadTest = { state, newTab, rememberComposer, retryHotReload }; window.__manualReloadMarker = 0;\n', 'utf8');
  fs.appendFileSync(path.join(code, 'electron', 'preload.js'), '\ncontextBridge.exposeInMainWorld("codeReloadTest", { read: function read() { return ipcRenderer.invoke("test:code-reload"); }, initialization: function initialization() { return ipcRenderer.invoke("test:factory-initialization"); } });\n', 'utf8');
  fs.writeFileSync(path.join(code, 'electron', 'lib', 'factory-initialization.js'), factorySource(0), 'utf8');
  const log = fs.openSync(path.join(output, 'process.log'), 'a');
  const child = spawn(require('electron'), [__filename, output], { cwd: root, stdio: ['ignore', log, log], windowsHide: true });
  const report = path.join(output, 'report.json');
  try {
    await waitFor(finished, '手动重载后真实行为报告', 90000);
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(result.error, null, result.error);
    assert.ok(result.firstPid !== result.secondPid, '确实启动了新主进程');
    for (const item of result.passed) process.stdout.write('PASS ' + item + '\n');
    process.stdout.write('REPORT ' + report + '\n');
  } finally {
    fs.closeSync(log);
    if (child.exitCode === null) child.kill();
  }
  /** 只有应用写入完整成功或失败结果时结束；首次进程退出不代表验证成功。 */
  function finished() { return fs.existsSync(report); }
}

/**
 * 在测试专用用户目录运行完整生产程序，先保存工厂与界面源码，再点击按钮分两次重载。
 * @param {string} output 监督进程创建的现场目录，通过原 relaunch 参数跨进程保留。
 * @returns {Promise<void>} 两次真实重启、新初始化值、新增 IPC 和双窗口状态恢复均通过才写成功报告。
 */
async function application(output) {
  const { app, BrowserWindow } = require('electron');
  const code = path.join(output, 'app');
  const userData = path.join(output, 'user-data');
  const workspace = path.join(output, 'workspace');
  for (const name of [userData, workspace, path.join(output, 'models')]) fs.mkdirSync(name, { recursive: true });
  app.setName('CodeRestartVerification');
  app.setPath('userData', userData);
  app.setPath('sessionData', path.join(output, 'session-data'));
  const second = process.argv.some(isReloadArgument);
  if (!second) fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    locale: 'zh', theme: 'dark', autoSave: false, onboardingCompleted: true, trainingDataEnabled: false,
    desktopAlive: false, cursorDirect: false, providers: [], currentModelId: 'local-gguf',
    modelsDir: path.join(output, 'models'), models: [{ id: 'local-gguf', name: '本地模型', type: 'local', model: '', enabled: true }],
    capabilityDefaults: {}, assemblies: {}, recents: []
  }), 'utf8');
  const windows = [];
  const passed = [];
  let completed = false;
  app.on('browser-window-created', observeWindow);
  const watchdog = setTimeout(expired, 35000);
  try {
    require(path.join(code, 'electron', 'main.js'));
    const factory = require(path.join(code, 'electron', 'lib', 'factory-initialization.js'));
    require('electron').ipcMain.handle('test:factory-initialization', readFactoryInitialization);
    /** 通过固定 IPC 读取真实工厂闭包，避免把磁盘文本或候选状态当成新初值已执行。 */
    function readFactoryInitialization() { return factory.readPhase(); }
    await app.whenReady();
    await waitFor(firstWindow, '生产主窗初始化', 20000);
    if (!second) {
      await seed(windows[0], '甲', false);
      await windows[0].webContents.executeJavaScript('(window.simple || window.sinpo).newWindow()');
      await waitFor(twoWindows, '第二个生产主窗', 10000);
      await seed(windows[1], '乙', false);
      const initial = { pid: process.pid, windows: [] };
      for (const win of windows) initial.windows.push(await inspectWindow(win));
      fs.writeFileSync(path.join(output, 'before.json'), JSON.stringify(initial), 'utf8');
      assert.equal(await windows[0].webContents.executeJavaScript('window.codeReloadTest.initialization()'), 0);
      check(await windows[0].webContents.executeJavaScript('document.getElementById("btn-reload")?.textContent === "手动重载"'), '生产界面提供可见的手动重载入口');
      // 前后台源码真实保存后先保持所有窗口空闲，确认保存本身既不更新后台也不刷新页面。
      fs.writeFileSync(path.join(code, 'electron', 'lib', 'factory-initialization.js'), factorySource(1), 'utf8');
      fs.appendFileSync(path.join(code, 'renderer', 'app.js'), '\nwindow.__manualReloadMarker = 1;\n', 'utf8');
      await observeManualOnly(windows[0], 0, 0);
      fs.writeFileSync(path.join(output, 'no-auto-initial.json'), JSON.stringify({ pid: process.pid }), 'utf8');
      await windows[1].webContents.executeJavaScript('window.__codeReloadTest.state.tabs.at(-1).sending = true;');
      await clickManualReload(windows[0]);
      await waitFor(restartQueued, '点击按钮后等待全部窗口空闲', 10000);
      assert.equal(await windows[0].webContents.executeJavaScript('window.codeReloadTest.initialization()'), 0);
      await windows[0].webContents.executeJavaScript('document.getElementById("input").value = "甲：等待期间继续输入";');
      await windows[1].webContents.executeJavaScript('(function finishFactory() { const test=window.__codeReloadTest; for(const tab of test.state.tabs) tab.sending=false; test.retryHotReload(); })()');
      return;
    }
    await waitFor(twoWindows, '手动重载后恢复原双窗口', 15000);
    // 窗口恢复完成顺序可能改变；按已种入的独立标题选目标，不能把创建顺序当成窗口身份。
    const ownerWindows = new Map();
    const windowOrder = [];
    for (const win of windows) {
      const current = await inspectWindow(win);
      ownerWindows.set(current.tabs[0].title, win);
      windowOrder.push({ windowId: win.id, title: current.tabs[0].title, text: current.text });
    }
    fs.writeFileSync(path.join(output, 'window-order-' + process.pid + '.json'), JSON.stringify(windowOrder), 'utf8');
    const alphaWindow = ownerWindows.get('甲标签一');
    const betaWindow = ownerWindows.get('乙标签一');
    assert.ok(alphaWindow && betaWindow);
    const initial = JSON.parse(fs.readFileSync(path.join(output, 'before.json'), 'utf8'));
    const factoryReport = path.join(output, 'factory-restarted.json');
    if (!fs.existsSync(factoryReport)) {
      assert.notEqual(process.pid, initial.pid);
      for (const win of windows) {
        assert.equal(await win.webContents.executeJavaScript('window.codeReloadTest.initialization()'), 1);
        assert.equal(await win.webContents.executeJavaScript('window.__manualReloadMarker'), 1);
      }
      fs.writeFileSync(factoryReport, JSON.stringify({ pid: process.pid, value: 1 }), 'utf8');
      await betaWindow.webContents.executeJavaScript('window.__codeReloadTest.state.tabs.at(-1).sending = true;');
      const main = path.join(code, 'electron', 'main.js');
      // 真正保存非法源码，确认没有自动预检；只有点击生产按钮才检查并明确拒载。
      const baselineSource = fs.readFileSync(main, 'utf8');
      fs.writeFileSync(main, baselineSource + '\nconst codeReloadSyntaxProbe = ;\n', 'utf8');
      await observeManualOnly(alphaWindow, 1, 1);
      fs.writeFileSync(path.join(output, 'no-auto-invalid.json'), JSON.stringify({ pid: process.pid }), 'utf8');
      await clickManualReload(alphaWindow);
      await waitFor(syntaxBlocked, '手动请求时非法代码明确拒载并保留旧进程', 10000);
      assert.equal(await alphaWindow.webContents.executeJavaScript('document.getElementById("btn-reload").disabled'), false);
      fs.writeFileSync(path.join(output, 'syntax-blocked.json'), JSON.stringify({ pid: process.pid }), 'utf8');
      fs.writeFileSync(path.join(code, 'electron', 'lib', 'code-reload-fixture.json'), JSON.stringify({ value: 42 }), 'utf8');
      fs.writeFileSync(main, baselineSource + '\n/** 修正测试语法后新增依赖和 IPC 注册，由全新生产进程实际执行。 */\nconst codeReloadSyntaxProbe = "fixed";\nconst codeReloadFixture = require("./lib/code-reload-fixture.json");\nipcMain.handle("test:code-reload", function readReloadFixture() { return codeReloadFixture.value; });\n', 'utf8');
      fs.appendFileSync(path.join(code, 'renderer', 'app.js'), '\nwindow.__manualReloadMarker = 2;\n', 'utf8');
      const rendererFixture = path.join(code, 'renderer', 'manual-reload-fixture.js');
      fs.writeFileSync(rendererFixture, 'export const present = true;\n', 'utf8');
      fs.appendFileSync(path.join(code, 'renderer', 'app.js'), '\nimport { manualReloadExport } from "./manual-reload-fixture.js";\n', 'utf8');
      await clickManualReload(alphaWindow);
      await waitFor(rendererBlocked, '手动预检拒绝缺少导出的前端模块', 10000);
      assert.equal(await alphaWindow.webContents.executeJavaScript('document.getElementById("btn-reload").disabled'), false);
      fs.writeFileSync(path.join(output, 'renderer-blocked.json'), JSON.stringify({ pid: process.pid }), 'utf8');
      fs.appendFileSync(rendererFixture, 'export const manualReloadExport = true;\n', 'utf8');
      await clickManualReload(alphaWindow);
      await waitFor(restartQueued, '修正后再次点击按钮进入重载队列', 10000);
      // 第一窗已准备，第二窗仍忙；此时修改第一窗草稿，验证最终阶段会重新采集。
      await alphaWindow.webContents.executeJavaScript('document.getElementById("input").value = "甲：等待期间继续输入";');
      assert.notEqual(process.pid, initial.pid);
      fs.writeFileSync(path.join(output, 'blocked.json'), JSON.stringify({ pid: process.pid, windows: windows.length }), 'utf8');
      await betaWindow.webContents.executeJavaScript('(function finish() { const test=window.__codeReloadTest; for(const tab of test.state.tabs) tab.sending=false; test.retryHotReload(); })()');
      // 此处不调用 quit/relaunch；第二次重启同样必须由生产协调器完成，监督进程等待最终报告。
      return;
    }
    const factoryRestart = JSON.parse(fs.readFileSync(factoryReport, 'utf8'));
    check(factoryRestart.pid !== initial.pid && factoryRestart.value === 1, '点击手动重载后启动新进程，并经真实 IPC 读到新的工厂初值');
    check(initial.pid !== process.pid && factoryRestart.pid !== process.pid, '再次点击手动重载后新增依赖和顶层 IPC 在第三个进程执行');
    check(fs.existsSync(path.join(output, 'no-auto-initial.json')), '全部窗口空闲时保存前后台源码均不自动加载');
    check(fs.existsSync(path.join(output, 'no-auto-invalid.json')), '重载后的新进程仍不因保存源码自动更新或预检');
    for (const win of windows) check(await win.webContents.executeJavaScript('window.codeReloadTest.initialization()') === 1, '后续重启仍实际执行修改后的工厂初值');
    check(fs.existsSync(path.join(output, 'blocked.json')), '有窗口任务未结束时保持旧进程运行');
    check(fs.existsSync(path.join(output, 'syntax-blocked.json')), '手动重载对非法代码明确拒载，修正后可再次点击');
    check(fs.existsSync(path.join(output, 'renderer-blocked.json')), '前端静态链接失败后恢复按钮，修正导出并再次点击才加载');
    const restored = [];
    for (const win of windows) restored.push(await inspectWindow(win));
    fs.writeFileSync(path.join(output, 'restored.json'), JSON.stringify(restored, null, 2), 'utf8');
    const byTitle = new Map();
    for (const item of restored) byTitle.set(item.tabs[0].title, item);
    const first = byTitle.get('甲标签一');
    const other = byTitle.get('乙标签一');
    check(Boolean(first && other), '两个原窗口按独立身份恢复，没有串窗口');
    check(first.tabs.length === 2 && other.tabs.length === 2, '自动保存关闭时双窗口全部四个标签仍恢复');
    check(first.text === '甲：等待期间继续输入', '重启前二次采集保留等待期间继续输入的最新草稿');
    check(other.text === '乙：当前草稿', '另一个窗口的当前草稿独立恢复');
    check(first.tabs[0].composer.text === '甲：后台草稿' && other.tabs[0].composer.text === '乙：后台草稿', '双窗口后台标签未发送草稿保留');
    check(first.attachments[0].name === '甲附件.txt' && other.attachments[0].name === '乙附件.txt', '双窗口附件及上下文按原归属恢复');
    for (const win of windows) {
      check(await win.webContents.executeJavaScript('window.codeReloadTest.read()') === 42, '新进程通过真实 preload 和 IPC 返回新依赖的值');
      check(await win.webContents.executeJavaScript('window.__manualReloadMarker') === 2, '手动重载同时执行最新前端代码');
      check(await win.webContents.executeJavaScript('document.getElementById("btn-reload").disabled === false'), '重载完成后手动入口恢复可用');
    }
    fs.writeFileSync(path.join(code, 'electron', 'lib', 'factory-initialization.js'), factorySource(2), 'utf8');
    fs.appendFileSync(path.join(code, 'renderer', 'app.js'), '\nwindow.__manualReloadMarker = 3;\n', 'utf8');
    await observeManualOnly(windows[0], 1, 2);
    check(true, '再次保存前后台源码不会重新启用自动重载');
    const sessions = path.join(userData, 'sessions');
    check(!fs.existsSync(sessions) || fs.readdirSync(sessions).length === 0, '一次性交接没有改写关闭自动保存的会话存档');
    await waitFor(consumed, '全部页面确认后消费交接快照', 5000);
    check(true, '全部窗口实际恢复后才删除一次性交接快照');
    completed = true;
    clearTimeout(watchdog);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ firstPid: initial.pid, factoryPid: factoryRestart.pid, secondPid: process.pid, passed, restored, error: null }, null, 2), 'utf8');
    app.exit(0);
  } catch (error) { fail(error); }

  /** 只收集并隐藏测试进程的生产主窗；桌宠和作品窗没有生产主窗 preload。 */
  function observeWindow(_event, win) {
    win.once('ready-to-show', hide);
    win.on('show', hide);
    win.webContents.once('did-finish-load', classify);
    /** 按真正加载的生产主页面识别主窗，创建事件发生时 preload 属性尚未完整。 */
    function classify() {
      const expected = require('url').pathToFileURL(path.join(code, 'renderer', 'index.html')).href;
      if (win.webContents.getURL() === expected) windows.push(win);
    }
    /** 不触碰用户窗口；测试窗口保持后台可运行。 */
    function hide() { if (!win.isDestroyed()) win.hide(); }
  }
  /** 判断真实页面访问口已加载；重载中不把异常当成初始化完成。 */
  async function initialized(win) {
    if (!win || win.isDestroyed() || win.webContents.isLoading()) return false;
    return win.webContents.executeJavaScript('Boolean(window.__codeReloadTest && document.getElementById("input"))');
  }
  /** 等待第一个完整生产页面。 */
  function firstWindow() { return initialized(windows[0]); }
  /** 等待两个生产页面均完成脚本初始化。 */
  async function twoWindows() { return windows.length === 2 && await initialized(windows[0]) && await initialized(windows[1]); }
  /** 从生产页面的真实错误提示确认语法失败没有被当成可加载候选。 */
  function syntaxBlocked() { return windows[0].webContents.executeJavaScript('Boolean(document.getElementById("status-hot-reload") && document.getElementById("status-hot-reload").textContent.includes("手动重载校验失败"))'); }
  /**
   * 读取前端整图预检的实际失败提示。
   * 无参数；只查看测试窗口状态栏。
   * @returns {Promise<boolean>} 缺少模块导出已被生产校验器拒绝时为 true。
   */
  function rendererBlocked() { return windows[0].webContents.executeJavaScript('Boolean(document.getElementById("status-hot-reload") && document.getElementById("status-hot-reload").textContent.includes("界面热更新失败"))'); }
  /** 读取生产页面可见的手动重载排队提示。 */
  function restartQueued() { return windows[1].webContents.executeJavaScript('Boolean(document.getElementById("status-hot-reload") && document.getElementById("status-hot-reload").textContent.includes("全部窗口"))'); }
  /** 确认全部一次性交接文件已经由真实页面恢复回执消费。 */
  function consumed() { return fs.readdirSync(path.join(userData, 'code-reload')).length === 0; }
  /** 每个成功项来自真实状态断言，不能靠源码字符串匹配代替。 */
  function check(value, message) { assert.ok(value, message); passed.push(message); }
  /** 测试总时限到达即失败，不伪装成重启完成。 */
  function expired() { fail(new Error('手动代码重载实测超时')); }
  /** 失败现场保留，退出的仅是本测试进程。 */
  function fail(error) {
    if (completed) return;
    completed = true;
    clearTimeout(watchdog);
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ error: error.stack, pid: process.pid, passed }, null, 2), 'utf8');
    app.exit(1);
  }
  /**
   * 在有界观察窗口内确认真实保存不会产生任何自动加载。
   * @param {Electron.BrowserWindow} win 当前测试主窗，必须保持同一文档与原有运行实现。
   * @param {number} expectedFactory 保存前已执行的后台初值。
   * @param {number} expectedMarker 保存前已执行的前端标记。
   * @returns {Promise<void>} 观察 1200ms 后核对文档、IPC、前端标记与无待重载通知；只读生产状态。
   */
  async function observeManualOnly(win, expectedFactory, expectedMarker) {
    const origin = await win.webContents.executeJavaScript('performance.timeOrigin');
    await new Promise(observationWindow);
    assert.equal(await win.webContents.executeJavaScript('performance.timeOrigin'), origin);
    assert.equal(await win.webContents.executeJavaScript('window.codeReloadTest.initialization()'), expectedFactory);
    assert.equal(await win.webContents.executeJavaScript('window.__manualReloadMarker'), expectedMarker);
    assert.equal(await win.webContents.executeJavaScript('(window.simple || window.sinpo).hotReloadStatus()'), null);
    /**
     * 等待覆盖原保存合并时长的负向观察窗，不将等待本身当成验证结果。
     * @param {function} resolve Promise 完成回调。
     * @returns {void} 只安排测试计时器，之后由真实状态断言判定是否自动重载。
     */
    function observationWindow(resolve) { setTimeout(resolve, 1200); }
  }

  /**
   * 点击真实生产重载按钮，保留按钮绑定、preload 与主进程 IPC。
   * @param {Electron.BrowserWindow} win 发起本次手动重载的测试主窗。
   * @returns {Promise<void>} 点击后由生产状态通知确认排队或失败；不直接调用 changed、flush 或 relaunch。
   */
  async function clickManualReload(win) {
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("btn-reload").disabled'), false);
    assert.equal(await win.webContents.executeJavaScript('document.getElementById("btn-reload").click(); document.getElementById("btn-reload").disabled'), true);
  }

  /** 在真实界面中准备当前和后台标签、附件，并精确控制任务忙状态。 */
  function seed(win, label, busy) {
    return win.webContents.executeJavaScript('(async function seed(){const test=window.__codeReloadTest; const state=test.state; state.autoSave=false; test.newTab(); const first=state.tabs.at(-1); first.title='+JSON.stringify(label+'标签一')+'; document.getElementById("input").value='+JSON.stringify(label+'：后台草稿')+'; test.rememberComposer(first); test.newTab(); const second=state.tabs.at(-1); second.title='+JSON.stringify(label+'标签二')+'; document.getElementById("input").value='+JSON.stringify(label+'：当前草稿')+'; state.attachments=[{name:'+JSON.stringify(label+'附件.txt')+',path:'+JSON.stringify(path.join(workspace,label+'附件.txt'))+'}]; state.contextPaths=['+JSON.stringify(label+'引用.txt')+']; second.sending='+JSON.stringify(busy)+'; test.rememberComposer(second);})()');
  }
  /** 返回实际页面恢复后的标签、草稿和附件；不从交接 JSON 推测运行效果。 */
  function inspectWindow(win) {
    return win.webContents.executeJavaScript('(function inspect(){const state=window.__codeReloadTest.state; return {tabs:state.tabs,active:state.activeTab,text:document.getElementById("input").value,attachments:state.attachments,paths:state.contextPaths};})()');
  }
}

/** 创建已执行的工厂闭包样本；phase 是待验证的声明初值，工厂与读取方法结构保持一致。 */
function factorySource(phase) {
  return 'function createService() { let phase = ' + phase + '; function readPhase() { return phase; } return { readPhase }; } module.exports = createService();';
}

/** 识别本产品实际追加的自动重启交接参数。 */
function isReloadArgument(argument) { return argument.startsWith('--spcode-code-reload='); }
/** 顶层失败保留非零退出码和诊断。 */
function failed(error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }

if (process.versions.electron) application(process.argv[2]).catch(failed);
else supervise().catch(failed);
