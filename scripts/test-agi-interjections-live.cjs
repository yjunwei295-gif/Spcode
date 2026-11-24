'use strict';

/** 用真实 Codex 和隔离的生产窗口验收当前任务运行期间的 22 条插话。 */
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomInt } = require('node:crypto');

const project = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-live-burst-'));
const userData = path.join(output, 'user-data');
const work = path.join(output, 'workspace');
const archive = path.join(output, 'archive');
const reportPath = path.join(output, 'report.json');
const source = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'simplecode', 'settings.json'), 'utf8'));
const model = source.models.find(function selected(entry) { return entry.id === source.currentModelId; });
assert.ok(model, '真实模型验收需要已选模型');
const provider = source.providers.find(function matching(entry) { return entry.id === model.providerId; });
assert.equal(provider?.protocol, 'codex', '真实模型验收需要选中 Codex 直通模型');
assert.ok(!provider.apiKey && !model.apiKey, '隔离实例只使用现有 Codex 登录');
const report = { pid: process.pid, model: model.model, protocol: provider.protocol, output };
const timeoutMs = 240000;
/** 让真实命令保持在途，给生产页面留出提交整批插话的时间，然后输出本次随机校验值。 */
const waitCode = "setTimeout(function done(){console.log(require('node:crypto').randomBytes(6).toString('hex'));}, 8000)";
const probes = makeProbes('LIVE_BURST', 20);
const additions = makeProbes('LIVE_NEXT', 2);
const input = {
  probes, additions, timeoutMs,
  first: toolTask('LIVE_ORIGINAL', '核对第一条本地命令的实际输出。'),
  batch: toolTask('LIVE_FOLLOWUP', '再核对第二条本地命令的实际输出，重新运行同一条命令并分别保留两个校验值。')
};

/**
 * 生成两批独立的合成需求，最终答复需要逐条给出计算结果。
 * @param {string} prefix 区分批次的标记。
 * @param {number} count 批内条数。
 * @returns {Array<object>} 原始标记、答复标记、合成整数及提交正文。
 */
function makeProbes(prefix, count) {
  return Array.from({ length: count }, function probe(_, index) {
    const id = String(index + 1).padStart(2, '0');
    const marker = prefix + '_' + id;
    const replyLabel = prefix + '_RESULT_' + id;
    const number = randomInt(1000, 9998);
    return { marker, replyLabel, number, expected: number + 1,
      text: marker + '=' + number + '。最终答复另起一行输出 ' + replyLabel + '=该整数加一的结果。' };
  });
}

/**
 * 构造需要真实命令输出的只读任务，命令运行期间可提交插话。
 * @param {string} marker 这一条命令独有的校验值标签。
 * @param {string} heading 当前需要核对的步骤。
 * @returns {string} 交给配置模型的合成任务。
 */
function toolTask(marker, heading) {
  return [
    heading + ' 使用 run_command 且 activity=test，执行以下完整命令：',
    'node -e "/* ' + marker + ' */ ' + waitCode + '"',
    '最终答复中输出 ' + marker + '= 加上真实 stdout 的 12 位十六进制值。',
    '收到补充时累计所有要求，最终答复末行写：任务已完成。'
  ].join('\n');
}

for (const dir of [userData, work, archive, path.join(output, 'session-data'), path.join(output, 'crash-dumps')]) fs.mkdirSync(dir);
app.setName('SpCodeLiveInterjectionVerification');
app.setPath('userData', userData);
app.setPath('sessionData', path.join(output, 'session-data'));
app.setPath('crashDumps', path.join(output, 'crash-dumps'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  locale: 'zh', onboardingCompleted: true, autoSave: false, desktopAlive: true,
  trainingDataEnabled: true, trainingDataDir: archive, cursorDirect: true,
  // 合成算术和单条命令使用低推理档位，仍调用同一个已登录的真实模型。
  proxy: source.proxy, currentModelId: model.id, models: [{ ...model, reasoningEffort: 'low' }], providers: [provider],
  commandSandbox: { enabled: true, timeoutSec: 30 }, recents: [{ path: work, name: '整合需求验收' }],
  capabilityDefaults: {}, assemblies: {}
}), 'utf8');

let finished = false;
let entered = false;
const deadline = setTimeout(function watchdog() { finish(new Error('真实模型分批验收超时')); }, timeoutMs);
console.log('REPORT ' + reportPath);

