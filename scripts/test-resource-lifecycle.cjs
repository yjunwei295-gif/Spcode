/**
 * 真实 Electron 生命周期回归：隐藏创建/销毁桌宠、IPC/显示器监听回收、媒体缓存淘汰及视频释放。
 * 使用独立用户目录；不连接模型、不启动压缩或转码，不改用户配置。
 */
'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'resource-lifecycle-'));
app.setPath('userData', path.join(output, 'user-data'));
app.on('window-all-closed', function keepAlive() {});
const passed = [];
const channels = ['send', 'answer', 'abort', 'start', 'bind', 'hide', 'compact'];
/** 断言真实观测结果，同时保留可复核的结果清单。 */
function check(value, label) { assert.ok(value, label); passed.push(label); console.log('PASS ' + label); }
/** 捕获全局事件持有量；创建/销毁后必须返回同一基线。 */
function listenerCounts() {
  const counts = { quit: app.listenerCount('before-quit'), displays: screen.listenerCount('display-removed') + screen.listenerCount('display-metrics-changed') };
  for (const name of channels) counts[name] = ipcMain.listenerCount('floatbar:' + name);
  return counts;
}
/** 给已开始的窗口加载和销毁回调一次排空机会。 */
function pause(ms) { return new Promise(function delay(resolve) { setTimeout(resolve, ms); }); }
/** 等待真实角色页完成加载，不只检查 BrowserWindow 已创建。 */
async function ready(wc) {
  for (let i = 0; i < 100; i++) {
    if (!wc.isLoading() && await wc.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin)')) return;
    await pause(25);
  }
  throw new Error('角色页加载超时');
}
/** 在真实页面及真实模块中检查媒体对象生命周期，只替换文件读取数据。 */
async function mediaLifecycle(win) {
  const source = fs.readFileSync(path.join(root, 'renderer/media-preview.js'), 'utf8');
  const moduleUrl = 'data:text/javascript;base64,' + Buffer.from(source + '\nexport function retainedPreviewCount(){return previews.size;}').toString('base64');
  return win.webContents.executeJavaScript('(' + browserMediaTest.toString() + ')(' + JSON.stringify(moduleUrl) + ')');
}
/** 浏览器内保留旧视频引用观察其释放，同时检查连续切换会话的缓存大小。 */
async function browserMediaTest(moduleUrl) {
  const m = await import(moduleUrl);
  const root = document.createElement('div');
  document.body.appendChild(root);
  let reads = 0;
  const api = { readWorkspaceFile: async function read(file) { reads++; return { kind: 'image', content: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>' }; } };
  function escape(value) { return String(value); }
  for (let i = 0; i < 120; i++) {
    root.innerHTML = '<div data-msg-i="0">' + m.mediaCardsHtml({ generatedMedia: [{ path: 'image-' + i + '.png' }] }, escape) + '</div>';
    m.loadMediaPreviews(root, api, 'workspace-' + i, new Map());
    await Promise.resolve();
    if (m.retainedPreviewCount() !== 1) throw new Error('切换后仍保留旧图片：' + m.retainedPreviewCount());
  }
  root.innerHTML = '';
  m.loadMediaPreviews(root, api, 'empty', new Map());
  const cleared = m.retainedPreviewCount() === 0;
  // 使用真实 HTMLVideoElement，断开卡片后仍保留引用以核对媒体源被主动释放。
  root.innerHTML = '<div data-msg-i="1"><figure data-media-path="v.mp4"><video src="file:///not-loaded.mp4"></video></figure></div>';
  const video = root.querySelector('video');
  const players = m.existingMediaPlayers(root);
  root.innerHTML = '';
  m.loadMediaPreviews(root, api, 'empty', players);
  return { reads, cleared, videoReleased: !video.hasAttribute('src') && video.paused && players.size === 0 };
}
/** 核对真实主进程的标签关闭处理器，只释放所属窗口的登记。 */
function mainSessionRelease() {
  const source = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  const start = source.indexOf('  function forgetWindowSession(');
  const end = source.indexOf("  ipcMain.on('floatbar:forget-session'", start);
  assert.ok(start >= 0 && end > start);
  const owner = {};
  const context = {
    getWin: function getWin() { return owner; },
    makeSessionKey: function key(_win, id) { return '1:' + id; },
    sessionsByKey: new Map([['1:closed', '关闭'], ['2:other', '保留']]),
    canStartByKey: new Map([['1:closed', {}], ['2:other', {}]]),
    lastTabIdByWin: new Map([[owner, 'closed']]),
    boundKey: '1:closed', lastActiveKey: '1:closed', broadcasts: 0,
    broadcastSessions: function broadcast() { context.broadcasts++; }
  };
  vm.runInNewContext(source.substring(start, end), context);
  context.forgetWindowSession({}, 'closed');
  check(context.sessionsByKey.size === 1 && context.canStartByKey.size === 1 && context.sessionsByKey.has('2:other') && context.lastTabIdByWin.size === 0 && !context.boundKey && !context.lastActiveKey && context.broadcasts === 1, '关闭标签清除所属会话及选项，不清除其它窗口');
}
/** 首帧抛错时真实作品窗、子视图和文件监听均须立即释放。 */
async function artifactFailureCleanup() {
  const studio = require('../electron/lib/artifact-studio');
  const windows = require('../electron/lib/artifact-window');
  windows.registerIpc({ ipcMain, getWorkspace: function workspace() { return output; }, getOwner: function owner() { return null; } });
  const sourcePath = 'broken.html';
  fs.writeFileSync(path.join(output, sourcePath), '<html><script>window.renderFrame=function(){throw Error("EXPECTED_FIRST_FRAME_FAILURE")}</script></html>');
  const item = await studio.present({ workspace: output, args: { sourcePath, title: '加载失败生命周期验收', width: 320, height: 180, fps: 12, duration: 1 } });
  const watched = new Set();
  const watch = fs.watchFile, unwatch = fs.unwatchFile;
  fs.watchFile = function recordWatch(file, options, handler) { watched.add(file); return watch.call(fs, file, options, handler); };
  fs.unwatchFile = function recordUnwatch(file, handler) { watched.delete(file); return unwatch.call(fs, file, handler); };
  try {
    await assert.rejects(windows.open({ workspace: output, manifest: item.manifest, theme: 'dark' }), /EXPECTED_FIRST_FRAME_FAILURE/);
    check(windows.contexts.size === 0 && watched.size === 0 && BrowserWindow.getAllWindows().length === 0, '作品首次绘制失败释放上下文、双文件监听与窗口');
  } finally {
    fs.watchFile = watch;
    fs.unwatchFile = unwatch;
  }
}
/** 顺序创建实例，避免验收本身并发占用大量资源。 */
async function main() {
  await app.whenReady();
  const { createFloatBar } = require('../electron/lib/float-bar');
  const baseline = listenerCounts();
  const heap = [];
  for (let cycle = 0; cycle < 12; cycle++) {
    const bar = createFloatBar({ slotIndex: 96 });
    const pet = BrowserWindow.getAllWindows()[0];
    await ready(pet.webContents);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.equal(pet.isVisible(), false);
    bar.pushEvent('cycle-' + cycle, { kind: 'ai', text: '生命周期消息'.repeat(10000) });
    await pause(100);
    bar.destroy();
    await pause(30);
    assert.deepEqual(listenerCounts(), baseline, '第 ' + cycle + ' 次销毁仍残留监听');
    assert.equal(BrowserWindow.getAllWindows().length, 0);
    heap.push(process.memoryUsage().heapUsed);
  }
  check(true, '12 次真实创建销毁后，7 个 IPC/退出/显示器监听均回到基线，窗口数归零');
  const bar = createFloatBar({ slotIndex: 96 });
  await ready(BrowserWindow.getAllWindows()[0].webContents);
  await pause(100);
  bar.destroy();
  bar.pushEvent('reopened', { kind: 'ai', text: '重新创建后仍可收消息' });
  await ready(BrowserWindow.getAllWindows()[0].webContents);
  check(ipcMain.listenerCount('floatbar:send') === baseline.send + 1, '同一实例销毁后重建只注册一组监听');
  const pet = BrowserWindow.getAllWindows()[0];
  const originalSend = pet.webContents.send.bind(pet.webContents);
  let history, quota;
  pet.webContents.send = function capture(channel, event) {
    if (event.kind === 'history') history = event;
    if (event.kind === 'quota') quota = event;
    originalSend(channel, event);
  };
  bar.pushEvent({ kind: 'sessions', sessions: [{ key: 'old', label: '关闭前' }] });
  bar.setBoundKey('old');
  bar.pushEvent('old', { kind: 'ai', text: '旧会话占用'.repeat(10000) });
  bar.pushEvent('old', { kind: 'quota', snapshot: { text: '旧余额' } });
  bar.pushEvent({ kind: 'sessions', sessions: [] });
  bar.pushEvent('old', { kind: 'ai', text: '关闭后迟到消息' });
  bar.setBoundKey('old');
  check(history.items.length === 0 && quota.snapshot === null, '关闭会话回收历史和余额，迟到事件不能重新建立旧缓存');
  await pause(100);
  bar.destroy();
  assert.deepEqual(listenerCounts(), baseline);
  mainSessionRelease();
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('about:blank');
  const media = await mediaLifecycle(win);
  check(media.reads === 120 && media.cleared, '连续120次媒体会话切换只留当前图片，空会话缓存归零');
  check(media.videoReleased, '移除视频卡片主动暂停并清空媒体源，不保留解码器');
  win.destroy();
  await artifactFailureCleanup();
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed, baseline, final: listenerCounts(), heapBytes: heap, media }, null, 2));
  console.log('RESULT ' + output);
  app.exit(0);
}
setTimeout(function timeout() { console.error('资源生命周期验收超时'); app.exit(1); }, 45000).unref();
main().catch(function failed(error) { console.error(error.stack); app.exit(1); });
