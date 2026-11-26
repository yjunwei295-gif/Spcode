/**
 * 用真实 Agent 工具循环、磁盘写入和完整设置页面验证代码模型池。
 * 仅替换模型传输，验证大脑明确选择的模型执行工作，未选模型不发请求。
 */
'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert/strict');
const { createRequire } = require('module');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'code-model-pool-'));
app.setPath('userData', path.join(output, 'user-data'));
app.on('window-all-closed', function keepAlive() {});
let checks = 0;
/** 校验真实结果。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 精确提取顶层函数供页面夹具使用，不改变生产代码。 */
function extract(source, signature) {
  const start = source.indexOf(signature), end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, signature);
  return source.substring(start, end + 3);
}
/** 载入真实 Agent，只替换外部模型传输和桌面生命周期。 */
function harness() {
  const file = path.join(root, 'electron/lib/agent.js');
  const local = createRequire(file);
  let transport;
  let directTransport;
  function alive() { return true; }
  function noop() {}
  function dependency(name) {
    if (name === './desktop-hand') return { isAlive: alive, hold: noop, release: noop };
    if (name === './api-protocol') return { ...local(name), complete };
    if (name === './codex-direct') return { ...local(name), runTurn: direct };
    if (name === './diag') return { log: noop };
    return local(name);
  }
  async function complete(args) { return transport(args); }
  async function direct(args) { return directTransport(args); }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.poolTest = { agentLoop, useCodeModel, codeModelsOf, codeModelTool, toolsFor };', context, { filename: file });
  function setTransport(fn) { transport = fn; }
  function setDirect(fn) { directTransport = fn; }
  return { functions: context.module.exports.poolTest, agent: context.module.exports, setTransport, setDirect, local };
}
/** 构造三个同等候选，名称只用于观察，不参与任何固定路由。 */
function settings() {
  const models = [];
  const refs = [];
  for (const id of ['ds', 'kimi', 'glm']) {
    models.push({ id, name: id, type: 'api', providerId: 'fixture', model: id });
    refs.push({ type: 'api', apiId: id, model: id });
  }
  return { locale: 'zh', currentModelId: 'ds', models, providers: [{ id: 'fixture', protocol: 'openai', baseUrl: 'http://unused', apiKey: '' }],
    assemblies: {}, capabilityDefaults: { code: { models: refs } } };
}
/**
 * 验证模型选择、实际写入和验收分流。无参数；使用隔离工作区和模拟的模型传输。
 * @returns {Promise<object>} 测试结果目录 output 和实际记录的模型调用列表 calls。
 */
