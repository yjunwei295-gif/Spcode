'use strict';

/**
 * 在独立 Chromium 页面加载完整生产界面，验证常用需求灰字与键盘补全的真实绑定。
 * 只写 generated 内的隔离副本与证据；模型、会话和草稿接口均使用本地夹具，不触碰用户数据。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'composer-prediction-'));
const rendererCopy = path.join(output, 'renderer');
const requirement = '帮我检查这段代码并修复问题';
const prefix = '帮我检';
let checks = 0;
let win = null;
let finished = false;
const evidence = { output, checks: [], errors: [] };
app.setPath('userData', path.join(output, 'user-data'));
app.setPath('sessionData', path.join(output, 'session-data'));
app.on('window-all-closed', function keepAlive() {});
const watchdog = setTimeout(function timedOut() { failed(new Error('输入预测完整页面验收超时')); }, 45000);

/** 记录真实断言；失败保留现场路径、已有证据与原始错误。 */
function check(value, message) {
  assert.ok(value, message);
  checks++;
  evidence.checks.push(message);
  console.log('PASS ' + message);
}

/** 注入本地 API 与紧凑候选元数据；所有发送仅被记录并立即完成。 */
function fixtureSetup() {
  localStorage.setItem('spcode.onboarding.completed', 'true');
  const record = { sent: [], errors: [], drafts: [], saved: [], deleted: [], listCalls: 0 };
  const sessions = [
    { id: 'saved-common', title: '历史常用需求', workspace: 'fixture', updatedAt: 200, messageCount: 0, requirements: [
      { text: '帮我检查这段代码并修复问题', count: 8, lastIndex: 9 },
      { text: '帮我检索当前项目的调用链', count: 2, lastIndex: 4 },
      { text: '🐱测试输入的候选完整内容', count: 2, lastIndex: 5 }
    ] },
    { id: 'saved-other', title: '另一个历史需求', workspace: 'fixture', updatedAt: 100, messageCount: 0, requirements: [
      { text: '帮我检查这段代码并修复问题', count: 1, lastIndex: 0 },
      { text: '整理一下当前调用链', count: 3, lastIndex: 2 }
    ] }
  ];
  function noOp() {}
  async function emptyList() { return []; }
  async function nullValue() { return null; }
  window.simple = {
    completeOnboarding: async function completeOnboarding() { return true; },
    getState: async function getState() { return { locale: 'zh', theme: 'dark', resolvedTheme: 'dark', autoSave: true,
      workspace: 'fixture', models: [{ id: 'fixture', name: '测试模型', type: 'api', model: 'fixture' }],
      currentModelId: 'fixture', providers: [], videoProviderModels: [], recents: [], localFiles: [], assemblies: {}, capabilityDefaults: {} }; },
    listSkills: emptyList, listRules: emptyList, listSnapshots: emptyList, listMilestones: emptyList,
    loadPersona: nullValue, getGlobalMemory: nullValue, listChildren: emptyList,
    getSnapshotMax: async function getSnapshotMax() { return 20; },
    loadSessions: async function loadSessions() { record.listCalls++; return structuredClone(sessions); },
    loadSession: async function loadSession(id) { return { id, workspace: 'fixture', title: '历史空会话', messages: [] }; },
    setWorkspace: async function setWorkspace(workspace) { return workspace; },
    saveModels: async function saveModels() { return { videoProviderModels: [] }; },
    onChatEvent: function onChatEvent(callback) { window.emitFixtureChat = callback; },
    onWorkspaceChanged: noOp, onUiRefresh: noOp, onDownloadProgress: noOp, onIndexProgress: noOp,
    onHotReload: function onHotReload() { return noOp; }, hotReloadStatus: nullValue,
    reportAccountQuota: noOp, floatBind: noOp, floatForget: noOp, floatCanStart: noOp, logSummaryTrace: noOp,
    reportError: function reportError(stage, details) {
      if (stage === '界面脚本报错' || stage === '界面未处理的 Promise 拒绝') record.errors.push({ stage, details });
    },
    /**
     * 记录完整会话保存调用，供关闭自动保存的边界断言核对。
     * @param {object} session 生产页面请求保存的会话快照。
     * @returns {Promise<boolean>} 返回成功；只记录夹具数据，不接触用户存档。
     */
    saveSession: async function saveSession(session) { record.saved.push(structuredClone(session)); return true; },
    /**
     * 删除隔离夹具中的历史记录，使下一次读取反映实际删除结果。
     * @param {string} id 待删除的夹具会话编号。
     * @returns {Promise<boolean>} 返回成功；仅移除匹配编号，其他历史记录保持原样。
     */
    deleteSession: async function deleteSession(id) {
      record.deleted.push(id);
      const index = sessions.findIndex(function sameSession(session) { return session.id === id; });
      if (index >= 0) sessions.splice(index, 1);
      return true;
    },
    saveComposer: async function saveComposer(draft) { record.drafts.push(structuredClone(draft)); return true; },
    chatRestoreConsumed: noOp, stageTurnWindow: noOp,
    chatSend: async function chatSend(payload) {
      record.sent.push(structuredClone(payload));
      // 等实际收到发送事件后保持会话在运行，面板测试显式结束该轮。
      if (record.holdChat) await new Promise(function hold(resolve) { record.finishChat = resolve; });
      return { text: '', changes: [] };
    },
    chatInterject: async function chatInterject() { throw new Error('测试不应落入插话分支'); },
    contextPreview: async function contextPreview() { return {}; }
  };
  record.sessions = sessions;
  window.predictionFixture = record;
}

