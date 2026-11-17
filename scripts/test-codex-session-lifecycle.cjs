'use strict';

/**
 * 验证 Codex 直通的进程收尾、同会话串行和 MCP 工具归属。
 * 执行：node scripts/test-codex-session-lifecycle.cjs
 * 测试执行完整生产适配器，只隔离模型创建、额度读取和诊断，不读取用户配置或请求外部服务。
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');

// 可传已构建适配器的路径，复用同一套生命周期断言核对实际交付文件。
const ADAPTER_PATH = path.resolve(process.argv[2] || path.join(__dirname, '..', 'electron', 'lib', 'codex-direct.js'));
// 超时只报告死锁，所有成功判断都来自退出闸门、事件或实际 HTTP 回执。
const TEST_TIMEOUT_MS = 15000;
let assertionCount = 0;
const failures = [];

/** 创建可人工交付的异步边界，不把经过时间当作任务已经完成。 */
function deferred() {
  let resolve;
  const promise = new Promise(function captureResolver(accept) {
    resolve = accept;
  });
  return { promise, resolve };
}

/** 等待一轮事件循环，让已触发的 Promise 续体和取消监听完成。 */
function nextTurn() {
  return new Promise(function scheduleNextTurn(resolve) {
    setImmediate(resolve);
  });
}

/** 验证真实行为并输出独立证据；失败立即交给当前场景的清理入口。 */
function check(message, condition) {
  assert.ok(condition, message);
  assertionCount += 1;
  console.log('通过：' + message);
}

/** 提前登记成功和失败处理，避免预期失败成为未处理的 Promise 拒绝。 */
function observe(promise) {
  const result = { settled: false, value: undefined, error: null, promise: null };
  function fulfilled(value) {
    result.settled = true;
    result.value = value;
    return result;
  }
  function rejected(error) {
    result.settled = true;
    result.error = error;
    return result;
  }
  result.promise = Promise.resolve(promise).then(fulfilled, rejected);
  return result;
}

/** 提供没有外部副作用的诊断出口。 */
function noop() {}

/** 额度样本明确表示尚未耗尽，禁止测试转入另一模型通道。 */
async function readFixtureQuota() {
  return { fixtureQuota: 'available' };
}

/** 根据已知样本返回额度状态，不连接账户服务。 */
function fixtureQuotaExhausted() {
  return false;
}

/** 测试未开启聊天额度通道，意外路由必须使测试失败。 */
async function unexpectedChatRun() {
  throw new Error('生命周期测试不应切换聊天额度通道');
}

/** 假聊天通道没有任务、会话或其他忙状态。 */
function fixtureChatBusy() {
  return false;
}

/** 假聊天通道不持有可关闭会话。 */
function fixtureCloseIdle() {
  return 0;
}

/**
 * 向生产 startBridge 发起真实本机 HTTP MCP 请求。
 * 返回完整 JSON 回执，让断言核对实际执行的工具及归属，而不是只检查源码。
 */
function requestTool(session, plan) {
  const body = JSON.stringify({
    method: 'tools/call',
    params: { name: 'fixture_probe', arguments: { tag: plan.tag }, toolCallId: plan.tag }
  });
  return new Promise(function sendRequest(resolve, reject) {
    const request = http.request({
      hostname: '127.0.0.1',
      port: session.bridge.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + session.bridge.token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, receiveResponse);
    function receiveResponse(response) {
      const chunks = [];
      function received(chunk) {
        chunks.push(chunk);
      }
      function completed() {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (response.statusCode !== 200) {
            reject(new Error('本机 MCP 回执失败：' + JSON.stringify(payload)));
            return;
          }
          resolve(payload);
        } catch (error) {
          reject(error);
        }
      }
      response.on('data', received);
      response.once('end', completed);
      response.once('error', reject);
    }
    request.once('error', reject);
    request.end(body);
  });
}

/**
 * 模拟 SDK 的事件生成器和真实退出时刻。
 * 正常消费会等 exit 闸门；提前关闭生成器只记录关闭，不把 writer 伪装成已经退出。
 */