async function testRouting() {
  const h = harness(), s = settings(), assembly = h.local('./assembly');
  const legacy = assembly.normalizeCapabilityDefaults({ code: { primary: s.capabilityDefaults.code.models[0], fallbacks: s.capabilityDefaults.code.models.slice(1) } });
  check(legacy.code.models.length === 3 && !Object.hasOwn(legacy.code, 'primary'), '旧主备迁为三个平等候选');
  check(assembly.resolveRole(s, 'code') === null, '多个候选时不默认取首项');
  const models = h.functions.codeModelsOf(s);
  check(models.length === 3 && models.every(function valid(m) { return m.config.baseUrl === 'http://unused'; }), '三个模型均解析为真实供应商配置');
  const tool = h.functions.codeModelTool(models);
  check(tool.function.parameters.required.includes('modelId') && tool.function.parameters.properties.modelId.enum.length === 3, '选模工具必须明确指定候选');
  const events = [], calls = [], counts = {};
  const archive = require('../electron/lib/training-archive');
  const trace = archive.create(output, 'pool-fixture', 'pool-turn', {});
  const snap = { current: null, readOnly: false, codeModels: models, modulePromptContext: {}, trainingArchive: trace };
  const common = { workspace: output, extra: [], snap, onEvent: event, signal: new AbortController().signal,
    lang: h.local('./reply-lang').fromLocale('zh'), maxRounds: 4, unlimitedRounds: true, workers: null,
    roleTag: 'brain', depth: 0, userOrder: '实现指定的代码改动', startOrdered: true };
  function event(value) { events.push(value); }
  async function transport(args) {
    const model = args.modelCfg.model;
    calls.push(model); counts[model] = (counts[model] || 0) + 1;
    if (model === 'brain') {
      if (counts.brain <= 2) {
        const chosen = counts.brain === 1 ? 'kimi' : 'glm';
        return { role: 'assistant', content: '', tool_calls: [{ id: chosen, type: 'function',
          function: { name: 'use_code_model', arguments: JSON.stringify({ modelId: 'api:' + chosen,
            task: '请创建 ' + chosen + '.txt，内容为“' + chosen + '已执行”，仅写此文件并核对工具返回。' }) } }] };
      }
      return { role: 'assistant', content: '两项指定任务已完成。' };
    }
    if (counts[model] === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'write-' + model, type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: model + '.txt', content: model + '已执行' }) } }] };
    return { role: 'assistant', content: model + '已完成指定文件写入。' };
  }
  h.setTransport(transport);
  async function run() {
    return h.functions.agentLoop({ ...common, modelCfg: { protocol: 'openai', model: 'brain', baseUrl: 'http://unused' },
      messages: [{ role: 'system', content: '按任务分别选kimi和glm，不选ds。' }, { role: 'user', content: '实现指定的代码改动' }],
      toolSpec: h.functions.toolsFor('brain', [], true, models) });
  }
  const answer = await archive.run(trace, run);
  await trace.finish('success');
  check(answer.includes('完成') && fs.readFileSync(path.join(output, 'kimi.txt'), 'utf8') === 'kimi已执行', '大脑选择第二个候选并实际完成文件写入');
  check(fs.readFileSync(path.join(output, 'glm.txt'), 'utf8') === 'glm已执行' && !calls.includes('ds'), '大脑再选择第三个候选协作，未选择的首项没有请求');
  check(events.some(function selected(e) { return e.activeModel === 'glm' && e.activeRole === 'code'; }), '界面事件标明实际选用的模型');
  const data = fs.readFileSync(trace.jsonl, 'utf8').trim().split('\n').map(JSON.parse);
  check(data.filter(function selected(r) { return r.kind === 'code-model-start'; }).length === 2 &&
    data.some(function raw(r) { return r.kind === 'tool-start' && r.data.input.name === 'write_file'; }), '归档包含选模决策与真实执行工具');
  let failures = 0;
  async function failure() { failures++; throw Object.assign(new Error('指定模型失败'), { status: 400 }); }
  h.setTransport(failure);
  await assert.rejects(h.functions.useCodeModel(common, { modelId: 'api:ds', task: '只调用所选模型' }), /指定模型失败/);
  check(failures === 1, '所选模型失败不自动调用其他模型');
  await assert.rejects(h.functions.useCodeModel(common, { task: '没有选模型' }), /未选择有效代码模型/);
  check(failures === 1, '未选模型明确拒绝，不暗选第一项');
  // 完整轮次核对真实工具调用次数，分别覆盖正确交付、两类返工、评审误报和不可解的要求。
  h.local('./store').save(s);
  for (const scenario of ['pass', 'repair', 'severe', 'falseAlarm', 'unverified', 'blocked']) {
    await testDirectDelivery(h, common.signal, event, scenario);
  }
  return { output, calls };
}
/**
 * 在直通大脑的真实验收循环中记录谁写初版、谁返工，以及核验所读到的文件内容。
 * @param {object} h 可控制模型传输的 Agent 夹具，文件工具和验收判定均使用生产实现。
 * @param {AbortSignal} signal 本轮停止信号。
 * @param {Function} onEvent 接收工具与状态事件。
 * @param {string} scenario 分别模拟初版正确、输出错误、启动异常、真实引文误报、引文失实及要求冲突。
 * @returns {Promise<void>} 核对最终正文、落盘结果和两种模型的写入次数后结束。
 */