/** 在生产页面执行表达式；所有测试访问口仅附加在隔离副本。 */
function page(source) { return win.webContents.executeJavaScript(source); }

/** 有界等待实际条件；失败返回当前 DOM 和 API 错误，避免把未初始化当成空候选。 */
async function waitFor(expression, timeoutMs = 3000) {
  const result = await page('(async function wait() { const started = performance.now(); while (performance.now() - started < ' + timeoutMs + ') {'
    + 'if (' + expression + ') return true; await new Promise(function pause(resolve) { setTimeout(resolve, 10); }); }'
    + 'return { value: document.getElementById("input")?.value, errors: window.predictionFixture?.errors, text: document.getElementById("input-prediction")?.textContent }; })()');
  assert.equal(result, true, JSON.stringify(result));
}

/** 等待短按判定窗口，仅用于验证明确的延迟与取消行为。 */
function pause(milliseconds) {
  return page('new Promise(function wait(resolve) { setTimeout(resolve, ' + milliseconds + '); })');
}

/** 以真实 input 事件更新文本、光标与草稿，保留生产输入回调。 */
async function setInput(text, start, end) {
  const first = start == null ? text.length : start;
  const last = end == null ? first : end;
  return page('(function set() { const input = document.getElementById("input"); input.focus(); input.value = ' + JSON.stringify(text)
    + '; input.setSelectionRange(' + first + ', ' + last + '); input.dispatchEvent(new Event("input", { bubbles: true }));'
    + 'input.dispatchEvent(new Event("select", { bubbles: true })); return input.value; })()');
}

/** 投递原生 Chromium 键并等对应 keyup，避免异步投递尚未处理就读结果。 */
async function nativeKey(keyCode, modifiers = []) {
  await page('void (window.predictionNativeDone = new Promise(function wait(resolve) { document.getElementById("input").addEventListener("keyup", function done() { resolve(); }, { once: true }); }))');
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // 原生字符是独立的 Chromium char 事件；keydown 只携带键位，不能代替实际文本输入。
  if (keyCode === 'Space') win.webContents.sendInputEvent({ type: 'char', keyCode: ' ', modifiers });
  if (keyCode === 'Return' && modifiers.includes('shift')) win.webContents.sendInputEvent({ type: 'char', keyCode: '\r', modifiers });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
  await page('window.predictionNativeDone');
}

/** 读取可见灰字、快捷键提示和发送数；提示与隐藏前缀均不属于输入正文。 */
function snapshot() {
  return page('(function inspect() { const input = document.getElementById("input"); const ghost = document.getElementById("input-prediction");'
    + 'return { value: input.value, suffix: ghost.querySelector(".composer-prediction-suffix")?.textContent || "",'
    + 'prefix: ghost.querySelector(".composer-prediction-prefix")?.textContent || "", hidden: getComputedStyle(ghost).display === "none" || ghost.hidden,'
    + 'hint: document.getElementById("input-prediction-hint")?.textContent, hintHidden: document.getElementById("input-prediction-hint")?.hidden,'
    + 'sent: predictionFixture.sent.length, errors: predictionFixture.errors, placeholder: input.placeholder }; })()');
}

/** 验证聚合排序直接执行生产 ESM，不以夹具重写排序规则。 */
async function testRanking() {
  const ranked = await page('(async function rank() { const module = await import("./composer-prediction.js"); return module.rankComposerRequirements(['
    + '{id:"a",updatedAt:10,requirements:[{text:"重复需求",count:2,lastIndex:1},{text:"旧但次数多",count:6,lastIndex:0}]},'
    + '{id:"b",updatedAt:30,requirements:[{text:"重复需求",count:3,lastIndex:2},{text:"同频新需求",count:5,lastIndex:0},{text:"同频更近序",count:5,lastIndex:4}]}]); })()');
  check(ranked[0].text === '旧但次数多' && ranked[1].text === '同频更近序' && ranked[2].text === '重复需求'
    && ranked[2].count === 5 && ranked[3].text === '同频新需求', '跨会话同需求合并次数，按频次、时间和最近序号排序');
}