async function* fixtureEvents(plan, state) {
  try {
    plan.started.resolve();
    await plan.beforeTool.promise;
    if (plan.withTool) {
      plan.toolResult = await requestTool(state.session, plan);
      plan.toolDone.resolve();
      yield { type: 'item.completed', item: { type: 'mcp_tool_call', tool: 'fixture_probe' } };
    } else {
      plan.toolDone.resolve();
    }
    if (plan.terminalType) {
      plan.terminalOffered.resolve();
      if (plan.terminalType === 'turn.failed') {
        yield { type: 'turn.failed', error: { message: plan.errorMessage } };
      } else {
        yield { type: 'error', message: plan.errorMessage };
      }
    }
    await plan.exit.promise;
    plan.drained = true;
    if (!plan.terminalType) {
      yield { type: 'item.completed', item: { type: 'agent_message', text: plan.tag + ' 已完成' } };
    }
  } finally {
    if (!plan.drained) plan.closedEarly = true;
    plan.iteratorClosed.resolve();
  }
}

/**
 * 模拟 thread.runStreamed；同一 thread 重入会报真实问题中的 active writer。
 * writer 只在退出闸门交付后释放，不能因为生成器被提前 return 就释放。
 */
async function fixtureRunStreamed(input) {
  const state = this.fixtureState;
  const harness = state.harness;
  const text = input[0].text;
  let plan = null;
  for (const candidate of harness.plans) {
    if (text.includes(candidate.tag)) {
      plan = candidate;
      break;
    }
  }
  assert.ok(plan, 'SDK 输入必须对应当前测试请求');
  harness.modelStarts.push({ key: state.key, tag: plan.tag });
  if (state.activeWriter) {
    harness.writerConflicts.push(plan.tag);
    throw new Error('thread-store conflict: thread fixture already has an active writer');
  }
  state.activeWriter = true;
  function exited() {
    state.activeWriter = false;
    plan.exited = true;
  }
  plan.exit.promise.then(exited);
  return { events: fixtureEvents(plan, state) };
}

/**
 * 创建隔离的生产适配器环境。
 * vm 追加口仅安装具名会话工厂、登记样本和查询队列；runTurn、桥及关闭函数均使用生产原实现。
 */
function createHarness() {
  const harness = {
    plans: [], sessions: [], outcomes: [], events: [], executions: [],
    modelStarts: [], writerConflicts: [], api: null
  };
  function fixtureRequire(id) {
    if (id === './diag') return { log: noop };
    if (id === './codex-env') return noop;
    if (id === './codex-model') {
      return { readRateLimitsFromAppServer: readFixtureQuota, fiveHourQuotaExhausted: fixtureQuotaExhausted };
    }
    if (id === './codex-chat-direct') {
      return { runTurn: unexpectedChatRun, closeSession: noop, busy: fixtureChatBusy, closeIdle: fixtureCloseIdle };
    }
    if (id === './training-recorder') return { note: noop };
    if (['http', 'crypto', 'os', 'path', 'fs'].includes(id)) return require(id);
    throw new Error('测试禁止加载未隔离依赖：' + id);
  }
  const moduleValue = { exports: {} };
  const sandbox = {
    module: moduleValue, exports: moduleValue.exports, require: fixtureRequire,
    __filename: ADAPTER_PATH, __dirname: path.dirname(ADAPTER_PATH),
    process, Buffer, console, AbortController, setImmediate, clearImmediate,
    setTimeout, clearTimeout, queueMicrotask
  };
  const access = [
    '',
    'module.exports.__fixture = {',
    '  installFactory: function installFactory(factory) { createSession = factory; },',
    '  registerSession: function registerSession(key, session) { sessions.set(key, session); },',
    '  bridge: startBridge,',
    "  queueSize: function queueSize() { return typeof turnQueues === 'undefined' ? null : turnQueues.size; }",
    '};'
  ].join('\n');
  vm.runInNewContext(fs.readFileSync(ADAPTER_PATH, 'utf8') + access, sandbox, { filename: ADAPTER_PATH });
  harness.api = moduleValue.exports;
  /** 只替换外部 SDK 创建；生产 HTTP 桥仍真正绑定本机随机端口。 */
  async function createFixtureSession(key, sig, modelCfg, tools) {
    const session = { sig, server: null, ctx: { tools, runTool: null }, thread: null, turns: 0 };
    const state = { harness, key, session, activeWriter: false };
    session.thread = { fixtureState: state, runStreamed: fixtureRunStreamed };
    session.bridge = await harness.api.__fixture.bridge(session);
    session.server = session.bridge.server;
    harness.sessions.push({ key, session });
    harness.api.__fixture.registerSession(key, session);
    return session;
  }
  harness.api.__fixture.installFactory(createFixtureSession);
  return harness;
}

