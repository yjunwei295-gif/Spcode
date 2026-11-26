/**
 * 验证 AGI 插话进入普通模型请求或 Codex 续接的用户消息，以及 MCP 原样返回在途工具结果。
 * 独立 Electron 进程执行真实 Agent 入口、直通适配器与本地 HTTP 桥，失败返回非零退出码。
 */
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
// 直接运行时可指定已构建的 resources/app；被实拍夹具引用时沿用源码根目录。
const invokedDirectly = typeof process.argv[1] === 'string' && path.resolve(process.argv[1]) === __filename;
const bundleRoot = invokedDirectly && process.argv[2];
const root = path.resolve(bundleRoot || path.join(__dirname, '..'));
// 指定发布目录时沿用真实发布边界；采集实现本来就不随包分发，不能以开发身份加载它。
if (bundleRoot) Object.defineProperty(app, 'isPackaged', { value: true });
let checks = 0;
const unexpected = [];
/** 将异步异常纳入验收，避免正常退出掩盖后台错误。 */
function unhandled(error) { unexpected.push(error); }
process.on('unhandledRejection', unhandled);
/** 每条断言输出可复核的行为证据。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/**
 * 核对模型收到的目录和同一请求注册的工具名逐项一致。
 * @param {string} content 包含目录的系统文本。
 * @param {Array<object>} specs 模型实际注册的函数或直通工具。
 */
function verifyToolCatalog(content, specs) {
  assert.match(content, /【本次请求注册的 SpCode 工具】/);
  const lines = content.split('【本次请求注册的 SpCode 工具】')[1].split('\n');
  const names = [];
  for (const line of lines) {
    if (line.startsWith('- ')) names.push(line.slice(2).split('：', 1)[0]);
  }
  assert.deepEqual(names, Array.from(specs, function name(spec) { return (spec.function || spec).name; }));
}

/** 仅运行局部模型循环的夹具按真实收件契约提供独立的插话账本。 */
function testInbox(key) {
  const { InterjectionTodos } = require('../electron/lib/interjection-todos');
  return new InterjectionTodos({ current: { interjectionTodos: [] } }, key, noop);
}

/** 测试不持有真实窗口或模型资源。 */
function noop() {}
/** 加载真实 Agent，仅隔离模型传输、桌面观察与用户配置。 */
function loadAgent(overrides = {}) {
  const file = path.join(root, 'electron/lib/agent.js');
  const localRequire = createRequire(file);
  let alive = true;
  let complete;
  function desktopOn() { return alive; }
  function settings() { return { locale: 'zh', desktopAlive: alive, models: [], providers: [] }; }
  /**
   * 将生产模型请求交给当前测试场景注册的应答函数。
   * @param {object} args 生产调用参数，含消息与工具接口。
   * @returns {Promise<object>} 场景的模型回包，场景抛出的异常原样传给 Agent。
   */
  async function modelCall(args) { return complete(args); }
  /**
   * 为真实 Agent 加载当前场景需要的依赖。
   * @param {string} name Agent 中的模块请求路径。
   * @returns {unknown} 隔离的桌面、模型或配置接口，其他模块由 Agent 原有的加载入口提供。
   */
  function dependency(name) {
    if (Object.hasOwn(overrides, name)) return overrides[name];
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
  // 生产大脑与并发模块共用 Map 构造器，保证已派目标表能通过模块间的类型检查。
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
    Map, process, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval };
  const source = fs.readFileSync(file, 'utf8').split('\r\n').join('\n');
  vm.runInNewContext(source + '\nmodule.exports.test = { runDirectWithInterjections, takeInterjections, waitForBatchOrInterjection, settleDeferredBatches, activeInterjectKeys, interjectInbox, interjectInFlight, interjectArchives, agentLoop, requirementText, unfinishedTaskTodos, agiContinuationPrompt, stillWorking, promisesMoreInvestigation, abortErr, execTool, recordTaskTodoIds, answerParts, askAnswerIsStart, withholdUnverifiedDelivery, implementationStateKey, runParallelAgi };',
    context, { filename: file });
  const agent = context.module.exports;
  function setAlive(value) { alive = value; }
  function setComplete(value) { complete = value; }
  return { agent, source, dependency, setAlive, setComplete, lang: localRequire('./reply-lang').fromLocale('zh') };
}
/**
 * 把真实 runBrain 放进受控外层，验证生产插话和任务续跑入口。
 * @param {object} harness 真实 Agent 源码、测试导出与隔离依赖。
 * @param {object|null} direct 直通适配器测试对象；普通模型分支传 null。
 * @param {string} key 当前测试独立的会话键，不与其他场景共享插话或清单。
 * @param {boolean} directOn 是否执行直通分支，省略时为 true。
 * @returns {object} run 执行真实大脑方法，context 可注入本例依赖，events 保存该会话的真实事件。
 */
function brainHarness(harness, direct, key, directOn = true) {
  const start = harness.source.indexOf('  async function runBrain(');
  const end = harness.source.indexOf('\n  // 方案树逐条执行', start);
  assert.ok(start >= 0 && end > start);
  const events = [];
  function onEvent(event) { events.push(event); }
  const context = {
    require: harness.dependency, crypto: require('node:crypto'),
    activeInterjectKeys: harness.agent.test.activeInterjectKeys,
    interjectInbox: harness.agent.test.interjectInbox, inboxKey: key,
    interjectInFlight: harness.agent.test.interjectInFlight,
    interjectionTrace: [], directProgressText: '',
    runDirectWithInterjections: harness.agent.test.runDirectWithInterjections,
    waitForBatchOrInterjection: harness.agent.test.waitForBatchOrInterjection,
    settleDeferredBatches: harness.agent.test.settleDeferredBatches,
    agentLoop: harness.agent.test.agentLoop,
    unfinishedTaskTodos: harness.agent.test.unfinishedTaskTodos,
    agiContinuationPrompt: harness.agent.test.agiContinuationPrompt,
    runParallelAgi: harness.agent.test.runParallelAgi,
    stillWorking: harness.agent.test.stillWorking,
    promisesMoreInvestigation: harness.agent.test.promisesMoreInvestigation,
    abortErr: harness.agent.test.abortErr,
    history: [],
    directSessionSignature: '',
    turnInterjections: [],
    recordTaskTodoIds: harness.agent.test.recordTaskTodoIds,
    answerParts: harness.agent.test.answerParts,
    askAnswerIsStart: harness.agent.test.askAnswerIsStart,
    desktopOn: function desktopOn() { return true; },
    interjectKey: key, directOn, codexDirectOn: true, codexDirect: direct,
    cursorDirect: { textOf: function textOf(value) { return String(value || ''); } },
    directWrites: false, turnStart: false, modelCfg: { protocol: 'codex', model: 'fixture' },
    workspace: '', extra: [], snap: { readOnly: false }, trackEvent: onEvent, onEvent,
    signal: new AbortController().signal, lang: harness.lang, workingMemoryRef: { current: { todos: [] } },
    waitForUserAnswer: null, roundLimit: 5, unlimitedRounds: true,
    loopTools: [], loopWorkers: null, wantPlanning: false, userText: '请核对当前任务',
    directProtocol: 'codex', codeWorker: null, codeModels: [], planningWorker: null,
    rules: [], skill: null, persona: '', contextRevision: '',
    toolsFor: function toolsFor() { return [{ function: { name: 'read_file', parameters: { type: 'object' } } }]; },
    MUTATE_FILE_TOOLS: new Set(),
    directRunTool: async function tool(name, args) { return '真实工具结果:' + name + ':' + args.path; }
  };
  vm.runInNewContext(harness.source.substring(start, end) + '\nthis.runBrain = runBrain;', context);
  /** 模拟生产整轮持有的接收登记；仅测大脑时仍由测试外层负责释放。 */
  async function run(list, started, resume = false) {
    context.activeInterjectKeys.set(key, testInbox(key));
    context.snap.taskScope = harness.dependency('./agi-task-scope').create(context.userText, context.history, context.turnStart);
    for (const addition of context.turnInterjections) harness.dependency('./agi-task-scope').update(context.snap.taskScope, addition);
    try { return await context.runBrain(list, started, resume); }
    finally { context.activeInterjectKeys.delete(key); }
  }
  return { run, context, events };
}
/** 测试消息保持独立，不继承其他会话正文。 */
function messages() { return [{ role: 'system', content: '测试规则' }, { role: 'user', content: '继续当前任务' }]; }
/**
 * 验证工具启动前的插话阻止旧动作，并让模型按新消息重新决策。
 * @param {object} harness 提供真实 Agent、插话收件箱及直通测试入口。
 * @returns {Promise<void>} 核对旧动作拦截与同会话续接，任何断言失败都会拒绝。
 */
async function testBeforeTool(harness) {
  let executions = 0;
  let requests = 0;
  const addition = '先核对当前依据';
  /**
   * 模拟工具启动前收到插话的旧请求，以及同会话读取插话后的续接请求。
   * @param {object} args 直通适配器收到的工具回调、停止判断、用户消息和会话续接标志。
   * @returns {Promise<{content: string}>} 首次返回旧请求的收尾文本，第二次返回根据插话重新调用工具后的答复。
   */
  async function directRun(args) {
    requests++;
    if (requests === 1) {
      check(harness.agent.pushInterjection('before', addition), '真实 runBrain 接受执行中插话');
      const response = await args.runTool('read_file', { path: 'fixture' });
      check(response.includes('尚未执行') && !response.includes(addition), '旧工具只返回阻止状态，插话留给用户消息');
      assert.ok(args.shouldYield());
      return { content: '旧请求结束。' };
    }
    assert.equal(requests, 2);
    check(args.turnText.includes(addition) && args.fresh === false, '原直通会话收到独立用户插话');
    const next = await args.runTool('read_file', { path: 'confirmed' });
    check(next === '已执行', '已读取插话后模型可以重新调用工具');
    return { content: '收到补充，已核对。' };
  }
  const brain = brainHarness(harness, { runTurn: directRun }, 'before');
  brain.context.directRunTool = async function execute() { executions++; return '已执行'; };
  const answer = await brain.run(messages(), false);
  check(answer.includes('收到补充') && executions === 1, '旧动作未执行，重新决策只执行一次');
  check(!harness.agent.pushInterjection('before', '收尾之后的消息'), '轮次退出后不假报接收，交给界面排队');
}
/**
 * 验证工具执行期间到达的多条插话独立投递，且已启动工具的结果原样保留。
 * @param {object} harness 提供真实 Agent、会话收件箱及直通测试入口。
 * @returns {Promise<void>} 核对同批拦截、续接与会话隔离，任何断言失败都会拒绝。
 */
