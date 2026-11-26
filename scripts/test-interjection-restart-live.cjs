'use strict';

/** 用已配置的真实会话模型、生产聊天卡片和两次独立启动验收插话回执。 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { randomBytes, randomInt } = require('node:crypto');
const root = path.resolve(__dirname, '..');

if (process.versions.electron) child();
else parent();

/** 只把选中的模型配置交给隔离实例；退出时删除临时配置，只留下合成会话的证据。 */
function parent() {
  const concurrent = process.argv[2] === 'parallel';
  const output = fs.mkdtempSync(path.join(root, 'generated', concurrent ? 'interjection-parallel-live-' : 'interjection-restart-live-'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-followup-live-'));
  const report = { phases: [], output };
  const reportFile = path.join(output, 'report.json');
  console.log('REPORT ' + reportFile);
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA, 'simplecode', 'settings.json'), 'utf8'));
    const selected = settings.models.find(function match(model) { return model.id === settings.currentModelId; });
    const provider = settings.providers.find(function match(entry) { return entry.id === selected.providerId; });
    assert.equal(provider.protocol, 'codex');
    assert.ok(!provider.apiKey && !selected.apiKey, '沿用 Codex 登录，不复制密钥');
    const models = [{ ...selected, reasoningEffort: 'low' }];
    const providers = [provider];
    const capabilityDefaults = {};
    if (!concurrent && !selected.vision) {
      // 恢复原标签实际使用的视觉槽位；隔离配置只引用同一台机器已登录的 Codex，不复制密钥。
      const slots = settings.assemblies?.['api:' + selected.id]?.slots || [];
      const slot = slots.find(function eye(entry) { return entry.role === 'vision' && entry.apiId; }) || settings.capabilityDefaults?.vision?.primary;
      const eye = settings.models.find(function matching(entry) { return entry.id === slot?.apiId; });
      assert.ok(eye, '纯图实测需要原会话的原生视觉或已配置的看图模型');
      const eyeProvider = settings.providers.find(function matching(entry) { return entry.id === eye.providerId; });
      assert.equal(eyeProvider.protocol, 'codex');
      assert.ok(!eye.apiKey && !eyeProvider.apiKey && !slot.apiKey);
      if (eye.id !== selected.id) models.push({ ...eye, reasoningEffort: 'low' });
      if (eyeProvider.id !== provider.id) providers.push(eyeProvider);
      capabilityDefaults.vision = { primary: { type: 'api', apiId: eye.id, model: eye.model, protocol: eyeProvider.protocol } };
      report.visionModel = eye.model;
    }
    const profile = path.join(temp, 'profile');
    const workspace = path.join(temp, 'workspace');
    fs.mkdirSync(profile);
    fs.mkdirSync(workspace);
    fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
      locale: 'zh', onboardingCompleted: true, autoSave: true, desktopAlive: true, cursorDirect: true,
      // 仅在隔离并发实测采集真实模型调用，随临时项目清理；用户的设置不参与写入。
      trainingDataEnabled: concurrent, trainingDataDir: path.join(temp, 'parallel-archive'),
      proxy: settings.proxy, currentModelId: selected.id,
      models, providers, capabilityDefaults, assemblies: {},
      recents: [{ path: workspace, name: '插话验收' }]
    }));
    const key = randomBytes(3).toString('hex');
    report.model = selected.model;
    report.followup = '蓝鹭' + key;
    report.queued = '白桦' + key;
    // 独立随机编号只画进原图，文件名、插话正文和其他待办都不包含这个答案。
    if (!concurrent) report.pictureCode = String(randomInt(10000000, 100000000));
    if (concurrent) {
      // 两份隔离样本的结果仅存在于磁盘，用于证明每个子代理确实检查过对应资料。
      const amount = parseInt(key, 16);
      // 空实现保证两条功能要求必须分别落盘，父进程会用不同输入执行修改后的导出函数。
      for (const moduleName of ['sum.cjs', 'duplicates.cjs']) {
        fs.writeFileSync(path.join(workspace, moduleName), "module.exports = function () { throw new Error('尚未实现'); };\n");
      }
      report.expectedAmount = String(amount + 83);
      report.expectedColor = '湖蓝' + key;
      fs.writeFileSync(path.join(workspace, 'invoice.json'), JSON.stringify([{ amount }, { amount: 83 }]));
      fs.writeFileSync(path.join(workspace, 'palette.txt'), ['米白', report.expectedColor, '浅粉', report.expectedColor].join('\n'), 'utf8');
    }
    for (const phase of concurrent ? ['parallel'] : ['live', 'restart']) {
      fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const run = require('node:child_process').spawnSync(require('electron'), [__filename, phase, temp, output], {
        env, cwd: root, encoding: 'utf8', timeout: concurrent ? 620000 : (phase === 'restart' ? 400000 : 200000), maxBuffer: 8 * 1024 * 1024
      });
      const item = JSON.parse(fs.readFileSync(path.join(output, phase + '.json'), 'utf8'));
      report.phases.push(item);
      // 首进程已退出，再移除测试原文件；次进程必须从旧会话快照读出像素。
      if (phase === 'live' && run.status === 0) fs.unlinkSync(path.join(temp, 'cover.png'));
      if (phase === 'parallel' && run.status === 0) verifyWorkerSessions(temp, item);
      assert.equal(run.status, 0, item.failure || run.error?.message || '验收进程未正常退出');
    }
    if (!concurrent) assert.notEqual(report.phases[0].pid, report.phases[1].pid);
    report.ok = true;
  } catch (error) {
    report.failure = error.message;
    process.exitCode = 1;
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    report.profileRemoved = !fs.existsSync(temp);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  }
}

