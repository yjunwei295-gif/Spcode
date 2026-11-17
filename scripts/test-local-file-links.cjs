/** 在隔离的完整页面验证聊天文件链接、只读预览与生产目录定位 IPC；不启动链接指向的程序。 */
'use strict';
const { app, BrowserWindow, ipcMain, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const appRoot = process.argv[2] ? path.resolve(process.argv[2]) : root;
if (appRoot !== root) Object.defineProperty(app, 'isPackaged', { value: true });
const workspaceApi = require(path.join(appRoot, 'electron/lib/workspace'));
const output = fs.mkdtempSync(path.join(root, 'generated', 'file-links-check-'));
app.setPath('userData', path.join(output, 'user-data'));
const binaryRel = 'generated/程序 #1 & (测试).exe';
const textRel = 'generated/说明 #1.md';
const imageRel = 'generated/图片 #1.png';
const reveals = [];
let win;
let checks = 0;
let liveReveal = false;
app.on('window-all-closed', function keepAlive() {});
/** 所有通过项均由实际观测断言产生。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 等待实际页面条件；失败输出页面诊断，不能把等待结束当作成功。 */
async function until(expression) {
  for (let i = 0; i < 100; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(function delay(resolve) { setTimeout(resolve, 30); });
  }
  const details = await win.webContents.executeJavaScript('({url:location.href,errors:fullPageRecord.errors,preview:document.getElementById("preview-body").innerText})');
  throw Error('条件超时：' + expression + '\n' + JSON.stringify(details));
}
/** 复用真实文件读取及目录 IPC；先记录路径断言，末项再实际唤起资源管理器供系统核对。 */
function registerHandlers() {
  const source = fs.readFileSync(path.join(appRoot, 'electron/main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('workspace:read'");
  const end = source.indexOf("ipcMain.handle('file:preview'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.substring(start, end), {
    ipcMain, fs, path, APP_ROOT: root, ...workspaceApi,
    ...require(path.join(appRoot, 'electron/lib/media')),
    getWin: function owner() { return win; },
    workspaceByWin: { get: function workspace() { return output; } },
    extraRoots: function extras() { return []; },
    shell: { showItemInFolder: function reveal(file) { reveals.push(file); if (liveReveal) shell.showItemInFolder(file); } }
  });
}
/** 点击真实聊天链接；文件路径来自 Markdown 输出而不是测试直接调用预览函数。 */
async function clickLink(label) {
  await win.webContents.executeJavaScript('findFileLink(' + JSON.stringify(label) + ').click();true');
}
/** 在指定节点右键再点击原有“打开所在目录”，检查生产 IPC 解析后的目标。 */
async function revealFrom(expression, expected) {
  const count = reveals.length;
  await win.webContents.executeJavaScript(expression + '.dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:450,clientY:350}));true');
  check(await win.webContents.executeJavaScript('!document.getElementById("ctx-menu").classList.contains("hidden")'), '右键显示文件定位菜单');
  await win.webContents.executeJavaScript('document.querySelector("[data-ctx=reveal]").click();true');
  await until('document.getElementById("ctx-menu").classList.contains("hidden")');
  check(reveals.length === count + 1 && reveals[count] === expected, '右键操作定位到原始文件，特殊字符未丢失');
}
/** 顺序验证文本、图片、二进制和现有网址，不并发运行打包或模型任务。 */
async function main() {
  await app.whenReady();
  fs.mkdirSync(path.join(output, 'generated'));
  fs.writeFileSync(path.join(output, binaryRel), Buffer.from([77, 90, 0, 1, 2, 3, 4, 5]));
  fs.writeFileSync(path.join(output, textRel), '# 文件链接预览\n\n中文内容与 & 字符。', 'utf8');
  const png = nativeImage.createFromBitmap(Buffer.from([30, 80, 150, 255]), { width: 1, height: 1 });
  fs.writeFileSync(path.join(output, imageRel), png.toPNG());
  const binary = path.join(output, binaryRel);
  const executable = appRoot === root
    ? path.join(root, require('../package.json').build.directories.output, 'win-unpacked', 'SimpleCode.exe')
    : path.join(path.dirname(path.dirname(appRoot)), 'SimpleCode.exe');
  const meta = workspaceApi.readForPreview(root, executable);
  check(meta.kind === 'binary' && meta.size === fs.statSync(executable).size && !('content' in meta), '真实大型 EXE 只返回元信息，不传送完整二进制内容');
  const preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, 'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("fileFixture",{read:function(p){return ipcRenderer.invoke("workspace:read",p)},reveal:function(p){return ipcRenderer.invoke("shell:showInFolder",p)}});');
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload, backgroundThrottling: false } });
  registerHandlers();
  const fixture = fs.readFileSync(path.join(root, 'scripts/test-ui-performance.cjs'), 'utf8');
  const start = fixture.indexOf('function fullPageSetup() {');
  const end = fixture.indexOf('\n/**', start);
  assert.ok(start >= 0 && end > start);
  // 本测试不发送热更新通知；补齐当前页面所需的订阅、状态和确认接口，不伪造可重载版本。
  const setup = fixture.substring(start, end) + '\nfullPageSetup();simple.onHotReload=function onHotReload(){return function unsubscribe(){};};simple.hotReloadStatus=async function hotReloadStatus(){return null;};simple.hotReloadReady=async function hotReloadReady(){return false;};const originalState=simple.getState;simple.getState=async function(){const s=await originalState();s.workspace=' + JSON.stringify(output) + ';return s;};simple.readWorkspaceFile=fileFixture.read;simple.showInFolder=fileFixture.reveal;window.findFileLink=function(label){for(const a of document.querySelectorAll("#messages a")){if(a.textContent===label)return a;}throw Error("链接不存在："+label);};';
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: setup });
  await win.loadFile(path.join(appRoot, 'renderer/index.html'));
  await until('!!document.querySelector("#tabs .tab")');
  await win.webContents.executeJavaScript('document.getElementById("input").value="本地文件链接验收";document.getElementById("btn-send").click();true');
  await until('!!fullPageRecord.turnId');
  const markdown = '[新版程序](' + executable.replace(/\\/g, '/') + ')\n\n[特殊字符文件](<' + binary.replace(/\\/g, '/') + '>)\n\n[说明文档](<' + textRel + '>)\n\n[图片](<' + imageRel + '>)\n\n[原有网址](https://example.com/?a=1&b=2)\n\n[脚本协议](javascript:alert%281%29)\n\n[数据协议](data:text/html,test)\n\n`[代码内路径](./unrelated.exe)`';
  await win.webContents.executeJavaScript('emitTestChat({type:"done",turnId:fullPageRecord.turnId,text:' + JSON.stringify(markdown) + '});fullPageRecord.resolveTurn(true);true');
  await until('document.querySelectorAll("#messages a[data-preview-file]").length===4');
  check(await win.webContents.executeJavaScript('findFileLink("原有网址").href==="https://example.com/?a=1&b=2"&&findFileLink("原有网址").target==="_blank"'), '原有网页链接与查询参数保持正常');
  check(await win.webContents.executeJavaScript('document.querySelectorAll("#messages a").length===5&&document.querySelector("#messages code").textContent.includes("unrelated.exe")'), '脚本和数据协议不可点击，代码内路径保持原文');
  const pageUrl = win.webContents.getURL();
  await clickLink('新版程序');
  await until('!!document.querySelector(".file-info-preview")');
  check(await win.webContents.executeJavaScript('document.querySelector(".file-info-preview strong").textContent==="SimpleCode.exe"&&document.querySelector(".file-info-preview").textContent.includes("修改时间")'), '与交付消息相同的绝对路径可打开 EXE 文件信息预览');
  check(win.webContents.getURL() === pageUrl && BrowserWindow.getAllWindows().length === 1, '预览不会导航当前页面或打开额外程序窗口');
  await clickLink('特殊字符文件');
  await until('document.querySelector(".file-info-preview strong")?.textContent==="程序 #1 & (测试).exe"');
  check(await win.webContents.executeJavaScript('document.querySelector(".file-info-preview").textContent.includes("8 字节")'), '含空格、中文、井号、括号及与号的目标按原路径读取');
  await revealFrom('findFileLink("特殊字符文件")', binary);
  await revealFrom('document.querySelector(".file-info-preview strong")', binary);
  await clickLink('说明文档');
  await until('document.querySelector("#preview-body h1")?.textContent==="文件链接预览"');
  check(true, '相对路径文档链接复用 Markdown 内容预览');
  await clickLink('图片');
  await until('document.querySelector("#preview-body img")?.naturalWidth===1');
  check(true, '图片文件链接复用可解码的图片预览');
  await clickLink('新版程序');
  await until('document.querySelector(".file-info-preview strong")?.textContent==="SimpleCode.exe"');
  check(await win.webContents.executeJavaScript('fullPageRecord.errors.length===0'), '完整页面没有脚本异常');
  liveReveal = true;
  await revealFrom('findFileLink("新版程序")', executable);
  fs.writeFileSync(path.join(output, 'preview.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, output, reveals, executable, meta }, null, 2));
  console.log('RESULT ' + output);
  app.exit(0);
}
setTimeout(function timeout() { console.error('本地文件链接验收超时'); app.exit(1); }, 30000).unref();
main().catch(function failed(error) { console.error(error.stack); app.exit(1); });
