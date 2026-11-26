'use strict';

/**
 * 页面重载后的轮次接回数据仓库。
 *
 * 用途：主进程每一轮 chat:send 真正发生之后，把发给本窗口的聊天事件按递增序号留一份，
 * 并在轮次收工时留下最终结果；重载后的新页面据此补齐事件、等原轮次收尾后直接写回结果，
 * 从而不需要重发 chat:send、也不会重跑工具。
 *
 * 设计原因：
 * 1. 记录按主窗对象分开，别的窗口、别的标签、别的会话取不到，避免串会话。
 * 2. 序号在「真正发往界面」那一刻生成，界面把处理过的最大序号记在答复上，
 *    重载后只补序号更大的事件，既不丢事件也不重复追加正文。
 * 3. 页面定时交回已处理的气泡并回收相应事件。完整终态保留到该窗口确认消费。
 * 4. 等结果的 Promise 一定会有结局：收工、标签关闭、窗口关闭都会兑现，页面不会永远挂着。
 */



/**
 * 把一条记录整理成可跨 IPC 传递的明文快照。
 * @param {object} record 内部记录。
 * @returns {object} 不含内部 Promise 队列的快照；事件数组做浅拷贝。
 */
function snapshotOf(record) {
  return {
    turnId: record.turnId,
    tabId: record.tabId,
    modelId: record.modelId,
    runId: record.runId,
    resident: record.resident,
    // 发送时的原标签起始状态：自动保存关闭或会话文件较旧时，新页面靠它把整轮补回来。
    seed: record.seed,
    finished: record.finished,
    outcome: record.outcome,
    result: record.result,
    error: record.error,
    events: record.events.slice()
  };
}

/**
 * 创建一份独立的接回数据仓库；每个进程只建一份，按窗口区分。
 * @returns {object} 提供 open/append/finish/snapshot/wait/release/forgetTab/hasResident/dropWindow/size。
 */
