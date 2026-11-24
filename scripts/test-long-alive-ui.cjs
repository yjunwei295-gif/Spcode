/**
 * 使用真实 Electron、preload IPC、原有 PlanMap/DialogMap 和长时面板验收。
 * 隔离用户数据，模型响应由本地处理器控制，不连接运营平台或外部模型。
 */
const { app, BrowserWindow, ipcMain, session } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { registerLongAlive } = require('../electron/lib/long-alive-host');
app.commandLine.appendSwitch('js-flags', '--expose-gc');
app.commandLine.appendSwitch('enable-precise-memory-info');
const root = path.resolve(__dirname, '..');
const out = fs.mkdtempSync(path.join(root, 'generated/long-alive-ui-'));
app.setPath('userData', path.join(out, 'userdata'));
let win;
let host;
let checks = 0;
let requests = 0;
let startCount = 0;
let stopCount = 0;
let doneCount = 0;
const faults = [];
const watchdog = setTimeout(function timeout() { fail(new Error('界面验收超时')); }, 45000);
/** 真实页面内执行，异常传给主进程断言。 */
function evaluate(code) { return win.webContents.executeJavaScript(code, true); }
/** 输出逐项行为证据。 */
function check(value, message) { assert.ok(value, message); checks++; console.log('PASS ' + message); }
/** 等待页面和跨进程事件，时间仅属于测试。 */
function pause(ms) { return new Promise(function wait(resolve) { setTimeout(resolve, ms); }); }
/** 失败保留诊断且以非零码退出。 */
function fail(error) { console.error(error); console.error(JSON.stringify(faults)); if (host) host.dispose(); clearTimeout(watchdog); app.exit(1); }