/** 验证真实灰字内容、Unicode 阈值、选择范围和多行排版。 */
async function testPresentation() {
  await setInput('');
  let result = await snapshot();
  check(result.suffix === requirement && !result.hidden && result.placeholder === '', '空框显示历史最高频需求，移除固定规划构建占位文案');
  check(result.hint === '快速按两次空格补全' && result.hintHidden === false, '空框灰字显示与实际手势一致的双空格提示');
  check(await page('predictionFixture.listCalls > 0'), '候选来自真实会话列表加载入口，重开时可恢复紧凑历史');
  await setInput('帮我');
  result = await snapshot();
  check(result.hidden || result.suffix === '', '不足三个字符时没有后缀预测');
  await setInput(prefix);
  result = await snapshot();
  check(!result.hidden && result.prefix === prefix && result.suffix === requirement.slice(prefix.length), '三个匹配前缀后仅以灰字展示未输入后缀');
  check(result.hint === '快速按两次回车补全' && result.hintHidden === false && result.value === prefix, '有文字的灰字显示快速双回车提示且不写入正文');
  await setInput('完全不匹配');
  result = await snapshot();
  check(result.hidden || result.suffix === '', '不匹配常用需求时不显示预测');
  check(result.hintHidden === true, '没有可用灰字时同时隐藏补全提示');
  await setInput(requirement);
  result = await snapshot();
  check(result.hidden || result.suffix === '', '完整需求已输入时不出现重复预测');
  await setInput(prefix, 1);
  result = await snapshot();
  check(result.hidden || result.suffix === '', '光标位于正文中间时不覆盖原文');
  await setInput(prefix, 0, prefix.length);
  result = await snapshot();
  check(result.hidden || result.suffix === '', '存在选区时不显示补全');
  await setInput('🐱测');
  result = await snapshot();
  check(result.hidden || result.suffix === '', 'Unicode 代理对按一个字符计数');
  await setInput('🐱测试');
  result = await snapshot();
  check(!result.hidden && result.suffix === '输入的候选完整内容', '三个 Unicode 字符可触发预测');
  await setInput(prefix);
  const layout = await page('(function layout() { const input = document.getElementById("input"); const ghost = document.getElementById("input-prediction");'
    + 'const typed = ghost.querySelector(".composer-prediction-prefix"); const suffix = ghost.querySelector(".composer-prediction-suffix");'
    + 'const a = input.getBoundingClientRect(); const b = ghost.getBoundingClientRect(); const style = getComputedStyle(input);'
    + 'return { pointer: getComputedStyle(ghost).pointerEvents, prefix: getComputedStyle(typed).visibility,'
    + 'font: style.fontSize, suffixFont: getComputedStyle(suffix).fontSize, input: {x:a.x,y:a.y,width:a.width}, ghost: {x:b.x,y:b.y,width:b.width} }; })()');
  check(layout.pointer === 'none' && layout.prefix === 'hidden' && layout.font === layout.suffixFont
    && Math.abs(layout.input.x - layout.ghost.x) < 2 && Math.abs(layout.input.y - layout.ghost.y) < 2
    && Math.abs(layout.input.width - layout.ghost.width) < 2, '真实样式中灰字对齐输入框、隐藏已输入前缀且不拦截鼠标');
  check(await page('getComputedStyle(document.getElementById("input-prediction-hint")).display !== "none"'
    + ' && document.getElementById("input-prediction-hint").getBoundingClientRect().top >= document.getElementById("input").getBoundingClientRect().bottom'
    + ' && document.getElementById("input-prediction-hint").getBoundingClientRect().height > 0'), '快捷键提示在真实样式下可见且位于输入框下方');
}

/**
 * 验证连续编辑会立即改变灰字，而非等到发送或重新加载历史后才匹配。
 * 无参数；通过 Chromium 原生文本插入、Backspace 和选区替换修改生产输入框。
 * 在生产 input 回调之后同步记录灰字，断言同一次可信输入事件内已更新；不手动调用预测刷新。
 * @returns {Promise<void>} 完成逐字输入、同前缀候选切换、删除及整段替换；仅保存隔离页面证据。
 */
