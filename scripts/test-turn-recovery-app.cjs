'use strict';

// 通过正式主窗、preload 与聊天 IPC 核对页面重载。仅替换模型执行，所有测试数据随子进程退出清理。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');

/** 在私有用户目录启动测试实例；Chromium 关闭所有句柄后删除目录，断言失败也执行清理。 */
function runParent() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-turn-recovery-test-'));
  try {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = require('node:child_process').spawnSync(require('electron'), [__filename, directory], {
      env, stdio: 'inherit', timeout: 55000
    });
    if (child.error) throw child.error;
    assert.equal(child.status, 0, '隔离测试进程应正常退出');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

/** 等待一次具体状态变化，超时输出尚未达到的行为断言。 */
async function until(label, predicate) {
  const deadline = Date.now() + 9000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(30);
  }
  throw new Error('等待超时：' + label);
}

/** 在真实 Electron 中发送并暂停两轮回复，分别验证完成和停止。 */
function runElectron(directory) {
  const { app } = require('electron');
  const userData = path.join(directory, 'profile');
  const workspace = path.join(directory, 'project');
  for (const dir of [userData, workspace, path.join(directory, 'models'), path.join(directory, 'dumps')]) {
    fs.mkdirSync(dir);
  }
  app.setName('SpCodeTurnRecoveryTest');
  app.setPath('userData', userData);
  app.setPath('sessionData', userData);
  app.setPath('crashDumps', path.join(directory, 'dumps'));
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
    locale: 'zh', onboardingCompleted: true, autoSave: false, desktopAlive: false,
    trainingDataEnabled: false, currentModelId: 'local-gguf', modelsDir: path.join(directory, 'models'),
    models: [{ id: 'local-gguf', name: '验收', type: 'local', enabled: true }],
    providers: [], capabilityDefaults: {}, assemblies: {}, recents: [{ name: '验收工程', path: workspace }]
  }), 'utf8');

  const runs = [];
  /** 模型回包由测试手动推进；停止必须来自生产按钮经 IPC 发给原始 AbortSignal。 */
  require('../electron/lib/agent').runTurn = function controlledTurn(request) {
    return new Promise(function hold(resolve, reject) {
      function stop() { reject(Object.assign(new Error('已停止'), { name: 'AbortError' })); }
      request.signal.addEventListener('abort', stop, { once: true });
      function complete() {
        request.signal.removeEventListener('abort', stop);
        const text = '原轮次完成';
        request.onEvent({ type: 'done', text });
        resolve({ text, changes: [], taskPending: false });
      }
      runs.push({ request, complete });
      request.onEvent({ type: 'text', text: '刷新前片段' });
    });
  };

  /** 第一次加载聊天主窗后驱动界面；重载产生的新文档继续由同一个验收过程观察。 */
  let started = false;
  app.on('browser-window-created', function observe(_event, win) {
    win.setFocusable(false);
    win.webContents.on('did-finish-load', function loaded() {
      if (started || !win.webContents.getURL().endsWith('/renderer/index.html')) return;
      started = true;
      verify(win, runs).then(function pass() { app.exit(0); }, function fail(error) {
        console.error(error.stack);
        app.exit(1);
      });
    });
  });
  require('../electron/main');
}

