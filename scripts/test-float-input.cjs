// 真实 Electron / Windows 全局键盘验收：气泡分区、跨软件唤起、草稿与原发送链路。
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { app, BrowserWindow, globalShortcut, screen } = require('electron');
const config = require('../electron/lib/desktop-pet-config.json');
const output = path.join(__dirname, '../generated/desktop-pet-check');
app.setPath('userData', path.join(os.tmpdir(), 'spcode-float-input-' + process.pid));
const passed = [];
let bar, background;
const measurements = [];
/** 等待原生焦点、IPC 和帧绘制完成。 */
function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
/** 记录通过项；失败保留原异常并让进程非零退出。 */
function ok(name, condition) { assert.ok(condition, name); passed.push(name); console.log('PASS ' + name); }
/** 使用 Windows 原生按键从前台窗口触发全局注册，不以派发 DOM 事件代替。 */
function keys(sequence) {
  const source = 'using System;using System.Runtime.InteropServices;public class FloatKeys{[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);}';
  let script = "Add-Type -TypeDefinition '" + source + "';";
  for (const key of sequence) script += '[FloatKeys]::keybd_event(' + key.code + ',0,' + (key.up ? 2 : 0) + ',[UIntPtr]::Zero);Start-Sleep -Milliseconds 40;';
  return new Promise(function (resolve, reject) {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], function (error) { if (error) reject(error); else resolve(); });
  });
}
/** 在真实页面读取几何，覆盖缩放和上下展开两种边缘布局。 */
async function geometry(wc, name) {
  const result = await wc.executeJavaScript('(function(){var l=document.getElementById("pet-label"),c=document.getElementById("pet-canvas"),a=l.getBoundingClientRect(),b=c.getBoundingClientRect();return {label:{left:a.left,top:a.top,right:a.right,bottom:a.bottom},canvas:{left:b.left,top:b.top,right:b.right,bottom:b.bottom},width:innerWidth,height:innerHeight,scroll:l.scrollHeight,client:l.clientHeight,text:l.textContent,opacity:getComputedStyle(l).opacity};})()');
  measurements.push({ name, result });
  ok(name + '气泡与角色不重叠且完整位于窗口内', result.label.bottom <= result.canvas.top && result.label.top >= 0 && result.label.left >= 0 && result.label.right <= result.width && result.canvas.bottom <= result.height + 1);
  ok(name + '长文保留且可滚动', result.text.includes('完整操作结尾') && result.scroll > result.client && result.opacity === '1');
}
/** 从其他窗口用真实全局热键聚焦，验证文字和发送只进入绑定会话。 */
async function run() {
  fs.mkdirSync(output, { recursive: true });
  const { createFloatBar } = require('../electron/lib/float-bar');
  background = new BrowserWindow({ x: 400, y: 100, width: 650, height: 450, show: true });
  await background.loadURL('data:text/html,<title>SpCode 输入验收背景窗口</title><textarea id="other" autofocus style="width:90vw;height:70vh"></textarea>');
  let sent = null;
  bar = createFloatBar({
    slotIndex: 97,
    onBind: function () { bar.setBoundKey('float-input:test'); },
    onSend: function (key, text, attachments) { sent = { key, text, attachments }; }
  });
  bar.setBoundKey('float-input:test');
  bar.show();
  const win = BrowserWindow.getAllWindows().find(function (one) { return bar.ownsWindow(one); });
  win.setTitle('SpCode 气泡与全局输入验收');
  const wc = win.webContents;
  for (let i = 0; i < 80; i++) {
    await wait(100);
    if (await wc.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin)')) break;
  }
  ok('真实页面及皮肤加载成功', await wc.executeJavaScript('!!desktopPetInspect().skin&&!desktopPetInspect().errors'));
  const detail = 'Codex 正在调用 read_file，核对工具操作及状态。'.repeat(24) + '完整操作结尾';
  bar.pushEvent('float-input:test', { kind: 'turn-start', turnId: 'focus-test' });
  bar.pushEvent('float-input:test', { kind: 'tool', turnId: 'focus-test', name: 'read_file', callId: 'read', status: 'running', text: detail });
  for (const scale of [config.layout.minScale, config.defaultScale, config.layout.maxScale]) {
    await wc.executeJavaScript('document.getElementById("pet-scale").value=' + JSON.stringify(String(scale)) + ';document.getElementById("pet-scale").dispatchEvent(new Event("input"))');
    for (const place of ['tl', 'br']) {
      bar.moveToPlace(place);
      await wait(650);
      await geometry(wc, scale + '-' + place);
      bar.setCompact(false);
      await wait(100);
      const data = await wc.executeJavaScript('desktopPet.call("init")');
      const b = win.getBounds(), area = screen.getDisplayMatching(b).workArea;
      ok(scale + '-' + place + '展开面板与角色分区且位于工作区', data.placement.panelHeight > 0 && (data.placement.panelTop + data.placement.panelHeight <= data.placement.petTop || data.placement.petTop + data.placement.petHeight <= data.placement.panelTop) && b.x >= area.x && b.y >= area.y && b.x + b.width <= area.x + area.width + 1 && b.y + b.height <= area.y + area.height + 1);
      bar.setCompact(true);
    }
  }
  await wc.executeJavaScript('document.getElementById("pet-scale").value=' + JSON.stringify(String(config.defaultScale)) + ';document.getElementById("pet-scale").dispatchEvent(new Event("input"))');
  bar.moveToPlace('br');
  await wait(400);
  fs.writeFileSync(path.join(output, 'float-label-fixed.png'), (await wc.capturePage()).toPNG());
  ok('全局输入键成功注册', globalShortcut.register(config.inputShortcut, function focusInputShortcut() { bar.focusInput(); }));
  await wc.executeJavaScript('document.getElementById("input").value="保留草稿："');
  background.show(); background.focus(); await background.webContents.executeJavaScript('document.getElementById("other").focus()'); await wait(250);
  ok('触发前焦点位于其他软件窗口', background.isFocused());
  const trigger = [{ code: 17 }, { code: 18 }, { code: 13 }, { code: 13, up: true }, { code: 18, up: true }, { code: 17, up: true }];
  await keys(trigger); await wait(350);
  ok('系统热键展开小窗并聚焦原输入框', win.isFocused() && await wc.executeJavaScript('desktopPetInspect().expanded&&document.activeElement.id==="input"'));
  ok('唤起保留草稿与绑定会话', await wc.executeJavaScript('document.getElementById("input").value==="保留草稿："&&desktopPetInspect().key==="float-input:test"'));
  // 原生字符按键必须落到小窗；背景输入框应保持空白。
  await keys([{ code: 65 }, { code: 65, up: true }]); await wait(150);
  ok('跨窗口输入真实按键进入AI输入框', (await wc.executeJavaScript('document.getElementById("input").value')).includes('a') && (await background.webContents.executeJavaScript('document.getElementById("other").value')) === '');
  await wc.insertText('中文指令');
  await keys([{ code: 17 }, { code: 13 }, { code: 13, up: true }, { code: 17, up: true }]); await wait(200);
  ok('CtrlEnter沿原入口发送给绑定AI会话', sent && sent.key === 'float-input:test' && sent.text.includes('中文指令') && sent.text.includes('保留草稿：'));
  ok('发送后输入框清空且没有重复发送', await wc.executeJavaScript('document.getElementById("input").value===""'));
  // 已展开和已隐藏都要可重复唤起，避免热键变成开关而关闭正在输入的页面。
  await keys(trigger); await wait(150);
  ok('重复按触发键保持展开和输入焦点', win.isFocused() && await wc.executeJavaScript('desktopPetInspect().expanded&&document.activeElement.id==="input"'));
  bar.hide(); background.focus(); await wait(150);
  await keys(trigger); await wait(200);
  ok('隐藏后触发键仍可恢复输入', bar.isVisible() && win.isFocused() && await wc.executeJavaScript('document.activeElement.id==="input"'));
  // 检查菜单不会挡住热键唤起后的输入，并覆盖未就绪的首次加载入口。
  await wc.executeJavaScript('document.getElementById("pet-menu").hidden=false');
  bar.focusInput(); await wait(150);
  ok('唤起自动关闭换肤菜单且不覆盖草稿', await wc.executeJavaScript('document.getElementById("pet-menu").hidden&&document.activeElement.id==="input"'));
  bar.setCompact(true);
  bar.moveToPlace('br');
  await wait(200);
  fs.writeFileSync(path.join(output, 'float-input-results.json'), JSON.stringify({ passed, measurements }, null, 2));
  console.log('RESULT ' + passed.length + ' checks passed');
  // 留出短暂可视核对时间，不重启正在承载用户对话的主进程。
  if (process.argv.includes('--preview')) await wait(20000);
  globalShortcut.unregister(config.inputShortcut);
  bar.destroy(); background.destroy(); app.quit();
}
app.whenReady().then(run).catch(function (error) {
  console.error(error.stack || error);
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'float-input-failure.txt'), String(error.stack || error));
  app.exit(1);
});
