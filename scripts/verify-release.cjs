/**
 * 验证打包产物与当前源码一致，并启动真实 EXE 检查版本、IPC 与桌宠页面。
 * 用法：node scripts/verify-release.cjs；用户数据和结果仅写 generated 的独立测试目录。
 * 调试端口由系统分配且仅监听本机；测试结束仅关闭本脚本创建的进程。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const output = fs.mkdtempSync(path.join(root, 'generated', 'release-' + version + '-'));
const userData = path.join(output, 'user-data');
const archive = path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar');
const exe = path.join(root, 'dist', 'win-unpacked', 'SimpleCode.exe');
const checks = [];
let child, socket, timer;
let nextId = 0;
const pending = new Map();

/** 断言与记录同步，失败不会生成通过结论。 */
function check(value, name) {
  assert.ok(value, name);
  checks.push(name);
  console.log('PASS ' + name);
}

/** 核对所有纳入本次应用发布的源码，而非只抽样检查版本字符串。 */
function verifyArchive() {
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'electron', 'renderer'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const files = git.stdout.trim().split(/\r?\n/);
  for (const file of files) {
    assert.ok(fs.readFileSync(path.join(root, file)).equals(asar.extractFile(archive, file.split('/').join(path.sep))), '包内源码一致：' + file);
  }
  check(true, files.length + ' 个应用源码及资源文件与 ASAR 逐字节一致');
  // electron-builder 会去掉开发配置并重排 package.json，按运行所需字段核对元数据。
  const packed = JSON.parse(asar.extractFile(archive, 'package.json'));
  const source = require('../package.json');
  for (const key of ['name', 'productName', 'version', 'main', 'dependencies']) assert.deepEqual(packed[key], source[key], '运行元数据一致：' + key);
  check(packed.version === version, 'ASAR 版本及运行依赖元数据正确：' + version);
  return files.length;
}

/** 等待测试进程给出系统分配的调试地址，保留启动错误供诊断。 */
function startExe() {
  return new Promise(function waitForInspector(resolve, reject) {
    let stderr = '';
    child = spawn(exe, ['--inspect=127.0.0.1:0', '--user-data-dir=' + userData], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
    child.once('error', reject);
    child.stderr.on('data', function readAddress(data) {
      stderr += data.toString();
      const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
      if (match) resolve(match[0]);
    });
    child.once('exit', function exited(code) { reject(new Error('EXE 提前退出：' + code + '\n' + stderr)); });
  });
}

/** 按请求编号接回真实主进程结果，协议错误和表达式错误均使测试失败。 */
function receive(message) {
  const data = JSON.parse(message.data);
  if (!pending.has(data.id)) return;
  const request = pending.get(data.id);
  pending.delete(data.id);
  if (data.error) request.reject(new Error(JSON.stringify(data.error)));
  else if (data.result.exceptionDetails) request.reject(new Error(JSON.stringify(data.result.exceptionDetails)));
  else request.resolve(data.result.result.value);
}

/** 使用本机 Inspector 执行只针对隔离实例的核对表达式。 */
function evaluate(expression) {
  return new Promise(function sendRequest(resolve, reject) {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}

/** 给异步页面加载让出事件循环，不操纵用户前台焦点。 */
function wait(ms) { return new Promise(function delayed(resolve) { setTimeout(resolve, ms); }); }

/** 核对真实安装目录 EXE 的主进程、preload、账户 IPC 和新增桌宠控件。 */
async function main() {
  const files = verifyArchive();
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboardingCompleted: true, modelsDir: path.join(output, 'models') }), 'utf8');
  timer = setTimeout(function timedOut() { console.error('FAIL EXE 核对超时'); if (socket) socket.close(); if (child) child.kill(); process.exit(1); }, 40000);
  const address = await startExe();
  socket = new WebSocket(address);
  socket.addEventListener('message', receive);
  await new Promise(function opened(resolve, reject) { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  // Inspector 地址先于 Node/Electron 引导完成，先让主进程完成自身模块初始化。
  await wait(2000);
  const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await evaluate('(function(){const e=' + electron + ';return e.app.isReady()&&e.BrowserWindow.getAllWindows().some(function(w){return w.webContents.getURL().includes("/index.html")&&!w.webContents.isLoading();});})()');
    if (ready) break;
    await wait(100);
  }
  check(ready, '真实 EXE 主界面完成加载');
  const state = await evaluate('(function(){const e=' + electron + ';return {version:e.app.getVersion(),packaged:e.app.isPackaged,userData:e.app.getPath("userData")};})()');
  check(state.version === version && state.packaged, '实际主进程版本正确且处于打包模式');
  check(path.resolve(state.userData) === path.resolve(userData), '实际主进程使用独立测试数据目录');
  const pageCode = '(async function(){const s=await window.simple.getState();return {build:window.__APP_BUILD,save:typeof window.simple.saveLocalImageGeneration,quota:typeof window.simple.reportAccountQuota,options:s.localImageGeneration,body:document.body.innerText.length};})()';
  const page = await evaluate('(async function(){const e=' + electron + ';const w=e.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().includes("/index.html");});return w.webContents.executeJavaScript(' + JSON.stringify(pageCode) + ');})()');
  check(page.save === 'function' && page.quota === 'function' && page.body > 0 && page.options !== undefined, '实际主界面及新增 preload IPC 可用');
  const petCode = '(function(){const x=document.getElementById("pet-glasses-offset-x"),y=document.getElementById("pet-glasses-offset-y");return {inspect:typeof window.desktopPetInspect,x:!!x,y:!!y,balance:!!document.getElementById("pet-balance"),lines:getComputedStyle(document.getElementById("pet-label")).webkitLineClamp};})()';
  const pet = await evaluate('(async function(){const e=' + electron + ';const w=e.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().includes("/float-bar.html");});return w.webContents.executeJavaScript(' + JSON.stringify(petCode) + ');})()');
  check(pet.inspect === 'function' && pet.x && pet.y && pet.balance && pet.lines === '3', '实际 EXE 桌宠具有 X/Y 控件、余额及三行正文布局');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ version, files, checks, state, page, pet }, null, 2), 'utf8');
  console.log('RESULT ' + JSON.stringify({ output, checks: checks.length, files }));
  await evaluate('(function(){' + electron + '.app.quit();return true;})()');
  socket.close();
  clearTimeout(timer);
  await wait(500);
  if (child.exitCode === null) child.kill();
}

/** 出错只结束本脚本的隔离测试进程，保留诊断目录。 */
function failed(error) {
  console.error(error.stack || error);
  if (socket) socket.close();
  if (child) child.kill();
  clearTimeout(timer);
  process.exitCode = 1;
}
main().catch(failed);
