'use strict';

/** 验证重启查看的实际数据边界、模型回执与刷新并发，不依赖模型账号。 */
const assert = require('node:assert/strict');
const { createRestartReview } = require('../electron/lib/restart-pending-review');

/** 用可控的模型输出模拟重启、等待和失败；完整 Electron 启动由 test-session-restart 验证。 */
async function main() {
  const { collectPendingReview, applyRestartReceipt, mergeInterjectionItems } =
    await import('../renderer/interjection-state.mjs');
  const longText = '保留完整原文'.repeat(500);
  const tab = {
    workingMemory: { interjectionTodos: [], openQuestions: ['缺少的资料'], todos: [
      { id: '1', status: 'completed', content: '旧待办' }, { id: '2', status: 'pending', content: '当前待办' }
    ] },
    queue: [{ text: '手动排队' }, { text: '屏幕通知', source: 'screen' }],
    composer: { text: '草稿' },
    messages: [
      { role: 'user', text: '已答需求' }, { role: 'assistant', text: '答复' },
      { role: 'system', text: '你（插话·已提交）：已交付的历史插话' },
      { role: 'user', text: '重启时仍在生成' }, { role: 'assistant', text: '尚未写完', thinkingOpen: true },
      { role: 'user', text: '未答需求' }
    ]
  };
  for (let i = 0; i < 45; i++) tab.workingMemory.interjectionTodos.push({ id: String(i), text: longText + i, status: 'pending', seen: i === 0 });
  const view = collectPendingReview(tab);
  assert.equal(view.interjections.length, 45);
  assert.equal(view.interjections[44].text, longText + 44);
  assert.deepEqual(view.todos, [{ content: '当前待办', status: 'pending' }]);
  assert.deepEqual(view.interrupted, ['重启时仍在生成', '未答需求']);
  assert.equal(view.queued.length, 1);
  assert.equal(view.queued[0].text, '手动排队');
  assert.equal(collectPendingReview({ messages: [], composer: tab.composer }), null);

  let release;
  const waiting = new Promise(function hold(resolve) { release = resolve; });
  const sent = [];
  /** 只记收到的模型与清单，失败会话独立拒绝。 */
  async function read(request) {
    sent.push(request.modelId);
    if (request.modelId === 'offline') throw new Error('离线');
    if (request.modelId === 'empty') return '';
    assert.deepEqual(JSON.parse(request.user), JSON.parse(JSON.stringify(view)));
    await waiting;
    return '已看到这些待办。\nSPCODE_ACK 3\nSPCODE_ACK 新插话';
  }
  const review = createRestartReview(read);
  const win = {};
  const request = { modelId: 'session-model', tabId: 'tab', view, lang: 'zh' };
  assert.deepEqual(review.begin(win, [request]), ['tab']);
  const first = review.result(win, 'tab');
  assert.deepEqual(review.begin(win, [{ ...request, tabId: '刷新后才新建' }]), ['tab']);
  assert.equal(first, review.result(win, 'tab'));
  await Promise.resolve();
  assert.deepEqual(sent, ['session-model']);
  assert.equal(tab.workingMemory.interjectionTodos[1].seen, false);
  release();
  const receipt = await first;
  assert.equal(receipt.ok, true);
  assert.equal(receipt.seenIds.length, 45);
  assert.equal(receipt.summary, '已看到这些待办。');
  assert.deepEqual(receipt.acknowledgedIds, ['3']);
  const current = [{ id: '1', status: 'completed' }, { id: '2', status: 'pending' }, { id: '3', status: 'pending', seen: true }, { id: '新插话', status: 'pending' }];
  const marked = applyRestartReceipt(current, receipt);
  assert.deepEqual(marked, [{ id: '1', status: 'completed', seen: true }, { id: '2', status: 'pending', seen: true }, { id: '3', status: 'completed', seen: true }, current[3]]);
  assert.equal(applyRestartReceipt([{ id: '3', status: 'cancelled' }], receipt)[0].status, 'cancelled');
  const stale = [{ id: '1', status: 'pending' }, { id: '2', status: 'pending', seen: false }];
  assert.deepEqual(mergeInterjectionItems(marked, stale), marked);
  const otherWindow = {};
  review.begin(otherWindow, [{ ...request, modelId: 'offline' }, { ...request, tabId: 'blank', modelId: 'empty' }]);
  assert.deepEqual(await review.result(otherWindow, 'tab'), { ok: false, detail: '离线' });
  assert.equal((await review.result(otherWindow, 'blank')).ok, false);
  assert.deepEqual(sent, ['session-model', 'offline', 'empty']);
  console.log('PASS 完整清单、未答复和排队需求、刷新接回、模型隔离、失败未读与迟到回执');
  await verifyRestoredPictures(collectPendingReview, applyRestartReceipt);
}