async function testDuringTool(harness) {
  harness.agent.test.activeInterjectKeys.set('other', testInbox('other'));
  harness.agent.pushInterjection('other', '另一个会话的消息');
  let requests = 0;
  /**
   * 模拟工具执行期间的旧请求与收到插话后的续接请求。
   * @param {object} args 本次直通收到的工具回调、停止判断及用户消息。
   * @returns {Promise<{content: string}>} 首次返回旧请求的收尾文本，第二次返回处理完插话的答复。
   */
  async function directRun(args) {
    requests++;
    if (requests === 1) {
      const response = await args.runTool('read_file', { path: 'fixture' });
      check(response === '原工具完整结果', '在途工具完整交回原始结果，插话保持独立');
      const old = await args.runTool('read_file', { path: 'obsolete' });
      check(old.includes('尚未执行') && args.shouldYield(), '有待投递插话时，同批后续工具不执行');
      return { content: '旧请求结束。' };
    }
    assert.equal(requests, 2);
    const text = args.turnText;
    check(text.includes('第一条补充') && text.includes('第二条补充') &&
      text.indexOf('第一条补充') < text.indexOf('第二条补充'), '连续插话按顺序进入同一条用户消息');
    check(!text.includes('另一个会话'), '并发会话不会串话');
    const next = await args.runTool('read_file', { path: 'next' });
    check(next === '原工具完整结果', '已经投递的插话不重复注入工具回包');
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
  check(await brain.run(messages(), false) === '已按补充继续' && calls === 2, '在途工具与续接后的工具各执行一次');
  check(harness.agent.test.takeInterjections('other')[0].text === '另一个会话的消息', '本轮不会清掉其他会话消息');
  harness.agent.test.activeInterjectKeys.delete('other');
}
/** 验证连续插话把已有有效要求送入同一个 SDK 会话，且显式停止不复活旧任务。 */
async function testCompletion(harness) {
  const original = '请列出三项检查结果，输出使用中文。';
  const first = '补充一点，每项写出行号。';
  const second = '再补充一下，每项注明是否已验证。';
  const key = 'completion';
  let calls = 0;
  /** 用两次模型请求收尾模拟先后插话；每次读取适配器实际收到的提示。 */
  async function directRun(args) {
    calls++;
    if (calls === 1) {
      check(harness.agent.pushInterjection(key, first), '第一条补充在首个模型请求中接收');
      return { content: '原答复' };
    }
    check(args.key === key && args.fresh === false, '收尾插话沿用原会话');
    const scopeText = args.turnText.split('【用户实时插话】')[0];
    check(scopeText.includes(original) && scopeText.includes(first), '首条续接请求同时列出原要求和已到补充');
    check(args.firstPrefix === '' && args.systemContext === '' && args.requiredToolNames.length === 0 && args.userContent === '',
      '续接沿用会话上下文，不重发规则、原附件或首次必调工具');
    if (calls === 2) {
      check(harness.agent.pushInterjection(key, second), '第二条补充在首条续接请求中接收');
      return { content: '第一条补充答复' };
    }
    check(calls === 3 && scopeText.indexOf(original) < scopeText.indexOf(first) &&
      scopeText.indexOf(first) < scopeText.indexOf(second), '第二条续接请求按原顺序列出三条有效要求');
    return { content: '这是补充说明' };
  }
  const brain = brainHarness(harness, { runTurn: directRun }, key);
  brain.context.userText = original;
  const list = [{ role: 'user', content: original }];
  check(await brain.run(list, false) === '这是补充说明' && calls === 3, '两批插话依次消费，最终回复来自最后续接');
  check(brain.events.some(function delivered(event) { return event.text === '插话已送达 AI，正在继续处理…'; }),
    '界面有实际投递状态');
  const delivered = brain.events.filter(function interjection(event) { return event.type === 'interjection'; });
  const requirement = harness.agent.test.requirementText(original, [], false, delivered.flatMap(function texts(event) { return event.texts; }));
  check(delivered.length === 2 && requirement.includes(original) && requirement.includes(first) && requirement.includes(second),
    '最终验收收到原要求和两条补充');
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
    check(args.messages.some(function included(message) { return message.role === 'user' && String(message.content).split('\n\n')[0] === '普通模式请求中补充'; }),
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
/**
 * 验证普通模型只执行插话抵达前已经启动的旧工具。
 * @param {object} harness 提供真实 Agent、模型传输替身及会话测试入口。
 * @returns {Promise<void>} 两种时序均验证通过后结束，断言失败则拒绝。
 */
async function testOrdinaryQueuedTools(harness) {
  const imagePath = path.join(root, 'icons.png');
  for (const imageOnly of [false, true]) {
    const key = 'ordinary-queued-' + imageOnly;
    const addition = '补充一个参考条件';
    const brain = brainHarness(harness, null, key, false);
    brain.context.workspace = root;
    brain.context.modelCfg = { protocol: 'openai', model: 'fixture', vision: true, baseUrl: 'http://unused' };
    let requests = 0;
    let continued = false;

    /**
     * 记录真实工具事件，并在首个工具已获准执行时提交纯图。
     * @param {object} event 大脑发出的事件。
     * @returns {void} 保留事件，在首个读文件启动时登记附件。
     */
    function observe(event) {
      brain.events.push(event);
      if (imageOnly && event.type === 'tool' && event.status === 'running' &&
          event.name === 'read_file' && event.detail === 'package.json') {
        assert.ok(harness.agent.pushInterjection(key, '', [{ path: imagePath }]));
      }
    }
    brain.context.trackEvent = observe;
    brain.context.onEvent = observe;

    /**
     * 先返回旧工具批次，再检查同一会话的工具结果与独立用户消息。
     * @param {object} args 普通模型请求，包含重放的消息历史。
     * @returns {Promise<object>} 首次给出待执行工具，第二次给出已处理插话的正文。
     */
    async function complete(args) {
      requests++;
      if (requests === 1) {
        if (!imageOnly) assert.ok(harness.agent.pushInterjection(key, addition));
        return { role: 'assistant', tool_calls: [
          { id: 'running', type: 'function', function: { name: 'read_file', arguments: '{"path":"package.json","startLine":1,"endLine":5}' } },
          { id: 'obsolete', type: 'function', function: { name: 'list_dir', arguments: '{"path":"electron"}' } }
        ] };
      }
      assert.equal(requests, 2);
      const history = args.messages;
      assert.match(history.find(function blocked(message) { return message.tool_call_id === 'obsolete'; }).content, /已停止旧工具/);
      const first = history.find(function running(message) { return message.tool_call_id === 'running'; });
      if (imageOnly) {
        assert.match(first.content, /"name": "simplecode"/);
        const imageMessage = history.find(function attached(message) { return message.role === 'user' && Array.isArray(message.content); });
        const part = imageMessage.content.find(function image(item) { return item.type === 'image_url'; });
        assert.ok(Buffer.from(part.image_url.url.split(',')[1], 'base64').equals(fs.readFileSync(imagePath)));
      } else {
        assert.match(first.content, /已停止旧工具/);
        assert.ok(history.some(function delivered(message) { return message.role === 'user' && String(message.content).split('\n\n')[0] === addition; }));
      }
      continued = true;
      return { role: 'assistant', content: '已按补充核对。' };
    }
    harness.setComplete(complete);
    const reply = await brain.run(messages(), false);
    const started = brain.events.filter(function started(event) { return event.type === 'tool' && event.activityOnly && event.status === 'running'; });
    check(continued && reply === '已按补充核对。' && started.length === Number(imageOnly),
      imageOnly ? '工具在途时收到纯图，保留真实结果并拦住同批未启动工具，原图进入下一请求' :
        '追加文字在旧模型请求结束前入队，旧批次无工具启动，正文进入下一请求');
  }
}

/** 普通模型使用真实附件解析器，把插话PNG送入下一次多模态请求。 */
async function testOrdinaryImages(harness) {
  let calls = 0;
  const imagePath = path.join(root, 'icons.png');
  async function complete(args) {
    calls++;
    if (calls === 1) {
      harness.agent.pushInterjection('ordinary-image', '', [{ path: imagePath, name: '参考图.png' }]);
      return { role: 'assistant', content: '原答复' };
    }
    const imageMessage = args.messages.find(function image(message) { return message.role === 'user' && Array.isArray(message.content) && message.content.some(function part(p) { return p.type === 'image_url'; }); });
    check(!!imageMessage, '普通模型下一次请求含插话图片内容块');
    const part = imageMessage.content.find(function image(p) { return p.type === 'image_url'; });
    check(Buffer.from(part.image_url.url.split(',')[1], 'base64').equals(fs.readFileSync(imagePath)), '普通模型收到的原图字节与附件一致');
    return { role: 'assistant', content: '已看图调整' };
  }
  harness.setComplete(complete);
  const brain = brainHarness(harness, null, 'ordinary-image', false);
  brain.context.modelCfg = { protocol: 'openai', model: 'fixture', vision: true, baseUrl: 'http://unused' };
  const history = messages();
  history.push({ role: 'assistant', tool_calls: [{ id: 'screen', type: 'function', function: { name: 'screen_read', arguments: '{}' } }] });
  history.push({ role: 'tool', tool_call_id: 'screen', content: '验收屏幕' });
  check(await brain.run(history, false) === '已看图调整', '普通模型真实入口完成带图插话');
}
/** 文本模型收到截图插话时，把真实图片交给已选的 Codex 眼睛槽。 */
async function testCodexVisionAttachment() {
  const key = 'codex-vision-attachment';
  const imagePath = path.join(root, 'icons.png');
  let forwarded = 0;
  /** 配置使用直通模型的眼睛槽，没有 GGUF 或 HTTP 端点。 */
  function visionFrom() { return { protocol: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'high' }; }
  /** 只替换 SDK 传输，核对生产路由送入原图和保存的档位。 */
  async function inspect(args) {
    const part = args.messages[0].content.find(function image(item) { return item.type === 'image_url'; });
    assert.equal(args.modelCfg.model, 'gpt-6.2-sol');
    assert.equal(args.modelCfg.reasoningEffort, 'high');
    assert.ok(Buffer.from(part.image_url.url.split(',')[1], 'base64').equals(fs.readFileSync(imagePath)));
    forwarded++;
    return { content: '截图上的实际标记。' };
  }
  const harness = loadAgent({ './assembly': { ...require('../electron/lib/assembly'), visionFrom },
    './codex-model': { complete: inspect } });
  /** 文本大脑确认收到视觉回执，而不是本地 GGUF 错误。 */
  async function complete(args) {
    const labels = args.messages.flatMap(function body(message) { return message.content; }).join('\n');
    assert.match(labels, /用户截图 1 识别结果[\s\S]*截图上的实际标记/);
    assert.doesNotMatch(labels, /无法识别图片|mmproj/);
    return { role: 'assistant', content: '已读截图。' };
  }
  harness.setComplete(complete);
  const brain = brainHarness(harness, null, key, false);
  brain.context.modelCfg = { protocol: 'openai', model: 'fixture', vision: false };
  harness.agent.test.activeInterjectKeys.set(key, testInbox(key));
  assert.ok(harness.agent.pushInterjection(key, '补充截图', [{ path: imagePath, name: '截图.png' }]));
  const answer = await brain.run(messages(), false);
  check(answer === '已读截图。' && forwarded === 1, '文本大脑的截图插话按配置发给 Codex 视觉槽，由原图返回真实识别回执');
}

/**
 * 将生产直通工具入口接入测试，以真实 todo_write 异常及工作记忆更新驱动收尾检查。
 * @param {object} harness 已加载的真实 Agent 源码与依赖。
 * @param {object} brain 本测试独立的大脑上下文；只更新其内存清单，不写项目或请求模型。
 * @returns {void} 覆盖该上下文的工具入口，后续 SDK 模拟仍经过生产工具与插话链。
 */
function useProductionTodoTools(harness, brain) {
  const start = harness.source.indexOf('  function directDetail(name, args) {');
  const end = harness.source.indexOf('  async function runBrain(', start);
  assert.ok(start >= 0 && end > start);
  brain.context.execTool = harness.agent.test.execTool;
  brain.context.compact = harness.dependency('./context-compact');
  brain.context.directLabels = {};
  brain.context.diag = { log: noop };
  vm.runInNewContext(harness.source.substring(start, end), brain.context);
}

/** 验证清单未完成时真正续跑原会话，完成后立即返回，历史待办不影响新问答。 */
async function testDirectTaskCompletion(harness) {
  let calls = 0;
  async function directRun(args) {
    calls++;
    if (calls === 1) {
      await args.runTool('todo_write', { merge: false, todos: [
        { id: 'edit', content: '修改目标代码', status: 'completed' },
        { id: 'verify', content: '核对目标行为', status: 'pending' }
      ] });
      return { content: '已完成编辑。' };
    }
    check(calls === 2, '待办完成后不会再请求模型');
    check(args.key === 'unfinished-task' && args.fresh === false, '任务续跑沿用同一直通会话');
    check(args.firstPrefix === '' && args.systemContext === '' && args.userContent === '' && args.requiredToolNames.length === 0,
      '续跑不重发历史附件和首次必调工具，避免重复执行');
    check(args.turnText.includes('[pending] verify：核对目标行为') && !args.turnText.includes('[completed] edit'),
      '续跑明确列出剩余验证，跳过已完成动作');
    await args.runTool('todo_write', { merge: true, todos: [{ id: 'verify', status: 'completed' }] });
    return { content: '已完成修复及验证。' };
  }
  const brain = brainHarness(harness, { runTurn: directRun }, 'unfinished-task');
  useProductionTodoTools(harness, brain);
  check(await brain.run(messages(), false) === '已完成修复及验证。' && calls === 2,
    '真实待办更新阻止半途收工，验证结束才返回最终结果');
  check(brain.events.some(function resumed(event) { return event.text === '任务尚未完成，正在继续执行并验证…'; }),
    '界面准确显示任务仍在执行');
  let ordinaryCalls = 0;
  async function ordinaryAnswer() { ordinaryCalls++; return { content: '这是普通问答的答案。' }; }
  const ordinary = brainHarness(harness, { runTurn: ordinaryAnswer }, 'history-only');
  ordinary.context.workingMemoryRef.current.todos = [{ id: 'old', content: '历史任务', status: 'pending' }];
  check(await ordinary.run(messages(), false) === '这是普通问答的答案。' && ordinaryCalls === 1,
    '本轮未更新清单时，历史残留待办不会让普通问答续跑');
}

/** 验证长任务不被旧软重试次数截断；停止、真实错误和只读边界仍立即生效。 */
async function testTaskCompletionBoundaries(harness) {
  let calls = 0;
  async function progress(args) {
    calls++;
    // 每轮产生可区分的实际工具结果，让长任务续做具备新证据。
    await args.runTool('read_file', { path: 'sample-' + calls + '.txt' });
    assert.ok(calls <= 10, '已完成后不能空转');
    return { content: calls < 10 ? '正在检查目标行为。' : '已完成核对。' };
  }
  const long = brainHarness(harness, { runTurn: progress }, 'long-progress');
  check(await long.run(messages(), false) === '已完成核对。' && calls === 10, '直通过程回复超过六次也不会误判为任务完成');
  const ctl = new AbortController();
  let stopCalls = 0;
  async function stopping() { stopCalls++; ctl.abort(); return { content: '正在检查目标行为。' }; }
  const stopped = brainHarness(harness, { runTurn: stopping }, 'stop-progress');
  stopped.context.signal = ctl.signal;
  await assert.rejects(stopped.run(messages(), false), { name: 'AbortError' });
  check(stopCalls === 1 && !harness.agent.test.activeInterjectKeys.has('stop-progress'), '用户停止后不续跑且释放会话入口');
  let failures = 0;
  async function failing() { failures++; throw new Error('真实传输失败'); }
  const failed = brainHarness(harness, { runTurn: failing }, 'failed-progress');
  await assert.rejects(failed.run(messages(), false), /真实传输失败/);
  check(failures === 1, '真实传输错误原样上报，不自动重放任务');
  let readonlyCalls = 0;
  async function readonlyReply() { readonlyCalls++; return { content: '正在检查目标行为。' }; }
  const readonly = brainHarness(harness, { runTurn: readonlyReply }, 'readonly-progress');
  readonly.context.snap.readOnly = true;
  await readonly.run(messages(), false);
  check(readonlyCalls === 1, '只读任务不进入实施续跑');
}

/**
 * 核对解释性事实不触发续跑，完成部分工作后的明确验证承诺仍会继续。
 * @param {object} harness 隔离模型传输的真实 Agent 测试环境。
 * @returns {Promise<void>} 所有断言通过才返回；本例不写项目或请求外部模型。
 */
async function testCompletionMeaning(harness) {
  for (const text of ['这段代码正在检查请求是否合法。', '该接口尚未支持流式输出。', '我现在已经完成修改。', '我现在已经检查过了，没有发现问题。', '我先读取了配置文件，再核对了调用链，结论是接口不支持流式输出。', '我先读取了配置，接下来我再检查了测试结果。']) {
    let calls = 0;
    async function fact() { calls++; assert.ok(calls <= 2, '事实说明不能空转'); return { content: text }; }
    const brain = brainHarness(harness, { runTurn: fact }, 'fact-' + text);
    check(await brain.run(messages(), false) === text && calls === 1, '事实说明直接回答：' + text);
  }
  let calls = 0;
  async function verify(args) {
    calls++;
    if (calls === 1) return { content: '已完成修改，接下来我会运行验证。' };
    check(calls === 2 && args.turnText.includes('沿用当前会话'), '已完成编辑仍会续做明确承诺的验证');
    return { content: '已完成验证。' };
  }
  const validating = brainHarness(harness, { runTurn: verify }, 'promised-validation');
  check(await validating.run(messages(), false) === '已完成验证。' && calls === 2, '完成声明不会遮住后续验证承诺');
  for (const text of ['我先读取了配置，接下来我再运行测试。', '我现在已经检查过了，我再核对调用链。', '我先读取了配置,接下来我继续验证。']) {
    let continuationCalls = 0;
    /**
     * 返回过去时说明夹带的后续执行承诺，第二次才交付真实测试结果。
     * @param {object} args 真实直通续接参数，核对无待办时仍沿用原会话。
     * @returns {Promise<object>} 首次为受测承诺，续接为完成正文；不请求外部模型或写项目。
     */
    async function continueAfterPast(args) {
      continuationCalls++;
      assert.ok(continuationCalls <= 2, '完成结果不能再次续跑');
      if (continuationCalls === 1) return { content: text };
      check(args.turnText.includes('沿用当前会话'), '过去时后续承诺沿用原会话：' + text);
      return { content: '已完成测试与核对。' };
    }
    const continuing = brainHarness(harness, { runTurn: continueAfterPast }, 'past-then-promise-' + text);
    check(await continuing.run(messages(), false) === '已完成测试与核对。' && continuationCalls === 2, '无待办时过去时说明不能遮蔽后续执行：' + text);
  }
  let merges = 0;
  async function mergeCurrent(args) {
    merges++;
    assert.equal(merges, 1, '本轮任务完成后不能重新开历史任务');
    await args.runTool('todo_write', { merge: true, todos: [{ id: 'current', content: '本轮已完成事项', status: 'completed' }] });
    return { content: '本轮已完成。' };
  }
  const merged = brainHarness(harness, { runTurn: mergeCurrent }, 'merge-history');
  merged.context.workingMemoryRef.current.todos = [{ id: 'old', content: '历史未完成事项', status: 'pending' }];
  useProductionTodoTools(harness, merged);
  check(await merged.run(messages(), false) === '本轮已完成。' && merges === 1,
    '本轮merge更新不重新授权历史未触及的待办');
}

/**
 * 通过生产 ask_user 等待链验证凭据阻塞：等待期间不结束也不额外请求模型，答复后继续原任务。
 * @param {object} harness 隔离模型传输的真实 Agent 测试环境。
 * @returns {Promise<void>} 用户答复、清单完成与最终回复均已观察；只使用合成答复，无真实凭据。
 */
async function testTaskWaitForAnswer(harness) {
  let notifyAsked;
  let answer;
  const asked = new Promise(function executor(resolve) { notifyAsked = resolve; });
  const reply = new Promise(function executor(resolve) { answer = resolve; });
  let calls = 0;
  async function run(args) {
    calls++;
    await args.runTool('todo_write', { merge: false, todos: [{ id: 'verify', content: '取得用户信息后核对', status: 'pending' }] });
    const result = await args.runTool('ask_user', { question: '缺少无法自行取得的信息，请补充测试值。' });
    check(result.includes('合成答复'), '真实ask_user把用户答复交回原模型请求');
    await args.runTool('todo_write', { merge: true, todos: [{ id: 'verify', status: 'completed' }] });
    return { content: '已完成核对。' };
  }
  const brain = brainHarness(harness, { runTurn: run }, 'waiting-task');
  useProductionTodoTools(harness, brain);
  brain.context.waitForUserAnswer = function wait() { notifyAsked(); return reply; };
  let settled = false;
  const running = brain.run(messages(), false);
  running.then(function done() { settled = true; }, function rejected() { settled = true; });
  await asked;
  check(calls === 1 && !settled && brain.context.workingMemoryRef.current.todos[0].status === 'pending',
    '真实外部信息等待期间保持任务未完成，不续发模型请求');
  answer('合成答复');
  check(await running === '已完成核对。' && calls === 1, '收到答复后原请求继续核对，清单完成才结束');
}

/** 验证普通模型同样基于实际 todo_write 完成剩余验证，不仅修复直通分支。 */
async function testOrdinaryTaskCompletion(harness) {
  let calls = 0;
  function todoCall(id, merge, todos) {
    return { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: {
      name: 'todo_write', arguments: JSON.stringify({ merge, todos })
    } }] };
  }
  async function complete(args) {
    calls++;
    if (calls === 1) return todoCall('create', false, [{ id: 'verify', content: '实际验证', status: 'pending' }]);
    if (calls === 2) return { role: 'assistant', content: '已完成编辑。' };
    if (calls === 3) {
      check(args.messages.some(function continuation(message) { return message.role === 'user' && String(message.content).includes('[pending] verify：实际验证'); }),
        '普通模型收到未完成待办，而不是被当作已结束');
      return todoCall('finish', true, [{ id: 'verify', status: 'completed' }]);
    }
    assert.equal(calls, 4, '普通模型完成后不再请求');
    return { role: 'assistant', content: '已完成实际验证。' };
  }
  harness.setComplete(complete);
  const brain = brainHarness(harness, null, 'ordinary-task', false);
  brain.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
  const history = messages();
  history.push({ role: 'assistant', tool_calls: [{ id: 'screen', type: 'function', function: { name: 'screen_read', arguments: '{}' } }] });
  history.push({ role: 'tool', tool_call_id: 'screen', content: '验收屏幕' });
  check(await brain.run(history, false) === '已完成实际验证。' && calls === 4,
    '普通模型通过真实工具更新清单，剩余验证完成后才收尾');
}

/**
 * 验证持续执行指令约束最终目标，而不是只约束某一批已经勾完的步骤。
 * @param {object} harness 使用真实普通循环与直通收尾的隔离环境。
 * @returns {Promise<void>} 目标未达时续接原任务，达标、有限评估与只读检查均正常结束。
 */
async function testContinuousGoal(harness) {
  const order = '持续研究，目标达到之前不允许停下来。';
  for (const reply of ['老大，这轮命中 36/1000，没有突破，目标未达。', '本批步骤已完成，但尚未达到目标。', '本批步骤已完成，但目标没有达到。', '本批步骤已完成，但目标尚未实现。']) {
    let calls = 0;
    /** 返回已完成单批步骤但目标未达的正文，第二次才返回目标核对结果。 */
    async function continuous(args) {
      calls++;
      assert.ok(calls <= 2, '达标后不能继续空转');
      if (calls === 1) {
        await args.runTool('todo_write', { merge: false, todos: [{ id: 'batch', content: '执行并核验本批方案', status: 'completed' }] });
        return { content: reply };
      }
      check(args.turnText.includes('沿用当前会话') && args.requiredToolNames.length === 0, '目标未达时沿用原会话，不强制重放已完成工具');
      return { content: '目标已达到，实际验证通过。' };
    }
    const brain = brainHarness(harness, { runTurn: continuous }, 'continuous-goal-' + reply);
    brain.context.userText = order;
    useProductionTodoTools(harness, brain);
    check(await brain.run([{ role: 'user', content: order }], false) === '目标已达到，实际验证通过。' && calls === 2,
      '勾完本批任务不能覆盖用户持续执行的未达目标：' + reply);
  }
  for (const conditional of [
    { text: '不允许停下来，除非我说停止', interjections: [] },
    { text: '不允许停下来，除非我说“停止”', interjections: [] },
    { text: order, interjections: ['除非我说停止'] }
  ]) {
    let calls = 0;
    /** 条件口令不是当前停止命令；勾完本批步骤后仍续接，实际实现目标才结束。 */
    async function conditionalGoal(args) {
      calls++;
      assert.ok(calls <= 2, '目标已实现后不能继续空转');
      if (calls === 1) {
        await args.runTool('todo_write', { merge: false, todos: [{ id: 'conditional-batch', content: '执行并核验本批方案', status: 'completed' }] });
        return { content: '本批步骤已完成，目标未达。' };
      }
      return { content: '之前目标未达；现在目标已经实现，实际验证通过。' };
    }
    const brain = brainHarness(harness, { runTurn: conditionalGoal }, 'goal-conditional-' + conditional.text + conditional.interjections.join(''));
    brain.context.userText = conditional.text;
    brain.context.turnInterjections = conditional.interjections;
    useProductionTodoTools(harness, brain);
    check(await brain.run([{ role: 'user', content: conditional.text }], false) === '之前目标未达；现在目标已经实现，实际验证通过。' && calls === 2,
      '条件中的停止不覆盖持续要求，目标实际实现后退出：' + conditional.text + conditional.interjections.join(''));
  }
  let finiteCalls = 0;
  /** 有限评估只报告本批结果，不擅自增加研究任务。 */
  async function finite() { finiteCalls++; return { content: '本轮评估完成，目标未达。' }; }
  const finiteBrain = brainHarness(harness, { runTurn: finite }, 'finite-assessment');
  finiteBrain.context.userText = '只评估这一批是否达标，报告结果。';
  check(await finiteBrain.run([{ role: 'user', content: finiteBrain.context.userText }], false) === '本轮评估完成，目标未达。' && finiteCalls === 1,
    '没有持续执行要求时，未达标的有限评估可以正常交付');
  for (const reply of ['“目标未达”是旧结果，现在结论已更新。', '示例代码：\n```text\n目标未达\n```\n当前结果核对结束。', '之前目标未达；现在已达标，验证通过。']) {
    let calls = 0;
    /** 引文、代码与较早状态不应覆盖最终实际状态。 */
    async function finalState() { calls++; assert.equal(calls, 1, '旧状态不能触发空转'); return { content: reply }; }
    const stateBrain = brainHarness(harness, { runTurn: finalState }, 'goal-state-' + reply);
    stateBrain.context.userText = order;
    check(await stateBrain.run([{ role: 'user', content: order }], false) === reply && calls === 1,
      '只按当前实际目标状态收尾：' + reply);
  }
  for (const stopOrder of ['不用继续，先总结当前结果。', '停止', '停下来', '不允许停下来，除非我说停止。现在停止。', '不允许停下来，除非我说停止，现在先停下来。']) {
    let stoppedCalls = 0;
    /** 后续真实停止覆盖带条件的持续要求，同句后续独立命令也必须保留。 */
    async function stoppedGoal() { stoppedCalls++; assert.equal(stoppedCalls, 1, '用户已要求停止或总结，不能再续跑'); return { content: '本轮目标尚未达到。' }; }
    const stopped = brainHarness(harness, { runTurn: stoppedGoal }, 'goal-user-revised-' + stopOrder);
    stopped.context.userText = '不允许停下来，除非我说停止';
    stopped.context.turnInterjections = [stopOrder];
    check(await stopped.run([{ role: 'user', content: stopped.context.userText }], false) === '本轮目标尚未达到。' && stoppedCalls === 1,
      '最新停止或总结指令覆盖早先持续要求：' + stopOrder);
  }
  let reverseCalls = 0;
  /** 最新状态仍然未达时，不能被前面的达标陈述遮住。 */
  async function reversedGoal() {
    reverseCalls++;
    assert.ok(reverseCalls <= 2, '最新目标完成后停止续接');
    return { content: reverseCalls === 1 ? '之前已达标；现在目标未达。' : '目标已达到，验证通过。' };
  }
  const reversed = brainHarness(harness, { runTurn: reversedGoal }, 'goal-latest-unmet');
  reversed.context.userText = order;
  check(await reversed.run([{ role: 'user', content: order }], false) === '目标已达到，验证通过。' && reverseCalls === 2,
    '最新未达状态覆盖此前达标状态，继续原目标');
  for (const ordinaryCase of [
    { order, reply: '本批已完成，目标没有达到。' },
    { order, reply: '本批步骤已完成，但目标尚未实现。' },
    { order: '不允许停下来，除非我说停止', reply: '本批步骤已完成，但目标尚未实现。' }
  ]) {
    let ordinaryCalls = 0;
    /** 普通模型同样保留持续要求，先报告目标未达，第二次交付实际达标结果。 */
    async function complete() {
      ordinaryCalls++;
      assert.ok(ordinaryCalls <= 2, '普通模型达标后不能空转');
      return { role: 'assistant', content: ordinaryCalls === 1 ? ordinaryCase.reply : '目标已达到，实际验证通过。',
        reasoning_content: ordinaryCalls === 1 ? '较早假设目标已达到。' : '较早记录目标未达。' };
    }
    harness.setComplete(complete);
    const ordinary = brainHarness(harness, null, 'ordinary-continuous-goal-' + ordinaryCase.order + ordinaryCase.reply, false);
    ordinary.context.userText = ordinaryCase.order;
    ordinary.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
    const history = [{ role: 'user', content: ordinaryCase.order },
      { role: 'assistant', tool_calls: [{ id: 'verify', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'verify', content: '已完成本批验证' }];
    check(await ordinary.run(history, false) === '目标已达到，实际验证通过。' && ordinaryCalls === 2,
      '普通模型以最终正文判断目标并保留条件持续要求：' + ordinaryCase.reply + ordinaryCase.order);
  }
}

/**
 * 验证普通 AGI 的只读审查不会因过程文字被催促修改文件。
 * @param {object} harness 隔离模型传输的真实 Agent 测试环境。
 * @returns {Promise<void>} 生产普通循环完成后兑现；检查实际请求数量和消息指令。
 */
async function testOrdinaryReadOnly(harness) {
  let calls = 0;
  async function complete(args) {
    calls++;
    check(calls === 1 && !args.messages.some(function unsafe(message) {
      return message.role === 'user' && String(message.content).includes('立刻自己调用 edit_file');
    }), '普通只读审查没有额外实施催促');
    return { role: 'assistant', content: '我正在核对只读审查结果。' };
  }
  harness.setComplete(complete);
  const brain = brainHarness(harness, null, 'ordinary-readonly', false);
  brain.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
  brain.context.snap.readOnly = true;
  const history = [{ role: 'system', content: '测试规则' }, { role: 'user', content: '只读审查，不修改文件。' },
    { role: 'assistant', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'read', content: '已读取源码' }];
  check(await brain.run(history, false) === '我正在核对只读审查结果。' && calls === 1,
    '普通只读边界与直通一致，不自动进入实施续跑');
}

/** 加载发布目录内的真实 SDK 适配器，仅导出测试所需的会话和回环桥入口。 */
function loadCodexBridge() {
  const file = path.join(root, 'electron/lib/codex-direct.js');
  const localRequire = createRequire(file);
  function dependency(name) { if (name === './diag') return { log: noop }; return localRequire(name); }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file), process, console, Buffer, AbortController, AbortSignal };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.test = { sessions, startBridge };', context, { filename: file });
  return context.module.exports;
}

/**
 * 在独立 Electron 进程里核对超长命令经过生产 MCP 与 Agent 后的实际结果。
 * @param {object} harness 提供生产工具入口与工具定义的隔离夹具。
 * @returns {Promise<void>} Windows 上核对完整参数、工作目录、退出状态和成功记录，失败时拒绝。
 */
async function testLongCommand(harness) {
  if (process.platform !== 'win32') return;
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
  const codex = loadCodexBridge();
  // 用中文负载跨过旧桥接请求体上限，同时检验脚本作为 UTF-8 传入 PowerShell。
  const payload = '中'.repeat(3_000_000);
  const command = "powershell -NoProfile -Command \"$s = '" + payload +
    "'; Write-Output (Get-Location).Path; Write-Output $s.Length; Write-Output '长命令尾标'\"";
  const snap = {};

  /**
   * 把 MCP 请求交给生产工具执行器，并核对桥接保留了完整命令。
   * @param {string} name MCP 请求指定的工具名。
   * @param {object} args 桥接收到的原始工具参数。
   * @returns {Promise<string>} 包含实际退出状态和输出的工具文本，命令不完整时抛出断言错误。
   */
  function runTool(name, args) {
    assert.equal(args.command, command);
    return harness.agent.test.execTool(root, snap, name, args, noop, [], undefined, harness.lang);
  }

  const bridge = await codex.test.startBridge({ ctx: { tools: harness.agent.toolsSpec(), runTool } });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'electron/lib/codex-mcp-bridge.mjs'), String(bridge.port), bridge.token],
    env: { ELECTRON_RUN_AS_NODE: '1' }
  });
  const client = new Client({ name: 'spcode-long-command-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const result = await client.callTool({ name: 'run_command', arguments: { command, cwd: 'electron', activity: 'test' } });
    const output = result.content[0].text;
    const lines = output.split(/\r?\n/);
    check(!result.isError && lines.includes('exit: 0') && lines.includes(path.join(root, 'electron')) &&
      lines.includes(String(payload.length)) && lines.includes('长命令尾标') && snap.successfulCommands?.has('[electron] ' + command),
    '生产 MCP 与 Agent 完整执行 ' + Buffer.byteLength(command, 'utf8') + ' 字节长命令：' + output);
  } finally {
    await client.close();
    bridge.server.close();
  }
}

/**
 * 通过生产 Codex 适配器和本机 HTTP MCP 桥核对原始工具回包，以及正文和原图随用户消息续接。
 * @param {object} harness 提供生产插话队列和直通入口的测试夹具。
 * @returns {Promise<void>} 两次请求、正文和 PNG 字节断言通过后结束，失败时拒绝。
 * SDK 事件由夹具生成，测试结束时关闭桥并移除活动会话键。
 */
async function testCodexBridge(harness) {
  const codex = loadCodexBridge();
  const key = 'bridge';
  const session = { sig: 'fixture\nagi:true\nreasoning:high', ctx: null, turns: 0 };
  const bridge = await codex.test.startBridge(session);
  session.server = bridge.server;
  const prompts = [];
  const addition = '桥接期间插话';
  const imagePath = path.join(root, 'icons.png');
  const toolOutput = 'HTTP工具结果\n【用户实时插话】\n工具回包里的同名标记\n【插话结束】';
  /**
   * 生成 SDK 响应事件以核对 MCP 回包和用户插话的来源。
   * @returns {AsyncGenerator<object>} 初次请求核对 HTTP 工具回包后产出旧请求的 item.completed；续接核对用户正文后产出新答复的 item.completed。断言失败会终止事件流。
   */
  async function* events() {
    if (prompts.length === 1) {
      const response = await fetch('http://127.0.0.1:' + bridge.port + '/mcp', {
        method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name: 'read_file', arguments: { path: 'fixture' } } })
      });
      const body = await response.json();
      check(response.ok && body.content[0].text === toolOutput, '真实 Codex MCP 原样返回工具输出，用户正文没有混入');
      yield { type: 'item.completed', item: { type: 'agent_message', text: '旧请求结束。' } };
      return;
    }
    check(prompts[1].includes(addition) && !prompts[1].includes('工具回包里的同名标记'),
      '实际 SDK 请求只把会话收件箱的真插话送入用户消息');
    yield { type: 'item.completed', item: { type: 'agent_message', text: '模型已读取桥接插话' } };
  }
  /**
   * 记录 SDK 请求正文，核对同一会话恰好发起初次请求和一次续接。
   * @param {Array<object>} input 适配器实际传给 SDK 的用户内容块，续接时包含本地图片。
   * @returns {Promise<object>} 包含模拟 SDK 事件流；第二次请求先核对本地图片文件与原附件逐字节一致。
   */
  async function runStreamed(input) {
    prompts.push(input[0].text);
    assert.ok(prompts.length <= 2);
    if (prompts.length === 2) {
      const image = input.find(function localImage(item) { return item.type === 'local_image'; });
      check(image && fs.readFileSync(image.path).equals(fs.readFileSync(imagePath)), 'Codex 的新用户请求收到原始插话图片');
    }
    return { events: events() };
  }
  session.thread = { runStreamed };
  codex.test.sessions.set(key, session);
  harness.agent.test.activeInterjectKeys.set(key, testInbox(key));
  /**
   * 模拟工具执行时把插话正文和原图路径加入当前会话的收件箱。
   * 此夹具只处理固定的读取调用，无需工具参数。
   * @returns {Promise<string>} 返回包含同名标记的原始工具文本，供 HTTP 回包逐字核对。
   */
  async function runTool() {
    harness.agent.pushInterjection(key, addition, [{ path: imagePath, name: '桥接附件.png' }]);
    return toolOutput;
  }
  try {
    const result = await harness.agent.test.runDirectWithInterjections(codex, {
      key, sig: 'fixture', modelCfg: { apiKey: 'test-no-network', reasoningEffort: 'high', vision: true }, tools: [{ name: 'read_file', parameters: { type: 'object' } }],
      runTool, onEvent: noop, signal: new AbortController().signal, agiMode: true, turnText: '验收'
    }, key);
    check(result.content === '模型已读取桥接插话' && session.turns === 2, 'Codex 沿用原会话续接一次并交付新答复');
  } finally {
    codex.closeSession(key);
    harness.agent.test.activeInterjectKeys.delete(key);
  }
}
/**
 * 令旧 SDK 流在思考中或工具返回后保持开启，验证插话主动交接。
 * @param {object} harness 提供生产插话收件箱与直通入口。
 * @param {string} phase 插话到达时机，可为启动、思考、在途工具或积压。
 * @returns {Promise<void>} 旧请求让出 SDK、新请求实际读到工具结果后结束。
 */
