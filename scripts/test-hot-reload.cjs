'use strict';

/**
 * 用真实临时 CommonJS 文件、文件监听和界面控制器验证热更新。
 * 测试只在系统临时目录写入样本，不改用户工程、配置或正在执行的聊天。
 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const vm = require('vm');
const { createHotReload } = require('../electron/lib/hot-reload');

let assertions = 0;
const failures = [];
const projectRoot = path.resolve(__dirname, '..');

/** 每条断言都验证运行行为或实际数据，不依赖源码中存在某个字符串。 */
function check(value, message) {
  assert.ok(value, message);
  assertions++;
}

/** 提供可精确控制完成时刻的异步任务，避免靠固定等待判断空闲。 */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise(accept);
  function accept(onResolve, onReject) { resolve = onResolve; reject = onReject; }
  return { promise, resolve, reject };
}

/** 等待一轮事件循环，供已经完成的 Promise 续体处理，不模拟文件保存时长。 */
function nextTurn() {
  return new Promise(schedule);
  function schedule(resolve) { setImmediate(resolve); }
}

/** 监听器关闭在后续事件循环完成，只等待资源计数达标并设置明确截止时刻。 */
function waitForResourceCount(predicate, maximum, timeoutMs) {
  return new Promise(begin);
  function begin(resolve, reject) {
    const deadline = Date.now() + timeoutMs;
    inspect();
    function inspect() {
      const count = process.getActiveResourcesInfo().filter(predicate).length;
      if (count <= maximum) { resolve(count); return; }
      if (Date.now() >= deadline) { reject(new Error('监听资源未释放，剩余：' + count)); return; }
      setImmediate(inspect);
    }
  }
}

