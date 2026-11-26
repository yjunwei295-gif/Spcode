/**
 * 校验页面重载的接回留存模块，以及冷启动时磁盘旧轮次照旧收停。
 * 全部在内存里跑：不启窗口、不连模型、不读写用户会话。
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createTurnRecovery } = require('../electron/lib/turn-recovery');

const root = path.join(__dirname, '..');
const appSource = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8').split('\r\n').join('\n');

/**
 * 从 app.js 抽出顶层具名函数原文，直接用真实实现做断言。
 * @param {string} signature 函数头。
 * @returns {string} 从函数头到结束大括号的源码。
 */
function functionSource(signature) {
  const start = appSource.indexOf(signature);
  assert.ok(start >= 0, '找不到函数 ' + signature);
  const end = appSource.indexOf('\n}\n', start);
  assert.ok(end > start, '函数未正常结束 ' + signature);
  return appSource.substring(start, end + 3);
}

/** 留存模块的主路径：序号、收工兑现、按窗口与标签隔离、释放与上限。 */
function testRecoveryApi() {
  const store = createTurnRecovery();
  const winA = { name: 'A' };
  const winB = { name: 'B' };
  assert.equal(store.open(winA, {}), null, '缺少轮次编号时不建记录');

  const record = store.open(winA, { turnId: 'r1', tabId: 'tab-1', modelId: 'm1', seed: { id: 'tab-1', messages: [{ role: 'assistant', turnId: 'r1' }] } });
  assert.equal(record.stopped, false, '执行方可以写「已停止」标记');
  assert.equal(store.append(record, { type: 'text', text: 'A' }).seq, 1, '事件序号从 1 开始');
  assert.equal(store.append(record, { type: 'text', text: 'B' }).seq, 2, '事件序号严格递增');
  assert.equal(store.snapshot(winB).length, 0, '别的窗口取不到这个窗口的记录');

  const snap = store.snapshot(winA)[0];
  assert.equal(snap.tabId, 'tab-1', '接回数据带标签编号，界面按它对号入座');
  assert.equal(snap.seed.id, 'tab-1', '接回数据带发送时的原标签起始状态');
  assert.equal(snap.events.length, 2, '接回数据带完整事件日志');
  assert.equal(store.hasResident(winA), false, '普通轮次不算常驻');

  store.checkpoint(winA, 'r1', { messages: [{ role: 'assistant', turnId: 'r1', turnSeq: 1, text: 'A' }] });
  assert.equal(store.snapshot(winA)[0].seed.messages[0].text, 'A');
  assert.deepEqual(store.snapshot(winA)[0].events.map(function sequence(event) { return event.seq; }), [2]);
  // 收工前后：等待者都会拿到结局，收工后不再追加事件
  const pending = store.wait(winA, 'r1');
  store.finish(record, 'success', { result: { text: '最终结果' } });
  return pending.then(function checkPending(terminal) {
    assert.equal(terminal.outcome, 'success', '等待者拿到真实结局');
    assert.equal(terminal.result.text, '最终结果', '等待者拿到原轮次回执');
    assert.equal(store.append(record, { type: 'text', text: 'C' }).seq, undefined, '收工后的事件不再追加');
    return store.wait(winA, 'r1');
  }).then(function checkFinished(again) {
    assert.equal(again.finished, true, '已收工的轮次立刻返回结局');
    assert.equal(store.release(winA, 'r1'), true, '界面消费后能释放');
    assert.equal(store.size(), 0, '释放后不留记录');
    return store.wait(winA, 'r1');
  }).then(function checkReleased(terminal) {
    assert.equal(terminal.outcome, 'error', '记录已不在时明确报错，不假装成功');
    assert.equal(terminal.released, true, '并标明这是已释放');

    // 常驻轮次与标签隔离
    const resident = store.open(winA, { turnId: 'r2', tabId: 'tab-2', resident: true, runId: 'run-2' });
    assert.equal(store.hasResident(winA), true, '常驻轮次在跑时算常驻');
    assert.equal(store.forgetTab(winA, 'tab-1'), 0, '别的标签关掉不影响这一轮');
    const stopped = store.wait(winA, 'r2');
    assert.equal(store.forgetTab(winA, 'tab-2'), 1, '标签关闭只丢掉它名下的记录');
    assert.equal(store.snapshot(winA).length, 0, '标签关闭后不再接回');
    return stopped;
  }).then(function checkDropped(terminal) {
    assert.equal(terminal.dropped, true, '标签关闭时等待者立刻拿到结局，不挂着');
    assert.equal(store.hasResident(winA), false, '记录释放后不再算常驻');

    // 失败与停止也留下收工状态
    const failed = store.open(winA, { turnId: 'r3', tabId: 'tab-3' });
    store.finish(failed, 'error', { error: '模型报错' });
    assert.equal(store.snapshot(winA)[0].error, '模型报错', '失败也留收工状态');
    const aborted = store.open(winA, { turnId: 'r4', tabId: 'tab-4' });
    aborted.stopped = true;
    store.finish(aborted, aborted.stopped ? 'stopped' : 'success', {});
    assert.equal(store.snapshot(winA)[1].outcome, 'stopped', '停止也留收工状态');

    // 验证并发标签和长输出不因任意固定上限而丢失。
    store.dropWindow(winA);
    for (let i = 0; i < 10; i++) store.open(winA, { turnId: 'cap-' + i });
    assert.equal(store.snapshot(winA).length, 10);
    assert.equal(store.snapshot(winA)[0].turnId, 'cap-0');
    const long = store.open(winB, { turnId: 'long' });
    const full = '长'.repeat(400001);
    for (let i = 0; i < 4001; i++) store.append(long, { type: 'text', text: '长' });
    store.finish(long, 'success', { result: { text: full } });
    assert.equal(store.snapshot(winB)[0].events.length, 4001);
    assert.equal(store.snapshot(winB)[0].result.text, full);
    store.dropWindow(winB);
    store.dropWindow(winA);
    assert.equal(store.size(), 0, '窗口关闭清掉该窗口全部记录');
    console.log('PASS 留存模块：序号、收工兑现、标签与窗口隔离、释放、上限');
  });
}

/** 冷启动：磁盘里残留的「进行中」一律收成「已停止」，不虚构发送中。 */
function testColdStart() {
  const context = { t: function t(key) { return String(key); } };
  const runner = new Function('t', functionSource('function settleDeadTurns(messages)') + '\nreturn settleDeadTurns;');
  const settleDeadTurns = runner(context.t);
  const messages = [
    { role: 'user', text: '需求' },
    { role: 'assistant', turnId: 'old', text: '半截', thinkingOpen: true, status: '正在调用' }
  ];
  settleDeadTurns(messages);
  const reply = messages[1];
  assert.equal(reply.thinkingOpen, false, '冷启动不再显示调用中');
  assert.equal(reply.status, 'stopped', '冷启动收成已停止');
  assert.equal(reply.stopped, true, '冷启动保留已停止标记');
  assert.equal(reply.revealLen, 2, '冷启动把已收到的正文直接显示完整');
  console.log('PASS 正常冷启动：磁盘旧轮次照旧收停');
}

Promise.resolve()
  .then(testRecoveryApi)
  .then(testColdStart)
  .then(function done() { console.log('接回留存与冷启动校验通过'); })
  .catch(function failed(error) {
    console.error('FAIL ' + (error && error.stack || error));
    process.exitCode = 1;
  });