/** 运行原页面，只阻止自动初始化模块，注入实际长时面板和真实发送函数。 */
async function main() {
  const appUrl = pathToFileURL(path.join(root, 'renderer/app.js')).href;
  const visionUrl = pathToFileURL(path.join(root, 'renderer/vision-settings.js')).href;
  session.defaultSession.webRequest.onBeforeRequest(function filter(details, callback) {
    callback({ cancel: details.url === appUrl || details.url === visionUrl });
  });
  win = new BrowserWindow({ show: false, width: 1280, height: 900,
    webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, sandbox: false } });
  win.webContents.on('console-message', function consoleMessage(event) {
    if ((event.level === 'error' || event.level >= 3) && !event.message.includes('ERR_BLOCKED_BY_CLIENT')) faults.push(event.message);
  });
  host = registerLongAlive({ app, ipcMain,
    getWin: function getWin(event) { return BrowserWindow.fromWebContents(event.sender); },
    send: function send(window, channel, data) { window.webContents.send(channel, data); },
    abort: function abort(_window, turnId) { stopCount++; },
    activeTab: function active() { return 'fixture'; }, workspace: function workspace() { return root; },
    busy: function busy() { return false; }, turnTab: function turnTab() { return 'fixture'; }
  });
  ipcMain.on('log:client', function log(_event, payload) {
    if (payload.message === '长时存活失败') faults.push(payload.detail);
  });
  ipcMain.handle('chat:send', async function chat(event, payload) {
    check(host.authorize(win, payload.longAliveRunId, payload.turnId) === '只核对本地任务，禁止发布',
      '真实主进程核对自动轮次权限并返回面板保存的原始目标');
    requests++;
    return { text: '已完成第 ' + requests + ' 次本地检查；下次继续核对待办。', changes: [] };
  });
  await win.loadFile(path.join(root, 'renderer/index.html'));
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8').split('\r\n').join('\n');
  const begin = source.indexOf('function isLongAliveMessage(');
  const end = source.indexOf('async function openContextPreview(', begin);
  const sendBegin = source.indexOf('async function sendOne(');
  const sendEnd = source.indexOf('/**\n * 将本地识别', sendBegin);
  const modalBegin = source.indexOf('function openModal(');
  const modalEnd = source.indexOf('async function openProject(', modalBegin);
  const setup = `
    var api = window.simple;
    var tab = { id: 'fixture', workspace: ${JSON.stringify(root)}, title: '长期运营验收',
      messages: [], queue: [], pickedSkillIds: [], workingMemory: {}, contextSummary: '' };
    var state = { tabs: [tab], currentModelId: 'controlled', contextPaths: [], attachments: [], promptOverrides: null };
    function $(id) { return document.getElementById(id); }
    function activeSession() { return tab; }
    function currentModel() { return { id: 'controlled' }; }
    function isActiveTab(value) { return value === tab; }
    function tabQueue(value) { return value.queue; }
    function normalizeSkillIds(value) { return value.skillIds || []; }
    function uid() { return crypto.randomUUID(); }
    function persistTab() { return Promise.resolve(); }
    function beginRefillResend() { return Promise.resolve(); }
    function prefersReducedMotion() { return true; }
    function dialogRounds() { return []; }
    function isNewChatTitle() { return false; }
    function t(value) { return value; }
    function extraFoldersOf() { return []; }
    function roundsOf() { return 16; }
    function emptyWorkingMemory() { return {}; }
    function isStopError() { return false; }
    function localMilestoneHits() { return []; }
    function slimMessagesForSave(messages) { return messages; }
    function focusInside() {}
    function releaseFocus() {}
    function focusComposer() {}
    function markTurnFailed(message, error) { throw error; }
  `;
  const noopNames = ['renderQueue','renderChips','renderTabs','renderMessages','scrollMessagesToBottom',
    'syncSendBtn','armStallWatch','logSummaryTrace','revealRest','clearStallWatch','finishTypewriter',
    'flushLivePaint','stopTypewriter','renderSidebar','retryHotReload'];
  let noops = '';
  for (const name of noopNames) noops += 'function ' + name + '() {}\n';
  ipcMain.handle('snapshot:list', function snapshots() { return []; });
  ipcMain.handle('milestone:list', function milestones() { return []; });
  await evaluate(setup + noops + source.slice(modalBegin, modalEnd) + source.slice(sendBegin, sendEnd) +
    source.slice(begin, end) + `
      api.onLongAliveTask(onLongAliveTask);
      api.onLongAliveState(showLongAliveState);
      $('btn-long-alive').onclick = openLongAlive;
      document.getElementById('view-welcome').style.display = 'none';
      document.getElementById('modal').classList.remove('hidden');
    `);
  await evaluate('openLongAlive()');
  check(await evaluate("!!$('long-alive-goal') && !!$('long-alive-goals') && !!$('long-alive-context')"),
    '真实面板包含配置及两个既有导图入口');
  await evaluate("$('long-alive-goal').value='只核对本地任务，禁止发布'; $('long-alive-interval').value=1; $('long-alive-timeout').value=10; $('long-alive-start').click()");
  startCount++;
  await pause(1250);
  check(requests >= 1, '真实定时器经 preload、IPC、渲染队列到达模型入口');
  await evaluate("$('long-alive-stop').click()");
  await pause(50);
  const afterStop = requests;
  await pause(1200);
  check(requests === afterStop, '面板停止后不再启动下一轮');
  await evaluate('openLongAlive()');
  await pause(50);
  fs.writeFileSync(path.join(out, 'panel.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate("$('long-alive-goals').click()");
  await pause(50);
  check(await evaluate("document.querySelector('#plan-map-modal').textContent.includes('任务目标导图')"), '目标图使用实际 PlanMap 组件');
  check(await evaluate("!Array.from(document.querySelectorAll('#plan-map-modal button')).some(function(b){return /清理导图|删除/.test(b.textContent+b.title)})"),
    '目标图不暴露源码方案删除操作');
  fs.writeFileSync(path.join(out, 'goals.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate('window.PlanMap.close()');
  await evaluate('openLongAliveContextMap()');
  await pause(50);
  check(await evaluate("document.querySelector('#dialog-map-modal').textContent.includes('长时存活')"),
    '归档图使用实际 DialogMap 组件');
  check(await evaluate("!Array.from(document.querySelectorAll('#dialog-map-modal button')).some(function(b){return /删除|^删$/.test(b.textContent+b.title)})"),
    '归档图只筛选，不显示删除历史入口');
  fs.writeFileSync(path.join(out, 'context.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate("Array.from(document.querySelectorAll('#dialog-map-modal button')).find(function(b){return b.textContent==='清空'}).click(); Array.from(document.querySelectorAll('#dialog-map-modal button')).find(function(b){return b.textContent==='应用'}).click()");
  await pause(50);
  check(await evaluate('tab.longAlive.context.length===0 && tab.longAlive.omitCheckpoint'), '导图取消勾选经真实 IPC 持久化');
  await evaluate('window.DialogMap.close()');
  const before = app.getAppMetrics();
  await evaluate(`
    for (let i=0;i<100;i++) {
      openLongAliveGoalMap(); window.PlanMap.close();
      window.DialogMap.open({ title:'资源回收', rounds:[], preserveRecords:true });
      window.DialogMap.close();
    }
  `);
  check(await evaluate("document.querySelectorAll('#plan-map-modal,#dialog-map-modal').length===0"),
    '100 次打开关闭后无残留导图节点');
  const heapSamples = [];
  for (let batch = 0; batch < 5; batch++) {
    await evaluate(`
      for (let i=0;i<100;i++) {
        openLongAliveGoalMap(); window.PlanMap.close();
        window.DialogMap.open({ title:'资源回收', rounds:[], preserveRecords:true });
        window.DialogMap.close();
      }
      gc();
    `);
    await pause(100);
    heapSamples.push(await evaluate('performance.memory.usedJSHeapSize'));
  }
  check(heapSamples[4] - heapSamples[1] < 2 * 1048576,
    '五批导图压力测试回收后堆内存趋稳，末三批增量小于 2MB');
  const after = app.getAppMetrics();
  const metrics = { checks, requests, startCount, stopCount, before, after, heapSamples, faults, out };
  check(faults.length === 0, '界面与异步回执无运行错误');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(metrics, null, 2), 'utf8');
  console.log(JSON.stringify(metrics));
  host.dispose();
  clearTimeout(watchdog);
  if (process.argv.includes('--preview')) {
    await evaluate('openLongAlive()');
    win.setTitle('长时存活第一版 · 隔离验收预览');
    win.show();
    console.log('PREVIEW_PID ' + process.pid);
    setTimeout(function closePreview() { win.destroy(); app.exit(0); }, 60000);
    return;
  }
  win.destroy(); app.exit(0);
}
app.whenReady().then(main).catch(fail);