/** 创建隔离目录和宿主状态；close 同时释放监听器、加载钩子与样本缓存。 */
function fixture(modules) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-hot-reload-'));
  const state = { busy: false, failAfterReload: false, reloads: [], notifications: [], waiters: [] };
  const previousLoader = Module._load;
  const hot = createHotReload({ root, modules, canApply, notify, afterReload });
  function canApply() { return !state.busy; }
  function notify(update) {
    state.notifications.push(update);
    for (const waiter of state.waiters.slice()) waiter(update);
  }
  function afterReload(files) {
    if (state.failAfterReload) throw new Error('宿主重新接线失败');
    state.reloads.push(files);
  }
  function file(name, source) {
    const absolute = path.join(root, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, source, 'utf8');
    return absolute;
  }
  function update(name, source) {
    const absolute = file(name, source);
    hot.changed(absolute);
    return absolute;
  }
  function load(name) { return require(path.join(root, name)); }
  function close() {
    hot.close();
    check(Module._load === previousLoader, 'close 恢复此前的 Node 加载器');
    for (const name of Object.keys(require.cache)) {
      if (name.startsWith(root + path.sep)) delete require.cache[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
  return { root, state, hot, file, update, load, close };
}

/** 用真实状态通知完成等待；超时只负责报告失败，不把经过时间当成功。 */
function waitNotification(subject, predicate, timeoutMs) {
  return new Promise(begin);
  function begin(resolve, reject) {
    const timer = setTimeout(expired, timeoutMs);
    subject.state.waiters.push(received);
    function remove() {
      clearTimeout(timer);
      const index = subject.state.waiters.indexOf(received);
      if (index >= 0) subject.state.waiters.splice(index, 1);
    }
    function received(update) {
      if (!predicate(update)) return;
      remove();
      resolve(update);
    }
    function expired() {
      remove();
      reject(new Error('未在 ' + timeoutMs + 'ms 内收到预期的真实热更新通知'));
    }
  }
}

/** 在明确的负向观察窗口内监听真实通知；出现通知立刻失败，到期解除监听。 */
function expectNoNotification(subject, timeoutMs) {
  return new Promise(begin);
  function begin(resolve, reject) {
    const timer = setTimeout(completed, timeoutMs);
    subject.state.waiters.push(received);
    function remove() {
      clearTimeout(timer);
      const index = subject.state.waiters.indexOf(received);
      if (index >= 0) subject.state.waiters.splice(index, 1);
    }
    function received(update) {
      remove();
      reject(new Error('相同内容写入不应触发通知，实际收到：' + update.kind));
    }
    function completed() { remove(); resolve(); }
  }
}

/** 加载完整的生产 ESM 控制器，保留所有实际分支。 */
async function rendererApi() {
  const file = path.join(projectRoot, 'renderer', 'hot-reload.js');
  const source = fs.readFileSync(file, 'utf8');
  return import('data:text/javascript;base64,' + Buffer.from(source, 'utf8').toString('base64'));
}

/** 模拟同一窗口的 sessionStorage；数据保存与自动落盘偏好相互独立。 */
function storageFixture() {
  const data = new Map();
  function getItem(key) { return data.has(key) ? data.get(key) : null; }
  function setItem(key, value) { data.set(key, String(value)); }
  function removeItem(key) { data.delete(key); }
  return { getItem, setItem, removeItem };
}

/** 注入真实内存快照、可控 IPC 和可见错误收集，保留控制器自身行为。 */
function rendererFixture(api) {
  const storage = storageFixture();
  const state = {
    busy: false, readyCalls: [], snapshots: [], clears: 0, statuses: [], errors: [], metadata: [],
    autoSave: false, sessions: [{ id: '未落盘会话', messages: [{ role: 'user', content: '草稿任务' }] }],
    readyResult: { ok: true }, readyGate: null, failSnapshot: false, failMetadata: false
  };
  const controller = api.createHotReloadController({ isBusy, saveSnapshot, clearSnapshot, ready, showStatus, reportError, refreshMetadata });
  function isBusy() { return state.busy; }
  function saveSnapshot(revision) {
    if (state.failSnapshot) throw new Error('快照不可写');
    const snapshot = { revision, autoSave: state.autoSave, sessions: state.sessions };
    state.snapshots.push(revision);
    storage.setItem('spcode:hot-reload', JSON.stringify(snapshot));
  }
  function clearSnapshot() { state.clears++; storage.removeItem('spcode:hot-reload'); }
  function ready(revision) {
    state.readyCalls.push(revision);
    if (state.readyGate) return state.readyGate.promise;
    return Promise.resolve(state.readyResult);
  }
  function showStatus(message, error) { state.statuses.push({ message, error }); }
  function reportError(message, details) { state.errors.push({ message, details }); }
  function refreshMetadata(update) {
    state.metadata.push(update);
    if (state.failMetadata) return Promise.reject(new Error('资料加载失败'));
    return Promise.resolve();
  }
  return { storage, state, controller };
}

/** 静态常量和解构函数均须在依赖更新后重新接到新实现。 */
async function testDependencyUpdates() {
  const sample = fixture(['dep.cjs', 'consumer.cjs']);
  try {
    sample.file('dep.cjs', 'const version = 1; function read() { return version; } module.exports = { version, read };');
    sample.file('consumer.cjs', "const { version, read } = require('./dep.cjs'); function result() { return [version, read()]; } module.exports = { result };");
    const dep = sample.load('dep.cjs');
    const oldRead = dep.read;
    const consumer = sample.load('consumer.cjs');
    const oldResult = consumer.result;
    check(JSON.stringify(oldResult()) === '[1,1]', '初始依赖常量及解构调用正确');
    sample.update('dep.cjs', 'const version = 2; function read() { return version; } module.exports = { version, read };');
    check(sample.hot.flush(), '真实依赖文件更新成功提交');
    check(dep.version === 2 && oldRead() === 2, '保存前持有的对象与解构函数调用新实现');
    check(JSON.stringify(oldResult()) === '[2,2]', '调用方捕获的常量和函数均切换新版本');
    check(sample.state.reloads[0].includes(path.join(sample.root, 'consumer.cjs')), '更新包含受影响的调用方');
  } finally { sample.close(); }
}

/**
 * 验证保存后待校验、正在执行的 Promise 与宿主忙状态均阻止页面重载和业务切换。
 * @returns {Promise<void>} 真实业务批次成功应用且解除占用后兑现；仅修改隔离临时样本。
 */
async function testBusyBoundaries() {
  const sample = fixture(['task.cjs']);
  const gate = deferred();
  try {
    sample.file('task.cjs', 'function version() { return 1; } function hold(promise) { return promise; } module.exports = { version, hold };');
    const task = sample.load('task.cjs');
    check(!sample.hot.isBusy(), '业务未保存且无在途调用时可空闲');
    sample.update('task.cjs', 'function version() { return 1; } function hold(promise) { return promise; } module.exports = { version, hold };');
    check(sample.hot.isBusy() && task.version() === 1, '业务保存后在合并延迟与校验开始前立即阻止重载');
    const running = task.hold(gate.promise);
    sample.update('task.cjs', 'function version() { return 2; } function hold(promise) { return promise; } module.exports = { version, hold };');
    check(sample.hot.isBusy(), '未完成 Promise 保持模块占用');
    check(sample.hot.flush() === false && task.version() === 1, '执行期间不切换业务代码');
    sample.state.busy = true;
    gate.resolve('任务结果');
    check(await running === '任务结果', '热重载生命周期保留原异步结果');
    check(sample.hot.flush() === false && task.version() === 1, '模块空闲后仍尊重宿主忙状态');
    sample.state.busy = false;
    check(sample.hot.flush() && task.version() === 2, '宿主和调用均结束后应用待更新版本');
    check(!sample.hot.isBusy(), '待校验业务实际提交成功后才解除重载阻塞');
  } finally { gate.resolve(); sample.close(); }
}

/** 同一批次只发布一次，反复保存不能积累过期缓存关系。 */
async function testBatchesAndCache() {
  const sample = fixture(['dep.cjs', 'consumer.cjs']);
  try {
    sample.file('dep.cjs', 'module.exports = { number: 0 };');
    sample.file('consumer.cjs', "const { number } = require('./dep.cjs'); function result() { return number; } module.exports = { result };");
    const consumer = sample.load('consumer.cjs');
    for (let version = 1; version <= 12; version++) {
      sample.update('consumer.cjs', "const { number } = require('./dep.cjs'); function result() { return number + " + version + '; } module.exports = { result };');
      sample.update('dep.cjs', 'module.exports = { number: ' + version + ' };');
      check(sample.hot.flush() && consumer.result() === version * 2, '同批跨文件更新保持一致版本 ' + version);
    }
    const runtime = sample.state.notifications.filter(isRuntime);
    function isRuntime(update) { return update.kind === 'runtime'; }
    check(runtime.length === 12 && runtime[0].paths.length === 2, '每批仅发布一个包含全部文件的通知');
    for (const cached of Object.values(require.cache)) {
      const linked = cached.children.filter(inSample);
      function inSample(child) { return child.filename.startsWith(sample.root + path.sep); }
      const names = new Set();
      for (const child of linked) names.add(child.filename);
      check(linked.length === names.size, '父模块未积累重复的样本缓存节点：' + cached.filename);
    }
  } finally { sample.close(); }
}

/** 语法错误、加载异常及宿主接线失败不得冒充成功，修正后可继续提交。 */
async function testFailureRecovery() {
  const sample = fixture(['value.cjs']);
  try {
    sample.file('value.cjs', 'module.exports = { version: 1 };');
    const value = sample.load('value.cjs');
    sample.update('value.cjs', 'module.exports = { version: ; };');
    check(sample.hot.flush() === false && value.version === 1, '语法错误保留正在使用的版本');
    check(sample.hot.status().kind === 'error' && sample.state.reloads.length === 0, '语法失败明确可见且未调用成功接线');
    sample.update('value.cjs', "throw new Error('装载失败'); module.exports = { version: 2 };");
    check(sample.hot.flush() === false && value.version === 1, '加载时异常不发布新导出');
    sample.state.failAfterReload = true;
    sample.update('value.cjs', 'module.exports = { version: 2 };');
    check(sample.hot.flush() === false && value.version === 1, '宿主接线失败不提前提交导出');
    sample.state.failAfterReload = false;
    sample.update('value.cjs', 'module.exports = { version: 3 };');
    check(sample.hot.flush() && value.version === 3, '下一次修复保存可以恢复热更新');
    check(sample.state.notifications.filter(isRuntime).length === 1, '所有失败均未发布业务更新成功');
    function isRuntime(update) { return update.kind === 'runtime'; }
  } finally { sample.close(); }
}

/**
 * 既有 CommonJS 导出删除或改变类型必须拒绝；保存失败候选后旧引用仍能真正执行。
 * @returns {Promise<void>} 使用隔离临时模块，不修改生产源码或宿主资源。
 */
async function testExportContracts() {
  const sample = fixture(['exports.cjs']);
  try {
    sample.file('exports.cjs', 'module.exports={read:function read(){return 1;},version:1};');
    const api = sample.load('exports.cjs');
    const held = api.read;
    sample.file('renderer/index.html', '<script type="module" src="./view.js"></script>');
    sample.file('renderer/view.js', 'export const value=1;');
    const ready = waitNotification(sample, isRenderer, 5000);
    sample.hot.changed(path.join(sample.root, 'renderer/index.html'));
    await ready;
    sample.update('exports.cjs', 'module.exports={version:2};');
    check(sample.hot.flush() === false && held() === 1 && api.version === 1, '删除既有函数导出被拒绝，旧引用和数据继续可用');
    check(sample.hot.status().kind === 'error', '业务导出失败也撤销之前已排队的界面 ready');
    sample.update('exports.cjs', 'module.exports={read:2,version:2};');
    check(sample.hot.flush() === false && held() === 1, '函数变成数字不能提交后才由调用方报错');
    sample.update('exports.cjs', 'module.exports={read:function read(){return 3;},version:"3"};');
    check(sample.hot.flush() === false && held() === 1, '既有数据导出的类型改变同样拒绝');
    const priorReadyRevision = sample.state.notifications.find(isRenderer).revision;
    const repairedReady = waitNotification(sample, isRenderer, 5000);
    sample.update('exports.cjs', 'module.exports={read:function read(){return 4;},version:4,added:true};');
    check(sample.hot.flush() && held() === 4 && api.added === true, '兼容实现及新增导出允许提交到稳定引用');
    check(sample.hot.status().kind === 'validating' && sample.hot.isBusy(), '业务修复先重新预检保留的界面路径，不复活旧 ready');
    const freshReady = await repairedReady;
    check(freshReady.revision > priorReadyRevision && freshReady.paths.includes('renderer/index.html') && !sample.hot.isBusy(), '此前排队界面资源经重验生成新版本，不永久丢失待加载更新');
  } finally { sample.close(); }
  /** 只接受预检真正完成的界面版本，跳过即时 validating 通知。 */
  function isRenderer(update) { return update.kind === 'renderer'; }
}

/**
 * 验证业务失败持续阻止在途或后来保存的有效界面发布 ready，其他业务成功不能解除失败。
 * @returns {Promise<void>} 实际预检子进程完成且修复后发布全新版本才兑现；仅使用临时源码。
 */
async function testBusinessErrorBlocksRenderer() {
  const sample = fixture(['first.cjs', 'second.cjs', 'unrelated.cjs']);
  try {
    sample.file('first.cjs', 'module.exports={read:function read(){return 1;}};');
    sample.file('second.cjs', 'module.exports={read:function read(){return 1;}};');
    sample.load('first.cjs');
    const second = sample.load('second.cjs');
    sample.file('unrelated.cjs', 'module.exports={read:function read(){return 1;}};');
    sample.load('unrelated.cjs');
    sample.file('renderer/index.html', '<script type="module" src="./view.js"></script>');
    sample.file('renderer/view.js', 'export const value=1;');
    const firstReady = waitNotification(sample, isRenderer, 5000);
    sample.hot.changed(path.join(sample.root, 'renderer/index.html'));
    const previousReady = await firstReady;
    const blockedAt = sample.state.notifications.length;
    const processesBefore = process.getActiveResourcesInfo().filter(isProcess).length;

    sample.update('renderer/view.js', 'export const value=2;');
    sample.update('first.cjs', 'module.exports={read:};');
    sample.update('second.cjs', 'module.exports={read:function read(){return 2;}};');
    check(sample.hot.flush() === false, '在界面预检尚在途时制造真实业务语法失败');
    await verifyBlocked('业务报错后的在途预检');

    sample.update('renderer/view.js', 'export const value=3;');
    await verifyBlocked('业务未修复时随后保存的有效界面');
    sample.update('unrelated.cjs', 'module.exports={read:function read(){return 2;}};');
    check(sample.hot.flush(), '无关业务模块仍可正常更新');
    await verifyBlocked('无关业务更新成功后');

    sample.update('unrelated.cjs', 'module.exports={read:};');
    check(sample.hot.flush() === false, '另一独立批次也产生真实业务失败');
    sample.update('first.cjs', 'module.exports={read:function read(){return 4;}};');
    check(sample.hot.flush(), '实际修复出错业务模块成功，不被独立失败批次阻止提交');
    check(second.read() === 2, '修复错误会重新提交失败原子批次中的有效同批文件，不要求额外保存');
    await verifyBlocked('另一独立失败批次尚未修复时');
    const repaired = waitNotification(sample, isRenderer, 5000);
    sample.update('unrelated.cjs', 'module.exports={read:function read(){return 4;}};');
    check(sample.hot.flush(), '最后一个失败批次实际修复成功');
    const next = await repaired;
    check(next.revision > previousReady.revision && next.paths.includes('renderer/view.js') && !sample.hot.isBusy(), '业务修复后保留的最新界面重新预检并生成新版本');

    /**
     * 等待真实校验进程退出和保存稳定，检查错误状态及所有通知中不存在 ready。
     * @param {string} phase 当前受测时序，加入失败断言供定位。
     * @returns {Promise<void>} 在有限负向观察窗口结束后兑现；期间任何通知或未退出校验均使测试失败。
     */
    async function verifyBlocked(phase) {
      await waitForResourceCount(isProcess, processesBefore, 5000);
      await expectNoNotification(sample, 600);
      check(!sample.state.notifications.slice(blockedAt).some(isRenderer), phase + '不得发布 renderer ready');
      check(sample.hot.status().kind === 'error' && sample.hot.isBusy(), phase + '持续保留业务错误并阻止重载');
    }
  } finally { sample.close(); }
  /** 仅匹配可重载界面通知；update 为实际通知，返回是否 ready。 */
  function isRenderer(update) { return update.kind === 'renderer'; }
  /** 识别 Node 活动子进程资源；name 为资源类型，返回是否 ProcessWrap。 */
  function isProcess(name) { return name === 'ProcessWrap'; }
}

/** 实际 fs.watch 保存事件必须自动驱动更新，而非依赖手动 changed。 */
async function testRealWatcherAndClose() {
  const sample = fixture(['watched.cjs']);
  const initialWatcherCount = process.getActiveResourcesInfo().filter(isWatcher).length;
  function isWatcher(name) { return name === 'FSEventWrap'; }
  let closed = false;
  try {
    sample.file('watched.cjs', 'module.exports = { version: 1 };');
    const value = sample.load('watched.cjs');
    sample.hot.start([sample.root]);
    const notice = waitNotification(sample, isRuntime, 5000);
    function isRuntime(update) { return update.kind === 'runtime'; }
    sample.file('watched.cjs', 'module.exports = { version: 2 };');
    const update = await notice;
    check(value.version === 2 && update.paths.includes('watched.cjs'), '真实文件保存经监听器自动生效');
    sample.close();
    closed = true;
    const remaining = await waitForResourceCount(isWatcher, initialWatcherCount, 1000);
    check(remaining <= initialWatcherCount, 'close 释放实际文件监听资源');
    const count = sample.state.notifications.length;
    sample.hot.changed(path.join(sample.root, 'watched.cjs'));
    check(sample.hot.flush() === false && sample.state.notifications.length === count, 'close 后不会处理或发布更新');
  } finally { if (!closed) sample.close(); }
}

/** 相同字节保存确实产生文件系统事件时，不应成为程序更新；后续真变化仍须生效。 */
async function testSameContentSave() {
  const sample = fixture(['watched.cjs']);
  let observer = null;
  let eventTimer = null;
  try {
    const source = 'module.exports = { version: 1 };';
    const file = sample.file('watched.cjs', source);
    const value = sample.load('watched.cjs');
    sample.hot.start([sample.root]);
    const observed = new Promise(watch);
    function watch(resolve, reject) {
      eventTimer = setTimeout(expired, 5000);
      observer = fs.watch(file, received);
      observer.on('error', failed);
      function received() { clearTimeout(eventTimer); resolve(); }
      function failed(error) { clearTimeout(eventTimer); reject(error); }
      function expired() { reject(new Error('相同内容写入未产生预期文件系统事件，无法验证过滤行为')); }
    }
    sample.file('watched.cjs', source);
    await observed;
    check(sample.state.notifications.length === 0, '真实相同内容保存事件未立即发布更新');
    await expectNoNotification(sample, 800);
    check(sample.hot.flush() === false && value.version === 1, '负向观察窗口内无通知且相同内容未进入待更新队列');
    const changed = waitNotification(sample, isRuntime, 5000);
    function isRuntime(update) { return update.kind === 'runtime'; }
    sample.file('watched.cjs', 'module.exports = { version: 2 };');
    await changed;
    check(value.version === 2, '过滤同内容事件后仍监听并应用真正内容变化');
  } finally {
    if (observer) observer.close();
    if (eventTimer) clearTimeout(eventTimer);
    sample.close();
  }
}

/** 合法 ESM 资源可以更新；错误与需要重启的常驻服务有明确通知。 */
async function testResourceClassification() {
  const sample = fixture(['business.cjs']);
  try {
    sample.file('renderer/dependency.js', 'export const value = 1;');
    sample.file('renderer/index.html', '<script type="module" src="./view.js"></script>');
    sample.file('renderer/view.js', "import { value } from './dependency.js'; export function render() { return value; }");
    const valid = waitNotification(sample, rendererOrError, 5000);
    function rendererOrError(update) { return update.kind === 'renderer' || update.kind === 'error'; }
    sample.hot.changed(path.join(sample.root, 'renderer/view.js'));
    check((await valid).kind === 'renderer', 'renderer import/export 按模块语法校验并接受');
    const rendererRevision = sample.hot.status().revision;
    sample.file('business.cjs', 'module.exports = { version: 1 };');
    sample.load('business.cjs');
    sample.update('business.cjs', 'module.exports = { version: 2 };');
    sample.hot.flush();
    check(sample.hot.status().kind === 'renderer' && sample.hot.status().revision === rendererRevision, '业务通知不覆盖尚未处理的界面更新');
    const css = waitNotification(sample, rendererOrError, 5000);
    sample.update('renderer/style.css', 'body { color: red; }');
    check((await css).kind === 'renderer' && sample.hot.status().paths.includes('renderer/view.js') && sample.hot.status().paths.includes('renderer/style.css'), '多次界面变更在保存稳定后保留全部待处理路径');
    const invalid = waitNotification(sample, isError, 5000);
    function isError(update) { return update.kind === 'error'; }
    sample.update('renderer/broken.js', 'export function broken( {');
    check((await invalid).kind === 'error', '非法界面语法有实际失败通知');
    const entryUpdate = waitNotification(sample, isRuntime, 5000);
    function isRuntime(update) { return update.kind === 'runtime'; }
    sample.update('electron/main.js', 'module.exports = {};');
    sample.hot.flush();
    check((await entryUpdate).paths.includes('electron/main.js'), '尚未加载的启动入口保存后交给首次加载读取，不要求重启');
    sample.update('skills/example.md', '新的技能正文');
    check(sample.state.notifications.at(-1).kind === 'data', '技能资料更新明确通知下次读取');
  } finally { sample.close(); }
}

/** 同批 CSS 不得绕过尚未通过的脚本；修正错误后整批才能变成可加载状态。 */
async function testRendererBatchFailure() {
  const sample = fixture(['business.cjs']);
  try {
    const failed = waitNotification(sample, isError, 5000);
    function isError(update) { return update.kind === 'error'; }
    sample.update('renderer/style.css', 'body { color: blue; }');
    sample.update('renderer/logic.js', 'export function broken( {');
    check(sample.hot.isBusy(), '同批界面脚本校验完成前禁止页面重载');
    await failed;
    check(sample.hot.isBusy() && sample.hot.status().kind === 'error', '脚本错误使整批界面更新保持不可加载且错误可见');
    const fixed = waitNotification(sample, isRenderer, 5000);
    function isRenderer(update) { return update.kind === 'renderer'; }
    sample.update('renderer/logic.js', 'export function updated() { return 2; }');
    const update = await fixed;
    check(!sample.hot.isBusy() && update.paths.includes('renderer/style.css') && update.paths.includes('renderer/logic.js'), '修复保存后CSS和脚本整批恢复可加载');
    check(sample.state.notifications.filter(isRenderer).length === 1, '包含错误的批次未抢先发布CSS成功通知');
  } finally { sample.close(); }
}

/**
 * 通过真实隔离预检进程核对静态模块图、HTML 脚本类型及错误后恢复。
 * @returns {Promise<void>} 验证链接结果与发布状态；候选脚本的顶层代码始终不会被执行。
 */
async function testStaticRendererGraph() {
  const sample = fixture([]);
  try {
    sample.file('renderer/index.html', '<script src="./classic.js"></script><script type="module" src="./entry.js"></script>');
    sample.file('renderer/classic.js', 'with ({value:1}) { value; }');
    sample.file('renderer/unused.html', '<!-- <script src="./missing-comment.js"></script> --><script type="application/json">{"value":1}</script><script>window.inlineValue=1;</script>');
    sample.file('renderer/entry.js', "import {value} from './barrel.js'; export const entry=value; throw new Error('预检不得执行');");
    sample.file('renderer/barrel.js', "export {value} from './dependency.js';");
    sample.file('renderer/dependency.js', 'export const value=1;');
    await accept('renderer/dependency.js', 'export const value=2;', 'HTML 经典脚本按非严格 script 解析，ESM 静态图只链接不执行');
    const oldRevision = sample.hot.status().revision;
    await reject('renderer/barrel.js', "export {value} from './missing.js';", '不存在的静态依赖阻止整页重载');
    check(sample.hot.status().revision > oldRevision && sample.hot.status().kind === 'error', '静态图错误使旧 ready 版本失效');
    await reject('renderer/barrel.js', "export {missing as value} from './dependency.js';", '静态 re-export 缺少具名导出时拒绝');
    await accept('renderer/barrel.js', "export {value} from './dependency.js';", '修复静态导出后才允许新版本重载');
    await reject('renderer/dependency.js', 'export const other=3;', '未改入口但依赖导出改变仍阻止整图加载');
    await accept('renderer/dependency.js', 'export const value=4;', '依赖导出恢复后整图重新通过');
    await reject('renderer/classic.js', 'export const invalid=1;', 'HTML classic 脚本不得被误按 ESM 放行');
    await accept('renderer/classic.js', 'with ({value:2}) { value; }', '经典脚本修复后允许整图通过');
    await reject('renderer/unused.html', '<script type="module">import {missing} from "./dependency.js";</script>', 'HTML 内联 ESM 的静态导出错误也必须拒绝');
    await accept('renderer/unused.html', '<script type="module">import {value} from "./dependency.js";</script>', '内联 ESM 修复后恢复静态图预检');
    const removed = waitNotification(sample, isError, 5000);
    fs.unlinkSync(path.join(sample.root, 'renderer/dependency.js'));
    sample.hot.changed(path.join(sample.root, 'renderer/dependency.js'));
    await removed;
    check(sample.hot.isBusy() && sample.hot.status().kind === 'error', '删除入口依赖仍须保留旧页面且报告缺文件');
  } finally { sample.close(); }

  /** 保存错误候选并等待实际进程拒绝，确保该批没有先发布 renderer ready。 */
  async function reject(file, source, label) {
    const start = sample.state.notifications.length;
    const failed = waitNotification(sample, isError, 5000);
    sample.update(file, source);
    check(sample.hot.isBusy() && sample.hot.status().kind !== 'renderer', '新保存立刻撤销旧 ready');
    await failed;
    check(sample.hot.isBusy() && !sample.state.notifications.slice(start).some(isRenderer), label);
  }
  /** 保存修复候选并等待完整静态图真实链接成功。 */
  async function accept(file, source, label) {
    const ready = waitNotification(sample, rendererOrError, 5000);
    sample.update(file, source);
    check((await ready).kind === 'renderer' && !sample.hot.isBusy(), label);
  }
  function isError(update) { return update.kind === 'error'; }
  function isRenderer(update) { return update.kind === 'renderer'; }
  function rendererOrError(update) { return isError(update) || isRenderer(update); }
}

/** close 必须终止实际语法校验子进程，关闭后的结果不能再发布成功。 */
async function testValidatorClose() {
  const sample = fixture(['business.cjs']);
  const initialCount = process.getActiveResourcesInfo().filter(isProcess).length;
  let closed = false;
  function isProcess(name) { return name.toLowerCase().includes('process'); }
  try {
    sample.update('renderer/closing.js', 'export const current = 1;');
    const createdCount = process.getActiveResourcesInfo().filter(isProcess).length;
    check(createdCount > initialCount, '界面校验实际启动了独立 Node 子进程');
    sample.close();
    closed = true;
    const remaining = await waitForResourceCount(isProcess, initialCount, 3000);
    check(remaining <= initialCount, 'close 回收正在运行的语法校验器');
    await nextTurn();
    check(sample.state.notifications.every(isValidation), '关闭后校验结果不再发布界面成功通知');
    function isValidation(update) { return update.kind === 'validating'; }
  } finally { if (!closed) sample.close(); }
}

/** 页面初始化与任务空闲都达成后，才保存未自动落盘的会话并请求重载。 */
async function testRendererBusyAndSnapshots(api) {
  const sample = rendererFixture(api);
  sample.state.busy = true;
  await sample.controller.receive({ kind: 'renderer', revision: 1 });
  check(sample.state.readyCalls.length === 0, '初始化前不重载界面');
  await sample.controller.initialize(0);
  check(sample.state.snapshots.length === 0, '正在执行任务时不保存快照或重载');
  sample.state.busy = false;
  await sample.controller.retry();
  check(JSON.stringify(sample.state.readyCalls) === '[1]', '空闲后只请求一次当前版本');
  const restored = api.takeHotReloadSnapshot(sample.storage);
  check(restored.autoSave === false && JSON.stringify(restored.sessions) === JSON.stringify(sample.state.sessions), 'autoSave=false 的内存会话通过一次性快照完整恢复');
  check(api.takeHotReloadSnapshot(sample.storage) === null, '快照只消费一次，避免旧会话覆盖新状态');
  await sample.controller.receive({ kind: 'renderer', revision: 1 });
  await sample.controller.retry();
  check(sample.state.readyCalls.length === 1, '已接受的版本不会重复重载');
}

/** 宿主拒绝后清理快照，重复空闲通知可以重试同一版本。 */
async function testRendererRefusalAndRevisions(api) {
  const sample = rendererFixture(api);
  await sample.controller.initialize(0);
  sample.state.readyResult = { ok: false };
  await sample.controller.receive({ kind: 'renderer', revision: 2 });
  check(sample.state.clears === 1 && api.takeHotReloadSnapshot(sample.storage) === null, '宿主忙而拒绝时清理未使用快照');
  sample.state.readyResult = { ok: true };
  await sample.controller.receive({ kind: 'runtime', revision: 3, message: '业务已更新' });
  await sample.controller.receive({ kind: 'renderer', revision: 2 });
  check(JSON.stringify(sample.state.readyCalls) === '[2,2]', '较新的业务通知不阻止同一待重载版本的空闲重试');
  const restored = api.takeHotReloadSnapshot(sample.storage);
  const freshWindow = rendererFixture(api);
  await freshWindow.controller.initialize(restored.revision);
  await freshWindow.controller.receive({ kind: 'renderer', revision: 2 });
  check(freshWindow.state.readyCalls.length === 0, '新页面排除已恢复版本，阻止重载循环');
  await freshWindow.controller.receive({ kind: 'renderer', revision: 4 });
  check(JSON.stringify(freshWindow.state.readyCalls) === '[4]', '恢复后仍可以处理更高版本');
}

/** IPC 等待期间到达的新版本须保留，旧请求拒绝后立即处理最新版本。 */
async function testRendererNewRevision(api) {
  const sample = rendererFixture(api);
  await sample.controller.initialize(0);
  const gate = deferred();
  sample.state.readyGate = gate;
  const first = sample.controller.receive({ kind: 'renderer', revision: 10 });
  await sample.controller.receive({ kind: 'renderer', revision: 11 });
  sample.state.readyGate = null;
  gate.resolve({ ok: false });
  await first;
  await nextTurn();
  check(JSON.stringify(sample.state.readyCalls) === '[10,11]', '较旧 IPC 处理中到达的新版本没有丢失');
  check(api.takeHotReloadSnapshot(sample.storage).revision === 11, '最终快照与实际接受的新版本一致');
}

/** 文件错误、快照错误和资料加载错误均对用户可见，新的修复版本仍可用。 */
async function testRendererErrorsAndWindows(api) {
  const sample = rendererFixture(api);
  await sample.controller.initialize(0);
  sample.state.failSnapshot = true;
  await sample.controller.receive({ kind: 'renderer', revision: 20 });
  await sample.controller.retry();
  check(sample.state.errors.length === 1 && sample.state.readyCalls.length === 0, '快照错误明确可见且不无限重试失败版本');
  sample.state.failSnapshot = false;
  await sample.controller.receive({ kind: 'renderer', revision: 21 });
  check(JSON.stringify(sample.state.readyCalls) === '[21]', '更高修复版本解除快照失败状态');
  const firstWindow = rendererFixture(api);
  const secondWindow = rendererFixture(api);
  await firstWindow.controller.initialize(21);
  await secondWindow.controller.initialize(0);
  await firstWindow.controller.receive({ kind: 'renderer', revision: 21 });
  await secondWindow.controller.receive({ kind: 'renderer', revision: 21 });
  check(firstWindow.state.readyCalls.length === 0 && secondWindow.state.readyCalls.length === 1, '不同窗口分别消费自己的恢复版本');
  secondWindow.state.failMetadata = true;
  await secondWindow.controller.receive({ kind: 'runtime', revision: 22, message: '业务更新' });
  await secondWindow.controller.receive({ kind: 'error', revision: 23, message: '语法错误', paths: ['renderer/broken.js'] });
  check(secondWindow.state.errors.length === 2 && secondWindow.state.statuses.at(-1).error, '资料失败及源码失败均显示错误而非成功');
}

/**
 * 在途 IPC 的旧成功回执、已排队与已接受的旧版本在错误或新保存后均不得复活。
 * @param {object} api 由真实生产控制器 ESM 导入的接口。
 * @returns {Promise<void>} 断言实际 ready 调用、临时快照及最后状态，不用源码字符串冒充行为。
 */
async function testRendererInvalidation(api) {
  const sample = rendererFixture(api);
  await sample.controller.initialize(0);
  sample.state.busy = true;
  await sample.controller.receive({kind:'renderer',revision:30});
  await sample.controller.receive({kind:'validating',revision:31,message:'正在预检'});
  sample.state.busy = false;
  await sample.controller.receive({kind:'renderer',revision:30});
  await sample.controller.retry();
  check(sample.state.readyCalls.length === 0, '新保存使旧排队 ready 失效，空闲后不能重试');
  await sample.controller.receive({kind:'renderer',revision:32});
  await sample.controller.receive({kind:'error',revision:33,message:'模块导出错误'});
  await sample.controller.retry();
  await sample.controller.receive({kind:'renderer',revision:32});
  check(JSON.stringify(sample.state.readyCalls) === '[32]' && api.takeHotReloadSnapshot(sample.storage) === null, '错误撤销已接受版本和快照，旧通知不能再次发起重载');
  const gate = deferred();
  sample.state.readyGate = gate;
  const inFlight = sample.controller.receive({kind:'renderer',revision:34});
  await sample.controller.receive({kind:'validating',revision:35,message:'新版本预检'});
  await sample.controller.receive({kind:'error',revision:36,message:'新版本链接失败'});
  sample.state.readyGate = null;
  gate.resolve({ok:true});
  await inFlight;
  check(api.takeHotReloadSnapshot(sample.storage) === null && sample.state.statuses.at(-1).message === '新版本链接失败', '旧 IPC 后到的成功回执不能恢复 accepted 或覆盖新错误');
  await sample.controller.receive({kind:'renderer',revision:37});
  check(JSON.stringify(sample.state.readyCalls) === '[32,34,37]' && api.takeHotReloadSnapshot(sample.storage).revision === 37, '只有新修复版本能重新保存快照并请求重载');
  const rejectedGate = deferred();
  sample.state.readyGate = rejectedGate;
  const rejectedFlight = sample.controller.receive({kind:'renderer',revision:38});
  await sample.controller.receive({kind:'error',revision:39,message:'应保留的新错误'});
  sample.state.readyGate = null;
  rejectedGate.reject(new Error('已失效的旧IPC错误'));
  await rejectedFlight;
  check(sample.state.statuses.at(-1).message === '应保留的新错误', '旧 IPC 后到的拒绝也不能覆盖新版本错误');
}

/**
 * 执行生产主进程的真实 IPC 注册段，控制 setImmediate 间隙中的最新版本与忙状态。
 * @returns {Promise<void>} 新保存、错误或版本改变时无页面重载；同一已校验版本才真正 reload。
 */
async function testMainReloadRevision() {
  const source = fs.readFileSync(path.join(projectRoot, 'electron/main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('app:hotReloadReady'");
  const end = source.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, '必须取得真实主进程热重载 IPC 边界');
  const queue = [];
  const notifications = [];
  const win = {isDestroyed,webContents:{reloadIgnoringCache}};
  let handler;
  let reloads = 0;
  let current = {kind:'renderer',revision:40};
  const versions = new Map();
  vm.runInNewContext(source.substring(start, end + 4), {
    ipcMain:{handle},getWin,windows:new Set([win]),hotReload:{status,isBusy},canApplyHotReload,
    hotReloadVersions:versions,setImmediate:schedule,sendTo
  });
  check(handler({},40).ok === true, '旧页面先收到候选版本的 IPC 确认');
  current = {kind:'validating',revision:41};
  queue.shift()();
  check(reloads === 0 && !versions.has(win) && notifications.at(-1).kind === 'validating', '最终回调遇到新预检时拒绝旧重载并撤销版本登记');
  current = {kind:'renderer',revision:42};
  handler({},42);
  current = {kind:'error',revision:43,message:'静态图失败'};
  queue.shift()();
  check(reloads === 0 && notifications.at(-1).kind === 'error', 'IPC 确认后出现链接错误不能继续重载');
  current = {kind:'renderer',revision:44};
  handler({},44);
  current = {kind:'renderer',revision:45};
  queue.shift()();
  check(reloads === 0 && notifications.at(-1).revision === 45, '已经校验的新版本也不能沿用旧版本 IPC 确认');
  check(handler({},45).ok === true, '最新校验版本重新确认');
  queue.shift()();
  check(reloads === 1 && versions.get(win) === 45, '最终检查仍是同一已校验版本时真正重载一次');
  function handle(_name, callback) { handler=callback; }
  function getWin() { return win; }
  function status() { return current; }
  function isBusy() { return current.kind === 'validating'; }
  function canApplyHotReload() { return true; }
  function schedule(callback) { queue.push(callback); }
  function sendTo(_window,_event,payload) { notifications.push(payload); }
  function isDestroyed() { return false; }
  function reloadIgnoringCache() { reloads++; }
}

/** 每个场景独立运行，失败时继续给出其余行为证据。 */
async function run(name, test) {
  try {
    await test();
    process.stdout.write('通过：' + name + '\n');
  } catch (error) {
    failures.push(name);
    process.stderr.write('失败：' + name + '\n' + error.stack + '\n');
  }
}

/**
 * 使用真实已加载主入口和常驻回调，确认旧引用原位执行新代码。
 * 同时验证宿主繁忙排队、定时器实例保留，以及初始化和捕获变化被拒绝而非假成功。
 */
async function testResidentLiveEdit() {
  const sample = fixture([]);
  let resident;
  try {
    const source = "const values = []; const events = new (require('events').EventEmitter)(); const initial = 1; const other = 2; function read() { return 10 + initial; } function record() { values.push(10); } const timer = setInterval(record, 5); timer.unref(); events.on('sample', record); module.exports = { read, record, values, events, timer };";
    sample.file('electron/main.js', source);
    resident = sample.load('electron/main.js');
    const held = resident.read;
    const originalTimer = resident.timer;
    const originalEmitter = resident.events;
    check(held() === 11, '主入口旧引用初始行为可执行');
    const updated = source.split('10').join('20');
    sample.state.busy = true;
    sample.update('electron/main.js', updated);
    check(sample.hot.flush() === false && held() === 11, '宿主繁忙时主入口继续旧实现');
    sample.state.busy = false;
    const notification = waitNotification(sample, isRuntime, 5000);
    function isRuntime(update) { return update.kind === 'runtime'; }
    check(sample.hot.flush(), '空闲后实际提交常驻脚本更新');
    await notification;
    check(held() === 21 && resident.read() === 21, '保留的旧引用与导出函数都使用新实现');
    resident.events.emit('sample');
    check(resident.values.at(-1) === 20 && resident.events === originalEmitter, '原事件实例上的已注册回调原位更新');
    const afterEventCount = resident.values.length;
    await waitForTick();
    function waitForTick() {
      return new Promise(observe);
      function observe(resolve, reject) {
        const deadline = Date.now() + 3000;
        inspect();
        function inspect() {
          if (resident.values.length > afterEventCount && resident.values.at(-1) === 20) { resolve(); return; }
          if (Date.now() >= deadline) { reject(new Error('原定时器未执行新回调')); return; }
          setImmediate(inspect);
        }
      }
    }
    check(resident.timer === originalTimer && !resident.timer._destroyed, '定时器保持原实例，没有第二次启动');
    const rejected = waitNotification(sample, isError, 5000);
    function isError(update) { return update.kind === 'error'; }
    sample.update('electron/main.js', updated.replace('initial = 1', 'initial = 9'));
    sample.hot.flush();
    check((await rejected).message.includes('尚未应用') && held() === 21, '顶层初始化变化明确拒绝，保留实际在用值');
    const changedCapture = waitNotification(sample, isError, 5000);
    sample.update('electron/main.js', updated.replace('return 20 + initial', 'return 20 + other'));
    sample.hot.flush();
    check((await changedCapture).kind === 'error' && held() === 21, '新增捕获依赖不会因 V8 返回 Ok 就冒充生效');

    const switchBefore = 'const x=100;function create(){let result;switch(1){case 1:const x=10;result=function read(){return x+1;};}return result;}module.exports=create();';
    const switchAfter = 'const x=100;function create(){let result;const x=10;switch(1){case 1:result=function read(){return x+2;};}return result;}module.exports=create();';
    sample.file('electron/lib/switch-service.js', switchBefore);
    const switchHeld = sample.load('electron/lib/switch-service.js');
    const switchRejected = waitNotification(sample, isError, 5000);
    sample.update('electron/lib/switch-service.js', switchAfter);
    sample.hot.flush();
    check((await switchRejected).kind === 'error' && switchHeld() === 11, 'switch 词法绑定跨作用域移动被拒绝，不冒充更新成功');

    const shadowBefore = 'const x=20;module.exports=function read(){{const x=1;}return 10;};';
    const shadowAfter = 'const x=20;module.exports=function read(){{const x=1;}return 10+x;};';
    sample.file('electron/lib/shadow-service.js', shadowBefore);
    const shadowHeld = sample.load('electron/lib/shadow-service.js');
    const shadowRejected = waitNotification(sample, isError, 5000);
    sample.update('electron/lib/shadow-service.js', shadowAfter);
    sample.hot.flush();
    check((await shadowRejected).kind === 'error' && shadowHeld() === 10, '内层同名声明不能掩盖新增外部捕获');

    const movedReference = waitNotification(sample, isError, 5000);
    sample.file('electron/lib/moved-service.js', 'const x=20;module.exports=function read(){{const x=1;x;}return 10;};');
    const movedHeld = sample.load('electron/lib/moved-service.js');
    sample.update('electron/lib/moved-service.js', 'const x=20;module.exports=function read(){{const x=1;}return 10+x;};');
    sample.hot.flush();
    check((await movedReference).kind === 'error' && movedHeld() === 10, '引用跨同名变量作用域移动被拒绝');

    const { assertLiveEditCompatible } = require('../electron/lib/live-edit');
    assert.throws(checkThisCapture, /尚未应用/);
    function checkThisCapture() {
      assertLiveEditCompatible('module.exports=function create(){return () => 1;};', 'module.exports=function create(){return () => this.value;};');
    }
    check(true, '箭头回调新增 this 捕获明确拒绝');
    assert.throws(checkStrictMode, /尚未应用/);
    function checkStrictMode() {
      assertLiveEditCompatible('module.exports=function read(){return 1;};', 'module.exports=function read(){"use strict";return 2;};');
    }
    check(true, '函数严格模式变化不会绕过原位更新限制');
    assert.throws(checkConditionalScope, /尚未应用/);
    function checkConditionalScope() {
      assertLiveEditCompatible('function make(){if(true) function inner(){return 10;}return inner;}module.exports=make();',
        'function make(){function inner(){return 20;}return inner;}module.exports=make();');
    }
    check(true, '非严格模式条件函数的隐式作用域不能冒充兼容布局');
    const repaired = waitNotification(sample, isRuntime, 5000);
    sample.update('electron/main.js', updated.split('20').join('30'));
    sample.hot.flush();
    await repaired;
    check(held() === 31, '拒绝不兼容变化后，后续兼容版本仍能实际更新旧引用');
    check(sample.hot.status().kind === 'error' && sample.hot.isBusy(), '常驻入口修复成功仍不解除其它独立常驻模块的失败与重载门禁');
  } finally {
    if (resident) clearInterval(resident.timer);
    sample.close();
  }
}

/** 按顺序释放全局 require 钩子，避免测试相互干扰。 */
async function main() {
  await run('真实依赖、解构函数与常量调用方更新', testDependencyUpdates);
  await run('异步任务与宿主忙状态边界', testBusyBoundaries);
  await run('多文件批次与缓存关系清理', testBatchesAndCache);
  await run('语法、加载及接线失败后的恢复', testFailureRecovery);
  await run('既有CommonJS导出删除和类型改变拒绝', testExportContracts);
  await run('业务错误持续阻止在途及后续界面重载', testBusinessErrorBlocksRenderer);
  await run('实际文件监听触发与关闭清理', testRealWatcherAndClose);
  await run('真实同内容保存事件过滤与后续更新', testSameContentSave);
  await run('ESM 资源校验与待处理通知保留', testResourceClassification);
  await run('主入口、事件与定时器原位更新及结构拒绝', testResidentLiveEdit);
  await run('界面CSS与脚本整批校验及错误恢复', testRendererBatchFailure);
  await run('完整静态图、HTML脚本类型及缺依赖导出拒绝', testStaticRendererGraph);
  await run('主进程最终版本核对阻止旧页面重载', testMainReloadRevision);
  await run('关闭时终止语法校验子进程', testValidatorClose);
  const api = await rendererApi();
  await run('界面忙状态与关闭自动保存的内存快照', rendererBusy);
  await run('宿主拒绝重试与版本循环排除', rendererRefusal);
  await run('IPC 处理中到达的新界面版本', rendererRevision);
  await run('可见错误及多窗口恢复状态', rendererErrors);
  await run('错误和预检取消旧排队与在途IPC', rendererInvalidation);
  function rendererInvalidation() { return testRendererInvalidation(api); }
  function rendererBusy() { return testRendererBusyAndSnapshots(api); }
  function rendererRefusal() { return testRendererRefusalAndRevisions(api); }
  function rendererRevision() { return testRendererNewRevision(api); }
  function rendererErrors() { return testRendererErrorsAndWindows(api); }
  process.stdout.write('行为断言：' + assertions + '；失败场景：' + failures.length + '\n');
  if (failures.length) process.exitCode = 1;
}

main().catch(failed);
/** 顶层运行失败保留实际异常和非零退出码。 */
function failed(error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