async function testRealtimeInput() {
  await setInput('');
  const baseline = await page('({ sent: predictionFixture.sent.length, listCalls: predictionFixture.listCalls })');
  await page('/** 初始化实时输入观察；无参数，清空隔离页面的证据数组并注册输入监听。'
    + ' @returns {void} 不返回值；后续输入由监听回调同步记录。 */'
    + '(function observeRealtimeInput() { window.predictionRealtimeEvents = [];'
    + 'document.getElementById("input").addEventListener("input", '
    + '/** 记录生产输入回调执行后的正文、灰字与事件来源，不修改输入或预测。'
    + ' @param {InputEvent} event 生产输入框触发的输入事件，用于读取正文、可信标记和编辑类型。'
    + ' @returns {void} 不返回值；向隔离页面的证据数组追加本次输入快照。 */'
    + 'function recordRealtimeInput(event) {'
    + 'const ghost = document.getElementById("input-prediction"); predictionRealtimeEvents.push({'
    + 'value: event.target.value, suffix: ghost.querySelector(".composer-prediction-suffix").textContent,'
    + 'hidden: ghost.hidden, trusted: event.isTrusted, inputType: event.inputType }); }); })()');
  const inserts = [
    { text: '帮', value: '帮', suffix: '' },
    { text: '我', value: '帮我', suffix: '' },
    { text: '检', value: prefix, suffix: requirement.slice(prefix.length) },
    { text: '索', value: '帮我检索', suffix: '当前项目的调用链' },
    { text: '当', value: '帮我检索当', suffix: '前项目的调用链' }
  ];
  for (const step of inserts) {
    await win.webContents.insertText(step.text);
    const event = await page('predictionRealtimeEvents.at(-1)');
    check(event.trusted && event.value === step.value && event.suffix === step.suffix
      && event.hidden === (step.suffix === ''), '原生逐字输入在同次 input 事件内更新预测：' + step.value);
  }
  const deletions = [
    { value: '帮我检索', suffix: '当前项目的调用链' },
    { value: prefix, suffix: requirement.slice(prefix.length) },
    { value: '帮我', suffix: '' }
  ];
  for (const step of deletions) {
    await nativeKey('Backspace');
    const event = await page('predictionRealtimeEvents.at(-1)');
    check(event.trusted && event.inputType === 'deleteContentBackward' && event.value === step.value
      && event.suffix === step.suffix && event.hidden === (step.suffix === ''), '原生删字立即重选候选或隐藏预测：' + step.value);
  }
  await win.webContents.insertText('检错');
  let result = await snapshot();
  check(result.value === '帮我检错' && result.hidden && result.suffix === '', '继续输入不匹配文字立即清除旧灰字');
  await nativeKey('Backspace');
  result = await snapshot();
  check(result.value === prefix && !result.hidden && result.suffix === requirement.slice(prefix.length), '删除不匹配文字立即恢复当前前缀预测');
  await page('document.getElementById("input").select()');
  await win.webContents.insertText('整理一');
  result = await snapshot();
  check(result.value === '整理一' && !result.hidden && result.suffix === '下当前调用链', '原生选区替换后立即按新前缀切换需求');
  await page('document.getElementById("input").select()');
  await win.webContents.insertText(prefix);
  result = await snapshot();
  check(result.value === prefix && !result.hidden && result.suffix === requirement.slice(prefix.length), '一次插入多个字符也立即更新预测');
  evidence.realtime = await page('predictionRealtimeEvents');
  check(evidence.realtime.length === 12 && evidence.realtime.every(
    /**
     * 判断单条实时输入证据是否来自可信 Chromium 输入事件，不修改证据。
     * @param {{ trusted: boolean }} event 已记录的输入快照，trusted 表示原始事件的可信状态。
     * @returns {boolean} 原始输入事件可信时返回 true，否则返回 false。
     */
    function trusted(event) { return event.trusted; }
  ), '连续编辑证据全部来自可信 Chromium input 事件');
  check(await page('predictionFixture.sent.length === ' + baseline.sent + ' && predictionFixture.listCalls === ' + baseline.listCalls), '实时匹配只更新提示，不发送消息或逐字重读历史');
}

/** 验证单/双/第三次回车与原生空格，不调用测试版发送或补全实现。 */
async function testGestures() {
  await setInput(prefix);
  let baseline = (await snapshot()).sent;
  await nativeKey('Return');
  check((await snapshot()).sent === baseline, '第一次回车不会提前发送半句');
  await nativeKey('Return');
  let result = await snapshot();
  check(result.value === requirement && result.sent === baseline, '快速原生双回车仅填充完整需求');
  check(result.hintHidden === true && !result.value.includes('快速按'), '补全完成后隐藏提示，输入正文不包含提示文案');
  await pause(420);
  result = await snapshot();
  check(result.value === requirement && result.sent === baseline, '双回车取消待发任务，窗口结束也不发送');
  await nativeKey('Return');
  await waitFor('predictionFixture.sent.length === ' + (baseline + 1));
  check(await page('predictionFixture.sent.at(-1).text === ' + JSON.stringify(requirement)), '第三次原生回车只发送一次完整预测');
  await setInput(prefix);
  baseline = (await snapshot()).sent;
  await nativeKey('Return');
  await pause(80);
  check((await snapshot()).sent === baseline, '单回车在双按判断窗口内保留原输入');
  await waitFor('predictionFixture.sent.length === ' + (baseline + 1));
  check(await page('predictionFixture.sent.at(-1).text === ' + JSON.stringify(prefix)), '未双按的回车发送用户原文而非预测全文');
  await setInput('无预测直接发送');
  baseline = (await snapshot()).sent;
  await nativeKey('Return');
  await waitFor('predictionFixture.sent.length === ' + (baseline + 1), 200);
  check(await page('predictionFixture.sent.at(-1).text === "无预测直接发送"'), '没有预测时原生回车不等待双按窗口');
  await setInput('');
  baseline = (await snapshot()).sent;
  await nativeKey('Space');
  check((await snapshot()).value === ' ', '空框第一次原生空格保留正常输入');
  await nativeKey('Space');
  result = await snapshot();
  check(result.value === requirement && result.sent === baseline, '空框原生双空格填入当前灰字且不发送');
  await pause(420);
  check((await snapshot()).sent === baseline, '双空格补全后不会隐式发送');
  await setInput('');
  await nativeKey('Space');
  await pause(420);
  await nativeKey('Space');
  check((await snapshot()).value === '  ', '慢速两次空格仍是正常空格');
}

