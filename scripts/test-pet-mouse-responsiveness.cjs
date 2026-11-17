/**
 * 实测桌宠透明区穿透、重新命中和系统鼠标延迟。
 * 只启动隔离小窗；坐标测试结束恢复鼠标。阻塞仅作用于测试主进程，且必须先证明未启用全局转发钩子。
 */
'use strict';
const { app, BrowserWindow, screen } = require('electron');
const { execFile, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = fs.mkdtempSync(path.join(__dirname, '..', 'generated', 'pet-mouse-check-'));
app.setPath('userData', path.join(output, 'user-data'));
const passed = [];
const calls = [];
let pet;
const nativeIgnore = BrowserWindow.prototype.setIgnoreMouseEvents;
/** 记录真实原生调用，禁止测试悄悄重新挂全局鼠标钩子。 */
BrowserWindow.prototype.setIgnoreMouseEvents = function recordIgnore(on, options) {
  calls.push({ on, forward: options && options.forward });
  assert.notEqual(options && options.forward, true);
  return nativeIgnore.call(this, on, options);
};
const nativeSource = 'using System;using System.Runtime.InteropServices;using System.Diagnostics;using System.Threading;public class PetProbe{[StructLayout(LayoutKind.Sequential)]public struct P{public int X;public int Y;}[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(P p);[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);public static long Hit(int x,int y){P p=new P();p.X=x;p.Y=y;return GetAncestor(WindowFromPoint(p),2).ToInt64();}public static string Latency(){double max=0;for(int i=0;i<20;i++){var s=Stopwatch.StartNew();mouse_event(1,0,0,0,UIntPtr.Zero);s.Stop();max=Math.Max(max,s.Elapsed.TotalMilliseconds);Thread.Sleep(25);}return max.ToString(System.Globalization.CultureInfo.InvariantCulture);}}';
/** 每次调用均在独立进程读写 Win32 鼠标，不依赖 Electron 页面派发的模拟悬停。 */
function native(code) {
  const script = "Add-Type -TypeDefinition '" + nativeSource + "';[PetProbe]::SetProcessDPIAware()|Out-Null;" + code;
  return new Promise(function execute(resolve, reject) {
    execFile('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true }, function done(error, stdout, stderr) {
      if (error) reject(new Error(String(error) + stderr)); else resolve(stdout.trim());
    });
  });
}
/** 短时等待实际 IPC 与绘制。 */
function pause(ms) { return new Promise(function delay(resolve) { setTimeout(resolve, ms); }); }
/** 记录行为断言。 */
function check(value, label) { assert.ok(value, label); passed.push(label); console.log('PASS ' + label); }
/** 将 DIP 转成原生坐标，移动后读取 Windows 命中窗口。 */
async function moveHit(x, y) {
  const point = screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) });
  return native('[PetProbe]::SetCursorPos(' + point.x + ',' + point.y + ')|Out-Null;Start-Sleep -Milliseconds 200;[PetProbe]::Hit(' + point.x + ',' + point.y + ')');
}
/** 在独立原生进程注入零位移事件；测试主线程停顿350ms期间事件仍须即时返回。 */
function latency() {
  return new Promise(function measure(resolve, reject) {
    const script = "Add-Type -TypeDefinition '" + nativeSource + "';[Console]::WriteLine('READY');Start-Sleep -Milliseconds 100;[Console]::WriteLine([PetProbe]::Latency())";
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', script], { windowsHide: true });
    let outputText = '', blocked = false, stderr = '';
    child.stdout.on('data', function received(data) {
      outputText += data.toString();
      if (!blocked && outputText.includes('READY')) {
        blocked = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 350);
      }
    });
    child.stderr.on('data', function errorText(data) { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', function closed(code) {
      if (code !== 0) reject(new Error(stderr));
      else resolve(Number(outputText.trim().split(/\s+/).pop()));
    });
  });
}
/** 用实际画布像素选点，验证透明与实心区域，不硬编码角色形状。 */
async function main() {
  await app.whenReady();
  const originalCursor = screen.getCursorScreenPoint();
  const { createFloatBar } = require('../electron/lib/float-bar');
  const bar = createFloatBar({ slotIndex: 95 });
  pet = BrowserWindow.getAllWindows()[0];
  const wc = pet.webContents;
  try {
    for (let i = 0; i < 100; i++) {
      if (!wc.isLoading() && await wc.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin)')) break;
      await pause(25);
    }
    check(BrowserWindow.getAllWindows().length === 1 && !pet.isVisible(), '启动没有创建或弹出独立对话窗');
    bar.show();
    const area = screen.getPrimaryDisplay().workArea;
    await wc.executeJavaScript('desktopPet.call("settings",{reducedMotion:true})');
    await pause(150);
    // 设置会重排原生窗口；重排完成后再移到测试区域。
    pet.setPosition(area.x + 20, area.y + 20);
    // 选取连续实心区域的中心，避免 DIP/屏幕像素取整将轮廓边缘采样移到透明像素。
    const opaque = await wc.executeJavaScript('(function(){const c=document.getElementById("pet-canvas"),r=c.getBoundingClientRect(),p=c.getContext("2d").getImageData(0,0,c.width,c.height).data;for(let y=20;y<c.height-20;y++)for(let x=20;x<c.width-20;x++){let solid=true;for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++)if(p[((y+dy)*c.width+x+dx)*4+3]<240)solid=false;if(solid)return {x:r.left+(x+.5)*r.width/c.width,y:r.top+(y+.5)*r.height/c.height};}throw Error("找不到连续实心区域");})()');
    const bounds = pet.getContentBounds();
    const handle = pet.getNativeWindowHandle().readBigUInt64LE().toString();
    check(await moveHit(bounds.x + 1, bounds.y + 1) !== handle, '透明边角真实穿透到底层窗口');
    // 画布点为页面 CSS 像素，先应用页面缩放转成 DIP，再交给 moveHit 转成屏幕像素。
    const zoom = wc.getZoomFactor();
    check(await moveHit(bounds.x + opaque.x * zoom, bounds.y + opaque.y * zoom) === handle, '未转发鼠标事件仍能从穿透恢复角色命中');
    check(await moveHit(bounds.x + 1, bounds.y + 1) !== handle, '离开实心像素后再次恢复穿透');
    check(calls.some(function ignored(call) { return call.on; }) && calls.every(function safe(call) { return call.forward === false; }), '所有真实穿透调用均禁用全局钩子');
    const maxMouseEventMs = await latency();
    check(Number.isFinite(maxMouseEventMs) && maxMouseEventMs < 200, '测试主线程停顿350ms时系统鼠标事件未被拖住：' + maxMouseEventMs.toFixed(2) + 'ms');
    bar.hide();
    check(await wc.executeJavaScript('desktopPet.call("cursor")') === null, '隐藏角色不读取系统鼠标坐标');
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ passed, calls, maxMouseEventMs }, null, 2));
    console.log('RESULT ' + output);
  } catch (error) {
    // 保留真实鼠标、窗口与页面状态，失败时区分命中逻辑、坐标换算和测试被外部输入打断。
    const diagnostics = { passed, calls, cursor: screen.getCursorScreenPoint(), bounds: pet.getContentBounds(), visible: pet.isVisible(), error: error.stack };
    diagnostics.page = await wc.executeJavaScript('(async function(){const point=await desktopPet.call("cursor"),c=document.getElementById("pet-canvas"),r=c.getBoundingClientRect();let alpha=null;if(point){const x=Math.floor((point.clientX-r.left)*c.width/r.width),y=Math.floor((point.clientY-r.top)*c.height/r.height);if(x>=0&&x<c.width&&y>=0&&y<c.height)alpha=c.getContext("2d").getImageData(x,y,1,1).data[3];}return {point,alpha,hidden:document.hidden,state:desktopPetInspect()};})()');
    fs.writeFileSync(path.join(output, 'failure.json'), JSON.stringify(diagnostics, null, 2));
    console.error('FAILURE ' + output);
    throw error;
  } finally {
    const original = screen.dipToScreenPoint(originalCursor);
    await native('[PetProbe]::SetCursorPos(' + original.x + ',' + original.y + ')|Out-Null');
    bar.destroy();
  }
  app.exit(0);
}
setTimeout(function timeout() { console.error('鼠标响应验收超时'); app.exit(1); }, 30000).unref();
main().catch(function failed(error) { console.error(error.stack); app.exit(1); });
