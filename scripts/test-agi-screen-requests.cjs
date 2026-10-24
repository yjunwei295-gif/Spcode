/**
 * 验证后台屏幕接单：真实定时器、主进程路由、渲染队列与 Agent 写入门槛。
 * 独立 Electron 测试，模型传输受控；另用临时 WinForms 窗口核对真实 Win32 裁剪 OCR。
 */
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawn } = require('node:child_process');
const { createScreenWatcher, requestsIn } = require('../electron/lib/agi-screen-watch');
const root = path.resolve(__dirname, '..');
const errors = [];
let checks = 0;
let workspace;
let fixture;
let nativeHand;
/** 没有测试窗口时也保持验收进程运行。 */
function keepAlive(event) { event.preventDefault(); }
app.on('window-all-closed', keepAlive);
/** 异步错误纳入最终结论，不能用进程正常返回冒充通过。 */
function unhandled(error) { errors.push(String(error.stack || error)); }
process.on('unhandledRejection', unhandled);
/** 输出逐项验收证据。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 仅供验收调度让出事件循环。 */
function pause(ms) { return new Promise(function wait(resolve) { setTimeout(resolve, ms); }); }
/** 测试画面保持与生产观察器相同的数据形状。 */
function frame(text) { return { lines: [{ text }], source: { title: '验收窗口', proc: 'fixture', hwnd: '123' } }; }

/** 验证本地稳定识别、去重、暂停、停止与失败，不导入任何模型发送器。 */
async function testWatcher() {
  let screen = frame('普通屏幕内容');
  let reads = 0;
  let busy = false;
  const sent = [];
  const failures = [];
  async function observe() { reads++; return screen; }
  function ready() { return !busy; }
  async function deliver(request) { sent.push(request); return true; }
  function interval() { return 60000; }
  function failed(error) { failures.push(error.message); }
  const watch = createScreenWatcher({ observe, ready, deliver, interval, onError: failed });
  watch.start('会话1');
  for (let i = 0; i < 5; i++) await watch.tick();
  check(reads === 5 && sent.length === 0, '普通画面只本地观察，零任务/模型投递');
  screen = frame('请帮我生成一份文件');
  await watch.tick();
  check(sent.length === 0, '请求未稳定时不提前执行半句');
  screen = frame('请帮我生成两份文件');
  await watch.tick();
  check(sent.length === 0, '打字内容变化时重新等待稳定');
  await watch.tick();
  check(sent.length === 1 && sent[0].text === screen.lines[0].text, '稳定的新请求自动交付');
  for (let i = 0; i < 3; i++) await watch.tick();
  check(sent.length === 1, '同一句请求持续可见也只交付一次');
  busy = true;
  const before = reads;
  await watch.tick();
  check(reads === before, '干活期间连后台 OCR 都暂停');
  busy = false;
  watch.stop();
  await watch.tick();
  check(reads === before, '关闭后不再读屏或投递');
  watch.start('会话1');
  await watch.tick(); await watch.tick();
  check(sent.length === 1, '同会话反复开关不重新执行旧请求');
  watch.stop();

  let release;
  async function waiting() { return new Promise(function pending(resolve) { release = resolve; }); }
  const pendingWatch = createScreenWatcher({ observe: waiting, ready, deliver, interval, onError: failed });
  pendingWatch.start('会话1');
  const running = pendingWatch.tick();
  pendingWatch.stop();
  release(screen);
  await running;
  check(sent.length === 1, '关闭时丢弃在途 OCR 结果');

  async function broken() { throw new Error('OCR_SENTINEL'); }
  const brokenWatch = createScreenWatcher({ observe: broken, ready, deliver, interval, onError: failed });
  brokenWatch.start('会话1'); await brokenWatch.tick(); await brokenWatch.tick();
  check(failures.join() === 'OCR_SENTINEL', 'OCR 故障明确报告且停止，不改发模型轮询');
  check(requestsIn(frame('网页里引用了请帮我写代码')).length === 0 &&
    requestsIn(frame('请帮我')).length === 0, '只识别行首完整触发词与实际请求');
}