/** 后台候选更新不能改变用户第一下按键时已经看见并确认的内容。 */
async function testAsyncCandidates() {
  const replacement = [{ text: '帮我检查另外一份脚本', count: 99, lastIndex: 99 }];
  await setInput(prefix);
  let baseline = (await snapshot()).sent;
  await nativeKey('Return');
  await page('__composerPredictionTest.composerPrediction.setCandidates(' + JSON.stringify(replacement) + ')');
  await nativeKey('Return');
  let result = await snapshot();
  check(result.value === requirement && result.sent === baseline, '首回车后后台候选变化，双回车仍接受第一次看见的需求');
  await pause(420);
  check((await snapshot()).sent === baseline, '后台候选变化后的双回车仍不自动发送');
  await page('__composerPredictionTest.refreshComposerRequirements()');
  await setInput(prefix);
  await nativeKey('Return');
  await page('__composerPredictionTest.composerPrediction.setCandidates(' + JSON.stringify(replacement) + ')');
  await waitFor('predictionFixture.sent.length === ' + (baseline + 1));
  check(await page('predictionFixture.sent.at(-1).text === ' + JSON.stringify(prefix)), '首回车后后台候选变化，单回车仍发送原输入');
  baseline++;
  await page('__composerPredictionTest.refreshComposerRequirements()');
  await setInput('');
  await nativeKey('Space');
  await page('__composerPredictionTest.composerPrediction.setCandidates(' + JSON.stringify(replacement) + ')');
  result = await snapshot();
  check(result.suffix === requirement && !result.hidden, '首空格后后台候选变化，灰字仍固定第一次展示的需求');
  await nativeKey('Space');
  result = await snapshot();
  check(result.value === requirement && result.sent === baseline, '后台候选变化后的双空格填充与眼前灰字一致且不发');
  await page('__composerPredictionTest.refreshComposerRequirements()');
}

/** 验证输入法、换行、菜单、编辑、失焦和会话切换不触发错误提交。 */
async function testIsolation() {
  await page('(async function prepareTabs() { const test = __composerPredictionTest; window.predictionOriginalTab = test.state.activeTab;'
    + 'test.newTab(); window.predictionAlternateTab = test.state.activeTab; test.newTab(); window.predictionBlankTab = test.state.activeTab;'
    + 'await test.switchToTab(window.predictionOriginalTab); })()');
  await setInput(prefix);
  let baseline = (await snapshot()).sent;
  await page('(function ime() { const input = document.getElementById("input"); input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));'
    + 'input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true }));'
    + 'input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true, cancelable: true }));'
    + 'input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })); })()');
  await pause(420);
  check((await snapshot()).sent === baseline && (await snapshot()).value === prefix, 'IME Enter 和旧输入法 229 不补全也不发送');
  await nativeKey('Return', ['shift']);
  check((await snapshot()).value === prefix + '\n' && (await snapshot()).sent === baseline, 'Shift+Enter 保留原生换行');
  for (const id of ['slash-menu', 'at-menu']) {
    await setInput(prefix);
    await page('document.getElementById(' + JSON.stringify(id) + ').classList.remove("hidden")');
    await page('document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", bubbles:true, cancelable:true }))');
    await pause(420);
    check((await snapshot()).sent === baseline && (await snapshot()).value === prefix, id + ' 打开时回车不接受预测或误发');
    await nativeKey('Return', ['shift']);
    check((await snapshot()).value === prefix + '\n' && (await snapshot()).sent === baseline, id + ' 打开时 Shift+Enter 仍是原生换行');
    await page('document.getElementById(' + JSON.stringify(id) + ').classList.add("hidden")');
  }
  await setInput(prefix);
  await nativeKey('Return');
  await setInput('用户随后改成的新需求');
  await pause(420);
  check((await snapshot()).sent === baseline && (await snapshot()).value === '用户随后改成的新需求', '单回车等待时继续编辑会取消待发且保留新草稿');
  await setInput(prefix);
  await nativeKey('Return');
  await page('document.getElementById("input").blur()');
  await pause(420);
  check((await snapshot()).sent === baseline, '失焦取消待发，不在后台发送原文');
  await setInput(prefix);
  await nativeKey('Return');
  await page('(function repeat() { document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key:"Enter", repeat:true, bubbles:true, cancelable:true })); })()');
  await waitFor('predictionFixture.sent.length === ' + (baseline + 1));
  check(await page('predictionFixture.sent.at(-1).text === ' + JSON.stringify(prefix)), '长按自动重复不冒充双回车补全');
  baseline++;
  // 使用与刚发送原文不同的合法前缀，仅核对切换归属，不触发既有旧草稿识别规则。
  const switchPrefix = '整理一';
  await setInput(switchPrefix);
  await nativeKey('Return');
  await page('__composerPredictionTest.switchToTab(window.predictionAlternateTab)');
  await setInput('另一个会话的草稿');
  await pause(420);
  check((await snapshot()).sent === baseline && (await snapshot()).value === '另一个会话的草稿', '切换会话取消旧待发并隔离前台草稿');
  await page('__composerPredictionTest.switchToTab(window.predictionOriginalTab)');
  check((await snapshot()).value === switchPrefix, '切回原会话恢复自己的原输入');
  await setInput('');
  await nativeKey('Space');
  await page('__composerPredictionTest.switchToTab(window.predictionBlankTab)');
  await nativeKey('Space');
  check((await snapshot()).value === ' ', '跨会话的两个空格不能合并成双空格手势');
}

/**
 * 验证关闭自动保存后，真实提交的需求在关标签和重读历史后仍留在预测候选中。
 * 无参数；在隔离页面依次覆盖已有存档和未落盘会话，同编号来源只计一次。
 * 显式删除须清除候选，较新的磁盘摘要仍可更新候选；所有接口只操作本测试夹具。
 */
