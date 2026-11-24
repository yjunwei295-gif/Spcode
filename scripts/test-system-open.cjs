'use strict';

/** 验证真实生产窗口的文件树启动和默认浏览器分流；仅执行本测试创建的程序，不读取用户会话。 */
const { app, BrowserWindow, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-system-open-'));
const workspace = path.join(output, '项目 #1 & (测试)');
const extra = path.join(output, '附加目录 #2');
const renderer = path.join(output, 'renderer');
const userData = path.join(output, 'user-data');
const report = { output, passed: [], paths: [], urls: [], requests: [], errors: [] };
const WAIT_MS = 20000;
// 为读屏和鼠标操作留出时间，同时在命令工具结束前保留失败报告。
const DESKTOP_CLICK_WAIT_MS = 45000;
const POLL_MS = 30;
// 仅在桌面验收时显示测试窗口，等待工具在真实聊天锚点上点击。
const desktopClick = process.argv.includes('--desktop-click');
let win, server, baseUrl, live = false, failOpen = false, finished = false, showChatFixture = false;
const actualOpenPath = shell.openPath.bind(shell);
const actualOpenExternal = shell.openExternal.bind(shell);

for (const folder of [workspace, extra, userData, path.join(output, 'models'), path.join(output, 'crash-dumps')]) fs.mkdirSync(folder, { recursive: true });
app.setName('SpCodeSystemOpenVerification');
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.setPath('crashDumps', path.join(output, 'crash-dumps'));
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ locale: 'zh', theme: 'dark', autoSave: false, onboardingCompleted: true, trainingDataEnabled: false, desktopAlive: false, cursorDirect: false, providers: [], currentModelId: 'local-gguf', modelsDir: path.join(output, 'models'), models: [{ id: 'local-gguf', name: '本地模型', type: 'local', model: '', enabled: true }], capabilityDefaults: {}, assemblies: {}, recents: [] }), 'utf8');
fs.cpSync(path.join(root, 'renderer'), renderer, { recursive: true });
fs.mkdirSync(path.join(output, 'electron', 'lib'), { recursive: true });
fs.copyFileSync(path.join(root, 'electron', 'lib', 'image-gen-options.js'), path.join(output, 'electron', 'lib', 'image-gen-options.js'));
const appFile = path.join(renderer, 'app.js');
const source = fs.readFileSync(appFile, 'utf8');
const ready = 'await receiveHotReload(await api.hotReloadStatus());';
const position = source.indexOf(ready);
assert.ok(position >= 0 && position === source.lastIndexOf(ready));
// 仅在临时副本加入观察口；生产点击处理、preload、主进程 IPC 和路径解析均不替换。
fs.writeFileSync(appFile, source.substring(0, position + ready.length) + '\nwindow.__systemOpenReady=true;' + source.substring(position + ready.length) + '\nwindow.__systemOpenTest={state,activeSession,newTab,loadFileTree,openLocalFile,renderMessages,showChat};\n', 'utf8');
const originalLoadFile = BrowserWindow.prototype.loadFile;
/** 只将测试主界面定向到增加观察口的副本，其他生产窗口使用原页面。 */
BrowserWindow.prototype.loadFile = function loadObserved(file, options) {
  if (file === path.join(root, 'renderer', 'index.html')) file = path.join(renderer, 'index.html');
  return originalLoadFile.call(this, file, options);
};
/** 先记录精确系统调用，开启实测阶段后仅放行本测试创建的文件。 */
shell.openPath = function recordPath(file) {
  report.paths.push(file);
  if (failOpen) return Promise.resolve('测试系统启动失败');
  if (!live) return Promise.resolve('');
  assert.ok(path.resolve(file).startsWith(workspace + path.sep), '实测只能启动测试目录文件');
  return actualOpenPath(file);
};
/** 先记录网页路由，实测阶段只放行本机服务器，避免访问真实外部服务。 */
shell.openExternal = function recordUrl(url) {
  report.urls.push(url);
  if (!live) return Promise.resolve();
  assert.ok(url.startsWith(baseUrl), '实测只能打开本机测试网页');
  return actualOpenExternal(url);
};
app.on('browser-window-created', observe);
/** 隐藏本测试新建窗口并记录界面异常，不操作用户当前窗口。 */
function observe(_event, window) {
  window.hide();
  window.on('show', hide);
  /** 除了桌面点击阶段的主窗口，其余验收窗口都在后台执行。 */
  function hide() { if (window !== win || !showChatFixture) window.hide(); }
  if (!win) win = window;
  window.webContents.on('console-message', recordError);
  function recordError(event) { if (event.level === 'error') report.errors.push(event.message); }
}
/** 每个通过项来自真实状态断言。 */
function check(value, label) { assert.ok(value, label); report.passed.push(label); console.log('PASS ' + label); }
/** 在真实生产主页面执行只针对隔离测试的观察表达式。 */
function page(expression) { return win.webContents.executeJavaScript(expression); }
/** 等待明确条件；超过指定毫秒数时，以对应场景名报告失败。 */
async function waitFor(predicate, label, timeoutMs = WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(delay);
    function delay(resolve) { setTimeout(resolve, POLL_MS); }
  }
  throw new Error('条件超时：' + label);
}
/** 对文件树真实按钮发送普通或 Ctrl 点击，保留编码后的原路径。 */
async function clickTree(file, ctrl) {
  await page('(function(){const encoded=' + JSON.stringify(encodeURIComponent(file)) + ';const row=document.querySelector("[data-tree-file=\\\""+encoded+"\\\"]");if(!row)throw Error("树节点不存在："+encoded);row.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true,ctrlKey:' + Boolean(ctrl) + '}));return true;})()');
}
/**
 * 点击由聊天渲染器生成的文件锚点。
 * @param {string} file 消息中的原始文件路径。
 * @returns {Promise<void>} 点击已送达；系统结果由后续断言单独核对。
 */
