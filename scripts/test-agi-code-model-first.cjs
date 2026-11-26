/**
 * 验证 AGI 模式的代码分工：先让大脑明确选定的代码模型出初版，大脑核验通过即收工；
 * 验收核实出实现问题后进入返工，补测与返工都由大脑自己用原有工具修，不再派代码模型。
 * 仅替换外部模型传输与桌面存活判定，工具执行、文件写入、提示词拼装都走真实 Agent 源码；
 * 不连任何外部模型，不产生提交或发布动作。
 */
'use strict';
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'agi-code-model-first-'));
app.setPath('userData', path.join(output, 'user-data'));
// 保持没有可见窗口的测试进程运行到最后一个场景结束。
app.on('window-all-closed', function keepAlive() {});
let checks = 0;
/** 校验真实行为结果，失败直接中断整轮验证。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }

/**
 * 载入真实 Agent 源码，只替换外部模型传输、桌面存活判定和诊断日志。
 * @param {boolean} desktopAlive 桌面端是否存活；为 true 时生产代码判定当前是 AGI 模式。
 * @returns {object} functions 暴露的顶层函数、setTransport 设置外部模型传输、local 取真实依赖。
 */
function harness(desktopAlive) {
  const file = path.join(root, 'electron/lib/agent.js');
  const local = createRequire(file);
  let transport;
  /** 返回场景传入的桌面存活状态，让模式判定与实际调用链一致。 */
  function alive() { return desktopAlive; }
  /** 忽略本夹具的诊断日志和桌面生命周期通知。 */
  function noop() {}
  /** 为模块名 name 返回隔离的模型或桌面接口，项目内其余依赖使用真实实现。 */
  function dependency(name) {
    if (name === './desktop-hand') return { isAlive: alive, hold: noop, release: noop };
    if (name === './api-protocol') return { ...local(name), complete };
    if (name === './diag') return { log: noop };
    return local(name);
  }
  /** 把本次 API 请求 args 交给场景设置的模型传输，返回其应答。 */
  async function complete(args) { return transport(args); }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval };
  const exportNames = '{ agentLoop, useCodeModel, codeModelsOf, codeModelTool, toolsFor, planRetryPrompt, '
    + 'buildSystemPrompt, composePromptTail, judgePlanVerdict }';
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.probe = ' + exportNames + ';', context, { filename: file });
  /** 设置本轮外部模型传输；大脑与代码模型的请求都从这里走。 */
  function setTransport(fn) { transport = fn; }
  return { functions: context.module.exports.probe, setTransport, local };
}

/** 构造两个平等候选，名称只用于观察调用次数，不参与固定路由。 */
function settings() {
  const models = [];
  const refs = [];
  for (const id of ['ds', 'glm']) {
    models.push({ id, name: id, type: 'api', providerId: 'fixture', model: id });
    refs.push({ type: 'api', apiId: id, model: id });
  }
  return { locale: 'zh', currentModelId: 'ds', models, providers: [{ id: 'fixture', protocol: 'openai', baseUrl: 'http://unused', apiKey: '' }],
    assemblies: {}, capabilityDefaults: { code: { models: refs } } };
}

/** 取出本轮大脑看到的全部工具回执正文，用于核对程序实际给出的收口或拦截说明。 */
function toolTexts(messages) {
  const texts = [];
  for (const item of messages) {
    if (item && item.role === 'tool') texts.push(String(item.content || ''));
  }
  return texts;
}

/** 组装大脑循环上下文：AGI 下由真实工具写盘，代码模型池来自设置。 */
function brainContext(h, models, snap) {
  const common = { workspace: output, extra: [], snap, onEvent: function noopEvent() {},
    signal: new AbortController().signal, lang: h.local('./reply-lang').fromLocale('zh'),
    maxRounds: 6, unlimitedRounds: true, workers: null, roleTag: 'brain', depth: 0,
    userOrder: '实现指定的代码改动', startOrdered: true };
  return { ...common, modelCfg: { protocol: 'openai', model: 'brain', baseUrl: 'http://unused' },
    messages: [{ role: 'system', content: '按任务执行。' }, { role: 'user', content: '实现指定的代码改动' }],
    toolSpec: h.functions.toolsFor('brain', [], true, models) };
}

/** 组装调用代码模型入口所需的公共上下文，含本轮快照里的权限与验收状态。 */
function codeModelOptions(h, snap) {
  return { workspace: output, extra: [], snap, onEvent: function noopEvent() {},
    signal: new AbortController().signal, lang: h.local('./reply-lang').fromLocale('zh'),
    maxRounds: 4, unlimitedRounds: true, workers: null, roleTag: 'brain', depth: 0 };
}

