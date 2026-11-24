'use strict';

// 控制模型事件的时机，运行真实主进程、命令工具、preload 和聊天页。
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const direct = require('../electron/lib/codex-direct');

const output = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-summary-ui-'));
const userData = path.join(output, 'user-data');
const workspace = path.join(output, 'workspace');
const report = { output, checks: [] };
const marker = 'summary-command-echo-marker-';
const probe = 'node -p "' + JSON.stringify(marker.repeat(28)).replaceAll('"', "'") + '.length"';
const command = 'node -p 32 && ' + probe;
const wrapped = command.replace(' && ', ' &&\n    ');
const clipped = probe.slice(0, 126) + '…' + probe.slice(-69);
const segments = [
  '草稿增量回显：' + command.slice(0, 80), command.slice(80),
  '本地输出已核对。\n全量：' + wrapped + '.\n后半段：' + probe + ';',
  '本地输出已核对。\n全量：' + command + ';\n后半段：' + probe + '.\n截短：' + clipped +
    '\n测试实际输出 ' + marker.length * 28 + '。\n任务已完成。'
];
const advance = [];
let entered = false;
let responseStage = 0;
let calls = 0;
let finished = false;

for (const dir of [userData, workspace, path.join(output, 'session-data'), path.join(output, 'crash-dumps')]) fs.mkdirSync(dir);
app.setName('SpCodeSummaryCommandVerification');
app.setPath('userData', userData);
app.setPath('sessionData', path.join(output, 'session-data'));
app.setPath('crashDumps', path.join(output, 'crash-dumps'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  locale: 'zh', onboardingCompleted: true, autoSave: false, desktopAlive: true,
  trainingDataEnabled: false, cursorDirect: true, currentModelId: 'fixture-model',
  models: [{ id: 'fixture-model', providerId: 'fixture-provider', name: 'Codex 验收', model: 'fixture', enabled: true }],
  providers: [{ id: 'fixture-provider', name: 'Codex 验收', protocol: 'codex', baseUrl: 'http://127.0.0.1:1' }],
  commandSandbox: { enabled: true, timeoutSec: 15 }, recents: [{ path: workspace, name: '总结验收' }],
  capabilityDefaults: {}, assemblies: {}
}), 'utf8');

/**
 * 保存行为断言和现场目录，并退出本测试创建的 Electron 进程。
 * @param {Error} [error] 失败原因，成功时不传。
 * @returns {void} 进程以实际验收结果为退出状态。
 */
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (error) report.error = String(error.stack || error);
  const file = path.join(output, 'report.json');
  fs.writeFileSync(file, JSON.stringify(report, null, 2), 'utf8');
  if (error) console.error(report.error);
  console.log('REPORT ' + file);
  app.exit(error ? 1 : 0);
}

/**
 * 暂停模型传输，让测试能在下一片段到达前读取实际气泡。
 * @param {number} stage 当前检查点编号。
 * @returns {Promise<void>} 页面采样完成后由验收代码解除暂停。
 */
function pauseAt(stage) {
  return new Promise(function gate(resolve) {
    advance[stage] = resolve;
    responseStage = stage;
  });
}

/**
 * 在测试实例返回固定目录，避免真实模型查询。
 * @returns {Promise<{catalog: {fixture: object}}>} 以模型标识为键的目录对象，夹具模型没有额外的推理选项。
 */
require('../electron/lib/codex-model').listModels = async function modelCatalog() {
  return { catalog: { fixture: {} } };
};

/**
 * 用真实工具取得结果，再按验收阶段发出固定的模型事件。
 * @param {object} args 正式直通入口传入的执行与事件发布接口。
 * @returns {Promise<{content: string}>} 测试释放最后一个检查点后返回完整正文。
 */
direct.runTurn = async function controlledModel(args) {
  assert.equal(++calls, 1, '夹具应在同一次请求中完成命令和结果汇报');
  const evidence = await args.runTool('run_command', { command, activity: 'command' });
  assert.match(evidence, /exit: 0/);
  assert.ok(evidence.includes(String(marker.length * 28)), evidence);
  args.onEvent({ type: 'text', text: segments[0] });
  args.onEvent({ type: 'status', text: '验收暂停在第一段' });
  await pauseAt(1);
  args.onEvent({ type: 'text', text: segments[1] });
  args.onEvent({ type: 'rewrite_text', text: segments[2] });
  await pauseAt(2);
  return { content: segments[3] };
};

/**
 * 等待生产页面或夹具到达指定阶段，由进程看门狗处理超时。
 * @param {Function} predicate 每次读取实际状态，支持异步采样。
 * @returns {Promise<*>} 首个判定通过的采样。
 */
async function waitFor(predicate) {
  for (;;) {
    const value = await predicate();
    if (value) return value;
    await new Promise(function poll(resolve) { setTimeout(resolve, 25); });
  }
}

/**
 * 在实际 Chromium 页面采样正文和当前轮次状态。
 * @param {BrowserWindow} win 隔离实例的生产主窗。
 * @returns {Promise<object>} 可见气泡文字、减少动态效果设置和完成事件。
 */