/** 加载真实 Agent 循环，只替换模型传输和桌面观察。 */
function agentHarness() {
  const file = path.join(root, 'electron/lib/agent.js');
  const localRequire = createRequire(file);
  let alive = true;
  let calls = 0;
  let writing = false;
  const hand = { isAlive: function isAlive() { return alive; }, hold: function hold() {} };
  /** 返回受控工具调用，让真实工具门槛决定文件能不能写入。 */
  async function complete() {
    calls++;
    if (alive && calls === 1) return { role: 'assistant', content: '',
      tool_calls: [{ id: 'screen', type: 'function', function: { name: 'screen_read', arguments: '{}' } }] };
    if (!writing) {
      writing = true;
      return { role: 'assistant', content: '', tool_calls: [{ id: 'write', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'accepted.txt', content: 'SCREEN_REQUEST_EXECUTED' }) } }] };
    }
    return { role: 'assistant', content: '已完成并核对验收文件。' };
  }
  /** 只隔离外部模型与桌面，不替换写文件、快照或开工门槛实现。 */
  function dependency(name) {
    if (name === './desktop-hand') return hand;
    if (name === './api-protocol') return { normalizeProtocol: function identity(value) { return value; }, complete };
    if (name === './screen-text-map') return {
      observe: async function observe() { return {}; },
      formatBlock: function formatBlock() { return '验收屏幕'; },
      applyToMessages: function applyToMessages() {}
    };
    if (name === './diag') return { log: function noop() {} };
    return localRequire(name);
  }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') +
    '\nmodule.exports.testLoop = agentLoop;', context, { filename: file });
  /** 执行没有开始口令和 action 的真实轮次。 */
  async function run(text, agi) {
    alive = agi;
    calls = 0;
    writing = false;
    const snap = { current: null, readOnly: false };
    const finalText = await context.module.exports.testLoop({
      modelCfg: { protocol: 'openai', model: 'controlled-test', baseUrl: 'http://unused' },
      messages: [{ role: 'system', content: '验收屏幕请求' }, { role: 'user', content: text }],
      workspace, extra: [], snap, onEvent: function noop() {},
      lang: localRequire('./reply-lang').fromLocale('zh'),
      toolSpec: context.module.exports.toolsSpec(), workers: null, roleTag: 'brain', depth: 0,
      hardRounds: 5, userOrder: text, startOrdered: false
    });
    return { finalText, snapshot: snap.current };
  }
  return { run };
}