async function testCodexInterjectionHandoff(harness, phase) {
  const codex = loadCodexBridge();
  const key = 'handoff-' + phase;
  const duringTool = phase === '在途工具';
  const session = { sig: 'fixture\nagi:true\nreasoning:default', ctx: null, turns: 0 };
  const bridge = await codex.test.startBridge(session);
  session.server = bridge.server;
  const parent = new AbortController();
  const addition = '请按新要求修复当前问题。';
  const bulk = phase === '积压';
  const burst = Array.from({ length: 20 }, function marker(_, i) { return '插话原文[' + (i + 1) + ']'; });
  const delivered = [];
  const prompts = [];
  const reads = [];
  let sendingIds = [];

  /** 经真实 HTTP MCP 读取当前请求的工具回包。 */
  async function call(label) {
    const response = await fetch('http://127.0.0.1:' + bridge.port + '/mcp', {
      method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: 'tools/call', params: { name: 'read_file', arguments: { path: label } } })
    });
    assert.equal(response.status, 200);
    return (await response.json()).content[0].text;
  }

  /** 只有产生旧请求的独立交接信号，模拟的 SDK 才会退出挂起阶段。 */
  async function* events(signal) {
    yield { type: 'turn.started' };
    if (prompts.length === 1) {
      if (bulk) {
        /** 第一波在旧请求等待时到账，最后一条带附件进入真实准备流程。 */
        for (let i = 0; i < 12; i++) {
          const files = i === 11 ? [{ path: path.join(root, 'icons.png'), name: '第十二条的附件.png' }] : [];
          assert.ok(harness.agent.pushInterjection(key, burst[i], files));
        }
        yield { type: 'item.started', item: { type: 'reasoning' } };
      } else if (duringTool) {
        const item = { id: 'old-read', type: 'mcp_tool_call', tool: 'read_file' };
        yield { type: 'item.started', item };
        check(await call('在途读取') === '在途读取的真实结果', '插话期间旧工具完整返回实际结果');
        check(!signal.aborted, '工具结果被 SDK 确认前，旧流继续接收事件');
        yield { type: 'item.completed', item };
        check(!signal.aborted, '工具完成事件本身尚未进入模型历史，继续等待下一次模型活动');
        yield { type: 'item.started', item: { type: 'reasoning' } };
      } else {
        if (phase === '思考') yield { type: 'item.started', item: { type: 'reasoning' } };
        assert.ok(harness.agent.pushInterjection(key, addition));
        if (phase === '启动') {
          check(!signal.aborted, 'SDK 仅报告轮次启动时保留原始消息写入的机会');
          yield { type: 'item.started', item: { type: 'reasoning' } };
        }
      }
      await require('node:timers/promises').setTimeout(1000, undefined, { signal });
      assert.fail('插话后旧 Codex 流仍在等待，宿主未主动交接');
    }
    check(sendingIds.length === (bulk ? burst.length : 1), 'SDK 等待首个模型回执时已按本批编号显示处理中');
    const result = await call('插话后的读取');
    check(result === '插话后的读取的真实结果', '续接请求能通过真实 MCP 调用工具：' + result);
    if (bulk) {
      const boundary = prompts[1].indexOf('【用户实时插话】');
      assert.ok(boundary >= 0);
      assert.deepEqual(prompts[1].slice(boundary).match(/插话原文\[\d+\]/g), burst);
      assert.deepEqual(prompts[1].slice(0, boundary).match(/插话原文\[\d+\]/g), burst);
      check(true, '同一条 SDK 用户请求收到 20 条按序插话，执行依据已合并到最新');
    } else assert.ok(prompts[1].includes(addition));
    yield { type: 'item.completed', item: { type: 'agent_message', text: '按插话继续执行。' } };
  }

  /** 只有新的一次 SDK 用户请求才能进入插话分支。 */
  async function runStreamed(input, { signal }) {
    prompts.push(input[0].text);
    assert.ok(prompts.length <= 2);
    if (bulk && prompts.length === 2) {
      const images = input.filter(function localImage(item) { return item.type === 'local_image'; });
      assert.equal(images.length, 1);
      check(fs.readFileSync(images[0].path).equals(fs.readFileSync(path.join(root, 'icons.png'))), '合并批次后原附件像素仍随续接请求送出');
    }
    return { events: events(signal) };
  }

  /** 模拟在途工具，验证插话之后的旧读取无法进入实际执行器。 */
  async function runTool(name, args) {
    reads.push(args.path);
    if (args.path === '在途读取') {
      assert.ok(harness.agent.pushInterjection(key, addition));
      assert.match(await call('过期读取'), /尚未执行/);
    }
    return args.path + '的真实结果';
  }

  /**
   * 在已取出第一波、等待附件准备期间提交剩余插话。
   * @param {object} event 生产收件箱向轮次报告的插话事件。
   * @returns {void} 记录原文，第二波走同一条真实收件入口。
   */
  function onEvent(event) {
    if (event.processingInterjectionIds) sendingIds = event.processingInterjectionIds;
    if (!bulk || event.type !== 'interjection') return;
    delivered.push(...event.texts);
    if (delivered.length === 12) queueMicrotask(submitRemaining);
  }
  /** 在第一波的异步准备阶段继续提交第 13 至 20 条。 */
  function submitRemaining() {
    for (let i = 12; i < burst.length; i++) assert.ok(harness.agent.pushInterjection(key, burst[i]));
  }

  session.thread = { runStreamed };
  codex.test.sessions.set(key, session);
  harness.agent.test.activeInterjectKeys.set(key, testInbox(key));
  try {
    const result = await harness.agent.test.runDirectWithInterjections(codex, {
      key, sig: 'fixture', modelCfg: { apiKey: 'test-no-network', vision: bulk }, tools: [{ name: 'read_file', parameters: { type: 'object' } }],
      taskScope: bulk ? harness.dependency('./agi-task-scope').create('请核对旧任务', [], false) : undefined,
      runTool, onEvent, signal: parent.signal, agiMode: true, turnText: '旧任务'
    }, key);
    if (bulk) {
      assert.deepEqual(delivered.map(function textOnly(text) { return text.split('\n')[0]; }), burst);
      check(true, '20 条均登记到本轮插话记录');
    }
    assert.deepEqual(reads, duringTool ? ['在途读取', '插话后的读取'] : ['插话后的读取']);
    check(result.content === '按插话继续执行。' && session.turns === 2 && !parent.signal.aborted,
      phase + '阶段只交接旧 SDK 调用，同一会话续接一次');
  } finally {
    codex.closeSession(key);
    harness.agent.test.activeInterjectKeys.delete(key);
    harness.agent.test.interjectInbox.delete(key);
  }
}

/**
 * 执行真实主窗 IPC 和悬浮栏入口，验证两处都向同一会话投递并在收尾时退回发送队列。
 * 只替换窗口对象与 Electron 注册器，不启动真实聊天。
 */
async function testRoutes(harness) {
  const source = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8').split('\r\n').join('\n');
  const deliveryStart = source.indexOf('function deliverChatInterjection(key, text, attachments) {');
  const floatStart = source.indexOf('function handleFloatBarSend(payload) {');
  const floatEnd = source.indexOf('\n}\n', floatStart);
  const ipcStart = source.indexOf("ipcMain.handle('chat:interject',");
  assert.ok(deliveryStart >= 0 && floatStart > deliveryStart && floatEnd > floatStart && ipcStart > floatEnd);
  const window = {};
  const broadcasts = [];
  const queued = [];
  const handlers = new Map();
  const context = {
    fs, path, require, agent: harness.agent,
    ipcMain: { handle: function handle(name, handler) { handlers.set(name, handler); } },
    getWin: function getWin() { return window; },
    resolveTurnTabId: function tabId(win, payload) { return payload.tabId; },
    makeSessionKey: function key(win, tabId) { return 'route:' + tabId; },
    broadcastToFloatBars: function broadcast(payload) { broadcasts.push(payload); },
    winFromKey: function winFromKey() { return window; },
    turnIsRunning: function running() { return true; },
    sendTo: function sendTo(win, channel, payload) { queued.push({ channel, payload }); }
  };
  vm.runInNewContext(source.substring(deliveryStart, floatEnd + 3) + '\n' + source.substring(ipcStart), context);
  const key = 'route:tab';
  harness.agent.test.activeInterjectKeys.set(key, testInbox(key));
  try {
    const reply = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '主窗需求' });
    context.handleFloatBarSend({ key, text: '小窗需求' });
    const inbox = harness.agent.test.takeInterjections(key);
    check(reply.ok && reply.key === key && inbox.length === 2 && inbox[0].text === '主窗需求' && inbox[1].text === '小窗需求',
      '主窗和悬浮窗的插话按提交顺序进入同一活动收件箱');
    check(queued.length === 1 && queued[0].channel === 'chat:float-user-message' &&
      queued[0].payload.tabId === 'tab' && queued[0].payload.interjection === true && queued[0].payload.text === '小窗需求',
      '悬浮窗只通知绑定主窗记录一条已接收的插话');
    check(broadcasts.some(function status(item) { return item.kind === 'status' && item.text.includes('下一次模型请求'); }),
      '悬浮窗确认已接收的插话会交给下一次模型请求');
    queued.length = 0;
    const imagePath = path.join(root, 'icons.png');
    const pictureReply = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '', attachments: [{ path: imagePath, name: '参考图.png' }] });
    context.handleFloatBarSend({ key, text: '看图片', attachments: [{ path: imagePath, name: '参考图.png' }] });
    const pictures = harness.agent.test.takeInterjections(key);
    check(pictureReply.ok && pictures.length === 2 && pictures.every(function original(item) {
      return item.attachments[0].path === imagePath;
    }) && queued.length === 1 && queued[0].payload.images[0].startsWith('file:'),
      '主窗纯图和悬浮窗图文保留原图，悬浮窗存档保留可显示的预览');
    queued.length = 0;
    harness.agent.test.activeInterjectKeys.delete(key);
    const ended = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '收尾补充' });
    context.handleFloatBarSend({ key, text: '小窗收尾补充' });
    check(!ended.ok && ended.reason === 'not-accepting' && queued.length === 1 &&
      queued[0].payload.interjection === false && queued[0].payload.text === '小窗收尾补充',
      '收件箱关闭时主窗可继续使用原队列，悬浮窗普通请求转给绑定标签');
    const empty = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '  ' });
    check(!empty.ok && empty.reason === 'empty', '空消息不报告已接收');
  } finally {
    harness.agent.test.activeInterjectKeys.delete(key);
  }
}
/**
 * 提供可由测试明确释放的异步边界，不使用定时器猜测总结或评审已经开始。
 * @returns {object} promise 等待释放，resolve(value) 交付该边界的真实测试结果。
 */
function deferred() {
  let release;
  function capture(resolve) { release = resolve; }
  return { promise: new Promise(capture), resolve: release };
}
/**
 * 在真实 AGI 直通和收尾中并行观察 Chromium 及执行游戏代码。只隔离模型和桌面定位传输，
 * 通过实际页面标题和 Node 游戏结果相互等待，串行实现会卡在第一个目标。
 */
