/**
 * 在独立用户目录里验证真实引导页面、主进程保存处理器及 preload IPC。
 * 模型与会话使用本地夹具，不连接模型、不读写用户的真实配置。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const output = path.join(root, 'generated', 'onboarding-verification');
fs.mkdirSync(output, { recursive: true });
const userData = fs.mkdtempSync(path.join(output, 'user-data-'));
app.setPath('userData', userData);
app.on('window-all-closed', function keepTestsAlive() {});
const store = require('../electron/lib/store');
const renderer = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8').split('\r\n').join('\n');
const main = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8').split('\r\n').join('\n');
const fixture = fs.readFileSync(path.join(root, 'scripts/test-ui-performance.cjs'), 'utf8').split('\r\n').join('\n');
const passed = [];

/** 提取完整顶层函数，边界不匹配时直接终止测试。 */
function extract(source, signature) {
  const start = source.indexOf(signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, signature);
  return source.substring(start, end + 3);
}

/** 输出检查结果并记录最终验收报告。 */
function check(value, message) {
  assert.ok(value, message);
  passed.push(message);
  console.log('PASS ' + message);
}

/** 构造可运行完整页面的最小配置；模型引用保持与真实下拉框格式一致。 */
function settings(configured) {
  const s = { locale: 'zh', theme: 'dark', resolvedTheme: 'dark', autoSave: true,
    workspace: '', models: [{ id: 'fixture', name: '测试模型', type: 'api', model: 'fixture' }],
    currentModelId: 'fixture', providers: [], recents: [], localFiles: [], assemblies: {},
    capabilityDefaults: {}, retained: { value: '保留已有配置' } };
  if (configured) {
    for (const role of ['summary', 'code', 'planning']) s.capabilityDefaults[role] = { primary: { type: 'api', apiId: 'fixture' }, fallbacks: [] };
  }
  return s;
}

/** 等到实际页面状态满足条件，超时保留页面脚本异常供诊断。 */
async function waitFor(win, expression) {
  const script = '(async function wait() { for (let index = 0; index < 150; index++) {'
    + 'if (' + expression + ') return true;'
    + 'await new Promise(function pause(resolve) { setTimeout(resolve, 20); });'
    + '} throw new Error("页面状态等待超时 / " + JSON.stringify(window.fullPageRecord?.errors)); })()';
  return win.webContents.executeJavaScript(script);
}

/** 用真实 HTML/CSS/ES 模块启动，只有非引导业务替换成已有本地夹具。 */
async function openPage(s, legacy) {
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  const setup = '(' + extract(fixture, 'function fullPageSetup()') + ')();\n'
    + 'localStorage.removeItem("spcode.onboarding.completed");\n'
    + (legacy ? 'localStorage.setItem("spcode.onboarding.completed","true");\n' : '')
    + 'const fixtureSettings = ' + JSON.stringify(s) + ';\n'
    + 'simple.getState = async function getState() { return fixtureSettings; };\n'
    + 'simple.completeOnboarding = function completeOnboarding() { return require("electron").ipcRenderer.invoke("app:completeOnboarding"); };\n'
    + 'simple.listProviderPresets = async function listProviderPresets() { return []; };\n'
    + 'simple.saveCapabilityDefaults = async function saveCapabilityDefaults(value) { return value; };\n'
    + 'simple.getProviderQuota = async function getProviderQuota() { return {}; };\n'
    + 'window.alert = function recordAlert(message) { fullPageRecord.errors.push({alert: message}); };\n'
    + 'window.fixtureSettings = fixtureSettings;\n';
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: setup });
  await win.loadFile(path.join(root, 'renderer/index.html'));
  // 初始化会在调用同步控件入口时经过这里，确认不是仅仅完成 HTML 加载。
  await waitFor(win, 'window.fullPageRecord && document.getElementById("view-welcome") && (document.getElementById("onboarding-skip") || document.getElementById("input"))');
  await win.webContents.executeJavaScript('new Promise(function wait(resolve) { setTimeout(resolve, 150); })');
  return win;
}

/** 检查引导可见性，同时拒绝把页面异常误判为没有弹窗。 */
async function guideVisible(win) {
  const result = await win.webContents.executeJavaScript('({ visible: !document.getElementById("modal").classList.contains("hidden") && !!document.getElementById("onboarding-skip"), errors: fullPageRecord.errors })');
  assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
  return result.visible;
}

