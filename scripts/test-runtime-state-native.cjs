/**
 * 用真实 WinForms 窗口、真实进程内存和生产 Agent 入口验收状态工具。
 * 测试进程隔离用户数据，窗口不激活；结果、采样日志与性能测量保存到 generated。
 */
'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const executeFile = promisify(execFile);
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'runtime-native-'));
app.setPath('userData', path.join(output, 'user-data'));
let checks = 0;
/** 统一关闭原生帮助进程和测试夹具，首条回包尚未到达时也可以由看门狗调用。 */
let stopNative;
const failures = [];
process.on('unhandledRejection', unhandled);
/** 异步错误必须令验收失败。 */
function unhandled(error) { failures.push(String(error.stack || error)); }
/** 记录真实断言，而非仅判断进程退出。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 在同份生产模块中增加测试可见性，不修改其实现或 mock Win32。 */
function loadDesktop() {
  const file = path.join(root, 'electron/lib/desktop-hand.js');
  const context = { require: createRequire(file), module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.nativeRequest = winInput;', context, { filename: file });
  return context.module.exports;
}
/** Agent 只替换桌面模块为上述生产实例；模型不会被调用。 */
function loadAgent(desktop) {
  const file = path.join(root, 'electron/lib/agent.js');
  const local = createRequire(file);
  function dependency(name) { if (name === './desktop-hand') return desktop; return local(name); }
  const context = { require: dependency, module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.executeRuntimeTest = execToolRaw;', context, { filename: file });
  return context.module.exports;
}
/** Fixture 只修改自己的文本框与内存，命令文件位于本次测试目录。 */
function fixture() {
  const commandPath = path.join(output, 'command.json');
  const child = spawn('powershell.exe', ['-NoProfile', '-Sta', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(__dirname, 'runtime-state-fixture.ps1'), '-CommandPath', commandPath],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let buffer = '';
  let stderr = '';
  const waiters = [];
  const messages = [];
  child.stderr.on('data', errorText);
  child.stdout.on('data', receive);
  child.on('error', failed);
  child.on('exit', exited);
  function errorText(chunk) { stderr += chunk; }
  function failed(error) { while (waiters.length) waiters.shift().reject(error); }
  function exited(code) { failed(new Error('Fixture exited ' + code + ': ' + stderr)); }
  /**
   * 按换行组装原生夹具的 JSON 回包，将未收齐的一行留到下一次读取。
   * @param {Buffer} chunk 本次标准输出数据块，可以包含零条或多条完整回包。
   * @returns {void} 向等待者交付回包或错误，尚无等待者时暂存完整回包。
   */
  function receive(chunk) {
    buffer += chunk.toString('utf8');
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim();
      buffer = buffer.slice(end + 1);
      if (!line) continue;
      let value;
      try { value = JSON.parse(line); }
      catch (error) { failed(new Error('Fixture 返回非 JSON：' + line)); return; }
      if (value.error) { failed(new Error(value.error)); continue; }
      if (waiters.length) waiters.shift().resolve(value);
      else messages.push(value);
    }
  }
  function next() {
    if (messages.length) return Promise.resolve(messages.shift());
    return new Promise(function wait(resolve, reject) { waiters.push({ resolve, reject }); });
  }
  async function command(value) { fs.writeFileSync(commandPath, JSON.stringify(value), 'utf8'); return next(); }
  return { child, ready: next(), command };
}
/** 通过 Agent 真正执行工具并检查 outcome，确保工具不是只注册未接线。 */
async function main() {
  await app.whenReady();
  const desktop = loadDesktop();
  desktop.setAlive(true);
  const agent = loadAgent(desktop);
  const sample = fixture();
  /** 关闭生产原生帮助进程并向实际 PowerShell 夹具发送终止请求。 */
  stopNative = function stopNativeResources() {
    desktop.setAlive(false);
    sample.child.kill();
  };
  await verify(desktop, agent, sample);
  app.quit();
}

/**
 * 核对生产工具返回的窗口、控件、内存状态及实际等待。
 * @param {object} desktop 真实桌面模块，验收末段会关闭 AGI。
 * @param {object} agent 带测试入口的生产 Agent。
 * @param {object} sample 原生夹具，先等待它返回窗口及内存位置。
 * @returns {Promise<void>} 断言通过后保存原生结果，任何错误传回主流程统一清理。
 */
async function verify(desktop, agent, sample) {
  try {
    const data = await sample.ready;
    const owner = { readOnly: false };
    const events = [];
    function event(value) { events.push(value); }
    async function run(args, signal) {
      return JSON.parse(await agent.executeRuntimeTest(root, owner, 'runtime_state', args, event, [], signal, {}));
    }
    const target = { pid: data.pid, hwnd: data.hwnd };
    check(agent.toolsSpec().some(isRuntime), 'AGI 开启时普通模型和 MCP 共用工具注册');
    const windows = await run({ action: 'snapshot', source: 'windows', target: { pid: data.pid } });
    fs.writeFileSync(path.join(output, 'window-diagnostic.json'), JSON.stringify({ fixture: data, windows }, null, 2));
    console.log(JSON.stringify({ fixture: data, windows }));
    check(windows.records['window:' + data.hwnd] && windows.records['window:' + data.hwnd].pid === data.pid, '真实窗口句柄与 PID 来自结构化快照');
    const controls = { source: 'controls', target, controls: [
      { key: 'editor', name: 'SpCode Runtime Editor', type: 'Edit' },
      { key: 'toggle', name: 'SpCode Runtime Toggle', type: 'CheckBox' }
    ] };
    const initial = await run({ ...controls, action: 'snapshot' });
    console.log(JSON.stringify({ controls: initial }));
    check(initial.records.editor && initial.records.editor.value === 'ready' && initial.records.toggle && initial.records.toggle.toggle === 'Off', '真实 UIA 读取文本与勾选状态');
    const stable = await run({ ...controls, action: 'diff', baseline: initial.snapshotId });
    check(stable.changes.length === 0, '未变化控件增量为空');
    const longText = '精确状态'.repeat(40);
    await sample.command({ text: longText, toggle: true });
    const changed = await run({ ...controls, action: 'diff', baseline: initial.snapshotId });
    check(changed.changes.length === 2 && changed.changes[0].after.value === longText, '真实变化包含完整长文本与勾选，不截成80字符');
    const cacheCheck = await executeFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(__dirname, 'test-runtime-uia-cache.ps1'), '-WindowHandle', data.hwnd], { windowsHide: true, timeout: 10000 });
    const cacheResult = JSON.parse(cacheCheck.stdout.trim());
    const afterCache = await run({ ...controls, action: 'snapshot' });
    check(cacheResult.ok && afterCache.records.editor.value === 'cache-survives', '真实 Observe 后旧 Scan 编号仍能操作同一测试控件');
    check(desktop.currentFrame() === null, '结构化查询从未刷新桌面坐标帧');
    const memoryQuery = { source: 'memory', target: { pid: data.pid }, memory: [
      { key: 'integer', address: data.address, length: 4, dataType: 'int32' }
    ] };
    const first = await run({ ...memoryQuery, action: 'snapshot' });
    check(first.records.integer.value[0] === 137, '常驻帮助进程真实跨进程读取137');
    let mutation;
    async function mutate() { mutation = sample.command({ value: 80 }); await mutation; }
    const timer = setTimeout(mutate, 350);
    const waited = await run({ ...memoryQuery, action: 'wait', timeoutMs: 5000, intervalMs: 100,
      baseline: first.snapshotId, condition: { key: 'integer', field: 'value', operator: 'eq', value: [80] } });
    clearTimeout(timer);
    if (mutation) await mutation;
    check(waited.status === 'matched' && waited.polls >= 2 && waited.record.value[0] === 80, '一次 Agent 调用等待真实内存137变80');
    const evidence = fs.readFileSync(path.join(root, waited.evidencePath), 'utf8');
    check(evidence.includes('"value":[137]') && evidence.includes('"value":[80]'), '真实内存前后采样原文落盘');
    const timeoutQuery = { ...memoryQuery, action: 'wait', timeoutMs: 250, intervalMs: 100,
      condition: { key: 'integer', field: 'value', operator: 'eq', value: [81] } };
    const timed = await run(timeoutQuery);
    const outcome = events[events.length - 1].outcome;
    check(timed.status === 'timeout' && outcome === 'error', '真实等待超时明确返回且 Agent 不报成功');
    // 运行观察没有命令退出码。验收提示应引用实际采样值，便于用户直接核对。
    const selfTest = require('../electron/lib/agi-self-test');
    const snap = { selfTestAuthorized: true };
    const receipt = selfTest.begin(root, snap, [], 'runtime_state', timeoutQuery);
    selfTest.record(snap, receipt, outcome === 'success', JSON.stringify(timed));
    const review = selfTest.status(root, [], snap);
    assert.equal(review.ready, false);
    assert.match(review.detail, /等待条件超时，末次采样 integer\.value=\[80\]/);
    check(true, review.detail);
    await assert.rejects(function badPid() { return run({ ...controls, action: 'snapshot', target: { pid: process.pid, hwnd: data.hwnd } }); }, /identity/i);
    check(true, '窗口属于其它进程时拒绝读取');
    await assert.rejects(function duplicate() { return run({ source: 'controls', action: 'snapshot', target,
      controls: [{ key: 'duplicate', name: 'SpCode Duplicate' }] }); }, /Ambiguous/);
    check(true, '真实 UIA 多匹配拒绝随便选控件');
    await assert.rejects(function unreadable() { return run({ source: 'memory', action: 'snapshot', target: { pid: data.pid },
      memory: [{ key: 'bad', address: '0x1', length: 4, dataType: 'int32' }] }); });
    check(true, '实际不可读内存地址明确失败');
    const controller = new AbortController();
    function cancel() { controller.abort(); }
    const cancelTimer = setTimeout(cancel, 120);
    await assert.rejects(function cancelled() { return run({ ...memoryQuery, action: 'wait', timeoutMs: 5000, intervalMs: 1000,
      condition: { key: 'integer', field: 'value', operator: 'eq', value: [99] } }, controller.signal); }, /已停止/);
    clearTimeout(cancelTimer);
    check(true, '真实等待可中断且留下取消证据');
    // 对相同已知数据测量单次启动与常驻采样，报告实际耗时，不预设加速比例。
    const legacy = require('../electron/lib/process-memory');
    const coldStart = performance.now();
    const old = await legacy.run({ action: 'read', pid: data.pid, address: data.address, length: 4, dataType: 'int32' });
    const legacyMs = performance.now() - coldStart;
    const warmStart = performance.now();
    for (let i = 0; i < 10; i++) {
      const value = await run({ ...memoryQuery, action: 'snapshot' });
      assert.equal(value.records.integer.value[0], old.value[0]);
    }
    const warmAverageMs = (performance.now() - warmStart) / 10;
    check(true, '连续10次常驻读取与原只读工具数值一致');
    const screenshotModules = Object.keys(require.cache).filter(isOcr);
    check(screenshotModules.length === 0, '观察和等待未启动 tesseract OCR 引擎');
    const result = { checks, output: path.relative(root, output), legacyMs, warmAverageMs,
      wait: waited, noChangeBytes: Buffer.byteLength(JSON.stringify(stable)),
      fullSnapshotBytes: Buffer.byteLength(JSON.stringify(initial)), failures };
    desktop.setAlive(false);
    check(!agent.toolsSpec().some(isRuntime), '关闭 AGI 后工具从模型列表移除');
    await assert.rejects(function disabled() { return run({ ...memoryQuery, action: 'snapshot' }); }, /AGI/);
    check(true, '执行入口再次核对 AGI，不能绕过开关');
    check(failures.length === 0, '无未处理异步异常');
    result.checks = checks;
    fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    stopNative();
  }
}
/** 只检查当前工具名称。 */
function isRuntime(spec) { return spec.function.name === 'runtime_state'; }
/** OCR 模块只在真正加载引擎时出现，导入屏幕工具模块不算启动识别。 */
function isOcr(file) { return file.includes('node_modules') && file.includes('tesseract.js'); }
const watchdog = setTimeout(timeout, 45000);
/** 超时时请求终止已启动的原生帮助进程和夹具，然后以状态码 1 退出 Electron。 */
function timeout() {
  stopNative?.();
  console.error('Native verification timeout');
  app.exit(1);
}
main().then(done, failed);
/** 所有原生资源释放后清除测试看门狗。 */
function done() { clearTimeout(watchdog); }
/** 任意断言或原生失败均以非零退出码交付。 */
function failed(error) { console.error(error.stack || error); clearTimeout(watchdog); app.exit(1); }