/**
 * 保存隔离测试报告，并按断言结果退出测试实例。
 * @param {Error} [error] 验收失败时保留堆栈。
 * @returns {void} 成功退出码为 0，失败为 1。
 */
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  if (error) report.failure = String(error.stack || error);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(error ? 'FAIL ' + report.failure : 'PASS ' + report.result);
  app.exit(error ? 1 : 0);
}

/**
 * 通过正式聊天页在同一任务的两次工具在途期间提交插话。
 * @param {object} fixture 两批合成插话及等待上限。
 * @returns {Promise<object>} 完成事件、两批显示时间和最终可见的插话。
 */
async function drive(fixture) {
  const api = window.simple;
  const done = [];
  const tools = [];
  const bursts = [];
  const readyAt = Date.now();
  let firstError;
  /**
   * 等待生产页面达到指定条件，异步提交错误会立即终止等待。
   * @param {Function} check 检查当前页面，返回真值时结束等待。
   * @param {string} label 超时报错用的检查名称。
   * @param {number} [limit] 本次等待上限（毫秒），实际截止时间还受整轮上限约束。
   * @returns {Promise<unknown>} 返回检查的首个真值，出错或超时则拒绝。
   */
  async function waitUntil(check, label, limit = fixture.timeoutMs) {
    const until = Math.min(readyAt + fixture.timeoutMs, Date.now() + limit);
    while (Date.now() < until) {
      if (firstError) throw new Error(firstError);
      const value = check();
      if (value) return value;
      await new Promise(function tick(resolve) { setTimeout(resolve, 25); });
    }
    throw new Error(label + '等待超时，完成事件 ' + done.length + '，工具启动 ' + tools.length);
  }
  /** 获取生产聊天中的真实插话条目，忽略输入框和待发队列。 */
  function entries() {
    return Array.from(document.querySelectorAll('#messages .interjection-entry'), function entry(node) {
      return node.textContent;
    });
  }
  /**
   * 逐条点击正式插话按钮，并核对前后批次的原文顺序和可见状态。
   * @param {Array<object>} probes 本批待提交的插话，每项含用户正文 text。
   * @param {string} prefix 只附加到本批第一条的补充要求，无补充时传空字符串。
   * @returns {Promise<object>} 本批条数、累计可见条数、首次核对的时间戳和全部可见原文。
   */
  async function submitBatch(probes, prefix) {
    const input = document.getElementById('input');
    const button = document.getElementById('btn-enqueue');
    if (button.textContent.trim() !== '插话') throw new Error('运行中没有显示插话入口');
    const expected = entries().concat(probes.map(function body(probe, index) {
      return index === 0 ? prefix + probe.text : probe.text;
    }));
    for (let i = 0; i < probes.length; i++) {
      input.value = i === 0 ? prefix + probes[i].text : probes[i].text;
      button.click();
    }
    const visible = await waitUntil(function rendered() {
      const current = entries();
      return current.length === expected.length && current.every(function matches(entry, i) {
        return entry.includes(expected[i]);
      }) && current;
    }, '插话原文按序入屏');
    const group = document.querySelector('#messages .interjection-block');
    if (bursts.length === 1) group.querySelector('summary').click();
    if (!group.open) throw new Error('新增批次使之前展开的插话折叠');
    // 同时核对真实布局，折叠或 CSS 隐藏的节点即使有正文也不能算显示。
    const displayed = Array.from(group.querySelectorAll('.interjection-entry')).filter(function laidOut(entry) {
      return entry.getClientRects().length > 0 && getComputedStyle(entry).visibility === 'visible';
    }).length;
    if (displayed !== expected.length) throw new Error('插话区实际显示 ' + displayed + ' 条，预期 ' + expected.length + ' 条');
    console.log('SPCODE_BURST_VISIBLE ' + displayed + ' 条，其中此前的 ' + (expected.length - probes.length) + ' 条仍可见');
    return { count: probes.length, displayed, visibleAt: Date.now(), visible };
  }
  /** 由正式工具运行事件安排下一批，两批都必须归属同一轮。 */
  function onEvent(event) {
    if (!event.turnId) return;
    if (event.type === 'error') firstError = event.message || event.text;
    if (event.type === 'done') {
      done.push({ turnId: event.turnId, text: event.text, taskSettled: event.taskSettled });
      console.log('SPCODE_BURST_DONE ' + done.length + ' ' + event.taskSettled);
    }
    if (event.type !== 'tool' || event.name !== 'run_command' || event.status !== 'running') return;
    // 同一条命令可能从多个状态源显示。按测试命令内的独立标签触发一次提交。
    const marker = event.detail?.match(/LIVE_ORIGINAL|LIVE_FOLLOWUP/)?.[0];
    if (!marker || tools.some(function seen(tool) { return tool.marker === marker; })) return;
    tools.push({ marker, turnId: event.turnId, at: Date.now() });
    const firstBatch = marker === 'LIVE_ORIGINAL';
    const batch = submitBatch(firstBatch ? fixture.probes : fixture.additions, firstBatch ? fixture.batch + '\n' : '');
    batch.catch(function failed(error) { firstError = error.message; });
    bursts.push(batch);
    console.log('SPCODE_BURST_SUBMITTED ' + tools.length);
  }
  const recent = await waitUntil(function recentProject() {
    return document.querySelector('#recent-list .recent-item[data-path]');
  }, '生产页面最近项目', 15000);
  recent.click();
  await waitUntil(function opened() { return document.querySelector('#tabs .tab[data-id]'); }, '测试项目标签', 15000);
  const unsubscribe = api.onChatEvent(onEvent);
  try {
    document.getElementById('input').value = fixture.first;
    document.getElementById('btn-send').click();
    await waitUntil(function completed() {
      return done.length > 0 && !document.getElementById('btn-send').classList.contains('is-stop');
    }, '同一任务的最终答复');
    return { done, tools, records: await Promise.all(bursts), visible: entries(),
      expanded: document.querySelector('#messages .interjection-block')?.open,
      queue: document.getElementById('queue').textContent };
  } finally { unsubscribe(); }
}

