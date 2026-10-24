/**
 * 验证 AGI 插话实际进入普通模型请求及 Codex MCP 工具结果，不访问外部模型。
 * 独立 Electron 进程执行真实 Agent 入口、直通适配器与本地 HTTP 桥，失败返回非零退出码。
 */
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
let checks = 0;
const unexpected = [];
/** 将异步异常纳入验收，避免正常退出掩盖后台错误。 */
function unhandled(error) { unexpected.push(error); }
process.on('unhandledRejection', unhandled);
/** 每条断言输出可复核的行为证据。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 测试不持有真实窗口或模型资源。 */
function noop() {}
/** 加载真实 Agent，仅隔离模型传输、桌面观察与用户配置。 */
function loadAgent() {
  const file = path.join(root, 'electron/lib/agent.js');
  const localRequire = createRequire(file);
  let alive = true;
  let complete;
  function desktopOn() { return alive; }
  function settings() { return { locale: 'zh', desktopAlive: alive, models: [], providers: [] }; }
  async function modelCall(args) { return complete(args); }
  function dependency(name) {
    if (name === './desktop-hand') return { isAlive: desktopOn };
    if (name === './store') return { ...localRequire(name), load: settings };
    if (name === './api-protocol') return { normalizeProtocol: function identity(value) { return value; }, complete: modelCall };
    if (name === './screen-text-map') return {
      observe: async function observe() { return {}; }, formatBlock: function formatBlock() { return '验收屏幕'; },
      applyToMessages: noop
    };
    if (name === './agi-throttle') return { setNotify: noop };
    if (name === './diag') return { log: noop };
    return localRequire(name);
  }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval };
  const source = fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
  vm.runInNewContext(source + '\nmodule.exports.test = { runDirectWithInterjections, takeInterjections, activeInterjectKeys, agentLoop, requirementText };',
    context, { filename: file });
  const agent = context.module.exports;
  function setAlive(value) { alive = value; }
  function setComplete(value) { complete = value; }
  return { agent, source, dependency, setAlive, setComplete, lang: localRequire('./reply-lang').fromLocale('zh') };
}
/** 把真实 runBrain 放进受控外层，验证生产入口确实注册收件与调用直通插话适配。 */
function brainHarness(harness, direct, key, directOn = true) {
  const start = harness.source.indexOf('  async function runBrain(loopMessages, startOrdered) {');
  const end = harness.source.indexOf('\n  // 方案树逐条执行', start);
  assert.ok(start >= 0 && end > start);
  const events = [];
  function onEvent(event) { events.push(event); }
  const context = {
    require: harness.dependency, crypto: require('node:crypto'),
    activeInterjectKeys: harness.agent.test.activeInterjectKeys,
    runDirectWithInterjections: harness.agent.test.runDirectWithInterjections,
    agentLoop: harness.agent.test.agentLoop,
    desktopOn: function desktopOn() { return true; },
    interjectKey: key, directOn, codexDirectOn: true, codexDirect: direct,
    cursorDirect: { textOf: function textOf(value) { return String(value || ''); } },
    directWrites: false, turnStart: false, modelCfg: { protocol: 'codex', model: 'fixture' },
    workspace: '', extra: [], snap: { readOnly: false }, trackEvent: onEvent, onEvent,
    signal: new AbortController().signal, lang: harness.lang, workingMemoryRef: null,
    waitForUserAnswer: null, roundLimit: 5, unlimitedRounds: true,
    loopTools: [], loopWorkers: null, wantPlanning: false, userText: '请核对当前任务',
    directProtocol: 'codex', codeWorker: null, planningWorker: null,
    rules: [], skill: null, persona: '', contextRevision: '',
    toolsFor: function toolsFor() { return [{ function: { name: 'read_file', parameters: { type: 'object' } } }]; },
    MUTATE_FILE_TOOLS: new Set(),
    directRunTool: async function tool(name, args) { return '真实工具结果:' + name + ':' + args.path; }
  };
  vm.runInNewContext(harness.source.substring(start, end) + '\nthis.runBrain = runBrain;', context);
  return { run: context.runBrain, context, events };
}
/** 测试消息保持独立，不继承其他会话正文。 */
function messages() { return [{ role: 'system', content: '测试规则' }, { role: 'user', content: '继续当前任务' }]; }
/** 工具开始前的补充必须阻止旧动作执行，随后允许模型按新消息重新决策。 */
async function testBeforeTool(harness) {
  let executions = 0;
  async function directRun(args) {
    check(harness.agent.pushInterjection('before', '先解释一下，不要修改文件'), '真实 runBrain 接受执行中插话');
    const response = await args.runTool('read_file', { path: 'fixture' });
    check(response.includes('先解释一下，不要修改文件') && response.includes('尚未执行'), '新工具开始前先把插话交给模型');
    const next = await args.runTool('read_file', { path: 'confirmed' });
    check(next === '已执行', '已读取插话后模型可以重新调用工具');
    return { content: '收到补充，先解释。' };
  }
  const brain = brainHarness(harness, { runTurn: directRun }, 'before');
  brain.context.directRunTool = async function execute() { executions++; return '已执行'; };
  const answer = await brain.run(messages(), false);
  check(answer.includes('收到补充') && executions === 1, '旧动作未执行，重新决策只执行一次');
  check(!harness.agent.pushInterjection('before', '收尾之后的消息'), '大脑退出后不假报接收，交给界面排队');
}
/** 执行期间到达的多条补充随结果返回，其他会话的插话不会混入。 */
async function testDuringTool(harness) {
  harness.agent.test.activeInterjectKeys.add('other');
  harness.agent.pushInterjection('other', '另一个会话的消息');
  async function directRun(args) {
    const response = await args.runTool('read_file', { path: 'fixture' });
    check(response.includes('原工具完整结果') && response.includes('第一条补充') && response.includes('第二条补充'),
      '工具执行中的插话与完整工具结果一起送给模型');
    check(response.indexOf('第一条补充') < response.indexOf('第二条补充'), '连续插话保持发送顺序');
    check(!response.includes('另一个会话'), '并发会话不会串话');
    const next = await args.runTool('read_file', { path: 'next' });
    check(!next.includes('【用户实时插话】'), '已经投递的插话不重复注入');
    return { content: '已按补充继续' };
  }
  const brain = brainHarness(harness, { runTurn: directRun }, 'during');
  let calls = 0;
  brain.context.directRunTool = async function execute() {
    calls++;
    if (calls === 1) {
      harness.agent.pushInterjection('during', '第一条补充');
      await Promise.resolve();
      harness.agent.pushInterjection('during', '第二条补充');
    }
    return '原工具完整结果';
  };
  await brain.run(messages(), false);
  check(harness.agent.test.takeInterjections('other')[0] === '另一个会话的消息', '本轮不会清掉其他会话消息');
  harness.agent.test.activeInterjectKeys.delete('other');
}
/** 无工具生成与 SDK 收尾时的插话自动续接同一会话，停止不触发自动续接。 */
async function testCompletion(harness) {
  let calls = 0;
  async function directRun(args) {
    calls++;
    if (calls === 1) {
      harness.agent.pushInterjection('completion', '刚才那点请再说明');
      return { content: '原答复' };
    }
    check(args.key === 'completion' && args.fresh === false, '收尾插话沿用原会话');
    check(args.turnText.includes('刚才那点请再说明') && args.firstPrefix === '' && args.systemContext === '',
      '续接只发送新插话，保留会话已有上下文');
    check(args.requiredToolNames.length === 0 && args.userContent === '', '续接不会重复原任务强制工具或附件');
    return { content: '这是补充说明' };
  }
  const brain = brainHarness(harness, { runTurn: directRun }, 'completion');
  check(await brain.run(messages(), false) === '这是补充说明' && calls === 2, '无工具回复中的插话不会被收尾清空');
  check(brain.events.some(function delivered(event) { return event.text === '插话已送达 AI，正在继续处理…'; }),
    '界面有实际投递状态');
  const delivered = brain.events.filter(function interjection(event) { return event.type === 'interjection'; });
  const requirement = harness.agent.test.requirementText('原始目标', [], false, delivered[0].texts);
  check(delivered.length === 1 && requirement.includes('原始目标') && requirement.includes('刚才那点请再说明'),
    '已送达插话同步加入总结需求，不再只按旧目标验收');
  const ctl = new AbortController();
  async function aborted() { harness.agent.pushInterjection('abort', '停止期间插话'); ctl.abort(); return { content: '停止' }; }
  const stopping = brainHarness(harness, { runTurn: aborted }, 'abort');
  stopping.context.signal = ctl.signal;
  await assert.rejects(stopping.run(messages(), false), { name: 'AbortError' });
  check(!harness.agent.test.activeInterjectKeys.has('abort'), '停止释放收件状态，不自动重启任务');
  harness.agent.test.takeInterjections('abort');
}
/** 真实普通循环在请求返回时检查插话，不把尚未读取的消息当成已经处理。 */
async function testOrdinary(harness) {
  let calls = 0;
  async function complete(args) {
    calls++;
    if (calls === 1) {
      harness.agent.pushInterjection('ordinary', '普通模式请求中补充');
      return { role: 'assistant', content: '原答复' };
    }
    check(args.messages.some(function included(message) { return message.role === 'user' && message.content === '普通模式请求中补充'; }),
      '普通循环的下一次模型请求含完整插话');
    return { role: 'assistant', content: '已收到普通补充' };
  }
  harness.setComplete(complete);
  const brain = brainHarness(harness, null, 'ordinary', false);
  brain.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
  // 保留已有工具上下文；其他 AGI 读屏与收尾门槛仍按生产实现运行。
  const ordinaryMessages = messages();
  ordinaryMessages.push({ role: 'assistant', tool_calls: [{ id: 'screen', type: 'function', function: { name: 'screen_read', arguments: '{}' } }] });
  ordinaryMessages.push({ role: 'tool', tool_call_id: 'screen', content: '验收屏幕' });
  const answer = await brain.run(ordinaryMessages, false);
  check(answer === '已收到普通补充' && calls > 1, '普通模型无工具收尾同样不吞插话');
}
/** 在真实 Codex 适配器与本地 HTTP MCP 桥上验证正文传输，无需厂商凭据。 */
async function testCodexBridge(harness) {
  const file = path.join(root, 'electron/lib/codex-direct.js');
  const localRequire = createRequire(file);
  function dependency(name) { if (name === './diag') return { log: noop }; return localRequire(name); }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file), process, console, Buffer };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.test = { sessions, startBridge };', context, { filename: file });
  const codex = context.module.exports;
  const key = 'bridge';
  const session = { sig: 'fixture\nagi:true\nreasoning:high', ctx: null, turns: 0 };
  const bridge = await codex.test.startBridge(session);
  session.server = bridge.server;
  async function* events() {
    const response = await fetch('http://127.0.0.1:' + bridge.port + '/mcp', {
      method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'tools/call', params: { name: 'read_file', arguments: { path: 'fixture' } } })
    });
    const body = await response.json();
    check(response.ok && body.content[0].text.includes('桥接期间插话') && body.content[0].text.includes('HTTP工具结果'),
      '真实 Codex HTTP MCP 返回值携带用户插话及工具结果');
    yield { type: 'item.completed', item: { type: 'agent_message', text: '模型已读取桥接插话' } };
  }
  session.thread = { runStreamed: async function runStreamed() { return { events: events() }; } };
  codex.test.sessions.set(key, session);
  harness.agent.test.activeInterjectKeys.add(key);
  async function runTool() { harness.agent.pushInterjection(key, '桥接期间插话'); return 'HTTP工具结果'; }
  try {
    const result = await harness.agent.test.runDirectWithInterjections(codex, {
      key, sig: 'fixture', modelCfg: {}, tools: [{ name: 'read_file', parameters: { type: 'object' } }],
      runTool, onEvent: noop, signal: new AbortController().signal, agiMode: true, turnText: '验收'
    }, key);
    check(result.content === '模型已读取桥接插话' && session.turns === 1, 'Codex 原会话单轮收到插话，无额外模型轮询');
  } finally {
    codex.closeSession(key);
    harness.agent.test.activeInterjectKeys.delete(key);
  }
}
/**
 * 执行真实主窗 IPC 和悬浮栏入口，验证两处都向同一会话投递并在收尾时退回发送队列。
 * 只替换窗口对象与 Electron 注册器，不启动真实聊天。
 */
