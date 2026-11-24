/**
 * 验证真实状态引擎的增量语义、等待、取消和证据归档。
 * 受控采样只模拟数据源，不用语法检查代替行为断言。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createObserver, LIMITS } = require('../electron/lib/runtime-state');
const tool = require('../electron/lib/runtime-state-tool');
let checks = 0;
/** 断言通过才计数。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 构造带实际时间戳的受控状态源，每次返回独立对象。 */
function harness(samples) {
  let count = 0;
  let alive = true;
  const events = [];
  /**
   * 按顺序取得受控样本，耗尽后重复读取最后一条，模拟状态保持不变。
   * @param {object} query 观察请求，source 用于标明采样来源。
   * @returns {Promise<object>} 带读取时间的独立样本，错误样本直接拒绝。
   */
  async function read(query) {
    const sample = samples[Math.min(count++, samples.length - 1)];
    if (sample instanceof Error) throw sample;
    return { ok: true, source: query.source, identity: sample.identity || 'fixture:1', startedAt: Date.now(),
      observedAt: Date.now(), records: structuredClone(sample.records) };
  }
  function active() { return alive; }
  function audit(event) { events.push(event); }
  function stop() { alive = false; }
  function reads() { return count; }
  return { observer: createObserver({ read, active }), read, active, audit, events, stop, reads };
}
/** 只有选定字段参与等待，测试不把字符串和布尔值互相转换。 */
function query(action) {
  return { action, source: 'controls', target: { pid: 1, hwnd: '123' }, controls: [{ key: 'status', name: 'Status' }] };
}
/** 等待失败必须抛错，不返回空记录或虚假成功。 */
async function rejects(run, pattern, label) { await assert.rejects(run, pattern); check(true, label); }
/** 每项覆盖实际分支，记录含回到原值的中间事件、错误与轮次隔离。 */
async function main() {
  const h = harness([{ records: { status: { enabled: false, value: 'A' } } },
    { records: { status: { enabled: true, value: 'B' } } }]);
  const first = await h.observer.run(query('snapshot'), null, h.audit);
  check(first.records.status.value === 'A', '完整快照保留字段原值');
  const diff = await h.observer.run({ ...query('diff'), baseline: first.snapshotId }, null, h.audit);
  check(diff.changes.length === 1 && diff.changes[0].before.value === 'A' && diff.changes[0].after.value === 'B', '增量保留前后证据');
  const same = await h.observer.run({ ...query('diff'), baseline: diff.snapshotId }, null, h.audit);
  check(same.changes.length === 0, '相同状态不重复发送整份内容');
  await rejects(function incompatible() { return h.observer.run({ ...query('diff'), controls: [{ key: 'status', name: 'Other' }], baseline: first.snapshotId }, null, h.audit); }, /不一致/, '不同选择器不能复用旧基线');
  await rejects(function missing() { return h.observer.run({ ...query('diff'), baseline: 'unknown' }, null, h.audit); }, /过期/, '缺失基线明确失败');
  const waitArgs = { ...query('wait'), timeoutMs: 2000, intervalMs: 100, condition: { key: 'status', field: 'enabled', operator: 'eq', value: true } };
  const temporal = harness([{ records: { status: { enabled: false, value: 'A' } } },
    { records: { status: { enabled: false, value: 'B' } } },
    { records: { status: { enabled: true, value: 'A' } } }]);
  const waited = await temporal.observer.run(waitArgs, null, temporal.audit);
  check(waited.status === 'matched' && waited.polls === 3, '一次工具等待多次本地采样');
  check(temporal.events.length === 3 && temporal.events[1].records.status.value === 'B', '回到原值也保留中间变化证据');
  check(waited.maxGapMs >= 90 && waited.sampling === true, '报告实测采样间隔而非声称连续观察');
  const absent = harness([{ records: {} }]);
  const removed = await absent.observer.run({ ...waitArgs, condition: { key: 'status', operator: 'absent' } }, null, absent.audit);
  check(removed.status === 'matched', '对象确实不存在才能满足 absent');
  const unknown = harness([{ records: { status: { enabled: false } } }]);
  await rejects(function unsupported() { return unknown.observer.run({ ...waitArgs, condition: { key: 'status', field: 'value', operator: 'ne', value: '' } }, null, unknown.audit); }, /未提供/, '未提供属性不能冒充不等于');
  const typed = harness([{ records: { status: { enabled: 'true' } } }]);
  const timed = await typed.observer.run({ ...waitArgs, timeoutMs: 120 }, null, typed.audit);
  check(timed.status === 'timeout' && timed.polls === 2, '严格类型比较且超时不冒充成功');
  const selfTest = require('../electron/lib/agi-self-test');
  const snap = { selfTestAuthorized: true };
  const receipt = selfTest.begin('', snap, [], 'runtime_state', waitArgs);
  selfTest.record(snap, receipt, false, JSON.stringify(timed));
  const review = selfTest.status('', [], snap);
  assert.equal(review.ready, false);
  assert.match(review.detail, /等待条件超时，末次采样 status\.enabled="true"/);
  check(true, review.detail);
  const replacement = harness([{ records: {} }, { identity: 'fixture:2', records: {} }]);
  await rejects(function identity() { return replacement.observer.run(waitArgs, null, replacement.audit); }, /身份/, '进程身份改变立即停止');
  const failure = harness([new Error('native failure')]);
  await rejects(function nativeFailure() { return failure.observer.run(query('snapshot'), null, failure.audit); }, /native failure/, '底层读取失败原样报告');
  const cancelled = harness([{ records: {} }]);
  const controller = new AbortController();
  function cancel() { controller.abort(); }
  const cancelTimer = setTimeout(cancel, 30);
  await rejects(function aborted() { return cancelled.observer.run({ ...waitArgs, intervalMs: 5000 }, controller.signal, cancelled.audit); }, /已停止/, '等待立即响应取消');
  clearTimeout(cancelTimer);
  check(cancelled.reads() === 1, '取消后不继续采样');
  const switched = harness([{ records: {} }]);
  const stopTimer = setTimeout(switched.stop, 30);
  await rejects(function off() { return switched.observer.run(waitArgs, null, switched.audit); }, /已停止/, '关闭 AGI 后不继续采样');
  clearTimeout(stopTimer);
  check(switched.reads() === 1, '开关关闭不产生额外原生读取');
  const changed = harness([{ records: { status: { value: 1 } } }, { records: { status: { value: 2 } } }]);
  const original = await changed.observer.run(query('snapshot'), null, changed.audit);
  const newValue = await changed.observer.run({ ...waitArgs, baseline: original.snapshotId, condition: { key: 'status', field: 'value', operator: 'changed' } }, null, changed.audit);
  check(newValue.status === 'matched', 'changed 对比明确基线');
  for (let i = 0; i < LIMITS.snapshots; i++) await changed.observer.run(query('snapshot'), null, changed.audit);
  await rejects(function evicted() { return changed.observer.run({ ...query('diff'), baseline: original.snapshotId }, null, changed.audit); }, /过期/, '缓存有界且淘汰基线不伪造');
  await rejects(function duplicate() { return h.observer.run({ ...query('snapshot'), controls: [{ key: 'x', name: 'A' }, { key: 'x', name: 'B' }] }, null, h.audit); }, /唯一/, '拒绝重复 key');
  await rejects(function unbounded() { return h.observer.run({ ...waitArgs, intervalMs: 0 }, null, h.audit); }, /intervalMs/, '拒绝无间隔忙循环');
  const preciseBytes = Buffer.alloc(8);
  preciseBytes.writeBigInt64LE(9007199254740993n);
  const precise = harness([{ records: { amount: { base64: preciseBytes.toString('base64') } } }]);
  const memoryQuery = { action: 'snapshot', source: 'memory', target: { pid: 1 },
    memory: [{ key: 'amount', address: '0x10000', length: 8, dataType: 'int64' }] };
  const preciseResult = await precise.observer.run(memoryQuery, null, precise.audit);
  check(preciseResult.records.amount.value[0] === '9007199254740993', '64位整数超过安全数值范围仍无损保留');
  const nonFiniteBytes = Buffer.alloc(8);
  nonFiniteBytes.writeDoubleLE(NaN);
  const nonFinite = harness([{ records: { amount: { base64: nonFiniteBytes.toString('base64') } } }]);
  await rejects(function nan() { return nonFinite.observer.run({ ...memoryQuery,
    memory: [{ key: 'amount', address: '0x10000', length: 8, dataType: 'float64' }] }, null, nonFinite.audit); }, /非有限/, 'NaN 不会在序列化时偷偷变成 null');
  const slow = createObserver({ active: function active() { return true; }, read: slowRead });
  async function slowRead(source) {
    await new Promise(function delay(resolve) { setTimeout(resolve, 30); });
    return { ok: true, source: source.source, identity: 'slow', startedAt: Date.now() - 30,
      observedAt: Date.now(), records: { status: { enabled: true } } };
  }
  const late = await slow.run({ ...waitArgs, timeoutMs: 1 }, null, h.audit);
  check(late.status === 'timeout', '超过截止时间才读到的匹配不算准时成功');
  const workspace = path.resolve(__dirname, '..');
  const owner = {};
  let epoch = 0;
  function runtimeEpoch() { return epoch; }
  const desktop = { isAlive: h.active, readRuntimeState: h.read, runtimeEpoch };
  const persisted = await tool.run(workspace, owner, query('snapshot'), null, desktop);
  const records = fs.readFileSync(path.join(workspace, persisted.evidencePath), 'utf8').trim().split('\n');
  check(records.length === 3 && JSON.parse(records[1]).type === 'sample', '原始采样与终态真实落盘');
  await rejects(function isolated() { return tool.run(workspace, {}, { ...query('diff'), baseline: persisted.snapshotId }, null, desktop); }, /过期/, '另一轮次不能借用快照');
  const pending = tool.run(workspace, owner, { ...waitArgs, condition: { key: 'status', field: 'value', operator: 'eq', value: 'never' } }, null, desktop);
  function cycleEpoch() { epoch += 2; }
  const cycleTimer = setTimeout(cycleEpoch, 20);
  await assert.rejects(pending, /已停止/);
  clearTimeout(cycleTimer);
  check(true, 'AGI 关闭后立即开启也不能恢复旧等待');
  await rejects(function expiredEpoch() { return tool.run(workspace, owner, { ...query('diff'), baseline: persisted.snapshotId }, null, desktop); }, /过期/, '开关生命周期切换后旧基线失效');
  check(true, '所有测试未加载 OCR、截图或模型模块');
  console.log(JSON.stringify({ checks }));
}
main().catch(function failed(error) { console.error(error); process.exitCode = 1; });