function createTurnRecovery() {
  // 键是主窗对象本身：窗口对象唯一，关闭时能立刻按它清干净，不会和新建窗口混淆。
  const byWindow = new Map();

  /**
   * 取某个窗口的记录数组；没有就建一个空数组并登记。
   * @param {object} win 主窗对象。
   * @returns {Array} 该窗口的轮次记录数组，按开工先后排列，新的在后面。
   */
  function bucketOf(win) {
    let list = byWindow.get(win);
    if (!list) {
      list = [];
      byWindow.set(win, list);
    }
    return list;
  }

  /**
   * 兑现某一轮所有在等的 Promise，保证页面重载后不会永远挂着。
   * @param {object} record 内部记录。
   * @param {object} terminal 交付给界面收尾用的结局；缺字段时沿用记录本身的值。
   * @returns {void} 只调用 Promise 的 resolve，不改记录状态。
   */
  function settleWaiters(record, terminal) {
    const waiters = record.waiters;
    record.waiters = [];
    for (const resolve of waiters) resolve(terminal);
  }

  /**
   * 按原窗口登记轮次；所有仍待处理的标签均可接回。
   * @param {object} win 本轮所属窗口。
   * @param {object} info 开工信息，含 turnId、tabId、modelId、runId、resident、seed。
   * @returns {object|null} 本轮记录；缺少窗口或轮次编号时返回 null，
   * 调用方的 append/finish 收到 null 会直接跳过，不影响原有发送流程。
   */
  function open(win, info) {
    if (!win) return null;
    const turnId = String((info && info.turnId) || '');
    if (!turnId) return null;
    const list = bucketOf(win);
    // 同一轮次重复开工时沿用原记录，防止界面拿到两份互相矛盾的快照。
    for (const one of list) {
      if (one.turnId === turnId) return one;
    }
    const record = {
      turnId: turnId,
      tabId: String((info && info.tabId) || ''),
      modelId: String((info && info.modelId) || ''),
      runId: info && info.runId ? String(info.runId) : '',
      resident: !!(info && info.resident),
      seed: (info && info.seed) || null,
      startedAt: Date.now(),
      nextSeq: 1,
      events: [],
      finished: false,
      outcome: 'running',
      result: null,
      error: '',
      // 由执行方在 finally 里写：这一轮是不是被用户停掉的。
      stopped: false,
      // 等最终结局的界面 Promise；收工时逐个兑现。
      waiters: []
    };
    list.push(record);
    return record;
  }

  /**
   * 把一条即将发往界面的事件追加进记录，并补上严格递增的序号。
   * @param {object} record open 返回的记录；为空时原样返回事件，不做登记。
   * @param {object} event 主进程要发给渲染层的聊天事件。
   * @returns {object} 带 seq 的事件副本；收工后的事件不再登记。
   * 副作用：记录内的 nextSeq 前进，事件数组追加一项。
   */
  function append(record, event) {
    if (!record || !event) return event;
    // 收工之后到达的事件一律不补：界面按最终结果收尾，补进去反而会重复。
    if (record.finished) return event;
    const stamped = Object.assign({}, event, { seq: record.nextSeq });
    record.nextSeq += 1;
    record.events.push(structuredClone(stamped));
    return stamped;
  }

  /**
   * 记录一轮的收工状态与最终结果，并兑现所有在等结局的界面 Promise。
   * @param {object} record open 返回的记录；为空时什么都不做。
   * @param {string} outcome 收工结果，取值 success / stopped / error。
   * @param {object} payload 收工数据：success 时带 result，停止或失败时带 error 文字。
   * @returns {void} 只改记录并兑现等待者，不向界面发消息。
   */
  function finish(record, outcome, payload) {
    if (!record) return;
    if (record.finished) return;
    record.finished = true;
    record.outcome = outcome === 'success' || outcome === 'stopped' ? outcome : 'error';
    record.result = payload?.result;
    record.error = String((payload && payload.error) || '');
    const terminal = {
      turnId: record.turnId,
      finished: true,
      outcome: record.outcome,
      result: record.result,
      error: record.error
    };
    settleWaiters(record, terminal);
  }

  /**
   * 取某个窗口当前未消费的轮次快照；渲染层重载后用它接回。
   * @param {object} win 主窗对象。
   * @returns {Array<object>} 轮次快照数组；没有记录时返回空数组。
   */
  function snapshot(win) {
    const list = byWindow.get(win) || [];
    const out = [];
    for (const one of list) out.push(snapshotOf(one));
    return out;
  }

  /**
   * 等某一轮的最终结局，供重载后的新页面收尾；不发起任何模型调用。
   * @param {object} win 主窗对象。
   * @param {string} turnId 轮次编号。
   * @returns {Promise<object>} 结局对象，含 finished、outcome，正常结束还带 result。
   * 记录已经收工时立刻兑现；记录不存在时按「已释放」返回，界面据此报错而不是假装成功。
   */
  function wait(win, turnId) {
    const id = String(turnId || '');
    const list = byWindow.get(win) || [];
    let record = null;
    for (const one of list) {
      if (one.turnId === id) {
        record = one;
        break;
      }
    }
    if (!record) {
      return Promise.resolve({ turnId: id, finished: true, outcome: 'error', error: '这一轮的恢复数据已释放', released: true });
    }
    if (record.finished) {
      return Promise.resolve({
        turnId: record.turnId, finished: true, outcome: record.outcome, result: record.result, error: record.error
      });
    }
    return new Promise(function enqueue(resolve) {
      record.waiters.push(resolve);
    });
  }

  /**
   * 界面已经消费完某一轮的恢复数据，释放掉它。
   * @param {object} win 主窗对象。
   * @param {string} turnId 已消费的轮次编号；为空时不删任何记录。
   * @returns {boolean} 真的删掉了一份记录时返回 true。
   */
  function release(win, turnId) {
    const id = String(turnId || '');
    if (!id) return false;
    const list = byWindow.get(win);
    if (!list) return false;
    for (let i = 0; i < list.length; i++) {
      if (list[i].turnId !== id) continue;
      const removed = list.splice(i, 1)[0];
      // 还有界面在等这一轮时立刻兑现，别让页面挂住。
      settleWaiters(removed, { turnId: removed.turnId, finished: true, outcome: 'stopped', released: true });
      if (!list.length) byWindow.delete(win);
      return true;
    }
    return false;
  }

  /**
   * 标签关闭时丢掉它名下的恢复数据，避免别的标签或新会话误接。
   * @param {object} win 主窗对象。
   * @param {string} tabId 已关闭的标签编号。
   * @returns {number} 实际释放的轮次条数。
   */
  function forgetTab(win, tabId) {
    const id = String(tabId || '');
    const list = byWindow.get(win);
    if (!id || !list) return 0;
    let removed = 0;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].tabId !== id) continue;
      const one = list.splice(i, 1)[0];
      settleWaiters(one, { turnId: one.turnId, finished: true, outcome: 'stopped', dropped: true });
      removed += 1;
    }
    if (!list.length) byWindow.delete(win);
    return removed;
  }

  /**
   * 这个窗口是否还有仍在执行的常驻（长时存活）轮次。
   * @param {object} win 主窗对象。
   * @returns {boolean} 只要常驻轮次的归档尚未确认即返回 true，页面在收工间隙重载也能归档。
   */
  function hasResident(win) {
    const list = byWindow.get(win) || [];
    for (const one of list) {
      if (one.resident) return true;
    }
    return false;
  }

  /**
   * 窗口关闭时清掉它的全部记录，避免残留事件长期占用内存。
   * @param {object} win 即将关闭的主窗对象。
   * @returns {void} 无返回；重复调用无副作用。
   */
  function dropWindow(win) {
    const list = byWindow.get(win);
    if (!list) return;
    for (const one of list) {
      settleWaiters(one, { turnId: one.turnId, finished: true, outcome: 'stopped', dropped: true });
    }
    byWindow.delete(win);
  }

  /**
   * 当前留存的记录总条数，供自检与测试核对释放是否生效。
   * @returns {number} 所有窗口的记录总条数。
   */
  function size() {
    let total = 0;
    for (const list of byWindow.values()) total += list.length;
    return total;
  }

  /**
   * 接收本窗口已经绘制的回复状态，释放其序号以前的日志。
   * checkpoint.messages 从当前回复开始，包含此后接收的插话。未交付至页面的事件仍需保留。
   */
  function checkpoint(win, turnId, update) {
    const message = update.messages[0];
    for (const record of byWindow.get(win) || []) {
      if (record.turnId !== turnId || record.finished || !record.seed) continue;
      const index = record.seed.messages.findIndex(function sameReply(item) { return item.role === 'assistant' && item.turnId === turnId; });
      if (index < 0 || message.turnId !== turnId || message.turnSeq < (record.seed.messages[index].turnSeq || 0)) return;
      record.seed.messages.splice(index, record.seed.messages.length - index, ...update.messages);
      record.seed.workingMemory = update.workingMemory;
      record.seed.parallelTasks = update.parallelTasks;
      record.seed.queue = update.queue;
      record.events = record.events.filter(function unprocessed(event) { return event.seq > message.turnSeq; });
      return;
    }
  }

  return { open, append, finish, snapshot, checkpoint, wait, release, forgetTab, hasResident, dropWindow, size };
}

module.exports = { createTurnRecovery };