/**
 * 读取隔离实例为同一标签写下的逐轮生产档案。
 * @returns {Map} 以真实 turnId 对应该轮事件。
 */
function loadArchive() {
  const sessions = fs.readdirSync(archive);
  assert.equal(sessions.length, 1, '所有批次应归属同一个标签');
  const session = path.join(archive, sessions[0]);
  const turns = new Map();
  for (const dir of fs.readdirSync(session)) {
    const lines = fs.readFileSync(path.join(session, dir, 'events.jsonl'), 'utf8').trim().split(/\r?\n/);
    const rows = lines.map(function parse(line) { return JSON.parse(line); });
    turns.set(rows[0].turnId, rows);
  }
  return turns;
}

/**
 * 核对指定段里出现的合成需求原文，保持编号、数值和到达顺序。
 * @param {string} text SDK 实际请求或训练归档中的原文。
 * @param {Array<object>} expected 当前阶段应出现的全部需求。
 * @returns {void} 遗漏、乱序和重复记录均令验收失败。
 */
function verifyProbes(text, expected) {
  const markers = Array.from(text.matchAll(/LIVE_(?:BURST|NEXT)_\d{2}=\d{4}/g), function marker(match) {
    return match[0];
  });
  assert.deepEqual(markers, expected.map(function body(probe) { return probe.marker + '=' + probe.number; }));
}

/**
 * 核对真实工具结果和插话入屏时机。
 * @param {object} command Codex 归档的工具完成事件。
 * @param {string} marker 答复中对应的校验值标签。
 * @param {object} batch 主窗口记录的插话显示时刻。
 * @param {object} tool 主窗口收到的工具开始事件。
 * @param {string} answer 本轮最终答复。
 * @returns {string} 实际命令输出的校验值。
 */
function verifyCommand(command, marker, batch, tool, answer) {
  const response = command.data.event.item.result?.content?.find(function text(part) { return part.type === 'text'; })?.text;
  const proof = response?.match(/--- stdout ---\r?\n([0-9a-f]{12})\b/i)?.[1];
  assert.match(proof || '', /^[0-9a-f]{12}$/i, '真实命令没有返回校验值');
  assert.equal(answer.match(new RegExp(marker + '=\\s*([0-9a-f]{12})\\b', 'i'))?.[1], proof);
  assert.ok(batch.visibleAt >= tool.at && batch.visibleAt < Date.parse(command.at), '插话须在对应命令完成前显示');
  return proof;
}

/**
 * 对照生产 UI、实际 SDK 请求和同一轮的档案。
 * @param {Electron.BrowserWindow} win 隔离实例的正式聊天窗口。
 * @returns {Promise<void>} 验证 22 条插话、三次 SDK 请求及最终答复后保存报告。
 */