/**
 * 核对旧会话中同名原图的次序、原像素传输与按编号回执。
 * collect 从真实存档结构生成重启清单，apply 将回执合入原卡片；缺图或部分失败不得结项。
 */
async function verifyRestoredPictures(collect, apply) {
  const fs = require('node:fs');
  const path = require('node:path');
  const bytes = fs.readFileSync(path.join(__dirname, '..', 'icons.png'));
  const pixels = 'data:image/png;base64,' + bytes.toString('base64');
  const title = '【插话附件】封面.png';
  const rows = [
    { id: 'old', turnId: 'turn', status: 'completed', text: title },
    { id: 'photo', turnId: 'turn', status: 'pending', text: title },
    { id: 'lost', turnId: 'other', status: 'pending', text: title },
    { id: 'partial', turnId: 'turn', status: 'pending', text: '两张图', attachments: [{ name: '已读', dataUrl: pixels }, { name: '拒读', dataUrl: pixels }] }
  ];
  const tab = { workingMemory: { interjectionTodos: rows }, queue: ['核对页数'], messages: [
    { role: 'assistant', turnId: 'turn' },
    { role: 'system', text: '你（插话·已提交）：', attachments: [{ path: 'a.png', name: '封面.png' }], images: ['file:///a.png'] },
    { role: 'system', text: '你（插话·已提交）：', attachments: [{ path: 'b.png', name: '封面.png' }], images: [pixels] }
  ] };
  const request = { modelId: '眼睛', lang: 'zh', tabId: 'tab', view: collect(tab) };
  assert.deepEqual(request.view.interjections[0].attachments, [{ name: '封面.png', dataUrl: pixels }]);
  const calls = [];
  /** 在实际模型调用边界比对图片字节，第二张故意拒读，摘要只应收到完整识别的条目。 */
  async function inspect(input) {
    if (input.picture) {
      calls.push(input.picture.name);
      assert.deepEqual(Buffer.from(input.picture.dataUrl.split(',')[1], 'base64'), bytes);
      if (input.picture.name === '拒读') throw new Error('模型拒绝图片');
      return '图中的书号为 BK-abc';
    }
    const received = JSON.parse(input.user);
    assert.deepEqual(received.interjections, [{ id: 'photo', text: title, images: [{ name: '封面.png', observation: '图中的书号为 BK-abc' }] }]);
    assert.deepEqual(received.queued, ['核对页数']);
    return '已读原图与排队需求。\nSPCODE_ACK lost\nSPCODE_ACK partial';
  }
  const review = createRestartReview(inspect);
  const window = {};
  review.begin(window, [request]);
  const receipt = await review.result(window, 'tab');
  assert.equal(receipt.ok, true);
  assert.deepEqual(calls, ['封面.png', '已读', '拒读']);
  assert.deepEqual(receipt.seenIds, ['photo']);
  assert.deepEqual(receipt.acknowledgedIds, []);
  assert.match(receipt.summary, /lost · 会话中缺少原图/);
  assert.match(receipt.summary, /partial · 模型拒绝图片/);
  assert.deepEqual(apply(rows, receipt), [rows[0], { ...rows[1], seen: true }, rows[2], rows[3]]);
  console.log('PASS 旧存档同名已办图不串号，原图字节一致，缺图及部分识别失败均无已看回执，其他待办照常查看');
}

main().catch(function failed(error) {
  console.error(error);
  process.exitCode = 1;
});
