'use strict';

/**
 * 为结构性代码更新协调自动重启：全部主窗空闲后重新采集快照，再交给新进程恢复。
 * 快照是一次性交接文件，独立于用户的自动保存设置；只有恢复成功的窗口才确认消费。
 */
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

/** 命令行只携带交接编号；用户数据路径由当前应用提供，不写死安装位置。 */
const ARGUMENT = '--spcode-code-reload=';

/**
 * 创建主进程重载协调器。
 * @param {object} options app 提供 relaunch/quit；directory 返回交接目录；argv 是真实启动参数；
 * windows 返回 {key,win} 的主窗清单；status/isBusy/canApply 查询更新与任务状态；
 * notify 广播同版本的二次采集通知；failed 将保存或重启失败交还更新状态通道。
 * @returns {object} observe/ready/check 管理两阶段确认；layouts/snapshot/restored 恢复并消费交接状态。
 * 不停止正在运行的任务，不以旧窗口的草稿代替另一窗口的数据。
 */
function createRestartReload(options) {
  let revision = null;
  let phase = 0;
  let scheduled = false;
  let committed = false;
  const receipts = new Map();
  let restored = null;
  let restoreFile = null;
  for (const argument of options.argv) {
    if (!argument.startsWith(ARGUMENT)) continue;
    const token = argument.slice(ARGUMENT.length);
    if (path.basename(token) !== token) throw new Error('代码重载交接编号无效');
    restoreFile = path.join(options.directory(), token + '.json');
    restored = JSON.parse(fs.readFileSync(restoreFile, 'utf8'));
  }

  /**
   * 观察更新通知；新版本和校验失败撤销此前的窗口回执。
   * @param {object} update 主更新器生成的真实通知，只有 restart 可进入重启流程。
   * @returns {void} 不启动计时轮询；当前版本的重复空闲通知保留已确认窗口。
   */
  function observe(update) {
    if (update.kind === 'runtime' || update.kind === 'data') return;
    if (update.kind === 'restart' && revision === update.revision) return;
    revision = update.kind === 'restart' ? update.revision : null;
    phase = 0;
    receipts.clear();
  }

  /**
   * 确认一个空闲主窗，第一阶段仅表示准备就绪，第二阶段必须重新采集最新草稿。
   * @param {object} win IPC 所属主窗；snapshot 是该窗当前完整临时状态；requestedPhase 区分两次采集。
   * @param {number} requestedRevision 页面确认的更新版本，旧版本不能触发新版本重启。
   * @returns {{ok:boolean}} 接受后仍须等待所有窗口和主进程空闲；非主窗或失效版本返回 false。
   */
  function ready(win, requestedRevision, snapshot, requestedPhase) {
    const update = options.status();
    if (!update || update.kind !== 'restart' || update.revision !== requestedRevision || revision !== requestedRevision || requestedPhase !== phase) return { ok: false };
    if (!options.canApply() || options.isBusy()) return { ok: false };
    let owner = null;
    for (const item of options.windows()) if (item.win === win) owner = item;
    if (!owner || !snapshot || snapshot.revision !== requestedRevision) return { ok: false };
    receipts.set(owner.key, snapshot);
    check();
    return { ok: true };
  }

  /**
   * 在窗口确认或关闭后核对完整清单，并于下一事件循环执行阶段切换。
   * @returns {void} 第一轮完成后要求所有窗口重新采集，避免等待其他窗口时保存了过期草稿。
   */
  function check() {
    if (scheduled || committed || revision === null) return;
    const owners = options.windows();
    if (!owners.length) return;
    for (const owner of owners) if (!receipts.has(owner.key)) return;
    scheduled = true;
    setImmediate(advance);
  }

  /**
   * 再次检查真实更新版本、任务和窗口数量；全部满足才写交接文件并安排 relaunch。
   * @returns {void} 保存或 relaunch 抛错时不退出，异常通过 failed 明确显示；源码不被还原。
   */
  function advance() {
    scheduled = false;
    const update = options.status();
    if (!update || update.kind !== 'restart' || update.revision !== revision) return;
    if (!options.canApply() || options.isBusy()) {
      receipts.clear();
      phase = 0;
      options.notify(Object.assign({}, update, { deferred: true, phase }));
      return;
    }
    const owners = options.windows();
    if (!owners.length) return;
    for (const owner of owners) if (!receipts.has(owner.key)) return;
    if (phase === 0) {
      phase = 1;
      receipts.clear();
      options.notify(Object.assign({}, update, { deferred: true, phase }));
      return;
    }
    try {
      const token = randomUUID();
      const windows = [];
      for (const owner of owners) {
        const snapshot = Object.assign({}, receipts.get(owner.key), { revision: 0 });
        windows.push({ key: owner.key, snapshot });
      }
      fs.mkdirSync(options.directory(), { recursive: true });
      fs.writeFileSync(path.join(options.directory(), token + '.json'), JSON.stringify({ windows }), { encoding: 'utf8', mode: 0o600 });
      const args = [];
      for (const argument of options.argv.slice(1)) if (!argument.startsWith(ARGUMENT)) args.push(argument);
      args.push(ARGUMENT + token);
      options.app.relaunch({ args });
      committed = true;
      options.app.quit();
    } catch (error) {
      committed = false;
      receipts.clear();
      revision = null;
      options.failed(error);
    }
  }

  /** 返回本次交接明确指定的窗口身份；普通启动返回 undefined，沿用常规窗口恢复。 */
  function layouts() {
    if (!restored) return undefined;
    const keys = [];
    for (const item of restored.windows) keys.push(item.key);
    return keys;
  }

  /** 按稳定窗口身份读取临时快照；未包含该窗时返回 null，绝不混用其他窗口状态。 */
  function snapshot(key) {
    if (!restored) return null;
    for (const item of restored.windows) if (item.key === key) return item.snapshot;
    return null;
  }

  /**
   * 页面实际恢复成功后消费其快照；最后一窗确认时删除一次性交接文件。
   * @param {string} key 已恢复窗口的稳定身份；重复确认不再次写盘。
   * @returns {void} 中途恢复失败的窗口仍保留原始交接数据，便于明确诊断。
   */
  function restoredWindow(key) {
    if (!restored) return;
    const remaining = [];
    for (const item of restored.windows) if (item.key !== key) remaining.push(item);
    if (remaining.length === restored.windows.length) return;
    restored.windows = remaining;
    if (remaining.length) fs.writeFileSync(restoreFile, JSON.stringify(restored), 'utf8');
    else {
      fs.unlinkSync(restoreFile);
      restored = null;
    }
  }

  /** 返回当前采集阶段，供初始化补取通知与重复空闲通知保持一致。 */
  function currentPhase() { return phase; }

  return { observe, ready, check, layouts, snapshot, restored: restoredWindow, phase: currentPhase };
}

module.exports = { createRestartReload };