/** 从真实 DOM 发消息、刷新并检查结果；禁止通过读取主进程缓存代替界面断言。 */
async function verify(win, runs) {
  const page = win.webContents.executeJavaScript.bind(win.webContents);
  const busy = "document.getElementById('btn-send')?.classList.contains('is-stop')";
  const messages = "document.getElementById('messages')?.textContent || ''";
  async function send(text) {
    await page("document.getElementById('input').value=" + JSON.stringify(text) +
      ";document.getElementById('btn-send').click();true");
  }
  /** 重载到新的实际文档并确认原文档标记已经消失。 */
  async function reload() {
    await page('window.__oldTurnDocument = true');
    const loaded = once(win.webContents, 'did-finish-load');
    win.webContents.reloadIgnoringCache();
    await loaded;
    assert.equal(await page('!!window.__oldTurnDocument'), false);
  }

  const recent = "document.querySelector('#recent-list .recent-item[data-path]')";
  await until('最近项目可打开', function ready() { return page('!!' + recent); });
  await page(recent + '.click();true');
  await until('聊天标签已建立', function opened() { return page("!!document.querySelector('#tabs .tab[data-id]')"); });
  await send('首轮正文');
  await until('首轮已经启动', function firstStarted() { return runs.length === 1; });
  const id = await page("document.querySelector('#tabs .tab.active').dataset.id");
  await reload();
  await until('自动保存关闭时原标签和停止按钮恢复', async function reattached() {
    return await page(busy) && await page("document.querySelector('#tabs .tab.active')?.dataset.id") === id;
  });
  runs[0].request.onEvent({ type: 'text', text: '刷新后片段' });
  await until('原用户正文和前后两段各出现一次', async function chunks() {
    const text = await page(messages);
    return ['首轮正文', '刷新前片段', '刷新后片段'].every(function exactlyOnce(part) {
      return text.split(part).length === 2;
    });
  });
  assert.equal(runs.length, 1);
  runs[0].complete();
  await until('原轮正常结束并恢复发送按钮', async function completed() {
    return !(await page(busy)) && (await page(messages)).includes('原轮次完成');
  });
  console.log('PASS 自动保存关闭，真实重载接回原标签、消息片段、最终回执，模型仅执行一次');

  await send('停止测试轮');
  await until('第二轮已经启动', function secondStarted() { return runs.length === 2; });
  await reload();
  await until('第二轮重新显示停止按钮', function stopVisible() { return page(busy); });
  await page("document.getElementById('btn-send').click();true");
  await until('原任务收到停止且界面收尾', async function stopped() {
    return runs[1].request.signal.aborted && !(await page(busy));
  });
  assert.equal(runs.length, 2);
  console.log('PASS 重载后的停止按钮取消原轮次，没有启动第三次模型调用');

  // 强制终止本测试的渲染进程；此时没有 beforeunload。模型在无页面期间结束。
  await send('崩溃间隙任务');
  await until('第三轮已经启动', function thirdStarted() { return runs.length === 3; });
  const gone = once(win.webContents, 'render-process-gone');
  win.webContents.forcefullyCrashRenderer();
  await gone;
  runs[2].complete();
  const loaded = once(win.webContents, 'did-finish-load');
  win.webContents.reload();
  await loaded;
  await until('崩溃间隙完成的结果已恢复', async function gapCompleted() {
    const text = await page(messages);
    return !(await page(busy)) && text.includes('崩溃间隙任务') && text.split('原轮次完成').length === 3;
  });
  assert.equal(await page("document.querySelectorAll('#tabs .tab').length"), 1);
  assert.equal(await page("document.querySelector('#tabs .tab.active').dataset.id"), id);
  assert.equal(runs.length, 3);
  console.log('PASS 渲染进程消失期间完成，重建页面恢复原标签、完整回执和以前的消息，没有重跑');

  await send('背景窗口任务甲');
  await until('甲轮次已接收', function fourthStarted() { return runs.length === 4; });
  await page("document.getElementById('btn-new-tab').click();true");
  await send('当前窗口任务乙');
  await until('乙轮次已接收', function fifthStarted() { return runs.length === 5; });
  const secondId = await page("document.querySelector('#tabs .tab.active').dataset.id");
  await page("document.getElementById('input').value='未提交草稿';true");
  await reload();
  await until('两个标签都在运行', function bothBusy() { return page("document.querySelectorAll('#tabs .tab.busy').length === 2"); });
  assert.equal(await page("document.querySelector('#tabs .tab.active').dataset.id"), secondId);
  assert.equal(await page("document.getElementById('input').value"), '未提交草稿');
  runs[3].complete();
  await until('后台完成时前台仍在运行', function onlyCurrent() {
    return page("document.querySelectorAll('#tabs .tab.busy').length === 1 && document.querySelector('#tabs .tab.active').classList.contains('busy')");
  });
  assert.ok(!(await page(messages)).includes('背景窗口任务甲'));
  runs[4].complete();
  await until('两轮都已完成', function allFinished() { return page("!document.querySelector('#tabs .tab.busy')"); });
  assert.equal(runs.length, 5);
  console.log('PASS 并发两标签各归原轮次，活动选择、未提交草稿和后台独立完成均正确');
}

if (process.versions.electron) runElectron(process.argv[2]);
else runParent();