/** 创建单次模型行为样本，退出和工具开始时刻均由当前场景明确控制。 */
function addPlan(harness, name, options) {
  const plan = {
    tag: '@@fixture:' + name + '@@',
    terminalType: options.terminalType || '',
    errorMessage: '原始终止错误：' + name,
    withTool: options.withTool === true,
    beforeTool: deferred(), started: deferred(), toolDone: deferred(),
    terminalOffered: deferred(), exit: deferred(), iteratorClosed: deferred(),
    drained: false, exited: false, closedEarly: false, toolResult: null
  };
  if (!options.blockTool) plan.beforeTool.resolve();
  harness.plans.push(plan);
  return plan;
}

/** 为当前请求配置自己的具名工具执行函数，实际归属由生产桥选择并执行。 */
function start(harness, key, plan, signal) {
  async function executeFixtureTool(name, args) {
    harness.executions.push({ owner: plan.tag, requested: args.tag, name });
    return '工具归属：' + plan.tag;
  }
  function onEvent(event) {
    harness.events.push({ owner: plan.tag, event });
  }
  const result = observe(harness.api.runTurn({
    key, sig: 'fixture-model', fresh: false,
    modelCfg: { model: 'fixture-model' },
    firstPrefix: '', systemContext: '', turnText: plan.tag, userContent: [],
    tools: [{
      type: 'function',
      function: {
        name: 'fixture_probe', description: '核对工具归属',
        parameters: { type: 'object', properties: { tag: { type: 'string' } }, required: ['tag'] }
      }
    }],
    runTool: executeFixtureTool, onEvent, signal, agiMode: true
  }));
  harness.outcomes.push(result);
  return result;
}

/** 核对实际 HTTP 文本和生产工具执行记录都属于当前请求。 */
function checkTool(harness, plan) {
  check(plan.tag + ' 的真实 HTTP 工具回执属于自身',
    plan.toolResult && !plan.toolResult.isError &&
    plan.toolResult.content[0].text === '工具归属：' + plan.tag);
  let matching = 0;
  for (const execution of harness.executions) {
    if (execution.requested === plan.tag) {
      matching += 1;
      check(plan.tag + ' 的执行上下文没有串入其他请求', execution.owner === plan.tag);
    }
  }
  check(plan.tag + ' 的成功工具只执行一次', matching === 1);
}

/** 队列实现存在时，核对所有已完成和取消的尾项都已清理。 */
async function checkIdle(harness) {
  await nextTurn();
  const size = harness.api.__fixture.queueSize();
  if (size !== null) check('已结束请求没有残留队列尾项', size === 0);
  check('全部请求结束后忙态解除', harness.api.busy() === false);
}

/** 等待服务器真正关闭；已经由生产错误处理关闭的服务器也能完成清理。 */
function closeServer(server) {
  return new Promise(function waitForClose(resolve) {
    function closed() {
      resolve();
    }
    server.close(closed);
  });
}

/** 先释放所有人为闸门，再等待请求收尾并关闭本场景创建的 HTTP 资源。 */
async function cleanup(harness) {
  for (const plan of harness.plans) {
    plan.beforeTool.resolve();
    plan.exit.resolve();
  }
  const pending = [];
  for (const outcome of harness.outcomes) pending.push(outcome.promise);
  await Promise.allSettled(pending);
  for (const record of harness.sessions) harness.api.closeSession(record.key);
  const closing = [];
  for (const record of harness.sessions) closing.push(closeServer(record.session.server));
  await Promise.all(closing);
}

