/**
 * 验证审美模块只认前端、视频、美术成果，并且投票必须严格超过 90%。
 * 不访问模型接口，不改用户配置。
 */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const review = require('../electron/lib/aesthetic-review');

function check(value, label) {
  assert.ok(value, label);
  console.log('PASS ' + label);
}

check(review.aestheticKind('renderer/app.js') === 'frontend', '界面脚本算前端');
check(review.aestheticKind('src/App.tsx') === 'frontend', '页面组件算前端');
check(review.aestheticKind('styles/home.css') === 'frontend', '样式算前端');
check(review.aestheticKind('generated/demo.mp4') === 'video', '视频文件算视频');
check(review.aestheticKind('generated/poster.png') === 'art', '图片算美术');
check(review.aestheticKind('generated/mark.svg') === 'art', '矢量图算美术');
check(review.aestheticKind('electron/lib/agent.js') === '', '普通脚本不算审美对象');
check(review.aestheticKind('notes.md') === '', '文档不算审美对象');

const picked = review.aestheticChanges([
  { path: 'electron/lib/agent.js' },
  { path: 'renderer/app.css' },
  { path: 'renderer/app.css' },
  { path: '../secret.html' },
  { path: 'generated/clip.webm' }
]);
check(picked.length === 2 && picked[0].kind === 'frontend' && picked[1].kind === 'video', '只留下前端和视频，重复和越界路径丢掉');
check(review.mentionsAestheticWork('把登录页样式改一下') === true, '做界面时名单上可以出现审美');
check(review.mentionsAestheticWork('修一个空指针') === false, '普通修 bug 不出现审美');

const passVote = review.parseAestheticVote('【审美投票】通过\n【挑刺】\n无');
const failVote = review.parseAestheticVote('【审美投票】不通过\n【挑刺】\n- 留白太挤');
const bothVote = review.parseAestheticVote('【审美投票】通过\n【审美投票】不通过');
const emptyVote = review.parseAestheticVote('看起来还行');
check(passVote.pass === true && failVote.pass === false, '通过和不通过能分开');
check(bothVote.pass === false && emptyVote.pass === false, '含糊的票不算通过');
check(failVote.critique.indexOf('留白太挤') >= 0, '挑刺原文留着');

function ballots(passCount, total) {
  const list = [];
  for (let i = 0; i < total; i++) list.push({ pass: i < passCount });
  return list;
}
check(review.tallyVotes(ballots(2, 2)).passed === true, '两票全过算通过');
check(review.tallyVotes(ballots(1, 2)).passed === false, '两票只过一票不算');
check(review.tallyVotes(ballots(9, 10)).passed === false, '刚好 90% 不算超过');
check(review.tallyVotes(ballots(10, 10)).passed === true, '全部通过算通过');
check(review.tallyVotes(ballots(10, 11)).passed === true, '十比十一超过 90% 算通过');
check(review.percentText(10 / 11) === '90.9%', '超过 90% 的比例按一位小数显示');

const calls = [];
async function completeFn(options) {
  calls.push(options);
  const id = options.modelCfg.model;
  if (id === 'fail') return { content: '【审美投票】不通过\n【挑刺】\n标题挤在边上' };
  return { content: '【审美投票】通过\n【挑刺】\n无' };
}

/**
 * 验证评委出场条件、只读权限、画面证据门槛与参考来源的成功批次登记。
 * @returns {Promise<void>} 所有断言通过后清理测试目录；任一失败由顶层处理并退出
 */
