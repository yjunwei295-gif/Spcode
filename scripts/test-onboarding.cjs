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
  const s = { locale: 'zh', theme: 'dark', resolvedTheme: 'dark', autoSave: true, videoProviderModels: [],
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

/**
 * 用真实 HTML/CSS/ES 模块启动，只有非引导业务替换成已有本地夹具。
 * @param {object} s 本轮设置夹具，直接作为 simple.getState 的返回值。
 * @param {boolean} legacy 是否写入旧版浏览器完成标记，用于迁移用例。
 * @param {string} extraScript 追加到页面注入脚本里的桩代码，用于提供厂商预设与远程模型清单。
 * @returns {Promise<BrowserWindow>} 已等到引导或主界面就绪的窗口。
 */
async function openPage(s, legacy, extraScript) {
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
    // 一键配置用例要核对实际保存的能力槽位与当前模型，这里把两次保存的入参记在页面里
    + 'simple.saveCapabilityDefaults = async function saveCapabilityDefaults(value) { window.fullPageRecord.savedCaps = value; return value; };\n'
    + 'simple.saveModels = async function saveModels(models, currentId) { window.fullPageRecord.savedModels = { models: models, currentId: currentId }; return { videoProviderModels: [] }; };\n'
    + 'simple.getProviderQuota = async function getProviderQuota() { return {}; };\n'
    + 'window.alert = function recordAlert(message) { fullPageRecord.errors.push({alert: message}); };\n'
    + (extraScript || '')
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
  vm.runInContext(extract(renderer, 'function capValOf(ref)') + extract(renderer, 'function codePoolRefs(pack)') + extract(renderer, 'async function completeOnboarding()')
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

/** 一键引导用到的厂商预设与远程模型清单桩；不连外部接口，模型名覆盖「文本」和「看图」两类。 */
const ONE_CLICK_STUBS = 'simple.listProviderPresets = async function listProviderPresets() {'
  + ' return [{ id: "fw", name: "FixtureAI", protocol: "openai", baseUrl: "http://fixture", modelsPath: "" }]; };\n'
  + 'simple.listRemoteModels = async function listRemoteModels() {'
  + ' return { models: ["text-basic", "qwen2.5-vl"], catalog: { "text-basic": { name: "Text Basic" }, "qwen2.5-vl": { name: "Qwen VL" } } }; };\n';

/**
 * 走完一键引导：选厂商、填密钥、拉模型、勾选两个模型，最后点完成并等界面回到对话。
 * @param {BrowserWindow} win 已完成注入的隐藏窗口。
 * @returns {Promise<void>} 对话界面出现才兑现；超时由 waitFor 抛出。
 */
async function driveOneClick(win) {
  await win.webContents.executeJavaScript('document.querySelector("[data-onboarding-provider=\\"0\\"]").click()');
  await win.webContents.executeJavaScript('document.getElementById("onboarding-next").click()');
  await waitFor(win, '!!document.getElementById("onboarding-key")');
  await win.webContents.executeJavaScript('document.getElementById("onboarding-key").value = "sk-fixture";'
    + 'document.getElementById("onboarding-next").click()');
  await waitFor(win, '!!document.getElementById("onboarding-fetch")');
  await win.webContents.executeJavaScript('document.getElementById("onboarding-fetch").click()');
  await waitFor(win, '!!document.querySelector("[data-onboarding-model]")');
  await win.webContents.executeJavaScript('document.querySelector("[data-onboarding-model=\\"text-basic\\"]").click();'
    + 'document.querySelector("[data-onboarding-model=\\"qwen2.5-vl\\"]").click()');
  await win.webContents.executeJavaScript('document.getElementById("onboarding-next").click()');
  await waitFor(win, 'document.getElementById("modal").classList.contains("hidden") && !!document.getElementById("input")');
}

/**
 * 验证「只配 API + 拉模型」的一键引导：勾选模型后点完成，程序自动定大脑、看图与各能力槽位并直接进对话。
 * 全程走真实引导页面与主进程保存处理器，厂商预设和远程模型清单用本地桩，不连外部模型。
 * @returns {Promise<void>} 断言失败时抛出，由 run 统一转成非零退出。
 */
async function testOneClickConfig() {
  const fresh = settings(false);
  fresh.models = [];
  fresh.currentModelId = '';
  store.save(fresh);
  const win = await openPage(fresh, false, ONE_CLICK_STUBS);
  check(await guideVisible(win), '全新用户进入引导');
  await driveOneClick(win);
  const saved = store.load();
  const savedModels = await win.webContents.executeJavaScript('window.fullPageRecord.savedModels');
  // 能力槽位由主进程归一化后才会入库；这里用同一个归一化函数核对引导实际发出的配置
  const assembly = require('../electron/lib/assembly');
  const payload = await win.webContents.executeJavaScript('window.fullPageRecord.savedCaps');
  const caps = assembly.normalizeCapabilityDefaults(payload || {});
  const resolveBase = { models: savedModels?.models || [], providers: [], capabilityDefaults: caps };
  const brainId = savedModels?.currentId;
  check(saved.onboardingCompleted === true, '一键配置后直接完成引导并进入对话');
  check(!!brainId, '保存的当前模型就是自动选定的大脑');
  check(caps.summary?.primary?.apiId === brainId && caps.planning?.primary?.apiId === brainId, '总结与规划自动跟随大脑');
  const visionHit = assembly.resolveRole(resolveBase, 'vision');
  check(!!visionHit?.slot, '看图槽位已被自动填上且能被解析');
  check(visionHit?.slot?.apiId === caps.vision?.primary?.apiId, '看图槽位指向同一个自动选定的模型');
  const visionModel = (savedModels?.models || []).find(function findVision(m) { return m.id === visionHit?.slot?.apiId; });
  check(visionModel?.model === 'qwen2.5-vl' && visionModel?.vision === true, '看图槽位选中具备视觉能力的模型');
  check((caps.code?.models || []).length === 2 && (caps.aesthetic?.models || []).length === 2, '代码与审美使用全部模型做平等池');
  const pageModels = savedModels?.models || [];
  const plainModel = pageModels.find(function findPlain(m) { return m.model === 'text-basic'; });
  check(pageModels.length === 2 && plainModel?.vision === false, '文本模型的看图标记保持关闭');
  const pageErrors = await win.webContents.executeJavaScript('fullPageRecord.errors');
  check(pageErrors.length === 0, '一键配置过程无页面异常 ' + JSON.stringify(pageErrors));
  win.destroy();
}

/**
 * 验证一键配置不覆盖用户已有的选择：重开引导时，已配好的总结槽位保持原值，只补没配过的看图槽位。
 * @returns {Promise<void>} 断言失败时抛出。
 */
async function testOneClickKeepsExisting() {
  const again = settings(false);
  again.models = [];
  again.currentModelId = '';
  // 用户此前手选过总结模块，一键配置必须让位给这个选择
  again.capabilityDefaults = { summary: { primary: { type: 'api', apiId: 'mine' }, fallbacks: [] } };
  store.save(again);
  const win = await openPage(again, false, ONE_CLICK_STUBS);
  check(await guideVisible(win), '重开引导的用户仍进入引导');
  await driveOneClick(win);
  const payload = await win.webContents.executeJavaScript('window.fullPageRecord.savedCaps');
  check(payload?.summary?.primary?.apiId === 'mine', '已配置的总结槽位不被一键配置覆盖');
  check(!!payload?.vision?.primary?.apiId, '未配置的看图槽位仍然自动补上');
  check((payload?.code?.models || []).length === 2, '未配置的代码池按本次模型自动填好');
  const pageErrors = await win.webContents.executeJavaScript('fullPageRecord.errors');
  check(pageErrors.length === 0, '保留已有配置时也没有页面异常 ' + JSON.stringify(pageErrors));
  win.destroy();
}

/** 验证首次启动、迁移、清空浏览器状态后的重开，以及手动引导与完成按钮。 */
async function run() {
  await app.whenReady();
  const begin = main.indexOf("ipcMain.handle('app:completeOnboarding'");
  const end = main.indexOf("\nipcMain.handle('app:theme'", begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInNewContext(main.substring(begin, end), { ipcMain, store });
  await testDecisions();
  await testOneClickConfig();
  await testOneClickKeepsExisting();

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
