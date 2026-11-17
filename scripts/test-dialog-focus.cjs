'use strict';

/**
 * 在隔离用户目录中运行完整生产界面，核对原生错误弹窗关闭后的系统键盘输入。
 * 只关闭本测试进程的原生对话框；使用 Win32 按键验证键盘路由，不用赋值或 insertText 冒充输入。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { spawn } = require('child_process');
/** 原生输入辅助进程只启动一次，避免创建控制台窗口干扰生产焦点。 */
let nativeWorker = null;
let nativeResolve = null;
let nativeReject = null;
let nativeBuffer = '';
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-dialog-focus-'));
const renderer = path.join(output, 'renderer');
const workspace = path.join(output, 'workspace');
const report = { output, pid: process.pid, passed: [], samples: [] };
let mainWindow = null;
let finished = false;

for (const name of ['user-data', 'session-data', 'crashes', 'models', 'workspace']) fs.mkdirSync(path.join(output, name), { recursive: true });
app.setName('SpCodeDialogFocusVerification');
app.setPath('userData', path.join(output, 'user-data'));
app.setPath('sessionData', path.join(output, 'session-data'));
app.setPath('crashDumps', path.join(output, 'crashes'));
fs.writeFileSync(path.join(output, 'user-data', 'settings.json'), JSON.stringify({
  locale: 'zh', theme: 'dark', autoSave: false, onboardingCompleted: true,
  trainingDataEnabled: false, desktopAlive: false, cursorDirect: false,
  providers: [], currentModelId: 'local-gguf', modelsDir: path.join(output, 'models'),
  models: [{ id: 'local-gguf', name: '本地模型', type: 'local', model: '', enabled: true }],
  capabilityDefaults: {}, assemblies: {}, recents: []
}), 'utf8');
fs.cpSync(path.join(root, 'renderer'), renderer, { recursive: true });
fs.mkdirSync(path.join(output, 'electron', 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'electron', 'lib', 'image-gen-options.js'), path.join(output, 'electron', 'lib', 'image-gen-options.js'));
fs.appendFileSync(path.join(renderer, 'app.js'), '\nwindow.__dialogFocusTest = { state, openModal, closeModal, focusComposer, keys: [] }; for (const kind of ["keydown", "keypress", "keyup", "input"]) document.addEventListener(kind, function recordKey(event) { window.__dialogFocusTest.keys.push({type:event.type,key:event.key,target:event.target.id,value:event.target.value,trusted:event.isTrusted,ctrl:event.ctrlKey,alt:event.altKey,shift:event.shiftKey}); }, true);\n', 'utf8');
app.on('browser-window-created', observeWindow);

/** 记录本测试的生产主窗口；其它测试附属窗口保持隐藏，不触碰用户已有进程。 */
function observeWindow(_event, win) {
  if (!mainWindow) { mainWindow = win; return; }
  win.hide();
  win.on('show', hideAuxiliary);
  function hideAuxiliary() { win.hide(); }
}

/** 在实际主窗口执行生产界面表达式，返回真实结果。 */
function page(source) { return mainWindow.webContents.executeJavaScript(source); }

/** 等待明确的运行条件；超时报告失败，轮询间隔只用于让出事件循环。 */
function waitFor(predicate, label) {
  return new Promise(begin);
  function begin(resolve, reject) {
    const deadline = Date.now() + 15000;
    inspect();
    async function inspect() {
      try {
        if (await predicate()) { resolve(); return; }
        if (Date.now() >= deadline) throw new Error(label + ' 等待超时；' + JSON.stringify(await sample('失败现场')));
        setTimeout(inspect, 30);
      } catch (error) { reject(error); }
    }
  }
}

/** 将辅助进程的逐行 JSON 回执交给当前唯一操作；失败保持可见。 */
function receiveNative(chunk) {
  nativeBuffer += chunk;
  const end = nativeBuffer.indexOf('\n');
  if (end < 0) return;
  const reply = JSON.parse(nativeBuffer.substring(0, end));
  nativeBuffer = nativeBuffer.substring(end + 1);
  if (reply.ok) nativeResolve(reply.result);
  else nativeReject(new Error(reply.error));
}