/** 路径一：AGI 有代码模型池时先派初版，大脑核验通过直接收工。 */
async function testFirstVersionPass() {
  const h = harness(true), s = settings();
  const models = h.functions.codeModelsOf(s);
  const snap = { current: null, readOnly: false, codeModels: models, modulePromptContext: {} };
  const calls = [], counts = {};
  let verifyRoundTools = null;
  /** 为 args 指定的模型返回选模、写入或核验操作；实际工具仍由 Agent 执行。 */
  async function transport(args) {
    const model = args.modelCfg.model;
    calls.push(model);
    counts[model] = (counts[model] || 0) + 1;
    if (model === 'brain') {
      // 模拟响应也要使用本次传输真实收到的工具，防止测试替不可见的入口发起调用。
      if (counts.brain === 1) {
        check(args.tools.some(function isCodeTool(tool) { return tool.function.name === 'use_code_model'; }),
          '普通模型首轮请求实际收到代码模型工具');
      }
      // 第二轮核对代码模块的实际回执。
      if (counts.brain === 2) verifyRoundTools = toolTexts(args.messages);
      if (counts.brain === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'first', type: 'function',
        function: { name: 'use_code_model', arguments: JSON.stringify({ modelId: 'api:glm',
          task: '创建 impl.txt，内容写“初版已完成”，只写这个文件并核对工具返回。' }) } }] };
      if (counts.brain === 2) return { role: 'assistant', content: '', tool_calls: [{ id: 'verify', type: 'function',
        function: { name: 'read_file', arguments: JSON.stringify({ path: 'impl.txt' }) } }] };
      return { role: 'assistant', content: '初版内容已核验，需求目标达成。' };
    }
    if (model === 'glm') {
      if (counts.glm === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'write', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'impl.txt', content: '初版已完成' }) } }] };
      return { role: 'assistant', content: 'impl.txt 已写入并核对。' };
    }
    return { role: 'assistant', content: '未选用的候选不应被请求。' };
  }
  h.setTransport(transport);
  const answer = await h.functions.agentLoop(brainContext(h, models, snap));
  check(fs.readFileSync(path.join(output, 'impl.txt'), 'utf8') === '初版已完成', 'AGI 初版由大脑明确选定的代码模型写入');
  check(counts.glm === 2 && !calls.includes('ds'), '只请求选定的代码模型，未选候选不发请求');
  check(snap.agiCodeModelUsed === true, '代码模型实际返回后登记初版交付');
  check(!!verifyRoundTools && verifyRoundTools.length > 0, '大脑拿到代码模块回执并继续核验');
  check(answer.includes('核验'), '大脑完成核验后正常收尾');
}

/** 路径二：验收核实实现问题后进入返工，两种入口都不再派代码模型，由大脑自己修。 */
async function testReworkStageSelfFix() {
  const h = harness(true), s = settings();
  const models = h.functions.codeModelsOf(s);
  // 验收循环在派回返工前会把已核实的缺口写进 planGaps，这里复用同一状态
  const snap = { current: null, readOnly: false, codeModels: models, modulePromptContext: {},
    planGaps: '【不一致】impl.txt:1 内容应为“已修复”' };
  const calls = [], counts = {};
  let reworkTools = null;
  /** 根据 args 中的请求顺序先尝试重复派工，再让大脑写入修正；调用次数用于发现意外的代码模型请求。 */
  async function transport(args) {
    const model = args.modelCfg.model;
    calls.push(model);
    counts[model] = (counts[model] || 0) + 1;
    if (model === 'brain') {
      if (counts.brain === 2) reworkTools = toolTexts(args.messages);
      if (counts.brain === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'again', type: 'function',
        function: { name: 'use_code_model', arguments: JSON.stringify({ modelId: 'api:glm', task: '再派一次修 impl.txt。' }) } }] };
      if (counts.brain === 2) return { role: 'assistant', content: '', tool_calls: [{ id: 'self', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'impl.txt', content: '已修复' }) } }] };
      return { role: 'assistant', content: '返工已由大脑直接改好并重验。' };
    }
    return { role: 'assistant', content: '返工阶段不应请求代码模型。' };
  }
  h.setTransport(transport);
  const answer = await h.functions.agentLoop(brainContext(h, models, snap));
  check(reworkTools && reworkTools.some(function blocked(text) { return text.includes('当前由大脑核验交付'); }),
    '返工阶段 use_code_model 被收口并提示大脑自己核验修复');
  check(counts.glm === undefined, '返工阶段不再请求任何代码模型');
  check(fs.readFileSync(path.join(output, 'impl.txt'), 'utf8') === '已修复', '大脑用原有工具直接修好文件');
  check(answer.includes('返工'), '返工完成后正常收尾');
  // 直通入口共用同一个执行函数：带返工缺口或正在补测时都直接拒绝，不发起模型请求
  await assert.rejects(h.functions.useCodeModel(codeModelOptions(h, snap), { modelId: 'api:glm', task: '直通入口再派一次。' }),
    /当前由大脑核验交付/, '直通入口在返工阶段同样不派代码模型');
  await assert.rejects(h.functions.useCodeModel({ ...codeModelOptions(h, { ...snap, planGaps: '' }), selfTesting: true },
    { modelId: 'api:glm', task: '补测时再派一次。' }), /当前由大脑核验交付/, '补测阶段同样不派代码模型');
  check(counts.glm === undefined, '直通与补测入口都没有发起代码模型请求');
  const retry = h.functions.planRetryPrompt(output, snap, [], '【不一致】impl.txt:1', '实现指定的代码改动');
  check(retry.includes('不要再派代码模型'), 'AGI 返工提示写明不再派代码模型');
}