async function testParallelAgi() {
  const root = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spcode-parallel-'));
  const workspace = path.join(root, 'current-project');
  const otherProject = path.join(root, 'other-project');
  fs.mkdirSync(workspace);
  fs.mkdirSync(otherProject);
  fs.writeFileSync(path.join(otherProject, 'other.cjs'), '原项目内容', 'utf8');
  fs.symlinkSync(otherProject, path.join(workspace, 'other-project-link'), 'junction');
  const { BrowserWindow, nativeImage } = require('electron');
  const page = new BrowserWindow({ show: false, width: 540, height: 320 });
  const secondPage = new BrowserWindow({ show: false, width: 540, height: 320 });
  const browserGoal = '检查浏览器页面标题';
  const gameGoal = '编写一个可运行的小游戏';
  const secondGoal = '操作第二个浏览器窗口';
  const order = '同时' + browserGoal + '，并' + gameGoal + '，以及' + secondGoal + '。';
  const observed = deferred();
  const gameVerified = deferred();
  const steps = [];
  const childKeys = new Set();
  let finish;
  let firstFocus = false;
  let secondFocus = false;
  let activeProject = workspace;

  /** 夹具只启用自己创建的真实浏览器窗口，保持生产工具及队列入口。 */
  function isAlive() { return true; }

  /** 在桌面工具调用发生时切换实际窗口，验证前台状态后才返回。 */
  async function windowFocus(title) {
    const target = title === browserGoal ? page : secondPage;
    target.show();
    target.focus();
    const deadline = Date.now() + 3000;
    while (!target.isFocused() && Date.now() < deadline) await new Promise(function poll(resolve) { setTimeout(resolve, 20); });
    assert.ok(target.isFocused(), title + ' 没有获得系统焦点');
    if (target === page) {
      firstFocus = true;
      steps.push('第一个窗口获得系统焦点');
    } else {
      secondFocus = true;
      steps.push('第二个窗口获得系统焦点');
    }
    return '窗口已获得系统焦点';
  }
  /** 捕获真正获得焦点的 Chromium 窗口，等待按钮后的画面合成。 */
  async function captureScreen() {
    const target = BrowserWindow.getFocusedWindow();
    assert.ok(target === page || target === secondPage);
    await target.webContents.executeJavaScript('new Promise(function painted(resolve) { requestAnimationFrame(function next() { requestAnimationFrame(resolve); }); })');
    const image = await target.webContents.capturePage();
    const screenshot = path.join(root, 'window-' + target.id + '.png');
    fs.writeFileSync(screenshot, image.toPNG());
    return { ok: true, path: screenshot, originX: 0, originY: 0 };
  }

  /** 用 Chromium 输出的实际像素核对按钮作用，模型传输留在测试进程内。 */
  async function inspectPixels(args) {
    const imagePart = args.messages[0].content.find(function image(part) { return part.type === 'image_url'; });
    const image = nativeImage.createFromDataURL(imagePart.image_url.url);
    assert.deepEqual([...image.toBitmap().subarray(0, 3)], [68, 51, 204]);
    return { content: '实际窗口像素显示按钮操作后的红色页面。' };
  }

  /** 让生产 screen_look 使用隔离的看图回包。 */
  function visionFrom() { return { model: 'fixture-vision', protocol: 'codex' }; }

  /** 从实际 Chromium 页面读标题，保持观察请求在途直到游戏测试完成。 */
  async function observeRuntime(_workspace, _snap, args) {
    const first = args.condition?.key === 'first';
    const target = first ? page : secondPage;
    if (first) {
      steps.push('网页操作已开始');
      observed.resolve();
      await gameVerified.promise;
      assert.equal(secondFocus, false);
      assert.ok(page.isFocused());
    }
    const actual = await target.webContents.executeJavaScript('document.querySelector("button").click(); document.title');
    return { status: 'matched', record: { actual } };
  }
  /** 用受控模型事件选择真实工具，核对父子会话和资源权限。 */
  async function child(args) {
    assert.equal(args.sdkOnly, true);
    assert.equal(args.agiMode, true);
    verifyToolCatalog(args.systemContext, args.tools);
    assert.ok(!childKeys.has(args.key));
    childKeys.add(args.key);
    const names = args.tools.map(function name(tool) { return tool.name; });
    assert.ok(!names.includes('run_agi_parallel'));
    const isBrowser = args.turnText.startsWith('【当前并发目标】' + browserGoal);
    const isSecond = args.turnText.startsWith('【当前并发目标】' + secondGoal);
    let result;
    if (isBrowser) {
      assert.ok(names.includes('runtime_state') && !names.includes('write_file'));
      try {
        assert.equal(await args.runTool('window_focus', { title: browserGoal }), '窗口已获得系统焦点');
      } catch (error) {
        observed.resolve();
        throw error;
      }
      const observation = await args.runTool('runtime_state', { action: 'wait', condition: { key: 'first' } });
      assert.equal(JSON.parse(observation).record.actual, 'Parallel Web Fixture: clicked');
      const pixels = await args.runTool('screen_look', { question: '核对第一个网页按钮操作后的实际颜色' });
      assert.match(pixels, /红色页面/);
      result = 'Parallel Web Fixture: clicked';
      steps.push('第一个网页按钮已点击');
    } else if (isSecond) {
      assert.ok(steps.includes('第一个网页按钮已点击'));
      assert.equal(await args.runTool('window_focus', { title: secondGoal }), '窗口已获得系统焦点');
      assert.ok(secondPage.isFocused() && !page.isFocused());
      const observation = await args.runTool('runtime_state', { action: 'wait', condition: { key: 'second' } });
      assert.equal(JSON.parse(observation).record.actual, 'Second Web Fixture: clicked');
      const pixels = await args.runTool('screen_look', { question: '核对第二个网页按钮操作后的实际颜色' });
      assert.match(pixels, /红色页面/);
      result = 'Second Web Fixture: clicked';
      steps.push('第二个网页按钮已点击');
    } else {
      assert.ok(names.includes('write_file') && !names.includes('keyboard_key'));
      await observed.promise;
      // 在已经启动的分支持有原工作区时切换主窗口工作区来源。
      activeProject = otherProject;
      finish.context.workspace = activeProject;
      steps.push('当前项目已切到 B');
      try {
        assert.equal(firstFocus, true);
        assert.equal(secondFocus, false);
        const outside = path.join(otherProject, 'other.cjs');
        const blockedWrite = await args.runTool('write_file', { path: outside, content: '意外写入' });
        const blockedRead = await args.runTool('read_file', { path: outside });
        const blockedCommand = await args.runTool('run_command', { command: 'node other.cjs', cwd: otherProject });
        assert.match(blockedWrite, /超出范围/);
        assert.match(blockedRead, /超出范围/);
        assert.match(blockedCommand, /超出范围/);
        const blockedLink = await args.runTool('write_file', { path: 'other-project-link/new.cjs', content: '意外写入' });
        assert.match(blockedLink, /超出范围/);
        const blockedLinkCommand = await args.runTool('run_command', { command: 'node --version', cwd: ' other-project-link ' });
        assert.match(blockedLinkCommand, /超出范围/);
        assert.equal(fs.existsSync(path.join(otherProject, 'new.cjs')), false);
        assert.equal(fs.readFileSync(outside, 'utf8'), '原项目内容');
        check(true, '子代理的绝对路径、目录联接和命令工作目录均不能串到其他项目');
        const written = await args.runTool('write_file', {
          path: 'game.cjs', content: 'let points = 0; points += 2; console.log("game-points=" + points);'
        });
        assert.match(written, /已写入/);
        const passed = await args.runTool('run_command', { activity: 'test', command: 'node game.cjs' });
        assert.match(passed, /exit: 0/);
        assert.match(passed, /game-points=2/);
        assert.equal(activeProject, otherProject);
        assert.ok(fs.existsSync(path.join(workspace, 'game.cjs')));
        assert.equal(fs.existsSync(path.join(otherProject, 'game.cjs')), false);
        check(true, '运行中切到项目 B，项目 A 的子代理仍把游戏写入 A 并实际跑出得分 2，项目 B 没有产物');
        steps.push('项目 A 游戏已运行');
        result = '小游戏实际运行得分 2。';
      } finally {
        // 主轮验收继续使用它发起时的工作区，而非当前窗口选中的项目。
        finish.context.workspace = workspace;
        gameVerified.resolve();
      }
    }
    assert.equal(await args.runTool('finish_agi_task', { status: 'completed', result }), '本项结果已登记。');
    return { content: '本项结果已登记。' };
  }
  /** 主会话只在三个分支都返回后收尾，逐项核对各自的实际结果。 */
  async function parent(args) {
    assert.ok(args.tools.some(function parallelTool(tool) { return tool.name === 'run_agi_parallel'; }));
    verifyToolCatalog(args.systemContext, args.tools);
    assert.match(args.systemContext, /- read_file：读取文本[^\n]*必填参数：path/);
    const output = await args.runTool('run_agi_parallel', { tasks: [
      { goal: browserGoal, resource: 'desktop' }, { goal: gameGoal, resource: 'project' }, { goal: secondGoal, resource: 'desktop' }
    ] });
    const results = JSON.parse(output);
    assert.deepEqual(results.map(function status(item) { return [item.goal, item.status]; }), [
      [browserGoal, 'completed'], [gameGoal, 'completed'], [secondGoal, 'completed']
    ], JSON.stringify({ results, steps }));
    assert.deepEqual(results.map(function receipt(item) { return item.result; }), [
      'Parallel Web Fixture: clicked', '小游戏实际运行得分 2。', 'Second Web Fixture: clicked'
    ]);
    steps.push('主会话收到三个结果');
    return { content: '两个网页按钮已点击，小游戏运行得分 2。' };
  }
  try {
    const fixture = '<button onclick="document.title += &quot;: clicked&quot;; document.documentElement.style.background = &quot;#cc3344&quot;">Click</button>';
    await page.loadURL('data:text/html,' + encodeURIComponent('<title>Parallel Web Fixture</title>' + fixture));
    await secondPage.loadURL('data:text/html,' + encodeURIComponent('<title>Second Web Fixture</title>' + fixture));
    const harness = loadAgent({ './codex-direct': { runTurn: child, closeSession: noop },
      './desktop-hand': { isAlive, windowFocus, captureScreen }, './runtime-state-tool': { run: observeRuntime },
      './assembly': { ...require('../electron/lib/assembly'), visionFrom }, './codex-model': { complete: inspectPixels } });
    finish = finishHarness(harness, { runTurn: parent }, 'parallel-execution');
    finish.context.workspace = workspace;
    finish.context.userText = order;
    finish.context.messages = [{ role: 'system', content: '验收规则' }, { role: 'user', content: order }];
    finish.context.toolsFor = harness.agent.toolsSpec;
    finish.context.snap.taskScope = harness.dependency('./agi-task-scope').create(order, [], false);
    finish.context.snap.current = null;
    /** 用生产收尾当前版本的实际命令回执核对实现。 */
    async function review() {
      assert.match(finish.context.snap.selfTestEvidence, /game-points=2/);
      assert.match(finish.context.snap.selfTestEvidence, /Second Web Fixture: clicked/);
      steps.push('统一验收');
      return 'current-pass';
    }
    finish.context.summarizeImplementation = review;
    const result = await finish.run();
    assert.deepEqual(steps, ['第一个窗口获得系统焦点', '网页操作已开始', '当前项目已切到 B', '项目 A 游戏已运行',
      '第一个网页按钮已点击', '第二个窗口获得系统焦点', '第二个网页按钮已点击', '主会话收到三个结果', '统一验收']);
    console.log('PARALLEL STEPS ' + steps.join(' → '));
    check(firstFocus && secondFocus, '两个真实 Chromium 窗口有序交接系统焦点，第二个窗口等第一个网页操作完成');
    assert.equal(childKeys.size, 3);
    assert.equal(result.taskPending, false);
    assert.ok(finish.context.snap.createdFiles.has('game.cjs'));
    assert.match(fs.readFileSync(path.join(workspace, 'game.cjs'), 'utf8'), /game-points=/);
    const panel = finish.events.filter(function progress(item) { return item.type === 'agi_parallel'; });
    /** 读取宿主向界面发布的完整快照，跨 VM 比较时使用测试进程自己的数组。 */
    function statuses(event) { return Array.from(event.tasks, function taskStatus(task) { return task.status; }); }
    assert.deepEqual(statuses(panel[0]), ['queued', 'queued', 'queued']);
    assert.ok(panel.some(function overlap(event) { return statuses(event).join(',') === 'running,running,queued'; }));
    assert.deepEqual(statuses(panel.at(-1)), ['completed', 'completed', 'completed']);
    const receipts = Array.from(panel.at(-1).tasks, function receipt(task) { return task.result; });
    assert.deepEqual(receipts, ['Parallel Web Fixture: clicked', '小游戏实际运行得分 2。', 'Second Web Fixture: clicked']);
    check(finish.events.filter(function done(ev) { return ev.type === 'done'; }).length === 1,
      '同一 Codex 请求中真实网页操作与游戏运行重叠，三个分支分别返回并统一交付一次');
  } finally {
    page.destroy();
    secondPage.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

/**
 * 通过普通 API 大脑的真实工具循环执行两项目标。观察和读盘同步交叉，
 * 空白的子会话正文不会覆盖主会话的两项交付。
 */
async function testParallelOrdinary() {
  const workspace = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spcode-parallel-ordinary-'));
  const deskGoal = '查看验收窗口';
  const fileGoal = '读取项目样本';
  const order = deskGoal + '，同时' + fileGoal + '。';
  const started = deferred();
  const read = deferred();
  fs.writeFileSync(path.join(workspace, 'sample.txt'), 'parallel-file-marker', 'utf8');
  /** 让真实普通循环生成桌面工具回执，等项目读盘也结束后返回。 */
  async function observe() {
    started.resolve();
    await read.promise;
    return { status: 'matched', record: { actual: 'parallel-window-marker' } };
  }
  /** 构造普通模型接口支持的函数调用消息。 */
  function call(name, args) {
    return { role: 'assistant', content: '', tool_calls: [{ id: name, type: 'function',
      function: { name, arguments: JSON.stringify(args) } }] };
  }
  /** 只替换模型传输，两个分支和主会话均通过生产接口处理工具和回执。 */
  async function complete(args) {
    verifyToolCatalog(args.messages[0].content, args.tools);
    const goal = args.messages.find(function branch(message) { return String(message.content).startsWith('【当前并发目标】'); });
    const response = args.messages.findLast(function toolResponse(message) { return message.role === 'tool'; });
    if (!goal) {
      if (!response) return call('run_agi_parallel', { tasks: [
        { goal: deskGoal, resource: 'desktop' }, { goal: fileGoal, resource: 'project' }
      ] });
      const results = JSON.parse(response.content);
      assert.deepEqual(results.map(function done(item) { return item.status; }), ['completed', 'completed']);
      return { role: 'assistant', content: '窗口和项目样本均已核对。' };
    }
    const desktop = goal.content.startsWith('【当前并发目标】' + deskGoal);
    if (!response) {
      if (desktop) return call('runtime_state', { action: 'wait' });
      await started.promise;
      return call('read_file', { path: 'sample.txt' });
    }
    if (response.tool_call_id === 'finish_agi_task') return { role: 'assistant', content: '本项目标已提交。' };
    const marker = desktop ? 'parallel-window-marker' : 'parallel-file-marker';
    assert.ok(response.content.includes(marker), response.content);
    if (!desktop) read.resolve();
    return call('finish_agi_task', { status: 'completed', result: marker });
  }
  try {
    const harness = loadAgent({ './runtime-state-tool': { run: observe } });
    harness.setComplete(complete);
    const brain = brainHarness(harness, null, 'parallel-ordinary', false);
    brain.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
    brain.context.workspace = workspace;
    brain.context.userText = order;
    const answer = await brain.run([{ role: 'user', content: order }], false);
    check(answer === '窗口和项目样本均已核对。', '普通模型同轮并发执行桌面与项目工具，主会话收齐两个结果');
    harness.setAlive(false);
    check(!harness.agent.toolsSpec().some(function parallelTool(entry) { return entry.function.name === 'run_agi_parallel'; }),
      'AGI 关闭时工具列表不提供并发入口');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

/**
 * 缩短传输等待窗口，强制主会话先收到运行中，再自动收到原批次结果。
 * 主会话重复请求和子代理请求嵌套启动均不得产生新分支。
 */
async function testDeferredParallel() {
  const parallel = require('../electron/lib/agi-parallel');
  const firstGoal = '读取软件包定义';
  const secondGoal = '读取渲染页面结构';
  const order = firstGoal + '，同时' + secondGoal + '。';
  const tasks = [{ goal: firstGoal, resource: 'project' }, { goal: secondGoal, resource: 'project' }];
  const released = deferred();
  const children = [];
  let parentRequests = 0;
  let sessionKey;
  let sessionSig;

  /** 使用真实定时器路径，加速传输提前归还的验收。 */
  function initialResult(batch) { return parallel.initialResult(batch, 15); }
  /** 持有真实分支直到主会话收到运行中，接着读取项目文件并提交证据。 */
  async function child(args) {
    children.push(args.key);
    verifyToolCatalog(args.systemContext, args.tools);
    assert.match(await args.runTool('run_agi_parallel', { tasks }), /超出当前任务/);
    await released.promise;
    const source = args.turnText.startsWith('【当前并发目标】' + firstGoal) ? 'package.json' : 'renderer/index.html';
    const content = await args.runTool('read_file', { path: source, startLine: 1, endLine: 5 });
    assert.match(content, /【文件】/);
    assert.equal(await args.runTool('finish_agi_task', { status: 'completed', result: source }), '本项结果已登记。');
    return { content: source };
  }
  /** 在主会话两次尝试重复启动，确认只接到第一次实际工具的结果。 */
  async function parent(args) {
    parentRequests++;
    if (parentRequests === 1) {
      sessionKey = args.key;
      sessionSig = args.sig;
      try {
        assert.match(await args.runTool('run_agi_parallel', { tasks }), /仍在运行/);
        assert.equal(children.length, 2);
        const repeated = await args.runTool('run_agi_parallel', { tasks });
        assert.ok(repeated.includes(firstGoal) && repeated.includes('仍在执行'), repeated);
        assert.equal(children.length, 2, '运行中的原目标不能创建第三个分支');
      } finally {
        // 宿主在退出请求前等待分支。先释放本例分支，断言失败才能报告原始错误。
        released.resolve();
      }
      return { content: '提前汇报，不应被当作最终结果' };
    }
    assert.equal(parentRequests, 2);
    assert.equal(args.key, sessionKey);
    assert.equal(args.sig, sessionSig);
    assert.match(args.turnText, /【子代理实际结果】[\s\S]*package\.json[\s\S]*renderer\/index\.html/);
    // 无新增要求时重复提交原目标，子会话数和已读取的原回执必须保持一致。
    await args.runTool('run_agi_parallel', { tasks });
    assert.equal(children.length, 2);
    for (const goal of [firstGoal, secondGoal]) assert.equal(brain.context.snap.parallelResults.get(goal).status, 'completed');
    return { content: '两项读取已核对。' };
  }

  const harness = loadAgent({ './agi-parallel': { ...parallel, initialResult },
    './codex-direct': { runTurn: child, closeSession: noop } });
  const brain = brainHarness(harness, { runTurn: parent }, 'parallel-deferred');
  brain.context.workspace = root;
  brain.context.userText = order;
  brain.context.toolsFor = harness.agent.toolsSpec;
  brain.context.snap.taskScope = harness.dependency('./agi-task-scope').create(order, [], false);
  try {
    const answer = await brain.run([{ role: 'user', content: order }], false);
    check(answer === '两项读取已核对。' && parentRequests === 2 && children.length === 2,
      '长批次提前归还工具，由宿主等原批次并续接；同轮重复启动和子代理嵌套均未创建新分支');
    const progress = brain.events.filter(function report(item) { return item.type === 'agi_parallel'; });
    check(progress.at(-1).tasks.every(function completed(item) { return item.status === 'completed'; }),
      '长批次等待后工作台收到全部完成状态');
  } finally {
    released.resolve();
  }
}

/**
 * 验证首批交回后，真实插话增加的独立交付能单独交给新的子代理。
 * @returns {Promise<void>} 核对用户原话、三个独立会话及真实读盘回执；重复派发或丢失任一结果都会失败。
 */
async function testParallelAddition() {
  const key = 'parallel-new-deliverable';
  const goals = ['读取软件包定义', '读取渲染页面结构', '读取并发模块源码'];
  const files = ['package.json', 'renderer/index.html', 'electron/lib/agi-parallel.js'];
  const order = goals.slice(0, 2).join('，同时') + '，随后逐项汇总。';
  const branchKeys = new Set();
  const reads = [];
  let rounds = 0;

  /** 将用户原话 goal 原样交给项目资源队列。 */
  function project(goal) { return { goal, resource: 'project' }; }
  /**
   * 在 args 所指的真实分支里读盘并提交对应目标的证据。
   * @returns {Promise<object>} 分支的传输结束消息，真实交付取自 finish_agi_task。
   */
  async function child(args) {
    const index = goals.findIndex(function requested(goal) { return args.turnText.startsWith('【当前并发目标】' + goal + '\n'); });
    assert.ok(index >= 0, args.turnText);
    branchKeys.add(args.key);
    const receipt = await args.runTool('read_file', { path: files[index], startLine: 1, endLine: 3 });
    assert.match(receipt, /【文件】/);
    reads.push(files[index]);
    assert.equal(await args.runTool('finish_agi_task', { status: 'completed', result: files[index] }), '本项结果已登记。');
    return { content: '本项目标已提交。' };
  }
  /**
   * 从主会话 args 派发首批，在汇总时插入新目标，然后提交单项追加。
   * @returns {Promise<object>} 完整回执核对完毕后返回主会话答复。
   */
  async function parent(args) {
    rounds++;
    if (rounds === 1) {
      const initial = JSON.parse(await args.runTool('run_agi_parallel', { tasks: goals.slice(0, 2).map(project) }));
      assert.deepEqual(initial.map(function receipt(row) { return row.result; }), files.slice(0, 2));
      assert.ok(harness.agent.pushInterjection(key, '另外，' + goals[2] + '。'));
      return { content: '首批证据已收到。' };
    }
    assert.equal(rounds, 2);
    assert.ok(args.turnText.includes(goals[2]));
    const result = await args.runTool('run_agi_parallel', { tasks: [project(goals[2])] });
    assert.ok(result.startsWith('['), result);
    const additions = JSON.parse(result);
    assert.ok(additions.some(function completed(row) { return row.goal === goals[2] && row.status === 'completed' && row.result === files[2]; }));
    return { content: '三项目标已逐项核对。' };
  }
  const harness = loadAgent({ './codex-direct': { runTurn: child, closeSession: noop } });
  const brain = brainHarness(harness, { runTurn: parent }, key);
  brain.context.workspace = root;
  brain.context.userText = order;
  brain.context.toolsFor = harness.agent.toolsSpec;
  const answer = await brain.run([{ role: 'user', content: order }], false);
  assert.equal(answer, '三项目标已逐项核对。');
  assert.equal(branchKeys.size, 3);
  assert.deepEqual(reads.sort(), files.slice().sort());
  for (const goal of goals) assert.equal(brain.context.snap.parallelResults.get(goal).status, 'completed');
  check(true, '首批后收到独立插话，只增派一个子代理，三个目标各有一次真实读盘和完成回执');
}

/**
 * 验证普通模型把多条独立插话并发派给子会话，执行中随后到达的新目标可立即加入。
 * @returns {Promise<void>} 使用生产模型循环，核对三个分支的启动重叠、真实读取和按批次归还的结果。
 */
async function testParallelBeforeFirstBatch() {
  const original = '读取软件包名称';
  const related = '同一个软件包再核对版本号';
  const independent = '读取渲染页面定义';
  const late = '读取插话账本源码';
  const key = 'parallel-before-first';
  const children = new Set();
  const entries = new Set();
  const bothStarted = deferred();
  let injected = false;
  let appended = false;
  let joined = false;
  /** 以 API 传输格式返回 name 和 args，交由生产工具入口执行。 */
  function call(name, args) {
    return { role: 'assistant', content: '', tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
  }
  /**
   * 响应真实模型请求 args。首个大脑请求中送达插话，两个子会话会合后各读取一次目标文件。
   * @returns {Promise<object>} 返回下一项实际工具调用或记录完整结果的答复。
   */
  async function complete(args) {
    const goal = args.messages.find(function branch(message) { return String(message.content).startsWith('【当前并发目标】'); });
    const receipt = args.messages.findLast(function response(message) { return message.role === 'tool'; });
    if (!goal) {
      if (!injected) {
        injected = true;
        assert.ok(harness.agent.pushInterjection(key, related));
        assert.ok(harness.agent.pushInterjection(key, independent));
        assert.ok(harness.agent.pushInterjection(key, '继续'));
        return { role: 'assistant', content: '原请求结束。' };
      }
      if (!receipt) {
        const texts = args.messages.map(function content(m) { return String(m.content); });
        for (const text of [related, independent, '各交给一个子代理同时处理']) assert.ok(texts.some(function contains(line) { return line.includes(text); }), text);
        return call('run_agi_parallel', { tasks: [{ goal: original, resource: 'project' }, { goal: independent, resource: 'project' }] });
      }
      if (!appended) {
        assert.match(receipt.content, /仍在运行/);
        assert.ok(args.messages.some(function newGoal(row) { return String(row.content).includes(late); }));
        appended = true;
        return call('run_agi_parallel', { tasks: [{ goal: late, resource: 'project' }] });
      }
      const old = args.messages.find(function results(row) { return String(row.content).startsWith('【子代理实际结果】'); });
      assert.ok(old && old.content.includes('包名和版本均已读取') && old.content.includes('页面定义已读取'));
      assert.equal(JSON.parse(receipt.content)[0].result, '账本源码已读取');
      const ledger = harness.agent.test.activeInterjectKeys.get(key);
      const items = ledger.memory.current.interjectionTodos;
      for (const item of items.filter(function separate(i) { return i.text === independent || i.text === late; })) {
        assert.equal(item.status, 'completed', '子代理独立交付后，原插话须在主会话结束前办结');
        assert.equal(item.result, item.text === independent ? '页面定义已读取' : '账本源码已读取');
      }
      assert.equal(items.find(function relatedItem(i) { return i.text === related; }).status, 'pending');
      return { role: 'assistant', content: '三个分支的实际结果均已核对。' };
    }
    const isPackage = goal.content.startsWith('【当前并发目标】' + original + '\n');
    const isLate = goal.content.startsWith('【当前并发目标】' + late + '\n');
    let file = 'renderer/index.html';
    if (isPackage) file = 'package.json';
    if (isLate) file = 'electron/lib/interjection-todos.js';
    if (!receipt) {
      if (isPackage) assert.ok(goal.content.includes(related), '补充约束需要送入负责原交付的分支');
      assert.ok(!entries.has(file), '同一目标只启动一次');
      entries.add(file);
      // 两个原分支等待第三个分支入场，任何串行等待都会触发下方的超时断言。
      if (entries.size === 2) assert.ok(harness.agent.pushInterjection(key, late));
      if (isLate) {
        joined = entries.size === 3 && children.size === 0;
        bothStarted.resolve();
      }
      await bothStarted.promise;
      return call('read_file', { path: file, startLine: 1, endLine: 12 });
    }
    if (receipt.tool_call_id === 'finish_agi_task') return { role: 'assistant', content: '本项已提交。' };
    assert.match(receipt.content, /【文件】/);
    if (isPackage) {
      assert.match(receipt.content, /"name"/);
      assert.match(receipt.content, /"version"/);
    }
    children.add(file);
    let result = '页面定义已读取';
    if (isPackage) result = '包名和版本均已读取';
    if (isLate) result = '账本源码已读取';
    return call('finish_agi_task', { status: 'completed', result });
  }
  const harness = loadAgent();
  harness.setComplete(complete);
  const brain = brainHarness(harness, null, key, false);
  brain.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
  brain.context.workspace = root;
  brain.context.userText = original;
  const timeout = setTimeout(function releaseForFailure() { bothStarted.resolve(); }, 10000);
  try {
    const answer = await brain.run([{ role: 'user', content: original }], false);
    assert.equal(answer, '三个分支的实际结果均已核对。');
    check(joined && children.size === 3, '三项独立工作在任一子代理交付前均已启动，各取一次真实回执；相关补充及继续没有额外分支');
    const overlap = brain.events.find(function simultaneous(event) {
      return event.type === 'agi_parallel' && event.tasks.filter(function active(task) { return task.status === 'running'; }).length === 3;
    });
    assert.ok(overlap, '工作台应收到三个同时运行的真实分支');
    const linked = overlap.tasks.filter(function interjected(task) { return task.interjectionIds?.length; });
    assert.deepEqual(Array.from(linked, function goal(task) { return task.goal; }), [independent, late]);
    check(linked[0].interjectionIds[0] !== linked[1].interjectionIds[0], '运行中的子代理按原话关联到两条不同的插话卡片');
  } finally {
    clearTimeout(timeout);
    bothStarted.resolve();
  }
}

/** 核对桌面独占、未验证结果、中断后排队动作及用户原文范围。 */
async function testParallelBoundaries() {
  const parallel = require('../electron/lib/agi-parallel');
  // 同一文件中的额外要求不能由局部目标办结；相同原话在派单之后又送达，也有自己的编号。
  const inbox = testInbox('partial-delivery');
  const goal = '修改账款合计';
  const one = inbox.receive(goal);
  const compound = inbox.receive(goal + '，并导出月报');
  inbox.markSeen([one, compound]);
  const dispatchedIds = inbox.idsForGoal(goal);
  const lateCopy = inbox.receive(goal);
  inbox.markSeen([lateCopy]);
  inbox.deliverBranch(goal, dispatchedIds, '新合计已交付');
  inbox.deliverBranch(goal, dispatchedIds, '重复终态');
  const saved = inbox.memory.current.interjectionTodos;
  assert.equal(saved[0].result, '新合计已交付');
  assert.deepEqual(saved.map(function state(item) { return item.status; }), ['completed', 'pending', 'pending']);
  check(true, '独立分支仅办结派单时覆盖的完整插话，保留局部要求与稍后重复到达的卡片');
  const goals = ['打开网页甲', '打开网页乙', '验证游戏'];
  const tasks = parallel.tasksFrom({ tasks: [
    { goal: goals[0], resource: 'desktop' }, { goal: goals[1], resource: 'desktop' },
    { goal: goals[2], resource: 'project' }
  ] }, goals);
  const desktopStarted = deferred();
  const projectStarted = deferred();
  const projectReported = deferred();
  const releaseDesktop = deferred();
  const events = [];
  let interrupted = false;
  /** 按资源发布测试工具，实际调用仍由并发入口校验。 */
  function toolsFor(resource) { return [{ function: { name: resource } }]; }
  /** 记录共享资源的进入顺序，让项目与正在使用的前台重叠。 */
  async function runTool(task) {
    events.push(task.goal);
    if (task.goal === goals[0]) {
      desktopStarted.resolve();
      return releaseDesktop.promise;
    }
    projectStarted.resolve();
    return '游戏已运行';
  }
  /** 模拟旧模型退出前已经提交两次桌面动作。 */
  async function runBranch(task, spec, dispatch) {
    if (task.resource === 'project') {
      assert.match(await dispatch('finish_agi_task', { status: 'completed', result: '没有实际回执' }), /先使用实际工具/);
      await desktopStarted.promise;
      await dispatch('project', {});
      await dispatch('finish_agi_task', { status: 'blocked', result: '测试输出未达到预期' });
      projectReported.resolve();
      return;
    }
    const running = dispatch('desktop', {});
    const queued = dispatch('desktop', {});
    await Promise.all([running, queued]);
  }
  /** 收件箱状态由测试控制，未启动的桌面动作须在入队后重查。 */
  function isInterrupted() { return interrupted; }
  const done = parallel.run(tasks, { runBranch, runTool, toolsFor, interrupted: isInterrupted, onProgress: noop });
  await projectStarted.promise;
  await new Promise(setImmediate);
  assert.deepEqual(events, [goals[0], goals[2]]);
  await projectReported.promise;
  const crossSession = [];
  /** 同一主进程里的另一轮桌面任务进入真实的前台队列。 */
  function secondSession() { crossSession.push('第二轮获得前台'); }
  const waiting = parallel.useDesktop(secondSession);
  let focusCalls = 0;
  /** 代替系统窗口切换，检查普通会话只在桌面空闲时到达执行器。 */
  function windowFocus() { focusCalls++; return '目标窗口已聚焦'; }
  /** 模拟测试隔离环境中的 AGI 开关。 */
  function isAlive() { return true; }
  const ordinary = loadAgent({ './desktop-hand': { isAlive, windowFocus } });
  const execTool = ordinary.agent.test.execTool;
  const locked = await execTool(null, null, 'window_focus', { title: '另一个窗口' }, noop, [], null, ordinary.lang);
  assert.match(locked, /其他任务使用.*未执行/);
  assert.equal(focusCalls, 0);
  assert.deepEqual(crossSession, []);
  interrupted = true;
  releaseDesktop.resolve('网页已加载');
  const results = await done;
  await waiting;
  assert.deepEqual(crossSession, ['第二轮获得前台']);
  assert.equal(await execTool(null, null, 'window_focus', { title: '另一个窗口' }, noop, [], null, ordinary.lang), '目标窗口已聚焦');
  check(focusCalls === 1, '不同会话共用前台队列，普通窗口操作不会抢占已运行的桌面子代理');
  assert.deepEqual(results.map(function status(item) { return item.status; }), ['interrupted', 'interrupted', 'blocked']);
  assert.deepEqual(results[0].tools, ['desktop']);
  assert.deepEqual(events, [goals[0], goals[2]]);
  assert.throws(function inventedGoal() {
    parallel.tasksFrom({ tasks: [...tasks, { goal: '用户未要求的新动作', resource: 'project' }] }, goals);
  }, /引用当前用户原话/);
  check(true, '同一前台不争抢，未验证不得报完成，插话保留在途回执并阻止旧动作');

  const projectGoals = ['构建游戏', '保存项目记录'];
  const projectTasks = projectGoals.map(function project(goal) { return { goal, resource: 'project' }; });
  const compileStarted = deferred();
  const editQueued = deferred();
  const compileDone = deferred();
  const writes = [];
  /** 保持真实资源调用在途，验证另一个项目会话已开始但没有越过操作队列。 */
  async function occupyProject(task) {
    writes.push(task.goal);
    if (task.goal === projectGoals[0]) {
      compileStarted.resolve();
      await compileDone.promise;
    }
    return '项目操作已返回';
  }
  /** 同一工作区的两个模型可以启动，但修改及命令只能依次进入工具层。 */
  async function projectBranch(task, spec, dispatch) {
    if (task.goal === projectGoals[1]) {
      await compileStarted.promise;
      editQueued.resolve();
    }
    await dispatch('project', {});
    await dispatch('finish_agi_task', { status: 'completed', result: '已验证工作区操作。' });
  }
  interrupted = false;
  const projectDone = parallel.run(projectTasks, { runBranch: projectBranch, runTool: occupyProject,
    toolsFor, interrupted: isInterrupted, onProgress: noop });
  await editQueued.promise;
  assert.deepEqual(writes, [projectGoals[0]]);
  compileDone.resolve();
  const projectResults = await projectDone;
  assert.deepEqual(writes, projectGoals);
  check(projectResults.every(function passed(item) { return item.status === 'completed'; }),
    '同一工作区的独立模型会话并发启动，项目命令与写入保留顺序');
}

/**
 * 将生产轮次的接收生命周期和完整验收收尾放入可控模型环境。
 * @param {object} harness 真实 Agent 源码与工具适配器。
 * @param {object} direct 仅替换外部模型传输的直通对象。
 * @param {string} key 当前独立会话键。
 * @returns {object} run 执行真实收尾源码，context 可注入阻塞总结/审美，events 记录唯一最终交付。
 */
function finishHarness(harness, direct, key) {
  const brain = brainHarness(harness, direct, key);
  const source = harness.source;
  const turnStart = source.indexOf('async function runTurn({');
  const lifeStart = source.indexOf('  const archive = trainingArchive.current();', turnStart);
  const lifeEnd = source.indexOf('  // 标记本轮桌面任务', lifeStart);
  const enableStart = source.indexOf('  // 配置校验完成后开始接收', lifeEnd);
  const enableEnd = source.indexOf('  const extra = extraRoots(', enableStart);
  // 复用生产会话对手动需求与定时目标的取值，避免验收片段引用夹具中不存在的变量。
  const goalStart = source.indexOf('  const taskText =', enableEnd);
  const goalEnd = source.indexOf('  // 本轮明确只读', goalStart);
  const trackStart = source.indexOf('  const turnInterjections = [];', enableEnd);
  const trackEnd = source.indexOf('  let directWrites =', trackStart);
  const finishStart = source.indexOf('  const planItemsOn =', trackEnd);
  const finishEnd = source.indexOf('  // 只在用户明确表达偏好', finishStart);
  const resultReturn = '\n  return result;\n';
  const finalReturn = source.indexOf(resultReturn, finishEnd);
  const cleanupStart = finalReturn + resultReturn.length;
  const cleanupEnd = source.indexOf('\n}\n\nfunction listSkills', cleanupStart) + 2;
  assert.ok(lifeStart > turnStart && enableStart > lifeEnd && goalStart > enableEnd &&
    goalEnd > goalStart && trackStart > goalEnd && finishStart > trackEnd &&
    finalReturn > finishEnd && cleanupEnd > cleanupStart);
  const context = brain.context;
  context.interjectInbox = harness.agent.test.interjectInbox;
  context.interjectArchives = harness.agent.test.interjectArchives;
  context.trainingArchive = { current: function current() { return null; } };
  // 默认夹具中的功能要求都需交付，只有纯告知用例会返回实际知悉编号。
  context.reviewWithoutTools = async function noNotices() { return 'NONE'; };
  context.snapshot = { captureAfter: noop };
  context.vs = {};
  context.history = [];
  context.longAliveGoal = undefined;
  context.messages = messages();
  context.snap.taskScope = harness.dependency('./agi-task-scope').create(context.userText, context.history, context.turnStart);
  context.planMismatch = false;
  context.rollingSummary = '';
  context.zbaingMeta = null;
  context.explicitPreferenceSaved = false;
  context.planLock = null;
  context.turnId = 'finish-fixture';
  context.snap.current = { id: 'finish-fixture', manifest: { changes: [{ path: 'fixture.js', action: 'write' }] } };
  context.workingMemory = context.workingMemoryRef.current;
  context.compact = harness.dependency('./context-compact');
  context.diag = { log: noop };
  context.requirementText = harness.agent.test.requirementText;
  // 真实审美入口用当前交付指纹筛选录屏回执，沿用生产函数。
  context.implementationStateKey = harness.agent.test.implementationStateKey;
  context.summarizeImplementation = async function summarize() { return 'current-pass'; };
  context.judgePlanVerdict = function judge() { return { failed: false, saidPass: true, gaps: [], unproven: 0 }; };
  context.offPlanGapLines = function gaps() { return []; };
  context.offPlanFiles = function files() { return []; };
  context.asksIfFixed = function asks() { return false; };
  context.aestheticModelsOf = function models() { return []; };
  context.aestheticReview = {
    criticInstruction: function instruction() { return ''; },
    review: async function review() { return { passed: true, report: 'current-aesthetic' }; }
  };
  context.buildModulePrompt = function prompt() { return ''; };
  context.completeAesthetic = noop;
  context.withholdUnverifiedDelivery = harness.agent.test.withholdUnverifiedDelivery;
  context.chainLib = function chain() { return { parseChainItems: function parse() { return []; } }; };
  context.onEvent = function onEvent(event) {
    brain.events.push(event);
    if (event.type === 'done') check(!harness.agent.pushInterjection(key, 'done之后的消息'),
      'done同步交付前已关闭插话入口，不假报接收');
  };
  vm.runInNewContext(source.substring(trackStart, trackEnd) +
    '\nasync function finish() {\n' + source.substring(lifeStart, lifeEnd) +
    '\nglobalThis.workingMemoryRef = workingMemoryRef; snap.interjectionTodos = interjectionTodos;\n' +
    '\ntry {\n' + source.substring(enableStart, enableEnd) +
    source.substring(goalStart, goalEnd) + source.substring(finishStart, finishEnd) + '\nreturn result;\n' +
    source.substring(cleanupStart, cleanupEnd) + '\nthis.finish = finish;', context);
  return { run: context.finish, context, events: brain.events };
}
/**
 * 让真实 Agent 收尾处理评审结果，验证更早的功能通过能否被驳回。
 * @param {string} goal 用户原话。
 * @param {Function} review 接收生产审美入口参数，返回本次测试使用的审美结果。
 * @param {boolean} [leaveTodo] 在最终评审阶段保留一条当前任务的待办。
 * @returns {Promise<object>} 最终正文、交付标记和队列等待状态，供调用方核对。
 */
async function runAestheticDelivery(goal, review, leaveTodo) {
  const harness = loadAgent();
  /** 提供试图过早宣布完成的正文，确保断言覆盖实际拦截而非空答。 */
  async function model() { return { content: '按钮样式已经改完，可以交付。' }; }
  const finish = finishHarness(harness, { runTurn: model }, 'theme-aesthetic-delivery');
  const context = finish.context;
  context.workspace = root;
  context.userText = goal;
  context.snap.taskScope = harness.dependency('./agi-task-scope').create(goal, [], false);
  context.snap.current.manifest.changes = [{ path: 'theme.css', action: 'write' }];
  /**
   * 在实际收尾评审期间交付夹具结果，并可保留当前任务的待办。
   * @param {object} options 生产评审入口参数。
   * @returns {Promise<object>} 原始评审结果。
   */
  context.aestheticReview.review = async function reviewWithTodo(options) {
    if (leaveTodo) {
      context.snap.taskScope.todos.add('pending-delivery');
      context.workingMemoryRef.current.todos.push({ id: 'pending-delivery', status: 'pending' });
    }
    return review(options);
  };
  const selfTest = harness.dependency('./agi-self-test');
  // 将上游功能验收设为通过，单独验证真实收尾能否拦住评审驳回的成果。
  const seen = selfTest.begin(root, context.snap, [], 'screen_record', { hwnd: '1' }, context.implementationStateKey);
  selfTest.record(context.snap, seen, true, '隔离夹具中的上游验收记录');
  const result = await finish.run();
  const events = finish.events.filter(function done(event) { return event.type === 'done'; });
  assert.equal(events.length, 1);
  assert.equal(context.snap.planAccepted, true);
  return { text: result.text, taskSettled: events[0].taskSettled, taskPending: result.taskPending, blocked: context.snap.planBlocked === true };
}

/** 验证主题审美驳回、评审通过与用户明确只改配色的交付边界。 */
async function testAestheticDelivery() {
  const theme = '做一个根据游戏主题换UI的功能，根据每个主题换一下对应的按钮。';
  /** 用具体问题构造失败票结果，真实模型的失败票另由实拍测试走同一入口。 */
  async function failedReview() { return { passed: false, report: '两张实拍中只有配色变化。' }; }
  /** 以通过票验证主题交付不被拦截。 */
  async function passedReview() { return { passed: true, report: '两张实拍有各自的轮廓和边框。' }; }
  const denied = await runAestheticDelivery(theme, failedReview);
  check(denied.blocked && denied.taskPending === true && !denied.taskSettled && /不能交卷.*审美验收未通过/u.test(denied.text) &&
    !denied.text.includes('可以交付') && denied.text.includes('只有配色变化'), '主题审美失败拦截完成声明，保留失败理由和未完成状态');
  const passed = await runAestheticDelivery(theme, passedReview);
  check(!passed.blocked && passed.taskPending === false && passed.taskSettled && passed.text.includes('可以交付'), '主题审美通过后允许交付并释放队列');
  const pending = await runAestheticDelivery(theme, passedReview, true);
  check(pending.taskPending === true && !pending.taskSettled, '验收通过但有当前任务的遗留待办时，回执仍要求暂停队列');
  const limited = await runAestheticDelivery('按游戏主题切换按钮，仅更改颜色。', failedReview);
  check(!limited.blocked && limited.taskSettled && limited.text.includes('可以交付'), '明确只改颜色的任务沿用配色验收，不触发主题风格交付拦截');
  const explicit = await runAestheticDelivery('实现按游戏主题切换按钮样式，不能只换颜色。', failedReview);
  check(explicit.blocked && !explicit.taskSettled, '明确要求不能只换颜色时必须通过风格审美验收');
}

/**
 * 验证总结与审美期间接收的补充先回到原会话，旧验收不能覆盖最新要求。
 * @param {object} harness 隔离外部传输的真实 Agent 环境。
 * @returns {Promise<void>} 两种收尾阶段都完成续接、重验、隔离及唯一交付后兑现。
 */
async function testFinishInterjections(harness) {
  for (const stage of ['summary', 'aesthetic']) {
    const key = 'finish-' + stage;
    const entered = deferred();
    const release = deferred();
    const requests = [];
    let actions = 0;
    let summaries = 0;
    let aesthetics = 0;
    let sessionSignature = '';
    async function model(args) {
      requests.push(args);
      if (requests.length === 1) {
        sessionSignature = args.sig;
        await args.runTool('read_file', { path: 'successful-evidence' });
        return { content: '已完成原目标。' };
      }
      check(requests.length === 2 && args.key === key && args.sig === sessionSignature && args.fresh === false,
        stage + '插话沿用原SDK会话和真实签名');
      check(args.turnText.includes(finish.context.userText) && args.turnText.includes('新增核对条件') &&
        !args.turnText.includes('【本轮 AGI 状态】') && args.firstPrefix === '' && args.systemContext === '' && args.requiredToolNames.length === 0,
        stage + '续接重申原要求与新增条件，沿用会话规则和工具证据');
      return { content: '已完成新增核对条件。' };
    }
    const finish = finishHarness(harness, { runTurn: model }, key);
    finish.context.directRunTool = async function tool() { actions++; return '已成功的证据'; };
    finish.context.summarizeImplementation = async function summary(args) {
      summaries++;
      if (stage === 'summary' && summaries === 1) { entered.resolve(); await release.promise; return 'stale-pass'; }
      check(summaries === 1 || args.userText.includes('新增核对条件'), stage + '最终实现验收包含最新插话');
      return 'current-pass';
    };
    finish.context.judgePlanVerdict = function judge(verdict) {
      assert.notEqual(verdict, 'stale-pass', '过期总结不能进入通过/返工判定');
      return { failed: false, saidPass: true, gaps: [], unproven: 0 };
    };
    finish.context.aestheticReview.review = async function aesthetic(args) {
      aesthetics++;
      if (stage === 'aesthetic' && aesthetics === 1) { entered.resolve(); await release.promise; return { passed: true, report: 'stale-aesthetic' }; }
      check(args.userText.includes('新增核对条件'), stage + '最终审美使用最新插话目标');
      return { passed: true, report: 'current-aesthetic' };
    };
    harness.agent.test.activeInterjectKeys.set('finish-other', testInbox('finish-other'));
    check(harness.agent.pushInterjection('finish-other', '其它会话的补充'), stage + '另一会话保持独立收件箱');
    const running = finish.run();
    await entered.promise;
    check(harness.agent.pushInterjection(key, '新增核对条件'), stage + '仍在运行的验收阶段实际接收插话');
    release.resolve();
    const result = await running;
    check(requests.length === 2 && actions === 1 && summaries === 2, stage + '补充确实消费并重验，成功工具不重放');
    check(result.text.includes('新增核对条件') && !result.text.includes('stale-aesthetic') &&
      finish.events.filter(function done(event) { return event.type === 'done'; }).length === 1,
      stage + '只交付一次最新结果，丢弃旧评审报告');
    check(finish.events.filter(function boundary(event) { return event.type === 'interjection_reply_boundary'; }).length === 1,
      stage + '每批插话只通知界面一次，续接前保留此前正文');
    check(harness.agent.test.takeInterjections('finish-other')[0].text === '其它会话的补充',
      stage + '收尾与清理不会消费或清空其它会话');
    harness.agent.test.activeInterjectKeys.delete('finish-other');
  }
}
/**
 * 验证验收中用户停止立即拒收，释放后也不重启模型或发出完成事件。
 * @param {object} harness 真实生产收尾测试环境。
 * @returns {Promise<void>} 停止、拒收、清理和不重启均有断言后兑现。
 */
async function testFinishStopped(harness) {
  const entered = deferred();
  const release = deferred();
  const ctl = new AbortController();
  let requests = 0;
  async function model() { requests++; return { content: '已完成原目标。' }; }
  const finish = finishHarness(harness, { runTurn: model }, 'finish-stop');
  finish.context.signal = ctl.signal;
  finish.context.summarizeImplementation = async function summary() { entered.resolve(); await release.promise; return 'ignored'; };
  const running = finish.run();
  await entered.promise;
  ctl.abort();
  check(!harness.agent.pushInterjection('finish-stop', '停止后的补充'), '验收中用户停止立即拒收，不假接收待处理消息');
  release.resolve();
  await assert.rejects(running, { name: 'AbortError' });
  check(requests === 1 && !finish.events.some(function done(event) { return event.type === 'done'; }) &&
    !harness.agent.test.activeInterjectKeys.has('finish-stop'), '用户停止后验收退出，不重启原模型且释放入口');
}

/**
 * 验证 SDK 在读取队列前报错时，轮次既传回失败回执也清理原队列。
 * @param {object} harness 提供生产收件箱、真实大脑和收尾入口的隔离环境。
 * @returns {Promise<void>} 20 条未投递的计数与原错误一起返回，期间无额外 SDK 请求或完成事件。
 */
async function testFailedSdkReceipts(harness) {
  const key = 'finish-sdk-error';
  const count = 20;
  const failure = new Error('SDK 连接中断');
  let requests = 0;

  /** 在首个直通请求仍持有队列时接收整批插话，再模拟 SDK 的异常出口。 */
  async function model() {
    requests++;
    for (let index = 1; index <= count; index++) {
      assert.equal(harness.agent.pushInterjection(key, '未投递插话 ' + index), true);
    }
    assert.equal(harness.agent.test.interjectInbox.get(key).length, count);
    throw failure;
  }

  const finish = finishHarness(harness, { runTurn: model }, key);
  await assert.rejects(finish.run(), { message: '本轮已接收的 20 条插话未送达 AI。\nSDK 连接中断', cause: failure });
  assert.equal(requests, 1);
  assert.equal(harness.agent.test.interjectInbox.has(key), false);
  assert.equal(harness.agent.test.activeInterjectKeys.has(key), false);
  check(finish.events.every(function unfinished(event) { return event.type !== 'done'; }),
    'SDK 提前报错时，20 条已确认接收但未投递的插话收到准确失败回执，原错误保留且无额外请求');
}

/**
 * 验证已出队的 20 条插话在 SDK 续接失败时仍有独立回执。
 * @param {object} harness 提供生产大脑和轮次生命周期的隔离环境。
 * @returns {Promise<void>} 核对 SDK 启动与模型活动的差异、晚到消息的计数和失败收尾。
 */
async function testResumedSdkReceipts(harness) {
  for (const [confirmed, late] of [[false, 0], [false, 1], [true, 1]]) {
    const codex = loadCodexBridge();
    const key = 'resumed-sdk-error-' + confirmed + '-' + late;
    const sig = 'receipt';
    const session = { sig: sig + '\nagi:true\nreasoning:default', ctx: null, turns: 0 };
    const bridge = await codex.test.startBridge(session);
    session.server = bridge.server;
    codex.test.sessions.set(key, session);
    const received = '插话已送达 AI，正在继续处理…';
    const failure = '续接请求中断';
    let beforeActivity;
    let afterActivity;
    const finish = finishHarness(harness, { runTurn: runCodex }, key);
    session.thread = { runStreamed };

    /**
     * 以固定签名进入生产 Codex 适配器，避免夹具启动真实模型。
     * @param {object} args 生产大脑准备的会话、工具和事件参数。
     * @returns {Promise<object>} 当前 SDK 请求的实际结果或异常。
     */
    function runCodex(args) {
      return codex.runTurn({ ...args, sig, modelCfg: { apiKey: 'test-no-network' } });
    }

    /**
     * 模拟 SDK 返回事件，验证两个请求都经过生产流消费代码。
     * @param {Array<object>} input SDK 用户内容块。
     * @returns {Promise<object>} 含首轮和续接的受控事件流。
     */
    async function runStreamed(input) {
      return { events: events(input) };
    }

    /**
     * 在原请求中积压 20 条，再让续接于确认前或确认后失败。
     * @param {Array<object>} input 当前请求的用户消息，用于核对取出的整批原文。
     * @returns {AsyncGenerator<object>} 依次产出启动、模型活动或错误事件。
     */
    async function* events(input) {
      yield { type: 'turn.started' };
      if (session.turns === 1) {
        for (let index = 1; index <= 20; index++) {
          assert.equal(harness.agent.pushInterjection(key, '续接插话[' + index + ']'), true);
        }
        yield { type: 'turn.completed' };
        return;
      }
      assert.equal(session.turns, 2);
      assert.equal(harness.agent.test.interjectInbox.has(key), false);
      assert.equal(input[0].text.split('【用户实时插话】')[1].match(/续接插话\[\d+\]/g).length, 20);
      beforeActivity = finish.events.some(delivered);
      if (confirmed) yield { type: 'item.started', item: { type: 'reasoning' } };
      afterActivity = finish.events.some(delivered);
      // 存在已启动的工具时，插话不能抢先终止旧流，随后 SDK 错误仍须回到轮次。
      if (confirmed) yield { type: 'item.started', item: { type: 'mcp_tool_call', id: 'resumed-tool', tool: 'read_file' } };
      if (late) assert.equal(harness.agent.pushInterjection(key, '在续接中晚到的另一条插话'), true);
      yield { type: 'turn.failed', error: { message: failure } };
    }

    /**
     * 判断是否已通过当前会话发出模型送达提示。
     * @param {object} event 生产大脑转发的轮次事件。
     * @returns {boolean} 仅匹配插话送达状态。
     */
    function delivered(event) { return event.type === 'status' && event.text === received; }

    try {
      const lines = [];
      if (late) lines.push('本轮已接收的 1 条插话未送达 AI。');
      if (!confirmed) lines.push('本轮已接收的 20 条插话未确认送达 AI。');
      lines.push(failure);
      await assert.rejects(finish.run(), { message: lines.join('\n') });
      assert.equal(beforeActivity, false, 'SDK 启动不等于已送达');
      assert.equal(afterActivity, confirmed, '送达提示必须由模型活动触发');
      assert.equal(finish.events.filter(delivered).length, confirmed ? 1 : 0);
      assert.equal(harness.agent.test.interjectInbox.has(key), false);
      assert.equal(harness.agent.test.interjectInFlight.has(key), false);
      assert.equal(harness.agent.test.activeInterjectKeys.has(key), false);
      check(session.turns === 2, 'SDK 续接失败回执：已确认批次=' + confirmed + '，新入队=' + late + '，未重复执行');
    } finally {
      codex.closeSession(key);
    }
  }
}

/**
 * 验证最终审美结果已经返回、上一检查已通过后插入的最后一条消息仍被消费。
 * @param {object} harness 真实轮次生命周期与收尾源码。
 * @returns {Promise<void>} 最后接收消息有实际续接、重验和唯一 done 交付后兑现。
 */
async function testLastFinishInterjection(harness) {
  let calls = 0;
  let reports = 0;
  let inserted = false;
  async function model(args) {
    calls++;
    if (calls === 2) check(args.turnText.includes('最后一条补充'), '最终关闭前接收的最后一条消息实际进入原会话');
    return { content: calls === 1 ? '已完成原目标。' : '已完成最后一条补充。' };
  }
  const finish = finishHarness(harness, { runTurn: model }, 'finish-last');
  finish.context.aestheticReview.review = async function review() {
    reports++;
    if (reports !== 1) return { passed: true, report: 'current-report' };
    const result = { passed: true };
    /** 结果被生产收尾实际读取时登记消息，精确落在上次队列检查之后。 */
    function readReport() {
      if (!inserted) {
        inserted = true;
        check(harness.agent.pushInterjection('finish-last', '最后一条补充'), '最终结果应用期间仍可接收最后一条插话');
      }
      return 'stale-last-report';
    }
    Object.defineProperty(result, 'report', { get: readReport });
    return result;
  };
  const result = await finish.run();
  check(calls === 2 && reports === 2 && result.text.includes('最后一条补充') &&
    !result.text.includes('stale-last-report'), 'done前最终队列检查消费最后消息并废弃过期报告');
}
/**
 * 验证普通模型在实现总结期间同样接收插话，复用既有消息和工具证据。
 * @param {object} harness 已隔离普通模型传输的真实 Agent。
 * @returns {Promise<void>} 两次请求、最新验收目标和实际交付均已验证后兑现。
 */
async function testOrdinaryFinishInterjection(harness) {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  let summaries = 0;
  async function complete(args) {
    calls++;
    if (calls === 2) check(args.messages.some(function user(message) {
      return message.role === 'user' && String(message.content).includes('普通模型收尾补充');
    }), '普通模型收尾补充进入同一份真实请求历史');
    return { content: calls === 1 ? '已完成原目标。' : '已完成普通模型收尾补充。' };
  }
  harness.setComplete(complete);
  const finish = finishHarness(harness, null, 'ordinary-finish');
  finish.context.directOn = false;
  finish.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
  finish.context.summarizeImplementation = async function summary(args) {
    summaries++;
    if (summaries === 1) { entered.resolve(); await release.promise; }
    else check(args.userText.includes('普通模型收尾补充'), '普通模型最终验收使用更新后的用户目标');
    return 'current-pass';
  };
  const running = finish.run();
  await entered.promise;
  check(harness.agent.pushInterjection('ordinary-finish', '普通模型收尾补充'), '普通模型总结期间实际接收插话');
  release.resolve();
  const result = await running;
  check(calls === 2 && summaries === 2 && result.text.includes('普通模型收尾补充'),
    '普通与直通收尾接收和消费行为一致');
}

/**
 * 验证普通模型续接失败时，旧工具进度不会盖掉插话失败回执。
 * @param {object} harness 提供真实普通模型循环和轮次收尾。
 * @returns {Promise<void>} 核对回退请求等待时已显示逐条进度，失败时返回整批未确认计数且没有完成事件。
 */
async function testOrdinaryFailedReceipt(harness) {
  const key = 'ordinary-resume-error';
  const failure = new Error('普通模型续接被服务端拒绝');
  let calls = 0;

  /**
   * 保留首轮工具结果，模拟流式协议被拒，待非流式请求显示进度后使其失败。
   * @param {object} args 普通模型收到的请求与对话历史。
   * @returns {Promise<object>} 首轮返回工具调用，含插话的请求拒绝。
   */
  async function complete(args) {
    calls++;
    if (calls === 1) {
      for (let index = 1; index <= 20; index++) {
        assert.equal(harness.agent.pushInterjection(key, '普通模型插话[' + index + ']'), true);
      }
      return { role: 'assistant', content: '', tool_calls: [
        { id: 'old-read', type: 'function', function: { name: 'read_file', arguments: '{"path":"fixture.js"}' } }
      ] };
    }
    assert.equal(args.messages.filter(toolResult).length, 1, '首轮工具回包仍在对话历史中');
    assert.equal(args.messages.filter(interjection).length, 20, '续接请求携带整批插话');
    if (args.stream) throw Object.assign(new Error('stream not supported'), { status: 400 });
    // 让传输入口发出进度，检查时模型尚未返回正文、推理或工具调用。
    await Promise.resolve();
    const visible = finish.events.filter(function processing(event) { return event.processingInterjectionIds; });
    assert.equal(visible.length, 2, '流式传输与改用非流式重试都应报告正在处理');
    const ids = [];
    for (const item of finish.context.workingMemoryRef.current.interjectionTodos) {
      assert.equal(item.status, 'pending');
      assert.ok(!item.seen, '仅等待非流式请求不能标记 AI 已看');
      ids.push(item.id);
    }
    for (const event of visible) assert.deepEqual(Array.from(event.processingInterjectionIds), ids);
    check(true, '普通模型非流式回复返回前，20 条插话已显示处理中且均未标记完成');
    throw failure;
  }

  /** 判断该条历史是否为首轮工具返回，供续接请求核对。 */
  function toolResult(message) { return message.role === 'tool'; }
  /** 判断该条历史是否为本测试发出的真实插话。 */
  function interjection(message) { return message.role === 'user' && String(message.content).startsWith('普通模型插话['); }

  harness.setComplete(complete);
  const finish = finishHarness(harness, null, key);
  finish.context.directOn = false;
  finish.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
  await assert.rejects(finish.run(), { message: '本轮已接收的 20 条插话未确认送达 AI。\n普通模型续接被服务端拒绝', cause: failure });
  assert.equal(harness.agent.test.interjectInFlight.has(key), false);
  /** 结束载荷只能在本轮完成后发出。 */
  function done(event) { return event.type === 'done'; }
  check(calls === 3 && !finish.events.some(done), '非流式续接失败时返回 20 条未确认送达，不把等待进度当成成功');
}

/**
 * 验证失败验收返工期间仍接收插话，既有成功编辑只执行一次，重验包含最新补充。
 * @param {object} harness 可控模型传输与真实生产返工/收尾源码。
 * @returns {Promise<void>} 返工、插话消费和新目标重验均成功后兑现。
 */
async function testRetryInterjection(harness) {
  const entered = deferred();
  const release = deferred();
  let calls = 0;
  let edits = 0;
  let version = 0;
  let summaries = 0;
  let retrySignature = '';
  async function model(args) {
    calls++;
    if (calls === 1) return { content: '已完成初次实现。' };
    if (calls === 2) {
      retrySignature = args.sig;
      await args.runTool('edit_file', { path: 'fixture.js' });
      version++;
      entered.resolve();
      await release.promise;
      return { content: '已完成验收返工。' };
    }
    check(calls === 3 && args.sig === retrySignature && args.turnText.includes('返工时新增条件') &&
      args.requiredToolNames.length === 0, '验收返工中的补充沿用当前SDK会话且不重复催执行');
    return { content: '已完成返工时新增条件。' };
  }
  const finish = finishHarness(harness, { runTurn: model }, 'finish-retry');
  finish.context.directRunTool = async function edit() { edits++; return '编辑成功'; };
  finish.context.implementationStateKey = function state() { return String(version); };
  finish.context.planRetryPrompt = function retry() { return '只修复验收指出的目标。'; };
  finish.context.summarizeImplementation = async function summary(args) {
    summaries++;
    if (summaries === 1) return 'failed';
    check(args.userText.includes('返工时新增条件'), '验收返工后的最终总结包含最新插话');
    return 'current-pass';
  };
  finish.context.judgePlanVerdict = function judge(verdict) {
    return { failed: verdict === 'failed', saidPass: verdict !== 'failed', gaps: ['目标需返工'], unproven: 0 };
  };
  const running = finish.run();
  await entered.promise;
  check(harness.agent.pushInterjection('finish-retry', '返工时新增条件'), '实现验收返工仍在运行时实际接收插话');
  release.resolve();
  const result = await running;
  check(calls === 3 && edits === 1 && summaries === 2 && result.text.includes('返工时新增条件'),
    '验收返工消费新增消息后重验，成功编辑保持一次');
}

/**
 * 在真实大脑入口比较相同用户输入的请求数、工作记忆和工具副作用。
 * 模型传输由用例驱动，文件工具只写临时项目；所有场景先采样再统一断言。
 * @param {object} harness 同套回归的隔离依赖。
 * @returns {Promise<void>} 任一调度次数、交付范围或磁盘结果不符时失败。
 */
async function testUserScope(harness) {
  const question = '要怎么你才能把东西做得好看?';
  const promise = '我来找参考、做样稿。';
  const results = [];
  for (const [label, order, first, extra, readonly] of [
    ['举例', question, promise, 0], ['建议', question, '可以比较模型的正面与侧面。', 0],
    ['验证', '修改模型并验证。', '模型已修改，接下来我会验证。', 1],
    ['只读', question, promise, 0, true],
    ['采纳', '按刚才的磨坊方案做。', '我先找参考。', 1],
    ['无任务的继续', '继续', promise, 0], ['已完成后的继续', '继续', promise, 0], ['授权后的继续', '继续', promise, 1]
  ]) {
    const key = 'scope-' + label;
    let calls = 0;
    let source = '';
    const history = [{ role: 'user', content: ['授权后的继续', '已完成后的继续'].includes(label) ? '修改模型并验证。' : question },
      { role: 'assistant', content: '我来做一个磨坊样稿。', taskSettled: label === '已完成后的继续' }];
    /** 第二次请求记录调度依据；示例误续时让模型真实创建一个待办，以观察副作用。 */
    async function model(args) {
      calls++;
      if (calls === 1) return { content: first };
      assert.equal(calls, 2);
      source = args.turnText;
      if (label === '举例') await args.runTool('todo_write', { merge: false, todos: [{ id: 'mill', content: '磨坊样稿', status: 'completed' }] });
      return { content: '验证结束。' };
    }
    const brain = brainHarness(harness, { runTurn: model }, key);
    useProductionTodoTools(harness, brain);
    brain.context.history = history;
    brain.context.userText = order;
    brain.context.snap.readOnly = !!readonly;
    await brain.run(history.concat({ role: 'user', content: order }), false);
    results.push({ label, calls, expected: extra + 1, todos: brain.context.workingMemoryRef.current.todos.length,
      anchored: !extra || source.includes(label === '授权后的继续' ? history[0].content : order) });
  }

  const key = 'scope-stop';
  const stop = '先停下来吧，先给我一个方案';
  let calls = 0, obsolete = 0, oldRequests = 0, stopText = '', oldRunTool;
  /** 模拟并行提交两个旧工具，记录真正进入执行器的次数，保留原待办。 */
  async function pausedModel(args) {
    calls++;
    assert.ok(calls <= 3);
    if (args.turnText.includes('【AGI 任务尚未完成】')) {
      oldRequests++;
      // 仅让有缺陷的旧循环有限退出，使修复前后可以执行完全相同的样本。
      await args.runTool('todo_write', { merge: true, todos: [{ id: 'old', status: 'completed' }] });
    } else if (calls === 1) {
      await args.runTool('todo_write', { merge: false, todos: [{ id: 'old', content: '建模', status: 'pending' }] });
      oldRunTool = args.runTool;
      harness.agent.pushInterjection(key, stop);
      const replies = await Promise.all([args.runTool('write_file', { path: 'old1.obj' }), args.runTool('write_file', { path: 'old2.obj' })]);
      stopText += replies.join('\n');
    } else {
      stopText += args.turnText;
      await oldRunTool('read_file', { path: '过期回调' });
    }
    return { content: '先停在这里。' };
  }
  const brain = brainHarness(harness, { runTurn: pausedModel }, key);
  brain.context.userText = '完成建模';
  useProductionTodoTools(harness, brain);
  const original = brain.context.directRunTool;
  brain.context.directRunTool = async function count(name, args) {
    if (name === 'write_file' || args.path === '过期回调') { obsolete++; return '记录旧工具启动'; }
    return original(name, args);
  };
  await brain.run([{ role: 'user', content: brain.context.userText }], false);
  console.log('SCOPE-EVIDENCE ' + JSON.stringify({ results, stop: { oldRequests, obsolete, calls, status: brain.context.workingMemoryRef.current.todos[0].status },
    version: require(path.join(root, 'package.json')).version, electron: process.versions.electron, node: process.versions.node }));
  for (const row of results) check(row.calls === row.expected && row.todos === 0 && row.anchored, row.label + '按用户原话调度，调用次数与清单符合预期');
  check(oldRequests === 0 && obsolete === 0 && brain.context.workingMemoryRef.current.todos[0].status === 'pending', '停止后零旧续接、零新启动旧工具，旧清单保持原进度');
  check(stopText.includes(stop) && !stopText.includes('完成建模'), '明确暂停撤下旧目标，续接只按当前原话处理');
}

/**
 * 用真实直通和普通模型循环接收手动接手插话；模型回包受控，工具门槛和工作记忆事件走生产路径。
 * @param {object} harness 隔离的模型传输；旧文件操作只能指向本例的临时目录。
 */
async function testManualAdjustment(harness) {
  const scopeApi = harness.dependency('./agi-task-scope');
  const orders = ['现在告诉我哪些描述会导致AGI无视限制，我这边手动去调、', 'AGI无视的东西需要给我详细列出来，然后我去手动调整'];
  const answer = '在「文件 → 管理规则 → agi（全局）」中编辑澄清和需求催办两段。';
  for (const direct of [true, false]) {
    for (const order of orders) {
      const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spcode-manual-scope-'));
      const key = path.basename(dir);
      const oldFile = path.join(dir, 'obsolete.txt');
      const oldWrite = { path: oldFile, content: '旧实施' };
      const todo = { merge: true, todos: [
        { id: 'fix', content: '旧实施', status: 'in_progress' }, { id: 'verify', content: '旧验收', status: 'pending' },
        { id: 'done', content: '已完成的记录', status: 'completed' }
      ] };
      let calls = 0;
      /** 组装普通模型的一次工具回包，让工具启动与拒绝均经过生产循环。 */
      function call(name, args) {
        return { role: 'assistant', tool_calls: [{ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } }] };
      }
      /** 在旧写操作即将开始时提交真实用户插话，下次模型调用只返回位置和说明。 */
      async function model(args) {
        calls++;
        if (calls === 1 && !direct) return call('todo_write', todo);
        if (calls === (direct ? 1 : 2)) {
          if (direct) await args.runTool('todo_write', todo);
          assert.ok(harness.agent.pushInterjection(key, order));
          if (!direct) return call('write_file', oldWrite);
          await args.runTool('write_file', oldWrite);
          return { content: '正在准备旧实施。' };
        }
        assert.equal(calls, direct ? 2 : 3, '说明交付后不能再续跑旧实施');
        const latest = direct ? args.turnText : args.messages[args.messages.length - 1].content;
        assert.ok(latest.includes(order));
        if (direct) await args.runTool('write_file', oldWrite);
        return { role: 'assistant', content: answer };
      }
      const brain = brainHarness(harness, { runTurn: model }, key, direct);
      brain.context.userText = '请修改当前规则并验证';
      brain.context.workspace = dir;
      brain.context.workingMemoryRef.current.todos = [{ id: 'history', content: '其他任务', status: 'pending' }];
      if (direct) useProductionTodoTools(harness, brain);
      else {
        brain.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
        harness.setComplete(model);
      }
      try {
        const reply = await brain.run([{ role: 'user', content: brain.context.userText }], false);
        const scope = brain.context.snap.taskScope;
        assert.equal(reply, answer);
        assert.equal(scope.limit, 'reply');
        assert.ok(!scope.active && !scope.implementation && scope.todos.size === 0);
        const updates = brain.events.filter(function memory(ev) { return ev.type === 'working_memory'; });
        const finalTodos = updates[updates.length - 1].workingMemory.todos;
        assert.deepEqual(Array.from(finalTodos, function id(t) { return t.id; }), ['history', 'done']);
        assert.equal(brain.context.workingMemoryRef.current.todos, finalTodos);
        assert.ok(!fs.existsSync(oldFile));
        check(true, (direct ? '直通' : '普通循环') + '只交付说明，旧文件未写，已撤两项旧待办：' + order);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  // 明确交给助手的实施、条件、历史叙述及引文均不触发接手。
  for (const text of ['AGI模式的规则你单独分离出来吧，我手动去调整', '告诉我位置并修改配置，我手动调整',
    '如果我手动调整', '我昨天手动调整了', '我手动调整吗？', '示例是「我自己来调」']) {
    assert.equal(scopeApi.replyOnlyRequest(text), false, text);
  }
  const scope = scopeApi.create('请修改规则', [], false);
  scopeApi.update(scope, '我自己来调');
  assert.equal(scope.limit, 'reply');
  scopeApi.update(scope, '请你修改配置');
  assert.ok(scope.active && scope.implementation && !scope.limit);
}

/**
 * 在真实 Codex 适配器断言请求次数，并通过 HTTP MCP 在隔离目录核对用户授权的文件。
 * @param {object} harness 大脑与工具的测试环境。只替换厂商流，保留生产路径解析、快照与文件写入。
 * @returns {Promise<void>} 流次数、清单、磁盘内容或暂停投递任一不符均失败。
 */
async function testScopeBridge(harness) {
  const question = '要怎么你才能把东西做得好看?';
  for (const test of [
    { user: '只问答：' + question, mode: 'example', allowed: [] },
    { user: '我已经让你直接改了，为什么还要等？', mode: 'edit', allowed: [] },
    { user: '开始工作，直接改 LuopanPlans.cs，点前进就在当帧启动切图。', mode: 'started-interjection', allowed: [] },
    { user: '按刚才的磨坊方案做。', mode: 'adopt', allowed: ['磨坊.obj'] },
    { user: '怎么做？顺便把交接文件写好，写入「docs/交接.md」。', mode: 'mixed', allowed: ['docs/交接.md'] },
    { user: '只授权本次诊断和交接文件，写入 docs/交接.md。', mode: 'document', allowed: ['docs/交接.md'] },
    { user: '完成建模', mode: 'pause', allowed: ['docs/交接.md'] }
  ]) {
    const codex = loadCodexBridge();
    const key = 'http-scope-' + test.mode;
    const workspace = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spcode-scope-'));
    fs.mkdirSync(path.join(workspace, 'docs'));
    const brain = brainHarness(harness, codex, key);
    brain.context.workspace = workspace;
    brain.context.userText = test.user;
    brain.context.history = [{ role: 'user', content: question }, { role: 'assistant', content: '可以先做一个磨坊模型。' }];
    brain.context.MUTATE_FILE_TOOLS = new Set(['write_file', 'edit_file']);
    brain.context.toolsFor = function specs() {
      return ['read_file', 'write_file', 'edit_file', 'todo_write'].map(function tool(name) { return { function: { name, parameters: { type: 'object' } } }; });
    };
    useProductionTodoTools(harness, brain);
    if (test.mode === 'edit') fs.writeFileSync(path.join(workspace, 'LuopanPlans.cs'), 'class OldName {}');
    const startedEdit = test.mode === 'started-interjection';
    const fixture = path.join(workspace, 'LuopanPlans.cs');
    const beforeEdit = 'class LuopanPlans { public const bool CutOnAdvance = false; }';
    const oldTarget = 'class LuopanPlans { public const bool CutOnAdvance = true; }';
    const afterEdit = 'class LuopanPlans { public const int CutDelayFrames = 1; }';
    const addition = '为什么加这种限制？切图改成延后一帧，写入 CutDelayFrames = 1，并回读确认。';
    if (startedEdit) fs.writeFileSync(fixture, beforeEdit);
    // 明确的按钮开工会设置 SDK 必调工具，用来检验在调用工具前收到暂停时能否让出旧请求。
    brain.context.turnStart = test.mode === 'pause' || startedEdit;
    const session = { sig: '', ctx: null, turns: 0 };
    const bridge = await codex.test.startBridge(session);
    session.server = bridge.server;
    const prompts = [];
    /** 通过生产 MCP 服务向当前会话调用工具并取得真实处理结果。 */
    async function call(name, args) {
      const response = await fetch('http://127.0.0.1:' + bridge.port + '/mcp', {
        method: 'POST', headers: { Authorization: 'Bearer ' + bridge.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'tools/call', params: { name, arguments: args } })
      });
      assert.equal(response.status, 200);
      return (await response.json()).content[0].text;
    }
    /** 相同流中主动尝试越界写入；只有工具实际落盘才会出现在下面的文件清单里。 */
    async function* events() {
      let reply = '验证结束。';
      if (test.mode === 'pause' && prompts.length === 1) {
        harness.agent.pushInterjection(key, '先停下来，只写交接文件「docs/交接.md」。');
        reply = '先停在这里。';
      } else if (startedEdit && prompts.length === 1) {
        const args = { path: 'LuopanPlans.cs' };
        assert.ok((await call('read_file', args)).includes(beforeEdit));
        assert.ok(harness.agent.pushInterjection(key, addition));
        const obsolete = await call('edit_file', { path: args.path, old_string: beforeEdit, new_string: oldTarget });
        assert.ok(obsolete.includes('尚未执行') && !obsolete.includes(addition), obsolete);
        assert.equal(fs.readFileSync(fixture, 'utf8'), beforeEdit);
      } else if (startedEdit) {
        assert.ok(prompts[1].includes(addition));
        const args = { path: 'LuopanPlans.cs' };
        const edit = { path: args.path, old_string: beforeEdit, new_string: afterEdit };
        const scope = brain.context.snap.taskScope;
        assert.equal(scope.active, true);
        assert.equal(scope.limit, '');
        assert.equal(scope.documents, null);
        assert.equal(brain.context.snap.readOnly, false);
        assert.match(await call('edit_file', edit), /已修改/);
        assert.ok((await call('read_file', args)).includes(afterEdit));
      } else if (test.mode === 'edit') {
        const result = await call('edit_file', { path: 'LuopanPlans.cs', old_string: 'class OldName', new_string: 'class NewName' });
        assert.match(result, /已修改/);
      } else if (test.mode === 'example') {
        await call('todo_write', { merge: false, todos: [{ id: 'mill', content: '建模', status: 'pending' }] });
        await call('write_file', { path: '磨坊.obj', content: '模型' });
        reply = '我来找参考、做样稿。';
      } else {
        await call('write_file', { path: '磨坊.obj', content: '模型' });
        if (test.mode !== 'adopt') {
          await call('write_file', { path: '别的交接.md', content: '越界' });
          await call('write_file', { path: 'docs/交接.md', content: '交接内容' });
        }
      }
      yield { type: 'item.completed', item: { type: 'agent_message', text: reply } };
    }
    session.thread = { runStreamed: async function stream(input) {
      prompts.push(input[0].text);
      assert.ok(prompts.length <= 2, '不得重发旧任务');
      return { events: events() };
    } };
    // SDK 用生产 runBrain 传来的签名匹配当前夹具，继续走真实 runSdkTurn 与本机 HTTP 服务。
    brain.context.codexDirect = { runTurn: function dispatch(args) {
      session.sig = args.sig + '\nagi:true\nreasoning:default';
      codex.test.sessions.set(key, session);
      return codex.runTurn(args);
    } };
    try {
      await brain.run(brain.context.history.concat({ role: 'user', content: test.user }), brain.context.turnStart);
      check(prompts.length === (test.mode === 'pause' || startedEdit ? 2 : 1) && !prompts.some(function nudge(t) { return t.includes('上一轮只回复了文字'); }),
        test.mode + ' 真实 SDK 请求次数符合预期，无旧必调工具重试');
      if (test.mode === 'edit') check(fs.readFileSync(path.join(workspace, 'LuopanPlans.cs'), 'utf8') === 'class NewName {}',
        '带问号的开工补充通过真实 MCP 编辑并落盘');
      if (startedEdit) {
        assert.equal(fs.readFileSync(fixture, 'utf8'), afterEdit);
        check(true, '带问号插话以用户消息续接，旧编辑未写入，按新需求真实修改并回读');
        console.log('STARTED-INTERJECTION ' + JSON.stringify({ started: brain.context.turnStart, sdkRequests: prompts.length,
          active: brain.context.snap.taskScope.active, limit: brain.context.snap.taskScope.limit, disk: fs.readFileSync(fixture, 'utf8') }));
      }
      const landed = [];
      for (const name of ['磨坊.obj', '别的交接.md', 'docs/交接.md']) if (fs.existsSync(path.join(workspace, name))) landed.push(name);
      assert.deepEqual(landed, test.allowed);
      check(brain.context.workingMemoryRef.current.todos.length === 0, test.mode + ' 仅授权文件实际落盘，未创建示例待办');
      for (const name of landed) assert.equal(fs.readFileSync(path.join(workspace, name), 'utf8'), name.endsWith('.md') ? '交接内容' : '模型');
      if (test.mode === 'pause') check(prompts[1].includes('先停下来，只写交接文件'), '第二次 SDK 请求只响应新文件交付');
    } finally {
      codex.closeSession(key);
      fs.rmSync(workspace, { force: true, recursive: true });
    }
  }
}

/** 通过普通模型请求和真实工具事件，核对初次问答、带待办暂停与排队批次。 */
async function testOrdinaryScope(harness) {
  for (const pause of [false, true]) {
    const key = 'ordinary-scope-' + pause;
    const brain = brainHarness(harness, null, key, false);
    brain.context.userText = pause ? '完成建模' : '要怎么你才能把东西做得好看?';
    brain.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
    let calls = 0;
    /** 第二次请求中收到停止，模型随即返回的旧工具批次必须整批留在执行器之外。 */
    async function model(args) {
      calls++;
      assert.ok(calls <= (pause ? 3 : 1));
      if (!pause) return { role: 'assistant', content: '我来找参考、做样稿。' };
      if (calls === 1) return { role: 'assistant', tool_calls: [{ id: 'create', type: 'function', function: {
        name: 'todo_write', arguments: JSON.stringify({ merge: false, todos: [{ id: 'model', content: '建模', status: 'pending' }] })
      } }] };
      if (calls === 2) {
        harness.agent.pushInterjection(key, '先停下来吧，先给我一个方案');
        return { role: 'assistant', tool_calls: ['a', 'b'].map(function old(id) {
          return { id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: id }) } };
        }) };
      }
      assert.ok(args.messages.some(function delivered(msg) { return msg.role === 'user' && String(msg.content).split('\n\n')[0] === '先停下来吧，先给我一个方案'; }));
      return { role: 'assistant', content: '方案如下。' };
    }
    harness.setComplete(model);
    await brain.run([{ role: 'user', content: brain.context.userText }], false);
    check(calls === (pause ? 3 : 1) && !brain.events.some(function old(ev) { return ev.type === 'tool' && ev.name === 'read_file'; }),
      pause ? '普通循环暂停后只答新要求，旧批次未启动，旧待办保留' : '普通循环举例直接交付，无工具催办');
    if (pause) assert.equal(brain.context.workingMemoryRef.current.todos[0].status, 'pending');
  }
}

/**
 * 核对验收报告中的引文不会启动新请求，报告正文里仍由助手承担的验证会继续。
 * @param {object} harness 由 loadAgent 创建，提供真实 Agent 源码、隔离依赖和普通模型回调的注入接口。
 * @returns {Promise<void>} 普通和直通均按预期请求并交付时完成；请求次数或交付正文不符时以断言错误拒绝。
 */
async function testQuotedDelivery(harness) {
  const report = '已完成验收。\n| 历史答复 | 实测请求数 |\n|---|---|\n| 助手答“我来找参考、做样稿” | 1 |';
  const finished = '已完成验证。';
  const historyQuote = '历史引文「自测未通过」。';
  const reason = ' 预览目录仍未载入。';
  const references = ['> 自测尚未通过。', '```text', '自测未通过', '```'];
  const sample = [historyQuote + '**自测未通过：**' + reason, ...references].join('\r\n');
  const delivery = harness.agent.test.withholdUnverifiedDelivery(sample, {
    accepted: false, askFixed: false, selfTestAttention: { detail: '请核对预览目录。' }
  });
  const expectedDelivery = ['需要注意的是，请核对预览目录。', '', historyQuote + reason, ...references];
  assert.equal(delivery, expectedDelivery.join('\n'));
  check(true, '只移除助手当前自测结论，保留同行原因、引文和代码示例');
  for (const direct of [true, false]) {
    for (const [label, first, expected] of [
      ['验收表格', report, 1],
      ['示例代码', '已完成验收。\n```text\n我会运行测试。\n```', 1],
      ['引用进度', '已完成验收。\n> 还没改完，我会运行测试。', 1],
      ['四空格引用', '已完成验收。\n    > 还没改完，我会运行测试。', 1],
      ['制表符引用', '已完成验收。\r\n\t> 我会运行测试。', 1],
      ['缩进引用后的承诺', '已完成验收。\n    > 我会运行测试。\n接下来我会继续验证。', 2],
      ['英文引文', '已完成验收。历史答复为 "I will check the result."。', 1],
      ['引文后继续验证', report + '\n接下来我会继续验证。', 2]
    ]) {
      const route = direct ? '直通' : '普通';
      let calls = 0;
      /** 只在宿主确实发出下一次请求时返回完成结果，避免误续接被夹具掩盖。 */
      async function model() {
        calls++;
        assert.ok(calls <= 2, '最终结果不能再次续跑');
        return { role: 'assistant', content: calls === 1 ? first : finished };
      }
      const brain = brainHarness(harness, direct ? { runTurn: model } : null, route + label, direct);
      if (!direct) {
        harness.setComplete(model);
        brain.context.modelCfg = { protocol: 'openai', model: 'fixture', baseUrl: 'http://unused' };
      }
      const history = messages();
      // 验收正文交付前已经取得工具结果；普通循环还会单独检查报告里是否声明“还没改完”。
      history.push({ role: 'assistant', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
      history.push({ role: 'tool', tool_call_id: 'read', content: '已读取测试样本。' });
      const result = await brain.run(history, false);
      assert.equal(calls, expected, route + label + '的请求总数');
      const delivered = harness.agent.test.withholdUnverifiedDelivery(result, { askFixed: false, accepted: false });
      check(delivered === (expected === 1 ? first : finished), route + label + '按正文承诺收尾，引文原样交付');
    }
  }
  // 真实完成声明仍须拦截，同一报告内的历史引文和多行示例必须留在原位。
  const evidence = ['核对结果如下。', '    > 【不能交卷】还没改完。', '```text', '已修复', '修好了', '```', '旧答复为“可以打”。'].join('\n');
  const mixed = harness.agent.test.withholdUnverifiedDelivery(evidence + '\n我已经修好了。', { askFixed: false, accepted: false });
  check(mixed.startsWith(evidence + '\n\n【不能交卷】') && !mixed.includes('我已经修好了。'), '只拦截助手本人未经验证的完成声明，保留完整引用和代码示例');
}

/**
 * 验证生产收尾即使命令通过也会要求补看指定窗口，直到取得视觉证据。
 * @param {object} harness 提供真实收尾逻辑、工具和隔离的直通传输。
 * @param {string} goal 需要目视验收的用户原话，调用时没有文件改动。
 * @returns {Promise<void>} 应补测一次并保持未验收状态，错误地进入最终验收则拒绝。
 */
async function testVisualFinish(harness, goal) {
  let requests = 0;
  /** 首次只跑实际命令，第二次核对宿主要求补看画面。 */
  async function model(args) {
    requests++;
    if (requests === 1) {
      const result = await args.runTool('run_command', { command: 'node -p 42', activity: 'test' });
      assert.match(result, /exit: 0/);
    } else {
      assert.equal(requests, 2);
      assert.match(args.turnText, /先自测再核对[\s\S]+screen_look/);
    }
    return { content: '命令已返回。' };
  }
  const finish = finishHarness(harness, { runTurn: model }, 'visual-finish');
  useProductionTodoTools(harness, finish);
  finish.context.workspace = root;
  finish.context.userText = goal;
  finish.context.snap.taskScope = harness.dependency('./agi-task-scope').create(finish.context.userText, [], false);
  finish.context.snap.current = null;
  finish.context.implementationStateKey = harness.agent.test.implementationStateKey;
  /** 缺少眼睛实测时，收尾不能调用最终实现核对。 */
  async function review() { assert.fail('缺少画面时不应调用最终核对'); }
  finish.context.summarizeImplementation = review;
  const result = await finish.run();
  check(requests === 2 && finish.context.snap.planUnverified && !finish.context.snap.planAccepted &&
    result.taskPending === true && /^需要注意的是，.*实际画面/m.test(result.text),
    '视觉任务仍待验收，最终说明指出需要查看实际画面');
}

/**
 * 验证多帧回执可按编号核对，且日志元数据和不存在的编号不能通过。
 * @returns {Promise<void>} 两条实际像素证据被取回、非法编号被拒绝时完成。
 */
async function testVisualEvidenceNumbers() {
  const selfTest = require('../electron/lib/agi-self-test');
  const first = '| 第 1–3 帧 | `ALPHA 1648` |';
  const later = '| 第 4–6 帧 | 红底 | `BRAVO 1649` |';
  const sample = [first, later, '第 20 帧 2850ms：C:/temp/frame-20.png', 'GIF：C:/temp/proof.gif', 'exit: 0'].join('\n');
  const evidence = '成功 screen_record\n' + sample;
  const goal = '核对目标窗两个大号标记的变化';
  /** 模拟总结模块只选真实回执编号。 */
  async function select(_instruction, material) {
    assert.match(material, /\[1\] \| 第 1–3 帧/);
    assert.match(material, /\[2\] \| 第 4–6 帧/);
    assert.doesNotMatch(material, /\[\d+\] (?:第 20 帧 2850ms：|GIF：|exit:)/);
    return '实测：1, 2';
  }
  /** 模拟总结模块选择未提供的编号。 */
  async function unknown() { return '实测：3'; }
  const ok = await selfTest.coverage(goal, evidence, select, [sample]);
  const invalid = await selfTest.coverage(goal, evidence, unknown, [sample]);
  check(ok.quotes?.join('\n') === [first, later].join('\n') && !!invalid.missing,
    '视觉自测使用原始编号取回多帧证据，并拒绝路径和不存在的编号');
}

/**
 * 验证风格任务和明确只改配色的任务收到各自的验收说明，并保留评审选中的画面证据。
 * @returns {Promise<void>} 比较只换色、风格差异、明确配色改动三种回执。
 */
async function testThemeEvidence() {
  const selfTest = require('../electron/lib/agi-self-test');
  const replyLang = require('../electron/lib/reply-lang');
  const review = require('../electron/lib/requirement-review');
  const styleGoal = '按两个游戏主题换对应的按钮';
  const colorGoal = '按两个游戏主题只改按钮颜色';
  const color = '主题一和主题二使用同一矩形按钮和同一边框，实际画面中底色从蓝变红。';
  const style = '同一配色下，主题一的按钮是切角外框，主题二的按钮是圆拱轮廓和浮雕边框。';
  const missing = '缺口：这两个主题的按钮只改了颜色，尚缺可见风格差异。';
  const zhGuide = selfTest.guide(replyLang.fromLocale('zh'));
  const enGuide = selfTest.guide(replyLang.fromLocale('en'));
  check(zhGuide.includes('逐个切换需要交付的主题') && zhGuide.includes('同配色预览') &&
    enGuide.includes('every requested theme') && enGuide.includes('shared palette'), '实施提示要求逐主题目视对照同一个元素');
  check(review.instruction([styleGoal]).includes('按风格缺失列为不一致') &&
    review.instruction([colorGoal]).includes('明确只改颜色时按配色要求核对'), '实现核对区分主题风格缺失和配色授权');

  /** 模拟核对模型按用户目标，从实际编号回执中选取证据，或返回具体缺口。 */
  async function assess(instruction, material) {
    assert.match(instruction, /实际切换画面中引用同一元素同一状态下符合主题的非配色差异/);
    assert.match(instruction, /只看到颜色变化[^。]*返回缺口/);
    assert.match(instruction, /用户明确只改颜色时，按配色要求核对/);
    if (material.includes('[1] ' + style)) return '实测：1';
    assert.ok(material.includes('[1] ' + color));
    if (material.includes(colorGoal)) return '实测：1';
    return missing;
  }
  const onlyColor = await selfTest.coverage(styleGoal, '成功 screen_record\n' + color, assess, [color]);
  const changedStyle = await selfTest.coverage(styleGoal, '成功 screen_record\n' + style, assess, [style]);
  const requestedColor = await selfTest.coverage(colorGoal, '成功 screen_record\n' + color, assess, [color]);
  check(onlyColor.missing === missing && !onlyColor.quotes, '主题风格只换色时保留评审缺口以触发返工');
  check(changedStyle.quotes?.[0] === style, '主题风格以画面中的非配色差异作为验收证据');
  check(requestedColor.quotes?.[0] === color, '用户只要配色时同一组换色证据可以通过');
}

/**
 * 用真实文件和测试命令经过直通工具、整轮自测及最终核对，验证返工、证据复用和停滞收尾。
 * @param {object} harness 隔离模型传输的生产 Agent 夹具。
 * @returns {Promise<void>} 请求次数、测试版本、核对顺序或阻塞状态不符合预期时以断言错误拒绝。
 */
async function testWorkCycle(harness) {
  for (const kind of ['按步完成', '失败返工', '通过后又修改', '没有进展', '零改动已满足']) {
    const workspace = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spcode-work-cycle-'));
    const command = { activity: 'test', command: 'node sample.cjs' };
    if (kind === '零改动已满足') fs.writeFileSync(path.join(workspace, 'sample.cjs'), "console.log('export-button=present')");
    const steps = [];
    let calls = 0;
    /** 仅按本场景调度实际工具；多出的模型请求立即失败。 */
    async function model(args) {
      calls++;
      assert.ok(calls <= 3);
      if (calls === 1) {
        assert.ok(args.turnText.includes('能验收的小步'));
        if (kind === '零改动已满足') return { content: '已有实现。' };
        const exitCode = kind === '失败返工' ? 1 : 0;
        const written = await args.runTool('write_file', { path: 'sample.cjs', content: 'process.exit(' + exitCode + ')' });
        assert.match(written, /已写入/, written);
        steps.push('做');
        if (kind !== '没有进展') {
          const output = await args.runTool('run_command', command);
          assert.ok(output.includes('exit: ' + exitCode));
          steps.push(exitCode ? '测失败' : '测通过');
        }
        if (kind === '通过后又修改') {
          await args.runTool('edit_file', { path: 'sample.cjs', old_string: 'process.exit(0)', new_string: 'process.exitCode = 0' });
          steps.push('再改');
        }
      } else {
        assert.ok(args.turnText.includes('先自测再核对'));
        if (kind === '失败返工' && calls === 2) {
          assert.match(args.turnText, /先自测再核对.*node sample\.cjs.*exit: 1/);
          await args.runTool('edit_file', { path: 'sample.cjs', old_string: 'exit(1)', new_string: 'exit(0)' });
          steps.push('返工');
        } else if (kind !== '没有进展') {
          assert.ok((await args.runTool('run_command', command)).includes('exit: 0'));
          steps.push('复测');
        }
      }
      return { content: '已处理本步。' };
    }
    const finish = finishHarness(harness, { runTurn: model }, 'work-cycle-' + kind);
    useProductionTodoTools(harness, finish);
    finish.context.workspace = workspace;
    finish.context.userText = '加个导出按钮，并用指定命令的退出状态验证。';
    finish.context.snap.taskScope = harness.dependency('./agi-task-scope').create(finish.context.userText, [], false);
    finish.context.snap.current = null;
    finish.context.implementationStateKey = harness.agent.test.implementationStateKey;
    finish.context.summarizeImplementation = async function review() {
      assert.ok(finish.context.snap.selfTestEvidence.includes('成功 node sample.cjs'));
      if (kind === '零改动已满足') {
        assert.ok(finish.context.snap.selfTestEvidence.includes('export-button=present'));
        assert.equal(finish.context.snap.current?.manifest?.changes.length || 0, 0);
      }
      steps.push('核对');
      return 'current-pass';
    };
    const result = await finish.run();
    const expected = { '按步完成': ['做', '测通过', '核对'], '失败返工': ['做', '测失败', '返工', '复测', '核对'],
      '通过后又修改': ['做', '测通过', '再改', '复测', '核对'], '没有进展': ['做'], '零改动已满足': ['复测', '核对'] };
    assert.deepEqual(steps, expected[kind]);
    if (kind === '没有进展') {
      assert.equal(calls, 2);
      assert.equal(result.taskPending, true);
      assert.match(result.text, /^需要注意的是，.*行为自测/);
      assert.ok(!finish.context.snap.planAccepted);
    }
    check(true, kind + '：' + steps.join(' → '));
  }
}

/**
 * 核对当前模式实际读取的简介、正文、行读、搜索以及内部模块提示。
 * 使用独立的技能目录与用户可自由编辑的内容，保留普通版旧标记的兼容覆盖。
 */
async function testSkillChannels(harness, appRoot, agi) {
  const skills = harness.agent.listSkills(appRoot, '', []);
  const selected = skills.find(function named(skill) { return skill.id === 'sample'; });
  const preview = require(path.join(root, 'electron/lib/prompt-preview'));
  const view = preview.build({ appRoot, workspace: '', modelCfg: { protocol: 'codex', model: 'fixture' },
    skillIds: ['sample', 'empty'], history: [], userText: '核对当前技能' });
  const shown = agi ? 'AGI正文甲' : '普通正文乙';
  const hidden = agi ? '普通正文乙' : 'AGI正文甲';
  const summary = agi ? 'AGI独立简介' : '普通独立简介';
  assert.equal(view.editable.skill.name, 'sample');
  assert.ok(view.system.includes(summary));
  for (const surface of [view.system, view.editable.skill.body, view.modules.code, view.modules.planning, view.modules.summary]) {
    assert.ok(surface.includes(shown) && !surface.includes(hidden) && !surface.includes('<!--normal-only-->'));
  }
  for (const locale of ['zh', 'en']) {
    const lang = harness.dependency('./reply-lang').fromLocale(locale);
    const system = harness.agent.buildSystemPrompt({ skill: selected, allSkills: skills, lang, userOrder: '核对当前技能' });
    assert.ok(system.includes(shown) && system.includes(summary) && !system.includes(hidden));
  }
  // 用户已有的普通版引用在 AGI 下也必须解析到独立正文，不能读回旧的普通约束。
  const extra = [path.join(appRoot, 'skills')];
  const invoke = harness.agent.test.execTool;
  for (const file of new Set([selected.file, agi ? selected.agiFile : selected.file])) {
    const all = await invoke(appRoot, {}, 'read_file', { path: file }, noop, extra);
    const line = await invoke(appRoot, {}, 'read_file', { path: file, startLine: 4, endLine: 4 }, noop, extra);
    const found = await invoke(appRoot, {}, 'search_text', { path: file, query: shown }, noop, extra);
    const missing = await invoke(appRoot, {}, 'search_text', { path: file, query: hidden }, noop, extra);
    assert.ok(all.includes(shown) && !all.includes(hidden));
    assert.ok(line.includes(shown) && found.includes(shown) && missing.includes('无匹配'));
  }
  check(true, '技能独立简介、正文、多技能、预览、模块、整读、行读与搜索 AGI=' + agi);
}

/**
 * 在隔离目录保存两份带不同 YAML 简介的手写正文，切换真实模式并核对持久化结果。
 * 只操作测试数据，涵盖 AGI 未配置、单独新建、清空重开及再次编辑普通版。
 */
async function testSkillVisibility(harness) {
  const appRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spcode-skill-versions-'));
  const lib = require(path.join(root, 'electron/lib/skills'));
  const hand = require(path.join(root, 'electron/lib/desktop-hand'));
  const previous = hand.isAlive();
  const normal = '---\ndescription: 普通独立简介\n---\n<!--normal-only-->普通正文乙<!--/normal-only-->';
  const agi = '---\ndescription: AGI独立简介\n---\nAGI正文甲';
  try {
    lib.saveSkill(appRoot, '', { id: 'sample', body: normal });
    const normalPath = path.join(appRoot, 'skills/sample/SKILL.md');
    const agiPath = path.join(appRoot, 'skills/sample/SKILL.agi.md');
    const single = harness.agent.listSkills(appRoot, '', [])[0];
    assert.equal(lib.skillBodyForMode(single, true), '');
    assert.equal(single.agiDesc, '');
    assert.ok(!fs.existsSync(agiPath));
    lib.saveSkill(appRoot, '', { id: 'sample', mode: 'agi', body: agi });
    assert.equal(fs.readFileSync(normalPath, 'utf8'), normal);
    lib.saveSkill(appRoot, '', { id: 'empty', mode: 'normal', body: '' });
    for (const mode of [false, true]) {
      hand.setAlive(mode);
      harness.setAlive(mode);
      await testSkillChannels(harness, appRoot, mode);
    }
    lib.saveSkill(appRoot, '', { id: 'sample', mode: 'agi', body: '' });
    lib.saveSkill(appRoot, '', { id: 'sample', mode: 'normal', body: '手改普通' });
    const cleared = harness.agent.listSkills(appRoot, '', []).find(function sample(s) { return s.id === 'sample'; });
    assert.equal(cleared.agiDesc, '');
    assert.equal(cleared.agiBody, '');
    assert.equal(fs.readFileSync(agiPath, 'utf8'), '');
    lib.saveSkill(appRoot, '', { id: 'only-agi', mode: 'agi', body: agi });
    const only = harness.agent.listSkills(appRoot, '', []).find(function onlyAgi(s) { return s.id === 'only-agi'; });
    assert.equal(only.body, '');
    assert.equal(only.agiBody, agi);
    check(true, '技能未填写不生成，单独新建 AGI 可重开，清空后不会回填');
  } finally {
    hand.setAlive(previous);
    harness.setAlive(true);
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
}

/**
 * 核对诊断查询的自测指引，并用真实退出状态检查对未解决失败的补测次数。
 * @param {object} harness 生产验收循环的隔离模型夹具。工作区外的状态文件模拟主窗条件变化。
 * @returns {Promise<void>} 日志诊断被当成自测、无关成功触发重复补测或有效失败被覆盖时拒绝。
 */
async function testFailedProbeRetries(harness) {
  const selfTest = harness.dependency('./agi-self-test');
  const replyLang = require('../electron/lib/reply-lang');
  for (const locale of ['zh', 'en']) {
    const guide = selfTest.guide(replyLang.fromLocale(locale));
    assert.match(guide, /activity=command/);
    assert.match(guide, /Get-WinEvent.*-ErrorAction Stop/);
    assert.match(guide, /NoMatchingEventsFound,Microsoft\.PowerShell\.Commands\.GetWinEventCommand/);
    assert.match(guide, /其他错误原样抛出|Rethrow every other error/);
    assert.match(guide, /自测通过后才报告已验证的结果|only after the self-test passes/);
    assert.match(guide, /需要注意的是.*已核实的原因|Please note.*observed reason/);
    assert.match(guide, /执行命令和完整输出留在工具记录里|Keep command lines and full output in the tool records/);
  }
  check(true, '中英文自测指引区分只读诊断、事件查询零匹配和真实错误');
  // 摘要清理只识别真实命令片段，保留附近的诊断、路径及独立程序名。
  const reviewCommand = 'node preview.cjs --input event-log-with-report.json --format detailed';
  const note = '（命令见工具记录）';
  const echoes = [reviewCommand, reviewCommand.replace(' --input ', '\r\n  --input\r\n  '),
    reviewCommand.replace('with-report', 'with-\nreport'), 'node preview.cjs --input event-log',
    'node preview.cjs --input event-log…', 'node preview.cjs --input ... --format detailed',
    'node preview.cjs --input\n…\n--format detailed'];
  for (const echo of echoes) {
    const original = '已核对：`' + echo + '`。\n诊断：预览目录未载入。';
    assert.equal(selfTest.omitCommandEchoes(original, [reviewCommand], note),
      '已核对：`' + note + '`。\n诊断：预览目录未载入。');
  }
  const narration = 'node 用于检查，preview.cjs 仍可打开。\n查看 node preview.cjs.bak 的输出。';
  assert.equal(selfTest.omitCommandEchoes(narration, [reviewCommand], note), narration);
  check(true, '原样、换行、截短和首尾保留的命令均清理，正文和相似文件名保留');

  // 复合命令的独立后半段也来自实际调用，英文句末符号和后续诊断应保留。
  const followup = 'node verify.cjs --target release-build';
  const compound = reviewCommand + ' && ' + followup;
  for (const echo of [compound, followup]) {
    for (const punctuation of ['.', ';']) {
      const original = 'Checked: ' + echo + punctuation + '\r\nDiagnosis: no preview.';
      assert.equal(selfTest.omitCommandEchoes(original, [compound], note),
        'Checked: ' + note + punctuation + '\nDiagnosis: no preview.');
    }
  }
  const finalStep = 'node report.cjs --format json';
  const trailingSteps = followup + ' | ' + finalStep;
  assert.equal(selfTest.omitCommandEchoes(trailingSteps, [reviewCommand + ' || ' + trailingSteps], note), note);
  const literal = 'node -e "log; ' + followup + '"';
  assert.equal(selfTest.omitCommandEchoes(followup, [literal], note), followup);
  assert.equal(selfTest.omitCommandEchoes(followup + '.bak', [compound], note), followup + '.bak');
  check(true, '复合命令后半段与英文句号、分号均通过，保留诊断和引号内的参数边界');

  for (const advances of [false, true]) {
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spcode-failed-probe-'));
    try {
      const workspace = path.join(dir, 'project');
      const phase = path.join(dir, 'phase.txt');
      fs.mkdirSync(workspace);
      fs.writeFileSync(phase, 'catalog-unloaded');
      fs.writeFileSync(path.join(workspace, 'preview.cjs'), [
        "const state = require('fs').readFileSync('../phase.txt', 'utf8');",
        'console.log(state);',
        "if (state !== 'preview-visible') {",
        "  console.error(('node preview.cjs ' + process.argv[2]).slice(0, 123));",
        "  console.error('preview-registry-disabled');",
        "  console.error('node preview.cjs ' + process.argv[2]);",
        "  process.exitCode = 1;",
        "}"
      ].join('\n'));
      const request = '修复技能预览，用指定命令的退出状态核实。';
      // 长参数复现真实自测命令和 stderr 原样回显进入总结的场景。
      const commandMarker = 'spcode-summary-command-';
      const probe = { command: 'node preview.cjs ' + commandMarker.repeat(40), activity: 'test' };
      const observed = [];
      let calls = 0;
      const limit = advances ? 3 : 2;
      /** 第一次建立失败记录，补测时分别模拟无关成功和同一命令报告不同的问题。 */
      async function model(args) {
        calls++;
        assert.ok(calls <= limit, '相同失败仍在，其他成功记录又触发了第 ' + calls + ' 次模型请求');
        if (!advances && calls === 2) {
          const output = await args.runTool('run_command', { command: 'node -p 42', activity: 'test' });
          assert.ok(output.includes('exit: 0') && /^42\r?$/m.test(output), output);
          observed.push('other-pass');
          // 模拟模型误报完成，宿主仍应保留已观察到的具体异常和未完成状态。
          return { content: '修复完成。\n【自测尚未通过】\n自测未通过：预览目录仍未载入。\n实际执行 ' +
            probe.command + '\n已核对技能目录。' };
        } else {
          const stage = ['catalog-unloaded', 'model-missing', 'preview-visible'][calls - 1];
          fs.writeFileSync(phase, stage);
          const output = await args.runTool('run_command', probe);
          assert.ok(output.includes(stage) && output.includes('exit: ' + (stage === 'preview-visible' ? 0 : 1)));
          observed.push(stage);
          if (stage === 'preview-visible') return { content: '预览已正常显示。\n实际执行 ' + probe.command };
        }
        return { content: '本步结束。' };
      }
      const finish = finishHarness(harness, { runTurn: model }, 'failed-probe-' + advances);
      useProductionTodoTools(harness, finish);
      finish.context.workspace = workspace;
      finish.context.userText = request;
      finish.context.snap.taskScope = harness.dependency('./agi-task-scope').create(request, [], false);
      finish.context.snap.current = null;
      finish.context.implementationStateKey = harness.agent.test.implementationStateKey;
      const result = await finish.run();
      assert.equal(calls, limit);
      if (advances) {
        assert.deepEqual(observed, ['catalog-unloaded', 'model-missing', 'preview-visible']);
        assert.equal(finish.context.snap.planAccepted, true);
        assert.equal(result.taskPending, false);
        assert.match(result.text, /预览已正常显示。\n实际执行 （命令见工具记录）/);
        assert.doesNotMatch(result.text, /需要注意的是|node preview\.cjs/);
        assert.ok(!result.text.includes(commandMarker));
        check(true, '验收通过时保留真实结果，已执行的长命令也不进入交付正文');
      } else {
        assert.deepEqual(observed, ['catalog-unloaded', 'other-pass']);
        assert.ok(finish.context.snap.planUnverified && !finish.context.snap.planAccepted);
        assert.equal(result.taskPending, true);
        const done = finish.events.find(function final(event) { return event.type === 'done'; });
        assert.equal(done.taskSettled, false);
        assert.equal(done.text, result.text);
        assert.match(result.text, /^需要注意的是，自测命令返回 exit: 1，stdout: catalog-unloaded，stderr: preview-registry-disabled/);
        assert.match(result.text, /预览目录仍未载入。\n实际执行 （命令见工具记录）\n已核对技能目录/);
        assert.doesNotMatch(result.text, /修复完成|自测尚未通过|自测未通过|不能交卷|node preview\.cjs/);
        assert.ok(!result.text.includes(commandMarker));
        assert.ok(finish.context.snap.selfTestEvidence.includes('成功 node -p 42'));
        assert.ok(finish.context.snap.selfTestEvidence.includes('失败 ' + probe.command));
        assert.ok(finish.context.snap.selfTestEvidence.includes('preview-registry-disabled\n' + probe.command));
        check(true, '交付正文保留实测失败原因，原始长命令及其回显只保留在工具证据');
      }
      check(true, '包含初次执行的模型请求共 ' + calls + ' 次，实测 ' + observed.join(' → ') + '，验收通过=' + !!finish.context.snap.planAccepted);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}

/**
 * 用真实沙盒核对编码命令被拒后，收尾能接受发生在同一版本的明文补测。
 * @param {object} harness 提供生产沙盒、直通入口及收尾的隔离夹具。
 * @returns {Promise<void>} 缺少替代实测时保留未执行提示，取得实际证据后完成验收。
 */
async function testBlockedProbeRetries(harness) {
  if (process.platform !== 'win32') return;
  const selfTest = harness.dependency('./agi-self-test');
  const rejected = "powershell -NoProfile -EncodedCommand 'fixture-never-executed'";
  const marker = '明文 PowerShell 实测结果';
  for (const replaced of [false, true]) {
    const workspace = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'spcode-blocked-probe-'));
    const request = '修复检查命令，并验收明文 PowerShell 的实际输出。';
    let calls = 0;
    try {
      /** 首次走真实拒绝，补测时按当前场景提交明文命令或保留缺口。 */
      async function model(args) {
        calls++;
        if (calls === 1) {
          const result = await args.runTool('run_command', { command: rejected, activity: 'test' });
          assert.match(result, /【沙盒拦截】.*EncodedCommand/);
        } else {
          assert.equal(calls, 2);
          assert.match(args.turnText, /命令未执行[\s\S]*EncodedCommand/);
          assert.doesNotMatch(args.turnText, /fixture-never-executed/);
          if (replaced) {
            const result = await args.runTool('run_command', {
              command: "powershell -NoProfile -Command \"Write-Output '" + marker + "'\"",
              activity: 'test'
            });
            assert.ok(result.includes('exit: 0') && result.split(/\r?\n/).includes(marker), result);
          }
        }
        return { content: '本步结束。' };
      }

      const finish = finishHarness(harness, { runTurn: model }, 'blocked-probe-' + replaced);
      useProductionTodoTools(harness, finish);
      finish.context.workspace = workspace;
      finish.context.userText = request;
      finish.context.snap.taskScope = harness.dependency('./agi-task-scope').create(request, [], false);
      finish.context.snap.current = null;
      /** 只用真实输出完成生产覆盖核对，拒绝把未执行的命令当成证据。 */
      async function review() {
        assert.equal(replaced, true);
        const snap = finish.context.snap;
        /** 模拟核对器选择工具回执中的实际输出。 */
        async function inspect(_instruction, material) {
          assert.doesNotMatch(material, /fixture-never-executed/);
          const output = material.split('\n').find(function observed(line) { return line.endsWith('] ' + marker); });
          assert.ok(output);
          return '实测：' + output.slice(1, output.indexOf(']'));
        }
        const coverage = await selfTest.coverage(request, snap.selfTestEvidence, inspect, snap.testCoverage.samples);
        assert.deepEqual(coverage.quotes, [marker]);
        return 'current-pass';
      }
      finish.context.summarizeImplementation = review;

      const result = await finish.run();
      assert.equal(calls, 2);
      assert.equal(!!finish.context.snap.planAccepted, replaced);
      if (!replaced) {
        assert.equal(result.taskPending, true);
        assert.match(result.text, /^需要注意的是，.*命令未执行[\s\S]*EncodedCommand/);
        assert.doesNotMatch(result.text, /fixture-never-executed/);
      }
      check(true, replaced ? '明文补测的实际输出得以验收' : '只有沙盒拒绝时保留待补测状态，并简短说明未执行原因');
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  }
}

/**
 * 验证工作额度切换后，两批共 20 条插话在同一个官方聊天中按顺序送达。
 * @param {object} harness 提供真实 Agent 和插话队列的夹具。
 * @param {boolean} exhaustedAtEntry 本轮开始时额度已耗尽；为 false 时模拟 SDK 运行中耗尽。
 * @returns {Promise<void>} 核对两次实际聊天请求、送达事件和最终回复，只替换外部额度与客户端 UI。
 */
async function testCodexChatInterjections(harness, exhaustedAtEntry) {
  const key = 'official-chat:' + exhaustedAtEntry;
  const requests = [];
  const accepted = [];
  let marker;
  let sessionStarts = 0;
  let quotaReads = 0;
  let sdkRequests = 0;
  let toolCalls = 0;
  let replied = 0;
  let generatingRequest = 0;
  const processingAt = [];

  /**
   * 在隔离环境中执行生产适配器。
   * @param {string} name 适配器文件名，不含扩展名。
   * @param {Function} dependency 当前夹具的模块加载入口。
   * @param {string} extra 只用于注入夹具和暴露会话登记的测试代码。
   * @returns {object} 当前场景独立的适配器导出。
   */
  function loadAdapter(name, dependency, extra) {
    const file = path.join(root, 'electron/lib', name + '.js');
    const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
      process, console, Buffer, AbortController, AbortSignal, setTimeout, runFixtureUi };
    vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\n' + extra, context, { filename: file });
    return context.module.exports;
  }
  /**
   * 模拟官方 UI 的会话标识、实际发送和已完成回复。
   * @param {object} request 生产适配器发出的启动、发送或读取指令。
   * @returns {Promise<object>} 当前指令的 UI 回执；分别在首批发送确认前、确认后模拟新插话。
   */
  async function runFixtureUi(request) {
    if (request.action === 'start') {
      sessionStarts++;
      return { ok: true };
    }
    if (request.action === 'send') {
      if (!requests.length) marker = request.text.match(/SPCODE-SESSION:[\w-]+/)[0];
      else assert.equal(request.sessionMarker, marker);
      requests.push(request.text);
      assert.equal(deliveredAt.length, requests.length - 1, '客户端确认发送前不得宣告送达');
      if (!exhaustedAtEntry && requests.length === 1) {
        for (let i = 2; i <= 20; i++) queueProbe(i);
      }
      return { assistantCount: replied };
    }
    assert.equal(request.action, 'read');
    assert.equal(request.sessionMarker, marker);
    if (replied < requests.length) {
      const items = state.activeInterjectKeys.get(key).memory.current.interjectionTodos;
      if (generatingRequest < requests.length) {
        // 本次发送已确认，客户端还未报告模型活动；这里只能看到办理进度。
        // 首批可由 SDK 或官方客户端先报告发送；第二批只能在新的请求中出现。
        assert.deepEqual(processingAt, requests.length === 1 ? [0] : [0, 1]);
        assert.equal(deliveredAt.length, replied);
        assert.ok(!items[items.length - 1].seen);
        generatingRequest = requests.length;
        return { markerFound: true, assistantCount: replied, generating: true, complete: false };
      }
      assert.equal(deliveredAt.length, requests.length, '开始生成即须确认已看');
      const currentBatch = replied ? items.slice(1) : items.slice(0, 1);
      for (const item of currentBatch) assert.equal(item.seen, true);
      replied++;
      if (exhaustedAtEntry && replied === 1) {
        for (let i = 2; i <= 20; i++) queueProbe(i);
      }
    }
    const action = replied === 1
      ? { action: 'tool', name: 'read_file', arguments: { path: '过期旧动作' } }
      : { action: 'final', text: '已收到第二批插话。' };
    return { markerFound: true, assistantCount: replied, complete: true, lastAssistant: JSON.stringify(action) };
  }
  /** 为生产额度判断提供独立的起始与切换样本，记录是否经过 SDK 失败路径。 */
  async function readQuota() { return exhaustedAtEntry || ++quotaReads > 1; }
  /** 返回本场景的布尔额度样本，避免读取真实账户。 */
  function quotaExhausted(value) { return value; }
  /** 仅用受控的额度耗尽事件驱动运行中切换。 */
  async function* sdkEvents() { yield { type: 'turn.failed', error: { message: '五小时额度已耗尽' } }; }
  /** 返回单次 SDK 失败事件流，并记录该额度分支确实启动过工作 SDK。 */
  async function runSdk() { sdkRequests++; return { events: sdkEvents() }; }

  const chat = loadAdapter('codex-chat-direct', require, 'runUi = runFixtureUi;');
  const localRequire = createRequire(path.join(root, 'electron/lib/codex-direct.js'));
  /** 只替换网络额度与官方 UI，沿用生产路由和工具权限。 */
  function dependency(name) {
    if (name === './codex-model') return { readRateLimitsFromAppServer: readQuota, fiveHourQuotaExhausted: quotaExhausted };
    if (name === './codex-chat-direct') return chat;
    if (name === './diag') return { log: noop };
    return localRequire(name);
  }
  const codex = loadAdapter('codex-direct', dependency, 'module.exports.test = { sessions };');
  if (exhaustedAtEntry) {
    await assert.rejects(codex.runTurn({ key: key + ':parallel', modelCfg: {}, sdkOnly: true }), /无法启动并发分支/);
    check(sessionStarts === 0 && requests.length === 0, 'Codex 额度耗尽时并发分支不进入父会话占用的官方聊天队列');
  }
  if (!exhaustedAtEntry) {
    codex.test.sessions.set(key, { sig: 'fixture\nagi:true\nreasoning:default',
      server: { close: noop }, thread: { runStreamed: runSdk } });
  }
  /**
   * 从生产接收入口登记一条独立插话，保留到达顺序供最终核对。
   * @param {number} i 场景内唯一的插话编号。
   * @returns {void} 接收成功时登记原文；拒收时立即断言失败。
   */
  function queueProbe(i) {
    const text = '请记录官方聊天插话【' + i + '】。';
    assert.ok(harness.agent.pushInterjection(key, text));
    accepted.push(text);
  }
  const deliveredAt = [];
  /**
   * 记录送达状态时官方聊天的回复数，以区分两个批次。
   * @param {object} event 生产 Agent 发出的状态或模型事件。
   * @returns {void} 仅记录明确的插话送达状态。
   */
  function onEvent(event) {
    if (event.type !== 'status') return;
    if (event.text === '正在处理插话，等待模型回复…') processingAt.push(replied);
    if (!event.text.startsWith('插话已送达')) return;
    deliveredAt.push(replied);
    // 取实际账本编号核对：晚到的首批回执不能重新点亮已被新插话打断的条目。
    const items = state.activeInterjectKeys.get(key).memory.current.interjectionTodos;
    const expected = [];
    if (replied === 0 && exhaustedAtEntry) expected.push(items[0].id);
    if (replied === 1) {
      for (const item of items.slice(1)) expected.push(item.id);
    }
    assert.deepEqual(Array.from(event.processingInterjectionIds), expected);
  }
  /** 上一批已过期的工具申请必须在续接前被跳过。 */
  async function runTool() { toolCalls++; return '旧动作不应执行'; }
  const state = harness.agent.test;
  state.activeInterjectKeys.set(key, testInbox(key));
  try {
    queueProbe(1);
    const result = await state.runDirectWithInterjections(codex, {
      key, sig: 'fixture', modelCfg: {}, fresh: false, turnText: '继续当前任务',
      tools: [{ function: { name: 'read_file', parameters: { type: 'object' } } }],
      runTool, onEvent, signal: new AbortController().signal, agiMode: true
    }, key);
    const mode = exhaustedAtEntry ? '起始额度耗尽' : 'SDK 运行中额度耗尽';
    check(sdkRequests === (exhaustedAtEntry ? 0 : 1), mode + '走预期额度路由');
    check(sessionStarts === 1 && requests.length === 2 && toolCalls === 0, mode + '复用聊天续接，跳过已过期的工具申请');
    const sent = requests.flatMap(function extract(text) { return text.match(/请记录官方聊天插话【\d+】。/g); });
    assert.deepEqual(sent, accepted);
    check(sent.length === 20, mode + '两批完整按序送达 20 条且无重复');
    assert.deepEqual(deliveredAt, [0, 1]);
    check(true, mode + '在两批回复各自生成完成前逐条通知处理中，过期回执不点亮旧插话');
    check(!state.interjectInFlight.has(key) && !state.interjectInbox.has(key) && result.content === '已收到第二批插话。', mode + '分批确认，清空收件箱并返回最终回复');
  } finally {
    state.activeInterjectKeys.delete(key);
    codex.closeSession(key);
  }
}

/**
 * 走真实收件、工具和最终交付路径，核对主动确认、打断、重新载入的逐条状态。
 * 外部模型受控返回，成功与业务失败均经过同一条 done 路径。
 */
async function testInterjectionChecklist(harness) {
  for (const outcome of ['成功', '明确失败', '停止', '新插话', '异常']) {
    const key = 'checklist-' + outcome;
    const controller = new AbortController();
    let count = 0;
    let received;
    async function respond(args) {
      count++;
      if (count === 1) {
        assert.ok(harness.agent.pushInterjection(key, '相同的原话'));
        assert.ok(harness.agent.pushInterjection(key, '相同的原话'));
        received = finish.context.workingMemoryRef.current.interjectionTodos;
        assert.equal(received.length, 2);
        assert.notEqual(received[0].id, received[1].id);
        for (const item of received) assert.ok(!item.seen, '仅入队的插话尚未被 AI 看到');
        return { content: '收到。' };
      }
      if (count === 2) {
        assert.ok(args.turnText.includes(received[0].id) && args.turnText.includes(received[1].id));
        // 仅完成续接准备时不显示处理中；首个模型活动应准确指回同文不同编号的两项。
        assert.ok(!finish.events.some(function processing(ev) { return ev.processingInterjectionIds; }));
        args.onEvent({ type: 'reason', text: '正在核对插话。' });
        const active = finish.events.filter(function processing(ev) { return ev.processingInterjectionIds; });
        assert.equal(active.length, 1);
        assert.deepEqual(Array.from(active[0].processingInterjectionIds), Array.from(received, function id(item) { return item.id; }));
        for (const item of finish.context.workingMemoryRef.current.interjectionTodos) assert.equal(item.seen, true);
        const reply = await args.runTool('interjection_done', { id: received[0].id });
        assert.match(reply, /已登记/);
        assert.equal(received[0].status, 'pending');
        if (outcome === '成功') {
          // 此时主回复还未返回；实际交付正文须立即出现在指定卡片上。
          await args.runTool('interjection_done', { id: received[0].id, result: '第一项结果已交付' });
          const current = finish.context.workingMemoryRef.current.interjectionTodos;
          assert.equal(current[0].status, 'completed');
          assert.equal(current[0].result, '第一项结果已交付');
          assert.equal(current[1].status, 'pending');
        }
        if (outcome === '停止') controller.abort();
        if (outcome === '异常') throw new Error('夹具模拟传输中断');
        if (outcome === '新插话') assert.ok(harness.agent.pushInterjection(key, '打断上一段处理'));
      }
      return { content: outcome === '明确失败' ? '该项处理已结束，操作失败，结果已交付。' : '本次答复已交付。' };
    }
    const finish = finishHarness(harness, { runTurn: respond }, key);
    useProductionTodoTools(harness, finish);
    finish.context.signal = controller.signal;
    finish.context.snap.current.manifest.changes = [];
    if (outcome === '停止' || outcome === '异常') {
      await assert.rejects(finish.run());
    } else {
      await finish.run();
    }
    const items = finish.context.workingMemoryRef.current.interjectionTodos;
    const finished = outcome === '成功' || outcome === '明确失败';
    assert.equal(items[0].seen, true);
    assert.equal(items[1].seen, true);
    assert.equal(items[0].status, finished ? 'completed' : 'pending');
    assert.equal(items[1].status, 'pending');
    assert.equal(items.length, outcome === '新插话' ? 3 : 2);
    const restored = harness.dependency('./context-compact').normalizeWorking(JSON.parse(JSON.stringify(finish.context.workingMemoryRef.current)));
    assert.equal(JSON.stringify(restored.interjectionTodos), JSON.stringify(items));
    check(true, outcome + '：收件保留独立原话，交付前不完成，中断状态随会话保存');
  }
  // 真实工具在模型确认仅需知悉时立即办结；混合批次中要求改动的条目仍需交付。
  const mixedKey = 'acknowledgment-checklist';
  let round = 0;
  async function acknowledge(args) {
    round++;
    if (round === 1) {
      for (const text of ['继续', '资料明天给你，知悉即可', '插话不是功能需求的话，AI 看了就可以标记为已处理', '继续改按钮', '我的样书是浅橙色封面，只是告知。']) {
        assert.ok(harness.agent.pushInterjection(mixedKey, text));
      }
      assert.ok(mixedFinish.context.workingMemoryRef.current.interjectionTodos.every(function unread(item) { return !item.seen && item.status === 'pending'; }));
      return { content: '接手插话。' };
    }
    args.onEvent({ type: 'reason', text: '已看见本批消息。' });
    const ledger = mixedFinish.context.workingMemoryRef.current;
    const progress = mixedFinish.events.filter(function status(event) { return event.processingInterjectionIds; }).at(-1);
    assert.ok(!progress.processingInterjectionIds.includes(ledger.interjectionTodos[0].id), '已办结的续办指令不能再次点亮处理中');
    assert.deepEqual(Array.from(ledger.interjectionTodos, function status(item) { return item.status; }), ['completed', 'pending', 'pending', 'pending', 'pending']);
    await args.runTool('interjection_done', { id: ledger.interjectionTodos[1].id, acknowledgmentOnly: true });
    assert.equal(ledger.interjectionTodos[1].status, 'completed');
    return { content: '已知悉。' };
  }
  const mixedFinish = finishHarness(harness, { runTurn: acknowledge }, mixedKey);
  // 主模型只提交第一条告知的回执。交付前的只读核对只确认漏记的告知，其余工作仍须交付。
  mixedFinish.context.reviewWithoutTools = async function reviewNotices(request) {
    const batch = JSON.parse(request.user);
    assert.deepEqual(batch.map(function original(item) { return item.text; }), [
      '插话不是功能需求的话，AI 看了就可以标记为已处理', '继续改按钮', '我的样书是浅橙色封面，只是告知。'
    ]);
    return 'SPCODE_ACK ' + batch[2].id + '\nSPCODE_ACK unrelated';
  };
  useProductionTodoTools(harness, mixedFinish);
  mixedFinish.context.snap.current.manifest.changes = [];
  await mixedFinish.run();
  const mixedItems = mixedFinish.context.workingMemoryRef.current.interjectionTodos;
  assert.deepEqual(Array.from(mixedItems, function status(item) { return item.status; }), ['completed', 'completed', 'pending', 'pending', 'completed']);
  check(mixedItems[4].seen, '交付前补齐主模型漏记的纯告知回执，混合批次中两条功能要求继续待办');
  const key = 'ordinary-checklist';
  let count = 0;
  let id;
  async function ordinary(args) {
    count++;
    if (count === 1) {
      harness.agent.pushInterjection(key, '普通模型插话原文');
      harness.agent.pushInterjection(key, '另一条已核实的普通模型插话');
      return { role: 'assistant', content: '旧答复' };
    }
    if (count === 2) {
      id = finish.context.workingMemoryRef.current.interjectionTodos[0].id;
      assert.ok(args.messages.some(function matches(row) { return row.role === 'user' && String(row.content).includes(id); }));
      assert.ok(!finish.context.workingMemoryRef.current.interjectionTodos[0].seen);
      args.onReason('正在核对插话。');
      assert.equal(finish.context.workingMemoryRef.current.interjectionTodos[0].seen, true);
      const active = finish.events.find(function processing(ev) { return ev.processingInterjectionIds; });
      const secondId = finish.context.workingMemoryRef.current.interjectionTodos[1].id;
      assert.deepEqual(Array.from(active.processingInterjectionIds), [id, secondId]);
      return { role: 'assistant', content: '', tool_calls: [
        { id: 'finish-one', type: 'function', function: { name: 'interjection_done', arguments: JSON.stringify({ id }) } },
        { id: 'publish-two', type: 'function', function: { name: 'interjection_done', arguments: JSON.stringify({ id: secondId, result: '第二项已核实' }) } }
      ] };
    }
    // 同一轮内只登记编号的第一项继续等交付，第二项的实际答复已经发布。
    const current = finish.context.workingMemoryRef.current.interjectionTodos;
    assert.equal(current[0].status, 'pending');
    assert.equal(current[1].status, 'completed');
    assert.equal(current[1].result, '第二项已核实');
    return { role: 'assistant', content: '完整答复。' };
  }
  const finish = finishHarness(harness, null, key);
  finish.context.directOn = false;
  finish.context.modelCfg = { protocol: 'openai', baseUrl: 'http://unused', model: 'fixture' };
  finish.context.snap.current.manifest.changes = [];
  harness.setComplete(ordinary);
  const result = await finish.run();
  check(count >= 3 && result.workingMemory.interjectionTodos[0].status === 'completed', '普通模型按编号立即发布有正文的结果，只登记编号的事项随整轮办结');
}

/** 顺序核对普通循环、生产直通入口、工具边界、会话隔离、停止和 MCP 传输。 */
async function main() {
  // 夹具的 Chromium 窗口可独立关闭，回归入口在全部检查结束时退出 Electron。
  app.on('window-all-closed', noop);
  await app.whenReady();
  const harness = loadAgent();
  await testInterjectionChecklist(harness);
  await testCodexChatInterjections(harness, true);
  await testCodexChatInterjections(harness, false);
  await testSkillVisibility(harness);
  check(!harness.agent.pushInterjection('idle', '空闲消息'), '空闲会话不接受无法消费的插话');
  harness.agent.test.activeInterjectKeys.set('disabled', testInbox('disabled'));
  harness.setAlive(false);
  check(!harness.agent.pushInterjection('disabled', 'AGI关闭消息'), 'AGI关闭仍保留排队语义');
  harness.setAlive(true);
  harness.agent.test.activeInterjectKeys.delete('disabled');
  await testQuotedDelivery(harness);
  await testWorkCycle(harness);
  await testParallelAgi();
  await testParallelOrdinary();
  await testDeferredParallel();
  await testParallelBeforeFirstBatch();
  await testParallelAddition();
  await testParallelBoundaries();
  await testVisualFinish(harness, '验收指定窗口的实际画面');
  await testVisualFinish(harness, '验收 Unity 游戏界面里的按钮布局');
  await testVisualFinish(harness, '验收按每个游戏主题换一下对应的按钮');
  const selfTest = require('../electron/lib/agi-self-test');
  check(selfTest.requiresVisual('调整游戏界面的按钮布局', [{ path: 'Assets/MainMenu.prefab' }], false), '游戏界面预制体的修改要求眼睛验收');
  check(!selfTest.requiresVisual('验证 Unity 场景切换逻辑', [{ path: 'Assets/Scenes/Main.unity' }], false), 'Unity 非视觉逻辑仍用行为测试');
  check(!selfTest.requiresVisual('修复主题配置的保存，保持当前界面不变', [{ path: 'theme-store.js' }], false), '纯主题存储逻辑不因提到界面就要求目视验收');
  await testVisualEvidenceNumbers();
  await testThemeEvidence();
  await testFailedProbeRetries(harness);
  await testBlockedProbeRetries(harness);
  await testUserScope(harness);
  await testManualAdjustment(harness);
  await testScopeBridge(harness);
  await testOrdinaryScope(harness);
  await testOrdinaryQueuedTools(harness);
  await testBeforeTool(harness);
  await testDuringTool(harness);
  await testCompletion(harness);
  await testOrdinary(harness);
  await testOrdinaryImages(harness);
  await testCodexVisionAttachment();
  await testDirectTaskCompletion(harness);
  await testTaskCompletionBoundaries(harness);
  await testCompletionMeaning(harness);
  await testTaskWaitForAnswer(harness);
  await testOrdinaryTaskCompletion(harness);
  await testContinuousGoal(harness);
  await testOrdinaryReadOnly(harness);
  check(harness.agent.toolsSpec().some(function memory(tool) { return tool.function.name === 'process_memory'; }), 'AGI工具列表已注册真实进程内存读取工具');
  await testLongCommand(harness);
  await testCodexBridge(harness);
  await testCodexInterjectionHandoff(harness, '启动');
  await testCodexInterjectionHandoff(harness, '思考');
  await testCodexInterjectionHandoff(harness, '在途工具');
  await testCodexInterjectionHandoff(harness, '积压');
  await testRoutes(harness);
  await testAestheticDelivery();
  await testFinishInterjections(harness);
  await testFinishStopped(harness);
  await testFailedSdkReceipts(harness);
  await testResumedSdkReceipts(harness);
  await testLastFinishInterjection(harness);
  await testOrdinaryFinishInterjection(harness);
  await testOrdinaryFailedReceipt(harness);
  await testRetryInterjection(harness);
  check(unexpected.length === 0, '没有未处理异步异常');
  console.log('RESULT ' + JSON.stringify({ checks, failures: 0, unhandled: unexpected.length }));
  app.exit(0);
}
/** 断言失败必须保留堆栈与失败退出码。 */
function failed(error) { console.error(error.stack || error); app.exit(1); }
if (invokedDirectly) main().catch(failed);
module.exports = { runAestheticDelivery };
