/**
 * 回归余额查询、多窗口模型保存与提示词摘要、对话索引移除。
 * 在独立 Electron 进程运行；本地场景不修改用户配置，--live-kimi 才用已配置凭据做真实厂商验收。
 */
const { app, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const { mergeCatalogEdits } = require('../electron/lib/model-catalog');
const { httpFetch } = require('../electron/lib/http-fetch');
const root = path.join(__dirname, '..');
const unexpected = [];

/** 让异步未处理错误参与最终失败计数。 */
function unexpectedError(error) { unexpected.push(error); console.error(error.stack || error); }
process.on('unhandledRejection', unexpectedError);
process.on('uncaughtException', unexpectedError);

/** 加载真实协议代码，仅替换与余额和 SSE 无关的 SDK。 */
function loadProtocol(fetcher) {
  function dependency(name) {
    if (name === './http-fetch') return { httpFetch: fetcher };
    if (name === './wallet') return { parseTokenUsage };
    if (name === './tool-xml') return { looksLikeXmlTool, parseXmlToolCalls };
    if (name === './cursor-model' || name === './codex-model') return {};
    throw new Error('未声明的依赖：' + name);
  }
  function parseTokenUsage() { return null; }
  function looksLikeXmlTool() { return false; }
  function parseXmlToolCalls() { return []; }
  const context = { module: { exports: {} }, require: dependency, AbortSignal, AbortController, TextDecoder,
    setTimeout, clearTimeout, setInterval, clearInterval, URL, console };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/lib/api-protocol.js'), 'utf8'), context);
  return context.module.exports;
}

/** 模拟两个窗口编辑同一目录，核对未编辑项、明确删除项和同项编辑的语义。 */
function testCatalog() {
  const local = { id: 'local', model: 'local' };
  const original = { id: 'old', model: 'old' };
  const kimi = { id: 'kimi', model: 'kimi-k2.7-code' };
  const baseline = [local, original];
  const current = [local, original, kimi];
  assert.deepEqual(mergeCatalogEdits(current, baseline, baseline), current);
  assert.deepEqual(mergeCatalogEdits(current, baseline, [local]), [local, kimi]);
  assert.deepEqual(mergeCatalogEdits([local, kimi], baseline, baseline), [local, kimi]);
  const edited = { ...original, name: '用户新名称' };
  assert.deepEqual(mergeCatalogEdits(current, baseline, [local, edited]), [local, edited, kimi]);
  const oldProvider = { id: 'provider', apiKey: 'old-test-key' };
  const newProvider = { id: 'provider', apiKey: 'new-test-key' };
  assert.deepEqual(mergeCatalogEdits([newProvider], [oldProvider], [oldProvider]), [newProvider]);
  assert.deepEqual(current, [local, original, kimi]);
  console.log('PASS multi-window add, explicit delete, no resurrection, edit, credential preservation');
}

/** 从真实主进程源码注册状态和保存 IPC，以两个 sender 验证接线及模型解析。 */
async function testModelHandlers() {
  const source = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  let settings = { models: [{ id: 'old', model: 'old', type: 'api', providerId: 'p' }],
    providers: [{ id: 'p', baseUrl: 'https://example.invalid/v1' }], currentModelId: 'old' };
  const handlers = {};
  const snapshots = new WeakMap();
  function handle(name, fn) { handlers[name] = fn; }
  function load() { return structuredClone(settings); }
  function save(s) { settings = structuredClone(s); }
  function identity(item) { return item; }
  function migrate(data) { return data; }
  function noOp() {}
  const context = { ipcMain: { handle }, modelCatalogBySender: snapshots, structuredClone,
    store: { load, save, normalizeProvider: identity, migrateProvidersAndModels: migrate },
    settingsWithTheme: load, modelsDirOf: noOp, getWin: identity, workspaceByWin: new WeakMap(),
    APP_ROOT: root, listLocalFilesEnriched: noOp, assembly: { assemblyKey: noOp },
    syncCursorDirect: noOp, mergeCatalogEdits };
  const stateStart = source.indexOf("ipcMain.handle('app:state'");
  const stateEnd = source.indexOf("ipcMain.handle('app:theme'", stateStart);
  const saveStart = source.indexOf("ipcMain.handle('models:save'");
  const saveEnd = source.indexOf("ipcMain.handle('providers:presets'", saveStart);
  assert.ok(stateStart >= 0 && stateEnd > stateStart && saveStart >= 0 && saveEnd > saveStart);
  vm.runInNewContext(source.substring(stateStart, stateEnd) + source.substring(saveStart, saveEnd), context);
  const a = { sender: {} };
  const b = { sender: {} };
  const first = await handlers['app:state'](a);
  const second = await handlers['app:state'](b);
  const kimi = { id: 'kimi', model: 'kimi-k2.7-code', type: 'api', providerId: 'p' };
  handlers['models:save'](a, { ...first, models: [...first.models, kimi], currentModelId: 'kimi' });
  const selected = handlers['models:save'](b, { ...second, currentModelId: 'old' });
  assert.ok(selected.models.some(isKimi));
  assert.ok(settings.models.some(isKimi));
  function isKimi(model) { return model.id === 'kimi'; }
  console.log('PASS real app:state / models:save handlers preserve Kimi across stale-window selection');
}

/** 按官方响应验证正数、零、负数、无接口和无效凭据，且不把密钥发往其他域。 */
async function testBalance() {
  let value = 49.58894;
  let mode = 'ok';
  let calls = [];
  async function fetchBalance(url, init) {
    calls.push(url);
    assert.equal(url, 'https://api.moonshot.cn/v1/users/me/balance');
    assert.equal(init.headers.Authorization, 'Bearer local-test-key');
    if (mode === 'denied') return { ok: false, status: 401 };
    if (mode === 'missing') return { ok: true, json: emptyData };
    return { ok: true, json: responseData };
  }
  function emptyData() { return {}; }
  function responseData() { return { code: 0, data: { available_balance: value, voucher_balance: 46.58893, cash_balance: 3.00001 } }; }
  const api = loadProtocol(fetchBalance);
  const cfg = { baseUrl: 'https://api.moonshot.cn/v1', protocol: 'openai', apiKey: 'local-test-key' };
  for (value of [49.58894, 0, -2.5]) {
    calls = [];
    const balance = await api.fetchAccountBalance(cfg);
    assert.equal(balance.available, true);
    assert.equal(balance.remaining, value);
    assert.equal(balance.currency, 'CNY');
    assert.equal(calls.length, 1);
  }
  for (mode of ['denied', 'missing']) {
    const balance = await api.fetchAccountBalance(cfg);
    assert.equal(balance.available, false);
  }
  console.log('PASS Kimi official endpoint, positive/zero/negative balances, denied and unavailable');
}

/** 调用实际提示词构建函数，断言摘要、对话索引与工作记忆均不再自动注入。 */
function testPrompt() {
  const source = fs.readFileSync(path.join(root, 'electron/lib/agent.js'), 'utf8');
  const start = source.indexOf('function buildSystemPrompt(');
  const end = source.indexOf('\nfunction ', start + 1);
  assert.ok(start >= 0 && end > start);
  const compact = require('../electron/lib/context-compact');
  const lang = require('../electron/lib/reply-lang');
  function empty() { return ''; }
  function off() { return false; }
  const context = { process, replyLang: lang, store: { load: empty }, compact,
    memoryGlobal: { formatProfile: empty, formatPrefs: empty }, desktopOn: off,
    userAskedQuestion: off, typecheck: { isUnity: off }, chainFormatRule: empty,
    toolRules: empty, toolsInstruction: empty, COMMENT_POLICY: '', logChainGatePrompt: empty, planPrompt: empty,
    houseStyle: { promptBlockIfNeeded: empty }, brainPressure: { promptBlock: empty } };
  vm.runInNewContext(source.substring(start, end) + '\nthis.build = buildSystemPrompt;', context);
  for (const locale of ['zh', 'en']) {
    const text = context.build({ lang: lang.fromLocale(locale), persona: '', rules: [], allSkills: [], extra: [],
      contextSummary: 'SUMMARY_SHOULD_NOT_LEAK', dialogIndex: '#R1 INDEX_SHOULD_NOT_LEAK',
      workingMemory: { goal: 'WORKING_MEMORY_RETAINED' } });
    assert.ok(!text.includes('SUMMARY_SHOULD_NOT_LEAK'));
    assert.ok(!text.includes('INDEX_SHOULD_NOT_LEAK'));
    assert.ok(!text.includes('## 更早对话摘要'));
    assert.ok(!text.includes('## 对话索引'));
    assert.ok(!text.includes('## Conversation index'));
    assert.ok(!text.includes('WORKING_MEMORY_RETAINED'));
  }
  const preview = require('../electron/lib/prompt-preview').build({
    appRoot: root, workspace: root, skillIds: [], userText: '测试提示词',
    modelCfg: { protocol: 'openai', model: 'prompt-test' },
    history: [
      { role: 'user', content: 'INDEX_SHOULD_NOT_LEAK', round: 1 },
      { role: 'assistant', content: '旧回复', round: 1 },
      { role: 'user', content: '最近一轮', round: 2 },
      { role: 'assistant', content: '最近回复', round: 2 }
    ],
    workingMemory: { goal: 'WORKING_MEMORY_RETAINED' }
  });
  assert.ok(!preview.system.includes('INDEX_SHOULD_NOT_LEAK'));
  assert.ok(!preview.system.includes('## 对话索引'));
  assert.ok(!preview.system.includes('## Conversation index'));
  assert.ok(!preview.system.includes('WORKING_MEMORY_RETAINED'));
  console.log('PASS actual system builder and preview remove summary/index/working memory');
}

/** 直连首次失败且代理不可用时只按既有路径重试直连；用户取消后不再切换网络。 */
async function testProxyRecovery() {
  const source = fs.readFileSync(path.join(root, 'electron/lib/http-fetch.js'), 'utf8');
  let directCalls = 0;
  let proxyCalls = 0;
  const good = { body: { locked: false } };
  async function directFetch() {
    directCalls++;
    if (directCalls === 1) throw new Error('net::ERR_CONNECTION_RESET');
    return good;
  }
  async function proxyFetch() { proxyCalls++; throw new Error('net::ERR_PROXY_CONNECTION_FAILED'); }
  function partition() { return { setProxy, fetch: directFetch }; }
  async function setProxy() {}
  function dependency(name) {
    assert.equal(name, 'electron');
    return { net: { fetch: proxyFetch }, session: { fromPartition: partition } };
  }
  const context = { module: { exports: {} }, require: dependency, AbortSignal, AbortController,
    setTimeout, clearTimeout };
  vm.runInNewContext(source, context);
  assert.equal(await context.module.exports.httpFetch('https://example.invalid'), good);
  assert.equal(directCalls, 2);
  assert.equal(proxyCalls, 1);
  console.log('PASS direct failure / proxy failure / direct recovery branch');
}

/** 系统代理不可用时，真实 Electron 请求仍能通过直连完成。 */
async function testBrokenProxy() {
  function serve(request, response) { response.end('DIRECT_OK'); }
  const server = http.createServer(serve);
  function listen(resolve) { server.listen(0, '127.0.0.1', resolve); }
  await new Promise(listen);
  try {
    await session.defaultSession.setProxy({ proxyRules: 'http://127.0.0.1:1', proxyBypassRules: '<-loopback>' });
    const response = await httpFetch('http://127.0.0.1:' + server.address().port);
    assert.equal(await response.text(), 'DIRECT_OK');
  } finally {
    server.closeAllConnections();
    server.close();
  }
  console.log('PASS real Electron direct request with unavailable system proxy');
}

/** 真实 Kimi 凭据仅用于其已配置域名；连续请求以及停止后新请求都使用同一模型。 */
async function testLiveKimi() {
  const settings = JSON.parse(fs.readFileSync(path.join(app.getPath('appData'), 'SimpleCode', 'settings.json'), 'utf8'));
  function isKimi(provider) { return /^https:\/\/api\.moonshot\.(cn|ai)(?:\/|$)/i.test(provider.baseUrl || ''); }
  const provider = settings.providers.find(isKimi);
  assert.ok(provider && provider.apiKey, '缺少已配置 Kimi 凭据');
  function sameProvider(model) { return model.providerId === provider.id; }
  const model = settings.models.find(sameProvider);
  assert.ok(model, '缺少已配置 Kimi 模型');
  const cfg = { ...provider, model: model.model };
  const api = loadProtocol(httpFetch);
  const balance = await api.fetchAccountBalance(cfg);
  assert.equal(balance.available, true);
  assert.ok(Number.isFinite(balance.remaining));
  console.log('PASS live Kimi account balance', balance.remaining, balance.currency);
  const messages = [{ role: 'user', content: '只回复 OK，不要调用工具。' }];
  for (let i = 0; i < 2; i++) {
    const result = await api.complete({ modelCfg: cfg, messages, signal: AbortSignal.timeout(30000) });
    assert.ok(result.content && result.content.trim());
    console.log('PASS live Kimi consecutive request', i + 1);
  }
  const ctl = new AbortController();
  function stop() { ctl.abort(); }
  function aborted(error) { return error.code === 'aborted'; }
  const stopMessages = [{ role: 'user', content: '从一写到一百，每个数字单独一行。' }];
  await assert.rejects(api.complete({ modelCfg: cfg, messages: stopMessages, signal: ctl.signal, onDelta: stop }), aborted);
  const next = await api.complete({ modelCfg: cfg, messages, signal: AbortSignal.timeout(30000) });
  assert.ok(next.content && next.content.trim());
  console.log('PASS live Kimi stop then resend without locked stream');
}

/** 汇总各场景并关闭独立测试进程，不重启或退出用户主程序。 */
async function main() {
  await app.whenReady();
  let failures = 0;
  const tests = [testCatalog, testModelHandlers, testBalance, testPrompt, testProxyRecovery, testBrokenProxy];
  if (process.argv.includes('--live-kimi')) tests.push(testLiveKimi);
  for (const test of tests) {
    try { await test(); }
    catch (error) { failures++; console.error('FAIL', test.name, error.stack || error); }
  }
  console.log('RESULT', JSON.stringify({ failures, unhandled: unexpected.length }));
  app.exit(failures || unexpected.length ? 1 : 0);
}
main().catch(unexpectedError);
