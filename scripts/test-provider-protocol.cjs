/** 回归直通配置退化：隔离设置读写，并替换 SDK/HTTP 出口，保证测试不消耗模型额度。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-protocol-'));
const root = path.resolve(__dirname, '..');
const { normalizeProtocol } = require('../electron/lib/provider-protocol');

/** 执行真实模块，只替换外部环境和模型传输，不替换被测路由逻辑。 */
function loadModule(name, mocks) {
  const filename = path.join(root, 'electron/lib', name);
  const nativeRequire = createRequire(filename);
  const context = { module: { exports: {} }, __dirname: path.dirname(filename),
    require: key => Object.hasOwn(mocks, key) ? mocks[key] : nativeRequire(key),
    process, console, Buffer, URL, AbortController, AbortSignal, structuredClone,
    setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return context.module.exports;
}

async function main() {
  const store = loadModule('store.js', {
    electron: { app: { getPath: () => temp, isPackaged: false }, nativeTheme: {} },
    './assembly': { migrateAssemblies: s => s }
  });
  const providers = ['codex', 'cursor', 'claudecode', 'grok'].map(id => ({
    id, name: id, protocol: 'openai', baseUrl: `${id}://sdk`, apiKey: 'fixture-key'
  }));
  const settings = { providers, models: providers.map(p => ({ id: p.id, providerId: p.id,
    model: 'fixture-model', type: 'api' })), currentModelId: 'codex', locale: 'zh' };
  fs.writeFileSync(path.join(temp, 'settings.json'), JSON.stringify(settings));
  const loaded = store.load();
  for (const p of providers) {
    assert.equal(loaded.providers.find(x => x.id === p.id).protocol, p.id);
    assert.equal(store.resolveModelCfg(p.id, settings).protocol, p.id);
    assert.equal(store.resolveModelCfg({ model: 'inline', baseUrl: p.baseUrl, protocol: 'openai' }).protocol, p.id);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(temp, 'settings.json'))).providers[0].protocol, 'codex');
  store.save(settings); // 模拟尚未重启的旧窗口提交错误协议。
  const saved = JSON.parse(fs.readFileSync(path.join(temp, 'settings.json')));
  assert.equal(saved.providers[0].protocol, 'codex');
  assert.equal(saved.providers[0].apiKey, 'fixture-key');
  assert.equal(saved.models[0].providerId, 'codex');
  assert.equal(normalizeProtocol('anthropic', 'https://example.test'), 'anthropic');
  assert.equal(normalizeProtocol('openai', 'https://codex.example.test'), 'openai');
  assert.equal(normalizeProtocol('', ' CODEX://sdk '), 'codex');
  assert.equal(normalizeProtocol('google'), 'gemini');
  console.log('PASS config migration, stale save, inline model and HTTP compatibility');

  const calls = [];
  const mocks = { './http-fetch': { httpFetch: async () => { throw Error('Unexpected HTTP call'); } } };
  for (const [protocol, file] of [['codex','codex'], ['cursor','cursor'], ['claudecode','claude'], ['grok','grok']]) {
    mocks[`./${file}-model`] = { complete: async () => {
      calls.push(protocol);
      return { role: 'assistant', content: 'ok' };
    } };
  }
  const api = loadModule('api-protocol.js', mocks);
  for (const p of providers) {
    const result = await api.complete({ modelCfg: { ...p, model: 'fixture' }, messages: [], stream: false });
    assert.equal(result.content, 'ok');
    assert.equal(calls.at(-1), p.id);
  }
  assert.equal(calls.length, providers.length);
  const { httpFetch } = require('../electron/lib/http-fetch');
  await assert.rejects(httpFetch('codex://sdk/chat/completions'), e =>
    e.code === 'unsupported_url_scheme' && e.retryable === false && !e.message.includes('/chat/completions'));
  console.log('PASS all direct adapters bypass HTTP; invalid schemes fail before networking');
}
main().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => {
  fs.rmSync(temp, { recursive: true, force: true });
});
