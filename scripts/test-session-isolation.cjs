'use strict';

// 使用真实渲染层函数和受控异步回执复现同窗口历史切换；不启动模型、不还原真实文件。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const passed = [];

/**
 * 从生产文件读取完整顶层函数，用实际实现而非重新实现的副本接受测试。
 * @param {string} name 顶层函数名。
 * @returns {string} 从声明到下一顶层声明之间的源码；定位失败直接抛出断言。
 */
function production(name) {
  let start = source.indexOf('async function ' + name + '(');
  if (start < 0) start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, '缺少生产函数 ' + name);
  const normal = source.indexOf('\nfunction ', start + 1);
  const asynchronous = source.indexOf('\nasync function ', start + 1);
  const end = Math.min(normal < 0 ? source.length : normal, asynchronous < 0 ? source.length : asynchronous);
  return source.substring(start, end);
}

/** 创建可人工交付的异步回执；返回 promise 和 resolve，测试无需真实计时等待。 */
function deferred() {
  const result = {};
  result.promise = new Promise(function capture(resolve) { result.resolve = resolve; });
  return result;
}

/** 记录通过的行为断言；name 是报告标题，condition 为实际执行结果，失败立即中止。 */
function check(name, condition) {
  assert.ok(condition, name);
  passed.push(name);
  console.log('PASS ' + name);
}

/** 测试用空副作用；返回 undefined，避免无关界面渲染和磁盘操作。 */
function noop() {}

/**
 * 构建隔离的渲染环境，保留真实会话、发送、持久化和停止目标逻辑。
 * @returns {object} VM 上下文、输入控件、请求与持久化快照；所有外部模型及快照恢复均为桩。
 */
function harness() {
  const input = { value: '' };
  const messages = { scrollTop: 0 };
  const writes = new Map();
  const requests = [];
  const events = [];
  const cancellations = [];
  const loads = [];
  let sequence = 0;
  const state = {
    tabs: [], activeTab: null, tabNavigationId: 0, workspace: 'project', autoSave: true,
    attachments: [], contextPaths: [], currentModelId: 'model',
    refillFromIndex: null, refillRevertFiles: false, typewriterRaf: null
  };
  const context = {
    state, console, Date, Map, Set, composerTimer: null, revealingMsgs: new Set(),
    $: function element(id) { return id === 'input' ? input : messages; },
    t: function translate(key) { return key; },
    uid: function identifier() { sequence += 1; return 'turn-' + sequence; },
    normalizeSkillIds: function skills(item) { return item.skillIds || []; },
    submittedTextHistory: function submitted(tab) { return tab.submittedTextHistory || []; },
    settleDeadTurns: function settled(list) { return list || []; },
    emptyContext: function contextValue() { return { skillIds: [], contextPaths: [], attachments: [] }; },
    emptyWorkingMemory: function memoryValue() { return { todos: [] }; },
    clampAgentRounds: function rounds(value) { return value; },
    skillStack: function selectedSkills() { return []; },
    extraFoldersOf: function folders(tab) { return tab.extraFolders || []; },
    hasComposerContent: function nonempty(draft) { return !!(draft.text || draft.attachments.length || draft.contextPaths.length); },
    slimMessagesForSave: function serialMessages(list) { return list; },
    applyTabContext: function apply(tab) { input.value = tab.composer ? tab.composer.text : ''; },
    applyTabWorkspace: noop, loadFileTree: noop, closeModal: noop, showChat: noop,
    renderTabs: noop, renderMessages: noop, renderQueue: noop, syncSendBtn: noop,
    ensureTypewriter: noop, flushLivePaint: noop, scrollMessagesToBottom: noop,
    clearStallWatch: noop, armStallWatch: noop, renderChips: noop, retryHotReload: noop,
    prefersReducedMotion: function reduced() { return false; },
    isNewChatTitle: function untitled() { return false; },
    dialogRounds: function roundsList() { return []; },
    roundsOf: function roundLimit() { return 1; },
    localMilestoneHits: function hits() { return []; },
    logSummaryTrace: noop, fillDialogIndex: noop, revealRest: noop,
    renderSidebar: noop, scheduleComposerSave: noop, refillHasTail: function noEdit() { return false; },
    currentModel: function model() { return { id: 'model' }; },
    recordSubmittedText: noop, restoreStoppedDraft: noop, finalizeStoppedTurn: noop,
    markTurnFailed: function failed(_message, error) { throw error; },
    cancelAnimationFrame: function cancel(frame) { cancellations.push(frame); },
    api: {
      saveSession: async function save(data) { writes.set(data.id, JSON.parse(JSON.stringify(data))); },
      loadSession: function load(id) { const pending = deferred(); loads.push({ id, pending }); return pending.promise; },
      floatBind: function bind(id) { events.push(['bind', id]); },
      chatSend: async function chat(payload) { requests.push(payload); return { text: '完成', changes: [] }; },
      chatInterject: async function interject(payload) { events.push(['interject', payload.tabId]); return { ok: true }; },
      chatAbort: function abort(id) { events.push(['abort', id]); },
      restoreSnapshot: async function forbiddenRestore(id) { events.push(['restore', id]); },
      listSnapshots: async function snapshots() { return []; },
      listMilestones: async function milestones() { return []; }
    }
  };
  vm.createContext(context);
  const names = ['activeSession', 'isActiveTab', 'isTabSending', 'tabQueue', 'findTabByTurnId',
    'collectComposer', 'rememberComposer', 'clearComposer', 'persistTab', 'persistSession',
    'hydrateTab', 'switchToTab', 'openHistorySession', 'stopTypewriter', 'finishTypewriter',
    'abortTab', 'beginRefillResend', 'isStopError', 'sendOne', 'processQueue', 'send'];
  for (const name of names) vm.runInContext(production(name), context);
  return { context, state, input, writes, requests, events, cancellations, loads };
}

