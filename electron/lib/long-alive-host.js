/**
 * 将长时存活调度接入主进程的真实会话、IPC 和停止流程。
 * 一个窗口仅绑定一个长期任务，窗口关闭、渲染退出或页面重载都会释放实例。
 */
const path = require('path');
const { createLongAlive, DEFAULTS } = require('./long-alive');

/** 注册一次 IPC；窗口和会话由发送者确定，禁止跨窗口接收执行回执。 */
function registerLongAlive(env) {
  const entries = new Map();

  /** 当前内存快照包含主进程堆、外部内存和 Electron 子进程，不在内存累积曲线。 */
  function metrics() {
    const mem = process.memoryUsage();
    return { at: Date.now(), rss: mem.rss, heapUsed: mem.heapUsed,
      external: mem.external, arrayBuffers: mem.arrayBuffers,
      processes: env.app.getAppMetrics() };
  }

  /** 取得已绑定实例；未绑定时拒绝开始、完成等写操作。 */
  function entryOf(win) {
    const entry = entries.get(win);
    if (!entry) throw new Error('请先打开长时存活面板');
    return entry;
  }

  /** 绑定或恢复当前会话；另一个会话仍在停止时不并行创建新调度器。 */
  function bind(win, payload) {
    let entry = entries.get(win);
    if (!entry) {
      entry = { controller: null };
      /** 桌面执行全局串行；切走目标标签、项目变化或手动轮次运行时只等待。 */
      function ready(state) {
        if (win.isDestroyed() || env.activeTab(win) !== state.sessionId ||
            env.workspace(win) !== state.workspace || env.busy()) return false;
        for (const other of entries.values()) {
          if (other !== entry && other.controller.snapshot()?.active) return false;
        }
        return true;
      }
      /** 主进程只推送短载荷，渲染层在模型发送前再次确认这一投递仍有效。 */
      function dispatch(task) { env.send(win, 'long-alive:task', task); }
      /** 与主界面停止按钮使用同一份取消逻辑。 */
      function cancel(turnId) { env.abort(win, turnId); }
      /** 状态事件覆盖当前快照，界面不追加心跳聊天记录。 */
      function notify(state) { env.send(win, 'long-alive:state', state); }
      entry.controller = createLongAlive({
        dir: path.join(env.app.getPath('userData'), 'long-alive'),
        ready, dispatch, cancel, notify, metrics
      });
      entries.set(win, entry);
    }
    const current = entry.controller.snapshot();
    if (current && current.sessionId !== payload.tabId && current.active) {
      entry.controller.stop('切换会话，长时存活已暂停');
      return entry.controller.snapshot();
    }
    return entry.controller.bind(payload.tabId, payload.workspace);
  }

  /** 窗口/页面生命周期结束时断开调度；移除 Map 强引用，避免关闭窗口仍被保留。 */
  function release(win) {
    const entry = entries.get(win);
    if (!entry) return;
    entry.controller.dispose();
    entries.delete(win);
  }

  /** 开启前检查同一会话没有在另一个窗口运营，避免重复发布。 */
  function start(event, payload) {
    const win = env.getWin(event);
    const controller = entryOf(win).controller;
    const current = controller.snapshot();
    if (current.sessionId !== payload.tabId) throw new Error('当前会话尚未绑定');
    for (const [otherWin, other] of entries) {
      const task = other.controller.snapshot();
      if (otherWin !== win && task && task.sessionId === current.sessionId && (task.enabled || task.active)) {
        throw new Error('这个会话已在另一窗口运行');
      }
    }
    return controller.start(payload);
  }

  /** 停止只作用于发起窗口绑定的任务；不取消其它会话的手动操作。 */
  function stop(event) { return entryOf(env.getWin(event)).controller.stop(); }
  /** 模型启动前接收真实 turnId；旧投递或关闭后的投递直接拒绝。 */
  function accept(event, payload) {
    const entry = entries.get(env.getWin(event));
    return !!entry && entry.controller.accept(payload.runId, payload.turnId);
  }
  /** 一轮结束才安排下次检查；完整结果先落盘，写盘异常明确返回给界面。 */
  function finish(event, payload) {
    const entry = entries.get(env.getWin(event));
    return !!entry && entry.controller.finish(payload.runId, payload);
  }
  /** 状态读取同时采样当前进程；关闭面板后没有残留轮询计时器。 */
  function status(event) {
    return { task: entries.get(env.getWin(event))?.controller.snapshot() || null, memory: metrics(), defaults: DEFAULTS };
  }
  /** 用户点击普通停止时同步关闭调度，防止下一次心跳又自行开工。 */
  function stopForAbort(win, turnId) {
    const entry = entries.get(win);
    if (!entry) return;
    const state = entry.controller.snapshot();
    if (!state || !state.enabled) return;
    if (!turnId || env.turnTab(turnId) === state.sessionId) entry.controller.stop();
  }
  /** 主进程退出时逐个释放，保留磁盘任务和日志，不启动额外守护进程。 */
  function dispose() { for (const win of entries.keys()) release(win); }

  env.ipcMain.handle('long-alive:bind', function bindFromWindow(event, payload) { return bind(env.getWin(event), payload); });
  env.ipcMain.handle('long-alive:start', start);
  env.ipcMain.handle('long-alive:stop', stop);
  env.ipcMain.handle('long-alive:accept', accept);
  env.ipcMain.handle('long-alive:finish', finish);
  env.ipcMain.handle('long-alive:status', status);
  /** 档案导图按页加载，筛选只改变后续上下文，不删除历史。 */
  env.ipcMain.handle('long-alive:records', function records(event, before) {
    return entryOf(env.getWin(event)).controller.records(before);
  });
  env.ipcMain.handle('long-alive:context', function context(event, rows) {
    return entryOf(env.getWin(event)).controller.setContext(rows);
  });
  /** 模型调用前再次核对投递，阻止停止后迟到的界面请求执行。 */
  function authorize(win, runId, turnId) {
    const entry = entries.get(win);
    return !!entry && entry.controller.authorized(runId, turnId);
  }
  return { release, dispose, stopForAbort, authorize };
}

module.exports = { registerLongAlive };
