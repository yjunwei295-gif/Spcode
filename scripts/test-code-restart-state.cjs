'use strict';

/** 验证自动重启的晚到确认、忙状态、窗口隔离及磁盘失败；交接文件使用真实临时目录。 */
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRestartReload } = require('../electron/lib/restart-reload');
let checks = 0;

/** 每个通过项均由实际结果断言产生。 */
function check(value, message) { assert.ok(value, message); checks++; }
/** 等待已排入的最后确认动作执行，不使用固定毫秒数假定成功。 */
function nextTurn() { return new Promise(schedule); }
/** 将观察安排在生产协调器的 setImmediate 之后。 */
function schedule(resolve) { setImmediate(resolve); }

/**
 * 创建可控制宿主忙状态的协调器，重启副作用仅记录在本测试对象中。
 * @returns {object} 文件位于真实临时目录；模拟 app 只用于核对不能提前退出和失败时保持运行。
 */
function sample() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-code-state-'));
  const first = { key: 'window-a', win: {} };
  const second = { key: 'window-b', win: {} };
  const state = { windows: [first, second], busy: false, update: { kind: 'restart', revision: 1, phase: 0 }, relaunches: [], quits: 0, notifications: [], errors: [] };
  const options = { directory: getDirectory, argv: ['electron', 'entry.cjs', '--user-flag', '--spcode-code-reload=old'], windows: getWindows, status: status, isBusy: isBusy, canApply: canApply, notify: notify, failed: failed, app: { relaunch, quit } };
  // 初始样本没有旧交接文件；待重启参数的去重在真正生成新参数时单独验证。
  options.argv.pop();
  const coordinator = createRestartReload(options);
  coordinator.observe(state.update);
  /** 返回本次真实临时目录。 */
  function getDirectory() { return directory; }
  /** 只返回当前仍存活的测试主窗。 */
  function getWindows() { return state.windows; }
  /** 返回最新候选版本，供最终阶段再次核对。 */
  function status() { return state.update; }
  /** 模拟源码预检或业务调用占用。 */
  function isBusy() { return state.busy; }
  /** 宿主任务是否空闲。 */
  function canApply() { return !state.busy; }
  /** 记录二次采集通知，不替页面自动确认。 */
  function notify(update) { state.notifications.push(update); }
  /** 记录真实磁盘异常，不吞掉错误。 */
  function failed(error) { state.errors.push(error); }
  /** 记录生产协调器传出的真实启动参数。 */
  function relaunch(value) { state.relaunches.push(value); }
  /** 记录是否已经请求退出。 */
  function quit() { state.quits++; }
  /** 构造明确属于当前版本的独立窗口状态。 */
  function snapshot(text) { return { revision: state.update.revision, tabs: [{ text }], composer: { text } }; }
  return { state, coordinator, first, second, directory, options, snapshot };
}

/** 双窗口晚到确认、阶段失效和新版本都不能使过期快照触发退出。 */
async function testVersionsAndBusy() {
  const s = sample();
  const c = s.coordinator;
  s.state.busy = true;
  check(!c.ready(s.first.win, 1, s.snapshot('甲'), 0).ok, '忙状态拒绝重启确认');
  s.state.busy = false;
  check(!c.ready({}, 1, s.snapshot('错误窗口'), 0).ok, '非主窗口不能代替其他窗口提交');
  check(c.ready(s.first.win, 1, s.snapshot('甲旧稿'), 0).ok, '首窗可就绪而不立即退出');
  await nextTurn();
  check(s.state.quits === 0 && s.state.relaunches.length === 0, '未收到另一窗回执时不重启');
  c.ready(s.second.win, 1, s.snapshot('乙旧稿'), 0);
  await nextTurn();
  check(c.phase() === 1 && s.state.notifications.at(-1).deferred, '全部就绪后要求二次采集');
  check(!c.ready(s.first.win, 1, s.snapshot('迟到旧稿'), 0).ok, '第一阶段的迟到回执不能充当最终快照');
  c.ready(s.first.win, 1, s.snapshot('甲新稿'), 1);
  c.ready(s.second.win, 1, s.snapshot('乙新稿'), 1);
  s.state.update = { kind: 'validating', revision: 2 };
  c.observe(s.state.update);
  await nextTurn();
  check(s.state.quits === 0 && s.state.relaunches.length === 0, '最终退出之前出现新保存会取消旧版本');
  s.state.update = { kind: 'restart', revision: 3, phase: 0 };
  c.observe(s.state.update);
  check(!c.ready(s.first.win, 1, { revision: 1 }, 0).ok, '旧版本确认不能触发新候选');
  fs.rmSync(s.directory, { recursive: true, force: true });
}