async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aesthetic-review-'));
  fs.writeFileSync(path.join(dir, 'page.html'), '<h1>标题</h1>', 'utf8');
  const none = await review.review({
    models: [{ id: 'a', label: '甲', config: { model: '甲' } }, { id: 'b', label: '乙', config: { model: '乙' } }],
    changes: [{ path: 'electron/lib/agent.js' }],
    completeFn: completeFn
  });
  check(none === null && calls.length === 0, '没有审美成果时模块不出场');

  const short = await review.review({
    models: [{ id: 'only', label: '只有一个', config: { model: 'only' } }],
    changes: [{ path: 'page.html' }],
    workspace: dir,
    completeFn: completeFn
  });
  check(short.passed === false && calls.length === 0 && short.report.indexOf('不足两个') >= 0, '不足两个模型直接不算通过');

  calls.length = 0;
  const models = [];
  for (let i = 0; i < 10; i++) {
    models.push({ id: 'm' + i, label: '评委' + i, config: { model: i === 9 ? 'fail' : 'ok' + i } });
  }
  const almost = await review.review({
    models: models,
    changes: [{ path: 'page.html' }, { path: 'generated/clip.mp4' }],
    workspace: dir,
    userText: '做一页前端',
    assistantText: '已经写好页面',
    systemPrompt: review.criticInstruction(),
    completeFn: completeFn
  });
  check(almost.passed === false && almost.report.indexOf('通过 0 / 共 10') >= 0 && almost.report.indexOf('缺少必要画面证据') >= 0, '没有看图的九张通过票均不计为通过');
  /**
   * 判断一个工具声明是否属于审美评委仅有的两种只读能力。
   * @param {object} tool 标准工具声明，function.name 为工具名称
   * @returns {boolean} 仅参考图查询与看图工具返回 true，任何其他工具返回 false
   */
  function allowed(tool) {
    return tool.function.name === 'search_reference_images' || tool.function.name === 'view_review_image';
  }
  /**
   * 核对每位评委启用了工具且仅获得参考图查询与看图权限。
   * @param {object} item 捕获的评委模型请求，包含 noTools 与 toolSpec
   * @returns {boolean} 工具已启用且两项声明均为只读能力时返回 true
   */
  function readOnlyTools(item) {
    return item.noTools === false && item.toolSpec.length === 2 && item.toolSpec.every(allowed);
  }
  check(calls.length === 10 && calls.every(readOnlyTools), '十个评委只有参考图查询与看图工具，没有修改工具');
  check(calls[0].messages[1].content.indexOf('<h1>标题</h1>') >= 0, '评委看得到做出的页面');
  check(calls[0].messages[0].content.indexOf('不改文件') >= 0, '评委被明确禁止改文件');

  calls.length = 0;
  const okModels = [
    { id: 'a', label: '甲', config: { model: 'ok-a' } },
    { id: 'b', label: '乙', config: { model: 'ok-b' } }
  ];
  const noEvidence = await review.review({
    models: okModels,
    changes: [{ path: 'page.html' }],
    workspace: dir,
    systemPrompt: review.criticInstruction(),
    completeFn: completeFn
  });
  check(noEvidence.passed === false && noEvidence.report.indexOf('通过 0 / 共 2') >= 0 && noEvidence.report.indexOf('缺少必要画面证据') >= 0, '未调用看图工具时，两票自报通过仍不通过');

  // 这里仅隔离下载与视觉通道来检查登记时序；真实像素与生产传输由 test-aesthetic-reference.cjs 验证。
  const referenceTools = require('../electron/lib/aesthetic-reference');
  const originalSearch = referenceTools.searchImages;
  const originalView = referenceTools.viewImage;
  const firstReference = { title: '第一幅参考', imageUrl: 'https://example.test/first.png', sourceUrl: 'https://example.test/first-source' };
  const secondReference = { title: '第二幅参考', imageUrl: 'https://example.test/second.png', sourceUrl: 'https://example.test/second-source' };
  let mode;
  /**
   * 返回两条固定候选，检查搜索结果与已查看来源的区别。
   * @returns {Promise<Array<object>>} 两幅测试参考图的标题、图片地址和来源地址
   */
  async function fixtureSearch() { return [firstReference, secondReference]; }
  /**
   * 构造画面读取结果，使本测试专注视觉准备前后的状态变化。
   * @param {string} workspace 本轮工作区；测试不读取磁盘画面
   * @param {object} args source 指定成果路径或候选编号
   * @param {Map<string,object>} references 当前评委通过搜索登记的候选
   * @returns {Promise<object>} 含标签、单像素测试图片及可选参考来源的画面对象
   */
  async function fixtureView(workspace, args, references) {
    return { label: args.source, width: 1, height: 1,
      dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aB9kAAAAASUVORK5CYII=',
      reference: references.get(args.source) };
  }
  /**
   * 构造标准只读调用，维持调用编号与工具响应的对应关系。
   * @param {string} name 查询或看图工具名称
   * @param {object} args 按工具协议提供的参数
   * @param {string} id 当前测试会话内的调用编号
   * @returns {object} 带 JSON 参数字符串的标准 function 工具调用
   */
  function toolCall(name, args, id) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  }
  /**
   * 按当前测试场景先查询、再看成果和参考，最后投通过票。
   * @param {object} options 模型请求，messages 为当前评委完整会话
   * @returns {Promise<object>} 查询、看图调用或最终投票；后批失败场景会继续请求第二幅参考
   */
  async function stagedComplete(options) {
    const last = options.messages[options.messages.length - 1];
    if (last.role === 'user' && typeof last.content === 'string') {
      return { tool_calls: [toolCall('search_reference_images', { query: '测试页面', count: 2 }, 'search')] };
    }
    if (last.role === 'tool' && mode !== 'search-only') {
      if (mode === 'reference-only') return { tool_calls: [toolCall('view_review_image', { source: '参考图1' }, 'first')] };
      if (mode === 'reference-subject') return { tool_calls: [toolCall('view_review_image', { source: '参考图1', subject: 'page.html' }, 'first')] };
      if (mode === 'url-reference-subject') return { tool_calls: [toolCall('view_review_image', { source: firstReference.imageUrl, subject: 'page.html' }, 'first')] };
      if (mode === 'unrelated') return { tool_calls: [toolCall('view_review_image', { source: 'unrelated.png' }, 'other')] };
      if (mode === 'runtime-subject') return { tool_calls: [toolCall('view_review_image', { source: 'http://localhost/page', page: true, subject: 'page.html' }, 'page')] };
      return { tool_calls: [toolCall('view_review_image', { source: 'page.html', width: 1, height: 1 }, 'work'),
        toolCall('view_review_image', { source: '参考图1' }, 'first')] };
    }
    if (last.role === 'user' && Array.isArray(last.content) && mode === 'pending-failure') throw new Error('测试携图请求失败');
    if (last.role === 'user' && Array.isArray(last.content) && mode === 'later-failure') {
      return { tool_calls: [toolCall('view_review_image', { source: '参考图2' }, 'second')] };
    }
    return { content: '【审美投票】通过\n【挑刺】\n无' };
  }
  /**
   * 模拟视觉准备的成功与失败，核对首次失败及后批失败的来源登记。
   * @param {Array<object>} images 评委累计读取的成果与参考画面
   * @returns {Promise<{text:string,parts:Array<object>}>} 成功时提供画面内容块；指定失败场景直接拒绝
   */
  async function fixturePrepare(images) {
    if (mode === 'first-failure' || (mode === 'later-failure' && images.length > 2)) {
      throw new Error('测试视觉准备失败');
    }
    const parts = [];
    for (const image of images) parts.push({ type: 'image_url', image_url: { url: image.dataUrl } });
    return { text: '测试视觉准备成功', parts };
  }
  referenceTools.searchImages = fixtureSearch;
  referenceTools.viewImage = fixtureView;
  for (mode of ['search-only', 'first-failure', 'success', 'later-failure', 'reference-only', 'reference-subject', 'url-reference-subject', 'unrelated', 'runtime-subject', 'pending-failure', 'partial-subjects']) {
    const changes = [{ path: 'page.html' }];
    if (mode === 'partial-subjects') changes.push({ path: 'other.html' });
    const result = await review.review({ models: okModels, changes, workspace: dir,
      systemPrompt: review.criticInstruction(), completeFn: stagedComplete, prepareImages: fixturePrepare });
    if (mode === 'search-only') {
      check(!result.passed && result.report.includes('缺少必要画面证据') && !result.report.includes('已查看的参考来源'), '只查询候选不算看图，不登记已查看来源');
    }
    if (mode === 'first-failure') {
      check(!result.passed && result.report.includes('测试视觉准备失败') && !result.report.includes('已查看的参考来源'), '首次视觉准备失败不登记参考来源');
    }
    if (mode === 'success') {
      check(result.passed && result.report.includes(firstReference.sourceUrl) && !result.report.includes(secondReference.sourceUrl), '看图成功后两票通过，来源只包含实际查看的候选');
    }
    if (mode === 'later-failure') {
      check(!result.passed && result.report.includes(firstReference.sourceUrl) && !result.report.includes(secondReference.sourceUrl), '后批看图失败只保留此前成功查看的参考来源');
    }
    if (mode === 'reference-only' || mode === 'reference-subject' || mode === 'url-reference-subject' || mode === 'unrelated') {
      check(!result.passed && result.report.includes('未成功查看被审成果 page.html'), mode + '：参考图或无关图片不能提供成果证据');
    }
    if (mode === 'runtime-subject') check(result.passed, '运行页面可明确关联被审成果并提供画面证据');
    if (mode === 'pending-failure') {
      check(!result.passed && result.report.includes('测试携图请求失败') && !result.report.includes('已查看的参考来源'), '准备成功但实际请求失败时不登记来源');
    }
    if (mode === 'partial-subjects') check(!result.passed && result.report.includes('未成功查看被审成果 other.html'), '多个成果不能共用未关联的画面证据');
  }
  referenceTools.searchImages = originalSearch;
  referenceTools.viewImage = originalView;
  fs.rmSync(dir, { recursive: true, force: true });
}

main().catch(function failed(error) {
  console.error(error.stack || error);
  process.exit(1);
});
