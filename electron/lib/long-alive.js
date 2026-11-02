/**
 * 长时存活的单任务调度器。
 * 每个实例只绑定一个会话；仅保留配置、最近进度和一个在途轮次，完整执行记录追加到磁盘。
 * 定时器在上轮结束后安排；停止、超时、重新绑定均使旧投递失效，不重复执行未知结果。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

/** 首次打开的可调整参数与内存中进度长度上限；时间单位均为秒。 */
const DEFAULTS = Object.freeze({ intervalSeconds: 60, timeoutSeconds: 600, checkpointChars: 6000, recordPageSize: 20, maxContextRecords: 20 });

/**
 * 创建独立调度器；依赖由主进程注入，便于验证真实启停和资源回收。
 * dir 为持久化目录；ready 判断是否空闲，dispatch 投递任务，cancel 中止已接受的轮次。
 * notify 仅发送当前快照；metrics 返回当前内存数据，不累计采样数组。
 */
function createLongAlive(options) {
  const clock = options.clock || { now: Date.now, setTimeout, clearTimeout };
  let state = null;
  let file = '';
  let timer = null;
  let deadline = null;
  let active = null;
  let disposed = false;

  /** 返回不含任务对象或回调引用的快照；界面和磁盘都不保留执行上下文。 */
  function snapshot() {
    if (!state) return null;
    return { ...state, active: !!active, defaults: DEFAULTS };
  }

  /** 小状态文件先写临时文件再替换；写入失败向调用者报错，不伪装成功。 */
  function persist() {
    try {
      fs.mkdirSync(options.dir, { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(state), 'utf8');
      fs.renameSync(file + '.tmp', file);
    } catch (error) {
      // 实测 Windows 极端连续替换可返回 EPERM；明确停止，不自动重试或假装已保存。
      clearTimers();
      state.enabled = false;
      state.nextAt = null;
      state.status = active ? 'stopping' : 'paused';
      state.error = '任务状态写入失败：' + error.message;
      notify();
      if (active && active.turnId) options.cancel(active.turnId);
      throw error;
    }
  }

  /** 推送单份当前状态，不为每次心跳添加聊天消息或历史缓存。 */
  function notify() { options.notify(snapshot()); }

  /** 释放调度与超时计时器；不通过重启进程掩盖资源持有。 */
  function clearTimers() {
    if (timer !== null) clock.clearTimeout(timer);
    if (deadline !== null) clock.clearTimeout(deadline);
    timer = null;
    deadline = null;
  }

  /** 等待下一次检查；忙碌时只等待，不积压心跳队列。 */
  function schedule() {
    if (disposed || !state || !state.enabled || active || timer !== null) return;
    timer = clock.setTimeout(tick, Math.max(0, state.nextAt - clock.now()));
    if (timer.unref) timer.unref();
  }

  /** 停止调度并取消在途轮次；待旧轮真正结束前，禁止再次开启造成重叠。 */
  function stop(reason) {
    clearTimers();
    if (!state) return snapshot();
    state.enabled = false;
    state.nextAt = null;
    // 尚未接收的投递没有执行轮次；清除后其迟到回执会被拒绝。
    if (active && !active.turnId) active = null;
    state.status = active ? 'stopping' : 'paused';
    state.error = reason || '';
    persist();
    if (active && active.turnId) options.cancel(active.turnId);
    notify();
    return snapshot();
  }

  /** 绑定会话并恢复待命；异常退出时未完成的任务暂停，避免重复发布或回复。 */
  function bind(sessionId, workspace) {
    if (disposed) throw new Error('长时存活实例已释放');
    if (!sessionId || !workspace) throw new Error('请先打开项目和会话');
    if (state && state.sessionId === sessionId && state.workspace === workspace) return snapshot();
    if (state) stop('切换会话，长时存活已暂停');
    if (active) throw new Error('上一轮仍在停止，请等待执行结束');
    const key = crypto.createHash('sha256').update(sessionId).digest('hex');
    file = path.join(options.dir, key + '.json');
    state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {
      sessionId, workspace, goal: '', intervalSeconds: DEFAULTS.intervalSeconds,
      timeoutSeconds: DEFAULTS.timeoutSeconds, enabled: false, status: 'paused',
      nextAt: null, checkpoint: '', completed: 0, lastAt: null, error: ''
    };
    if (state.workspace !== workspace) throw new Error('长时存活任务所属项目不一致');
    if (state.status === 'running' || state.status === 'stopping') {
      state.enabled = false;
      state.nextAt = null;
      state.status = 'paused';
      state.error = '上次执行被中断，请核对平台实际结果后再开启';
      persist();
    }
    schedule();
    notify();
    return snapshot();
  }

  /** 保存目标与频率并开启；参数来自用户输入，不替用户补运营目标或账号。 */
  function start(config) {
    if (!state || disposed) throw new Error('尚未绑定会话');
    if (active) throw new Error('上一轮尚未结束');
    const goal = String(config.goal || '').trim();
    const intervalSeconds = Number(config.intervalSeconds);
    const timeoutSeconds = Number(config.timeoutSeconds);
    if (!goal) throw new Error('请填写长期目标和允许执行的范围');
    if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 86400) throw new Error('检查间隔须为 1～86400 秒');
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw new Error('单轮超时须为 1～86400 秒');
    clearTimers();
    Object.assign(state, { goal, intervalSeconds, timeoutSeconds, enabled: true,
      status: 'waiting', error: '', nextAt: clock.now() + intervalSeconds * 1000 });
    persist();
    schedule();
    notify();
    return snapshot();
  }

  /** 到期投递一轮；不读取整份对话，进度与目标构成固定大小的续做输入。 */
  function tick() {
    if (timer !== null) clock.clearTimeout(timer);
    timer = null;
    if (disposed || !state || !state.enabled || active) return;
    try {
      if (!options.ready(state)) {
        state.status = 'waiting';
        state.nextAt = clock.now() + state.intervalSeconds * 1000;
        schedule();
        return;
      }
      active = { id: crypto.randomUUID(), turnId: '', startedAt: clock.now() };
      state.status = 'running';
      state.nextAt = null;
      persist();
      deadline = clock.setTimeout(expired, state.timeoutSeconds * 1000);
      if (deadline.unref) deadline.unref();
      options.dispatch({ ...snapshot(), runId: active.id });
      notify();
    } catch (error) {
      stop(error.message);
    }
  }

  /** 超时明确暂停，不自动重试可能已经产生外部效果的操作。 */
  function expired() {
    deadline = null;
    stop('单轮执行超时，已请求停止；请核对实际执行结果');
  }

  /** 渲染层在调用模型前登记轮次；关闭后迟到的投递不可启动。 */
  function accept(runId, turnId) {
    if (!active || active.id !== runId || !state.enabled || active.turnId) return false;
    active.turnId = turnId;
    return true;
  }

  /** 记录完整结果到磁盘，内存只留有长度限制的最近进度；失败后暂停而非无限重试。 */
  function finish(runId, result) {
    if (!active || active.id !== runId) return false;
    const job = active;
    clearTimers();
    const text = String(result.text || '');
    const record = { n: (state.recordCount || 0) + 1, goal: state.goal, runId, startedAt: job.startedAt, endedAt: clock.now(),
      outcome: result.outcome, text, messages: result.messages, memory: options.metrics() };
    fs.appendFileSync(file + '.jsonl', JSON.stringify(record) + '\n', 'utf8');
    active = null;
    state.recordCount = record.n;
    state.lastAt = record.endedAt;
    state.memory = record.memory;
    // 没有真正执行的拒收回执不覆盖上次有效进度。
    if (text) {
      state.checkpoint = text.slice(-DEFAULTS.checkpointChars);
      state.checkpointRound = record.n;
      state.omitCheckpoint = false;
      state.checkpointTruncated = text.length > DEFAULTS.checkpointChars;
    }
    if (result.outcome === 'success') state.completed++;
    if (result.outcome !== 'success') {
      state.enabled = false;
      state.error = result.error || '本轮未完成，长时存活已暂停';
    }
    state.status = state.enabled ? 'waiting' : 'paused';
    state.nextAt = state.enabled ? clock.now() + state.intervalSeconds * 1000 : null;
    persist();
    notify();
    schedule();
    return true;
  }

  /** 关闭窗口或渲染进程退出时释放全部计时器和任务引用，磁盘记录继续保留。 */
  function dispose() {
    if (disposed) return;
    stop('窗口关闭或页面重载，长时存活已暂停');
    disposed = true;
    active = null;
  }

  /**
   * 按页读取已归档轮次，逐行扫描磁盘且最多保留一页预览。
   * before 是排他的轮次编号；完整记录仍在日志内，不把全部历史装进内存。
   */
  async function records(before) {
    if (!state) throw new Error('尚未绑定会话');
    const log = file + '.jsonl';
    const rows = [];
    if (!fs.existsSync(log)) return { rows, before: null };
    const stream = fs.createReadStream(log, { encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line) continue;
        const record = JSON.parse(line);
        if (before != null && record.n >= before) continue;
        rows.push({ n: record.n, title: String(record.goal || '').slice(0, 60),
          userText: record.goal, asstText: String(record.text || '').slice(-DEFAULTS.checkpointChars),
          outcome: record.outcome, endedAt: record.endedAt });
        if (rows.length > DEFAULTS.recordPageSize) rows.shift();
      }
    } finally {
      lines.close();
      stream.destroy();
    }
    return { rows, before: rows.length && rows[0].n > 1 ? rows[0].n : null };
  }

  /** 保存上下文导图选中的轮次；仅保留有限预览，排除记录不再进入模型请求。 */
  function setContext(rows) {
    if (!Array.isArray(rows) || rows.length > DEFAULTS.maxContextRecords) throw new Error('最多选择 ' + DEFAULTS.maxContextRecords + ' 轮上下文');
    const context = [];
    for (const row of rows) {
      if (!Number.isSafeInteger(row.n) || typeof row.userText !== 'string' || typeof row.asstText !== 'string') throw new Error('上下文轮次无效');
      context.push({ n: row.n, userText: row.userText.slice(0, DEFAULTS.checkpointChars),
        asstText: row.asstText.slice(-DEFAULTS.checkpointChars) });
    }
    /** 上下文跨页选择后仍保持原始轮次顺序。 */
    function compareRounds(left, right) { return left.n - right.n; }
    context.sort(compareRounds);
    state.context = context;
    state.omitCheckpoint = true;
    for (const row of context) if (row.n === state.checkpointRound) state.omitCheckpoint = false;
    persist();
    notify();
    return snapshot();
  }

  /** 只有仍启用且已登记的当前轮可以调用模型，旧回执不能穿过停止边界。 */
  function authorized(runId, turnId) {
    return !!active && state.enabled && active.id === runId && active.turnId === turnId;
  }
  return { bind, start, stop, accept, authorized, finish, snapshot, dispose, tick, records, setContext };
}

module.exports = { createLongAlive, DEFAULTS };