/** 创建指定编号的已加载历史标签并追加到环境；返回该标签，不切换激活状态。 */
function addTab(h, id) {
  const tab = h.context.hydrateTab({ id, title: id, workspace: 'project', modelId: 'model', messages: [] }, 'project');
  h.state.tabs.push(tab);
  return tab;
}

/**
 * 模拟连续双开同一历史与读取期间继续输入；验证唯一标签、最新草稿保存和精确小窗绑定。
 * @returns {Promise<void>} 两次真实打开流程均结束后兑现。
 */
async function historyRace() {
  const h = harness();
  const original = addTab(h, 'old');
  h.state.activeTab = original.id;
  h.input.value = '开始加载前的草稿';
  const first = h.context.openHistorySession('history');
  const second = h.context.openHistorySession('history');
  h.input.value = '加载期间继续输入的草稿';
  const data = { id: 'history', title: '历史', workspace: 'project', messages: [{ role: 'user', text: '历史正文' }] };
  h.loads[0].pending.resolve(data);
  await first;
  const loaded = h.state.tabs.find(function target(tab) { return tab.id === 'history'; });
  loaded.messages.push({ role: 'assistant', text: '先完成的加载已有新内容' });
  h.loads[1].pending.resolve(data);
  await second;
  check('快速重复打开同一历史只产生一个标签且保留先加载对象', h.state.tabs.filter(function target(tab) { return tab.id === 'history'; }).length === 1 && loaded.messages.length === 2);
  check('历史加载期间的新草稿保存在原会话且不会覆盖历史正文', h.writes.get('old').composer.text === '加载期间继续输入的草稿' && original.composer.text === '加载期间继续输入的草稿' && loaded.messages[0].text === '历史正文');
  check('打开新历史沿用精确标签绑定', h.events.some(function bound(event) { return event[0] === 'bind' && event[1] === 'history'; }));
  await h.context.switchToTab(original.id);
  check('切回原历史恢复加载期间输入的文本', h.input.value === '加载期间继续输入的草稿');
}

/**
 * 执行后台 A 的真实发送队列，同时让前台 B 停在旧消息编辑态。
 * @returns {Promise<void>} 后台队列结束后兑现；快照恢复桩应始终未被调用。
 */