async function testClosedRequirementRetention() {
  await setInput('');
  await page('__composerPredictionTest.state.autoSave = false; window.predictionSaveBaseline = predictionFixture.saved.length; window.predictionDraftBaseline = predictionFixture.drafts.length');
  const scenarios = [
    { id: 'saved-other', text: '回归检查已有会话的新需求', saved: true },
    { text: '回归验证未落盘会话的新需求', saved: false }
  ];
  for (const scenario of scenarios) {
    if (scenario.saved) await page('__composerPredictionTest.openHistorySession(' + JSON.stringify(scenario.id) + ')');
    else await page('__composerPredictionTest.newTab()');
    const id = await page('__composerPredictionTest.state.activeTab');
    if (!scenario.saved) await page('window.predictionUnsavedTab = ' + JSON.stringify(id));
    await setInput(scenario.text);
    const baseline = (await snapshot()).sent;
    await nativeKey('Return');
    await waitFor('predictionFixture.sent.length === ' + (baseline + 1) + ' && !__composerPredictionTest.state.tabs.find(function tab(item) { return item.id === ' + JSON.stringify(id) + '; }).sending');
    await page('document.querySelector(\'[data-close="' + id + '"]\').click()');
    await waitFor('!__composerPredictionTest.state.tabs.some(function closed(item) { return item.id === ' + JSON.stringify(id) + '; })');
    await page('__composerPredictionTest.openHistory()');
    check(await page('!document.getElementById("modal").classList.contains("hidden")'), '关标签后实际打开历史窗口：' + scenario.text);
    check(await page('(function retained() { const sources = __composerPredictionTest.state.sessions.filter(function same(item) { return item.id === ' + JSON.stringify(id) + '; });'
      + 'return sources.length === 1 && sources[0].requirements.filter(function submitted(item) { return item.text === ' + JSON.stringify(scenario.text) + '; }).length === 1; })()'),
      '历史读取保留关闭标签的已提交需求且同会话不重复：' + scenario.text);
    if (!scenario.saved) check(await page('!document.querySelector(\'[data-sid="' + id + '"]\')'), '内存候选不会冒充磁盘历史记录');
    await page('document.getElementById("m-ok").click()');
    await setInput(Array.from(scenario.text).slice(0, 3).join(''));
    let result = await snapshot();
    check(!result.hidden && result.suffix === Array.from(scenario.text).slice(3).join(''), '关闭标签并重读历史后，真实输入框仍预测刚提交的需求：' + scenario.text);
    await page('__composerPredictionTest.loadComposerSessions();');
    check(await page('__composerPredictionTest.state.sessions.filter(function same(item) { return item.id === ' + JSON.stringify(id) + '; }).length === 1'), '重复读取历史不重复累计同会话来源：' + scenario.text);
  }
  check(await page('predictionFixture.saved.length === predictionSaveBaseline && predictionFixture.drafts.length === predictionDraftBaseline'), '关闭自动保存时，提交及关标签不写会话和草稿');
  await page('(function updateDisk() { const saved = predictionFixture.sessions.find(function same(item) { return item.id === "saved-other"; });'
    + 'saved.updatedAt = new Date(Date.now() + 60000).toISOString(); saved.requirements = [{ text: "回归检查磁盘新提交的需求", count: 2, lastIndex: 1 }]; })()');
  await page('__composerPredictionTest.loadComposerSessions()');
  await setInput('回归检');
  check((await snapshot()).suffix === '查磁盘新提交的需求', '较新的磁盘提交可更新同会话的旧预测摘要');
  await page('(async function remove() { window.confirm = function confirmFixtureDelete() { return true; }; await __composerPredictionTest.deleteConversation("saved-other", "测试历史"); await __composerPredictionTest.loadComposerSessions(); })()');
  await setInput('回归检');
  check((await snapshot()).hidden, '显式删除历史后不会复活该会话的预测候选');
  await setInput('回归验');
  check((await snapshot()).suffix === '证未落盘会话的新需求', '删除一个历史会话不丢失其他关闭标签的内存候选');
  await page('__composerPredictionTest.state.autoSave = true');
}

