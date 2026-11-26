/**
 * 使用真实 Chromium DOM 和主进程会话 IPC 验证项目打开、逐帧绘制、草稿保存。
 * 磁盘操作仅作用于 generated 内的独立测试目录，不连接模型或修改用户会话。
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
// 允许同一套真实 DOM 断言直接加载发布包中的页面和脚本。
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8').split('\r\n').join('\n');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
let checks = 0;
// 专项之间会销毁独立窗口，最后由断言结果统一结束 Electron。
app.on('window-all-closed', function keepTestsAlive() {});
setTimeout(function testTimeout() { failed(new Error('专项验收超时')); }, 20000);

/** 提取真实顶层函数；缺少边界直接让验收失败。 */
function functionSource(signature) {
  const start = source.indexOf(signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, signature);
  return source.substring(start, end + 3);
}

/** 输出断言证据；失败中止后续验收。 */
function check(value, message) { assert.ok(value, message); checks++; console.log('PASS ' + message); }

/** 执行真实会话处理器，核对并发保存、旧存档、输入清空与删除。 */
async function testSessions() {
  fs.mkdirSync(path.join(root, 'generated'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'generated', 'ui-performance-'));
  const handlers = {};
  function handle(name, fn) { handlers[name] = fn; }
  function sessionDir() { return dir; }
  function dependency(name) {
    assert.equal(name, './lib/session-composer');
    return require('../electron/lib/session-composer');
  }
  const start = mainSource.indexOf('const sessionMetaCache = new Map();');
  const end = mainSource.indexOf('const restartReview =', start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(mainSource.substring(start, end), { fs, path, process, ipcMain: { handle }, sessionDir, require: dependency, console,
    distillSubmittedRequirements: require('../electron/lib/composer-requirements').distillSubmittedRequirements });
  const full = { id: 'history', title: '测试对话', workspace: 'fixture', messages: [
    { role: 'user', text: '原始消息' }, { role: 'assistant', text: '历史正文'.repeat(400000) }
  ], composer: { text: '旧草稿' } };
  await handlers['sessions:save']({}, full);
  const file = path.join(dir, 'history.json');
  const before = fs.readFileSync(file);
  const statBefore = fs.statSync(file);
  const draft = { id: full.id, title: full.title, workspace: full.workspace, composer: {
    text: '新草稿', attachments: [{ path: 'fixture.png', name: 'fixture.png' }], contextPaths: ['source.js'], skillIds: ['zabingsk']
  } };
  await handlers['sessions:saveComposer']({}, draft);
  check(fs.statSync(file).mtimeMs === statBefore.mtimeMs && fs.readFileSync(file).equals(before), '草稿不改写整份历史文件');
  const draftBytes = fs.statSync(path.join(dir, 'drafts/history.json')).size;
  check(draftBytes < 1024 && before.length > 4000000, '数 MB 历史的草稿写入小于 1KB');
  const loaded = await handlers['sessions:load']({}, 'history');
  check(loaded.composer.text === '新草稿' && loaded.messages[1].text === full.messages[1].text, '重开恢复最新草稿并保留完整历史');
  check(loaded.composer.attachments[0].path === 'fixture.png' && loaded.composer.contextPaths[0] === 'source.js', '草稿附件和引用状态保留');
  const a = handlers['sessions:save']({}, { ...full, composer: null });
  const b = handlers['sessions:saveComposer']({}, { ...draft, composer: { text: '发送后继续输入' } });
  await Promise.all([a, b]);
  check((await handlers['sessions:load']({}, 'history')).composer.text === '发送后继续输入', '完整保存与后续输入重叠时保留新草稿');
  await handlers['sessions:save']({}, { ...full, composer: null });
  check((await handlers['sessions:load']({}, 'history')).composer === null, '发送清空后不恢复旧草稿');
  await handlers['sessions:saveComposer']({}, draft);
  check((await handlers['sessions:list']({})).find(function find(x) { return x.id === 'history'; }).hasComposer, '列表识别独立草稿');
  await handlers['sessions:saveComposer']({}, { ...draft, composer: null });
  check(!(await handlers['sessions:list']({})).find(function find(x) { return x.id === 'history'; }).hasComposer, '列表同步草稿清空状态');
  await fs.promises.writeFile(path.join(dir, 'legacy.json'), JSON.stringify({ id: 'legacy', messages: [], composer: { text: '旧版草稿' } }));
  check((await handlers['sessions:load']({}, 'legacy')).composer.text === '旧版草稿', '旧存档保留原有草稿');
  const broken = Buffer.alloc(147);
  await fs.promises.writeFile(path.join(dir, 'drafts/history.json'), broken);
  await fs.promises.writeFile(path.join(dir, 'drafts/zeroed.json'), broken);
  await fs.promises.writeFile(path.join(dir, 'zeroed.json'), broken);
  const afterCrash = await handlers['sessions:list']({});
  check(afterCrash.some(item => item.id === 'history') && !afterCrash.some(item => item.id === 'zeroed'),
    '掉电清零的草稿或正文不阻塞会话列表');
  const reopened = await handlers['sessions:load']({}, 'history');
  check(reopened.messages[0].text === full.messages[0].text && reopened.composer === null &&
    fs.readFileSync(path.join(dir, 'drafts/history.json')).equals(broken),
    '对话仍能打开，坏草稿留在磁盘供恢复');
  const writing = handlers['sessions:saveComposer']({}, draft);
  await handlers['sessions:delete']({}, 'history');
  await writing;
  check(!fs.existsSync(file) && !fs.existsSync(path.join(dir, 'drafts/history.json')), '删除会话等待在途草稿，旧输入不会复活');
  console.log('METRIC ' + JSON.stringify({ historyBytes: before.length, draftBytes }));
}

/** 为真实函数安装可计数的事件调度与项目资料依赖，消息和输入使用真实 DOM。 */
function rendererSetup() {
  const assistant = { role: 'assistant', text: '流式文字'.repeat(100), revealLen: 0 };
  const tab = { id: 'a', title: '测试', workspace: 'fixture', messages: [{ role: 'user', text: '历史'.repeat(1000000) }, assistant], liveAssistant: assistant };
  const state = { autoSave: true, activeTab: 'a', workspace: 'fixture', tabs: [tab], attachments: [], contextPaths: [], typewriterRaf: null };
  const metrics = { fullPaints: 0, fullSaves: 0, savedDraft: null, pendingMeta: [], chatShown: false, applied: false, historyRenders: 0, treeLoads: 0 };
  const frames = new Map();
  let frameId = 0;
  function $(id) { return document.getElementById(id); }
  function activeSession() { return tab; }
  function skillStack() { return []; }
  function prefersReducedMotion() { return false; }
  function renderMarkdown(text) { return text; }
  function paintLiveAssistant() { metrics.fullPaints++; }
  function persistTab() { metrics.fullSaves++; return Promise.resolve(); }
  function requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; }
  function flushFrames() {
    let count = 0;
    while (frames.size && count < 2000) {
      const entry = frames.entries().next().value;
      frames.delete(entry[0]); entry[1](); count++;
    }
    return count;
  }
  function delayed(name) {
    return new Promise(function wait(resolve) { metrics.pendingMeta.push({ name, resolve }); });
  }
  const api = {
    saveComposer: function saveComposer(draft) { metrics.savedDraft = structuredClone(draft); return Promise.resolve(true); },
    setWorkspace: async function setWorkspace(ws) { return ws; },
    listSkills: function listSkills() { return delayed('skills'); },
    listRules: function listRules() { return delayed('rules'); },
    listSnapshots: function listSnapshots() { return delayed('snapshots'); },
    listMilestones: function listMilestones() { return delayed('milestones'); },
    getGlobalMemory: function getGlobalMemory() { return delayed('memory'); },
    getSnapshotMax: function getSnapshotMax() { return delayed('max'); }
  };
  function sameWorkspace(a,b) { return a === b; }
  function setWorkspace(ws) { state.workspace = ws; }
  async function persistSession() {}
  function showChat() { metrics.chatShown = true; }
  function applyTabContext() { metrics.applied = true; }
  async function restoreLastSession() { throw new Error('已存在标签不应重载历史'); }
  function newTab() { throw new Error('不应创建额外标签'); }
  function noOp() {}
  function renderMessages() { metrics.historyRenders++; }
  function loadFileTree() { metrics.treeLoads++; return Promise.resolve(); }
  Object.assign(window, { $, activeSession, skillStack, prefersReducedMotion, renderMarkdown, paintLiveAssistant,
    persistTab, requestAnimationFrame, flushFrames, api, sameWorkspace, setWorkspace, persistSession,
    showChat, applyTabContext, restoreLastSession, newTab, state, metrics, frames, assistant, tab,
    revealingMsgs: new WeakSet(), composerTimer: null, composerPrediction: null, composerSessionsLoaded: false,
    renderTabs: noOp, renderQueue: noOp, syncSendBtn: noOp, renderSidebar: noOp, syncAgentBtn: noOp, loadFileTree, renderMessages });
}