async function verify(win) {
  try {
    const page = await win.webContents.executeJavaScript('(' + drive.toString() + ')(' + JSON.stringify(input) + ')');
    report.frontend = page;
    assert.equal(page.done.length, 1);
    assert.deepEqual(page.tools.map(function marker(tool) { return tool.marker; }), ['LIVE_ORIGINAL', 'LIVE_FOLLOWUP']);
    assert.deepEqual(page.records.map(function count(batch) { return batch.count; }), [20, 2]);
    assert.equal(page.queue.trim(), '');
    assert.equal(page.expanded, true, '最终回复后之前打开的插话仍然展开');
    const all = probes.concat(additions);
    verifyProbes(page.records[0].visible.join('\n'), probes);
    verifyProbes(page.records[1].visible.join('\n'), all);
    verifyProbes(page.visible.join('\n'), all);
    const done = page.done[0];
    assert.ok(page.tools.every(function matching(tool) { return tool.turnId === done.turnId; }));
    const archiveTurns = loadArchive();
    assert.equal(archiveTurns.size, 1, '两批插话继续使用同一聊天轮次');
    const rows = archiveTurns.get(done.turnId);
    const requests = rows.filter(function request(row) {
      return row.kind === 'direct-start' && !row.data.input.key.startsWith('worker:');
    });
    const commands = rows.filter(function completed(row) {
      const event = row.data.event;
      return row.kind === 'sdk-event' && row.data.provider === 'codex' &&
        event?.type === 'item.completed' && event.item?.type === 'mcp_tool_call' && event.item.tool === 'run_command';
    });
    const accepted = rows.filter(function interjection(row) { return row.kind === 'user-interjection'; });
    const result = rows.find(function reply(row) { return row.kind === 'turn-result'; });
    const ended = rows.find(function finished(row) { return row.kind === 'turn-end'; });
    assert.equal(requests.length, 3, '首轮加两次模型续接');
    assert.equal(commands.length, 2);
    assert.equal(accepted.length, all.length);
    assert.equal(new Set(requests.map(function key(row) { return row.data.input.key; })).size, 1);
    assert.ok(requests[0].data.input.turnText.includes(input.first));
    verifyProbes(requests[0].data.input.turnText, []);
    verifyProbes(accepted.map(function body(row) { return row.data.text; }).join('\n'), all);
    const heading = '【用户实时插话】';
    for (const [index, newest, cumulative] of [[1, probes, probes], [2, additions, all]]) {
      const request = requests[index];
      const text = request.data.input.turnText;
      const marker = text.indexOf(heading);
      assert.ok(marker > 0, '续接请求必须包含本批用户插话');
      assert.ok(text.slice(0, marker).includes(input.first), '累计范围应保留首个用户要求');
      verifyProbes(text.slice(0, marker), cumulative);
      verifyProbes(text.slice(marker), newest);
      assert.ok(request.seq > commands[index - 1].seq, '工具完成后才续接模型请求');
    }
    assert.equal(result.data.text, done.text);
    assert.equal(ended.data.outcome, 'success');
    assert.equal(done.taskSettled, true, '成功交付须有真实验收回执');
    assert.equal(result.data.taskPending, false);
    assert.deepEqual(page.records.map(function displayed(batch) { return batch.displayed; }), [20, 22]);
    const actual = Array.from(done.text.matchAll(/\b(LIVE_(?:BURST|NEXT)_RESULT_\d{2})\s*=\s*(\d{4})\b/g), function pair(match) {
      return [match[1], Number(match[2])];
    });
    assert.deepEqual(actual, all.map(function pair(probe) { return [probe.replyLabel, probe.expected]; }));
    report.checks = {
      turns: 1, sdkRequests: requests.length, batchSizes: [probes.length, additions.length], matched: actual.length,
      toolProofs: [verifyCommand(commands[0], 'LIVE_ORIGINAL', page.records[0], page.tools[0], done.text),
        verifyCommand(commands[1], 'LIVE_FOLLOWUP', page.records[1], page.tools[1], done.text)],
      turnId: done.turnId
    };
    report.result = '同一轮的两次模型续接按批读取插话，页面和最终答复完整保留两批共 22 条要求';
    finish();
  } catch (error) { finish(error); }
}

/** 隐藏隔离实例，仅在正式聊天页加载后驱动测试。 */
function onWindow(_event, win) {
  win.once('show', function hide() { win.hide(); });
  win.webContents.on('console-message', function progress(event) {
    if (String(event.message || '').startsWith('SPCODE_BURST_')) console.log(event.message);
  });
  win.webContents.on('did-finish-load', function loaded() {
    if (entered || !win.webContents.getURL().endsWith('/renderer/index.html')) return;
    entered = true;
    verify(win);
  });
}

app.on('browser-window-created', onWindow);
require(path.join(project, 'electron', 'main.js'));