/** 通过生产发送和聊天事件验证子代理面板，记录可见状态和会话隔离。 */
async function testParallelPanel() {
  await page('predictionFixture.holdChat = true');
  await setInput('同时检查页面并验证游戏');
  await nativeKey('Return');
  await waitFor('predictionFixture.finishChat');
  await page(`/** 创建仍在发送的会话夹具，发布两个运行和两个排队的任务，并记录跨项目事件是否被隔离。 */
  (function prepareParallel() {
    const state = __composerPredictionTest.state;
    const tab = state.tabs.find(function current(item) { return item.id === state.activeTab; });
    window.testParallelTurn = { tab: tab.id, turnId: tab.liveTurnId, workspace: tab.workspace, tasks: [
      { goal: '核对浏览器 <b>标题</b>', resource: 'desktop', status: 'running' },
      { goal: '写小游戏并运行', resource: 'project', status: 'running' },
      { goal: '查看另一个窗口', resource: 'desktop', status: 'queued' },
      { goal: '检查设置页', resource: 'desktop', status: 'queued' }
    ] };
    document.getElementById('input').focus();
    emitFixtureChat({ type: 'agi_parallel', ...testParallelTurn, workspace: 'other-fixture' });
    window.crossProjectEventHidden = document.getElementById('agi-workbench').hidden;
    emitFixtureChat({ type: 'agi_parallel', ...testParallelTurn });
  })()`);
  const snapshot = await page(`(function readPanel() {
    const panel = document.getElementById('agi-workbench');
    const labels = [];
    for (const label of panel.querySelectorAll('.agi-workbench-state')) labels.push(label.textContent);
    return { visible: !panel.hidden && panel.getBoundingClientRect().height > 0,
      labels, count: panel.querySelector('[data-workbench-count]').textContent,
      focus: document.activeElement.id, containsMarkup: !!panel.querySelector('li b'),
      owner: panel.querySelector('[data-workbench-desktop] strong').textContent,
      waiting: panel.querySelector('[data-workbench-waiting]').textContent,
      belowChat: panel.previousElementSibling.classList.contains('chat-stage') };
  })()`);
  check(snapshot.visible && snapshot.count === '2 项运行中 · 共 4 项', '真实界面同时显示两项运行和两项排队');
  assert.deepEqual(snapshot.labels, ['使用桌面', '执行中', '等待桌面', '等待桌面']);
  check(snapshot.belowChat && snapshot.owner.includes('浏览器') && snapshot.waiting === '2 项等待',
    '独立工作台位于聊天区底部并显示前台拥有者与等待数');
  check(await page('crossProjectEventHidden'), '同轮编号携带其他项目时工作台拒绝显示');
  check(snapshot.focus === 'input' && !snapshot.containsMarkup, '面板标明桌面占用且保留输入焦点，目标文字按原文显示');
  // 等待一次实际绘制，再截取全窗和工作台近景，避免读取到更新前的合成帧。
  const bounds = await page(`new Promise(function painted(resolve) {
    requestAnimationFrame(function firstFrame() {
      requestAnimationFrame(function secondFrame() {
        const panel = document.getElementById('agi-workbench');
        const rect = panel.getBoundingClientRect();
        resolve({ x: Math.floor(rect.x), y: Math.floor(rect.y),
          width: Math.ceil(rect.right) - Math.floor(rect.x), height: Math.ceil(rect.bottom) - Math.floor(rect.y) });
      });
    });
  })`);
  const panelImage = await win.webContents.capturePage(bounds);
  check(!panelImage.isEmpty() && panelImage.getSize().height >= bounds.height, '实际绘制的工作台可截取为独立画面');
  fs.writeFileSync(path.join(output, 'agi-workbench-detail.png'), panelImage.toPNG());
  fs.writeFileSync(path.join(output, 'agi-workbench.png'), (await win.webContents.capturePage()).toPNG());
  await page('__composerPredictionTest.state.workspace = "other-fixture"; __composerPredictionTest.newTab()');
  check(await page('document.getElementById("agi-workbench").hidden'), '切到另一项目不显示原项目的子代理');
  await page(`/** 在发起会话处于后台时发布任务进展，覆盖完成、受阻、接手桌面和停止四种状态。 */
  (function backgroundProgress() {
    testParallelTurn.tasks[0].status = 'completed';
    testParallelTurn.tasks[0].result = '已核对浏览器标题。';
    testParallelTurn.tasks[1].status = 'blocked';
    testParallelTurn.tasks[1].result = '缺少关卡 <b>入口</b>。';
    testParallelTurn.tasks[2].status = 'running';
    testParallelTurn.tasks[3].status = 'interrupted';
    testParallelTurn.tasks[3].result = '用户已补充或停止。';
    emitFixtureChat({ type: 'agi_parallel', ...testParallelTurn });
  })()`);
  assert.equal(await page('document.getElementById("agi-workbench").hidden'), true);
  await page('__composerPredictionTest.switchToTab(testParallelTurn.tab)');
  const handoff = await page(`/** 读取切回后可见的活动卡片、桌面占用和回执，并统计停止条目供断言。 */
  (function inspectHandoff() {
    const panel = document.getElementById('agi-workbench');
    const cards = panel.querySelectorAll('.agi-workbench-card');
    const blocked = panel.querySelector('.agi-workbench-receipt[data-status="blocked"]');
    return { count: panel.querySelector('[data-workbench-count]').textContent,
      cards: cards.length, active: cards[0].querySelector('.agi-workbench-goal').textContent,
      owner: panel.querySelector('[data-workbench-desktop] strong').textContent,
      completed: panel.querySelector('.agi-workbench-receipt[data-status="completed"] .agi-workbench-result').textContent,
      blocked: blocked.querySelector('.agi-workbench-result').textContent,
      stoppedItems: panel.querySelectorAll('[data-status="interrupted"]').length,
      blockedMarkup: !!blocked.querySelector('b'),
      receiptVisible: blocked.getBoundingClientRect().height > 0 };
  })()`);
  check(handoff.cards === 1 && handoff.active === '查看另一个窗口' && handoff.owner === handoff.active &&
    handoff.count === '1 项运行中 · 共 1 项', '关闭的子代理逐个退出活动区，剩余代理接手前台并单独计数');
  check(handoff.completed === '已核对浏览器标题。' && handoff.blocked === '缺少关卡 <b>入口</b>。' &&
    !handoff.blockedMarkup && handoff.receiptVisible, '完成回执和受阻原因在发起项目中可见，回执按纯文本显示');
  check(handoff.stoppedItems === 0, '已暂停的子代理立即退出工作台，剩余子代理继续显示');
  // 等待合成器绘制后记录有受阻原因的工作台实景。
  await page('new Promise(function repaint(resolve) { requestAnimationFrame(function first() { requestAnimationFrame(resolve); }); })');
  const receiptImage = await win.webContents.capturePage();
  assert.ok(!receiptImage.isEmpty());
  fs.writeFileSync(path.join(output, 'agi-workbench-receipts.png'), receiptImage.toPNG());
  await page(`(function closeLastBranch() {
    testParallelTurn.tasks[2].status = 'interrupted';
    testParallelTurn.tasks[2].result = '用户已补充或停止。';
    emitFixtureChat({ type: 'agi_parallel', ...testParallelTurn });
  })()`);
  check(await page(`/** 检查主会话仍在发送时，工作台是否隐藏、退出布局并清空卡片与回执。 */
  (function inspectClosedPanel() {
    const panel = document.getElementById('agi-workbench');
    /**
     * 按会话 ID 识别发起本轮并行任务的会话。
     * @param {object} item 当前参与查找的候选会话。
     * @returns {boolean} 候选会话是本轮发起会话时返回 true，否则返回 false。
     */
    function source(item) {
      return item.id === testParallelTurn.tab;
    }
    const tab = __composerPredictionTest.state.tabs.find(source);
    return tab.sending && panel.hidden && getComputedStyle(panel).display === 'none' &&
      panel.getBoundingClientRect().height === 0 && !panel.querySelector('.agi-workbench-card, .agi-workbench-receipt');
  })()`), '最后一个子代理停止后立即收起工作台，主会话仍在运行');
  // 等待实际绘制后保存工作台收起的聊天界面。
  await page('new Promise(function repaint(resolve) { requestAnimationFrame(function first() { requestAnimationFrame(resolve); }); })');
  const closedImage = await win.webContents.capturePage();
  assert.ok(!closedImage.isEmpty());
  fs.writeFileSync(path.join(output, 'agi-workbench-closed.png'), closedImage.toPNG());

  await page('predictionFixture.holdChat = false; predictionFixture.finishChat()');
  await waitFor('document.getElementById("agi-workbench").hidden');
  check(await page('document.querySelector("[data-workbench-tasks]").childElementCount === 0 && document.querySelector("[data-workbench-receipts]").childElementCount === 0'), '本轮结束后清空活动卡片和回执');
}

