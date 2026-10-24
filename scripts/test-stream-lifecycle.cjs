/**
 * 使用真实 Electron 网络栈验证流锁与取消行为，仅访问本机临时端口。
 * 运行方式：由 Electron 启动本脚本；独立测试进程退出，不影响正在运行的主程序。
 */
const { app, net } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { httpFetch } = require('../electron/lib/http-fetch');
const unexpected = [];

/** 记录异步取消冒出的未处理异常，使底层错误参与验收。 */
function recordUnexpected(error) {
  unexpected.push(error);
  console.error('UNHANDLED', error.stack || error);
}
process.on('unhandledRejection', recordUnexpected);
process.on('uncaughtException', recordUnexpected);

/** 本地响应先发送一个 SSE 数据块，稍后结束，覆盖响应头后的取消窗口。 */
function serveStream(request, response) {
  response.writeHead(200, { 'Content-Type': 'text/event-stream' });
  response.flushHeaders();
  if (!request.url.includes('/silent')) {
    let payload = { choices: [{ delta: { content: '测试' } }] };
    if (request.url.includes('/messages')) payload = { type: 'content_block_delta', delta: { type: 'text_delta', text: '测试' } };
    if (request.url.includes(':streamGenerateContent')) payload = { candidates: [{ content: { parts: [{ text: '测试' }] } }] };
    response.write('data: ' + JSON.stringify(payload) + '\n\n');
  }
  const timer = setTimeout(finishResponse, 200);
  function finishResponse() { response.end('data: [DONE]\n\n'); }
  function clearResponseTimer() { clearTimeout(timer); }
  response.on('close', clearResponseTimer);
}

/** 提取实际的流读取实现，避免测试加载账户、模型 SDK 等无关依赖。 */
function loadReader() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/lib/api-protocol.js'), 'utf8');
  const start = source.indexOf('function emitSseLine(');
  const end = source.indexOf('async function completeOpenAI(');
  assert.ok(start >= 0 && end > start);
  const context = { TextDecoder, Error, Object, console };
  vm.runInNewContext(source.substring(start, end) + '\nthis.readStream = readSseStream;', context);
  return context.readStream;
}

/** 取消前先持有 reader，检查 Electron 本身是否在取消时错误调用锁定 body。 */
async function testNativeAbort(url) {
  const ctl = new AbortController();
  const response = await net.fetch(url, { signal: ctl.signal });
  const reader = response.body.getReader();
  await reader.read();
  const pending = reader.read();
  ctl.abort();
  await assert.rejects(pending);
  reader.releaseLock();
  console.log('PASS native abort with locked reader');
}

/** 检查统一 HTTP 返回响应头后，取消是否仍能中断正在读取的数据流。 */
async function testDirectAbort(url) {
  const ctl = new AbortController();
  const response = await httpFetch(url, { signal: ctl.signal });
  const reader = response.body.getReader();
  await reader.read();
  const pending = reader.read();
  ctl.abort();
  try {
    await assert.rejects(pending);
  } finally {
    reader.releaseLock();
  }
  console.log('PASS direct abort after headers');
}

/** 验证正常读取、回调异常和预先锁定的响应都能遵守 reader 所有权。 */
async function testReader(url) {
  const readStream = loadReader();
  const response = await httpFetch(url);
  let events = 0;
  function onEvent() { events++; }
  await readStream(response, { onEvent });
  assert.equal(events, 1);
  assert.equal(response.body.locked, false);
  const failed = await httpFetch(url);
  const marker = new Error('回调异常');
  function throwEvent() { throw marker; }
  await assert.rejects(readStream(failed, { onEvent: throwEvent }), isMarker);
  function isMarker(error) { return error === marker; }
  assert.equal(failed.body.locked, false);
  const locked = await net.fetch(url);
  const owner = locked.body.getReader();
  await assert.rejects(readStream(locked, { onEvent }), isLockedError);
  function isLockedError(error) { return error.code === 'stream_locked'; }
  await owner.cancel();
  owner.releaseLock();
  console.log('PASS normal read, callback failure, locked response');
}