/** 验证大历史输入载荷、停止空转、新片段续播和加载期间继续输入。 */
async function rendererTests() {
  const passed = [];
  function check(value, name) { if (!value) throw new Error(name); passed.push(name); }
  $('input').value = '用户正在输入';
  await saveComposerDraft();
  check(metrics.savedDraft.composer.text === '用户正在输入' && !Object.hasOwn(metrics.savedDraft, 'messages') && metrics.fullSaves === 0, '大对话输入不传消息数组');
  const payloadBytes = new Blob([JSON.stringify(metrics.savedDraft)]).size;
  check(payloadBytes < 1024, '输入 IPC 载荷小于 1KB');
  state.autoSave = false; metrics.savedDraft = null;
  await saveComposerDraft();
  check(metrics.savedDraft === null, '自动保存关闭时不写草稿');
  state.autoSave = true;
  const history = tab.messages; tab.messages = [];
  await saveComposerDraft();
  check(metrics.fullSaves === 1, '新空对话仍保存模型与附加目录设置');
  tab.messages = history;
  ensureTypewriter();
  check(flushFrames() > 1 && assistant.revealLen === assistant.text.length, '逐字动画完整显示正文');
  check(metrics.fullPaints === 0 && $('messages').textContent === assistant.text, '逐帧只写真实气泡');
  check(frames.size === 0 && state.typewriterRaf === null, '文字追上后停止帧循环');
  assistant.text += '后续片段'; ensureTypewriter(); flushFrames();
  check($('messages').textContent === assistant.text, '新片段到达后继续动画');
  const opening = openProject('fixture');
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  check(metrics.chatShown && metrics.applied && metrics.pendingMeta.length === 6, '六项侧栏资料并行等待时已显示对话');
  $('input').value = '加载侧栏期间继续打字';
  for (const query of metrics.pendingMeta) query.resolve(query.name === 'max' ? 20 : []);
  await opening;
  check($('input').value === '加载侧栏期间继续打字' && metrics.historyRenders === 1 && metrics.treeLoads === 1,
    '资料返回不覆盖输入，不再次重绘历史');
  return { passed, payloadBytes };
}