/**
 * 用宿主已落盘的真实模型调用核对每条插话的独立子会话及其运行区间。
 * 只在隔离进程退出后读取该测试标签的档案，公开报告仅保留会话编号与时间。
 * @param {string} temp 本次专属临时目录。@param {object} sample 界面实测结果，按同轮原话关联卡片。
 */
function verifyWorkerSessions(temp, sample) {
  const sessionKey = require('node:crypto').createHash('sha256').update(sample.session).digest('hex');
  const dir = path.join(temp, 'parallel-archive', sessionKey);
  const receipts = new Map();
  const workers = [];
  for (const turn of fs.readdirSync(dir)) {
    const lines = fs.readFileSync(path.join(dir, turn, 'events.jsonl'), 'utf8').trimEnd().split('\n');
    for (const line of lines) {
      const event = JSON.parse(line);
      if (event.turnId !== sample.rows[0].turnId) continue;
      if (event.kind === 'direct-result') receipts.set(event.data.callId, event.at);
      if (event.kind === 'direct-start' && event.data.input.key.startsWith('worker:parallel:')) workers.push(event);
    }
  }
  const ids = new Set();
  for (const row of sample.rows) {
    const prefix = '【当前并发目标】' + row.goal + '\n';
    const hits = workers.filter(function match(event) { return event.data.input.turnText.startsWith(prefix) && receipts.has(event.data.callId); });
    assert.equal(hits.length, 1, '原插话应对应一次有真实返回的子会话调用：' + row.goal);
    const event = hits[0];
    row.workerKey = event.data.input.key;
    row.workerStartedAt = event.at;
    row.workerReturnedAt = receipts.get(event.data.callId);
    ids.add(row.workerKey);
  }
  assert.equal(ids.size, 2, '两个目标必须使用不同的模型子会话');
  const [first, second] = sample.rows;
  sample.workerOverlapMs = Math.min(Date.parse(first.workerReturnedAt), Date.parse(second.workerReturnedAt)) -
    Math.max(Date.parse(first.workerStartedAt), Date.parse(second.workerStartedAt));
  assert.ok(sample.workerOverlapMs > 0, '两个真实模型请求必须同时在途');
}

