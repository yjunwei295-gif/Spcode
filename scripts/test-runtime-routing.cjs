/**
 * 用生产模型循环和受控传输核对按需观察：问答不截图，状态任务一次工具等待。
 * 外部模型只替换传输响应，工具执行入口和提示生成保持真实实现。
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'runtime-routing-'));
app.setPath('userData', path.join(output, 'user-data'));
let checks = 0;
/** 每项断言都来自实际循环行为。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 载入真实 Agent，仅隔离外部传输和本机读屏，记录任何非必要观察。 */
function harness() {
  const file = path.join(root, 'electron/lib/agent.js');
  const local = createRequire(file);
  let transport;
  let screenCalls = 0;
  let stateCalls = 0;
  function alive() { return true; }
  function epoch() { return 1; }
  async function read(query) {
    stateCalls++;
    return { ok: true, source: query.source, identity: 'windows', startedAt: Date.now(), observedAt: Date.now(), records: {} };
  }
  function observe() { screenCalls++; throw new Error('不应自动截图'); }
  function noop() {}
  function dependency(name) {
    if (name === './desktop-hand') return { isAlive: alive, runtimeEpoch: epoch, readRuntimeState: read };
    if (name === './api-protocol') return { ...local(name), complete };
    if (name === './screen-text-map') return { observe, applyToMessages: noop, formatBlock: String };
    if (name === './diag') return { log: noop };
    return local(name);
  }
  async function complete(args) { return transport(args); }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.loopTest = agentLoop;', context, { filename: file });
  function setTransport(value) { transport = value; }
  function counts() { return { screenCalls, stateCalls }; }
  return { agent: context.module.exports, setTransport, counts, lang: local('./reply-lang').fromLocale('zh') };
}
/** 不执行网络或操作用户窗口，覆盖普通问答及明确的状态检查任务。 */
async function main() {
  await app.whenReady();
  const h = harness();
  const events = [];
  function event(value) { events.push(value); }
  const common = { modelCfg: { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' },
    workspace: root, extra: [], onEvent: event, signal: new AbortController().signal, lang: h.lang,
    maxRounds: 4, workers: null, roleTag: 'brain', depth: 0, unlimitedRounds: true };
  let turns = 0;
  async function question(args) {
    turns++;
    check(args.toolChoice === null, '普通问答不强制任何桌面工具');
    return { role: 'assistant', content: '内存扫描按条件查找目标数据。' };
  }
  h.setTransport(question);
  const answer = await h.agent.loopTest({ ...common, snap: { current: null, readOnly: true },
    userOrder: '解释一下内存扫描的原理', startOrdered: false,
    messages: [{ role: 'system', content: '回答问题。' }, { role: 'user', content: '解释一下内存扫描的原理' }] });
  console.log(JSON.stringify({ question: { answer, turns, counts: h.counts(), events } }));
  check(answer.includes('按条件') && turns === 1 && h.counts().screenCalls === 0, '普通问答一次模型响应完成且不采集屏幕');
  turns = 0;
  await h.agent.loopTest({ ...common, snap: { current: null, readOnly: false },
    userOrder: '解释一下内存扫描的原理', startOrdered: false,
    messages: [{ role: 'system', content: '回答问题。' }, { role: 'user', content: '解释一下内存扫描的原理' }] });
  check(turns === 1 && h.counts().screenCalls === 0, '允许写入的 AGI 会话中普通问答同样不触发无意义工具重试');
  turns = 0;
  async function stateTask(args) {
    turns++;
    if (turns === 1) {
      check(args.toolChoice === 'required', '明确开工仍要求实际调用工具');
      return { role: 'assistant', content: '', tool_calls: [{ id: 'state', type: 'function',
        function: { name: 'runtime_state', arguments: JSON.stringify({ action: 'snapshot', source: 'windows' }) } }] };
    }
    check(args.toolChoice !== 'required', '已有状态证据后不强制补截图');
    const record = args.messages.find(isTool);
    check(record && record.content.includes('snapshotId') && record.content.includes('evidencePath'), '模型收到结构化原始工具结果和证据入口');
    return { role: 'assistant', content: '状态已核对。' };
  }
  h.setTransport(stateTask);
  const state = await h.agent.loopTest({ ...common, snap: { current: null, readOnly: false },
    userOrder: '核对窗口状态', startOrdered: true,
    messages: [{ role: 'system', content: '核对状态。' }, { role: 'user', content: '核对窗口状态' }] });
  check(state.includes('已核对') && turns === 2 && h.counts().stateCalls === 1 && h.counts().screenCalls === 0,
    '状态任务一次工具执行与两次模型请求，无自动 OCR 或重复工具轮询');
  const pressure = require('../electron/lib/brain-pressure');
  check(!pressure.promptBlock(root, false, true).includes('必须先调用 screen_read'), '自主模式提示不再强制截图');
  const tail = h.agent.composePromptTail({ agiNow: true, lang: h.lang, modelCfg: { model: 'fixture' }, codexDirectOn: true });
  check(tail.includes('runtime_state') && !tail.includes('必须先调用 screen_read'), '直通模式提示包含状态工具与按需视觉观察');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, counts: h.counts(), events: events.length }, null, 2));
  console.log(JSON.stringify({ checks, output: path.relative(root, output) }));
  app.exit(0);
}
/** 只定位这次模型收到的工具消息。 */
function isTool(message) { return message.role === 'tool' && message.tool_call_id === 'state'; }
main().catch(function failed(error) { console.error(error.stack || error); app.exit(1); });
