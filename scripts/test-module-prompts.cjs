/**
 * 在独立 Electron 进程捕获真实模块调度发出的请求，不访问厂商、不修改用户配置或项目文件。
 * 验证普通派单、直通转发、总结验收、预览和本轮技能/规则隔离。
 */
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.join(__dirname, '..');
const agentFile = path.join(root, 'electron/lib/agent.js');
const localRequire = createRequire(agentFile);
const { buildModulePrompt } = localRequire('./module-prompts');
const lang = localRequire('./reply-lang').fromLocale('zh');
const moduleContext = {
  rules: [{ name: '测试规则', body: 'RULE_SENTINEL：只修改任务点名的文件。' }],
  skill: { name: '测试技能', body: 'SKILL_SENTINEL：读取指定区段并核对结果。' },
  persona: 'PERSONA_MUST_NOT_LEAK',
  workingMemory: { goal: 'MEMORY_MUST_NOT_LEAK' }
};
const requests = [];
const directRequests = [];
let brainCalls = 0;
const task = '文件：src/fixture.js；方法：value；行号：1-3；目标：按给定原文完成局部修改；现状原文：return 1；目标原文：return 2；范围：只改该方法，保留其他行为；验证：核对目标方法返回指定值；禁止修改其他文件。此处仅验证模块请求，模拟模型不执行编辑。';

/** 模拟模型返回，保留实际发送器交出的消息快照。 */
async function complete(opts) {
  requests.push({ model: opts.modelCfg.model, messages: JSON.parse(JSON.stringify(opts.messages)) });
  if (opts.modelCfg.model === 'brain-test') {
    brainCalls++;
    if (brainCalls <= 2) return {
      role: 'assistant', content: '',
      tool_calls: [{ id: 'call-' + brainCalls, type: 'function', function: {
        name: 'call_worker', arguments: JSON.stringify({ role: brainCalls === 1 ? 'planning' : 'code', task })
      } }]
    };
  }
  return { role: 'assistant', content: '已完成：测试仅核对请求，不改文件。\n方案验收：通过' };
}

/** 捕获传给直通 SDK 的系统正文，不建立外部会话。 */
async function directRun(opts) { directRequests.push(opts); return { content: '已完成：测试仅核对请求，不改文件。' }; }
function noop() {}
function textOf(value) { return typeof value === 'string' ? value : JSON.stringify(value); }
function normalizeProtocol(value) { return value; }
function settings() { return { desktopAlive: false, locale: 'zh', maxAgentRounds: 4, models: [], providers: [] }; }
function summaryCfg() { return { protocol: 'openai', model: 'summary-test', baseUrl: 'http://unused' }; }
function notUnity() { return false; }

/** 仅替换模型传输和外部状态，执行真实 agentLoop、workerDirect 与总结入口。 */
function dependency(name) {
  if (name === './api-protocol') return { normalizeProtocol, complete };
  if (name === './cursor-direct' || name === './codex-direct') return { runTurn: directRun, closeSession: noop, textOf };
  if (name === './store') return { ...localRequire(name), load: settings };
  if (name === './diag') return { log: noop };
  if (name === './context-compact') return { ...localRequire(name), pickSummaryCfg: summaryCfg };
  if (name === './typecheck') return { ...localRequire(name), isUnity: notUnity };
  return localRequire(name);
}

/** 所有内部模块必须有当前技能/规则，且不能带大脑人设、工作记忆或沟通提示。 */
function assertInternal(text) {
  assert.ok(text.includes('RULE_SENTINEL'));
  assert.ok(text.includes('SKILL_SENTINEL'));
  assert.ok(text.includes('内部模块职责边界'));
  assert.ok(text.includes('大脑负责理解用户需求'));
  assert.ok(text.includes('本模块以准确完成派单和核对事实为目标'));
  assert.ok(text.includes('结果只交给大脑'));
  for (const marker of ['PERSONA_MUST_NOT_LEAK', 'MEMORY_MUST_NOT_LEAK', '## 工作记忆', '## 人设（必须始终遵守）', '回答与汇报口径（强制）']) assert.ok(!text.includes(marker), marker);
}

