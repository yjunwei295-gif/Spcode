/**
 * 验证长时存活的实际调度、持久化、停止边界、归档分页及渲染发送链路。
 * 模型传输受控，任务执行、回执、上下文筛选与消息保留使用生产实现。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
// 测试产物保留在项目 generated 目录，便于复核。
const path = require('node:path');
const vm = require('node:vm');
const { createLongAlive, DEFAULTS } = require('../electron/lib/long-alive');
const { registerLongAlive } = require('../electron/lib/long-alive-host');
const dir = fs.mkdtempSync(path.join(__dirname, '../generated/long-alive-check-'));
let checks = 0;
/** 汇报行为断言，失败立即退出。 */
function check(value, text) { assert.ok(value, text); checks++; console.log('PASS ' + text); }
/** 可推进的计时器，直接核对待持有的计时器数量。 */
function fakeClock() {
  let now = 1000;
  let next = 0;
  const jobs = new Map();
  function set(callback, delay) { const id = ++next; jobs.set(id, { callback, at: now + delay }); return id; }
  function clear(id) { jobs.delete(id); }
  function advance(ms) {
    now += ms;
    const due = [];
    for (const [id, job] of jobs) if (job.at <= now) due.push([id, job]);
    for (const [id, job] of due) if (jobs.delete(id)) job.callback();
  }
  return { now: function time() { return now; }, setTimeout: set, clearTimeout: clear, advance, jobs };
}

/** 模型未进入测试，不产生外部发布；验证串行调度、崩溃恢复和有界记录。 */
async function scheduler() {
  const clock = fakeClock();
  let busy = false;
  let task;
  let dispatched = 0;
  let cancelled = 0;
  const options = {
    dir, clock, ready: function ready() { return !busy; },
    dispatch: function dispatch(value) { task = value; dispatched++; },
    cancel: function cancel() { cancelled++; }, notify: function notify() {},
    metrics: function metrics() { return { rss: 123, heapUsed: 45 }; }
  };
  const ctl = createLongAlive(options);
  ctl.bind('task', 'project');
  const config = { goal: '只检查项目测试，不发布', intervalSeconds: 1, timeoutSeconds: 3 };
  for (let i = 0; i < 1000; i++) {
    ctl.start(config); ctl.stop();
    // 每次交还事件循环，模拟独立界面事件，而非同一同步调用内连续刷盘。
    await new Promise(function yieldTurn(resolve) { setTimeout(resolve, 1); });
  }
  check(clock.jobs.size === 0, '1000 次启停后零残留定时器');
  ctl.start(config); ctl.start(config);
  check(clock.jobs.size === 1, '重复开启仅一个检查定时器');
  busy = true; clock.advance(1000);
  check(dispatched === 0 && clock.jobs.size === 1, '忙碌时不投递、不积压');
  busy = false; clock.advance(1000);
  check(dispatched === 1 && clock.jobs.size === 1, '到期只启动一轮，持有单轮超时');
  ctl.tick(); clock.advance(1000);
  check(dispatched === 1, '执行期间心跳不重入');
  check(ctl.accept(task.runId, 'turn') && !ctl.accept(task.runId, 'other'), '一个投递只接受一次');
  ctl.stop();
  check(cancelled === 1 && !ctl.authorized(task.runId, 'turn') && clock.jobs.size === 0, '停止取消执行并拒绝迟到模型发送');
  assert.throws(function noRestart() { ctl.start(config); });
  checks++;
  ctl.finish(task.runId, { outcome: 'stopped', text: '已停', messages: [] });
  check(!ctl.snapshot().active && !ctl.snapshot().enabled, '旧轮结束后才释放执行槽');
  ctl.start(config); clock.advance(1000);
  const stale = task.runId;
  ctl.stop();
  check(!ctl.accept(stale, 'late') && !ctl.snapshot().active, '关闭时尚未接收的投递失效');
  ctl.start(config); clock.advance(1000); ctl.accept(task.runId, 'slow');
  clock.advance(3000);
  check(!ctl.snapshot().enabled && cancelled === 2 && /超时/.test(ctl.snapshot().error), '超时暂停且取消，不自动重做');
  ctl.finish(task.runId, { outcome: 'stopped', text: '超时已停' });
  for (let i = 0; i < 150; i++) {
    ctl.start(config); clock.advance(1000);
    ctl.accept(task.runId, 'run-' + i);
    ctl.finish(task.runId, { outcome: 'success', text: '第' + i + '轮进度' + '中'.repeat(9000), messages: [] });
  }
  check(ctl.snapshot().completed === 150 && ctl.snapshot().checkpoint.length === DEFAULTS.checkpointChars,
    '150 轮进度保留有界，完成次数正确');
  check(clock.jobs.size === 1 && !ctl.snapshot().active, '连续轮次后仅一个下次检查计时器');
  const page = await ctl.records();
  const older = await ctl.records(page.before);
  check(page.rows.length === 20 && older.rows.length === 20 && older.rows[19].n < page.rows[0].n,
    '归档分页真实读取且页间不重叠');
  check(page.rows[0].asstText.length === 6000, '归档预览有界');
  ctl.setContext([page.rows[0]]);
  check(ctl.snapshot().context.length === 1 && ctl.snapshot().omitCheckpoint, '上下文排除最近一轮确实关闭其进度注入');
  ctl.setContext([]);
  check(ctl.snapshot().context.length === 0 && ctl.snapshot().omitCheckpoint, '清空勾选后零已选上下文');
  assert.throws(function tooMany() { ctl.setContext(Array(21).fill(page.rows[0])); }); checks++;
  ctl.stop(); ctl.dispose();
  check(clock.jobs.size === 0, '释放后零定时器');
  const reloaded = createLongAlive(options);
  reloaded.bind('task', 'project');
  check(reloaded.snapshot().completed === 150 && reloaded.snapshot().goal === config.goal, '重建实例恢复真实目标与进度');
  reloaded.start(config); clock.advance(1000); reloaded.accept(task.runId, 'crash');
  const crashed = createLongAlive({ ...options, clock: fakeClock() });
  crashed.bind('task', 'project');
  check(!crashed.snapshot().enabled && /中断/.test(crashed.snapshot().error), '异常退出未完成轮暂停，避免重复发布');
  crashed.dispose(); reloaded.dispose();
  const broken = createLongAlive({ ...options, dir: path.join(dir, 'write-failure'), clock: fakeClock() });
  broken.bind('write-failure', 'project');
  const originalRename = fs.renameSync;
  function deniedRename() { throw Object.assign(new Error('EPERM_TEST'), { code: 'EPERM' }); }
  try {
    fs.renameSync = deniedRename;
    assert.throws(function failedWrite() { broken.start(config); }, /EPERM_TEST/);
    checks++;
  } finally { fs.renameSync = originalRename; }
  check(!broken.snapshot().enabled && /写入失败/.test(broken.snapshot().error),
    '真实状态写入失败明确暂停且不伪装开启成功');
  broken.dispose();
}

