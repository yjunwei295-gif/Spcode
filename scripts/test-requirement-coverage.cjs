/** 在隔离项目中经真实 runTurn、文件工具和总结验收复现漏项，仅替换两个模型的传输。 */
'use strict';
const electron = require('electron');
// Node 入口负责启动真实的 Electron 测试进程，并传回其退出状态。
if (typeof electron === 'string') {
  const child = require('node:child_process').spawnSync(electron, [__filename], { stdio: 'inherit' });
  if (child.error) throw child.error;
  if (child.signal) throw new Error('Electron 测试进程被停止：' + child.signal);
  process.exit(child.status);
}
const { app } = electron;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-requirements-'));
app.setPath('userData', temp);
const root = path.resolve(__dirname, '..');
const agentPath = path.join(root, 'electron/lib/agent.js');
const local = createRequire(agentPath);
const modelCfg = { protocol: 'codex', model: 'implementation-test', baseUrl: 'http://unused' };
const summary = { protocol: 'openai', model: 'review-test', baseUrl: 'http://unused' };
const first = '请实现 alpha 开关。';
const second = '同时启用 beta 开关。';
const sources = fs.readFileSync(agentPath, 'utf8');

/**
 * 在独立的临时项目中运行一轮需求验收，核对磁盘状态、执行与验收次数及最终答复。
 * @param {string} mode 场景名，决定初始开关状态、模拟模型的逐轮行为和预期结果。
 * @returns {Promise<void>} runTurn 结束且本场景的断言全部通过后完成。执行出错或断言失败时拒绝，由测试入口以非零状态退出。
 */
