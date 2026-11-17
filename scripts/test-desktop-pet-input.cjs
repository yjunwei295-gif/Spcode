// 真实 Electron 窗口验收：最新文字、独立置顶输入、快捷键与草稿生命周期。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const vm = require('vm');
app.setPath('userData', path.join(require('os').tmpdir(), 'spcode-pet-input-' + process.pid));
const results = [];
const output = path.join(__dirname, '..', 'generated', 'desktop-pet-check');
/** 等待事件与实际绘制，条件不成立时明确报错。 */
function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
/** 在有限时间内等待真实页面满足条件，避免固定延时冒充加载成功。 */
async function until(wc, expression) {
  for (let i = 0; i < 60; i++) {
    if (await wc.executeJavaScript(expression)) return;
    await wait(100);
  }
  const state = await wc.executeJavaScript('({focus:document.activeElement&&document.activeElement.id,error:document.getElementById("pet-error").textContent,visibility:document.visibilityState})');
  throw new Error('页面条件未满足：' + expression + ' ' + JSON.stringify(state));
}
/** 记录通过项，任何一项失败直接中止并输出真实堆栈。 */
function ok(name, value) { assert.ok(value, name); results.push(name); console.log('PASS ' + name); }
/** 使用 Chromium 的原生按键输入路径，不直接调用页面发送方法。 */
async function key(wc, code, modifiers) {
  wc.sendInputEvent({ type: 'keyDown', keyCode: code, modifiers: modifiers || [] });
  wc.sendInputEvent({ type: 'keyUp', keyCode: code, modifiers: modifiers || [] });
  await wait(100);
}
/** 提取主进程实际注册的回调，验证快捷键入口控制真实窗口而非另一份测试实现。 */
function inputShortcut(bar) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const start = source.indexOf("shortcutOk = globalShortcut.register('CommandOrControl+Alt+Space'");
  const end = source.indexOf('\n    if (!shortcutOk)', start);
  assert.ok(start >= 0 && end > start, '主进程快捷键入口存在');
  let handler;
  const context = { floatBar: bar, globalShortcut: {
    register: function (accelerator, callback) {
      assert.strictEqual(accelerator, 'CommandOrControl+Alt+Space');
      handler = callback;
      return true;
    }
  } };
  vm.runInNewContext(source.substring(start, end), context);
  return handler;
}
/** 实测独立窗口与现有消息、附件、问答、外观设置链路。 */
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const { createFloatBar } = require('../electron/lib/float-bar');
  const sends = [];
  let answered = null;
  const startupArea = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bar = createFloatBar({
    slotIndex: 97,
    onBind: function () { bar.setBoundKey('input-test:tab'); },
    onSend: function (sessionKey, text, attachments) { sends.push({ sessionKey, text, attachments }); },
    onAnswer: function (value) { answered = value; }
  });
  bar.setBoundKey('input-test:tab');
  const windows = BrowserWindow.getAllWindows();
  for (const one of windows) await until(one.webContents, '!!(window.desktopPetInspect&&desktopPetInspect().skin)');
  const pet = windows.find(function (one) { return !one.webContents.getURL().includes('dialogue=1'); });
  const wc = pet.webContents;
  ok('启动只初始化隐藏角色页，不创建或弹出独立对话窗', windows.length === 1 && !pet.isVisible() && !(await wc.executeJavaScript('desktopPetInspect().expanded')));
  const hotkey = inputShortcut(bar);
  hotkey();
  const panel = BrowserWindow.getAllWindows().find(function (one) { return one !== pet && bar.ownsWindow(one); });
  const input = panel.webContents;
  await until(input, '!!(window.desktopPetInspect&&desktopPetInspect().skin)&&document.activeElement===document.getElementById("input")');
  ok('首次快捷键按需创建置顶输入窗并聚焦，宠物仍隐藏', !pet.isVisible() && panel.isVisible() && panel.isAlwaysOnTop() && panel.isFocused());
  const centered = panel.getBounds();
  ok('输入框首次按屏幕居中而非按宠物定位', Math.abs(centered.x + centered.width / 2 - startupArea.x - startupArea.width / 2) <= 1 && Math.abs(centered.y + centered.height / 2 - startupArea.y - startupArea.height / 2) <= 1);
  hotkey();
  ok('主进程快捷键回调只收起输入框，不显示宠物', !panel.isVisible() && !pet.isVisible());
  hotkey();
  await until(input, 'document.activeElement===document.getElementById("input")');
  ok('宠物隐藏时快捷键仍可直接唤起并聚焦输入框', panel.isVisible() && panel.isFocused() && !pet.isVisible());
  // 消息流验收期间收起输入窗，避免长时间占据用户工作区；之后再用快捷键核对历史回灌。
  hotkey();
  panel.setPosition(startupArea.x + startupArea.width - centered.width, startupArea.y + startupArea.height - centered.height);
  bar.show();
  const initial = pet.getBounds();
  bar.pushEvent('input-test:tab', { kind: 'turn-start', turnId: 'one' });
  bar.pushEvent('input-test:tab', { kind: 'reason', turnId: 'one', text: '中文旧思考\n'.repeat(35) });
  await wait(650);
  bar.pushEvent('input-test:tab', { kind: 'ai', turnId: 'one', text: '旧回复\n'.repeat(35) + 'LATEST English tail 123' });
  await wait(650);
  const latest = await wc.executeJavaScript('(function(){var e=document.getElementById("pet-label");return {text:e.textContent,scroll:e.scrollTop,height:e.clientHeight,total:e.scrollHeight};})()');
  ok('长文字实际可见区滚至最新英文内容', latest.text.endsWith('LATEST English tail 123') && latest.scroll > 0 && Math.abs(latest.total - latest.height - latest.scroll) <= 2);
  bar.pushEvent('input-test:tab', { kind: 'tool', turnId: 'one', callId: 'read', name: 'read_file', status: 'running' });
  await wait(650);
  ok('工具动作不会把新回复盖回旧中文思考', await wc.executeJavaScript('document.getElementById("pet-label").textContent.endsWith("LATEST English tail 123")'));
  bar.pushEvent('input-test:tab', { kind: 'ai-delta', turnId: 'one', text: '\n最新追加 END' });
  await wait(650);
  ok('流式增量继续显示最新片段', await wc.executeJavaScript('document.getElementById("pet-label").textContent.endsWith("最新追加 END")'));
  assert.ok(panel, '独立窗口首次快捷键时已创建');
  hotkey();
  await until(input, '!!(window.desktopPetInspect&&desktopPetInspect().skin&&document.body.classList.contains("pet-dialogue"))');
  await until(input, 'document.activeElement===document.getElementById("input")');
  ok('输入框使用独立置顶窗口且角色大小位置不变', panel !== pet && panel.isAlwaysOnTop() && panel.isVisible() && JSON.stringify(initial) === JSON.stringify(pet.getBounds()));
  ok('独立页显示完整输入区且隐藏角色', await input.executeJavaScript('getComputedStyle(document.getElementById("frame")).display!=="none"&&getComputedStyle(document.getElementById("pet-stage")).display==="none"'));
  ok('首次加载回灌当前会话最新消息', await input.executeJavaScript('document.getElementById("msgs").textContent.includes("最新追加 END")'));
  await input.insertText('独立输入 draft');
  await wait(150);
  ok('获得焦点后直接捕获输入但不自动发送', sends.length === 0 && await input.executeJavaScript('document.getElementById("input").value==="独立输入 draft"'));
  await key(input, 'Enter');
  ok('普通回车不发送', sends.length === 0);
  await key(input, 'Enter', ['control']);
  ok('Ctrl+Enter只发送一次并携带正确会话', sends.length === 1 && sends[0].sessionKey === 'input-test:tab' && sends[0].text === '独立输入 draft');
  await input.insertText('输入法未确认');
  await input.executeJavaScript('document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",ctrlKey:true,isComposing:true,bubbles:true,cancelable:true}))');
  ok('输入法组词确认不误发送', sends.length === 1);
  await key(input, 'Escape');
  ok('Esc丢弃草稿且不发送', sends.length === 1 && await input.executeJavaScript('document.getElementById("input").value===""'));
  await input.insertText('收起保留的草稿');
  await input.executeJavaScript('document.getElementById("btnHide").click()');
  await wait(100);
  ok('收起独立对话窗仍保留角色', !panel.isVisible() && pet.isVisible());
  hotkey();
  await until(input, 'document.activeElement===document.getElementById("input")');
  ok('快捷键再次唤起复用原窗口并保留草稿', BrowserWindow.getAllWindows().length === 2 && await input.executeJavaScript('document.getElementById("input").value==="收起保留的草稿"'));
  const position = panel.getBounds();
  const area = screen.getDisplayMatching(position).workArea;
  panel.setPosition(area.x, area.y);
  const independentPosition = panel.getBounds();
  pet.setPosition(initial.x + 10, initial.y);
  await wc.executeJavaScript('document.getElementById("pet-label").click()');
  ok('移动宠物和点击气泡不控制输入窗位置或显隐', panel.isVisible() && JSON.stringify(independentPosition) === JSON.stringify(panel.getBounds()));
  hotkey();
  hotkey();
  ok('输入窗独立拖动后快捷键唤起保留位置', JSON.stringify(independentPosition) === JSON.stringify(panel.getBounds()));
  screen.emit('display-metrics-changed');
  ok('显示器变化按输入窗自身位置布局，不重新吸附宠物', JSON.stringify(independentPosition) === JSON.stringify(panel.getBounds()));
  bar.pushEvent('input-test:tab', { kind: 'ai-delta', turnId: 'one', text: '\n打开后新正文' });
  await until(input, 'document.getElementById("msgs").textContent.includes("打开后新正文")');
  ok('独立窗口持续接收实时消息', true);
  await wc.executeJavaScript('desktopPet.call("menu")');
  await until(input, '!document.getElementById("pet-menu").hidden');
  ok('角色菜单显示在独立窗口内', true);
  await input.executeJavaScript('document.getElementById("pet-scale").value="0.8";document.getElementById("pet-scale").dispatchEvent(new Event("input"))');
  await until(wc, 'desktopPetInspect().scale===0.8');
  ok('独立窗口调整外观同步角色', true);
  await input.executeJavaScript('document.getElementById("pet-preview").value="reading";document.getElementById("pet-preview").dispatchEvent(new Event("change"))');
  await until(wc, 'desktopPetInspect().presentedState==="reading"&&document.getElementById("pet-label").textContent.startsWith("预览 · ")');
  ok('独立设置菜单动作预览仍由角色播放', true);
  await input.executeJavaScript('document.getElementById("pet-menu-close").click()');
  await key(input, 'Escape');
  bar.pushAsk({ sessionKey: 'input-test:tab', turnId: 'one', question: '独立窗口确认', options: ['允许'] });
  await until(input, '!document.getElementById("ask").classList.contains("hidden")');
  await input.executeJavaScript('document.querySelector("#askOpts button").click()');
  await wait(100);
  ok('确认回调保留原会话与轮次', answered && answered.key === 'input-test:tab' && answered.turnId === 'one');
  fs.writeFileSync(path.join(output, 'independent-input.png'), (await input.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'latest-text.png'), (await wc.capturePage()).toPNG());
  // 人工画面核对模式短暂保留真实窗口，仍在结束时清理，不连接真实模型。
  if (process.argv.includes('--preview')) {
    panel.show();panel.focus();
    await input.executeJavaScript('document.getElementById("input").value="输入保留为草稿 · Ctrl+Enter 发送 · Esc 丢弃"');
    await wait(30000);
  }
  bar.hide();
  ok('隐藏宠物时独立输入窗继续显示', !pet.isVisible() && panel.isVisible());
  panel.close();
  ok('关闭独立输入窗只隐藏自身，宠物保持隐藏', !pet.isVisible() && !panel.isVisible());
  hotkey();
  await until(input, 'document.activeElement===document.getElementById("input")');
  await input.insertText('宠物隐藏时输入');
  ok('宠物隐藏后仍可唤起并直接输入', !pet.isVisible() && panel.isVisible() && await input.executeJavaScript('document.getElementById("input").value==="宠物隐藏时输入"'));
  await key(input, 'Escape');
  ok('独立丢弃不发送也不改变宠物显隐', sends.length === 1 && !pet.isVisible() && panel.isVisible() && await input.executeJavaScript('document.getElementById("input").value===""'));
  bar.destroy();
  ok('销毁实例时清理两个窗口', BrowserWindow.getAllWindows().length === 0);
  fs.writeFileSync(path.join(output, 'input-results.json'), JSON.stringify({ passed: results }, null, 2), 'utf8');
  app.quit();
}
app.whenReady().then(run).catch(function (error) { console.error(error.stack || error); app.exit(1); });