/** 在独立 Chromium 页面中装载真实项目函数。 */
async function testRenderer() {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadURL('data:text/html,<textarea id="input"></textarea><div id="slash-menu" class="hidden"></div><div id="at-menu" class="hidden"></div><div id="messages"><div class="msg assistant" data-msg-i="1"><div class="bubble"></div></div></div>');
    await win.webContents.executeJavaScript('(' + rendererSetup.toString() + ')()');
    const signatures = ['function collectComposer()', 'function hasComposerContent(c)', 'function rememberComposer(tab)',
      'function saveComposerDraft()', 'function refreshComposerPrediction(cancelPending = false)',
      'function refreshComposerRequirements()', 'async function loadComposerSessions()', 'function onInput()',
      'function typeStep(behind)', 'function paintRevealBubble(msg, done)',
      'function ensureTypewriter()', 'async function openProject(dir)', 'async function showProjectSession(ws)',
      'async function refreshMeta()', 'async function loadMilestones()', 'async function loadGlobalMemory()', 'async function loadSnapshotMax()'];
    for (const signature of signatures) await win.webContents.executeJavaScript(functionSource(signature));
    const result = await win.webContents.executeJavaScript('(' + rendererTests.toString() + ')()');
    for (const message of result.passed) check(true, message);
    console.log('METRIC ' + JSON.stringify({ inputIpcBytes: result.payloadBytes }));
  } finally { win.destroy(); }
}

