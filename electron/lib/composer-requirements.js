'use strict';

/**
 * 从已提交用户原稿提炼常用需求，供输入框灰字预测复用。
 * @param {object} data 会话存档；已有 submittedTextHistory 时以该字段为准，保留重复提交次数。
 * @returns {{text: string, count: number, lastIndex: number}[]} 按首次出现顺序返回去重候选，索引从零开始。
 * 仅裁掉正文两端空白，保留内部换行；少于三个 Unicode 字符不作预测，不读取未提交草稿或助手回复。
 * 旧存档的迁移口径与渲染层提交历史一致，迁移结果只在本次计算中使用，不改写会话。
 */
function distillSubmittedRequirements(data) {
  let history = data.submittedTextHistory;
  if (!Array.isArray(history)) {
    history = [];
    const interjectionPrefix = '你（插话·已提交）：';
    for (const message of data.messages || []) {
      let text = '';
      if (message.role === 'user') {
        text = typeof message.draft?.text === 'string' ? message.draft.text : message.text;
      } else if (message.role === 'system' && message.text?.startsWith(interjectionPrefix)) {
        text = message.text.slice(interjectionPrefix.length);
      }
      if (text && text.trim()) history.push(text);
    }
    for (const item of data.queue || []) {
      const text = typeof item === 'string' ? item : item.text;
      if (text && text.trim()) history.push(text);
    }
  }

  const requirements = new Map();
  for (let index = 0; index < history.length; index++) {
    const text = history[index].trim();
    if (Array.from(text).length < 3) continue;
    const existing = requirements.get(text);
    if (existing) {
      existing.count++;
      existing.lastIndex = index;
    } else {
      requirements.set(text, { text, count: 1, lastIndex: index });
    }
  }
  return Array.from(requirements.values());
}

module.exports = { distillSubmittedRequirements };