/** 在测试窗口激活前准备系统输入进程，此后所有操作复用同一条管道。 */
function prepareNative() {
  return new Promise(begin);
  function begin(resolve, reject) {
    nativeResolve = resolve;
    nativeReject = reject;
    const nativeSource = fs.readFileSync(path.join(__dirname, 'dialog-focus-native.ps1'), 'utf8');
    nativeWorker = spawn('powershell.exe', ['-NoProfile', '-STA', '-EncodedCommand', Buffer.from(nativeSource, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    nativeWorker.stdout.setEncoding('utf8');
    nativeWorker.stdout.on('data', receiveNative);
    nativeWorker.on('error', reject);
    nativeWorker.stderr.on('data', recordNativeError);
    nativeWorker.on('exit', nativeExited);
    /**
     * 记录原生输入辅助进程最近一次标准错误输出，供进程退出诊断使用。
     * @param {Buffer|string} chunk 标准错误流本次收到的数据块，按 UTF-8 转成报告文本。
     * @returns {void} 更新 report.nativeError，不改变当前操作的完成状态。
     */
    function recordNativeError(chunk) { report.nativeError = String(chunk); }
    /** 辅助进程退出必须立即失败，不把缺少回执留成悬挂测试。 */
    function nativeExited(code) { if (!finished) nativeReject(new Error('系统输入辅助进程退出：' + code + '；' + report.nativeError)); }
  }
}

/**
 * 通过已准备好的辅助进程管道发送一条原生操作，并等待对应回执。
 * @param {Object} command 命令对象：activate 传 {action:'activate', hwnd}；key 传 {action:'key', hwnd, key}；dialog 传 {action:'dialog', process}。hwnd 是十进制窗口句柄字符串，key 是单个 UTF-16 字符，process 是本测试的进程编号。
 * @returns {Promise<string>} 成功回执的 result：activate/key 为 completed，dialog 为找到并确认的原生弹窗句柄字符串。
 * 辅助进程返回 ok:false 时以回执 error 拒绝；未结束测试时辅助进程退出，由 nativeExited 拒绝当前操作。
 * 调用前必须等待 prepareNative 完成，每次必须等待上一命令结束；本方法会替换当前唯一回执处理器并向 stdin 写入一行 JSON，不支持并发命令。
 */
function nativeCommand(command) {
  return new Promise(begin);
  function begin(resolve, reject) {
    nativeResolve = resolve;
    nativeReject = reject;
    nativeWorker.stdin.write(JSON.stringify(command) + '\n');
  }
}

/** 系统按键发送前核对前台句柄；仅初始基线允许激活窗口，弹窗后绝不额外修复焦点。 */
async function typeSystemKey(key, initialActivation) {
  const hwnd = mainWindow.getNativeWindowHandle().readBigUInt64LE(0).toString();
  if (initialActivation === true) {
    await nativeCommand({ action: 'activate', hwnd });
    await page('window.__dialogFocusTest.focusComposer()');
  }
  return nativeCommand({ action: 'key', key, hwnd });
}

/** 只确认本测试 PID 所属的原生消息框，返回真实句柄。 */
function dismissNativeDialog() { return nativeCommand({ action: 'dialog', process: process.pid }); }

/** 保存窗口、网页与 DOM 三层焦点证据，DOM 活动元素不单独作为输入恢复的判据。 */
async function sample(label) {
  const dom = await page('(function inspectFocus() { const input=document.getElementById("input"); return { active:document.activeElement.id, documentFocus:document.hasFocus(), value:input.value, keys:window.__dialogFocusTest.keys.splice(0) }; })()');
  const value = { label, windowFocus: mainWindow.isFocused(), contentsFocus: mainWindow.webContents.isFocused(), dom };
  report.samples.push(value);
  console.log('SAMPLE ' + JSON.stringify(value));
  return value;
}

/** 实际打开原生 alert，再通过系统消息确认；返回后沿用生产设置弹窗关闭入口。 */
async function nativeError(label) {
  const closed = dismissNativeDialog();
  await page('alert(' + JSON.stringify(label) + ')');
  report.samples.push({ label, nativeDialog: await closed });
  await sample(label + '：原生弹窗关闭');
}

/** 记录断言；失败停止测试并保留独立报告。 */
function check(value, message) { assert.ok(value, message); report.passed.push(message); console.log('PASS ' + message); }

/** 运行真实错误弹窗、重复错误与普通设置弹窗的系统输入回归。 */
async function run() {
  await app.whenReady();
  await prepareNative();
  await waitFor(created, '生产主窗口');
  function created() { return mainWindow && !mainWindow.webContents.isLoading(); }
  await page('(window.simple || window.sinpo).setWorkspace(' + JSON.stringify(workspace) + ')');
  await mainWindow.loadFile(path.join(renderer, 'index.html'));
  await waitFor(initialized, '完整生产聊天界面');
  async function initialized() { return page('Boolean(window.__dialogFocusTest && window.__dialogFocusTest.state.tabs.length && !document.getElementById("view-chat").classList.contains("hidden"))'); }
  mainWindow.setTitle('SpCode Dialog Focus Regression ' + process.pid);
  mainWindow.show();
  mainWindow.focus();
  await page('window.__dialogFocusTest.focusComposer()');
  await waitFor(focused, '主窗口前台焦点');
  function focused() { return mainWindow.isFocused(); }
  console.log('INITIAL_WINDOW ' + JSON.stringify({ id: mainWindow.id, visible: mainWindow.isVisible(), enabled: mainWindow.isEnabled(), minimized: mainWindow.isMinimized(), title: mainWindow.getTitle(), bounds: mainWindow.getBounds() }));
  await sample('初始窗口');
  await typeSystemKey('a', true);
  await waitFor(initialText, '初始系统文字');
  /**
   * 判断初始系统按键是否已进入生产输入框，建立弹窗测试前的真实输入基线。
   * @returns {Promise<boolean>} 仅当输入框内容严格等于 a 时为 true，否则继续等待；只读取，不主动恢复焦点。
   */
  async function initialText() { return page('document.getElementById("input").value === "a"'); }
  check((await sample('初始系统输入')).dom.value === 'a', '错误弹窗前系统按键确实进入生产输入框');

  for (let index = 0; index < 3; index++) {
    await page('window.__dialogFocusTest.openModal(\'<h3>错误弹窗回归</h3><input id="focus-setting" value="设置草稿">\'); document.getElementById("focus-setting").focus();');
    await nativeError('错误弹窗回归 ' + index);
    await page('window.__dialogFocusTest.closeModal()');
    await typeSystemKey('b');
    await waitFor(composerUpdated, '错误弹窗后的系统文字');
    async function composerUpdated() { return page('document.getElementById("input").value === ' + JSON.stringify('a' + 'b'.repeat(index + 1))); }
    const result = await sample('返回主界面 ' + index);
    check(result.dom.value === 'a' + 'b'.repeat(index + 1), '第' + (index + 1) + '次错误弹窗关闭后系统键盘继续输入，草稿不丢失');
    check(result.windowFocus && result.contentsFocus && result.dom.active === 'input', '第' + (index + 1) + '次返回后窗口、网页和输入框焦点一致');
  }
  await page('window.__dialogFocusTest.openModal(\'<h3>正常设置回归</h3><input id="focus-setting" value="">\'); document.getElementById("focus-setting").focus();');
  await typeSystemKey('c');
  await waitFor(normalSettingText, '普通设置字段系统输入');
  async function normalSettingText() { return page('document.getElementById("focus-setting").value === "c"'); }
  check(await page('document.getElementById("focus-setting").value === "c"'), '普通设置字段仍接收输入，不被聊天输入框抢焦点');
  await page('window.__dialogFocusTest.closeModal()');
  await typeSystemKey('d');
  await waitFor(normalComposerText, '普通设置返回后的系统输入');
  async function normalComposerText() { return page('document.getElementById("input").value === "abbbd"'); }
  check((await sample('正常设置返回')).dom.value === 'abbbd', '普通设置关闭后恢复输入，原有草稿保留');

  await nativeError('主界面直接报错');
  await typeSystemKey('中');
  await waitFor(directText, '主界面直接报错后的中文系统输入');
  async function directText() { return page('document.getElementById("input").value === "abbbd中"'); }
  check((await sample('主界面直接报错后输入')).dom.value === 'abbbd中', '不经设置关闭入口，错误提示关闭后也能直接输入中文');

  await page('window.__dialogFocusTest.openModal(\'<h3>报错后继续设置</h3><input id="focus-setting" value="">\'); document.getElementById("focus-setting").focus();');
  await nativeError('设置中报错后继续编辑');
  await typeSystemKey('文');
  await waitFor(settingText, '报错后设置字段系统输入');
  async function settingText() { return page('document.getElementById("focus-setting").value === "文"'); }
  check(await page('document.getElementById("input").value === "abbbd中" && document.activeElement.id === "focus-setting"'), '报错后设置输入焦点与草稿保留，不抢到聊天输入框');
  await page('window.__dialogFocusTest.closeModal()');
  await typeSystemKey('终');
  await waitFor(finalText, '设置最终返回主界面');
  async function finalText() { return page('document.getElementById("input").value === "abbbd中终"'); }
  check((await sample('全部返回后')).dom.value === 'abbbd中终', '设置错误返回主界面后继续中文输入，完整草稿不变');
}

/** 只结束本隔离测试进程并保存报告，用户现有软件不重启。 */
function finish(error) {
  if (finished) return;
  finished = true;
  if (nativeWorker) nativeWorker.kill();
  if (error) { report.failure = String(error.stack || error); console.error(report.failure); }
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('REPORT ' + path.join(output, 'report.json'));
  app.exit(error ? 1 : 0);
}

/** 将异步测试失败交给统一收尾。 */
function failed(error) { finish(error); }
/** 全部实际断言通过后结束测试。 */
function passed() { finish(null); }
setTimeout(testTimeout, 90000);
/** 对话框或系统输入卡住时明确失败。 */
function testTimeout() { finish(new Error('原生弹窗焦点回归超时')); }
try { require('../electron/main.js'); run().then(passed, failed); } catch (error) { finish(error); }
