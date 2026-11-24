'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { distillSubmittedRequirements } = require('../electron/lib/composer-requirements');

/** 核对重复原稿只合并展示、提交次数和最近索引都保留，正文内部换行不被压平。 */
function testSubmittedFrequency() {
  const data = { submittedTextHistory: ['  修复输入框\n保留换行  ', '检查打包结果', '修复输入框\n保留换行', '  检查打包结果  ', '修复输入框\n保留换行'] };
  assert.deepEqual(distillSubmittedRequirements(data), [
    { text: '修复输入框\n保留换行', count: 3, lastIndex: 4 },
    { text: '检查打包结果', count: 2, lastIndex: 3 }
  ]);
  assert.equal(data.submittedTextHistory[0], '  修复输入框\n保留换行  ');
}

/** Unicode 字符按码点计数，两个表情不会因为 UTF-16 代理对长度而提前成为候选。 */
function testUnicodeMinimum() {
  assert.deepEqual(distillSubmittedRequirements({ submittedTextHistory: ['你好', '😀😀', '你好呀', '😀😀😀', 'abc', ''] }), [
    { text: '你好呀', count: 1, lastIndex: 2 },
    { text: '😀😀😀', count: 1, lastIndex: 3 },
    { text: 'abc', count: 1, lastIndex: 4 }
  ]);
}

/** 旧存档只按用户原稿、已提交插话与队列迁移；助手、标题、画像及未提交草稿都不入库。 */
function testLegacySources() {
  const data = {
    title: '标题不是需求',
    composer: { text: '未提交的草稿' },
    profile: { notes: ['画像不是需求'] },
    messages: [
      { role: 'assistant', text: '助手不是需求' },
      { role: 'user', text: '展示转写正文', draft: { text: '用户实际原稿' } },
      { role: 'system', text: '普通系统消息' },
      { role: 'system', text: '你（插话·已提交）：已提交插话' },
      { role: 'user', text: '用户实际原稿' },
      { role: 'user', text: '   ' }
    ],
    queue: ['排队用户原稿', { text: '排队用户原稿' }]
  };
  assert.deepEqual(distillSubmittedRequirements(data), [
    { text: '用户实际原稿', count: 2, lastIndex: 2 },
    { text: '已提交插话', count: 1, lastIndex: 1 },
    { text: '排队用户原稿', count: 2, lastIndex: 4 }
  ]);
  assert.equal(Object.hasOwn(data, 'submittedTextHistory'), false);
}

/** 明确存在的提交历史是唯一来源，不能再叠加消息或队列造成重复计数。 */
function testExplicitHistoryWins() {
  assert.deepEqual(distillSubmittedRequirements({
    submittedTextHistory: ['相同需求', '相同需求'],
    messages: [{ role: 'user', text: '相同需求' }],
    queue: ['相同需求'],
    composer: { text: '未提交草稿' }
  }), [{ text: '相同需求', count: 2, lastIndex: 1 }]);
  assert.deepEqual(distillSubmittedRequirements({ submittedTextHistory: [], messages: [{ role: 'user', text: '不应复活的旧需求' }] }), []);
}

/** 空存档或只有未提交草稿时没有候选，不生成固定需求来代替用户历史。 */
function testEmptyHistory() {
  assert.deepEqual(distillSubmittedRequirements({}), []);
  assert.deepEqual(distillSubmittedRequirements({ composer: { text: '未提交草稿' }, messages: [] }), []);
}

/** 执行主进程真实摘要函数，核对新字段已接入缓存路径且原有历史元数据保持完整。 */
function testMainSessionMetaIntegration() {
  const mainSource = fs.readFileSync(path.join(__dirname, '../electron/main.js'), 'utf8').split('\r\n').join('\n');
  const start = mainSource.indexOf('function sessionMetaOf(data) {');
  const end = mainSource.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, '主进程必须存在可定位的 sessionMetaOf');
  const sessionMetaOf = vm.runInNewContext('(' + mainSource.substring(start, end + 2) + ')', { distillSubmittedRequirements });
  const meta = sessionMetaOf({
    id: 'fixture', title: '原有标题', workspace: 'workspace', updatedAt: 'timestamp',
    messages: [{ role: 'assistant', text: '助手不是需求' }],
    submittedTextHistory: ['检查输入预测', '检查输入预测'],
    composer: { text: '未提交草稿' }
  });
  assert.equal(meta.id, 'fixture');
  assert.equal(meta.title, '原有标题');
  assert.equal(meta.workspace, 'workspace');
  assert.equal(meta.updatedAt, 'timestamp');
  assert.equal(meta.messageCount, 1);
  assert.equal(meta.hasComposer, true);
  assert.equal(JSON.stringify(meta.requirements), JSON.stringify([{ text: '检查输入预测', count: 2, lastIndex: 1 }]));
  assert.ok(mainSource.includes('meta: sessionMetaOf(data)'), '完整保存必须仍更新同一摘要缓存');
  assert.ok(mainSource.includes('const meta = sessionMetaOf(data);'), '清单读盘必须仍生成同一摘要');
  assert.deepEqual(Object.keys(meta), ['id', 'title', 'workspace', 'updatedAt', 'messageCount', 'hasComposer', 'requirements']);
}

testSubmittedFrequency();
testUnicodeMinimum();
testLegacySources();
testExplicitHistoryWins();
testEmptyHistory();
testMainSessionMetaIntegration();
console.log('PASS composer requirements: 6 scenarios (frequency, latest index, Unicode threshold, legacy submissions, draft exclusion, empty history and main metadata integration)');