async function scenario(mode) {
  const workspace = path.join(temp, mode);
  fs.mkdirSync(workspace);
  const file = path.join(workspace, 'flags.js');
  const initial = mode === 'existing';
  fs.writeFileSync(file, 'exports.alpha = ' + initial + ';\nexports.beta = ' + initial + ';\n');
  let executions = 0;
  let reviews = 0;
  const mixed = mode === 'mixed-explain';
  const change = mixed ? '请修复 alpha 和 beta 开关' : first;
  const tail = mixed ? '并告诉我为什么会失效。' : second;
  const explanation = '两个开关原先都初始化为 false。';
  const command = 'node --check flags.js';
  // 实际加载当前版本的开关模块，语法检查仍是 command 场景的独立要求。
  const observeCommand = `node -e "console.log('flags-observed '+JSON.stringify(require('./flags.js')))"`;
  /**
   * 实际加载开关模块并核对测试工具回包。
   * @param {Function} runTool 当前场景的生产工具入口。
   * @returns {Promise<void>} 成功返回两个开关的实测值时完成，其他结果触发断言失败。
   */
  async function observeFlags(runTool) {
    const evidence = await runTool('run_command', { command: observeCommand, activity: 'test' });
    assert.match(evidence, /exit: 0/);
    assert.match(evidence, /^flags-observed \{"alpha":(?:true|false),"beta":(?:true|false)\}$/m);
  }
  let request = change + '\n' + ' '.repeat(4200) + tail + (mode === 'command' ? '\n运行语法检查。' : '');
  if (mixed) request = change + tail;
  if (mode === 'no-fix') request = '请不要修复 alpha 开关。';
  const continuing = mode === 'continue' || mode === 'interjection';
  const previous = mode === 'interjection' ? rendererHistory() :
    [{ role: 'user', content: request }, { role: 'assistant', content: '准备核对这两个开关。' }];
  /**
   * 模拟直通执行者，累计执行次数，并按场景调用真实工具修改测试文件或运行检查。
   * reply-echo 场景首次执行时直接返回两项需求原文，跳过文件写入，供总结端核实复述交卷的行为。
   * @param {object} args 直通调用参数，turnText 用于核对续做或返工上下文，runTool 用于执行文件编辑与命令。
   * @returns {Promise<{content: string}>} 向生产轮次交付模拟答复正文。工具调用或磁盘断言失败时拒绝。
   */
  async function implement(args) {
    executions++;
    assert.ok(executions <= (mixed ? 3 : 2), '执行者被重复派去做已完成的工作');
    if (mode === 'no-fix') return { content: '收到。' };
    if (continuing || executions >= 2) {
      assert.ok(args.turnText.includes(change) && args.turnText.includes(tail), '续做和返工须带齐原任务及补充');
      assert.ok(!args.turnText.includes('排除的需求'), '排除的历史不可作为续做依据');
    }
    let names = [];
    if (mixed) {
      // 第一回空手交卷，第二回只修开关，第三回补回用户要求的原因说明。
      if (executions === 2) names = ['alpha', 'beta'];
      if (executions === 3) return { content: explanation };
    } else if (mode === 'reply-echo' && executions === 1) {
      // 执行者复述两项要求就交卷，实际运行仍观察到两个开关关闭。
      await observeFlags(args.runTool);
      return { content: first + '\n' + second };
    } else if (mode === 'reply-echo') {
      names = ['alpha', 'beta'];
    } else if (mode === 'command') {
      if (executions === 1) names = ['alpha', 'beta'];
      else assert.match(await args.runTool('run_command', { command, activity: 'test' }), /exit: 0/);
    } else if (executions === 1) {
      if (!initial && mode !== 'zero') names = ['alpha'];
    } else {
      names = mode === 'zero' ? ['alpha', 'beta'] : ['beta'];
    }
    for (const name of names) {
      await args.runTool('edit_file', { path: 'flags.js', old_string: 'exports.' + name + ' = false;', new_string: 'exports.' + name + ' = true;' });
      assert.ok(fs.readFileSync(file, 'utf8').includes('exports.' + name + ' = true;'));
    }
    if (mode !== 'command' || executions === 1) await observeFlags(args.runTool);
    return { content: '两个开关都已实现。' };
  }
  /**
   * 模拟总结模型逐轮验收，并核对重审与返工的先后顺序。
   * 漏项场景首轮只报第一项通过；复述场景首轮给两个功能项都引用需求复述，
   * 次轮确认两项均待核实且执行者尚未返工，再按磁盘开关状态报告缺口或给出逐项证据。
   * @param {object} args 模型调用参数，messages 包含本轮验收提示及上轮未核实项。
   * @returns {Promise<{role: string, content: string}>} 本次模拟的总结消息，轮次或提示内容与预期不符时断言失败。
   */
  async function review(args) {
    const prompt = args.messages.map(function body(item) { return String(item.content); }).join('\n');
    assert.ok(prompt.includes(tail), '验收模型缺少完整的第二项需求');
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n');
    // 实测覆盖预检只选择当前运行结果，实际开关是否正确仍由后续总结按原需求判定。
    if (prompt.includes('当前版本工具回执：')) {
      const observed = prompt.match(/^\[(\d+)\] flags-observed (\{[^\r\n]+\})$/m);
      assert.ok(observed, '覆盖预检须看到由运行命令产生的编号回执');
      assert.deepEqual(JSON.parse(observed[2]), {
        alpha: rows[0] === 'exports.alpha = true;',
        beta: rows[1] === 'exports.beta = true;'
      }, '运行回执须与当前版本的两个开关一致');
      return { role: 'assistant', content: '实测：' + observed[1] };
    }
    reviews++;
    assert.ok(reviews <= 4, '验收没有按结果停止');
    const firstPass = '核对 1：alpha 已启用。证据：flags.js:1「' + rows[0] + '」';
    if ((mode === 'partial' && reviews === 1) || mode === 'silent') return { role: 'assistant', content: firstPass + '\n方案验收：通过' };
    if (mode === 'wrong-quote' && reviews === 1) return { role: 'assistant', content: firstPass +
      '\n核对 2：beta 已启用。证据：flags.js:2「exports.beta = true;」\n方案验收：通过' };
    if ((mode === 'self-quote' || mode === 'cross-quote') && reviews === 1) {
      const citation = mode === 'self-quote' ? '2「' + second + '」' : '1「' + first + '」';
      return { role: 'assistant', content: firstPass + '\n核对 2：beta 已启用。依据：需求 ' + citation + '\n方案验收：通过' };
    }
    if (mode === 'no-verdict' && reviews === 1) return { role: 'assistant', content: '我看过改动，没有发现明显问题。' };
    if (mode === 'reply-echo' && reviews === 1) {
      // 两条答复引文确实出自执行者，但分别照搬本项和另一项需求，不能据此验收功能。
      return { role: 'assistant', content: '核对 1：alpha 已启用。答复：「' + first +
        '」\n核对 2：beta 已启用。答复：「' + first + '」\n方案验收：通过' };
    }
    if (mode === 'reply-echo' && reviews === 2) {
      const feedback = prompt.slice(prompt.indexOf('【上次尚未核实】'));
      assert.ok(feedback.includes('需求 1：' + first) && feedback.includes('需求 2：' + second), '两条复述均须重新核实');
      assert.equal(executions, 1, '先重审引文，再根据实际源码决定是否返工');
    }
    const missing = rows.findIndex(function disabled(line) { return line.includes('false'); });
    if (missing >= 0) return { role: 'assistant', content: '方案验收：未通过\n不一致：' + (missing ? second : first) + ' 当前仍关闭，应启用。证据：flags.js:' + (missing + 1) + '「' + rows[missing] + '」' };
    if (mixed) {
      assert.ok(prompt.includes('需求 1：' + change + '\n需求 2：' + tail), '修复和解释必须分别编号');
      const repaired = '核对 1：两个开关均已启用。证据：flags.js:2「' + rows[1] + '」';
      if (reviews === 2) return { role: 'assistant', content: repaired + '\n方案验收：通过' };
      if (reviews === 3) {
        assert.ok(prompt.includes('【上次尚未核实】') && !prompt.includes(explanation), '遗漏说明时先重审');
        return { role: 'assistant', content: '方案验收：未通过\n不一致：开关已修复，还需向用户解释原先失效的原因。证据：flags.js:2「' + rows[1] + '」' };
      }
      return { role: 'assistant', content: repaired + '\n核对 2：已说明原因。答复：「' + explanation + '」\n方案验收：通过' };
    }
    let enabled = firstPass + '\n核对 2：beta 已启用。证据：flags.js:2「' + rows[1] + '」';
    // 复现真实总结将同一需求的多个源码引用放在一行的格式。
    if (mode === 'multiple-citations' || (mode === 'invalid-second-citation' && reviews === 2)) {
      const cited = mode === 'multiple-citations' ? rows[0] : 'exports.alpha = false;';
      enabled += '；flags.js:1「' + cited + '」';
    }
    if (mode === 'command') {
      if (reviews === 2) {
        assert.ok(prompt.includes('需求 3：运行语法检查。') && !prompt.includes('【本轮成功命令】\n' + command));
        return { role: 'assistant', content: '方案验收：未通过\n不一致：两个开关已经实现，还需运行所要求的检查。证据：flags.js:2「' + rows[1] + '」' };
      }
      if (reviews === 3) assert.ok(prompt.includes('【本轮成功命令】\n' + command));
      return { role: 'assistant', content: enabled + '\n核对 3：语法检查已执行。命令：' + command + '\n方案验收：通过' };
    }
    return { role: 'assistant', content: enabled + '\n方案验收：通过' };
  }
  /**
   * 普通模型先编辑再实测，其他模型请求交给同一验收夹具。
   * @param {object} args 生产模型调用参数，用模型标识和上一条消息识别步骤。
   * @returns {Promise<object>} 返回工具调用或当前步骤的验收答复。
   */
  async function complete(args) {
    if (args.modelCfg.model !== 'ordinary-test') return review(args);
    const last = args.messages[args.messages.length - 1];
    if (last.role === 'tool') {
      if (/^flags-observed /m.test(String(last.content))) return { role: 'assistant', content: '两个开关都已实现。' };
      return { role: 'assistant', content: '', tool_calls: [{ id: 'observe-' + executions, type: 'function', function: {
        name: 'run_command', arguments: JSON.stringify({ command: observeCommand, activity: 'test' })
      } }] };
    }
    executions++;
    assert.ok(executions <= 2, '普通模型反复执行');
    const name = executions === 1 ? 'alpha' : 'beta';
    return { role: 'assistant', content: '', tool_calls: [{ id: 'enable-' + name, type: 'function', function: {
      name: 'edit_file', arguments: JSON.stringify({ path: 'flags.js', old_string: 'exports.' + name + ' = false;', new_string: 'exports.' + name + ' = true;' })
    } }] };
  }
  /** 保留生产文件、快照、配置形态和普通总结循环；替换模型响应和桌面开关，不请求外部端点。 */
  function dependency(name) {
    if (name === './codex-direct') return { ...local(name), runTurn: implement };
    if (name === './api-protocol') return { ...local(name), complete };
    if (name === './context-compact') return { ...local(name), pickSummaryCfg: function pick() { return summary; } };
    if (name === './desktop-hand') return { ...local(name), isAlive: function enabled() { return true; } };
    if (name === './store') return { ...local(name), load: function load() { return { ...local(name).load(), desktopAlive: true, models: [], providers: [], locale: 'zh' }; } };
    return local(name);
  }
  const ctx = { require: dependency, module: { exports: {} }, __dirname: path.dirname(agentPath),
    process, console, Buffer, URL, AbortController, AbortSignal, TextDecoder, setTimeout, clearTimeout, setInterval, clearInterval };
  vm.runInNewContext(sources, ctx, { filename: agentPath });
  const events = [];
  const cfg = mode === 'ordinary' ? { ...modelCfg, protocol: 'openai', model: 'ordinary-test' } : modelCfg;
  const result = await ctx.module.exports.runTurn({ workspace, appRoot: root, modelCfg: cfg,
    userText: continuing ? '继续' : request, history: continuing ? previous : [],
    rules: [], allSkills: [], attachments: [], contextPaths: [], extraFolders: [], workingMemory: {},
    turnId: mode, interjectKey: 'fixture:' + mode, signal: new AbortController().signal,
    onEvent: function collect(event) { events.push(event); } });
  assert.equal(events.filter(function done(e) { return e.type === 'done'; }).length, 1);
  if (mode === 'no-fix') {
    assert.equal(executions, 1);
    assert.equal(reviews, 0, '明确不要修复时不能触发实施验收或返工');
    assert.equal(fs.readFileSync(file, 'utf8'), 'exports.alpha = false;\nexports.beta = false;\n');
  } else if (mode === 'silent') {
    assert.equal(executions, 1, '总结漏报不能命令执行者盲改');
    assert.ok(reviews >= 2 && result.text.includes(tail) && !result.text.includes('两个开关都已实现'), '持续漏报须点明未核实项并扣住完成声明');
  } else {
    assert.equal(fs.readFileSync(file, 'utf8'), 'exports.alpha = true;\nexports.beta = true;\n', '只交付了部分功能');
    if (initial) assert.equal(result.changes.length, 0, '已有实现应凭证据通过，本轮不能产生文件变更');
    if (mixed) {
      assert.equal(executions, 3);
      assert.equal(reviews, 4);
      assert.ok(result.text.includes(explanation), '最终答复须包含实际补交的说明');
    } else {
      assert.equal(executions, initial ? 1 : 2);
    }
    assert.ok(reviews >= (initial ? 1 : mode === 'partial' ? 3 : 2));
    if (mode === 'multiple-citations') assert.equal(reviews, 2, '多处真实引文应一次核验通过');
    if (mode === 'invalid-second-citation') assert.equal(reviews, 3, '第二处虚假引文必须触发重审');
    assert.ok(!result.text.includes('未通过'));
  }
  console.log('PASS', mode, '执行', executions, '验收', reviews);
}
/** 从保存过的气泡执行生产 sendOne 的历史序列化片段，保留真实轮号、排除标志和插话顺序。 */
function rendererHistory() {
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8');
  const from = source.indexOf('  const roundByMsg =', source.indexOf('async function sendOne('));
  const to = source.indexOf('  const turnId =', from);
  const rounds = source.indexOf('function dialogRounds(tab)');
  const end = source.indexOf('\n}', rounds) + 2;
  assert.ok(from >= 0 && to > from && rounds >= 0 && end > rounds);
  const tab = { messages: [
    { role: 'user', text: first }, { role: 'assistant', text: '已处理第一项。' },
    { role: 'user', text: '继续' }, { role: 'assistant', text: '收到。' },
    { role: 'system', text: '你（插话·已提交）：' + second },
    { role: 'system', text: '普通状态通知' },
    { role: 'user', text: '排除的需求', ctxRemoved: true },
    { role: 'assistant', text: '收到。' }, { role: 'user', text: '继续' }
  ] };
  const result = vm.runInNewContext(source.slice(rounds, end) + '\n' + source.slice(from, to) + '\nhistory;', { tab, resident: false });
  assert.deepEqual(Array.from(result[2].interjections), [second]);
  assert.equal(result[4].removed, true);
  return result;
}
/**
 * 核对仅凭答复举证时，独立文字、复述引文和含修复动作的混合需求分别得到预期结论。
 * @returns {void} 各断言通过后打印结果，引文位置或证据类型判断出错时抛出断言错误。
 */