async function backgroundQueue() {
  const h = harness();
  const a = addTab(h, 'a');
  const b = addTab(h, 'b');
  a.messages = [{ role: 'user', text: 'A旧1' }, { role: 'assistant', text: 'A旧2', snapshotId: 'a-snapshot' }];
  b.messages = [{ role: 'user', text: 'B旧1' }, { role: 'assistant', text: 'B旧2' }];
  b.refillFromIndex = 1;
  b.refillRevertFiles = true;
  h.state.activeTab = b.id;
  h.state.refillFromIndex = 1;
  h.state.refillRevertFiles = true;
  h.state.typewriterRaf = 77;
  b.liveAssistant = b.messages[1];
  h.input.value = 'B正在编辑的草稿';
  a.queue.push({ text: 'A下一条', skillIds: [], contextPaths: [], attachments: [] });
  await h.context.processQueue(a);
  check('后台队列不截断自己或前台历史，也不消费前台编辑锚点', a.messages.length === 4 && b.messages.length === 2 && b.refillFromIndex === 1 && h.state.refillFromIndex === 1 && b.refillRevertFiles && h.state.refillRevertFiles);
  check('后台队列不触发别的历史编辑所选择的快照处理', !h.events.some(function restored(event) { return event[0] === 'restore'; }));
  check('后台结束不会取消前台打字帧或改写前台草稿', h.state.typewriterRaf === 77 && h.cancellations.length === 0 && h.input.value === 'B正在编辑的草稿');
  check('后台请求和持久化均指向自己的历史', h.requests[0].tabId === 'a' && h.requests[0].history[0].content === 'A旧1' && h.writes.get('a').messages.length === 4 && !h.writes.has('b'));
  a.refillFromIndex = 1;
  a.refillRevertFiles = false;
  await h.context.beginRefillResend(a);
  check('后台自己的编辑锚点仍能正常消费而不清前台状态', a.messages.length === 1 && a.refillFromIndex === null && b.refillFromIndex === 1 && h.state.refillFromIndex === 1);
}

/**
 * 将 A 的提示词覆盖排队，先执行 B，再执行 A；验证覆盖与回复、停止目标完全隔离。
 * @returns {Promise<void>} 两个历史的真实提交和队列结束后兑现。
 */
async function overrideOwnership() {
  const h = harness();
  const a = addTab(h, 'a');
  const b = addTab(h, 'b');
  h.state.activeTab = a.id;
  a.sending = true;
  a.liveTurnId = 'a-running';
  h.input.value = 'A带覆盖的请求';
  const overrides = { persona: '仅A临时正文', rules: [], skill: '' };
  await h.context.send({ sysOverrides: overrides });
  check('运行中按修改发送保留为独立任务而不丢进插话', a.queue.length === 1 && a.queue[0].sysOverrides === overrides && !h.events.some(function interjected(event) { return event[0] === 'interject'; }));
  a.sending = false;
  a.liveTurnId = null;
  await h.context.switchToTab(b.id);
  h.input.value = 'B独立请求';
  await h.context.send();
  check('B请求不会消费A提示词覆盖', h.requests.length === 1 && h.requests[0].tabId === 'b' && !Object.hasOwn(h.requests[0], 'sysOverrides'));
  await h.context.processQueue(a);
  check('A延迟执行仍携带自身覆盖且消息没有进入B', h.requests[1].tabId === 'a' && h.requests[1].sysOverrides === overrides && a.messages[0].text === 'A带覆盖的请求' && b.messages[0].text === 'B独立请求');
  a.liveTurnId = 'a-now';
  b.liveTurnId = 'b-now';
  h.context.abortTab(b);
  check('停止当前历史只发送本历史轮次编号', h.events.some(function stopped(event) { return event[0] === 'abort' && event[1] === 'b-now'; }) && !h.events.some(function stopped(event) { return event[0] === 'abort' && event[1] === 'a-now'; }));
}

/**
 * 在 A 的重发确认等待期间切到 B，核对确认、取消以及空闲/排队/插话三条路径的载荷归属。
 * @returns {Promise<void>} 所有确认分支完成后兑现；执行真实 send 和队列函数，模型与快照恢复仅记录参数。
 */