/** 双阶段真实交接使用最新状态、保留参数，并只在各自恢复成功后消费快照。 */
async function testHandoff() {
  const s = sample();
  const c = s.coordinator;
  c.ready(s.first.win, 1, s.snapshot('甲旧'), 0);
  c.ready(s.second.win, 1, s.snapshot('乙旧'), 0);
  await nextTurn();
  c.observe({ kind: 'data', revision: 10 });
  c.observe({ kind: 'runtime', revision: 11 });
  check(c.phase() === 1, '资料与其他业务成功通知不会撤销正在等待的最终采集');
  c.ready(s.first.win, 1, s.snapshot('甲最新'), 1);
  c.ready(s.second.win, 1, s.snapshot('乙最新'), 1);
  await nextTurn();
  check(s.state.relaunches.length === 1 && s.state.quits === 1, '全部最终回执后才恰好安排一次重启');
  c.check();
  await nextTurn();
  check(s.state.relaunches.length === 1, '重复空闲事件不会安排第二次重启');
  const args = s.state.relaunches[0].args;
  check(args.includes('entry.cjs') && args.includes('--user-flag'), '自动重启保留原有入口与用户启动参数');
  const restored = createRestartReload(Object.assign({}, s.options, { argv: ['electron', ...args] }));
  check(JSON.stringify(restored.layouts()) === JSON.stringify(['window-a', 'window-b']), '交接保留明确的原窗口组身份');
  check(restored.snapshot('window-a').composer.text === '甲最新' && restored.snapshot('window-b').composer.text === '乙最新', '双窗恢复使用最终采集的各自最新草稿');
  check(restored.snapshot('window-a').revision === 0, '新进程版本空间重新开始，不沿用旧进程序号屏蔽新更新');
  restored.restored('window-a');
  check(restored.snapshot('window-b').composer.text === '乙最新' && fs.readdirSync(s.directory).length === 1, '一窗确认不提前删除另一窗的交接快照');
  restored.restored('window-b');
  check(fs.readdirSync(s.directory).length === 0, '最后一窗恢复成功后才消费完交接文件');
  fs.rmSync(s.directory, { recursive: true, force: true });
}

/** 保存失败时保留原进程并报告原始异常，不能先退出再声称保存成功。 */
async function testWriteFailure() {
  const s = sample();
  const c = s.coordinator;
  c.ready(s.first.win, 1, s.snapshot('甲'), 0);
  c.ready(s.second.win, 1, s.snapshot('乙'), 0);
  await nextTurn();
  fs.rmSync(s.directory, { recursive: true });
  fs.writeFileSync(s.directory, '此路径是文件，不能作为交接目录', 'utf8');
  c.ready(s.first.win, 1, s.snapshot('甲最终'), 1);
  c.ready(s.second.win, 1, s.snapshot('乙最终'), 1);
  await nextTurn();
  check(s.state.errors.length === 1 && s.state.quits === 0 && s.state.relaunches.length === 0, '真实交接写盘失败会报告且不退出、不启动新进程');
  fs.unlinkSync(s.directory);
}

/** 按顺序验证，全部通过才报告本次断言数量。 */
async function main() {
  await testVersionsAndBusy();
  await testHandoff();
  await testWriteFailure();
  process.stdout.write('自动重启状态行为断言：' + checks + '；失败：0\n');
}
/** 顶层异常保留诊断与非零退出码。 */
function failed(error) { process.stderr.write(error.stack + '\n'); process.exitCode = 1; }
main().catch(failed);