/** 终止事件必须等待 SDK 自然消费完成，随后保留原错误。 */
async function testTerminalEvent(type) {
  const harness = createHarness();
  try {
    const plan = addPlan(harness, type, { terminalType: type });
    const result = start(harness, 'terminal', plan);
    await plan.terminalOffered.promise;
    await nextTurn();
    check(type + ' 事件不会在退出闸门之前拒绝请求', !result.settled);
    check(type + ' 等待退出期间仍保持忙态', harness.api.busy());
    check(type + ' 等待退出期间不能被 closeIdle 关闭', harness.api.closeIdle() === 0);
    plan.exit.resolve();
    await result.promise;
    check(type + ' 退出后返回原始事件错误', result.error && result.error.message === plan.errorMessage);
    check(type + ' 事件生成器正常消费到退出', plan.drained && !plan.closedEarly && plan.exited);
    await checkIdle(harness);
  } finally {
    await cleanup(harness);
  }
}

/** 同 key 请求先排队，首个工具延迟到排队后执行，以暴露 ctx 被覆盖的问题。 */
async function testSameKey() {
  const harness = createHarness();
  try {
    const first = addPlan(harness, 'same-first', { withTool: true, blockTool: true });
    const second = addPlan(harness, 'same-second', { withTool: true });
    const firstResult = start(harness, 'same-key', first);
    await first.started.promise;
    const secondResult = start(harness, 'same-key', second);
    await nextTurn();
    check('同 key 第二个请求尚未进入 runStreamed', harness.modelStarts.length === 1);
    check('同 key 排队不会触发 active writer', harness.writerConflicts.length === 0);
    check('同 key 排队期间 closeIdle 保持会话', harness.api.closeIdle() === 0);
    first.beforeTool.resolve();
    await first.toolDone.promise;
    checkTool(harness, first);
    check('首个工具成功后仍未越过真实退出边界', harness.modelStarts.length === 1);
    first.exit.resolve();
    await firstResult.promise;
    check('同 key 首个请求正常完成', !firstResult.error);
    await second.started.promise;
    await second.toolDone.promise;
    checkTool(harness, second);
    second.exit.resolve();
    await secondResult.promise;
    check('同 key 后继请求正常完成', !secondResult.error);
    check('同 key 没有重复执行已成功工具', harness.executions.length === 2);
    await checkIdle(harness);
    check('完成后 closeIdle 能回收同 key 会话', harness.api.closeIdle() === 1);
  } finally {
    await cleanup(harness);
  }
}

/** 不同 key 应并行执行，并且一个完成不会关闭另一个仍在运行的会话。 */
async function testDifferentKeys() {
  const harness = createHarness();
  try {
    const first = addPlan(harness, 'parallel-first', { withTool: true });
    const second = addPlan(harness, 'parallel-second', { withTool: true });
    const firstResult = start(harness, 'parallel-a', first);
    const secondResult = start(harness, 'parallel-b', second);
    await Promise.all([first.started.promise, second.started.promise]);
    check('不同 key 的两个 runStreamed 可以并行进入', harness.modelStarts.length === 2);
    await Promise.all([first.toolDone.promise, second.toolDone.promise]);
    checkTool(harness, first);
    checkTool(harness, second);
    first.exit.resolve();
    await firstResult.promise;
    check('另一个 key 尚未退出时请求仍未结束', !secondResult.settled);
    check('另一个 key 运行期间 closeIdle 不回收会话', harness.api.closeIdle() === 0);
    second.exit.resolve();
    await secondResult.promise;
    check('不同 key 的请求都能正常完成', !firstResult.error && !secondResult.error);
    await checkIdle(harness);
    check('全部退出后 closeIdle 回收两个独立会话', harness.api.closeIdle() === 2);
  } finally {
    await cleanup(harness);
  }
}

/** 前序失败仍须等真实退出，再释放后继；成功过的工具不能被重投。 */
async function testFailureReleasesQueue() {
  const harness = createHarness();
  try {
    const first = addPlan(harness, 'failure-first', { terminalType: 'turn.failed', withTool: true });
    const second = addPlan(harness, 'failure-second', { withTool: true });
    const firstResult = start(harness, 'failure-key', first);
    await first.terminalOffered.promise;
    const secondResult = start(harness, 'failure-key', second);
    await nextTurn();
    check('前序失败事件尚未退出时后继仍排队', harness.modelStarts.length === 1);
    first.exit.resolve();
    await firstResult.promise;
    check('排队包装没有吞掉前序原错误', firstResult.error && firstResult.error.message === first.errorMessage);
    await second.started.promise;
    await second.toolDone.promise;
    second.exit.resolve();
    await secondResult.promise;
    check('前序失败后后继可以正常完成', !secondResult.error);
    checkTool(harness, first);
    checkTool(harness, second);
    check('失败后没有重放此前成功的工具', harness.executions.length === 2);
    check('失败后的后继没有 active writer 冲突', harness.writerConflicts.length === 0);
    await checkIdle(harness);
  } finally {
    await cleanup(harness);
  }
}