async function resendConfirmationOwnership() {
  for (const mode of ['idle', 'queued', 'interject']) {
    for (const choice of ['keep', 'revert', 'new', 'cancel']) {
      const h = harness();
      const a = addTab(h, 'a');
      const b = addTab(h, 'b');
      a.workspace = 'owner-a';
      a.modelId = 'model-a';
      b.workspace = 'owner-b';
      b.modelId = 'model-b';
      a.messages = [{ role: 'user', text: 'A旧正文' }, { role: 'assistant', text: 'A旧回复', snapshotId: 'snapshot-a' }];
      b.messages = [{ role: 'user', text: 'B旧正文' }, { role: 'assistant', text: 'B旧回复' }];
      a.refillFromIndex = 1;
      a.sending = mode !== 'idle';
      b.refillFromIndex = 1;
      b.refillRevertFiles = true;
      h.state.activeTab = a.id;
      h.state.refillFromIndex = 1;
      h.input.value = 'A确认前提交的正文';
      h.state.contextPaths = ['reference-a'];
      h.state.attachments = [{ path: 'attachment-a', name: 'A附件', preview: mode === 'interject' ? 'image-a' : undefined }];
      h.context.skillStack = selectedSkills;
      h.context.refreshAfterRestore = noop;
      const confirmation = deferred();
      const interjections = [];
      h.context.confirmSubmitFromPrevious = confirm;
      h.context.api.chatInterject = interject;
      vm.runInContext(production('refillHasTail'), h.context);
      const sending = h.context.send();
      check(mode + '/' + choice + '确认前未提交也未消费A输入', h.requests.length === 0 && a.queue.length === 0 && h.input.value === 'A确认前提交的正文');
      await h.context.switchToTab(b.id);
      h.input.value = 'B确认期间的新草稿';
      h.state.attachments = [{ path: 'attachment-b', name: 'B附件' }];
      h.state.contextPaths = ['reference-b'];
      h.state.currentModelId = b.modelId;
      h.state.refillFromIndex = 1;
      h.state.refillRevertFiles = true;
      h.context.composerTimer = 55;
      confirmation.resolve(choice);
      await sending;
      check(mode + '/' + choice + '确认返回保留B正文附件引用编辑锚点及保存计时器', h.state.activeTab === b.id && h.input.value === 'B确认期间的新草稿' && h.state.attachments[0].path === 'attachment-b' && h.state.contextPaths[0] === 'reference-b' && b.refillFromIndex === 1 && b.refillRevertFiles && h.state.refillFromIndex === 1 && h.state.refillRevertFiles && h.context.composerTimer === 55 && b.messages.length === 2);
      if (choice === 'cancel') {
        check(mode + '取消原确认不提交A且保留A草稿', h.requests.length === 0 && a.queue.length === 0 && interjections.length === 0 && a.composer.text === 'A确认前提交的正文' && a.refillFromIndex === 1);
        continue;
      }
      const submitted = mode === 'idle' ? h.requests[0] : mode === 'queued' ? a.queue[0] : interjections[0];
      check(mode + '/' + choice + '只提交A确认前的正文与附件', submitted.text === 'A确认前提交的正文' && submitted.attachments[0].path === 'attachment-a' && a.composer === null);
      if (mode !== 'interject') {
        check(mode + '/' + choice + '模型技能引用保持A归属', submitted.modelId === 'model-a' && submitted.skillIds[0] === 'skill-a' && submitted.contextPaths[0] === 'reference-a');
      } else {
        check(mode + '/' + choice + '插话只投递原会话', submitted.tabId === a.id);
      }
      check(mode + '/' + choice + '未恢复B快照', !h.events.some(isForeignRestore));

      /** 返回当前标签技能；无参数，返回独立ID数组，不修改状态。 */
      function selectedSkills() { return [h.state.activeTab === a.id ? 'skill-a' : 'skill-b']; }
      /** 延迟原会话确认；无参数，返回受控Promise，不改变输入或导航。 */
      function confirm() { return confirmation.promise; }
      /** 记录真实插话载荷；payload为提交对象，返回成功回执，不启动模型。 */
      async function interject(payload) { interjections.push(payload); return { ok: true }; }
      /** event为快照操作记录；返回是否错误引用B，不修改记录。 */
      function isForeignRestore(event) { return event[0] === 'restore' && event[1].workspace === 'owner-b'; }
    }
  }
}