async function testDirectDelivery(h, signal, onEvent, scenario) {
  // 让 Electron 用户数据和测试报告位于工作区外，文件指纹只随交付脚本变化。
  const workspace = fs.mkdtempSync(path.join(output, scenario + '-'));
  const file = 'direct-' + scenario + '.cjs';
  const expected = 'console.log("READY");';
  const needsRepair = scenario === 'repair' || scenario === 'severe';
  let draft = expected;
  if (scenario === 'repair' || scenario === 'blocked') draft = 'console.log("WAITING");';
  if (scenario === 'severe') draft = 'throw new Error("STARTUP_FAILURE");';
  // 在测试进程中观察脚本启动结果，异常消息和正常输出都来自实际执行。
  const command = 'node -e "try { require(\'./' + file + '\') } catch (error) { console.log(error.message) }"';
  let observation = '';
  let workerRequests = 0;
  let assignments = 0;
  let repairs = 0;
  let reviews = 0;
  const task = '实现脚本 ' + file + '，运行时只输出 READY。' +
    (scenario === 'blocked' ? '同一次运行还必须只输出 WAITING。' : '');

  /**
   * 响应 args 指定的模型请求。实现模型通过工具写入，覆盖核对只返回实际命令输出的编号。
   * @returns {Promise<object>} 供真实 Agent 循环执行的工具调用或模型正文。
   */
  async function apiModel(args) {
    if (args.modelCfg.model !== 'glm') {
      const material = String(args.messages.at(-1).content);
      // 找到模型收到的候选行编号；匹配的内容必须是本次 command 实际输出的整行。
      let selected;
      for (const line of material.split('\n')) {
        if (line.startsWith('[') && line.endsWith('] ' + observation)) selected = line;
      }
      assert.ok(selected, '行为覆盖须引用本次真实读回的行：' + observation);
      return { role: 'assistant', content: '实测：' + selected.slice(1, selected.indexOf(']')) };
    }
    workerRequests++;
    if (workerRequests === 1) return { role: 'assistant', content: '', tool_calls: [{ id: 'write', type: 'function',
      function: { name: 'write_file', arguments: JSON.stringify({ path: file, content: draft }) } }] };
    assert.ok(fs.existsSync(path.join(workspace, file)), JSON.stringify(args.messages.filter(function receipt(m) { return m.role === 'tool'; })));
    return { role: 'assistant', content: '文件已写入。' };
  }

  /**
   * 模拟直通模型对 args 中本轮提示的响应。读盘和测试使用真实工具，只在生产返工入口修改文件。
   * @returns {Promise<object>} 核对结论或大脑本轮答复，断言失败时拒绝。
   */
  async function directModel(args) {
    if (args.key.startsWith('worker:summary:')) {
      reviews++;
      const actual = fs.readFileSync(path.join(workspace, file), 'utf8');
      const quote = scenario === 'unverified' ? '文件中没有这句话' : actual;
      const evidence = '证据：' + file + ':1「' + quote + '」';
      const rechecking = args.turnText.includes('【只读复核实现差异】');
      const label = scenario === 'severe' ? '严重问题' : '不一致';
      if (rechecking) {
        assert.ok(args.turnText.includes('当前版本已核实的实测行：\n' + observation));
        for (const tool of args.tools) assert.ok(['read_file', 'search_text', 'map_lookup', 'list_dir', 'goto_definition'].includes(tool.name));
        if (scenario === 'blocked') return { content: '方案验收：未通过\n无法与方案一致：预期「READY」；实际「' +
          observation + '」；约束「同一次运行还必须只输出 WAITING」；阻塞原因：两个互斥的唯一输出无法同时满足。' + evidence };
        if (observation !== 'READY' || scenario === 'unverified') return { content: '方案验收：未通过\n' +
          label + '：预期「READY」；实际「' + observation + '」；差异：脚本启动后没有交付所需输出。' + evidence };
      } else if (actual !== expected || scenario === 'unverified' || scenario === 'falseAlarm') {
        return { content: '方案验收：未通过\n' + label + '：运行结果应为 READY。' + evidence };
      }
      return { content: '核对 1：正文与要求一致。' + evidence + '\n方案验收：通过' };
    }
    if (args.turnText.includes('【需求验收未通过】')) {
      assert.ok(needsRepair, '只有真实错误才应进入大脑返工：' + scenario);
      await assert.rejects(args.runTool('use_code_model', { modelId: 'api:glm', task }), /当前由大脑核验交付/);
      await args.runTool('edit_file', { path: file, old_string: draft, new_string: expected });
      repairs++;
    } else {
      assert.equal(assignments++, 0, '同一初版只应派发一次：' + args.turnText.slice(-850));
      assert.ok(args.tools.some(function pool(t) { return t.name === 'use_code_model'; }));
      assert.ok(args.requiredToolNames.includes('use_code_model'));
      const delivery = await args.runTool('use_code_model', { modelId: 'api:glm', task });
      assert.ok(fs.existsSync(path.join(workspace, file)), '代码模块回执：' + delivery);
    }
    const execution = await args.runTool('run_command', { command, activity: 'test' });
    const stdout = execution.match(/^--- stdout ---\s*\r?\n(READY|WAITING|STARTUP_FAILURE)\s*$/m);
    assert.ok(stdout, execution);
    observation = stdout[1];
    return { content: '已核对文件正文。' };
  }
  h.setTransport(apiModel);
  h.setDirect(directModel);
  const result = await h.agent.runTurn({ workspace, appRoot: root,
    modelCfg: { id: 'brain-direct', protocol: 'codex', model: 'brain-direct', baseUrl: 'codex://sdk' },
    history: [], userText: task, action: 'start-work', attachments: [], contextPaths: [],
    skill: null, rules: [], allSkills: [], onEvent, signal, workingMemory: {}, contextSummary: '',
    extraFolders: [], unlimitedRounds: true, interjectKey: 'fixture:' + scenario, turnId: scenario });
  assert.equal(fs.readFileSync(path.join(workspace, file), 'utf8'), scenario === 'blocked' ? draft : expected);
  assert.equal(assignments, 1);
  assert.equal(workerRequests, 2, '代码模型只写一次并返回一次结果');
  assert.equal(repairs, Number(needsRepair));
  const reviewCount = { pass: 1, repair: 3, severe: 3, falseAlarm: 2, unverified: 2, blocked: 2 };
  assert.equal(reviews, reviewCount[scenario], scenario + '：' + result.text);
  assert.equal(result.text.includes('尚未验收通过'), scenario === 'unverified' || scenario === 'blocked');
  if (scenario === 'blocked') assert.ok(result.text.includes('两个互斥的唯一输出无法同时满足'));
  check(true, { pass: '正确初版一次验收通过，大脑未重写', repair: '实际输出错误，大脑修复并重新运行通过',
    severe: '实际启动抛错，大脑修复后重新运行输出 READY', falseAlarm: '引用真实但输出已正确，只读复核通过',
    unverified: '依据失实时保留未核实状态，全程未返工', blocked: '要求互斥时报告真实约束并停止写入' }[scenario]);
}