/** 路径三：普通非 AGI 模式保持原有分工，返工仍按原流程派代码。 */
async function testNormalModeUnchanged() {
  const h = harness(false), s = settings();
  const models = h.functions.codeModelsOf(s);
  const snap = { current: null, readOnly: false, codeModels: models, modulePromptContext: {},
    planGaps: '【不一致】impl.txt:1' };
  const retry = h.functions.planRetryPrompt(output, snap, [], '【不一致】impl.txt:1', '实现指定的代码改动');
  check(retry.includes('派代码修正') && !retry.includes('不要再派代码模型'), '非 AGI 返工提示仍要求派代码修正');
  // 非 AGI 即便带着返工缺口，代码模型池仍可正常使用（收口只针对 AGI）
  const calls = [];
  /** 记录 args 指定的普通模式代码模型，返回这次任务的模拟回执。 */
  async function transport(args) {
    calls.push(args.modelCfg.model);
    return { role: 'assistant', content: '已完成指定任务。' };
  }
  h.setTransport(transport);
  const result = await h.functions.useCodeModel(codeModelOptions(h, snap), { modelId: 'api:ds', task: '普通模式使用代码模型。' });
  check(result.includes('已完成') && calls.includes('ds'), '非 AGI 的代码模型分工不受 AGI 返工收口影响');
}

/** 路径四：没有代码模型时保持自己动手能力，AGI 拦截与只读限制原样生效。 */
async function testNoPoolAndReadOnly() {
  const h = harness(true), s = settings();
  const models = h.functions.codeModelsOf(s);
  // 本轮没有代码模型池：工具清单不该出现选模工具，大脑只能自己动手
  const snap = { current: null, readOnly: false, codeModels: [], modulePromptContext: {} };
  const toolNames = h.functions.toolsFor('brain', [], true, []).map(function name(t) { return t.function ? t.function.name : t.name; });
  check(!toolNames.includes('use_code_model'), '没有代码模型池时不提供选模工具');
  let blockedCallWorker = '';
  const counts = {};
  /** 让无代码池的大脑尝试调用旧派单工具，再用自己的文件工具完成任务；args 包含本次请求的模型与消息。 */
  async function transport(args) {
    const model = args.modelCfg.model;
    counts[model] = (counts[model] || 0) + 1;
    if (counts.brain === 2) blockedCallWorker = (toolTexts(args.messages)[0] || '');
    if (counts.brain === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'worker', type: 'function',
      function: { name: 'call_worker', arguments: JSON.stringify({ role: 'code', task: '改文件' }) } }] };
    if (counts.brain === 2) return { role: 'assistant', content: '', tool_calls: [{ id: 'self', type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: 'solo.txt', content: '自己写' }) } }] };
    return { role: 'assistant', content: '没有代码模型时由大脑自己写文件。' };
  }
  h.setTransport(transport);
  const answer = await h.functions.agentLoop(brainContext(h, [], snap));
  check(fs.readFileSync(path.join(output, 'solo.txt'), 'utf8') === '自己写', '无代码模型时大脑用原有工具自己写文件');
  check(blockedCallWorker.includes('use_code_model') && blockedCallWorker.includes('返工由大脑完成'),
    'AGI 下 call_worker 被拦并指向可用的代码模型入口');
  check(answer.includes('自己写文件'), '无代码模型时循环正常收尾');
  // 只读轮次仍禁止用代码模型改文件，返工收口不能盖掉只读限制
  await assert.rejects(h.functions.useCodeModel(codeModelOptions(h, { ...snap, codeModels: models, readOnly: true }),
    { modelId: 'api:glm', task: '只读时不得改动。' }), /仅允许只读/, '只读限制原样保留');
}