/** 注入完整页面的本地 API，所有模型和磁盘返回均使用测试数据。 */
function fullPageSetup() {
  localStorage.setItem('spcode.onboarding.completed', 'true');
  const record = { errors: [], drafts: [], requests: [], fullSaves: 0, stream: '', turnId: '', resolveTurn: null };
  function noOp() {}
  async function emptyList() { return []; }
  async function nullValue() { return null; }
  const api = {
    // 完整页面启动会把旧版 localStorage 标记迁移到设置；测试 API 同步提供保存入口。
    completeOnboarding: async function completeOnboarding() { return true; },
    getState: async function getState() { return { locale: 'zh', theme: 'dark', resolvedTheme: 'dark', autoSave: true,
      workspace: 'fixture', models: [{ id: 'fixture', name: '测试模型', type: 'api', model: 'fixture' }],
      currentModelId: 'fixture', providers: [], videoProviderModels: [], recents: [], localFiles: [], assemblies: {}, capabilityDefaults: {} }; },
    listSkills: emptyList, listRules: emptyList, listSnapshots: emptyList, listMilestones: emptyList,
    loadPersona: nullValue, getGlobalMemory: nullValue, getSnapshotMax: async function getSnapshotMax() { return 20; },
    listChildren: emptyList, loadSessions: emptyList,
    // 模型保存回包同步包含厂商派生的视频候选，夹具遵循真实 IPC 契约。
    saveModels: async function saveModels() { return { videoProviderModels: [] }; },
    onChatEvent: function onChatEvent(callback) { window.emitTestChat = callback; },
    onFloatUserMessage: function onFloatUserMessage(callback) { window.emitFloatMessage = callback; },
    chatInterject: function chatInterject() { throw new Error('整合需求不应调用实时插话接口'); },
    onWorkspaceChanged: noOp, onUiRefresh: noOp, onDownloadProgress: noOp, onIndexProgress: noOp,
    onHotReload: function onHotReload() { return noOp; }, hotReloadStatus: nullValue,
    // 余额同步是新增的主窗桥接口，完整页面夹具同步提供入口。
    reportAccountQuota: noOp,
    // 设置页会读忽略索引目录，夹具补上空列表，避免打开设置时抛未处理拒绝。
    indexGetIgnoredFolders: emptyList,
    // 保存模型后界面会刷新厂商余额条，夹具明确返回「不可用」，不连真实接口。
    fetchAccountBalance: async function fetchAccountBalance() { return { available: false }; },
    floatBind: noOp, floatForget: noOp, floatCanStart: noOp, logSummaryTrace: noOp,
    reportError: function reportError(stage, details) {
      if (stage === '界面脚本报错' || stage === '界面未处理的 Promise 拒绝') record.errors.push({ stage, details });
    },
    /** 记录当前测试轮的会话保存回执，供核对三段回复的原文。 */
    saveSession: async function saveSession(session) {
      record.fullSaves++;
      record.savedAssistant = session.messages.find(function current(message) { return message.turnId === record.turnId; });
      return true;
    },
    saveComposer: async function saveComposer(draft) { record.drafts.push(draft); return true; },
    chatRestoreConsumed: noOp, stageTurnWindow: noOp,
    chatSend: function chatSend(payload) {
      record.requests.push(payload);
      record.turnId = payload.turnId;
      record.tabId = payload.tabId;
      return new Promise(function pending(resolve) { record.resolveTurn = resolve; });
    },
    contextPreview: async function contextPreview() { return {}; }
  };
  window.simple = api;
  window.fullPageRecord = record;
}

