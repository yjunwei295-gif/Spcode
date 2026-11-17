/**
 * 验证 MXAPI 各厂商入口的模型目录，以及无效凭据和其他厂商的原有行为。
 * 运行真实协议与目录代码，仅替换 HTTP 和无关 SDK；不读取用户配置、不发送付费请求。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const calls = [];
let denied = false;
let checked = 0;

/** 模拟无模型接口的厂商；只有余额接口成功，任何 MXAPI /models 请求都返回 404。 */
async function fakeFetch(url, options) {
  calls.push({ url, options });
  let status = 404;
  let data = { message: '模型列表接口不存在' };
  if (url === 'https://open.mxapi.org/api/v2/points/balance') {
    status = denied ? 401 : 200;
    data = denied ? { code: 401, message: 'fixture-invalid-key' } : { code: 200, data: { remaining_points: 100 } };
  }
  if (url === 'https://example.test/v1/models') {
    status = 200;
    data = { data: [{ id: 'normal-chat' }] };
  }
  return { ok: status === 200, status, json: async function json() { return data; }, text: async function text() { return JSON.stringify(data); } };
}

/** 加载完整生产模块；替身只隔离外部依赖，不复制待验证的方法。 */
function load(relative, replacements) {
  const file = path.join(root, relative);
  const original = require('node:module').createRequire(file);
  const module = { exports: {} };
  function dependency(name) { return Object.hasOwn(replacements, name) ? replacements[name] : original(name); }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), {
    module, exports: module.exports, require: dependency, __dirname: path.dirname(file),
    Buffer, URL, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout, console
  }, { filename: file });
  return module.exports;
}
const mxapi = load('electron/lib/mxapi.js', { './http-fetch': { httpFetch: fakeFetch } });
const protocol = load('electron/lib/api-protocol.js', {
  './mxapi': mxapi, './http-fetch': { httpFetch: fakeFetch }, './wallet': {}, './tool-xml': {},
  './cursor-model': {}, './codex-model': {}, './claude-model': {}, './grok-model': {}
});

/** 检查目录内容与请求边界：只验证一次凭据，不请求 /models，不自动保存或选中模型。 */
async function checkCatalog(basePath, expectedCount, requiredModels) {
  calls.length = 0;
  const result = await protocol.listModels({ baseUrl: 'https://open.mxapi.org' + basePath, protocol: 'openai', apiKey: 'fixture-only-key' });
  assert.equal(result.ok, true);
  assert.equal(result.models.length, expectedCount);
  assert.equal(new Set(result.models).size, expectedCount);
  for (const model of requiredModels) {
    assert.ok(result.models.includes(model), model);
    assert.equal(result.catalog[model].id, model);
    assert.ok(result.catalog[model].name);
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://open.mxapi.org/api/v2/points/balance');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture-only-key');
  assert.ok(!JSON.stringify(result).includes('fixture-only-key'));
  checked++;
  console.log('PASS directory ' + basePath + ' (' + expectedCount + ')');
}

/** 从真实 listModels 入口覆盖三个模板、尾斜杠、认证失败和普通厂商。 */
async function main() {
  for (const basePath of ['/v1', '/v1/']) {
    await checkCatalog(basePath, 10, ['nano-banana', 'nano-banana-pro', 'nano-banana-2.1', 'gpt-image-2', 'gpt-image-2.6-flare']);
  }
  for (const basePath of ['/api/v2/nano', '/api/v2/nano/']) {
    await checkCatalog(basePath, 1, ['nano-banana']);
  }
  for (const basePath of ['', '/', '/api/v2', '/api/v2/']) {
    await checkCatalog(basePath, 6, ['doubao-seedance-1-0-pro-fast-251015', 'veo-3.1-fast', 'omni-flash']);
  }
  denied = true;
  calls.length = 0;
  await assert.rejects(protocol.listModels({ baseUrl: 'https://open.mxapi.org/v1', apiKey: 'fixture-invalid-key' }), /401.*fixture-invalid-key/);
  assert.equal(calls.length, 1);
  checked++;
  console.log('PASS invalid credentials fail without a fallback catalog');
  denied = false;
  calls.length = 0;
  const normal = await protocol.listModels({ baseUrl: 'https://example.test/v1', protocol: 'openai', apiKey: 'fixture-only-key' });
  assert.equal(normal.models.join(','), 'normal-chat');
  assert.equal(calls.filter(function modelRequest(call) { return call.url === 'https://example.test/v1/models'; }).length, 1);
  assert.ok(calls.every(function originalHost(call) { return new URL(call.url).hostname === 'example.test'; }));
  checked++;
  console.log('PASS other providers retain their remote model endpoint');
  assert.equal(mxapi.isMxApi({ baseUrl: 'https://open.mxapi.org.example.test/v1' }), false);
  calls.length = 0;
  await assert.rejects(protocol.listModels({ baseUrl: 'https://open.mxapi.org/unsupported' }), /MXAPI.*入口/);
  assert.equal(calls.length, 0);
  checked++;
  console.log('PASS unsupported paths are explicit and lookalike hosts are not MXAPI');
  console.log('RESULT ' + JSON.stringify({ checks: checked, paidRequests: 0 }));
}
main().catch(function failed(error) { console.error(error.stack); process.exitCode = 1; });