function checkReplyQuotes() {
  const review = local('./requirement-review');
  const request = '请原样回复「已收到」。';
  const row = '核对 1：文字已交付。答复：「已收到」';
  /** 本组用例没有源码引文，结果只能来自被核对的答复。 */
  function noSource() { return false; }
  assert.deepEqual(review.unchecked(row, [request], noSource, request, []), ['需求 1：' + request]);
  assert.deepEqual(review.unchecked(row, [request], noSource, '已收到', []), []);
  assert.deepEqual(review.unchecked(row, [request], noSource, request + '\n已收到', []), []);
  const textRequest = '请说明开关状态。';
  const crossing = '核对 1：已说明状态。答复：「状态。开关已启用。」';
  // 同一需求、引文和结论，只改变引文出现的位置，以区分跨越复述末尾和完全独立的答复。
  assert.deepEqual(review.unchecked(crossing, [textRequest], noSource, textRequest + '开关已启用。', []),
    ['需求 1：' + textRequest], '跨越复述末尾的引文须被拒绝');
  assert.deepEqual(review.unchecked(crossing, [textRequest], noSource, '当前状态。开关已启用。', []), []);
  const mixed = '请说明原因以及修复开关。';
  const explanation = '开关初值错误。';
  const explained = '核对 1：已说明原因。答复：「' + explanation + '」';
  assert.deepEqual(review.unchecked(explained, review.sections(mixed), noSource, explanation, []),
    ['需求 1：' + mixed], '以及连接的修复动作仍须源码举证');
  console.log('PASS 答复引文与混合需求 6 项');
}

/** 运行真实轮次，任一断言失败以非零状态结束独立 Electron 进程。 */
async function main() {
  await app.whenReady();
  checkReplyQuotes();
  for (const mode of ['partial', 'zero', 'existing', 'continue', 'interjection', 'wrong-quote', 'no-verdict', 'silent', 'ordinary', 'command', 'mixed-explain', 'no-fix', 'self-quote', 'cross-quote', 'reply-echo', 'multiple-citations', 'invalid-second-citation']) await scenario(mode);
  app.exit(0);
}
main().catch(function failed(error) { console.error(error.stack || error); app.exit(1); });