/** 创建隔离副本、执行完整页面测试并保存截图与可追溯报告。 */
async function main() {
  fs.cpSync(path.join(root, 'renderer'), rendererCopy, { recursive: true });
  fs.mkdirSync(path.join(output, 'electron', 'lib'), { recursive: true });
  fs.copyFileSync(path.join(root, 'electron', 'lib', 'image-gen-options.js'), path.join(output, 'electron', 'lib', 'image-gen-options.js'));
  fs.appendFileSync(path.join(rendererCopy, 'app.js'), '\nwindow.__composerPredictionTest = { state, newTab, switchToTab, composerPrediction, refreshComposerRequirements, refreshComposerPrediction, loadComposerSessions, openHistory, openHistorySession, deleteConversation };\n', 'utf8');
  await app.whenReady();
  win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: '(' + fixtureSetup.toString() + ')()' });
  await win.loadFile(path.join(rendererCopy, 'index.html'));
  win.showInactive();
  await waitFor('window.__composerPredictionTest && !document.getElementById("view-chat").classList.contains("hidden") && document.querySelector("#tabs .tab")');
  await waitFor('document.getElementById("input-prediction")?.querySelector(".composer-prediction-suffix")?.textContent');
  await testRanking();
  await testPresentation();
  await testRealtimeInput();
  await testGestures();
  await testAsyncCandidates();
  await testIsolation();
  await testClosedRequirementRetention();
  await testParallelPanel();
  await setInput(prefix);
  evidence.errors = await page('predictionFixture.errors');
  check(evidence.errors.length === 0, '完整 HTML、输入绑定、草稿和发送链路没有页面异常');
  fs.writeFileSync(path.join(output, 'prediction.png'), (await win.webContents.capturePage()).toPNG());
  const composerRect = await page('(function bounds() { const rect = document.getElementById("composer").getBoundingClientRect();'
    + 'return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) }; })()');
  fs.writeFileSync(path.join(output, 'composer.jpg'), (await win.webContents.capturePage(composerRect)).toJPEG(60));
  evidence.images = { fullPage: 'prediction.png', composer: 'composer.jpg' };
  evidence.totalChecks = checks;
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2), 'utf8');
  console.log('RESULT ' + JSON.stringify({ failures: 0, checks, output }));
  finish(0);
}

/** 仅结束本脚本自己的窗口，保留测试副本与验收证据。 */
function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (win && !win.isDestroyed()) win.destroy();
  app.exit(code);
}

/** 失败输出原始堆栈并保存已完成断言；非零状态不会被运行结束掩盖。 */
function failed(error) {
  console.error(error.stack || error);
  evidence.failure = error.stack || String(error);
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(evidence, null, 2), 'utf8');
  finish(1);
}
main().catch(failed);