/** 运行真实引导恢复逻辑的边界用例，包括本地模型引用与保存失败。 */
async function testDecisions() {
  const context = { localStorage: { getItem: function getItem() { return null; }, setItem: function setItem() {} },
    api: { completeOnboarding: async function completeOnboarding() {} } };
  vm.createContext(context);
  vm.runInContext(extract(renderer, 'function capValOf(ref)') + extract(renderer, 'async function completeOnboarding()')
    + extract(renderer, 'async function restoreOnboardingCompletion(settings)'), context);
  const partial = settings(true);
  delete partial.capabilityDefaults.planning;
  check(await context.restoreOnboardingCompletion(partial) === false, '只配置部分必选模块仍保留首次引导');
  const emptyRefs = settings(true);
  emptyRefs.capabilityDefaults.code.primary = {};
  check(await context.restoreOnboardingCompletion(emptyRefs) === false, '空模型引用不算完成引导');
  const local = settings(true);
  local.capabilityDefaults.code.primary = { modelPath: 'models/local.gguf' };
  check(await context.restoreOnboardingCompletion(local) === true, '已配置本地模型的必选模块可以迁移');
  context.api.completeOnboarding = async function failSaving() { throw new Error('fixture-save-failed'); };
  await assert.rejects(context.restoreOnboardingCompletion(settings(true)), /fixture-save-failed/);
  check(true, '持久化失败明确报告，不伪装完成');
}

/** 验证首次启动、迁移、清空浏览器状态后的重开，以及手动引导与完成按钮。 */
async function run() {
  await app.whenReady();
  const begin = main.indexOf("ipcMain.handle('app:completeOnboarding'");
  const end = main.indexOf("\nipcMain.handle('app:theme'", begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInNewContext(main.substring(begin, end), { ipcMain, store });
  await testDecisions();

  const fresh = settings(false);
  store.save(fresh);
  let win = await openPage(fresh, false);
  check(await guideVisible(win), '首次启动且未配置时自动显示引导');
  await win.webContents.executeJavaScript('document.getElementById("onboarding-skip").click()');
  await waitFor(win, 'document.getElementById("modal").classList.contains("hidden")');
  check(store.load().onboardingCompleted === true, '真实跳过按钮通过 IPC 将完成标记写入设置');
  check(store.load().retained.value === fresh.retained.value, '保存标记保留其他配置');
  win.destroy();

  win = await openPage(store.load(), false);
  check(!(await guideVisible(win)), '清空浏览器标记后重开仍不弹引导');
  await win.webContents.executeJavaScript('document.getElementById("btn-guide").click()');
  await waitFor(win, '!!document.getElementById("onboarding-skip")');
  check(await guideVisible(win), '已完成用户仍能手动打开引导');
  win.destroy();

  const configured = settings(true);
  // 独立用例明确重置夹具中的完成标记，不触及真实用户设置。
  configured.onboardingCompleted = false;
  store.save(configured);
  win = await openPage(configured, false);
  check(!(await guideVisible(win)) && store.load().onboardingCompleted === true, '已有三项必选模型但无浏览器标记时迁移并进入主界面');
  await win.webContents.executeJavaScript('document.getElementById("btn-guide").click()');
  await waitFor(win, '!!document.getElementById("onboarding-next")');
  await win.webContents.executeJavaScript('document.getElementById("onboarding-next").click(); document.getElementById("onboarding-finish").click();');
  await waitFor(win, '!!document.getElementById("onboarding-modules-done")');
  check(await win.webContents.executeJavaScript('!document.getElementById("onboarding-modules-done").disabled'), '已配置模块可通过真实引导完成按钮');
  store.save({ ...configured, onboardingCompleted: false });
  await win.webContents.executeJavaScript('document.getElementById("onboarding-modules-done").click()');
  await waitFor(win, 'document.getElementById("modal").classList.contains("hidden")');
  check(store.load().onboardingCompleted === true, '真实完成按钮持久化状态');
  check((await win.webContents.executeJavaScript('fullPageRecord.errors')).length === 0, '完整引导操作无页面异常');
  win.destroy();

  store.save({ ...fresh, onboardingCompleted: false });
  win = await openPage(fresh, true);
  check(!(await guideVisible(win)) && store.load().onboardingCompleted === true, '旧版浏览器完成标记迁移到设置');
  win.destroy();

  const bridge = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await bridge.loadURL('about:blank');
  store.save({ ...fresh, onboardingCompleted: false });
  check(await bridge.webContents.executeJavaScript('simple.completeOnboarding()') === true && store.load().onboardingCompleted === true,
    '真实隔离 preload 透传完成 IPC 并写盘');
  bridge.destroy();

  fs.writeFileSync(path.join(output, 'verification.json'), JSON.stringify({ ok: true, checks: passed.length, passed, userData }, null, 2), 'utf8');
  console.log('RESULT ' + JSON.stringify({ failures: 0, checks: passed.length }));
  app.exit(0);
}

/** 输出失败堆栈，并通过非零退出阻止错误验收。 */
function failed(error) { console.error(error.stack || error); app.exit(1); }
setTimeout(function timeout() { failed(new Error('引导验收超时')); }, 30000);
run().catch(failed);
