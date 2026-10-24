/**
 * 在独立 Chromium 执行真实提交、键盘绑定和会话保存，验证可连续浏览的正文历史。
 * 真实磁盘回读仅作用于 generated 测试目录，不连接模型、不修改用户会话。
 */
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8').split('\r\n').join('\n');
const mainSource = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8').split('\r\n').join('\n');

/** 提取顶层具名函数；保持真实实现，缺少边界时直接让测试失败。 */
function functionSource(signature) {
  const start = source.indexOf(signature);
  const end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, signature);
  return source.substring(start, end + 3);
}

/** 用真实会话处理器建立独立持久化环境，覆盖完整保存、流式保存及草稿覆盖后的回读。 */
function installSessionHandlers() {
  fs.mkdirSync(path.join(root, 'generated'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'generated', 'composer-history-'));
  const handlers = {};
  function handle(name, fn) { handlers[name] = fn; }
  function sessionDir() { return dir; }
  function dependency(name) {
    assert.equal(name, './lib/session-composer');
    return require('../electron/lib/session-composer');
  }
  const start = mainSource.indexOf('const sessionMetaCache = new Map();');
  const end = mainSource.indexOf("ipcMain.handle('sessions:rename'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(mainSource.substring(start, end), { fs, path, ipcMain: { handle }, sessionDir, require: dependency, console });
  ipcMain.handle('history-test-save', handlers['sessions:save']);
  ipcMain.handle('history-test-load', handlers['sessions:load']);
  ipcMain.handle('history-test-draft', handlers['sessions:saveComposer']);
  console.log('FIXTURE ' + path.relative(root, dir));
}

/** 用真实 DOM 键盘事件覆盖连续浏览、插话、切换会话、磁盘恢复和输入边界。 */
async function main() {
  await app.whenReady();
  installSessionHandlers();
  const keyStart = source.indexOf("  $('input').addEventListener('keydown', (e) => {");
  const keyEnd = source.indexOf("\n  document.addEventListener('paste',", keyStart);
  const floatStart = source.indexOf('if (api.onFloatUserMessage) {');
  const floatEnd = source.indexOf('// 小窗里点了别的标签', floatStart);
  assert.ok(keyStart >= 0 && keyEnd > keyStart && floatStart >= 0 && floatEnd > floatStart);
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false } });
  try {
    await win.loadURL('data:text/html,<textarea id="input"></textarea><div id="slash-menu" class="hidden"></div><div id="at-menu" class="hidden"></div><div id="messages"></div>');
    const result = await win.webContents.executeJavaScript(String.raw`(async function () {
      const { ipcRenderer } = require('electron');
      const state = { autoSave: true, workspace: 'test', attachments: [], contextPaths: [], currentModelId: 'model', activeTab: 'a', tabs: [] };
      let processed = 0;
      let saved = 0;
      let interjectResolve;
      let hasModel = true;
      let floatMessage;
      const writes = [];
      const payloads = [];
      const SAVE_THINK_STEPS = 60;
      const SAVE_THINK_CHARS = 2000;
      function $(id) { return document.getElementById(id); }
      function activeSession() { return state.tabs.find(function match(tab) { return tab.id === state.activeTab; }); }
      function tabQueue(tab) { return tab.queue; }
      function currentModel() { return hasModel; }
      function skillStack() { return []; }
      function refillHasTail() { return false; }
      function clearComposer(tab) { tab.composer = null; }
      function scheduleComposerSave() { saved++; }
      function renderChips() {}
      function renderQueue() {}
      function isActiveTab(tab) { return tab.id === state.activeTab; }
      function renderMessages() { $('messages').textContent = activeSession().messages.map(function text(message) { return message.text; }).join('\n'); }
      function scrollMessagesToBottom() {}
      function openSettings() {}
      function extraFoldersOf(tab) { return tab.extraFolders || []; }
      function emptyContext() { return { attachments: [], contextPaths: [], skillIds: [] }; }
      function emptyWorkingMemory() { return {}; }
      function normalizeSkillIds(value) { return value.skillIds || []; }
      function t(key) { return key; }
      function syncSendBtn() {}
      async function processQueue() { processed++; }
      async function flushSaves() { await Promise.all(writes.splice(0)); }
      const api = {
        chatInterject: function chatInterject() { return new Promise(function pending(resolve) { interjectResolve = resolve; }); },
        saveSession: function saveSession(payload) {
          payloads.push(structuredClone(payload));
          const job = ipcRenderer.invoke('history-test-save', payload);
          writes.push(job);
          return job;
        },
        onFloatUserMessage: function onFloatUserMessage(callback) { floatMessage = callback; }
      };
      ${functionSource('function collectComposer()')}
      ${functionSource('function hasComposerContent(c)')}
      ${functionSource('function rememberComposer(tab)')}
      ${functionSource('function slimMessagesForSave(messages)')}
      ${functionSource('function persistTab(tab, force = false)')}
      ${functionSource('async function persistMessages(tab)')}
      ${functionSource('function settleDeadTurns(messages)')}
      ${functionSource('function hydrateTab(data, fallbackWs)')}
      ${functionSource('function onInput()')}
      ${functionSource('function submittedTextHistory(tab)')}
      ${functionSource('function recordSubmittedText(tab, text)')}
      ${functionSource('function receiveFloatInterjection(payload)')}
      ${functionSource('function recallSubmittedText(event)')}
      ${functionSource('async function send(options = {})')}
      ${source.substring(keyStart, keyEnd)}
      ${source.substring(floatStart, floatEnd)}
      const passes = [];
      function check(value, name) { if (!value) throw new Error(name); passes.push(name); }
      function arrow(key, options = {}) {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
        $('input').dispatchEvent(event);
        return event.defaultPrevented;
      }
      function up(options = {}) { return arrow('ArrowUp', options); }
      function down(options = {}) { return arrow('ArrowDown', options); }
      const a = hydrateTab({ id: 'a', workspace: 'test', messages: [] });
      const b = hydrateTab({ id: 'b', workspace: 'test', messages: [] });
      state.tabs.push(a, b);
      check(!up() && !down(), 'empty conversation keeps native arrow keys');
      $('input').value = '第一条已提交';
      await send();
      check(processed === 1 && $('input').value === '', 'normal submit consumes composer');
      check(up() && $('input').value === '第一条已提交', 'normal submission recalled');
      check(a.composer.text === '第一条已提交' && saved > 0, 'recall updates actual composer state');
      check(down() && $('input').value === '', 'down after newest returns to empty composer');
      a.sending = true;
      state.attachments = [{ path: 'fixture.png', name: 'fixture.png' }];
      const queued = '  第二条尚未启动\n多行原文  ';
      $('input').value = queued;
      await send();
      check(a.queue.length === 2 && a.messages.length === 0 && processed === 1, 'attachment message queued without starting conversation');
      check(up() && $('input').value === queued, 'queue recalls exact raw text before model starts');
      check($('input').selectionStart === queued.length && $('input').selectionEnd === queued.length, 'caret placed after recalled text');
      check(up() && $('input').value === '第一条已提交', 'second up reaches older submission');
      check(up() && $('input').value === '第一条已提交', 'oldest boundary remains on first record');
      check(down() && $('input').value === queued && down() && $('input').value === '', 'down traverses newer record and exits history');
      check(!down() && state.attachments.length === 0 && a.queue.length === 2, 'history does not send, dequeue or resurrect attachments');
      $('input').value = '正在编辑\n第二行';
      check(!up() && !down() && $('input').value === '正在编辑\n第二行', 'existing multiline draft preserves native arrows');
      $('input').value = '';
      check(up(), 'history can be entered again');
      $('input').value += '修改';
      check(!up() && !down() && $('input').value.endsWith('修改'), 'editing recalled text exits history without overwriting edits');
      $('input').value = '';
      check(!up({ isComposing: true }) && !down({ isComposing: true }), 'IME arrows are untouched');
      check(!up({ keyCode: 229 }) && !down({ keyCode: 229 }), 'legacy IME composition code is untouched');
      for (const modifier of ['ctrlKey', 'altKey', 'metaKey', 'shiftKey']) {
        check(!up({ [modifier]: true }) && !down({ [modifier]: true }), modifier + ' arrows are untouched');
      }
      $('slash-menu').classList.remove('hidden');
      check(!up() && !down(), 'skill menu keeps arrow navigation');
      $('slash-menu').classList.add('hidden');
      $('at-menu').classList.remove('hidden');
      check(!up() && !down(), 'reference menu keeps arrow navigation');
      $('at-menu').classList.add('hidden');
      $('input').value = '第三条插话';
      const interjecting = send();
      check(a.submittedTextHistory.join('|') === '第一条已提交|' + queued + '|第三条插话' && $('input').value === '', 'interjection appended before async acknowledgement');
      await flushSaves();
      const pendingDisk = await ipcRenderer.invoke('history-test-load', 'a');
      check(pendingDisk.submittedTextHistory[2] === '第三条插话' && pendingDisk.composer === null, 'unacknowledged interjection is already saved without old draft');
      interjectResolve({ ok: true });
      await interjecting;
      check(up() && $('input').value === '第三条插话' && up() && $('input').value === queued && up() && $('input').value === '第一条已提交', 'up traverses interjection, queued and normal records in order');
      check(a.messages[0].text.includes('第三条插话') && $('messages').textContent.includes('第三条插话'), 'accepted interjection remains visible after repaint');
      $('input').value = '';
      state.activeTab = 'b';
      check(!up(), 'another empty tab cannot recall first tab');
      const legacy = hydrateTab({ id: 'legacy', workspace: 'test', messages: [
        { role: 'user', text: '带附件的显示正文', draft: { text: '已存用户原文' } },
        { role: 'assistant', text: '不能召回助手消息' },
        { role: 'system', text: '你（插话·已提交）：旧插话原文' },
        { role: 'system', text: '无关系统通知' },
        { role: 'user', text: '仅附件名称', draft: { text: '' } }
      ], queue: [{ text: '尚未处理的队列正文' }] });
      state.tabs.push(legacy);
      state.activeTab = 'legacy';
      check(up() && $('input').value === '尚未处理的队列正文' && up() && $('input').value === '旧插话原文' && up() && $('input').value === '已存用户原文', 'legacy migration includes interjections and queue, excluding assistant and attachment names');
      $('input').value = '';
      state.activeTab = 'a';
      check(up() && $('input').value === '第三条插话', 'switching back retains own submission list');
      hasModel = false;
      $('input').value = '没有模型时未提交';
      await send();
      check(a.submittedTextHistory.length === 3, 'rejected send does not append history');
      hasModel = true;
      $('input').value = '延迟回执插话';
      const delayed = send();
      $('input').value = '随后输入的新草稿';
      state.attachments = [{ path: 'new.png', name: '新附件' }];
      state.activeTab = 'b';
      interjectResolve({ ok: true });
      await delayed;
      check($('input').value === '随后输入的新草稿' && state.attachments[0].path === 'new.png', 'delayed acknowledgement preserves new draft and attachments');
      check(a.submittedTextHistory[3] === '延迟回执插话' && b.submittedTextHistory.length === 0, 'tab switch during acknowledgement records original conversation only');
      floatMessage({ tabId: 'a', text: '小窗已投递插话', interjection: true });
      check(a.submittedTextHistory[4] === '小窗已投递插话' && b.submittedTextHistory.length === 0, 'real float callback records bound tab while another tab is active');
      check($('input').value === '随后输入的新草稿' && state.attachments[0].path === 'new.png', 'float interjection registration preserves active composer');
      state.activeTab = 'a';
      state.attachments = [];
      state.contextPaths = ['original-reference'];
      $('input').value = '排队插话';
      const failing = send();
      $('input').value = '失败回执前的新草稿';
      state.attachments = [{ path: 'later.png', name: '后续附件' }];
      state.contextPaths = ['later-reference'];
      a.sending = false;
      a.draining = false;
      interjectResolve({ ok: false });
      await failing;
      const queuedItem = a.queue[a.queue.length - 1];
      check(queuedItem.text === '排队插话' && queuedItem.attachments.length === 0 && queuedItem.contextPaths[0] === 'original-reference', 'failed interjection queues exact snapshot');
      check($('input').value === '失败回执前的新草稿' && state.attachments[0].path === 'later.png' && state.contextPaths[0] === 'later-reference', 'failed acknowledgement preserves new composer');
      check(processed === 2 && a.submittedTextHistory.filter(function same(text) { return text === '排队插话'; }).length === 1, 'fallback queue starts without duplicate history entry');
      state.attachments = [];
      state.contextPaths = [];
      $('input').value = '排队插话';
      await send();
      check(a.submittedTextHistory.slice(-2).join('|') === '排队插话|排队插话', 'intentional repeated submission keeps separate list entries');
      $('input').value = '/历史命令';
      await send();
      $('input').value = '@历史引用';
      await send();
      check(up() && $('input').value === '@历史引用' && up() && $('input').value === '/历史命令' && up() && $('input').value === '排队插话', 'recalled slash and reference text do not open menus or block traversal');
      await persistMessages(a);
      await flushSaves();
      const savedList = [...a.submittedTextHistory];
      await ipcRenderer.invoke('history-test-draft', { id: 'a', title: a.title, workspace: 'test', composer: null });
      const restored = hydrateTab(await ipcRenderer.invoke('history-test-load', 'a'));
      check(JSON.stringify(restored.submittedTextHistory) === JSON.stringify(savedList), 'real disk round trip survives stream save and later draft save');
      state.tabs[0] = restored;
      $('input').value = '';
      for (let i = savedList.length - 1; i >= 0; i--) {
        check(up() && $('input').value === savedList[i], 'reopened up record ' + i);
      }
      for (let i = 1; i < savedList.length; i++) {
        check(down() && $('input').value === savedList[i], 'reopened down record ' + i);
      }
      check(down() && $('input').value === '', 'reopened traversal returns to blank composer');
      check(payloads.every(function hasList(payload) { return Array.isArray(payload.submittedTextHistory); }), 'all full and stream saves carry the submitted list');
      $('input').value = '原生最新';
      await send();
      await flushSaves();
      $('input').focus();
      window.historyFixture = { state, keys: [] };
      $('input').addEventListener('keydown', function observeKey(event) {
        window.historyFixture.keys.push({ key: event.key, code: event.keyCode, composing: event.isComposing,
          prevented: event.defaultPrevented, index: activeSession().composerHistoryIndex, value: $('input').value });
      });
      return passes;
    })()`);
    for (const item of result) console.log('PASS ' + item);
    // 原生上下键验证连续翻阅，避免只验证模拟事件或辅助函数。
    const nativeSteps = [['Up', '原生最新'], ['Up', '@历史引用'], ['Down', '原生最新'], ['Down', '']];
    for (const step of nativeSteps) {
      // sendInputEvent 异步投递；等待这次 keyup 后才读取结果，不能把尚未送达当成浏览失败。
      await win.webContents.executeJavaScript("void (window.nativeKeyDone = new Promise(function wait(resolve) { document.getElementById('input').addEventListener('keyup', function done() { resolve(); }, { once: true }); }))");
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: step[0] });
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: step[0] });
      await win.webContents.executeJavaScript('window.nativeKeyDone');
      const snapshot = await win.webContents.executeJavaScript("({ value: document.getElementById('input').value, keys: window.historyFixture.keys })");
      assert.equal(snapshot.value, step[1], JSON.stringify(snapshot));
      console.log('PASS Chromium native ' + step[0] + ' -> ' + JSON.stringify(step[1]));
    }
    console.log('RESULT ' + JSON.stringify({ failures: 0, checks: result.length + nativeSteps.length }));
  } finally {
    win.destroy();
  }
  app.exit(0);
}

/** 任一断言失败均保留堆栈并返回失败状态。 */
function failed(error) { console.error(error.stack || error); app.exit(1); }
main().catch(failed);