/**
 * 延迟实际 saveSession 回执并在等待期间继续输入，核对同步切换和最后选择归属。
 * @returns {Promise<void>} 所有保存回执及两次切换结束后兑现；不使用计时等待。
 */
async function delayedSaveNavigation() {
  const h = harness();
  const a = addTab(h, 'a');
  const b = addTab(h, 'b');
  const c = addTab(h, 'c');
  h.state.activeTab = a.id;
  h.input.value = 'A离开时完整草稿';
  const saves = [];
  h.context.api.saveSession = function delayedSave(data) {
    const pending = deferred();
    const captured = JSON.parse(JSON.stringify(data));
    h.writes.set(data.id, captured);
    saves.push({ data: captured, pending });
    return pending.promise;
  };
  const first = h.context.switchToTab(b.id);
  check('保存IPC尚未返回时输入和活动标签已经同步切到目标', saves.length === 1 && h.state.activeTab === b.id && h.input.value === '');
  h.input.value = '保存A期间在B继续输入';
  const second = h.context.switchToTab(c.id);
  check('连续切换在保存回执前采集B新输入', saves.length === 2 && saves[0].data.composer.text === 'A离开时完整草稿' && saves[1].data.composer.text === '保存A期间在B继续输入');
  h.input.value = 'C最新输入';
  saves[1].pending.resolve(true);
  await second;
  saves[0].pending.resolve(true);
  await first;
  check('倒序保存回执不覆盖最后选择或等待期间的新输入', h.state.activeTab === c.id && h.input.value === 'C最新输入' && b.composer.text === '保存A期间在B继续输入');
  h.state.autoSave = false;
  await h.context.switchToTab(a.id);
  check('关闭自动保存时仍同步保留离开标签的内存草稿', c.composer.text === 'C最新输入');
}

/**
 * 按相反顺序交付两次不同历史的读取，核对旧回执仅添加标签、不抢最新选择。
 * @returns {Promise<void>} 两个真实历史读取流程均结束后兑现。
 */
async function reversedHistoryLoads() {
  const h = harness();
  const a = addTab(h, 'initial');
  h.state.activeTab = a.id;
  const first = h.context.openHistorySession('first');
  const second = h.context.openHistorySession('second');
  h.loads[1].pending.resolve({ id: 'second', title: '后选历史', workspace: 'project', messages: [] });
  await second;
  h.input.value = '后选历史中新写的草稿';
  h.loads[0].pending.resolve({ id: 'first', title: '先选历史', workspace: 'project', messages: [] });
  await first;
  check('不同历史倒序返回时最后选择保持激活且新草稿完整', h.state.activeTab === 'second' && h.input.value === '后选历史中新写的草稿');
  check('过时历史读取仍登记独立标签且不会再次绑定小窗', h.state.tabs.some(function loaded(tab) { return tab.id === 'first'; }) && !h.events.some(function bound(event) { return event[0] === 'bind' && event[1] === 'first'; }));
}

/**
 * 运行真实工作区切换函数并倒序交付 IPC 回执，核对旧导航不会覆盖新工作区。
 * @returns {Promise<void>} 两次切换结束后兑现；目录和模型调用均为受控桩。
 */
async function reversedWorkspaceReplies() {
  const h = harness();
  const initial = addTab(h, 'initial');
  const b = addTab(h, 'b');
  const c = addTab(h, 'c');
  b.workspace = 'workspace-b';
  c.workspace = 'workspace-c';
  h.state.activeTab = initial.id;
  const replies = [];
  const applied = [];
  h.context.sameWorkspace = function same(a, b) { return a === b; };
  h.context.closeCodePreview = noop;
  h.context.setWorkspace = function set(ws) { h.state.workspace = ws; applied.push(ws); };
  h.context.refreshMeta = noop;
  h.context.api.setWorkspace = function request(ws) { const pending = deferred(); replies.push({ ws, pending }); return pending.promise; };
  vm.runInContext(production('applyTabWorkspace'), h.context);
  const first = h.context.switchToTab(b.id);
  const second = h.context.switchToTab(c.id);
  replies[1].pending.resolve('workspace-c');
  await second;
  h.input.value = 'C工作区新草稿';
  replies[0].pending.resolve('workspace-b');
  await first;
  check('旧工作区回执不能覆盖新标签工作区或新草稿', h.state.activeTab === c.id && h.state.workspace === 'workspace-c' && applied.length === 1 && applied[0] === 'workspace-c' && h.input.value === 'C工作区新草稿');
}