function sample(win) {
  return win.webContents.executeJavaScript(`({
    text: document.querySelector('#messages .msg.assistant:last-child .bubble')?.textContent || '',
    running: document.getElementById('btn-send').classList.contains('is-stop'),
    reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
    done: window.summaryCommandDone || [],
    firstChunkDelivered: window.summaryCommandPaused
  })`);
}

/**
 * 核对正文没有命令片段，并记录通过的检查点。
 * @param {string} label 当前检查点的文字说明。
 * @param {{text: string}} actual 页面采样或实际收到的 IPC 正文。
 * @returns {void} 有命令回显时立即抛出断言。
 */
function check(label, actual) {
  assert.doesNotMatch(actual.text, /node\s+-p|summary-command-echo-marker|草稿增量回显/, label + JSON.stringify(actual));
  report.checks.push(label);
  console.log('PASS ' + label);
}

/**
 * 通过正式发送入口验收增量、快照与完成后的实际气泡。
 * @param {BrowserWindow} win 已加载生产聊天页的主窗。
 * @returns {Promise<void>} 核对通过后保留气泡正文与生成中截图。
 */
async function verify(win) {
  const debuggerPipe = win.webContents.debugger;
  debuggerPipe.attach('1.3');
  await debuggerPipe.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const js = win.webContents.executeJavaScript.bind(win.webContents);
  await waitFor(function ready() { return js("!!document.querySelector('#recent-list .recent-item[data-path]')"); });
  await js("document.querySelector('#recent-list .recent-item[data-path]').click()");
  await waitFor(function opened() { return js("!!document.querySelector('#tabs .tab[data-id]')"); });
  await js(`
    window.summaryCommandDone = [];
    window.simple.onChatEvent(function receive(event) {
      if (event.type === 'done') window.summaryCommandDone.push(event.text);
      if (event.type === 'status' && event.text === '验收暂停在第一段') window.summaryCommandPaused = true;
    });
    document.getElementById('input').value = '核对指定本地命令的实际输出。';
    document.getElementById('btn-send').click();
    true;
  `);
  // 使用后到的状态事件确认前一正文片段已到达同一个页面，后台窗口无需等待动画帧。
  const partial = await waitFor(async function firstChunk() {
    const actual = await sample(win);
    return actual.firstChunkDelivered && actual;
  });
  assert.equal(responseStage, 1);
  assert.ok(partial.reduced && partial.running && !partial.done.length, JSON.stringify(partial));
  check('减少动态效果：未完成的命令增量没有进入生成中的气泡', partial);
  advance[1]();
  const live = await waitFor(async function snapshot() {
    const actual = await sample(win);
    return actual.text.includes('本地输出已核对') && actual;
  });
  assert.equal(responseStage, 2);
  assert.ok(live.running && !live.done.length, JSON.stringify(live));
  check('完成事件到达前：气泡清理换行的完整命令和后半段，保留英文标点', live);
  assert.ok(live.text.includes('全量：（命令见工具记录）.'));
  assert.ok(live.text.includes('后半段：（命令见工具记录）;'));
  await waitFor(function visible() { return win.isVisible(); });
  const screenshot = await win.webContents.capturePage();
  assert.ok(!screenshot.isEmpty());
  fs.writeFileSync(path.join(output, 'generating.png'), screenshot.toPNG());
  advance[2]();
  const final = await waitFor(async function completed() {
    const actual = await sample(win);
    return !actual.running && actual.done.length && actual;
  });
  check('完成后：气泡清理完整、后半段和截短回显，保留实测输出', final);
  assert.ok(final.text.includes('全量：（命令见工具记录）;'));
  assert.ok(final.text.includes('后半段：（命令见工具记录）.'));
  assert.ok(final.text.includes('截短：（命令见工具记录）'));
  assert.ok(final.text.includes('测试实际输出 ' + marker.length * 28 + '。'));
  assert.equal(final.done.length, 1);
  check('最终 IPC 正文已清理', { text: final.done[0] });
  report.liveBubble = live.text;
  report.finalBubble = final.text;
}

/**
 * 只在隔离实例首次加载正式聊天页后启动验收。
 * @param {Electron.Event} _event Electron 创建窗口的通知。
 * @param {BrowserWindow} win 新建窗口，悬浮窗加载时不运行验收。
 * @returns {void} 注册当前窗口加载后的验收入口。
 */
function onWindow(_event, win) {
  // 保留实际渲染表面供截图，不抢占用户的键盘焦点。
  win.setFocusable(false);
  win.webContents.on('did-finish-load', function loaded() {
    if (entered || !win.webContents.getURL().endsWith('/renderer/index.html')) return;
    entered = true;
    verify(win).then(finish, finish);
  });
}

const watchdog = setTimeout(function timeout() { finish(new Error('桌面验收超时，模型阶段：' + responseStage)); }, 30000);
app.on('browser-window-created', onWindow);
require('../electron/main');