/** 在当前隔离主进程内操纵真实输入控件；只观察消息与卡片，不替换 IPC、存档或模型。 */
function child() {
  const { app } = require('electron');
  const [phase, temp, output] = process.argv.slice(2);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'report.json'), 'utf8'));
  const record = { phase, pid: process.pid, statuses: [] };
  const profile = path.join(temp, 'profile');
  app.setName('SpCodeFollowupLiveCheck');
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  let win;
  let finished = false;
  let step = '生产窗口初始化';
  const watchdog = setTimeout(function expired() { finish(new Error(step + '超时')); }, phase === 'parallel' ? 600000 : 180000);

  /** 记录阶段结果并真正退出 Electron；下一阶段从磁盘恢复同一个隔离实例。 */
  async function finish(error) {
    if (finished) return;
    finished = true;
    clearTimeout(watchdog);
    if (error) {
      record.failure = step + '：' + error.message;
      if (win && !win.isDestroyed()) {
        record.observed = await page('({events:(window.testChatEvents||[]).slice(-20),labels:Array.from(document.querySelectorAll(".interjection-todo-card li")).map(function line(el){return el.innerText;}),active:document.getElementById("btn-send")?.classList.contains("is-stop"),noticeEvents:window.testNoticeEvents,parallel:window.testParallel?.at(-1)})');
      }
    }
    fs.writeFileSync(path.join(output, phase + '.json'), JSON.stringify(record, null, 2));
    if (win && !win.isDestroyed()) await win.webContents.session.flushStorageData();
    app.quit();
    app.exit(error ? 1 : 0);
  }
  /** 在指定的生产窗口中执行页面观察或点击，返回实际页面结果。 */
  function page(code) { return win.webContents.executeJavaScript(code); }
  /** 等待界面达到目标；主动点击停止时允许该操作产生的取消回执，仍须等到卡片状态实际变化。 */
  async function until(label, code, expectedErrors = []) {
    step = label;
    for (;;) {
      const value = await page(code);
      if (value) return value;
      const error = await page('window.testModelError || document.querySelector(".restart-review-failed")?.innerText');
      if (error && !expectedErrors.includes(error)) throw new Error(label + '：' + error);
      await new Promise(function tick(resolve) { setTimeout(resolve, 40); });
    }
  }
  /** 按当前卡片的实际布局截图，区域以页面 CSS 像素表示。 */
  async function capture(selector, filename) {
    const clip = await page('(async function locate(){const el=document.querySelector(' + JSON.stringify(selector) + ');el.scrollIntoView({block:"center",behavior:"instant"});await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);const r=el.getBoundingClientRect();return {x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height,scale:1};})()');
    const image = await win.webContents.debugger.sendCommand('Page.captureScreenshot', { format: 'png', clip });
    fs.writeFileSync(path.join(output, filename), Buffer.from(image.data, 'base64'));
  }
  /** 从实际项目入口打开验收会话。 */
  async function openWorkspace() {
    await until('打开项目入口', 'document.querySelector("#recent-list .recent-item[data-path]") !== null');
    await page('document.querySelector("#recent-list .recent-item[data-path]").click()');
    await until('项目会话', '!!document.querySelector("#tabs .tab.active")');
  }
  /** 在真实渲染进程记录同一时钟下的分支事件与可见卡片，按已投递的编号关联两者。 */
  function observeParallelDelivery() {
    window.testChatEvents = [];
    window.testParallel = [];
    window.testDeliveries = {};
    window.testParallelClock = performance.timeOrigin;
    const rows = window.testDeliveries;
    /** 以原卡片实际显示的状态和回执为准。界面一起更新的时间只记首次。 */
    function observeRows() {
      for (const card of document.querySelectorAll('.interjection-todo-card [data-interjection-id]')) {
        const row = rows[card.dataset.interjectionId];
        if (!row || row.cardAt !== undefined || !card.getClientRects().length) continue;
        const label = card.querySelector('strong').innerText;
        if (label !== 'AI 已看 · 已处理') continue;
        row.cardAt = performance.now();
        row.label = label;
        row.visibleLabelsAtDelivery = {};
        for (const peer of document.querySelectorAll('.interjection-todo-card [data-interjection-id]')) {
          if (peer.getClientRects().length) row.visibleLabelsAtDelivery[peer.dataset.interjectionId] = peer.querySelector('strong').innerText;
        }
        row.displayedResult = card.querySelector('.interjection-result')?.innerText;
        row.othersRunning = Object.values(rows).filter(function running(other) {
          return other !== row && other.start !== undefined && other.end === undefined;
        }).map(function id(other) { return other.id; });
      }
    }
    new MutationObserver(observeRows).observe(document.body, { childList: true, subtree: true, characterData: true });
    /** 保存每个真实分支首次运行及结果发布时间；完整快照中的其他行不重复计时。 */
    window.simple.onChatEvent(function observe(event) {
      if (event.turnId) window.testChatEvents.push(event.type);
      if (event.type === 'error') window.testModelError = event.text || event.message;
      if (event.type !== 'agi_parallel') return;
      window.testParallel.push(event.tasks);
      const now = performance.now();
      for (const task of event.tasks) {
        for (const id of task.interjectionIds || []) {
          if (!rows[id]) rows[id] = { id, turnId: event.turnId, goal: task.goal };
          const row = rows[id];
          if (task.status === 'running' && row.start === undefined) row.start = now;
          if (task.status === 'completed' && row.end === undefined) {
            row.end = now;
            row.result = task.result;
          }
        }
      }
      observeRows();
    });
  }
  /** 实际实现两个独立导出函数，核对重叠的运行区间、可见的逐项交付和磁盘功能。 */
  async function verifyParallel() {
    await openWorkspace();
    await page('(' + observeParallelDelivery.toString() + ')()');
    await page('document.getElementById("input").value="解释书目卡片的用途。";document.getElementById("btn-send").click()');
    await until('可提交两条独立插话', 'window.testChatEvents.length && document.getElementById("btn-enqueue").textContent.trim()==="插话"');
    const goals = [
      '实现 sum.cjs，直接导出函数计算输入账款数组的 amount 合计，用 invoice.json 实测并报告总额。',
      '实现 duplicates.cjs，直接导出函数返回输入颜色数组中所有重复的颜色名，每种只返回一次，用 palette.txt 实测并报告重复颜色。'
    ];
    await page('(async function submit(goals){const input=document.getElementById("input");const button=document.getElementById("btn-enqueue");for(const goal of goals){input.value=goal;await button.onclick();}})(' + JSON.stringify(goals) + ')');
    const both = await until('两个功能子代理同时运行', 'window.testParallel.find(function overlap(tasks){return tasks.filter(function active(t){return t.status==="running" && t.interjectionIds?.length;}).length===2;})');
    record.session = await page('document.querySelector("#tabs .tab.active").dataset.id');
    record.clockOrigin = await page('new Date(window.testParallelClock).toISOString()');
    record.concurrentGoals = both.map(function goal(task) { return task.goal; });
    await until('第一条结果交付时另一条仍在处理', 'Object.values(window.testDeliveries).some(function first(row){return row.othersRunning?.length;}) || window.testParallel.at(-1).every(function ended(task){return task.status==="completed" || task.status==="blocked";})');
    record.rows = await page('Object.values(window.testDeliveries)');
    assert.ok(record.rows.some(function first(row) { return row.othersRunning?.length === 1 && row.result === row.displayedResult; }), '第一项在另一子代理运行期间须显示已处理和自己的完整结果');
    const partial = record.rows.find(function early(row) { return row.othersRunning?.length === 1; });
    assert.equal(partial.visibleLabelsAtDelivery[partial.id], 'AI 已看 · 已处理');
    assert.equal(partial.visibleLabelsAtDelivery[partial.othersRunning[0]], 'AI 已看 · 处理中');
    await capture('.interjection-todo-card', 'first-delivery.png');
    await until('两项功能均在各自的卡片交付', 'Object.values(window.testDeliveries).every(function done(row){return row.cardAt!==undefined;})');
    record.rows = await page('Object.values(window.testDeliveries)');
    assert.equal(record.rows.length, 2);
    assert.equal(new Set(record.rows.map(function turn(row) { return row.turnId; })).size, 1);
    const [first, second] = record.rows;
    record.overlapMs = Math.min(first.end, second.end) - Math.max(first.start, second.start);
    assert.ok(record.overlapMs > 0, '两个实际运行区间必须重叠');
    for (const row of record.rows) {
      assert.ok(goals.includes(row.goal) && row.result && row.end > row.start && row.cardAt >= row.end);
      assert.equal(row.label, 'AI 已看 · 已处理');
      assert.equal(row.displayedResult, row.result);
    }
    const invoice = record.rows.find(function match(row) { return row.goal.includes('sum.cjs'); });
    const palette = record.rows.find(function match(row) { return row.goal.includes('duplicates.cjs'); });
    assert.ok(invoice.result.replace(/[,，\s]/g, '').includes(report.expectedAmount));
    assert.ok(palette.result.includes(report.expectedColor));
    const workspace = path.join(temp, 'workspace');
    const sum = require(path.join(workspace, 'sum.cjs'));
    const duplicates = require(path.join(workspace, 'duplicates.cjs'));
    record.functionalResults = {
      invoiceSum: sum(JSON.parse(fs.readFileSync(path.join(workspace, 'invoice.json'), 'utf8'))),
      colors: duplicates(fs.readFileSync(path.join(workspace, 'palette.txt'), 'utf8').split('\n'))
    };
    assert.equal(String(record.functionalResults.invoiceSum), report.expectedAmount);
    assert.deepEqual(record.functionalResults.colors, [report.expectedColor]);
    assert.equal(sum([{ amount: 8 }, { amount: -2 }]), 6);
    assert.deepEqual(duplicates(['灰', '蓝', '灰', '蓝', '灰']).sort(), ['灰', '蓝'].sort());
    await until('主会话结束', '!document.getElementById("btn-send").classList.contains("is-stop")');
    await capture('.interjection-todo-card', 'parallel-delivery.png');
    record.statuses = await page('Array.from(document.querySelectorAll(".interjection-todo-card li strong"), function label(el){return el.innerText;})');
    assert.deepEqual(record.statuses, ['AI 已看 · 已处理', 'AI 已看 · 已处理']);
  }
  /** 在测试图片上绘制只有从像素才能获得的书号，返回浏览器实际编码的 PNG。 */
  function drawPicture(code) {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 250;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'black';
    ctx.font = '38px sans-serif';
    ctx.fillText('待办：核对下列书号的页数', 36, 76);
    ctx.font = 'bold 62px monospace';
    ctx.fillText(code, 36, 174);
    return canvas.toDataURL('image/png');
  }

  /** 经生产附件按钮选入测试 PNG。仅代选操作系统文件对话框，预览、插话及恢复均走正式接口。 */
  async function selectPicture() {
    const file = path.join(temp, 'cover.png');
    const url = await page('(' + drawPicture.toString() + ')(' + JSON.stringify(report.pictureCode) + ')');
    fs.writeFileSync(file, Buffer.from(url.split(',')[1], 'base64'));
    const { dialog } = require('electron');
    const original = dialog.showOpenDialog;
    try {
      dialog.showOpenDialog = async function select() { return { canceled: false, filePaths: [file] }; };
      await page('document.getElementById("btn-attach").onclick()');
      assert.ok(await page('!!document.querySelector(".chip-img img")'));
    } finally {
      dialog.showOpenDialog = original;
    }
  }

  /** 通过界面提交插话并停止本轮，随后把另一项独立需求手动加入待发队列。 */
  async function live() {
    await openWorkspace();
    await page('window.testChatEvents=[];window.testModelError="";window.simple.onChatEvent(function observe(e){if(e.type==="error")window.testModelError=e.text||e.message;if(e.turnId)window.testChatEvents.push(e.type);});true');
    await page('document.getElementById("input").value="请分段举例解释书籍页码、页数和印张的区别，以及三者分别如何核对。";document.getElementById("btn-send").click()');
    await until('运行中可插话', 'window.testChatEvents.length>0 && document.getElementById("btn-enqueue").textContent.trim()==="插话"');
    // 先提交续办，再补充具体要求；无论两条是否同批送达，最新的真实工作都应显示处理中。
    await page('(async function submit(){const input=document.getElementById("input");const button=document.getElementById("btn-enqueue");input.value="继续";await button.onclick();input.value=' + JSON.stringify('还要核对《' + report.followup + '》报告的表格行数，原表稍后提供。') + ';await button.onclick();})()');
    const label = 'Array.from(document.querySelectorAll(".interjection-todo-card li")).find(function hit(el){return el.getClientRects().length && el.innerText.includes(' + JSON.stringify(report.followup) + ');})?.querySelector("strong")?.innerText';
    const pending = await until('原插话卡片显示', label);
    record.statuses.push(pending);
    await until('SDK 发送期间卡片显示处理中', '(' + label + ')?.endsWith("处理中")');
    record.statuses.push(await page(label));
    const continuing = 'Array.from(document.querySelectorAll(".interjection-todo-card li")).find(function hit(el){return el.getClientRects().length && el.innerText.trim().endsWith("继续");})?.querySelector("strong")?.innerText';
    await until('续办指令收到真实模型回执后立即办结', '(' + continuing + ')==="AI 已看 · 已处理"');
    record.continueStatus = await page(continuing);
    const seen = await until('模型活动后卡片显示已看和处理中', '(' + label + ')==="AI 已看 · 处理中"');
    assert.equal(seen, true);
    record.statuses.push(await page(label));
    await capture('.interjection-todo-card', 'processing.png');
    await selectPicture();
    await page('document.getElementById("input").value=""; document.getElementById("btn-enqueue").onclick()');
    record.pictureId = await until('纯图插话原编号', 'Array.from(document.querySelectorAll(".interjection-todo-card li")).find(function hit(el){return el.innerText.includes("cover.png");})?.dataset.interjectionId');
    await page('document.getElementById("btn-send").click()');
    await until('停止后留下未办插话', '!document.getElementById("btn-send").classList.contains("is-stop") && (' + label + ')==="AI 已看 · 待处理"', ['The operation was aborted', '已停止']);
    record.statuses.push(await page(label));
    await page('document.getElementById("input").value=' + JSON.stringify('核对《' + report.queued + '》手册的页码。') + ';document.getElementById("btn-enqueue").click()');
    const id = await page('document.querySelector("#tabs .tab.active").dataset.id');
    const file = path.join(profile, 'sessions', id + '.json');
    step = '待办和排队需求落盘';
    for (;;) {
      if (fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (saved.queue?.some(function match(item) { return item.text.includes(report.queued); }) &&
            saved.workingMemory?.interjectionTodos?.some(function match(item) { return item.seen && item.status === 'pending' && item.text.includes(report.followup); })) {
          const { collectPendingReview } = await import('../renderer/interjection-state.mjs');
          const restored = collectPendingReview(saved);
          const photo = restored.interjections.find(function match(item) { return item.id === record.pictureId; });
          const png = fs.readFileSync(path.join(temp, 'cover.png'));
          assert.deepEqual(Buffer.from(photo.attachments[0].dataUrl.split(',')[1], 'base64'), png);
          record.savedImageBytes = png.length;
          record.seenBeforeRestart = !!saved.workingMemory.interjectionTodos.find(function match(item) { return item.id === record.pictureId; }).seen;
          assert.ok(!JSON.stringify(restored, function omitPixels(key, value) { return key === 'dataUrl' ? undefined : value; }).includes(report.pictureCode));
          break;
        }
      }
      await new Promise(function tick(resolve) { setTimeout(resolve, 40); });
    }
    record.session = id;
  }
  /** 只观察启动后自动出现的真实模型摘要和原卡片，不发送消息，也不手动启动查看。 */
  async function restart() {
    const summary = await until('重启模型只读查看', 'document.querySelector(".restart-review-done .restart-review-line:last-child")?.innerText');
    record.summary = summary;
    assert.ok(summary.includes(report.pictureCode), '重启模型须从像素读出随机书号：' + summary);
    record.pictureId = report.phases[0].pictureId;
    const pictureSelector = '.interjection-todo-card [data-interjection-id="' + record.pictureId + '"] strong';
    record.pictureStatus = await until('纯图插话按原编号显示已看', 'document.querySelector(' + JSON.stringify(pictureSelector) + ')?.innerText');
    assert.equal(record.pictureStatus, 'AI 已看 · 待处理');
    assert.ok(summary.includes(report.followup) && summary.includes(report.queued), '模型摘要应读回两项独立随机名称：' + summary);
    // 历史消息按可见区域排版，先滚回原卡片再读实际显示文字。
    await until('重启后原插话卡片恢复', 'Boolean(document.querySelector(".interjection-todo-card li"))');
    await capture('.interjection-todo-card', 'restored-interjections.png');
    const status = await until('恢复卡片显示原需求状态', 'Array.from(document.querySelectorAll(".interjection-todo-card li")).find(function hit(el){return el.textContent.includes(' + JSON.stringify(report.followup) + ');})?.querySelector("strong")?.innerText');
    record.continueStatus = await until('恢复卡片显示续办状态', 'Array.from(document.querySelectorAll(".interjection-todo-card li")).find(function hit(el){return el.textContent.trim().endsWith("继续");})?.querySelector("strong")?.innerText');
    assert.equal(record.continueStatus, 'AI 已看 · 已处理');
    record.statuses.push(status);
    assert.equal(status, 'AI 已看 · 待处理');
    const id = await page('document.querySelector("#tabs .tab.active").dataset.id');
    assert.equal(id, report.phases[0].session);
    await capture('.restart-review-done', 'restart-review.png');
    // 告知回执是另一轮独立模型请求，使用它自己的验收时间。
    watchdog.refresh();
    await verifyNotice();
  }
  /** 另开会话投递没有独立交付的自然语言告知，核实模型实际给出的逐条回执。 */
  async function verifyNotice() {
    const previousId = await page('document.querySelector("#tabs .tab.active").dataset.id');
    await page('document.getElementById("btn-new-tab").click()');
    await until('新会话可用', 'document.querySelector("#tabs .tab.active").dataset.id!==' + JSON.stringify(previousId));
    await page('window.testNoticeEvents=[];window.testNoticeStarted=false;window.simple.onChatEvent(function observe(e){if(e.turnId)window.testNoticeStarted=true;if(e.type==="error")window.testModelError=e.text||e.message;if(e.type==="interjection_todos" && e.items.some(function hit(i){return i.text.includes("浅橙色封面") && i.seen && i.status==="completed";}))window.testNoticeEvents.push({seen:true,active:document.getElementById("btn-send").classList.contains("is-stop")});});document.getElementById("input").value="请解释图书封面和扉页的区别。";document.getElementById("btn-send").click()');
    await until('可提交纯告知', 'window.testNoticeStarted && document.getElementById("btn-enqueue").textContent.trim()==="插话" && document.getElementById("btn-send").classList.contains("is-stop")');
    await page('document.getElementById("input").value="我手边的书是浅橙色封面，只是告诉你一声，无需答复或做任何操作。";document.getElementById("btn-enqueue").click()');
    const notice = 'Array.from(document.querySelectorAll(".interjection-todo-card li")).find(function hit(el){return el.getClientRects().length && el.innerText.includes("浅橙色封面");})?.querySelector("strong")?.innerText';
    await until('纯告知获得模型的已处理回执', '(' + notice + ')==="AI 已看 · 已处理"');
    record.noticeStatus = await page(notice);
    assert.ok(await page('window.testNoticeEvents.some(function live(e){return e.seen && e.active;})'), '主任务仍在运行时已经收到独立告知的完成回执');
    await capture('.interjection-todo-card', 'notice.png');
  }
  /** 绑定生产主窗口并执行所属阶段，测试窗口可在后台保持真实布局。 */
  app.on('browser-window-created', function observe(_event, candidate) {
    candidate.webContents.setBackgroundThrottling(false);
    candidate.webContents.on('did-finish-load', async function loaded() {
      if (win || !candidate.webContents.getURL().endsWith('/renderer/index.html')) return;
      win = candidate;
      try {
        win.webContents.debugger.attach('1.3');
        if (phase === 'parallel') await verifyParallel();
        else if (phase === 'live') await live();
        else await restart();
        await finish();
      } catch (error) { await finish(error); }
    });
  });
  require('../electron/main.js');
}