/**
 * 验证 A→B→A 在 B 回执前仍向主进程重新提交 A，较早回执不能改变最新导航。
 * @returns {Promise<void>} 两种回执顺序都结束后兑现；同步主进程状态桩模拟真实 workspace:set 提交时机。
 */
async function returnedWorkspaceBeforeReply() {
  for (const oldReplyFirst of [true, false]) {
    const h = harness();
    const a = addTab(h, 'a');
    const b = addTab(h, 'b');
    a.workspace = 'workspace-a';
    b.workspace = 'workspace-b';
    h.state.activeTab = a.id;
    h.state.workspace = a.workspace;
    let mainWorkspace = a.workspace;
    const replies = [];
    const applied = [];
    h.context.closeCodePreview = noop;
    h.context.setWorkspace = applyWorkspace;
    h.context.refreshMeta = noop;
    h.context.api.setWorkspace = requestWorkspace;
    vm.runInContext(production('applyTabWorkspace'), h.context);
    const first = h.context.switchToTab(b.id);
    check('切往B先提交主进程而界面A缓存尚未收到回执', mainWorkspace === b.workspace && h.state.workspace === a.workspace);
    const second = h.context.switchToTab(a.id);
    check('B回执前返回A仍提交A工作区', replies.length === 2 && replies[1].ws === a.workspace && mainWorkspace === a.workspace);
    h.input.value = '返回A后继续写的新草稿';
    if (oldReplyFirst) {
      replies[0].pending.resolve(b.workspace);
      await first;
      replies[1].pending.resolve(a.workspace);
      await second;
    } else {
      replies[1].pending.resolve(a.workspace);
      await second;
      replies[0].pending.resolve(b.workspace);
      await first;
    }
    check('A→B→A回执次序' + (oldReplyFirst ? '旧先' : '新先') + '保持标签、主进程工作区和草稿一致', h.state.activeTab === a.id && mainWorkspace === a.workspace && h.state.workspace === a.workspace && applied.length === 1 && h.input.value === '返回A后继续写的新草稿');

    /** 提交工作区并延迟回执；ws 是目标路径，返回受控 Promise，主进程状态立即更新。 */
    function requestWorkspace(ws) {
      mainWorkspace = ws;
      const pending = deferred();
      replies.push({ ws, pending });
      return pending.promise;
    }
    /** 仅应用有效导航回执；ws 是目标路径，无返回值，记录渲染层实际应用的工作区。 */
    function applyWorkspace(ws) { h.state.workspace = ws; applied.push(ws); }
  }
}

/**
 * 在前台延迟执行带覆盖的排队请求，验证新正文、附件与引用不被队列开始或结束再次消费。
 * @returns {Promise<void>} 真实队列完成后兑现；检查实际持久化载荷而非仅字段存在。
 */