/** 路径五：AGI 的系统提示与直通尾巴真的把「初版派代码模型、核验通过收工、返工自己修」写给模型。 */
function testPromptWiring() {
  const h = harness(true);
  const zh = h.local('./reply-lang').fromLocale('zh');
  const system = h.functions.buildSystemPrompt({ workspace: output, rules: [], skill: null, extra: [], allSkills: [],
    persona: '', visionMode: false, visionBridge: null, lang: zh, globalPrefs: {}, profile: null,
    zbaingBridge: null, brainHandsOff: false, hasPlanning: true, userOrder: '实现功能', thinkBudget: 1,
    planFile: '', startOrdered: true });
  check(system.includes('use_code_model') && system.includes('返工阶段不再派代码模型'),
    'AGI 系统提示写明初版派代码模型与返工收口');
  const direct = h.functions.composePromptTail({ modelCfg: { model: 'brain' }, turnStart: true, userText: '实现功能',
    codeWorker: true, planningWorker: true, agiNow: true, lang: zh, cursorDirectOn: true });
  check(direct.includes('AGI'), 'AGI 直通尾巴保留 AGI 执行口径');
  // 压力段：AGI 只说禁止 call_worker，不再禁止派代码模型
  const pressure = require('../electron/lib/brain-pressure').promptBlock(output, false, true);
  check(pressure.includes('禁止 call_worker') && !pressure.includes('禁止派单'), 'AGI 压力段不再禁止派代码模型');
}

/**
 * 核对代码模型交付后的返工门槛。用真实文件区分引文、行为差异和不能继续的约束。
 * 无参数。断言失败时中断测试；普通模式仍使用原验收规则。
 */
function testVerifiedOnlyVerdict() {
  const judge = harness(true).functions.judgePlanVerdict;
  fs.writeFileSync(path.join(output, 'gap.txt'), '实际内容\n', 'utf8');
  const evidence = '证据：gap.txt:1「实际内容」';
  const allegation = '不一致：内容应为实际内容。' + evidence;
  const equalReview = { request: '内容应为实际内容', observations: [] };
  const draft = judge(allegation, output, [], true);
  check(!draft.failed && draft.incomplete, '引文真实但尚未核实差异时只读复核');
  const equal = judge('不一致：预期「实际内容」；实际「实际内容」；差异：正文不符。' + evidence,
    output, [], true, equalReview);
  check(!equal.failed && equal.unverified, '实际内容与要求相同时拒绝返工');
  const review = { request: '内容应为指定内容', observations: [] };
  const comparison = '预期「指定内容」；实际「实际内容」；差异：文件保留了旧正文。' + evidence;
  const repair = judge('严重问题：' + comparison, output, [], true, review);
  check(repair.failed && !repair.cannot && repair.gaps.length === 1, '可修复的严重错误进入大脑返工');
  const wrongGoal = judge('不一致：' + comparison, output, [], true, equalReview);
  check(!wrongGoal.failed && wrongGoal.unverified, '评审自行增加的要求不能触发返工');
  const wrongObservation = judge('不一致：预期「指定内容」；实际「编造内容」；差异：正文不符。' + evidence,
    output, [], true, review);
  check(!wrongObservation.failed && wrongObservation.unverified, '实际表现必须来自引文或已核实的实测');
  const missing = '不一致：预期「指定内容」；实际「实际内容」；差异：正文不符。证据：gap.txt:1「查无此内容」';
  const mixed = judge('不一致：' + comparison + '\n' + missing, output, [], true, review);
  check(mixed.failed && mixed.gaps.length === 1 && mixed.unproven === 1, '只把已经核实的差异交给大脑');
  const constraints = { request: '内容应为指定内容，同时必须保留原正文且不许修改。', observations: [] };
  const blocker = '无法与方案一致：预期「指定内容」；实际「实际内容」；约束「必须保留原正文且不许修改」；阻塞原因：要求同时保留和替换唯一正文。' + evidence;
  const blocked = judge(blocker, output, [], true, constraints);
  check(blocked.cannot && blocked.gaps.includes(blocker), '已核实的约束冲突停止执行并保留原因');
  const inventedConstraint = judge(blocker, output, [], true, review);
  check(!inventedConstraint.cannot && inventedConstraint.unverified, '用户未施加的约束不能停止大脑修复流程');
  check(judge(missing, output, [], false).failed, '普通模式判据保持原样');
}

/** 依次跑六条路径；任一断言失败即非零退出。 */
async function main() {
  await testFirstVersionPass();
  await testReworkStageSelfFix();
  await testNormalModeUnchanged();
  await testNoPoolAndReadOnly();
  testPromptWiring();
  testVerifiedOnlyVerdict();
  console.log('全部通过：' + checks + ' 项');
  app.quit();
}

// 记录首个失败的断言或运行异常，以非零状态结束隔离的 Electron 进程。
main().catch(function failed(error) {
  console.error(error && error.stack ? error.stack : error);
  app.exit(1);
});
