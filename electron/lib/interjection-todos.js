'use strict';

const { randomUUID } = require('node:crypto');
const { textOf, isContinueOnly, parseAcknowledgments } = require('./interjection-content');

/** 只需知悉的插话可当场结项，有具体交付的插话在交付时确认完成。 */
const tool = {
  type: 'function',
  function: {
    name: 'interjection_done',
    description: '按原编号交付已处理的插话。只需知悉的插话看完传 acknowledgmentOnly=true。需要答复、改动或操作的插话办妥时传 result，把具体结果立即交付到该卡片。只登记编号的事项在整轮正常交付时办结。',
    parameters: { type: 'object', properties: {
      id: { type: 'string', description: '插话待办编号' },
      result: { type: 'string', minLength: 1, description: '现在交付给用户的具体答复或办理结果，显示在该插话卡片上。' },
      acknowledgmentOnly: { type: 'boolean', description: '仅限对本条插话的全部要求已由阅读满足。' }
    }, required: ['id'] }
  }
};

/** 为一轮处理绑定会话存档、回复编号和界面事件。临时申请只活在这一轮，重开不会恢复。 */
class InterjectionTodos {
  constructor(memory, turnId, onEvent) {
    this.memory = memory;
    this.turnId = turnId;
    this.onEvent = onEvent;
    this.requested = new Set();
    this.reviewed = new Set(); // 同轮新插话触发再次收尾时，已核对的原话无需重复询问模型。
  }

  /** 收件成功即按原文登记。即便文字相同也生成不同编号；新插话打断尚未交付的标记。 */
  receive(entry) {
    this.requested.clear();
    const item = { id: randomUUID(), text: textOf(entry), turnId: this.turnId, status: 'pending' };
    // 随编号保存收件时的附件引用。重启查看按引用匹配会话中保存的原图，工作记忆不复制图片字节。
    item.attachments = typeof entry === 'string' ? [] : entry.attachments;
    this.memory.current.interjectionTodos = this.memory.current.interjectionTodos.concat(item);
    this.onEvent({ type: 'interjection_todos', items: [item] });
    return item.id;
  }

