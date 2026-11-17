'use strict';

/**
 * 用多个真正退出后重开的生产 Electron 进程核对会话标签恢复。
 * 普通 Node 入口创建隔离用户目录并依次启动各阶段；Electron 入口加载生产主进程与临时界面副本。
 * 不连接模型、不读取真实用户会话，也不重启正在承载用户任务的 SpCode。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

if (!process.versions.electron) {
  runParent();
} else {
  runChild();
}

/**
 * 依次启动独立生产进程，确保恢复不依赖上一个进程的内存或 sessionStorage。
 * 无参数；同步运行种子、恢复关闭、再次恢复及自动保存关闭后的重开阶段，失败保留临时目录并设置退出码。
 */
function runParent() {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-session-restart-'));
  const userData = path.join(output, 'user-data');
  const workspace = path.join(output, 'workspace-a');
  const alternate = path.join(output, 'workspace-b');
  for (const dir of [userData, workspace, alternate, path.join(output, 'models')]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    locale: 'zh', theme: 'dark', autoSave: true, onboardingCompleted: true,
    trainingDataEnabled: false, desktopAlive: false, cursorDirect: false,
    providers: [], currentModelId: 'local-gguf', modelsDir: path.join(output, 'models'),
    models: [{ id: 'local-gguf', name: '本地模型', type: 'local', model: '', enabled: true }],
    capabilityDefaults: {}, assemblies: {}, recents: []
  }), 'utf8');
  const renderer = path.join(output, 'renderer');
  fs.cpSync(path.join(root, 'renderer'), renderer, { recursive: true });
  fs.mkdirSync(path.join(output, 'electron', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(root, 'electron', 'lib', 'image-gen-options.js'), path.join(output, 'electron', 'lib', 'image-gen-options.js'));
  const appFile = path.join(renderer, 'app.js');
  const source = fs.readFileSync(appFile, 'utf8');
  const ready = 'await receiveHotReload(await api.hotReloadStatus());';
  const position = source.indexOf(ready);
  assert.ok(position >= 0 && source.lastIndexOf(ready) === position, '初始化完成锚点唯一');
  // 仅在临时副本追加观察口和初始化标记，不替换生产恢复、持久化或 IPC 实现。
  fs.writeFileSync(appFile, source.substring(0, position + ready.length)
    + '\n  window.__sessionRestartReady = true;'
    + source.substring(position + ready.length)
    + '\nwindow.__sessionRestartTest = { state, newTab, switchToTab, persistTab, renderTabs, openHistorySession };\n', 'utf8');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const results = [];
  for (const phase of ['seed', 'restore-close', 'restore-again', 'restore-after-disabled', 'restore-renumbered']) {
    const result = require('node:child_process').spawnSync(require('electron'), [__filename, output, phase], {
      cwd: root, env, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    results.push({ phase, status: result.status, error: result.error && result.error.message });
    if (result.status !== 0) { process.exitCode = 1; break; }
  }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ output, results }, null, 2), 'utf8');
  console.log('REPORT ' + path.join(output, 'report.json'));
}

/**
 * 在单次真实启动中执行指定验收阶段。
 * 从命令行读取独立输出目录和阶段名；所有磁盘副作用仅发生在该临时目录，异常使本进程非零退出。
 */