async function queuedDraftPreservation() {
  const h = harness();
  const a = addTab(h, 'a');
  h.state.activeTab = a.id;
  a.sending = true;
  h.input.value = '已提交的排队正文';
  h.state.contextPaths = ['已提交引用'];
  h.state.attachments = [{ path: 'queued.txt', name: '排队附件' }];
  await h.context.send({ sysOverrides: { persona: '本条覆盖', rules: [], skill: '' } });
  h.input.value = '下一条尚未提交的正文';
  h.state.contextPaths = ['新草稿引用'];
  h.state.attachments = [{ path: 'new.txt', name: '新草稿附件' }];
  const result = deferred();
  h.context.api.chatSend = function delay(payload) { h.requests.push(payload); return result.promise; };
  a.sending = false;
  const running = h.context.processQueue(a);
  await Promise.resolve();
  check('延迟队列启动使用原提交快照且保留前台新附件与引用', h.requests[0].attachments[0].path === 'queued.txt' && h.requests[0].contextPaths[0] === '已提交引用' && h.input.value === '下一条尚未提交的正文' && h.state.attachments[0].path === 'new.txt' && h.state.contextPaths[0] === '新草稿引用');
  result.resolve({ text: '完成', changes: [] });
  await running;
  const saved = h.writes.get(a.id).composer;
  check('延迟队列结束后新草稿正文附件引用完整持久化', saved.text === '下一条尚未提交的正文' && saved.attachments[0].path === 'new.txt' && saved.contextPaths[0] === '新草稿引用' && h.state.attachments[0].path === 'new.txt' && h.state.contextPaths[0] === '新草稿引用');
  // 使用真实草稿恢复端切走再切回，不能只验证持久化载荷而漏掉恢复时复活旧引用。
  h.context.setSkillStack = noop;
  h.context.composerAlreadySent = function unsent() { return false; };
  h.context.renderModelMenu = noop;
  h.context.syncRoundsInput = noop;
  vm.runInContext(production('applyTabContext'), h.context);
  const b = addTab(h, 'b');
  await h.context.switchToTab(b.id);
  await h.context.switchToTab(a.id);
  check('切回标签从真实composer恢复新草稿正文附件引用', h.input.value === '下一条尚未提交的正文' && h.state.attachments[0].path === 'new.txt' && h.state.contextPaths.length === 1 && h.state.contextPaths[0] === '新草稿引用');
}

/**
 * 延迟预览回执并模拟面板显示后切换历史，验证 A 的覆盖文本不能进入 B。
 * @returns {Promise<void>} 两次预览回执结束后兑现，模型发送只记录参数、不访问服务。
 */
async function previewOwnership() {
  const h = harness();
  const a = addTab(h, 'a');
  const b = addTab(h, 'b');
  h.state.activeTab = a.id;
  const elements = new Map();
  const requests = [];
  let opened = 0;
  let submitted = 0;
  h.context.$ = function element(id) {
    if (id === 'input') return h.input;
    if (!elements.has(id)) elements.set(id, { value: '', classList: { add: noop } });
    return elements.get(id);
  };
  h.context.escapeHtml = function escape(value) { return String(value); };
  h.context.openModal = function show() { opened += 1; };
  h.context.send = function sendPreview() { submitted += 1; };
  h.context.api.promptPreview = function request() { const pending = deferred(); requests.push(pending); return pending.promise; };
  vm.runInContext(production('openPromptPreview'), h.context);
  const first = h.context.openPromptPreview();
  await h.context.switchToTab(b.id);
  requests[0].resolve({ editable: { persona: '仅A预览', rules: [] } });
  await first;
  check('A预览迟到时不在B弹出或提交旧提示词', opened === 0 && submitted === 0 && h.state.activeTab === b.id);
  await h.context.switchToTab(a.id);
  const second = h.context.openPromptPreview();
  requests[1].resolve({ editable: { persona: '仅A预览', rules: [] } });
  await second;
  const submit = h.context.$('m-preview-send').onclick;
  await h.context.switchToTab(b.id);
  submit();
  check('预览显示后切换历史使旧提交按钮失效', opened === 1 && submitted === 0 && h.state.activeTab === b.id);
}

/**
 * 使用真实 preload 与主进程快照 IPC，快照处理器为只记参数的桩，绝不操作项目文件。
 * @returns {Promise<void>} 后台重发和两个用户确认入口的归属核对结束后兑现。
 */