/** 加载完整 HTML/CSS/ES 模块，以 Chromium 原生字符事件验证流式期间持续输入。 */
async function testFullPage() {
  const win = new BrowserWindow({ show: false, width: 1280, height: 840, webPreferences: { backgroundThrottling: false } });
  try {
    console.log('STAGE full-page create');
    await win.loadURL('about:blank');
    win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Page.enable');
    console.log('STAGE full-page debugger ready');
    await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: '(' + fullPageSetup.toString() + ')()' });
    await win.loadFile(path.join(root, 'renderer/index.html'));
    console.log('STAGE full-page loaded');
    win.showInactive();
    const ready = await win.webContents.executeJavaScript('(' + async function waitForInit() {
      for (let i = 0; i < 100; i++) {
        if (!document.getElementById('view-chat').classList.contains('hidden') && document.querySelector('#tabs .tab')) return true;
        await new Promise(function wait(resolve) { setTimeout(resolve, 20); });
      }
      return { errors: window.fullPageRecord?.errors, build: window.__APP_BUILD };
    }.toString() + ')()');
    check(ready === true, '完整 HTML、样式和模块初始化并显示项目对话');
    await win.webContents.executeJavaScript('(' + async function startFixtureTurn() {
      const input = document.getElementById('input');
      input.value = '测试流式期间输入';
      document.getElementById('btn-send').click();
      for (let i = 0; i < 100 && !fullPageRecord.turnId; i++) {
        await new Promise(function wait(resolve) { setTimeout(resolve, 10); });
      }
      if (!fullPageRecord.turnId) throw new Error('真实发送入口未进入本地测试模型');
      const record = fullPageRecord;
      record.mutations = 0;
      const role = document.querySelector('.msg.assistant .role');
      record.observer = new MutationObserver(function changed(list) { record.mutations += list.length; });
      record.observer.observe(role, { childList: true, subtree: true });
      record.timer = setInterval(function stream() {
        record.stream += '继续输出文字';
        emitTestChat({ type: 'text', turnId: record.turnId, text: '继续输出文字' });
      }, 25);
      input.focus();
    }.toString() + ')()');
    const typed = 'native-input-'.repeat(10);
    for (const ch of typed) win.webContents.sendInputEvent({ type: 'char', keyCode: ch });
    const result = await win.webContents.executeJavaScript('(' + async function verifyInput() {
      await new Promise(function wait(resolve) { setTimeout(resolve, 750); });
      const record = fullPageRecord;
      clearInterval(record.timer);
      const input = document.getElementById('input');
      const value = input.value;
      const drafts = record.drafts.length;
      const turn = record.turnId;
      emitTestChat({ type: 'done', turnId: turn, text: record.stream });
      record.resolveTurn({ text: record.stream, changes: [] });
      // 保留产品的逐字补完效果，等待可见气泡追上最终正文再验收。
      for (let i = 0; i < 200; i++) {
        if (document.querySelector('.msg.assistant .bubble')?.textContent === record.stream) break;
        await new Promise(function wait(resolve) { setTimeout(resolve, 25); });
      }
      record.observer.disconnect();
      return { value, drafts, errors: record.errors, mutations: record.mutations,
        bubble: document.querySelector('.msg.assistant .bubble')?.textContent, stream: record.stream };
    }.toString() + ')()');
    check(result.value === typed && result.drafts > 0, '完整页面流式输出时原生连续输入无丢字且草稿已保存');
    check(result.bubble === result.stream && result.stream.length > 0, '真实事件链结束后完整展示最终回复');
    assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
    check(true, '完整页面初始化与输入无脚本异常');
    const batches = await win.webContents.executeJavaScript('(' + async function verifyIntegratedQueue() {
      const record = fullPageRecord;
      const input = document.getElementById('input');
      const enqueue = document.getElementById('btn-enqueue');
      const firstIndex = record.requests.length;
      /** 等待生产发送入口到达指定轮次，出现多余请求立即失败。 */
      async function waitForTurn(count) {
        for (let i = 0; i < 100; i++) {
          if (record.requests.length >= count) {
            if (record.requests.length !== count) throw new Error('出现额外模型请求');
            return;
          }
          await new Promise(function wait(resolve) { setTimeout(resolve, 20); });
        }
        throw new Error('未启动下一轮整合需求');
      }
      /** 通过真实按钮提交一条主窗需求。 */
      function submit(text) {
        input.value = text;
        enqueue.click();
      }
      /**
       * 发出当前轮的最终事件，主进程回执仍可延后。
       * @param {string} text 当前轮显示的最终答复。
       * @param {boolean} taskSettled 当前任务是否完成。
       * @returns {void} 事件交给真实页面处理。
       */
      function showDone(text, taskSettled = true) {
        emitTestChat({ type: 'done', turnId: record.turnId, text, taskSettled });
      }
      /**
       * 兑现当前轮发送入口等待的主进程回执。
       * @param {string} text 当前轮的最终答复。
       * @param {boolean} taskPending 当前任务是否还要继续。
       * @returns {void} 恢复发送流程。
       */
      function endTurn(text, taskPending = false) { record.resolveTurn({ text, changes: [], taskPending }); }
      /** 从真实队列 DOM 取还未送入模型的文本。 */
      function pendingText() { return document.getElementById('queue').textContent; }

      input.value = '原始任务';
      document.getElementById('btn-send').click();
      await waitForTurn(firstIndex + 1);
      const button = enqueue.textContent;
      submit('主窗第一条');
      emitFloatMessage({ tabId: record.tabId, text: '浮窗第二条', images: ['../icons.png'], attachments: [{ name: '参考图.png', path: 'icons.png' }] });
      submit('主窗第三条');
      const pendingFirst = pendingText();
      showDone('原始任务已完成');
      await new Promise(function settlePaint(resolve) { setTimeout(resolve, 50); });
      const noEarlyRequest = record.requests.length === firstIndex + 1;
      endTurn('原始任务已完成');
      await waitForTurn(firstIndex + 2);
      const firstBatch = record.requests[firstIndex + 1];
      const queueDrained = !pendingText();
      submit('执行期间第四条');
      submit('执行期间第五条');
      const pendingNext = pendingText();
      const noExtraRequest = record.requests.length === firstIndex + 2;
      showDone('第一批验收受阻', false);
      endTurn('第一批验收受阻', true);
      await new Promise(function settlePaint(resolve) { setTimeout(resolve, 50); });
      if (record.requests.length !== firstIndex + 2) throw new Error('未完成回执触发了下一批整合需求');
      const pausedQueue = pendingText();
      emitFloatMessage({ tabId: record.tabId, text: '浮窗等待第六条', images: [], attachments: [] });
      submit('主窗等待第七条');
      document.getElementById('btn-send').click();
      await new Promise(function settlePaint(resolve) { setTimeout(resolve, 50); });
      if (record.requests.length !== firstIndex + 2) throw new Error('追加需求或空发送提前解锁队列');
      const pausedAdditions = pendingText();
      input.value = '继续';
      document.getElementById('btn-send').click();
      await waitForTurn(firstIndex + 3);
      const continuation = record.requests[firstIndex + 2];
      showDone('还有待办未完成', false);
      endTurn('还有待办未完成', true);
      await new Promise(function settlePaint(resolve) { setTimeout(resolve, 50); });
      if (record.requests.length !== firstIndex + 3 || pendingText() !== pausedAdditions) {
        throw new Error('重试仍有待办时改变了待发队列');
      }
      input.value = '继续';
      document.getElementById('btn-send').click();
      await waitForTurn(firstIndex + 4);
      showDone('第一批整合完成');
      endTurn('第一批整合完成');
      await waitForTurn(firstIndex + 5);
      const nextBatch = record.requests[firstIndex + 4];
      showDone('第二批整合完成');
      endTurn('第二批整合完成');
      return { button, pendingFirst, noEarlyRequest, firstBatch, queueDrained, pendingNext, noExtraRequest,
        pausedQueue, pausedAdditions, continuation, nextBatch, errors: record.errors };
    }.toString() + ')()');
    assert.equal(batches.button, '整合需求');
    assert.match(batches.pendingFirst, /主窗第一条[\s\S]*浮窗第二条[\s\S]*主窗第三条/);
    assert.ok(batches.noEarlyRequest && batches.queueDrained);
    assert.match(batches.firstBatch.text, /【整合需求 1】\n主窗第一条[\s\S]*【整合需求 2】\n浮窗第二条[\s\S]*参考图\.png[\s\S]*【整合需求 3】\n主窗第三条/);
    assert.equal(batches.firstBatch.attachments[0].path, 'icons.png');
    assert.ok(batches.firstBatch.history.some(function previous(message) { return message.role === 'assistant' && message.content === '原始任务已完成'; }));
    check(true, '原轮完成回执后才发送首批整合，保留主窗和悬浮窗提交顺序及附件');
    assert.ok(batches.noExtraRequest);
    assert.match(batches.pendingNext, /执行期间第四条[\s\S]*执行期间第五条/);
    assert.equal(batches.pausedQueue, batches.pendingNext);
    assert.match(batches.pausedAdditions, /执行期间第四条[\s\S]*执行期间第五条[\s\S]*浮窗等待第六条[\s\S]*主窗等待第七条/);
    assert.equal(batches.continuation.text, '继续');
    assert.match(batches.nextBatch.text, /【整合需求 1】\n执行期间第四条[\s\S]*【整合需求 2】\n执行期间第五条[\s\S]*【整合需求 3】\n浮窗等待第六条[\s\S]*【整合需求 4】\n主窗等待第七条/);
    check(true, '验收受阻或还有待办时保留整合队列，当前任务续做通过后才按序发送');
    assert.doesNotMatch(batches.nextBatch.text, /主窗第一条|浮窗第二条|主窗第三条/);
    assert.notEqual(batches.nextBatch.turnId, batches.firstBatch.turnId);
    assert.equal(batches.errors.length, 0, JSON.stringify(batches.errors));
    check(true, '整合任务执行期间的新需求组成下一批，当前模型请求不被续接打断');
    console.log('METRIC ' + JSON.stringify({ nativeInputCharacters: typed.length, streamCharacters: result.stream.length, roleMutations: result.mutations }));
  } finally {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
    win.destroy();
  }
}

/** 断言决定最终退出状态，运行结束本身不代表通过。 */
async function main() {
  await app.whenReady();
  await testSessions();
  await testRenderer();
  await testFullPage();
  console.log('RESULT ' + JSON.stringify({ failures: 0, checks }));
  app.exit(0);
}

/** 失败保留堆栈并非零退出。 */
function failed(error) { console.error(error.stack || error); app.exit(1); }
main().catch(failed);