/** 排队者取消应立即返回，但不能提前放行它后面的请求。 */
async function testQueuedAbort() {
  const harness = createHarness();
  try {
    const first = addPlan(harness, 'abort-first', {});
    const cancelled = addPlan(harness, 'abort-cancelled', { withTool: true });
    const last = addPlan(harness, 'abort-last', { withTool: true });
    const controller = new AbortController();
    const firstResult = start(harness, 'abort-key', first);
    await first.started.promise;
    const cancelledResult = start(harness, 'abort-key', cancelled, controller.signal);
    const lastResult = start(harness, 'abort-key', last);
    await nextTurn();
    check('取消前同 key 等待者尚未进入 SDK', harness.modelStarts.length === 1);
    controller.abort();
    await nextTurn();
    check('排队请求取消后立即返回', cancelledResult.settled);
    check('排队取消返回 AbortError', cancelledResult.error && cancelledResult.error.name === 'AbortError');
    check('取消者和后继都没有越过首个退出闸门', harness.modelStarts.length === 1);
    check('排队取消不能使 closeIdle 关闭仍在执行的会话', harness.api.closeIdle() === 0);
    first.exit.resolve();
    await firstResult.promise;
    await last.started.promise;
    await last.toolDone.promise;
    last.exit.resolve();
    await lastResult.promise;
    check('取消者之后的请求仍能正常完成', !firstResult.error && !lastResult.error);
    check('被取消的请求从未进入 runStreamed', harness.modelStarts.length === 2);
    check('被取消请求没有执行任何工具', harness.executions.length === 1);
    checkTool(harness, last);
    check('取消及后继没有触发 active writer', harness.writerConflicts.length === 0);
    await checkIdle(harness);
  } finally {
    await cleanup(harness);
  }
}

/** 每个场景独立报告，单项失败后仍继续收集其他行为证据。 */
async function runCase(name, test) {
  try {
    await test();
    console.log('场景通过：' + name);
  } catch (error) {
    failures.push({ name, error });
    console.error('场景失败：' + name + '\n' + (error.stack || error));
  }
}

/** 具名入口分别覆盖两种终止事件，避免匿名回调隐藏测试职责。 */
async function testErrorEvent() {
  await testTerminalEvent('error');
}

/** turn.failed 与 error 必须遵守相同的真实退出边界。 */
async function testFailedEvent() {
  await testTerminalEvent('turn.failed');
}

/** 只在整体截止时报告死锁；截止时间不会成为任何通过条件。 */
function timedOut() {
  console.error('Codex 会话生命周期测试超时：仍有退出闸门、排队请求或本机 HTTP 资源未结束。');
  process.exit(1);
}

/** 顺序运行隔离场景，所有 HTTP 资源均由场景自己的 finally 释放。 */
async function main() {
  const timer = setTimeout(timedOut, TEST_TIMEOUT_MS);
  try {
    await runCase('error 事件等待真实退出', testErrorEvent);
    await runCase('turn.failed 事件等待真实退出', testFailedEvent);
    await runCase('同 key 串行及真实 HTTP 工具归属', testSameKey);
    await runCase('不同 key 保持并行', testDifferentKeys);
    await runCase('前序失败释放后继', testFailureReleasesQueue);
    await runCase('排队取消不提前释放队列', testQueuedAbort);
    console.log('生命周期验收：' + assertionCount + ' 条断言通过，' + failures.length + ' 个场景失败。');
    if (failures.length) process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
}

/** 入口错误保留完整堆栈，并向命令行返回失败退出码。 */
function reportFailure(error) {
  console.error(error.stack || error);
  process.exitCode = 1;
}

main().catch(reportFailure);