/** 验证锁定响应和原生锁异常的有界重试，以及取消和普通错误不被重试。 */
async function testLockedGuard() {
  const source = fs.readFileSync(path.join(__dirname, '../electron/lib/http-fetch.js'), 'utf8');
  const context = { module: { exports: {} } };
  vm.runInNewContext(source + '\nmodule.exports.guard = fetchWithLockedGuard;', context);
  const guard = context.module.exports.guard;
  let calls = 0;
  let cancels = 0;
  const healthy = { body: { locked: false } };
  function forbiddenCancel() { cancels++; throw new Error('不得取消其他 reader 的流'); }
  async function lockedOnce() {
    calls++;
    if (calls === 1) return { body: { locked: true, cancel: forbiddenCancel } };
    return healthy;
  }
  assert.equal(await guard(lockedOnce, 'local'), healthy);
  assert.equal(calls, 2);
  assert.equal(cancels, 0);
  calls = 0;
  async function throwsOnce() {
    calls++;
    if (calls === 1) throw new TypeError('Invalid state: ReadableStream is locked');
    return healthy;
  }
  assert.equal(await guard(throwsOnce, 'local'), healthy);
  assert.equal(calls, 2);
  calls = 0;
  async function alwaysLocked() { calls++; throw new TypeError('Invalid state: ReadableStream is locked'); }
  function isLocked(error) { return error.code === 'stream_locked' && error.retryable; }
  await assert.rejects(guard(alwaysLocked, 'local'), isLocked);
  assert.equal(calls, 3);
  calls = 0;
  const ctl = new AbortController();
  ctl.abort();
  function nativeLocked(error) { return error instanceof TypeError; }
  await assert.rejects(guard(alwaysLocked, 'local', { signal: ctl.signal }), nativeLocked);
  assert.equal(calls, 1);
  const marker = new Error('普通网络异常');
  async function ordinaryFailure() { throw marker; }
  function isMarker(error) { return error === marker; }
  await assert.rejects(guard(ordinaryFailure, 'local'), isMarker);
  console.log('PASS locked retry, retry limit, owner preservation, abort and ordinary errors');
}

/** 加载完整协议实现，仅替换无关 SDK 和记账；超时场景缩短计时，不改产品阈值。 */
function loadProtocol(shortTimeout) {
  const source = fs.readFileSync(path.join(__dirname, '../electron/lib/api-protocol.js'), 'utf8');
  function loadDependency(name) {
    if (name === './http-fetch') return { httpFetch };
    if (name === './wallet') return { parseTokenUsage };
    if (name === './tool-xml') return { looksLikeXmlTool, parseXmlToolCalls };
    if (name === './cursor-model' || name === './codex-model') return {};
    throw new Error('测试不应加载依赖：' + name);
  }
  function parseTokenUsage() { return null; }
  function looksLikeXmlTool() { return false; }
  function parseXmlToolCalls() { return []; }
  function schedule(callback, delay) {
    return setTimeout(callback, shortTimeout && delay === 3 * 60 * 1000 ? 30 : delay);
  }
  const context = {
    module: { exports: {} }, require: loadDependency, TextDecoder, AbortController,
    setTimeout: schedule, clearTimeout, setInterval, clearInterval, URL, console
  };
  vm.runInNewContext(source, context);
  return context.module.exports;
}

/** 三种远程协议分别核对正常输出、停止、内部无响应超时及停止后的新请求。 */
async function testProtocols(url) {
  for (const protocol of ['openai', 'anthropic', 'gemini']) {
    const api = loadProtocol(false);
    const modelCfg = { protocol, baseUrl: url, model: 'test', apiKey: 'local-test' };
    const messages = [{ role: 'user', content: '测试' }];
    const result = await api.complete({ modelCfg, messages });
    assert.equal(result.content, '测试');
    const ctl = new AbortController();
    function stop() { ctl.abort(); }
    function isStopped(error) { return error.code === 'aborted'; }
    await assert.rejects(api.complete({ modelCfg, messages, signal: ctl.signal, onDelta: stop }), isStopped);
    const shortApi = loadProtocol(true);
    const silentCfg = { ...modelCfg, baseUrl: url + '/silent' };
    function isTimeout(error) { return error.code === 'no_response'; }
    await assert.rejects(shortApi.complete({ modelCfg: silentCfg, messages }), isTimeout);
    const next = await api.complete({ modelCfg, messages });
    assert.equal(next.content, '测试');
    console.log('PASS', protocol, 'normal, stop, internal timeout, next request');
  }
}

/** 顺序执行各场景并汇总失败，始终关闭本地服务和测试进程。 */
async function main() {
  await app.whenReady();
  const server = http.createServer(serveStream);
  await new Promise(listen);
  function listen(resolve) { server.listen(0, '127.0.0.1', resolve); }
  const url = 'http://127.0.0.1:' + server.address().port;
  let failures = 0;
  for (const test of [testNativeAbort, testDirectAbort, testReader, testLockedGuard, testProtocols]) {
    try { await test(url); }
    catch (error) { failures++; console.error('FAIL', test.name, error.stack || error); }
  }
  await new Promise(settle);
  function settle(resolve) { setTimeout(resolve, 50); }
  server.closeAllConnections();
  server.close();
  console.log('RESULT', JSON.stringify({ failures, unhandled: unexpected.length }));
  app.exit(failures || unexpected.length ? 1 : 0);
}
main().catch(fatal);
function fatal(error) { console.error(error.stack || error); app.exit(1); }