/** 真正打开完整设置页面，勾选、保存并重新打开检查三个模型。 */
async function testPage() {
  const fixture = fs.readFileSync(path.join(root, 'scripts/test-ui-performance.cjs'), 'utf8').split('\r\n').join('\n');
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  const s = { ...settings(), theme: 'dark', resolvedTheme: 'dark', autoSave: true, onboardingCompleted: true,
    workspace: output, recents: [], localFiles: [], videoProviderModels: [], retained: {} };
  const setup = '(' + extract(fixture, 'function fullPageSetup()') + ')();\n' +
    'window.poolSaved=null;localStorage.setItem("spcode.onboarding.completed","true");\n' +
    'simple.getState=async function(){return ' + JSON.stringify(s) + ';};\n' +
    'simple.saveCapabilityDefaults=async function(value){window.poolSaved=value;return value;};\n' +
    // 打开设置时会异步读取当前项目的忽略目录；隔离项目没有配置目录。
    'simple.indexGetIgnoredFolders=async function ignoredFolders(){return [];};\n' +
    'simple.getProviderQuota=async function(){return {};};simple.fetchAccountBalance=async function(){return {available:false};};simple.indexStatus=async function(){return {running:false,files:0};};simple.saveSearchSites=async function(v){return v;};simple.saveProxy=async function(v){return v;};simple.saveCommandSandbox=async function(v){return v;};simple.saveLocalImageGeneration=async function(v){return v;};simple.saveMaxAgentRounds=async function(v){return v;};simple.setTheme=async function(){return {theme:"dark",resolvedTheme:"dark"};};window.alert=function(v){fullPageRecord.errors.push({alert:v});};\n';
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: setup });
  await win.loadFile(path.join(root, 'renderer/index.html'));
  await win.webContents.executeJavaScript('new Promise(function(resolve){setTimeout(resolve,500);})');
  const result = await win.webContents.executeJavaScript('(async function(){document.querySelector("[data-act=settings]").click();await new Promise(function(r){setTimeout(r,100);});const box=document.querySelector("[data-model-pool=code]");if(!box)return {errors:fullPageRecord.errors,missing:true};const items=[...box.querySelectorAll("input[data-pool-model]")];items.forEach(function(e){e.checked=true;e.dispatchEvent(new Event("change",{bubbles:true}));});document.getElementById("m-ok").click();for(let i=0;i<100;i++){if(document.getElementById("modal").classList.contains("hidden"))break;await new Promise(function(r){setTimeout(r,20);});}if(!document.getElementById("modal").classList.contains("hidden"))throw new Error("保存后的弹窗尚未关闭");document.querySelector("[data-act=settings]").click();await new Promise(function(r){setTimeout(r,300);});return {modalClass:document.getElementById("modal").className,modalOpacity:getComputedStyle(document.getElementById("modal")).opacity,modalDisplay:getComputedStyle(document.getElementById("modal")).display,saved:poolSaved,checked:[...document.querySelectorAll("input[data-pool-model]:checked")].map(function(e){return e.value;}),errors:fullPageRecord.errors,hasLegacy:!!document.querySelector("select[data-cap-role=code]")};})()');
  fs.writeFileSync(path.join(output, 'page-result.json'), JSON.stringify(result, null, 2));
  check(!result.missing && result.saved?.code.models.length === 3, '真实设置页同时选择并保存三个代码模型');
  check(result.checked.length === 3 && !result.hasLegacy, '重新打开保留全部勾选且没有主备下拉框');
  check(result.errors.length === 0, '完整设置页面没有脚本异常');
  const geometry = await win.webContents.executeJavaScript('(function(){const pool=document.querySelector("[data-model-pool=code]");pool.scrollIntoView({block:"center"});return [...pool.querySelectorAll("input[data-pool-model]")].map(function(input){const b=input.getBoundingClientRect(),l=input.closest("label").getBoundingClientRect();return {width:b.width,height:b.height,left:b.left,right:b.right,labelRight:l.right,labelHeight:l.height};});})()');
  check(geometry.length === 3 && geometry.every(function fits(g) { return g.width > 0 && g.width < g.labelHeight * 2 && g.right <= g.labelRight; }), '真实页面复选框尺寸正常且位于候选标签内');
  // 隐藏窗口的合成帧可能停在弹窗打开前；非激活显示测试窗口后再截实际画面。
  win.showInactive();
  const visible = await win.webContents.executeJavaScript('(async function(){for(let i=0;i<100;i++){const m=document.getElementById("modal");if(!m.classList.contains("hidden")&&Number(getComputedStyle(m).opacity)>0.99)return true;await new Promise(function(r){setTimeout(r,20);});}return false;})()');
  check(visible, '设置弹窗完成真实显示动画后采集画面');
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(output, 'settings.png'), image.toPNG());
  win.destroy();
}
async function main() {
  await app.whenReady();
  const routing = await testRouting();
  await testPage();
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, routing }, null, 2));
  console.log(JSON.stringify({ checks, output }));
  app.exit(0);
}
main().catch(function failed(error) { console.error(error.stack || error); app.exit(1); });
