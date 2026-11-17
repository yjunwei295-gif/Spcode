/**
 * 将源码更新通知排到界面空闲后执行，保留单次页面重载所需的临时快照。
 * 所有窗口、存储和 IPC 操作由调用方注入；模块本身不写会话文件、不取消正在执行的任务。
 * @param {object} options 宿主回调集合；isBusy() 同步返回是否有未完成任务；saveSnapshot(revision)
 * 同步保存指定版本的一次性快照，clearSnapshot() 同步清除取消的快照；ready(revision) 返回
 * Promise<{ok:boolean}>，只有主进程确认可重载才返回 ok=true；refreshMetadata(update) 异步刷新资料；
 * showStatus(message, failed) 同步更新状态提示，reportError(message, detail) 同步记录诊断。
 * 各回调不得自行触发另一次页面重载；快照、确认与初始化的执行顺序由本控制器管理。
 * @returns {{receive: function(object): Promise<void>, retry: function(): Promise<void>, initialize: function(number): Promise<void>}}
 * receive(update) 接收主进程有序通知；retry() 在任务收尾时重试待加载版本；initialize(restoredRevision)
 * 在窗口状态恢复完成后启用重载，restoredRevision 是恢复快照的版本，无快照时由宿主传入 0。
 */
export function createHotReloadController(options) {
  let initialized = false;
  let receivedRevision = 0;
  let pending = null;
  let applying = false;
  let accepted = false;
  let failedRevision = null;
  let cancellationVersion = 0;
  let pendingMetadata = null;

  /** 显示更新失败并保留诊断；失败时禁止把页面重载当成已经生效。 */
  function reportFailure(message, error) {
    options.showStatus(message, true);
    options.reportError(message, { message: String(error && (error.message || error)) });
  }

  /**
   * 只在初始化完成且所有界面任务空闲时保存一次性快照，再请求主进程确认重载。
   * @returns {Promise<void>} 等待实际 IPC；取消或失效后的成功/失败回执均不改变新版本状态。
   * 普通忙状态只等待宿主下一次空闲通知，不建立自动轮询或恢复旧候选。
   */
  async function retry() {
    if (!initialized || applying || accepted || !pending || pending.revision === failedRevision || options.isBusy()) return;
    const update = pending;
    const confirmationVersion = cancellationVersion;
    applying = true;
    try {
      options.saveSnapshot(update.revision);
      const result = await options.ready(update.revision);
      if (confirmationVersion === cancellationVersion && pending === update) {
        if (result.ok) {
          accepted = true;
          options.showStatus('正在加载更新后的界面…', false);
        } else {
          options.clearSnapshot();
          options.showStatus('更新已排队，等待软件空闲后加载', false);
        }
      }
      // 已被新保存或错误取消的 IPC 回执不得恢复 accepted、覆盖错误提示或触碰新版本快照。
    } catch (error) {
      if (confirmationVersion === cancellationVersion && pending === update) {
        failedRevision = update.revision;
        reportFailure('热重载失败，本次更新尚未加载：' + String(error.message || error), error);
      }
    } finally {
      applying = false;
    }
    // 仅在确认期间出现新版本或主进程明确取消确认时补一次尝试，不对普通拒绝持续轮询。
    if (!accepted && pending && (pending.revision !== update.revision || confirmationVersion !== cancellationVersion)) await retry();
  }

  /** 在初始化恢复完成后刷新资料；加载失败保留明确提示，不覆盖恢复中的标签与草稿。 */
  async function refreshMetadata(update) {
    try {
      await options.refreshMetadata(update);
      options.showStatus(update.message, false);
    } catch (error) {
      reportFailure('更新资料加载失败：' + String(error.message || error), error);
    }
  }

  /**
   * 接收有序的更新通知；业务模块更新刷新资料，预检通过的界面版本才请求真正重载。
   * @param {object} update 主进程产生的 kind/revision/paths/message；旧版本普通通知忽略。
   * @returns {Promise<void>} 新保存或错误撤销旧候选和快照，重复有效版本仅按空闲条件重试。
   */
  async function receive(update) {
    if (update && update.kind === 'renderer' && pending && update.revision === pending.revision) {
      // 主进程第二次空闲检查可以取消已接受的重载；撤销的是过期快照，不改变任何源码或会话文件。
      if (update.deferred === true) {
        accepted = false;
        cancellationVersion++;
        try {
          options.clearSnapshot();
          options.showStatus('更新已排队，等待软件空闲后加载', false);
        } catch (error) {
          failedRevision = update.revision;
          reportFailure('无法清理已取消的热重载快照：' + String(error.message || error), error);
          return;
        }
      }
      // 普通补发仅使尚未确认的版本重试；已经 accepted 的常规重复通知仍由 retry 去重。
      return retry();
    }
    if (!update || update.revision <= receivedRevision) return;
    receivedRevision = update.revision;
    if (update.kind === 'renderer') {
      if (pending || accepted) cancelPending();
      pending = update;
      failedRevision = null;
      options.showStatus('界面更新已排队，空闲后自动加载', false);
      await retry();
      return;
    }
    if (update.kind === 'runtime' || update.kind === 'data') {
      if (!initialized) {
        pendingMetadata = update;
        return;
      }
      await refreshMetadata(update);
      return;
    }
    if (update.kind === 'validating' || update.kind === 'restart' || update.kind === 'error') {
      cancelPending();
      if (update.kind === 'validating') {
        options.showStatus(update.message, false);
        return;
      }
      options.showStatus(update.message, true);
      options.reportError(update.message, { kind: update.kind, paths: update.paths, revision: update.revision });
    }
  }

  /**
   * 撤销旧候选及一次性快照，使在途 ready 的成功回执不能复活已失效版本。
   * @returns {void} 只清除热重载状态和临时快照，不取消模型任务或写入会话文件。
   */
  function cancelPending() {
    pending = null;
    accepted = false;
    failedRevision = null;
    cancellationVersion++;
    try { options.clearSnapshot(); }
    catch (error) { reportFailure('无法清理已取消的热重载快照：' + String(error.message || error), error); }
  }

  /** 启动时排除已经用于恢复本页的版本，避免主进程补发同一通知造成重载循环。 */
  async function initialize(restoredRevision) {
    receivedRevision = Math.max(receivedRevision, restoredRevision);
    if (pending && pending.revision <= restoredRevision) pending = null;
    initialized = true;
    if (pendingMetadata && pendingMetadata.revision > restoredRevision) await refreshMetadata(pendingMetadata);
    pendingMetadata = null;
    await retry();
  }

  return { receive, retry, initialize };
}

/** 从当前窗口读取并消费一次性快照；只用于同一页面的重载，不改变自动保存偏好。 */
export function takeHotReloadSnapshot(storage) {
  const source = storage.getItem('spcode:hot-reload');
  if (source === null) return null;
  const snapshot = JSON.parse(source);
  storage.removeItem('spcode:hot-reload');
  return snapshot;
}