/** 验证真实调度、直通系统转发及总结两种调用方式。 */
async function main() {
  await app.whenReady();
  const context = { require: dependency, module: { exports: {} }, exports: {}, __dirname: path.dirname(agentFile),
    process, console, Buffer, URL, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval };
  const source = fs.readFileSync(agentFile, 'utf8');
  vm.runInNewContext(source + '\nmodule.exports.testEntries = { agentLoop, workerDirect, summarizeImplementation };', context, { filename: agentFile });
  const agent = context.module.exports;
  const snap = { current: null, readOnly: false, modulePromptContext: moduleContext };
  const brainSystem = agent.buildSystemPrompt({ workspace: '', rules: moduleContext.rules, skill: moduleContext.skill,
    persona: 'PERSONA_MUST_NOT_LEAK', workingMemory: { goal: 'MEMORY_MUST_NOT_LEAK' }, allSkills: [], extra: [], lang });
  assert.ok(brainSystem.includes('PERSONA_MUST_NOT_LEAK'));
  assert.ok(!brainSystem.includes('MEMORY_MUST_NOT_LEAK'));
  await agent.testEntries.agentLoop({ modelCfg: { protocol: 'openai', model: 'brain-test', baseUrl: 'http://unused' },
    messages: [{ role: 'system', content: brainSystem }, { role: 'user', content: '/spcode-start' }],
    workspace: '', extra: [], snap, onEvent: noop, lang, workers: {
      planning: { protocol: 'openai', model: 'planning-test', baseUrl: 'http://unused' },
      code: { protocol: 'openai', model: 'code-test', baseUrl: 'http://unused' }
    }, roleTag: 'brain', startOrdered: true, userOrder: '/spcode-start', hardRounds: 6 });
  for (const model of ['planning-test', 'code-test']) {
    const request = requests.find(function match(item) { return item.model === model; });
    assert.ok(request, model + ' 未被实际调用');
    assertInternal(request.messages[0].content);
    assert.ok(request.messages[1].content.includes('src/fixture.js'));
  }
  console.log('PASS real ordinary planning/code dispatch receives isolated prompts and task');
  for (const protocol of ['cursor', 'codex']) {
    await agent.testEntries.workerDirect({ modelCfg: { protocol, model: 'direct-test' },
      messages: [{ role: 'system', content: buildModulePrompt('code', moduleContext) }, { role: 'user', content: task }],
      toolSpec: [], workspace: '', extra: [], snap, onEvent: noop, lang, roleTag: 'code', labels: {} });
    const request = directRequests[directRequests.length - 1];
    assertInternal(request.firstPrefix);
    assert.ok(request.turnText.includes('src/fixture.js'));
  }
  console.log('PASS Cursor/Codex worker forwarding preserves only module system and task');
  for (const agiReport of [false, true]) {
    await agent.testEntries.summarizeImplementation({ vs: settings(), modelCfg: summaryCfg(), userText: '核对测试目标',
      assistantText: '', workspace: '', snap, changes: [], onEvent: noop, messages: [], agiReport });
  }
  const summaries = requests.filter(function match(item) { return item.model === 'summary-test'; });
  assert.equal(summaries.length, 2);
  for (const request of summaries) assertInternal(request.messages[0].content);
  console.log('PASS real summary verification and action-report requests remain neutral');
  const preview = require('../electron/lib/prompt-preview').build({ appRoot: root, workspace: root,
    modelCfg: { protocol: 'openai', model: 'preview-test' }, skillIds: [], history: [], userText: '核对预览',
    workingMemory: { goal: 'MEMORY_MUST_NOT_LEAK' } });
  assert.ok(!preview.system.includes('MEMORY_MUST_NOT_LEAK'));
  for (const role of ['code', 'summary', 'planning']) {
    assert.equal(preview.modules[role], buildModulePrompt(role, { rules: preview.editable.rules, skill: preview.editable.skill }));
  }
  assert.notEqual(preview.modules.code, preview.modules.summary);
  assert.notEqual(preview.modules.summary, preview.modules.planning);
  console.log('PASS role preview uses actual module builder and excludes working memory');
  await testPreviewDom(preview);
  console.log('RESULT {"failures":0}');
  app.exit(0);
}

/** 在真实 Chromium DOM 中执行预览入口，核对四种角色区域与仅大脑人设标签。 */
async function testPreviewDom(preview) {
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  const start = source.indexOf('async function openPromptPreview()');
  const end = source.indexOf('\nfunction patchLiveUsage(', start);
  assert.ok(start >= 0 && end > start);
  const win = new BrowserWindow({ show: false });
  try {
    await win.loadURL('data:text/html,<input id="input"><div id="modal-card"></div>');
    const script = `(async function(){
      const data=${JSON.stringify(preview)};
      const tab={messages:[],workspace:'test',modelId:'test'};
      const state={contextPaths:[],attachments:[]};
      function $(id){return document.getElementById(id);}
      function activeSession(){return tab;}
      function skillStack(){return [];}
      function extraFoldersOf(){return [];}
      function t(key){return key;}
      function escapeHtml(value){const box=document.createElement('div');box.textContent=String(value);return box.innerHTML;}
      function openModal(html){$('modal-card').innerHTML=html;}
      function closeModal(){}
      function send(){}
      const api={async promptPreview(){return data;}};
      ${source.substring(start, end)}
      await openPromptPreview();
      return {titles:Array.from(document.querySelectorAll('details summary'),function(el){return el.textContent;}),text:$('modal-card').textContent};
    })()`;
    const result = await win.webContents.executeJavaScript(script);
    for (const role of ['大脑', '实现模块', '总结模块', '规划模块']) {
      assert.ok(result.titles.some(function match(title) { return title.includes(role); }), role);
    }
    assert.ok(result.text.includes('（仅大脑）'));
    console.log('PASS real Chromium prompt preview renders separate role sections');
  } finally {
    win.destroy();
  }
}

/** 测试错误必须产生非零退出码，不能把脚本运行成功当验收通过。 */
function failed(error) { console.error(error.stack || error); app.exit(1); }
main().catch(failed);