/** 使用实际主进程模块核对发送者隔离和窗口释放，不加载外部模型 SDK。 */
async function host() {
  const handlers = new Map();
  const w1 = {}, w2 = {};
  const root = path.join(dir, 'host');
  const app = { getPath: function userData() { return root; }, getAppMetrics: function memory() { return []; } };
  const api = registerLongAlive({ app, ipcMain: { handle: function handle(k, f) { handlers.set(k, f); } },
    getWin: function window(e) { return e.win; }, send: function send() {}, abort: function abort() {},
    activeTab: function tab() { return 'same'; }, workspace: function workspace() { return 'project'; },
    busy: function busy() { return false; }, turnTab: function turnTab() { return ''; } });
  handlers.get('long-alive:bind')({ win: w1 }, { tabId: 'same', workspace: 'project' });
  handlers.get('long-alive:bind')({ win: w2 }, { tabId: 'same', workspace: 'project' });
  handlers.get('long-alive:start')({ win: w1 }, { tabId: 'same', goal: '测试', intervalSeconds: 60, timeoutSeconds: 60 });
  assert.throws(function duplicate() {
    handlers.get('long-alive:start')({ win: w2 }, { tabId: 'same', goal: '测试', intervalSeconds: 60, timeoutSeconds: 60 });
  }); checks++;
  check(!handlers.get('long-alive:accept')({ win: w2 }, { runId: 'foreign', turnId: 'foreign' }),
    '其它窗口不能接收本窗口任务');
  api.release(w1);
  check(handlers.get('long-alive:status')({ win: w1 }).task === null, '窗口释放后 Map 不再持有任务');
  api.dispose();
}

