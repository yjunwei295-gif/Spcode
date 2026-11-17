/** 在隔离 Electron 页面核对生成事件、媒体解码、右键定位和会话重载；不调用任何生成模型。 */
'use strict';
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
// 可传 app.asar 验收实际打包代码；测试夹具和输出仍保留在项目 generated 目录。
const appRoot = process.argv[2] ? path.resolve(process.argv[2]) : root;
// 使用打包源码时同步 Electron 的打包标记，避免加载开发环境专用的训练归档依赖。
if (appRoot !== root) Object.defineProperty(app, 'isPackaged', { value: true });
const workspaceApi = require(path.join(appRoot, 'electron/lib/workspace'));
const output = fs.mkdtempSync(path.join(root, 'generated', 'media-preview-check-'));
app.setPath('userData', path.join(output, 'user-data'));
const imageRel = 'generated/角色 #1.png';
const videoRel = 'generated/角色 #1.mp4';
const saved = path.join(output, 'history.json');
const reveals = [];
let win;
let checks = 0;
app.on('window-all-closed', function keepAlive() {});
/** 行为断言同时输出证据。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 等待实际 DOM 条件，避免以固定延时冒充已加载。 */
async function until(expression) {
  for (let i = 0; i < 120; i++) {
    if (await win.webContents.executeJavaScript(expression)) return;
    await new Promise(function wait(resolve) { setTimeout(resolve, 50); });
  }
  const details = await win.webContents.executeJavaScript('({url:location.href,build:window.__APP_BUILD,record:window.fullPageRecord,body:document.body?.innerText.slice(0,500)})');
  throw new Error('页面条件超时：' + expression + '\n' + JSON.stringify(details));
}
/** 执行本地解码夹具命令，失败保留 stderr。 */
function ffmpeg(args) {
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}
/** 暴露真实生成入口，只隔离收费模型边界，用于检查参数和单次失败行为。 */
async function testGenerationBridge() {
  const file = path.join(appRoot, 'electron/lib/agent.js');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  let calls = 0;
  let fail = false;
  async function generateMedia(options) {
    calls++;
    assert.equal(options.imagePath, path.join(output, imageRel));
    assert.equal(options.duration, 5);
    if (fail) throw new Error('fixture-generation-failed');
    return { ext: '.mp4', buf: fs.readFileSync(path.join(output, videoRel)) };
  }
  loaded.require = function dependency(name) {
    if (name === './generate') return { generateMedia };
    return Module.prototype.require.call(loaded, name);
  };
  loaded._compile(fs.readFileSync(file, 'utf8') + '\nmodule.exports.previewTest={generateRole};', file);
  const vs = { models: [], providers: [], assemblies: {}, capabilityDefaults: { videoGen: {
    primary: { type: 'api', model: 'fixture', baseUrl: 'https://fixture.test/v1', apiKey: 'fixture' },
    fallbacks: [{ type: 'api', model: 'second', baseUrl: 'https://second.test/v1', apiKey: 'fixture' }]
  } } };
  const events = [];
  function onEvent(event) { events.push(event); }
  const request = { vs, role: 'videoGen', prompt: '参考角色攻击', workspace: output, extra: [], onEvent, snap: {}, lang: 'zh', imageRequest: { imagePath: imageRel, duration: 5 } };
  const result = await loaded.exports.previewTest.generateRole(request);
  check(result.ok && calls === 1 && events.some(function media(event) { return event.type === 'generated_media' && event.media.path === result.rel && event.media.kind === 'video'; }), '真实 Agent 传递参考图和时长，落盘后发布媒体事件');
  fail = true;
  calls = 0;
  const failed = await loaded.exports.previewTest.generateRole(request);
  check(!failed.ok && calls === 1 && failed.detail.includes('fixture-generation-failed'), '视频失败不调用备用槽位重复生成');
}
/** 注册生产文件预览和文件夹定位 IPC，文件管理器边界仅记录绝对路径。 */
function registerProductionHandlers() {
  const source = fs.readFileSync(path.join(appRoot, 'electron/main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('workspace:read'");
  const end = source.indexOf("ipcMain.handle('file:preview'", start);
  assert.ok(start >= 0 && end > start);
  vm.runInNewContext(source.substring(start, end), {
    ipcMain, fs, path, APP_ROOT: root, getWin: function owner() { return win; },
    workspaceByWin: { get: function workspace() { return output; } },
    extraRoots: function extraRoots() { return []; }, ...workspaceApi,
    ...require(path.join(appRoot, 'electron/lib/media')), shell: { showItemInFolder: function show(file) { reveals.push(file); } }
  });
  ipcMain.handle('fixture:children', function children(_event, rel) { return workspaceApi.listChildren(output, rel); });
  ipcMain.handle('fixture:save', function save(_event, value) { fs.writeFileSync(saved, JSON.stringify(value)); return true; });
  ipcMain.handle('fixture:load', function load() { return fs.existsSync(saved) ? [JSON.parse(fs.readFileSync(saved, 'utf8'))] : []; });
}
/** 在完整 HTML、CSS、ES 模块和真实文件 IPC 上执行用户操作。 */
async function main() {
  await app.whenReady();
  fs.mkdirSync(path.join(output, 'generated'));
  ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=24:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path.join(output, videoRel)]);
  ffmpeg(['-i', path.join(output, videoRel), '-frames:v', '1', path.join(output, imageRel)]);
  await testGenerationBridge();
  const preload = path.join(output, 'preload.cjs');
  fs.writeFileSync(preload, 'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("mediaFixture",{read:function(p){return ipcRenderer.invoke("workspace:read",p)},reveal:function(p){return ipcRenderer.invoke("shell:showInFolder",p)},children:function(p){return ipcRenderer.invoke("fixture:children",p)},save:function(v){return ipcRenderer.invoke("fixture:save",v)},load:function(){return ipcRenderer.invoke("fixture:load")}});');
  win = new BrowserWindow({ show: false, width: 1280, height: 900, webPreferences: { preload, backgroundThrottling: false } });
  registerProductionHandlers();
  const fixture = fs.readFileSync(path.join(root, 'scripts/test-ui-performance.cjs'), 'utf8');
  const start = fixture.indexOf('function fullPageSetup() {');
  const end = fixture.indexOf('\n/**', start);
  const setup = fixture.substring(start, end) + '\nfullPageSetup();const originalState=simple.getState;simple.getState=async function(){const s=await originalState();s.workspace=' + JSON.stringify(output) + ';return s;};simple.readWorkspaceFile=mediaFixture.read;simple.showInFolder=mediaFixture.reveal;simple.listChildren=mediaFixture.children;simple.saveSession=mediaFixture.save;simple.loadSessions=mediaFixture.load;simple.loadSession=async function(){return (await mediaFixture.load())[0];};';
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: setup });
  await win.loadFile(path.join(appRoot, 'renderer/index.html'));
  await until('!!document.querySelector("#tabs .tab")');
  await win.webContents.executeJavaScript('document.getElementById("input").value="生成媒体预览测试";document.getElementById("btn-send").click();true');
  await until('!!fullPageRecord.turnId');
  for (const item of [{ path: imageRel, kind: 'image' }, { path: videoRel, kind: 'video' }]) {
    await win.webContents.executeJavaScript('emitTestChat({type:"generated_media",turnId:fullPageRecord.turnId,media:' + JSON.stringify(item) + '});true');
  }
  await until('document.querySelector(".chat-media-card img")?.naturalWidth===320&&document.querySelector(".chat-media-card video")?.readyState>=2');
  check(await win.webContents.executeJavaScript('document.querySelectorAll(".chat-media-card").length===2&&document.querySelector(".chat-media-card video").controls'), '生成事件在对话中显示可解码图片和带播放控件的视频');
  await win.webContents.executeJavaScript('window.savedPlayer=document.querySelector(".chat-media-card video");savedPlayer.currentTime=0.75;true');
  await until('Math.abs(savedPlayer.currentTime-0.75)<0.1&&!savedPlayer.seeking');
  await win.webContents.executeJavaScript('savedPlayer.play()', true);
  await until('savedPlayer.currentTime>1&&!savedPlayer.paused');
  await win.webContents.executeJavaScript('savedPlayer.pause();true');
  check(await win.webContents.executeJavaScript('savedPlayer.paused&&savedPlayer.currentTime>1'), '视频实际播放推进画面，暂停和拖动都可用');
  await win.webContents.executeJavaScript('emitTestChat({type:"generated_media",turnId:fullPageRecord.turnId,media:' + JSON.stringify({ path: videoRel, kind: 'video' }) + '});true');
  check(await win.webContents.executeJavaScript('document.querySelectorAll(".chat-media-card").length===2&&document.querySelector(".chat-media-card video")===savedPlayer&&savedPlayer.currentTime>0.6'), '重复事件去重，重绘保留视频节点和拖动位置');
  await win.webContents.executeJavaScript('document.querySelector(".chat-media-card img").click();true');
  check(await win.webContents.executeJavaScript('!document.getElementById("lightbox").classList.contains("hidden")'), '图片点击后可放大预览');
  await win.webContents.executeJavaScript('document.getElementById("lightbox").click();document.querySelector(".chat-media-card video").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:500,clientY:850}));true');
  check(await win.webContents.executeJavaScript('!document.getElementById("ctx-menu").classList.contains("hidden")&&document.querySelector("[data-ctx=resource]").textContent.includes("资源列表")&&document.getElementById("ctx-menu").getBoundingClientRect().bottom<=innerHeight'), '视频右键展示两个定位选项，菜单不超出窗口');
  await win.webContents.executeJavaScript('document.querySelector("[data-ctx=resource]").click();true');
  await until('document.activeElement?.dataset.treeFile===' + JSON.stringify(encodeURIComponent(videoRel)));
  check(await win.webContents.executeJavaScript('!document.getElementById("file-tree").classList.contains("hidden")&&document.activeElement.classList.contains("on")'), '在资源列表显示自动展开目录并选中视频文件');
  await win.webContents.executeJavaScript('document.querySelector(".chat-media-card img").dispatchEvent(new MouseEvent("contextmenu",{bubbles:true,cancelable:true,clientX:500,clientY:400}));document.querySelector("[data-ctx=reveal]").click();true');
  await until('document.getElementById("ctx-menu").classList.contains("hidden")');
  check(reveals.length === 1 && reveals[0] === path.join(output, imageRel), '图片右键通过生产 IPC 定位实际文件夹和文件');
  await win.webContents.executeJavaScript('emitTestChat({type:"done",turnId:fullPageRecord.turnId,text:"媒体已生成"});fullPageRecord.resolveTurn(true);true');
  await until('!document.getElementById("btn-send").disabled');
  check(fs.existsSync(saved) && JSON.parse(fs.readFileSync(saved, 'utf8')).messages.some(function hasMedia(message) { return message.generatedMedia?.length === 2; }), '真实保存记录包含两条媒体引用');
  await win.reload();
  await until('document.querySelectorAll(".chat-media-card").length===2&&document.querySelector(".chat-media-card video")?.readyState>=2');
  check(true, '重载完整会话后图片和视频预览仍可读取');
  check(await win.webContents.executeJavaScript('fullPageRecord.errors.length===0'), '界面没有脚本异常');
  win.showInactive();
  await win.webContents.executeJavaScript('document.querySelector(".chat-media-card video").scrollIntoView({block:"center"});true');
  fs.writeFileSync(path.join(output, 'preview.png'), (await win.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ checks, output }, null, 2));
  console.log('RESULT ' + JSON.stringify({ checks, output }));
  app.exit(0);
}
setTimeout(function timeout() { console.error('媒体预览验收超时'); app.exit(1); }, 60000);
main().catch(function failed(error) { console.error(error.stack); app.exit(1); });