function runChild() {
  const { app, BrowserWindow } = require('electron');
  const output = process.argv[2];
  const phase = process.argv[3];
  const evidence = { phase, pid: process.pid, passed: [], errors: [] };
  let win = null;
  let finished = false;
  const userData = path.join(output, 'user-data');
  app.setName('SpCodeSessionRestartVerification');
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  fs.mkdirSync(path.join(output, 'crash-dumps'), { recursive: true });
  app.setPath('crashDumps', path.join(output, 'crash-dumps'));
  const originalLoadFile = BrowserWindow.prototype.loadFile;
  /**
   * 将生产主界面定向到只增加观察口的临时副本。
   * @param {string} file 原始页面路径。
   * @param {object} options 原样交给 Electron 的加载选项。
   * @returns {Promise<void>} 原生加载结果；宠物和其他窗口仍使用生产页面。
   */
  BrowserWindow.prototype.loadFile = function loadObservedPage(file, options) {
    if (file === path.join(root, 'renderer', 'index.html')) file = path.join(output, 'renderer', 'index.html');
    return originalLoadFile.call(this, file, options);
  };
  app.on('browser-window-created', observe);
  const watchdog = setTimeout(expired, 30000);
  /** 超时使当前阶段失败；无参数，仅关闭本测试进程。 */
  function expired() { finish(new Error('会话重开验收超时')); }
  /**
   * 隐藏测试创建的窗口并收集生产界面错误。
   * @param {object} event Electron 窗口创建事件。
   * @param {BrowserWindow} window 当前测试进程的新窗口。
   * @returns {void} 首个窗口登记为测试主窗，不接触用户的其他进程。
   */
  function observe(event, window) {
    window.hide();
    window.on('show', hide);
    /** 无参数；阻止本测试窗口遮挡用户桌面，不改变生产业务。 */
    function hide() { window.hide(); }
    if (!win) win = window;
    window.webContents.on('console-message', recordError);
    /** event为真实控制台事件；仅记录error级别，返回undefined。 */
    function recordError(event) {
      if (event.level === 'error') evidence.errors.push(event.message);
    }
  }
  /**
   * 保存当前阶段的完整结果并真正退出进程。
   * @param {Error|null} error 失败原因；null 表示成功。
   * @returns {Promise<void>} 在退出前刷新 Chromium 的本地存储，下一阶段使用相同用户目录。
   */
  async function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (error) { evidence.failure = String(error.stack || error); console.error(evidence.failure); }
    if (win && !win.isDestroyed()) await win.webContents.session.flushStorageData();
    fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify(evidence, null, 2), 'utf8');
    app.quit();
    app.exit(error ? 1 : 0);
  }
  /** name为断言说明，value为真实执行结果；失败抛出，成功追加证据，返回undefined。 */
  function check(name, value) {
    assert.ok(value, name);
    evidence.passed.push(name);
    console.log('PASS ' + phase + ' ' + name);
  }
  /** source为仅对本测试主窗执行的表达式；返回原生executeJavaScript的Promise结果。 */
  function page(source) { return win.webContents.executeJavaScript(source); }
  /**
   * 等待真实页面完成生产初始化。
   * 无参数，返回Promise<void>；30秒总看门狗控制失败，不依赖固定睡眠认定初始化成功。
   */
  async function waitReady() {
    while (!win || win.webContents.isLoading() || !await page('Boolean(window.__sessionRestartReady)')) {
      await new Promise(nextPoll);
    }
    /** resolve为当前轮询的兑现函数；25毫秒后继续检查，不改变页面状态。 */
    function nextPoll(resolve) { setTimeout(resolve, 25); }
  }
  /**
   * 按阶段准备三个标签、核对冷启动恢复或验证关闭后不复活。
   * 无参数，返回Promise<void>；模型不被调用，会话与草稿通过生产IPC写入临时用户目录。
   */
  async function verify() {
    await app.whenReady();
    await waitReady();
    const expectedFile = path.join(output, 'expected.json');
    if (phase === 'restore-renumbered') {
      const expected = JSON.parse(fs.readFileSync(path.join(output, 'renumber.json'), 'utf8'));
      const actual = await page('(function restoredWindow(){const state=window.__sessionRestartTest.state;return {ids:state.tabs.map(function identity(tab){return tab.id;}),key:state.sessionLayoutKey};})()');
      check('原第二主窗变成新进程第一主窗后仍恢复自己的三个标签', JSON.stringify(actual.ids) === JSON.stringify(expected.ids));
      check('窗口运行编号变化但持久身份保持不变', win.id === 1 && expected.previousWindowId !== win.id && actual.key === expected.key);
      check('主动关闭的其他主窗没有在重开时复活', BrowserWindow.getAllWindows().filter(isMainWindow).length === 1);
    } else if (phase === 'seed') {
      const ids = await page('(async function seedTabs() {'
        + 'const test=window.__sessionRestartTest; const state=test.state; const api=window.simple||window.sinpo;'
        + 'await api.setWorkspace(' + JSON.stringify(path.join(output, 'workspace-a')) + '); state.workspace=' + JSON.stringify(path.join(output, 'workspace-a')) + ';'
        + 'test.newTab(); const a=state.tabs[state.tabs.length-1]; a.title="记录甲"; a.messages=[{role:"user",text:"甲的正文"},{role:"assistant",text:"甲的回复"}]; document.getElementById("input").value="甲的草稿"; await test.persistTab(a);'
        + 'state.workspace=' + JSON.stringify(path.join(output, 'workspace-b')) + '; test.newTab(); const b=state.tabs[state.tabs.length-1]; b.title="记录乙"; b.messages=[{role:"user",text:"乙的正文"}]; document.getElementById("input").value="乙的草稿"; await test.persistTab(b);'
        + 'state.workspace=' + JSON.stringify(path.join(output, 'workspace-a')) + '; test.newTab(); const c=state.tabs[state.tabs.length-1]; c.title="空白记录"; test.renderTabs(); await test.switchToTab(b.id);'
        + 'return {ids:[a.id,b.id,c.id],active:b.id,scope:(await api.getState()).sessionLayoutKey}; })()');
      check('退出前确实存在三个独立标签', ids.ids.length === 3 && new Set(ids.ids).size === 3);
      check('主进程分配了窗口专属的持久化键', typeof ids.scope === 'string' && ids.scope.startsWith('spcode:open-tabs:'));
      fs.writeFileSync(expectedFile, JSON.stringify(ids), 'utf8');
      await verifyWindowIsolation(ids.scope);
    } else {
      const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
      const restored = await page('(function inspectTabs(){const state=window.__sessionRestartTest.state;return {ids:state.tabs.map(function identity(tab){return tab.id;}),active:state.activeTab,workspace:state.workspace,draft:document.getElementById("input").value,tabs:state.tabs.map(function snapshot(tab){return {id:tab.id,title:tab.title,messages:tab.messages,composer:tab.composer};}),hot:sessionStorage.getItem("spcode:hot-reload")};})()');
      evidence.restored = restored;
      const wanted = phase === 'restore-close' ? expected.ids : expected.ids.slice(1);
      const scope = await page('(window.simple||window.sinpo).getState().then(function key(settings){return settings.sessionLayoutKey;})');
      check('新进程沿用原窗口的持久化键', scope === expected.scope);
      check('真正退出重开后标签数量和顺序一致', JSON.stringify(restored.ids) === JSON.stringify(wanted));
      check('恢复原来选中的标签及其项目', restored.active === expected.active && restored.workspace === path.join(output, 'workspace-b'));
      check('恢复当前标签未发送的草稿', restored.draft === '乙的草稿');
      check('恢复使用冷启动路径而非热重载快照', restored.hot === null);
      const b = restored.tabs.find(function second(tab) { return tab.id === expected.ids[1]; });
      check('会话正文独立且空白标签仍为空', b.messages[0].text === '乙的正文' && restored.tabs[restored.tabs.length - 1].messages.length === 0);
      if (phase === 'restore-close') {
        const a = restored.tabs[0];
        check('后台标签的正文和草稿也完整恢复', a.messages[0].text === '甲的正文' && a.composer.text === '甲的草稿');
        await page('document.querySelector("[data-close=\\"' + expected.ids[0] + '\\"]").click()');
        const remaining = await page('window.__sessionRestartTest.state.tabs.map(function identity(tab){return tab.id;})');
        check('关闭一个标签后仅剩其余两个', JSON.stringify(remaining) === JSON.stringify(expected.ids.slice(1)));
      } else {
        const history = await page('(window.simple||window.sinpo).loadSessions()');
        check('主动关闭的标签不复活，但会话仍保留在历史记录', history.some(function closed(item) { return item.id === expected.ids[0]; }));
        if (phase === 'restore-again') {
          const unchanged = await page('(function disabledSave(){const test=window.__sessionRestartTest;const key=test.state.sessionLayoutKey;const before=localStorage.getItem(key);test.state.autoSave=false;test.newTab();test.renderTabs();return localStorage.getItem(key)===before;})()');
          check('关闭自动保存后新增标签不覆盖已保存的打开清单', unchanged);
        }
      }
      if (phase === 'restore-after-disabled') await prepareRenumberedWindow();
    }
    check('生产界面没有脚本或加载错误', evidence.errors.length === 0);
    if (phase === 'restore-close' || phase === 'restore-renumbered') {
      // 隐藏窗口没有可截图的显示表面；只让本测试窗口短暂显示且不激活，等真实合成帧后再取证。
      win.removeAllListeners('show');
      win.showInactive();
      await page('new Promise(function composed(resolve){requestAnimationFrame(function frame(){requestAnimationFrame(resolve);});})');
      const screenshot = await win.webContents.capturePage({ x: 0, y: 0, width: 1280, height: 180 });
      win.hide();
      evidence.screenshot = path.join(output, phase + '.png');
      fs.writeFileSync(evidence.screenshot, screenshot.toPNG());
    }
  }
  /** candidate为本测试进程的窗口；按真实主界面地址识别，返回boolean，不改变窗口。 */
  function isMainWindow(candidate) { return candidate.webContents.getURL().endsWith('/renderer/index.html'); }
  /**
   * 关闭原第一主窗，让第二主窗在下次启动取得不同运行编号，并验证刚开启自动保存的标签。
   * 无参数，返回Promise<void>；只操作测试窗口和临时配置，保留原第二主窗稳定身份用于后续核对。
   */
  async function prepareRenumberedWindow() {
    const second = BrowserWindow.getAllWindows().find(otherMainWindow);
    /** candidate为测试窗口；返回是否已恢复的另一个主窗，不修改状态。 */
    function otherMainWindow(candidate) { return candidate !== win && isMainWindow(candidate); }
    assert.ok(second, '整体退出后第二主窗也应恢复');
    const data = await second.webContents.executeJavaScript('(async function enableAutoSave(){const test=window.__sessionRestartTest;test.state.autoSave=false;test.newTab();test.newTab();test.renderTabs();document.querySelector("[data-act=toggle-autosave]").click();while(!test.state.autoSave || JSON.parse(localStorage.getItem(test.state.sessionLayoutKey)).tabs.length!==3){await new Promise(function poll(resolve){setTimeout(resolve,25);});}return {ids:test.state.tabs.map(function identity(tab){return tab.id;}),key:test.state.sessionLayoutKey};})()');
    data.previousWindowId = second.id;
    check('开启自动保存后立即建立全部三个标签的恢复清单', data.ids.length === 3);
    fs.writeFileSync(path.join(output, 'renumber.json'), JSON.stringify(data), 'utf8');
    const first = win;
    win = second;
    await new Promise(closeFirst);
    /** resolve为真实closed事件的兑现函数；等到窗口确实关闭再退出应用，返回undefined。 */
    function closeFirst(resolve) { first.once('closed', resolve); first.close(); }
  }
  /**
   * 验证同进程的第二主窗保存标签时不覆盖第一主窗。
   * @param {string} firstKey 第一主窗由生产主进程分配的持久化键。
   * @returns {Promise<void>} 两个真实主窗的键和独立清单核对通过后兑现，仅改变测试用户目录。
   */
  async function verifyWindowIsolation(firstKey) {
    const before = await page('localStorage.getItem(' + JSON.stringify(firstKey) + ')');
    await page('(window.simple||window.sinpo).newWindow()');
    let second = null;
    while (!second || second.webContents.isLoading() || !await second.webContents.executeJavaScript('Boolean(window.__sessionRestartReady)')) {
      for (const candidate of BrowserWindow.getAllWindows()) {
        if (candidate !== win && candidate.webContents.getURL().endsWith('/renderer/index.html')) second = candidate;
      }
      await new Promise(nextWindowPoll);
    }
    /** resolve为窗口初始化轮询的兑现函数；25毫秒后核对，不以延时认定成功。 */
    function nextWindowPoll(resolve) { setTimeout(resolve, 25); }
    const other = await second.webContents.executeJavaScript('(async function seedSecondWindow(){const test=window.__sessionRestartTest;test.state.workspace=' + JSON.stringify(path.join(output, 'workspace-a')) + ';test.newTab();test.state.tabs[0].title="第二窗口的记录";test.renderTabs();return {key:test.state.sessionLayoutKey,layout:localStorage.getItem(test.state.sessionLayoutKey)};})()');
    check('第二主窗使用独立的持久化键', other.key !== firstKey && typeof other.key === 'string');
    check('第二主窗只保存自己的标签清单', JSON.parse(other.layout).tabs.length === 1);
    check('第二主窗保存不会覆盖第一主窗的三个标签', await page('localStorage.getItem(' + JSON.stringify(firstKey) + ')') === before);
  }
  /** error为真实异常；返回finish的Promise并让进程失败退出。 */
  function failed(error) { return finish(error); }
  /** 无参数；当前阶段成功后退出，仅返回finish的Promise。 */
  function succeeded() { return finish(null); }
  try { require('../electron/main.js'); verify().then(succeeded, failed); } catch (error) { failed(error); }
}
