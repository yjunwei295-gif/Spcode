/**
 * 按插话编号合并回执与聊天事件的工作记忆。已看只增不减，早到的终态不能被晚到的待办快照覆盖。
 * @param {Array<object>} current 标签最新账本。@param {Array<object>} incoming 当前事件的记录。
 * @returns {Array<object>} 保留原有顺序并追加新插话的账本。
 */
export function mergeInterjectionItems(current = [], incoming = []) {
  const items = new Map();
  for (const item of current) items.set(item.id, item);
  for (const item of incoming) {
    const old = items.get(item.id);
    const merged = { ...old, ...item };
    if (old?.seen) merged.seen = true;
    if (old?.status === 'completed' || old?.status === 'cancelled') merged.status = old.status;
    items.set(item.id, merged);
  }
  return Array.from(items.values());
}

/** 将冷启动回执合入当前账本。只需知悉的待办可结项，核对期间新增或已终结的事项保留原状态。 */
export function applyRestartReceipt(current, receipt) {
  const seen = new Set(receipt.seenIds);
  const acknowledged = new Set(receipt.acknowledgedIds);
  return current.map(function mark(item) {
    if (!seen.has(item.id)) return item;
    if (item.status === 'pending' && acknowledged.has(item.id)) return { ...item, seen: true, status: 'completed' };
    return item.seen ? item : { ...item, seen: true };
  });
}

/** 保存用户已经提交但还在排队的需求，桌面观察与常驻心跳由各自的宿主管理。 */
export function submittedQueue(queue = []) {
  return queue.filter(function userItem(item) { return item.source !== 'screen' && item.source !== 'long-alive'; });
}

/**
 * 按原轮次、完整概要和提交次序把旧账本与聊天存档里的附件配对。
 * 同轮同文的记录连已办项一起计数。条数对不上时不猜配，新账本仍有按编号保存的附件引用。
 * @param {object} tab 恢复的会话标签。@returns {Map} 插话编号对应的原附件，包括主窗已保存的像素。
 */
function restoredPictures(tab) {
  const groups = new Map();
  const pictures = new Map();
  for (const item of tab.workingMemory?.interjectionTodos || []) {
    // 新记录以收件字段区分纯文字；只有旧格式需要从宿主追加的附件行识别。
    const hasPictures = item.attachments ? item.attachments.length > 0 : /(?:^|\n)【插话附件】[^\n]+$/.test(item.text);
    if (!hasPictures) continue;
    const key = JSON.stringify([item.turnId, item.text]);
    if (!groups.has(key)) groups.set(key, { items: [], messages: [] });
    groups.get(key).items.push(item);
    pictures.set(item.id, item.attachments || []);
  }
  const prefix = '你（插话·已提交）：';
  let turnId;
  for (const message of tab.messages || []) {
    if (message.role === 'user') turnId = undefined;
    if (message.role === 'assistant') turnId = message.turnId;
    if (message.role !== 'system' || !message.text?.startsWith(prefix) || !message.attachments?.length) continue;
    const names = message.attachments.map(function name(file) { return file.name; });
    const text = [message.text.slice(prefix.length).trim(), '【插话附件】' + names.join('、')].filter(Boolean).join('\n');
    const group = groups.get(JSON.stringify([turnId, text]));
    if (group) group.messages.push(message);
  }
  for (const group of groups.values()) {
    if (group.items.length !== group.messages.length) continue;
    for (const [index, item] of group.items.entries()) {
      const message = group.messages[index];
      if (item.attachments && !item.attachments.every(function matches(file, i) {
        return file.path === message.attachments[i]?.path;
      })) continue;
      const files = [];
      for (const [i, file] of message.attachments.entries()) {
        const pixels = message.images?.[i];
        if (pixels?.startsWith('data:image/')) files.push({ name: file.name, dataUrl: pixels });
        else files.push(file);
      }
      pictures.set(item.id, files);
    }
  }
  return pictures;
}

/**
 * 从刚恢复的标签提取交给会话模型的完整未办清单。无待办时返回 null。
 * 插话使用独立账本，系统通知和未提交草稿不进入清单。用户原需求按提交和回复的配对判断。
 * @param {object} tab 已从磁盘或进程交接快照恢复的标签。
 */
export function collectPendingReview(tab) {
  const memory = tab.workingMemory || {};
  const interjections = [];
  const pictures = restoredPictures(tab);
  for (const item of memory.interjectionTodos || []) {
    if (item.status !== 'pending') continue;
    const entry = { id: item.id, text: item.text };
    if (pictures.has(item.id)) entry.attachments = pictures.get(item.id);
    interjections.push(entry);
  }
  const todos = [];
  for (const item of memory.todos || []) {
    if (item.status === 'pending' || item.status === 'in_progress') todos.push({ content: item.content, status: item.status });
  }
  const openQuestions = (memory.openQuestions || []).filter(function nonEmpty(text) { return text.trim(); });
  const interrupted = [];
  let user = null;
  for (const message of tab.messages || []) {
    if (message.longAlive) continue;
    if (message.role === 'user') {
      if (user) interrupted.push(user);
      user = message.ctxRemoved || message.ctxSkip ? null : message.text;
    } else if (message.role === 'assistant' && user) {
      if (message.thinkingOpen || message.askPending || message.errorShown || message.stopped || message.taskPending) interrupted.push(user);
      user = null;
    }
  }
  if (user) interrupted.push(user);
  const queued = [];
  for (const item of submittedQueue(tab.queue)) {
    if (typeof item === 'string') queued.push(item);
    else queued.push({ text: item.text, attachments: (item.attachments || []).map(function name(file) { return file.name; }), contextPaths: item.contextPaths });
  }
  if (!interjections.length && !todos.length && !openQuestions.length && !interrupted.length && !queued.length) return null;
  return { interjections, todos, openQuestions, interrupted, queued };
}