async function clickChatFile(file) {
  const selector = '#messages a[data-preview-file="' + encodeURIComponent(file) + '"]';
  await page('document.querySelector(' + JSON.stringify(selector) + ').click();true');
}
/** 点击真实网页锚点，覆盖新窗和当前页导航，不直接调用被测路由函数。 */
async function clickWeb(contents, url, target) {
  await contents.executeJavaScript('(function(){const a=document.createElement("a");a.href=' + JSON.stringify(url) + ';a.target=' + JSON.stringify(target) + ';a.textContent="打开方式验收";document.body.appendChild(a);a.click();a.remove();return true;})()');
}
/** 创建只写标记文件的 BAT、CMD 和本机编译 EXE，所有路径均相对本次临时目录。 */
function createLaunchFixtures() {
  const sourceCode = 'using System;using System.IO;public class LaunchFixture{public static void Main(){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"exe-started.txt"),"fixture");}}';
  const executable = path.join(workspace, '程序 #1 & (测试).EXE');
  const command = "Add-Type -TypeDefinition '" + sourceCode + "' -OutputAssembly '" + executable.replace(/'/g, "''") + "' -OutputType ConsoleApplication";
  const compiled = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(compiled.status, 0, compiled.stderr);
  fs.writeFileSync(path.join(workspace, '脚本 #1 & (测试).bat'), '@echo off\r\n> "%~dp0bat-started.txt" echo bat\r\n', 'utf8');
  fs.writeFileSync(path.join(workspace, '命令 #1 & (测试).CMD'), '@echo off\r\n> "%~dp0cmd-started.txt" echo cmd\r\n', 'utf8');
  fs.writeFileSync(path.join(extra, '附加 #2.cmd'), '@echo off\r\n', 'utf8');
  fs.writeFileSync(path.join(workspace, '说明.md'), '# 普通文件仍然预览\n\n测试正文', 'utf8');
}
/** 本机网页只用于证明默认浏览器收到请求，不包含用户内容或外部请求。 */
async function startServer() {
  server = http.createServer(receive);
  function receive(request, response) {
    report.requests.push(request.url);
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    response.end('<!doctype html><html><head><title>SpCode 打开方式验收</title></head><body>默认浏览器已成功打开本机测试页。此页可关闭。</body></html>');
  }
  await new Promise(listen);
  function listen(resolve) { server.listen(0, '127.0.0.1', resolve); }
  baseUrl = 'http://127.0.0.1:' + server.address().port;
  const html = '<!doctype html><meta charset="utf-8"><title>HTML 启动验收</title><script>location.replace(' + JSON.stringify(baseUrl + '/local-html') + ')</script>';
  fs.writeFileSync(path.join(workspace, '网页 #1 & (测试).HTML'), html, 'utf8');
  fs.writeFileSync(path.join(workspace, '另一网页.htm'), html, 'utf8');
}
/** 核对同一页面中的新窗、当前页、邮件与子资源边界。 */
async function verifyWebRoutes(contents, label) {
  const before = contents.getURL();
  const windowCount = BrowserWindow.getAllWindows().length;
  for (const target of ['_blank', '_self']) {
    const url = 'https://example.com/' + label + '?a=1&b=中文#段落-' + target;
    const count = report.urls.length;
    await clickWeb(contents, url, target);
    async function delivered() { return report.urls.length === count + 1; }
    await waitFor(delivered, label + '网页路由');
    check(report.urls[count] === new URL(url).href && contents.getURL() === before, label + target + '交给系统浏览器且原页面不变');
    check(BrowserWindow.getAllWindows().length === windowCount, label + target + '没有新增内置浏览器窗口');
  }
}
/** 完整生产进程中点击文件树，再真实启动受控程序及默认浏览器。 */
async function main() {
  createLaunchFixtures();
  await startServer();
  require('../electron/main.js');
  async function readyPage() { return win && !win.webContents.isLoading() && await page('Boolean(window.__systemOpenReady)'); }
  await waitFor(readyPage, '生产主界面初始化');
  await page('(async function(){const t=window.__systemOpenTest;t.newTab();t.state.workspace=' + JSON.stringify(workspace) + ';t.activeSession().workspace=t.state.workspace;t.activeSession().extraFolders=[' + JSON.stringify(extra) + '];t.state.treeOpen.add(' + JSON.stringify(extra.replace(/\\/g, '/')) + ');await simple.setWorkspace(t.state.workspace);await t.loadFileTree();return true;})()');
  const launchNames = ['网页 #1 & (测试).HTML', '另一网页.htm', '脚本 #1 & (测试).bat', '命令 #1 & (测试).CMD', '程序 #1 & (测试).EXE'];
  for (const name of launchNames) {
    const count = report.paths.length;
    await clickTree(name, false);
    async function launched() { return report.paths.length === count + 1; }
    await waitFor(launched, name + '系统打开');
    check(report.paths[count] === path.join(workspace, name), '文件树直接启动且保留中文和特殊字符：' + path.extname(name));
    check(await page('document.getElementById("code-preview").classList.contains("hidden")'), '启动文件不打开详情：' + path.extname(name));
  }
  const absolute = path.join(extra, '附加 #2.cmd');
  await clickTree(absolute.replace(/\\/g, '/'), false);
  function extraLaunched() { return report.paths[report.paths.length - 1] === absolute; }
  await waitFor(extraLaunched, '附加目录绝对路径');
  check(true, '附加目录的启动文件使用原始绝对路径');
  const count = report.paths.length;
  await clickTree(launchNames[2], true);
  check(report.paths.length === count && await page('window.__systemOpenTest.state.contextPaths.includes(' + JSON.stringify(launchNames[2]) + ')'), 'Ctrl 点击启动文件仍只添加上下文');
  await clickTree('说明.md', false);
  async function previewed() { return await page('document.querySelector("#preview-body h1")?.textContent==="普通文件仍然预览"'); }
  await waitFor(previewed, '普通文档预览');
  check(report.paths.length === count, '普通文件继续预览，不调用系统启动');
  failOpen = true;
  const failure = await page('(async function(){try{await window.__systemOpenTest.openLocalFile(' + JSON.stringify(launchNames[4]) + ');return "未拒绝";}catch(error){return error.message;}})()');
  failOpen = false;
  check(failure.includes('测试系统启动失败') && await page('document.querySelector("#preview-body h1")?.textContent==="普通文件仍然预览"'), '系统启动失败真实拒绝且不回退到详情');
  await verifyWebRoutes(win.webContents, '主窗口');
  const before = report.urls.length;
  await clickWeb(win.webContents, 'mailto:fixture@example.invalid?subject=test', '_blank');
  function mailDelivered() { return report.urls.length === before + 1; }
  await waitFor(mailDelivered, '邮件分流');
  check(report.urls[before] === 'mailto:fixture@example.invalid?subject=test', '原有邮件链接交给系统邮件程序');
  const resourceCount = report.urls.length;
  await page('fetch(' + JSON.stringify(baseUrl + '/fetch-resource') + ').then(function received(response){return response.text();})');
  /**
   * 只读检查本机服务器是否收到主页面的网络资源请求，供等待条件使用。
   * @returns {boolean} 已记录 /fetch-resource 请求时返回 true，否则返回 false。
   */
  function resourceLoaded() { return report.requests.includes('/fetch-resource'); }
  await waitFor(resourceLoaded, '页面网络资源加载');
  check(report.urls.length === resourceCount, '网页子资源仍在原页面加载，不误唤起浏览器');
  const studio = require('../electron/lib/artifact-studio');
  const scene = 'scene.html';
  fs.writeFileSync(path.join(workspace, scene), '<!doctype html><meta charset="utf-8"><title>作品外链验收</title><p>作品测试</p>', 'utf8');
  const item = await studio.present({ workspace, args: { sourcePath: scene, title: '作品外链验收', width: 640, height: 360 } });
  const ctx = await require('../electron/lib/artifact-window').open({ workspace, manifest: item.manifest, owner: win, theme: 'light' });
  await verifyWebRoutes(ctx.view.webContents, '作品页面');
  const frameUrls = report.urls.length;
  await ctx.view.webContents.executeJavaScript('(function(){const frame=document.createElement("iframe");frame.src=' + JSON.stringify(baseUrl + '/frame-resource') + ';document.body.appendChild(frame);return true;})()');
  /**
   * 只读检查本机服务器是否收到作品 iframe 的子页面请求，供等待条件使用。
   * @returns {boolean} 已记录 /frame-resource 请求时返回 true，否则返回 false。
   */
  function frameLoaded() { return report.requests.includes('/frame-resource'); }
  await waitFor(frameLoaded, '作品子页面加载');
  check(report.urls.length === frameUrls, '作品 iframe 子页面仍在内部加载，不误转系统浏览器');
  ctx.win.close();
  // 用聊天正文核对相对 CMD、绝对 HTML 和交付消息中使用的 EXE 标签。
  const chatHtml = path.join(workspace, launchNames[0]);
  const chatExe = path.join(workspace, launchNames[4]);
  const markdown = '[打开命令](<' + launchNames[3] + '>)\n\n[打开页面](<' + chatHtml + '>)\n\n[新版程序](<' + chatExe + '>)';
  const message = { role: 'assistant', text: markdown, changes: [{ path: launchNames[3] }] };
  await page('(function(){const t=window.__systemOpenTest;t.activeSession().messages.push(' + JSON.stringify(message) + ');t.renderMessages();return true;})()');
  // 记录正文锚点的输入，用于核对每次点击只向系统提交一次打开请求。
  await page('window.__chatFileClicks=[];document.getElementById("messages").addEventListener("click",function recordFileClick(event){const link=event.target.closest("a[data-preview-file]");if(link)window.__chatFileClicks.push({label:link.textContent,trusted:event.isTrusted,button:event.button,detail:event.detail});},true);true');
  const launchCount = report.paths.length;
  const previewPath = await page('document.getElementById("preview-path").textContent');
  const chatUrl = win.webContents.getURL();
  live = true;
  await clickChatFile(launchNames[3]);
  /** 等待对话里的 CMD 实际执行并创建标记。 */
  function cmdStarted() { return fs.existsSync(path.join(workspace, 'cmd-started.txt')); }
  await waitFor(cmdStarted, '对话 CMD 真实启动标记');
  check(report.paths[launchCount] === path.join(workspace, launchNames[3]), '对话里的相对 CMD 实际执行并写入标记');
  await clickChatFile(chatHtml);
  /** 等待默认浏览器访问 HTML 中的本机地址。 */
  function htmlOpened() { return report.requests.includes('/local-html'); }
  await waitFor(htmlOpened, '默认浏览器打开对话里的 HTML');
  check(report.paths.length === launchCount + 2 && report.paths[launchCount + 1] === chatHtml, '对话里的绝对 HTML 仅打开一次，默认浏览器访问本机验证页');
  check(win.webContents.getURL() === chatUrl && await page('document.getElementById("preview-path").textContent') === previewPath, '聊天文件锚点保留当前会话和已有侧栏预览');

  await page('document.querySelector("#messages [data-expand-files]").click();document.querySelector("#messages .file-card [data-preview-file]").click();true');
  /** 等待文件变更卡片刷新为脚本的只读内容。 */
  async function cardPreviewed() { return await page('document.getElementById("preview-body").textContent.includes("cmd-started.txt")'); }
  await waitFor(cardPreviewed, '变更卡片只读预览');
  check(report.paths.length === launchCount + 2, '变更卡片继续只读预览，不启动脚本');

  const exeIndex = report.paths.length;
  if (desktopClick) {
    const selector = '#messages a[data-preview-file="' + encodeURIComponent(chatExe) + '"]';
    await page('(function(){window.__systemOpenTest.showChat();document.querySelector(' + JSON.stringify(selector) + ').scrollIntoView({block:"center"});return true;})()');
    showChatFixture = true;
    win.setTitle('SpCode 对话标签鼠标验收');
    // 单击前将隔离验收窗口放在桌面前方，避免普通窗口覆盖聊天气泡。
    win.setAlwaysOnTop(true);
    win.show();
    console.log('DESKTOP_CLICK_READY ' + win.getTitle());
  } else {
    await clickChatFile(chatExe);
  }
  /** 等待「新版程序」实际运行，进程在自身目录写入本次验收标记。 */
  function exeStarted() { return fs.existsSync(path.join(workspace, 'exe-started.txt')); }
  await waitFor(exeStarted, '新版程序真实启动标记', desktopClick ? DESKTOP_CLICK_WAIT_MS : WAIT_MS);
  report.chatClicks = await page('window.__chatFileClicks');
  if (desktopClick) {
    const exeClick = report.chatClicks.find(function isExeClick(click) { return click.label === '新版程序'; });
    check(exeClick && exeClick.trusted && exeClick.button === 0 && exeClick.detail === 1, '新版程序标签收到真实鼠标左键单击');
    win.hide();
  }
  check(report.paths.length === exeIndex + 1 && report.paths[exeIndex] === chatExe, '新版程序标签仅启动指定 EXE 一次，并写入受控标记');
  check(win.webContents.getURL() === chatUrl, '启动新版程序后聊天仍在原页面');

  await clickTree(launchNames[2], false);
  /** 等待测试 BAT 实际运行并写入本次验收标记。 */
  function batStarted() { return fs.existsSync(path.join(workspace, 'bat-started.txt')); }
  await waitFor(batStarted, 'BAT 真实启动标记');
  check(true, 'BAT 实际由系统启动并写入受控标记');
  const pageUrl = win.webContents.getURL();
  const windows = BrowserWindow.getAllWindows().length;
  await clickWeb(win.webContents, baseUrl + '/external-live?a=1&b=2', '_blank');
  function browserOpened() { return report.requests.includes('/external-live?a=1&b=2'); }
  await waitFor(browserOpened, '默认浏览器打开网页');
  check(win.webContents.getURL() === pageUrl && BrowserWindow.getAllWindows().length === windows, '网页实际进入默认浏览器，聊天页面和窗口数量保持不变');
  check(report.errors.length === 0, '生产界面无脚本错误');
  await finish();
}
/** 保存实际证据，仅退出本次隔离生产进程，服务器关闭前停止接受新请求。 */
async function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(watchdog);
  if (error) { report.failure = String(error.stack || error); console.error(report.failure); }
  if (server) server.close();
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('REPORT ' + path.join(output, 'report.json'));
  app.exit(error ? 1 : 0);
}
const watchdog = setTimeout(expired, 120000);
/** 本次验收到达总时限后真实失败，不把部分通过当作全部成功。 */
function expired() { void finish(new Error('系统打开验收超时')); }
/** 顶层失败写入同一报告并使进程非零退出。 */
function failed(error) { void finish(error); }
main().catch(failed);