async function testRoutes(harness) {
  const source = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8').split('\r\n').join('\n');
  const floatStart = source.indexOf('function handleFloatBarSend(payload) {');
  const floatEnd = source.indexOf('\n}\n', floatStart);
  const ipcStart = source.indexOf("ipcMain.handle('chat:interject',");
  assert.ok(floatStart >= 0 && floatEnd > floatStart && ipcStart >= 0);
  const window = {};
  const broadcasts = [];
  const queued = [];
  const handlers = new Map();
  const context = {
    fs, path, agent: harness.agent,
    ipcMain: { handle: function handle(name, handler) { handlers.set(name, handler); } },
    getWin: function getWin() { return window; },
    resolveTurnTabId: function tabId(win, payload) { return payload.tabId; },
    makeSessionKey: function key(win, tabId) { return 'route:' + tabId; },
    broadcastToFloatBars: function broadcast(payload) { broadcasts.push(payload); },
    diag: { log: noop },
    winFromKey: function winFromKey() { return window; },
    turnIsRunning: function running() { return true; },
    sendTo: function sendTo(win, channel, payload) { queued.push({ channel, payload }); }
  };
  vm.runInNewContext(source.substring(floatStart, floatEnd + 3) + '\n' + source.substring(ipcStart), context);
  const key = 'route:tab';
  harness.agent.test.activeInterjectKeys.add(key);
  try {
    const reply = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '主窗插话' });
    context.handleFloatBarSend({ key, text: '小窗插话' });
    const inbox = harness.agent.test.takeInterjections(key);
    check(reply.ok && inbox.join('|') === '主窗插话|小窗插话', '真实主窗 IPC 与悬浮栏入口投递同一会话');
    check(broadcasts.some(function status(item) { return item.kind === 'status' && item.text.includes('已接收'); }),
      '接收状态与投递状态分开显示');
    check(queued.length === 1 && queued[0].channel === 'chat:float-user-message' &&
      queued[0].payload.interjection === true && queued[0].payload.tabId === 'tab' && queued[0].payload.text === '小窗插话',
      '成功的小窗插话回传绑定会话登记历史，不重复投递');
    queued.length = 0;
    harness.agent.test.activeInterjectKeys.delete(key);
    const ended = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '收尾补充' });
    context.handleFloatBarSend({ key, text: '小窗收尾补充' });
    check(!ended.ok && queued.length === 1 && queued[0].payload.text === '小窗收尾补充',
      '主窗和小窗在收尾阶段都保留补充并转交正常队列');
    const empty = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '  ' });
    check(!empty.ok && empty.reason === 'empty', '空消息不报告已接收');
  } finally {
    harness.agent.test.activeInterjectKeys.delete(key);
  }
}
/** 顺序核对普通循环、生产直通入口、工具边界、会话隔离、停止和 MCP 传输。 */
async function main() {
  await app.whenReady();
  const harness = loadAgent();
  check(!harness.agent.pushInterjection('idle', '空闲消息'), '空闲会话不接受无法消费的插话');
  harness.agent.test.activeInterjectKeys.add('disabled');
  harness.setAlive(false);
  check(!harness.agent.pushInterjection('disabled', 'AGI关闭消息'), 'AGI关闭仍保留排队语义');
  harness.setAlive(true);
  harness.agent.test.activeInterjectKeys.delete('disabled');
  await testBeforeTool(harness);
  await testDuringTool(harness);
  await testCompletion(harness);
  await testOrdinary(harness);
  await testCodexBridge(harness);
  await testRoutes(harness);
  check(unexpected.length === 0, '没有未处理异步异常');
  console.log('RESULT ' + JSON.stringify({ checks, failures: 0, unhandled: unexpected.length }));
  app.exit(0);
}
/** 断言失败必须保留堆栈与失败退出码。 */
function failed(error) { console.error(error.stack || error); app.exit(1); }
main().catch(failed);