  /**
   * 把模型已看到的插话逐条记入会话，处理被打断后仍保留已看回执。
   * @param {string[]} ids 本次模型请求实际携带且收到活动回执的插话编号。
   * @param {boolean} acknowledgmentOnly 模型确认本批所选插话仅需知悉。
   * @returns {string[]} 标记已看并办结只需知悉的条目后，本批仍需继续处理的编号。
   */
  markSeen(ids, acknowledgmentOnly = false) {
    const batch = new Set(ids);
    const pending = [];
    const changed = [];
    const items = this.memory.current.interjectionTodos.slice();
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!batch.has(item.id)) continue;
      const complete = item.status === 'pending' && (acknowledgmentOnly || isContinueOnly(item.text));
      if (!complete && item.status === 'pending') pending.push(item.id);
      if (item.seen && !complete) continue;
      items[i] = { ...item, seen: true };
      if (complete) items[i].status = 'completed';
      changed.push(items[i]);
    }
    if (changed.length) {
      this.memory.current.interjectionTodos = items;
      this.onEvent({ type: 'interjection_todos', items: changed });
    }
    return pending;
  }

  /**
   * 按原编号交付单项结果或登记整轮交付；已办结的结果不被重复调用覆盖。
   * @param {string} id 本会话的插话编号，包括重新接手的历史项。
   * @param {boolean} acknowledgmentOnly 本条是否只需知悉。
   * @param {string} [result] 要立即展示在卡片上的实际结果。只传编号时仍等整轮交付。
   * @returns {string} 当前交付或登记结果。编号未知或显式传入的结果为空时抛错。
   */
  mark(id, acknowledgmentOnly = false, result) {
    for (const item of this.memory.current.interjectionTodos) {
      if (item.id !== id) continue;
      if (result !== undefined) {
        if (typeof result !== 'string' || !result.trim()) throw new Error('请填写要交付到这条插话卡片的具体结果。');
        if (item.status !== 'pending') return '这条插话已经结束。';
        this.publishResult([id], result);
        return '结果已交付到这条插话卡片，已标记为已处理。';
      }
      const pending = this.markSeen([id], acknowledgmentOnly === true);
      if (!pending.length) return '这条插话已处理。';
      this.requested.add(id);
      return '已登记本条处理结果，完整交付后显示已处理。';
    }
    throw new Error('当前会话没有这条插话待办。');
  }

  /**
   * 按分支已校验的目标原话关联本轮插话卡片，供展示进度和识别对应的交付。
   * @param {string} goal 派单所引的用户原话。@returns {string[]} 已送达且仍待交付的插话编号。
   */
  idsForGoal(goal) {
    const ids = [];
    for (const item of this.memory.current.interjectionTodos) {
      if (item.turnId === this.turnId && item.seen && item.status === 'pending' && item.text.includes(goal)) ids.push(item.id);
    }
    return ids;
  }

  /**
   * 将已发布的独立分支结果交付给对应插话，立即保存结果并更新原卡片。
   * @param {string} goal 分支负责的用户原话。部分原话只代表进度，不能办结整条插话。
   * @param {string[]} ids 分支派出时关联的插话编号，之后新到的同文消息须单独办理。
   * @param {string} result 分支实际完成并提交的结果，与已处理状态一起发送给界面。
   */
  deliverBranch(goal, ids, result) {
    this.publishResult(ids, result, goal);
  }

  /**
   * 将交付正文和完成状态作为同一个卡片事件发布，只更新指定的待办编号。
   * @param {string[]} ids 单项确认的编号或分支派出时绑定的编号。
   * @param {string} result 展示给用户的结果，随原插话保存。
   * @param {string} [branchGoal] 并发分支还须完整匹配本轮目标；按编号续办的历史项不受轮次限制。
   */
  publishResult(ids, result, branchGoal) {
    const items = this.memory.current.interjectionTodos.slice();
    const changed = [];
    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.status !== 'pending' || !ids.includes(item.id)) continue;
      if (branchGoal !== undefined && (item.turnId !== this.turnId || item.text.trim() !== branchGoal)) continue;
      const delivered = { ...item, seen: true, status: 'completed', result };
      items[index] = delivered;
      changed.push(delivered);
      this.requested.delete(item.id);
    }
    if (!changed.length) return;
    this.memory.current.interjectionTodos = items;
    this.onEvent({ type: 'interjection_todos', items: changed });
  }

  /**
   * 交付前让模型判定本轮仍未标记的已读文字是否仅需知悉，不据此确认任何实际工作。
   * @param {Function} read 把原话和编号交给无工具的会话模型，返回逐条知悉回执。
   * 带附件的要求须在有原附件的主请求确认，单靠文件名不能判断。已提交交付的任务沿用原路径。
   */
  async reviewNotices(read) {
    const items = [];
    const ids = [];
    for (const item of this.memory.current.interjectionTodos) {
      if (item.turnId !== this.turnId || !item.seen || item.status !== 'pending') continue;
      if (this.requested.has(item.id) || this.reviewed.has(item.id) || item.text.includes('【插话附件】')) continue;
      items.push({ id: item.id, text: item.text });
      ids.push(item.id);
    }
    if (!items.length) return;
    const reply = await read(items);
    if (!reply.trim()) throw new Error('模型未返回插话知悉回执');
    const receipt = parseAcknowledgments(reply, ids);
    this.markSeen(receipt.acknowledgedIds, true);
    for (const id of ids) this.reviewed.add(id);
  }

  /** 正常交付时仅提交本次明确标记的条目；没有标记的插话继续等待处理。 */
  finish() {
    if (!this.requested.size) return;
    const changed = [];
    const saved = [];
    for (const item of this.memory.current.interjectionTodos) {
      if (this.requested.has(item.id)) {
        const completed = { ...item, status: 'completed' };
        changed.push(completed);
        saved.push(completed);
      } else {
        saved.push(item);
      }
    }
    this.memory.current.interjectionTodos = saved;
    this.requested.clear();
    this.onEvent({ type: 'interjection_todos', items: changed });
  }

  /** 续聊时提供本会话遗留的未完项及原文，供按当前要求继续时准确指回对应编号。 */
  pendingContext() {
    const pending = [];
    for (const item of this.memory.current.interjectionTodos) {
      if (item.status === 'pending') pending.push({ id: item.id, text: item.text });
    }
    return pending.length ? '【历史插话待办，仅供对照，不新增执行范围】\n' + JSON.stringify(pending) : '';
  }
}

module.exports = { InterjectionTodos, tool };
