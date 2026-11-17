'use strict';

/**
 * 在真实打包模式中验证生产入口、业务模块、preload、界面和外置资料的磁盘热更新。
 * Node 入口复制 Electron 分发文件到系统临时目录，再无 app 参数启动 resources/app；
 * Electron 入口只保存这一临时安装副本，所有更新必须由生产 fs.watch 自动发现。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const childProcess = require('child_process');

if (process.versions.electron) runPackagedApplication();
else preparePackagedApplication();

/**
 * 创建与 asar:false 发布版相同的 resources/app 布局并运行独立程序。
 * 依赖通过目录连接复用；用户数据、程序源码及外置资料全部位于临时目录。
 * @returns {void} 子进程退出后将实际退出码交给命令调用方，保留报告和现场。
 */
function preparePackagedApplication() {
  const sourceRoot = path.resolve(__dirname, '..');
  const electronExecutable = require('electron');
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-hot-reload-packaged-'));
  const distribution = path.join(output, 'distribution');
  const application = path.join(distribution, 'resources', 'app');
  fs.cpSync(path.dirname(electronExecutable), distribution, { recursive: true });
  fs.mkdirSync(application, { recursive: true });
  for (const directory of ['electron', 'renderer']) {
    fs.cpSync(path.join(sourceRoot, directory), path.join(application, directory), { recursive: true });
  }
  fs.mkdirSync(path.join(application, 'scripts'));
  fs.copyFileSync(__filename, path.join(application, 'scripts', path.basename(__filename)));
  for (const name of ['icons.png', 'icons.ico']) {
    fs.copyFileSync(path.join(sourceRoot, name), path.join(application, name));
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.build.asar, false, '默认发布必须使用可监听的 resources/app 源码布局');
  manifest.main = 'scripts/' + path.basename(__filename);
  fs.writeFileSync(path.join(application, 'package.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.symlinkSync(path.join(sourceRoot, 'node_modules'), path.join(application, 'node_modules'), 'junction');
  const seedRoot = path.join(distribution, 'resources', 'app-root');
  fs.mkdirSync(path.join(seedRoot, 'skills', 'packaged-fixture'), { recursive: true });
  fs.mkdirSync(path.join(seedRoot, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(seedRoot, 'skills', 'packaged-fixture', 'SKILL.md'), '# 打包技能第一版\n初始技能内容', 'utf8');
  fs.writeFileSync(path.join(seedRoot, 'rules', 'packaged-fixture.md'), '# 打包规则第一版\n初始规则内容', 'utf8');
  fs.appendFileSync(path.join(application, 'renderer', 'app.js'),
    '\nwindow.__packagedHotReloadTest = { state, newTab, rememberComposer, retryHotReload };\n', 'utf8');
  // Electron 根据可执行文件名识别开发分发版；产品名副本由原生实现进入打包分支。
  const packagedExecutable = path.join(distribution, 'SpCodePackagedHotReloadTest.exe');
  fs.copyFileSync(path.join(distribution, path.basename(electronExecutable)), packagedExecutable);
  const environment = { ...process.env, SPCODE_PACKAGED_TEST_OUTPUT: output };
  delete environment.ELECTRON_RUN_AS_NODE;
  console.log('PACKAGED_FIXTURE ' + output);
  const result = childProcess.spawnSync(packagedExecutable, [], {
    cwd: distribution, env: environment, encoding: 'utf8', timeout: 110000, windowsHide: true, maxBuffer: 8 * 1024 * 1024
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}

/**
 * 启动完整生产主进程并逐项验证真实发布进程中的自动更新。
 * @returns {void} 验收结果写入临时 report.json，测试只退出自己创建的 Electron 实例。
 */
function runPackagedApplication() {
  const { app, ipcMain } = require('electron');
  const root = path.resolve(__dirname, '..');
  const output = process.env.SPCODE_PACKAGED_TEST_OUTPUT;
  assert.ok(output, '打包子进程必须由本脚本创建');
  const userData = path.join(output, 'user-data');
  const workspace = path.join(output, 'workspace');
  const evidence = { output, pid: process.pid, isPackaged: app.isPackaged, defaultApp: Boolean(process.defaultApp), passed: [], notifications: [], errors: [] };
  let mainWindow = null;
  let runtime = null;
  let navigationCount = 0;
  let finished = false;
  let watchdog = null;

  for (const directory of [userData, workspace, path.join(output, 'models'), path.join(output, 'session-data'), path.join(output, 'crash-dumps')]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  app.setName('SpCodePackagedHotReloadVerification');
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

  /** 记录已经实际满足的断言，错误保留完整现场供复查。 */
  function check(value, message) {
    assert.ok(value, message);
    evidence.passed.push(message);
    console.log('PASS ' + message);
  }

  /** 保存报告并退出本测试进程，不触碰用户正在运行的软件。 */
  function finish(error) {
    if (finished) return;
    finished = true;
    if (watchdog) clearTimeout(watchdog);
    if (error) {
      evidence.failure = String(error.stack || error);
      console.error('FAIL ' + evidence.failure);
    }
    evidence.navigationCount = navigationCount;
    if (mainWindow && !mainWindow.isDestroyed()) {
      evidence.window = { windowId: mainWindow.id, webContentsId: mainWindow.webContents.id, pid: process.pid };
    }
    if (runtime) runtime.close();
    const report = path.join(output, 'report.json');
    fs.writeFileSync(report, JSON.stringify(evidence, null, 2), 'utf8');
    console.log('REPORT ' + report);
    app.exit(error ? 1 : 0);
  }

  /** 有界等待可观察状态；超时携带通知及界面错误，固定延时不算通过。 */
  function waitFor(predicate, label, timeoutMs = 15000) {
    return new Promise(begin);
    function begin(resolve, reject) {
      const deadline = Date.now() + timeoutMs;
      inspect();
      async function inspect() {
        try {
          const value = await predicate();
          if (value) { resolve(value); return; }
          if (Date.now() >= deadline) throw new Error(label + ' 等待超时；诊断：' + JSON.stringify(evidence));
          setTimeout(inspect, 25);
        } catch (error) { reject(error); }
      }
    }
  }

  /** 在实际生产主窗口执行页面表达式，沿用真实 preload 和 IPC。 */
  function page(source) { return mainWindow.webContents.executeJavaScript(source); }

  /** 页面完成生产初始化后才查询 DOM，避免把导航过程当成可交互状态。 */
  async function initializedPage() {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isLoading()) return false;
    return page('Boolean(window.__packagedHotReloadTest && document.getElementById("modal").classList.contains("hidden"))');
  }

  /** 精确替换临时程序中唯一锚点；测试不修改项目源码，也不用正则跨段替换。 */
  function saveVersion(relative, anchor, replacement) {
    const file = path.join(root, relative);
    const original = fs.readFileSync(file, 'utf8');
    const position = original.indexOf(anchor);
    assert.ok(position >= 0 && original.lastIndexOf(anchor) === position, relative + ' 的保存锚点唯一');
    fs.writeFileSync(file, original.substring(0, position) + replacement + original.substring(position + anchor.length), 'utf8');
  }

  /** 只旁路记录生产通知，保留热重载创建参数、监听路径与实际实现。 */
  function captureRuntime(options) {
    const notifyProduction = options.notify;
    options.notify = notify;
    function notify(update) {
      evidence.notifications.push(update);
      return notifyProduction(update);
    }
    runtime = createProductionRuntime(options);
    return runtime;
  }

  /** 隐藏本测试新建的窗口并观察实际文档加载，不操作其他进程。 */
  function observeWindow(_event, win) {
    win.hide();
    win.on('show', hideWindow);
    function hideWindow() { win.hide(); }
    if (!mainWindow) {
      mainWindow = win;
      win.webContents.on('did-start-loading', countNavigation);
      function countNavigation() { navigationCount++; }
    }
    win.webContents.on('preload-error', preloadFailed);
    function preloadFailed(_event, file, error) { evidence.errors.push({ type: 'preload', file, message: String(error && error.message) }); }
    win.webContents.on('render-process-gone', rendererGone);
    function rendererGone(_event, details) { if (!finished) evidence.errors.push({ type: 'renderer-gone', details }); }
    win.webContents.on('console-message', consoleMessage);
    function consoleMessage(event) {
      if (event.level === 'error') evidence.errors.push({ type: 'console', message: event.message, sourceId: event.sourceId, line: event.lineNumber });
    }
  }

  /** 保留生产诊断，任何真实界面异常均不能冒充更新成功。 */
  function recordClientError(_event, payload) { evidence.errors.push({ type: 'renderer', payload }); }

  /** 判断目标通知是否由保存事件到达；不会主动调用 changed、flush 或重载。 */
  function notified(kind, relative, startingIndex) {
    for (let index = startingIndex; index < evidence.notifications.length; index++) {
      const update = evidence.notifications[index];
      if (update.kind === kind && update.paths.includes(relative)) return true;
    }
    return false;
  }

  app.on('browser-window-created', observeWindow);
  ipcMain.on('log:client', recordClientError);
  const hotReload = require('../electron/lib/hot-reload');
  const createProductionRuntime = hotReload.createHotReload;
  hotReload.createHotReload = captureRuntime;

  /** 验收真实磁盘保存后的运行结果、状态保留和外置资料读取。 */
  async function verifyApplication() {
    await app.whenReady();
    await waitFor(initializedPage, '发布版生产主窗口初始化');
    check(app.isPackaged === true && !process.defaultApp, '真实无 app 参数启动，Electron 确认 app.isPackaged 为 true');
    check(!fs.existsSync(path.join(process.resourcesPath, 'app.asar')), '临时发布目录不存在旧 app.asar，未从归档加载');
    check(app.getAppPath() === root && root === path.join(process.resourcesPath, 'app'), '生产代码实际从发布目录 resources/app 加载');
    check(Boolean(runtime), '生产入口实际创建热重载并完成启动');
    const firstState = await page('(window.simple || window.sinpo).getState()');
    check(firstState.appRoot === path.join(userData, 'app-root'), '发布版外置资料使用隔离的 userData/app-root');
    check(firstState.assemblyKey === 'local', '业务代码更新前实际 IPC 返回原始结果');
    const original = { pid: process.pid, windowId: mainWindow.id, webContentsId: mainWindow.webContents.id };

    await page('(window.simple || window.sinpo).setWorkspace(' + JSON.stringify(workspace) + ')');
    const ids = await page('(function seed() {' +
      'const test = window.__packagedHotReloadTest; test.newTab(); const first = test.state.tabs[test.state.tabs.length - 1];' +
      'first.title = "发布版后台标签"; document.getElementById("input").value = "后台草稿"; test.rememberComposer(first);' +
      'test.newTab(); const second = test.state.tabs[test.state.tabs.length - 1]; second.title = "发布版当前标签";' +
      'document.getElementById("input").value = "发布版未发送草稿"; test.state.contextPaths = ["reference.txt"];' +
      'test.state.attachments = [{path:' + JSON.stringify(path.join(workspace, 'reference.txt')) + ',name:"reference.txt"}];' +
      'test.rememberComposer(second); second.sending = true; second.draining = true;' +
      'return {first:first.id,second:second.id,count:test.state.tabs.length}; })()');
    const before = navigationCount;
    let start = evidence.notifications.length;
    fs.appendFileSync(path.join(root, 'renderer', 'styles.css'), '\n:root { --packaged-hot-reload-marker: packaged-css-v2; }\n', 'utf8');
    await waitFor(cssQueued, '发布版真实 CSS 保存通知和繁忙排队');
    async function cssQueued() {
      if (!notified('renderer', 'renderer/styles.css', start)) return false;
      return page('Boolean(document.getElementById("status-hot-reload") && document.getElementById("status-hot-reload").textContent.includes("排队"))');
    }
    check(navigationCount === before, '发布版繁忙期间实际 CSS 保存只排队，不打断页面');
    await page('(function finishTask() {const test=window.__packagedHotReloadTest;for(const tab of test.state.tabs){tab.sending=false;tab.draining=false;}test.retryHotReload();})()');
    await waitFor(cssApplied, '保存触发的真实 CSS 加载与草稿恢复');
    async function cssApplied() {
      if (navigationCount <= before || !await initializedPage()) return false;
      return page('getComputedStyle(document.documentElement).getPropertyValue("--packaged-hot-reload-marker").trim() === "packaged-css-v2" && window.__packagedHotReloadTest.state.activeTab === ' + JSON.stringify(ids.second));
    }
    check(true, '发布版 fs.watch 自动触发重载，页面实际计算样式已更新');
    const restored = await page('(function restored(){const state=window.__packagedHotReloadTest.state;return {active:state.activeTab,count:state.tabs.length,text:document.getElementById("input").value,tabs:state.tabs,attachments:state.attachments,paths:state.contextPaths,snapshot:sessionStorage.getItem("spcode:hot-reload")};})()');
    check(restored.active === ids.second && restored.count === ids.count && restored.text === '发布版未发送草稿', '发布版全部标签、当前选择与未发送草稿跨重载保留');
    let first = null;
    for (const tab of restored.tabs) if (tab.id === ids.first) first = tab;
    check(first && first.composer.text === '后台草稿', '发布版后台标签草稿跨真实导航保留');
    check(restored.attachments[0].name === 'reference.txt' && restored.paths[0] === 'reference.txt' && restored.snapshot === null, '发布版草稿附件、引用保留且一次性快照已消费');

    start = evidence.notifications.length;
    saveVersion('electron/lib/assembly.js', "return name ? `local:${name}` : 'local';", "return name ? `local:${name}` : 'local:packaged-v2';");
    await waitFor(assemblyApplied, '发布版业务代码保存自动生效');
    async function assemblyApplied() {
      if (!notified('runtime', 'electron/lib/assembly.js', start)) return false;
      const current = await page('(window.simple || window.sinpo).getState()');
      return current.assemblyKey === 'local:packaged-v2';
    }
    check(true, '真实业务文件保存后，生产 IPC 返回新 assemblyKey，未手动调用 changed 或 flush');

    start = evidence.notifications.length;
    saveVersion('electron/main.js', "    workspace: workspaceByWin.get(win) || '',", "    workspace: workspaceByWin.get(win) || '', packagedTestMain: 'main-v2',");
    await waitFor(mainApplied, '发布版主入口既有 IPC 原位更新');
    async function mainApplied() {
      if (!notified('runtime', 'electron/main.js', start)) return false;
      const current = await page('(window.simple || window.sinpo).getState()');
      return current.packagedTestMain === 'main-v2';
    }
    check(true, '真实 main.js 保存后既有 IPC 返回新值，未重新启动主进程');

    start = evidence.notifications.length;
    saveVersion('electron/preload.js', 'const api = {', "const api = {\n  packagedTestVersion: function packagedTestVersion() { return 'preload-v2'; },");
    await waitFor(preloadApplied, '发布版 preload 保存后自动重载');
    async function preloadApplied() {
      if (!notified('renderer', 'electron/preload.js', start) || !await initializedPage()) return false;
      return page('Boolean((window.simple || window.sinpo).packagedTestVersion && (window.simple || window.sinpo).packagedTestVersion() === "preload-v2")');
    }
    check(true, '真实 preload 保存后新桥接方法生效，原窗口继续运行');

    start = evidence.notifications.length;
    fs.appendFileSync(path.join(root, 'renderer', 'app.js'), '\nwindow.__packagedRendererVersion = "renderer-v2";\n', 'utf8');
    await waitFor(rendererApplied, '发布版 renderer 脚本保存自动重载');
    async function rendererApplied() {
      if (!notified('renderer', 'renderer/app.js', start) || !await initializedPage()) return false;
      return page('window.__packagedRendererVersion === "renderer-v2" && document.getElementById("input").value === "发布版未发送草稿"');
    }
    check(true, '真实 renderer 脚本保存后新逻辑执行，并连续保留草稿');

    start = evidence.notifications.length;
    const skillFile = path.join(firstState.appRoot, 'skills', 'packaged-fixture', 'SKILL.md');
    fs.writeFileSync(skillFile, '# 打包技能第二版\n技能真实更新内容', 'utf8');
    await waitFor(skillApplied, '发布版外置技能保存通知及实际读取');
    async function skillApplied() {
      let notice = false;
      for (let index = start; index < evidence.notifications.length; index++) {
        const update = evidence.notifications[index];
        if (update.kind === 'data' && update.paths.some(skillPath)) notice = true;
      }
      function skillPath(relative) { return relative.endsWith('/skills/packaged-fixture/SKILL.md'); }
      if (!notice) return false;
      const skills = await page('(window.simple || window.sinpo).listSkills()');
      for (const skill of skills) if (skill.id === 'packaged-fixture' && skill.body.includes('技能真实更新内容')) return true;
      return false;
    }
    check(true, '发布版 userData/app-root 外置技能保存仍自动通知，实际业务读取新内容');

    start = evidence.notifications.length;
    const ruleFile = path.join(firstState.appRoot, 'rules', 'packaged-fixture.md');
    fs.writeFileSync(ruleFile, '# 打包规则第二版\n规则真实更新内容', 'utf8');
    await waitFor(ruleApplied, '发布版外置规则保存通知及实际读取');
    async function ruleApplied() {
      let notice = false;
      for (let index = start; index < evidence.notifications.length; index++) {
        const update = evidence.notifications[index];
        if (update.kind === 'data' && update.paths.some(rulePath)) notice = true;
      }
      function rulePath(relative) { return relative.endsWith('/rules/packaged-fixture.md'); }
      if (!notice) return false;
      const rules = await page('(window.simple || window.sinpo).listRules()');
      for (const rule of rules) if (rule.id === 'packaged-fixture' && rule.body.includes('规则真实更新内容')) return true;
      return false;
    }
    check(true, '发布版 userData/app-root 外置规则保存仍自动通知，实际业务读取新内容');
    check(process.pid === original.pid && mainWindow.id === original.windowId && mainWindow.webContents.id === original.webContentsId, '所有自动更新后 PID、BrowserWindow 和 WebContents 保持不变');
    check(await page('document.getElementById("input").value === "发布版未发送草稿"'), '全部更新结束后未发送草稿仍完整保留');
    check(evidence.errors.length === 0 && !evidence.notifications.some(failedNotice), '生产发布进程未出现界面异常、原位更新失败或重启要求');
    function failedNotice(update) { return update.kind === 'error' || update.kind === 'restart'; }
    evidence.restored = restored;
  }

  watchdog = setTimeout(timeout, 90000);
  function timeout() { finish(new Error('真实发布版热重载验收超时')); }
  try {
    require('../electron/main.js');
    hotReload.createHotReload = createProductionRuntime;
    verifyApplication().then(success, failure);
    function success() { finish(null); }
    function failure(error) { finish(error); }
  } catch (error) {
    finish(error);
  }
}
