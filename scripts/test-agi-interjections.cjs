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
// 可指定已构建的 resources/app 根目录，让同一组行为断言核对实际交付源码。
const root = path.resolve(process.argv[2] || path.join(__dirname, '..'));
// 指定发布目录时沿用真实发布边界；采集实现本来就不随包分发，不能以开发身份加载它。
if (process.argv[2]) Object.defineProperty(app, 'isPackaged', { value: true });
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
  vm.runInNewContext(source + '\nmodule.exports.test = { runDirectWithInterjections, takeInterjections, activeInterjectKeys, interjectInbox, interjectArchives, agentLoop, requirementText, unfinishedTaskTodos, agiContinuationPrompt, stillWorking, promisesMoreInvestigation, abortErr, execTool, recordTaskTodoIds, answerParts, askAnswerIsStart };',
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
    runDirectWithInterjections: harness.agent.test.runDirectWithInterjections,
    agentLoop: harness.agent.test.agentLoop,
    unfinishedTaskTodos: harness.agent.test.unfinishedTaskTodos,
    agiContinuationPrompt: harness.agent.test.agiContinuationPrompt,
    stillWorking: harness.agent.test.stillWorking,
    promisesMoreInvestigation: harness.agent.test.promisesMoreInvestigation,
    abortErr: harness.agent.test.abortErr,
    directTodoIds: new Set(),
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
    context.activeInterjectKeys.add(key);
    try { return await context.runBrain(list, started, resume); }
    finally { context.activeInterjectKeys.delete(key); }
  }
  return { run, context, events };
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
  check(!harness.agent.pushInterjection('before', '收尾之后的消息'), '轮次退出后不假报接收，交给界面排队');
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
  check(harness.agent.test.takeInterjections('other')[0].text === '另一个会话的消息', '本轮不会清掉其他会话消息');
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
  async function progress() {
    calls++;
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
      key, sig: 'fixture', modelCfg: { apiKey: 'test-no-network', reasoningEffort: 'high' }, tools: [{ name: 'read_file', parameters: { type: 'object' } }],
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
    fs, path, require, agent: harness.agent,
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
    check(reply.ok && inbox.map(function body(item) { return item.text; }).join('|') === '主窗插话|小窗插话', '真实主窗 IPC 与悬浮栏入口投递同一会话');
    check(broadcasts.some(function status(item) { return item.kind === 'status' && item.text.includes('已接收'); }),
      '接收状态与投递状态分开显示');
    check(queued.length === 1 && queued[0].channel === 'chat:float-user-message' &&
      queued[0].payload.interjection === true && queued[0].payload.tabId === 'tab' && queued[0].payload.text === '小窗插话',
      '成功的小窗插话回传绑定会话登记历史，不重复投递');
    queued.length = 0;
    const imagePath = path.join(root, 'icons.png');
    const pictureReply = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '', attachments: [{ path: imagePath, name: '参考图.png' }] });
    context.handleFloatBarSend({ key, text: '看图片', attachments: [{ path: imagePath, name: '参考图.png' }] });
    const pictureInbox = harness.agent.test.takeInterjections(key);
    check(pictureReply.ok && pictureInbox.length === 2 && pictureInbox.every(function image(item) { return item.attachments[0].path === imagePath; }), '主窗纯图和桌宠图文插话均保留原路径进入同一队列');
    check(queued[0].payload.attachments[0].path === imagePath && queued[0].payload.images[0].startsWith('file:'), '桌宠插话回传历史包含可显示的原图');
    queued.length = 0;
    harness.agent.test.activeInterjectKeys.delete(key);
    const ended = await handlers.get('chat:interject')({}, { tabId: 'tab', text: '收尾补充' });
    context.handleFloatBarSend({ key, text: '小窗收尾补充' });
    check(!ended.ok && queued.length === 1 && queued[0].payload.text === '小窗收尾补充',
      '主窗和小窗在轮次结束后都保留补充并转交正常队列');
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
  const trackStart = source.indexOf('  const turnInterjections = [];', enableEnd);
  const trackEnd = source.indexOf('  let directWrites =', trackStart);
  const finishStart = source.indexOf('  const planItemsOn =', trackEnd);
  const finishEnd = source.indexOf('  // 只在用户明确表达偏好', finishStart);
  const cleanupStart = source.indexOf("  } finally {\n    signal?.removeEventListener('abort', stopTurnInterjections);", finishEnd);
  const cleanupEnd = source.indexOf('\n}\n\nfunction listSkills', cleanupStart) + 2;
  assert.ok(lifeStart > turnStart && enableStart > lifeEnd && trackStart > enableEnd &&
    finishStart > trackEnd && cleanupStart > finishEnd && cleanupEnd > cleanupStart);
  const context = brain.context;
  context.interjectInbox = harness.agent.test.interjectInbox;
  context.interjectArchives = harness.agent.test.interjectArchives;
  context.trainingArchive = { current: function current() { return null; } };
  context.snapshot = { captureAfter: noop };
  context.vs = {};
  context.history = [];
  context.messages = messages();
  context.planMismatch = false;
  context.rollingSummary = '';
  context.zbaingMeta = null;
  context.explicitPreferenceSaved = false;
  context.planLock = null;
  context.turnId = 'finish-fixture';
  context.snap.current = { id: 'finish-fixture', manifest: { changes: [{ path: 'fixture.js', action: 'write' }] } };
  context.compact = { isContextOverflowError: function overflow() { return false; } };
  context.diag = { log: noop };
  context.requirementText = harness.agent.test.requirementText;
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
  context.withholdUnverifiedDelivery = function delivery(value) { return value; };
  context.chainLib = function chain() { return { parseChainItems: function parse() { return []; } }; };
  context.onEvent = function onEvent(event) {
    brain.events.push(event);
    if (event.type === 'done') check(!harness.agent.pushInterjection(key, 'done之后的消息'),
      'done同步交付前已关闭插话入口，不假报接收');
  };
  vm.runInNewContext(source.substring(trackStart, trackEnd) +
    '\nasync function finish() {\n' + source.substring(lifeStart, lifeEnd) +
    '\ntry {\n' + source.substring(enableStart, enableEnd) +
    source.substring(finishStart, finishEnd) + '\nreturn result;\n' +
    source.substring(cleanupStart, cleanupEnd) + '\nthis.finish = finish;', context);
  return { run: context.finish, context, events: brain.events };
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
      check(args.turnText.includes('新增核对条件') && !args.turnText.includes('【本轮 AGI 状态】') &&
        args.firstPrefix === '' && args.systemContext === '' && args.requiredToolNames.length === 0,
        stage + '续接只送新增消息，不重发原任务和首次必调工具');
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
    harness.agent.test.activeInterjectKeys.add('finish-other');
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
  await testOrdinaryImages(harness);
  await testDirectTaskCompletion(harness);
  await testTaskCompletionBoundaries(harness);
  await testCompletionMeaning(harness);
  await testTaskWaitForAnswer(harness);
  await testOrdinaryTaskCompletion(harness);
  await testContinuousGoal(harness);
  await testOrdinaryReadOnly(harness);
  check(harness.agent.toolsSpec().some(function memory(tool) { return tool.function.name === 'process_memory'; }), 'AGI工具列表已注册真实进程内存读取工具');
  await testCodexBridge(harness);
  await testRoutes(harness);
  await testFinishInterjections(harness);
  await testFinishStopped(harness);
  await testLastFinishInterjection(harness);
  await testOrdinaryFinishInterjection(harness);
  await testRetryInterjection(harness);
  check(unexpected.length === 0, '没有未处理异步异常');
  console.log('RESULT ' + JSON.stringify({ checks, failures: 0, unhandled: unexpected.length }));
  app.exit(0);
}
/** 断言失败必须保留堆栈与失败退出码。 */
function failed(error) { console.error(error.stack || error); app.exit(1); }
main().catch(failed);