/** 抽取生产发送与接收函数，连续执行自动轮次，检查草稿和消息对象数量。 */
async function renderer() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8').split('\r\n').join('\n');
  const send = source.slice(source.indexOf('function applyFinalResultToAssistant('), source.indexOf('/**\n * 将本地识别'));
  const resident = source.slice(source.indexOf('function isLongAliveMessage('), source.indexOf('/** 主进程投递回调'));
  const selected = [{ n: 9, userText: '已选历史', asstText: '已选结果' }];
  const tab = { id: 'task', workspace: 'project', title: '测试会话', messages: [
    { role: 'user', text: '手动需求' }, { role: 'assistant', text: '手动回复' }
  ], queue: [], pickedSkillIds: ['zabingsk'], workingMemory: { goal: '手动记忆' }, contextSummary: '手动摘要' };
  const state = { tabs: [tab], currentModelId: 'model', contextPaths: ['keep.js'], attachments: ['keep.png'],
    promptOverrides: { persona: '保留' } };
  let calls = 0;
  let finished = 0;
  const sandbox = { state, console, Set, Map, Date, documentTurns: new Set(),
    sessionData: function sessionData(item) { return { id: item.id, messages: item.messages }; },
    api: {
      longAliveAccept: async function accept() { return true; },
      /** 归档前先核对生产渲染函数提交的结果，失败时保留实际报错。 */
      longAliveFinish: async function finish(result) {
        assert.equal(result.outcome, 'success', result.error);
        finished++;
        check(result.messages.length === 2, '归档只包含当前自动轮');
      },
      chatRestoreConsumed: function consumed() {},
      chatSend: async function chat(payload) {
        calls++;
        assert.equal(payload.history.length, 2);
        assert.equal(payload.history[0].content, '已选历史');
        assert.equal(payload.contextSummary, '');
        assert.deepEqual(Object.keys(payload.workingMemory), []);
        assert.equal(payload.contextRevision, 'job-' + calls);
        assert.equal(payload.sysOverrides, undefined);
        assert.equal(payload.text.includes('被排除的最近进度'), false);
        return { text: '本轮完成', changes: [], workingMemory: { goal: '不能污染' }, contextSummary: '不能污染' };
      },
      listSnapshots: async function snapshots() { return []; },
      listMilestones: async function milestones() { return []; }
    },
    activeSession: function activeSession() { return tab; },
    isActiveTab: function active(value) { return value === tab; }, currentModel: function model() { return {}; },
    tabQueue: function queue(value) { return value.queue; },
    normalizeSkillIds: function ids(value) { return value.skillIds || []; },
    uid: function uid() { return 'turn-' + (calls + 1); },
    beginRefillResend: async function refill() {}, prefersReducedMotion: function reduced() { return true; },
    dialogRounds: function rounds() { return []; }, isNewChatTitle: function title() { return false; },
    t: function translate(value) { return value; }, extraFoldersOf: function extra() { return []; },
    roundsOf: function rounds() { return 16; }, emptyWorkingMemory: function memory() { return {}; },
    isStopError: function stop() { return false; }, localMilestoneHits: function hits() { return []; },
    slimMessagesForSave: function slim(messages) { return messages; },
    showLongAliveFailure: function failure(error) { throw error; }
  };
  for (const name of ['renderQueue','renderChips','renderTabs','renderMessages','scrollMessagesToBottom',
    'syncSendBtn','armStallWatch','logSummaryTrace','revealRest','clearStallWatch','finishTypewriter',
    'flushLivePaint','stopTypewriter','renderSidebar','persistTab','retryHotReload']) sandbox[name] = function noop() {};
  sandbox.markTurnFailed = function failed(_message, error) { throw error; };
  vm.createContext(sandbox);
  vm.runInContext(send + resident, sandbox);
  for (let i = 1; i <= 60; i++) {
    await sandbox.receiveLongAliveTask({ sessionId: tab.id, workspace: tab.workspace, runId: 'job-' + i,
      goal: '测试运营', context: selected, omitCheckpoint: true, checkpoint: '被排除的最近进度' });
    assert.equal(tab.messages.length, 4);
  }
  check(calls === 60 && finished === 60 && tab.messages.length === 4,
    '60 轮实际发送后界面始终仅手动历史和最近自动轮');
  check(state.promptOverrides.persona === '保留' && state.contextPaths[0] === 'keep.js' &&
    state.attachments[0] === 'keep.png' && tab.workingMemory.goal === '手动记忆' && tab.contextSummary === '手动摘要',
    '自动执行不消费草稿或污染手动记忆');
  check(!tab.liveAssistant && !tab.liveTurnId && !tab.draining && !tab.sending, '轮次结束释放界面执行引用');
}

/** 连续运行全部专项验证，输出可复核计数与产物目录。 */
async function main() {
  await scheduler(); await host(); await renderer();
  console.log(JSON.stringify({ checks, dir, result: 'passed' }));
}
main().catch(function failed(error) { console.error(error); process.exitCode = 1; });