async function snapshotWorkspaceOwnership() {
  const root = path.join(__dirname, '..');
  const main = fs.readFileSync(path.join(root, 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(root, 'electron', 'preload.js'), 'utf8');
  const handlers = new Map();
  const restored = [];
  const exposed = {};
  const begin = main.indexOf("ipcMain.handle('snapshot:restore'");
  const end = main.indexOf("ipcMain.handle('snapshot:undo'", begin);
  assert.ok(begin >= 0 && end > begin);
  vm.runInNewContext(main.substring(begin, end), {
    ipcMain: { handle: function register(name, handler) { handlers.set(name, handler); } },
    snapshot: { restore: function record(workspace, id) { restored.push({ workspace, id }); return { ok: true }; } },
    workspaceByWin: { get: function wrongOwner() { throw new Error('不应读取前台项目'); } }
  });
  const electron = {
    contextBridge: { exposeInMainWorld: function expose(name, value) { exposed[name] = value; } },
    ipcRenderer: { invoke: async function invoke(name, payload) { return handlers.get(name)({}, payload); } }
  };
  vm.runInNewContext(preload, { require: function dependency(name) { assert.equal(name, 'electron'); return electron; } });
  const bridge = exposed.simple || exposed.sinpo;
  assert.ok(bridge && bridge.restoreSnapshot);
  const h = harness();
  const a = addTab(h, 'a');
  const b = addTab(h, 'b');
  a.workspace = 'owner-a';
  b.workspace = 'owner-b';
  a.messages = [{ role: 'user', text: '保留' }, { role: 'assistant', text: '被确认替换的尾部', snapshotId: 'a-snapshot' }];
  a.refillFromIndex = 1;
  a.refillRevertFiles = true;
  h.state.activeTab = b.id;
  h.state.workspace = b.workspace;
  h.context.api.restoreSnapshot = bridge.restoreSnapshot;
  h.context.refreshAfterRestore = noop;
  await h.context.beginRefillResend(a);
  check('后台A已确认的快照处理跨preload和IPC仍使用A项目', restored[0].workspace === 'owner-a' && restored[0].id === 'a-snapshot');

  // 直接执行两个生产点击分支，确认窗口期间切到B；处理器仅记录参数。
  const sideBegin = source.indexOf('    if (restore) {');
  const sideEnd = source.indexOf('\n  };', sideBegin);
  const messageBegin = source.indexOf("    const id = e.target.closest('[data-restore]')");
  const messageEnd = source.indexOf('\n  };', messageBegin);
  assert.ok(sideBegin >= 0 && sideEnd > sideBegin && messageBegin >= 0 && messageEnd > messageBegin);
  const sideCode = source.substring(sideBegin, sideEnd);
  const messageCode = source.substring(messageBegin, messageEnd);
  h.state.snapshots = [{ id: 'clicked-snapshot', changes: [] }];
  h.context.restore = 'clicked-snapshot';
  h.context.openModal = noop;
  h.context.t = function translate(key) { return key; };
  const button = { getAttribute: function id() { return 'clicked-snapshot'; }, textContent: '' };
  h.context.e = { target: { closest: function target() { return button; } } };
  for (const entry of [{ name: 'sidebarClick', code: sideCode }, { name: 'messageClick', code: messageCode }]) {
    const confirmed = deferred();
    h.state.activeTab = a.id;
    h.state.workspace = a.workspace;
    h.context.confirmRestore = function confirmation() { return confirmed.promise; };
    vm.runInContext('async function ' + entry.name + '() {\n' + entry.code + '\n}', h.context);
    const clicking = h.context[entry.name]();
    h.state.activeTab = b.id;
    h.state.workspace = b.workspace;
    confirmed.resolve(true);
    await clicking;
  }
  check('侧栏和消息点击确认期间切项目仍保留原快照项目', restored.length === 3 && restored[1].workspace === 'owner-a' && restored[2].workspace === 'owner-a');
  await assert.rejects(bridge.restoreSnapshot({ id: 'missing-owner' }), /未选择工作目录/);
  check('快照IPC缺少明确所属项目时失败且不回落前台项目', restored.length === 3);
}

/** 顺序执行并汇总行为回归；任一断言失败向进程返回非零退出码。 */
async function run() {
  await historyRace();
  await backgroundQueue();
  await overrideOwnership();
  await resendConfirmationOwnership();
  await delayedSaveNavigation();
  await reversedHistoryLoads();
  await reversedWorkspaceReplies();
  await returnedWorkspaceBeforeReply();
  await queuedDraftPreservation();
  await previewOwnership();
  await snapshotWorkspaceOwnership();
  console.log(JSON.stringify({ passed: passed.length, checks: passed }, null, 2));
}

run().catch(function reportFailure(error) { console.error(error.stack || error); process.exitCode = 1; });