/** 实际主进程投递→preload 通道→渲染队列→真实 Agent 写入，无开始点击或输入框发送。 */
async function testPipeline() {
  const agent = agentHarness();
  const rendererFile = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8').split('\r\n').join('\n');
  const begin = rendererFile.indexOf('async function receiveScreenRequest(');
  const end = rendererFile.indexOf('/** 提交当前输入', begin);
  const processBegin = rendererFile.indexOf('async function processQueue(');
  const processEnd = rendererFile.indexOf('/**\n * 将本地识别', processBegin);
  const tab = { id: 'tab-1', workspace, modelId: 'controlled-test', pickedSkillIds: ['zabingsk'], queue: [], messages: [],
    context: { contextPaths: ['keep.cs'], attachments: ['keep.png'] } };
  const draft = { value: '用户还没发送的草稿', attachments: ['keep.png'] };
  let sendCount = 0;
  let ackHandler;
  const sender = {};
  const win = { isDestroyed: function isDestroyed() { return false; } };
  const ipc = {
    handle: function handle() {},
    on: function on(name, callback) { if (name === 'desktop:screen-result') ackHandler = callback; }
  };
  const renderer = {
    state: { tabs: [tab], currentModelId: 'controlled-test', workspace,
      contextPaths: ['keep.cs'], attachments: ['keep.png'], promptOverrides: { persona: '用户下次发送时用' } },
    isActiveTab: function active(item) { return item === tab; },
    currentModel: function model() { return {}; },
    normalizeSkillIds: function normalize(value) { return value.skillIds; },
    tabQueue: function queue(item) { return item.queue; },
    renderQueue: function noop() {}, syncSendBtn: function noop() {},
    api: { screenRequestResult: function result(id, accepted) { ackHandler({ sender }, id, accepted); } },
    sendOne: async function sendOne(item, text, itemDraft) {
      check(!itemDraft.action, '自动请求没有伪造 start-work 授权字段');
      sendCount++;
      await agent.run(text, true);
      return false;
    }
  };
  // 使用真实 sendOne，确保其原有清理逻辑不会误消费后台任务之外的草稿。
  const sendBegin = rendererFile.indexOf('async function sendOne(');
  const uiNoops = ['renderChips','renderTabs','renderMessages','scrollMessagesToBottom','armStallWatch',
    'logSummaryTrace','revealRest','fillDialogIndex','clearStallWatch','finishTypewriter','renderSidebar','persistTab',
    'flushLivePaint','stopTypewriter'];
  for (const name of uiNoops) renderer[name] = function noop() {};
  renderer.beginRefillResend = async function noEdit() {};
  renderer.prefersReducedMotion = function reduced() { return true; };
  renderer.dialogRounds = function rounds() { return []; };
  renderer.isNewChatTitle = function named() { return false; };
  renderer.uid = function uid() { return 'test-turn'; };
  renderer.t = function translate(key) { return key; };
  renderer.extraFoldersOf = function folders() { return []; };
  renderer.roundsOf = function rounds() { return 16; };
  renderer.emptyWorkingMemory = function memory() { return {}; };
  renderer.isStopError = function stopped() { return false; };
  renderer.localMilestoneHits = function hits() { return []; };
  renderer.markTurnFailed = function failure(_assistant, error) { throw error; };
  renderer.api.listSnapshots = async function snapshots() { return []; };
  renderer.api.listMilestones = async function milestones() { return []; };
  renderer.api.chatSend = async function chatSend(payload) {
    check(!payload.action, '自动请求没有伪造 start-work 授权字段');
    check(payload.attachments.length === 0 && payload.contextPaths.length === 0 && !payload.sysOverrides,
      '屏幕任务载荷不夹带未发送草稿的引用、附件或提示词覆盖');
    sendCount++;
    const result = await agent.run(payload.text, true);
    return { text: result.finalText, changes: [] };
  };
  vm.createContext(renderer);
  vm.runInContext(rendererFile.slice(sendBegin, processEnd) + rendererFile.slice(begin, end), renderer);
  const mainFile = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  const mainBegin = mainFile.indexOf('/** AGI 后台接单只属于');
  const mainEnd = mainFile.indexOf('function abortMap(', mainBegin);
  const ipcBegin = mainFile.indexOf('/** AGI 开启后监听当前会话');
  const ipcEnd = mainFile.indexOf("ipcMain.handle('window:new'", ipcBegin);
  let current = frame('普通画面');
  const hand = { isAlive: function isAlive() { return true; }, isBusy: function isBusy() { return false; } };
  /** 使用实际通道交给真实渲染入队方法。 */
  function sendTo(target, channel, payload) {
    assert.equal(target, win);
    assert.equal(channel, 'chat:screen-request');
    renderer.receiveScreenRequest(payload).catch(unhandled);
  }
  /** 将读取输入替换为可控画面，主进程绑定、投递、回执与定时器均使用真实源码。 */
  function dependency(name) {
    if (name === './lib/agi-screen-watch') return { createScreenWatcher };
    if (name === './lib/agi-throttle') return { profile: function profile() { return { minGapMs: 5 }; } };
    if (name === './lib/screen-text-map') return { observeForegroundRequest: async function observe() { return current; } };
    throw new Error(name);
  }
  const main = {
    require: dependency, desktopHand: hand, setTimeout, clearTimeout,
    lastTabIdByWin: new Map([[win, tab.id]]), workspaceByWin: new Map([[win, workspace]]),
    runningByWin: new Map(), sendTo, ipcMain: ipc, diag: { log: function noop() {} },
    getWin: function getWin() { return win; }, makeSessionKey: function key(_win, id) { return '1:' + id; }
  };
  vm.createContext(main);
  vm.runInContext(mainFile.slice(mainBegin, mainEnd) + mainFile.slice(ipcBegin, ipcEnd), main);
  main.startScreenRequests(win, tab.id);
  await pause(30);
  check(sendCount === 0, '主进程待命时零聊天模型轮次');
  current = frame('请帮我生成验收文件');
  for (let i = 0; i < 100 && !fs.existsSync(path.join(workspace, 'accepted.txt')); i++) await pause(10);
  main.stopScreenRequests();
  check(fs.readFileSync(path.join(workspace, 'accepted.txt'), 'utf8') === 'SCREEN_REQUEST_EXECUTED',
    '真实定时器发现屏幕请求后自动执行 write_file，无需开始');
  check(draft.value === '用户还没发送的草稿' && renderer.state.attachments[0] === 'keep.png' &&
    renderer.state.contextPaths[0] === 'keep.cs' && renderer.state.promptOverrides.persona === '用户下次发送时用' &&
    tab.context.attachments[0] === 'keep.png', '真实 sendOne 保留未发送草稿、附件、引用与提示词覆盖');
  await pause(30);
  check(sendCount === 1, '主进程回执闭环没有重复起模型轮次');
  // 普通模式换到另一文件名，确认相同模型的写入工具被真实开工门槛拦截。
  const ordinary = await agent.run('请帮我修复文件', false);
  check(ordinary.snapshot === null,
    'AGI 关闭后普通请求仍由现有开工门槛处理');
  check(errors.length === 0, '队列与工具运行无异步悬空错误');
}

/** 用真实本地窗口和 Win32/屏幕 OCR 验证前台裁剪，不调用聊天模型。 */
async function testNativeScreen() {
  const fixturePath = path.join(workspace, 'screen-fixture.ps1');
  const ps = '$ErrorActionPreference="Stop"\r\nAdd-Type -AssemblyName System.Windows.Forms\r\n' +
    'Add-Type -AssemblyName System.Drawing\r\n$form=New-Object System.Windows.Forms.Form\r\n' +
    '$form.Text="AGI screen request verification"\r\n$form.Width=1000\r\n$form.Height=240\r\n' +
    '$form.StartPosition="Manual"\r\n$form.Location=New-Object System.Drawing.Point(40,80)\r\n$form.TopMost=$true\r\n' +
    '$label=New-Object System.Windows.Forms.Label\r\n$label.Text="请帮我生成验收文件"\r\n' +
    '$label.Font=New-Object System.Drawing.Font("Microsoft YaHei",32)\r\n$label.AutoSize=$true\r\n' +
    '$label.Location=New-Object System.Drawing.Point(24,50)\r\n$form.Controls.Add($label)\r\n' +
    // 测试窗口同时报告物理显示器边界，与生产 foregroundWindow 的坐标结构一致。
    '$form.Add_Shown({$form.Activate();$p=$form.PointToScreen((New-Object System.Drawing.Point(0,0)));$m=[System.Windows.Forms.Screen]::FromHandle($form.Handle).Bounds;' +
    '$bounds=@{hwnd=[string]$form.Handle.ToInt64();left=$p.X;top=$p.Y;right=($p.X+$form.ClientSize.Width);bottom=($p.Y+$form.ClientSize.Height);monitor=@{left=$m.Left;top=$m.Top;right=$m.Right;bottom=$m.Bottom}};' +
    '[Console]::WriteLine(("READY "+($bounds|ConvertTo-Json -Compress)));[Console]::Out.Flush()})\r\n' +
    '[System.Windows.Forms.Application]::Run($form)\r\n';
  await fs.promises.writeFile(fixturePath, Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), Buffer.from(ps,'utf8')]));
  fixture = spawn('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-STA','-File',fixturePath], { windowsHide: false });
  const fixtureBounds = await new Promise(function shown(resolve, reject) {
    fixture.on('error', reject);
    fixture.stdout.on('data', function ready(data) {
      const output = String(data).trim();
      if (output.startsWith('READY ')) resolve(JSON.parse(output.slice('READY '.length)));
    });
    fixture.stderr.on('data', function failed(data) { reject(new Error(String(data))); });
  });
  nativeHand = require('../electron/lib/desktop-hand');
  nativeHand.setAlive(true);
  const foreground = await nativeHand.foregroundWindow();
  check(foreground.pid > 0 && foreground.right > foreground.left, '真实 Win32 前台身份与边界可读取');
  const screenText = require('../electron/lib/screen-text-map');
  // 固定测试窗口元数据；真实窗口仍显示在屏幕上，避免用户切焦点使截图专项受干扰。
  const readForeground = nativeHand.foregroundWindow;
  nativeHand.foregroundWindow = async function fixtureForeground() {
    return Object.assign({ pid: fixture.pid, proc: 'powershell', title: 'AGI screen request verification' }, fixtureBounds);
  };
  const observed = await screenText.observeForegroundRequest();
  console.log('NATIVE ' + JSON.stringify({ foreground, observed }));
  check(observed && requestsIn(observed).some(function found(text) { return text.includes('生成验收文件'); }),
    '真实显示窗口的裁剪图像由本地 OCR 识别为屏幕请求');
  const unchanged = await screenText.observeForegroundRequest();
  check(unchanged && unchanged.lines === observed.lines, '未变化的真实图像复用 OCR 文本');
  check(nativeHand.currentFrame() === null, '后台读屏不改写桌面操作坐标帧');
  let foregroundReads = 0;
  /** 模拟识别期间用户切走窗口，结果必须作废，不能在其它窗口误执行。 */
  nativeHand.foregroundWindow = async function changedForeground() {
    foregroundReads++;
    const hwnd = foregroundReads === 1 ? fixtureBounds.hwnd : 'other-window';
    return Object.assign({ pid: fixture.pid, proc: 'powershell', title: 'fixture' }, fixtureBounds, { hwnd });
  };
  check(await screenText.observeForegroundRequest() === null, '读屏期间前台切换时不提交旧窗口请求');
  /** 自身进程的对话回显不得进入 OCR 接单。 */
  nativeHand.foregroundWindow = async function selfForeground() {
    return Object.assign({}, fixtureBounds, { pid: process.pid, proc: path.basename(process.execPath,'.exe') });
  };
  check(await screenText.observeForegroundRequest() === null, 'SpCode 自身前台不重复接收聊天回显');
  const long = '请帮我' + '核对代码调用关系'.repeat(30);
  const pieces = [{ text: long, conf: 99, x0: 0, x1: 900, y0: 0, y1: 30 }];
  check(screenText.normalizeLines(pieces,1,1,Infinity)[0].text === long, '后台完整行不受展示用160字截断');
  nativeHand.foregroundWindow = readForeground;
  nativeHand.setAlive(false);
  fixture.kill();
  fixture = null;
}

/** 顺序完成行为链路与本地 OCR，结果与样本保留在独立目录。 */
async function main() {
  await app.whenReady();
  const timeout = setTimeout(function exceeded() { failed(new Error('AGI 接单验收超时')); }, 55000);
  await fs.promises.mkdir(path.join(root,'generated'), { recursive: true });
  workspace = await fs.promises.mkdtemp(path.join(root,'generated','agi-screen-test-'));
  await testWatcher();
  await testPipeline();
  await testNativeScreen();
  check(errors.length === 0, '全部专项无未处理拒绝');
  await fs.promises.writeFile(path.join(workspace,'verification.json'), JSON.stringify({ ok:true,checks,errors },null,2),'utf8');
  console.log('RESULT ' + JSON.stringify({ ok:true,checks,workspace }));
  clearTimeout(timeout);
  app.exit(0);
}
/** 失败时关闭本次创建的窗口和辅助进程，保留真实错误与非零退出状态。 */
function failed(error) {
  if (fixture) fixture.kill();
  if (nativeHand) nativeHand.setAlive(false);
  console.error(error.stack || error);
  if (errors.length) console.error(errors.join('\n'));
  app.exit(1);
}
main().catch(failed);
