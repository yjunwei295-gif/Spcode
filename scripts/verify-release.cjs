/**
 * 验证打包产物与当前源码一致，并启动真实 EXE 检查版本、IPC 与桌宠页面。
 * 用法：node scripts/verify-release.cjs [发布目录]；省略目录时检查 dist/win-unpacked。
 * 用户数据和结果仅写 generated 的独立测试目录，指定目录用于核对隔离构建，不覆盖已有发布产物。
 * 调试端口由系统分配且仅监听本机；测试结束仅关闭本脚本创建的进程。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const version = require('../package.json').version;
const output = fs.mkdtempSync(path.join(root, 'generated', 'release-' + version + '-'));
const userData = path.join(output, 'user-data');
// 发布版使用可监听的真实程序目录；源码核对和 EXE 启动必须指向同一份构建。
const releaseRoot = process.argv[2] ? path.resolve(root, process.argv[2]) : path.join(root, 'dist', 'win-unpacked');
const applicationRoot = path.join(releaseRoot, 'resources', 'app');
const exe = path.join(releaseRoot, 'SimpleCode.exe');
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

/**
 * 核对真实发布目录的完整源码和运行元数据。
 * 按当前构建配置排除明确不发布的文件；目录布局与文件字节不符时直接失败，不读取旧 ASAR 冒充新发布包。
 * @returns {number} 已完成逐字节核对的程序文件数量。
 */
function verifyApplicationFiles() {
  const source = require('../package.json');
  check(source.build.asar === false && fs.statSync(applicationRoot).isDirectory()
    && !fs.existsSync(path.join(path.dirname(applicationRoot), 'app.asar')), '发布版使用真实程序目录且不存在优先加载的旧 ASAR');
  const excluded = new Set();
  for (const pattern of source.build.files) {
    if (pattern.startsWith('!')) excluded.add(pattern.slice(1));
  }
  const git = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '--', 'electron', 'renderer'], { cwd: root, encoding: 'utf8' });
  assert.equal(git.status, 0, git.stderr);
  const files = git.stdout.trim().split(/\r?\n/).filter(included);
  for (const file of files) {
    assert.ok(fs.readFileSync(path.join(root, file)).equals(fs.readFileSync(path.join(applicationRoot, file))), '包内源码一致：' + file);
  }
  check(true, files.length + ' 个应用源码及资源文件与发布目录逐字节一致');
  // electron-builder 会去掉开发配置并重排 package.json，按运行所需字段核对元数据。
  const packed = JSON.parse(fs.readFileSync(path.join(applicationRoot, 'package.json'), 'utf8'));
  for (const key of ['name', 'productName', 'version', 'main', 'dependencies']) assert.deepEqual(packed[key], source[key], '运行元数据一致：' + key);
  check(packed.version === version, '发布目录版本及运行依赖元数据正确：' + version);
  return files.length;

  /** 只排除当前构建配置明确点名的文件，保持其余程序源码完整核对。 */
  function included(file) { return !excluded.has(file); }
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

/** 在桌宠渲染进程测量气泡的可见行数和距最新文本的滚动距离，单位为 CSS 像素。 */
function readPetLayout() {
  const label = document.getElementById('pet-label');
  const style = getComputedStyle(label);
  const contentHeight = label.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  return {
    inspect: typeof window.desktopPetInspect,
    x: !!document.getElementById('pet-glasses-offset-x'), y: !!document.getElementById('pet-glasses-offset-y'),
    balance: !!document.getElementById('pet-balance'), text: label.textContent,
    contentHeight, lineHeight: parseFloat(style.lineHeight), overflow: style.overflowY,
    scrollTop: label.scrollTop, bottomGap: label.scrollHeight - label.clientHeight - label.scrollTop
  };
}

/**
 * 向隔离 EXE 的桌宠发送正常的轮次与回复事件，等待真实气泡呈现长文本。
 * @param {string} electron 现有测试连接里取得 Electron 模块的表达式。
 * @returns {Promise<object>} 包含呈现后的几何和滚动位置。总超时沿用发布验证的看门狗。
 */
async function samplePet(electron) {
  const windowExpr = electron + '.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().endsWith("/float-bar.html");})';
  const inspect = 'window.desktopPetInspect?.()';
  // 通过主界面的正式 IPC 绑定测试会话；空会话会重新请求历史，把尚未登记的消息清掉。
  const bind = 'window.simple.floatBind("release-bubble","发布验证",true)';
  await evaluate(electron + '.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().includes("/index.html");}).webContents.executeJavaScript(' + JSON.stringify(bind) + ')');
  // 角色窗默认隐藏；先显示隔离实例，确保皮肤解码与首帧有机会完成。
  const startedAt = Date.now();
  let state;
  do {
    await wait(100);
    state = await evaluate('(async function(){const w=' + windowExpr + ';if(!w)return null;if(!w.isVisible())w.showInactive();return w.webContents.executeJavaScript(' + JSON.stringify(inspect) + ');})()');
    assert.ok(!state?.errors, '桌宠初始化出错：' + state?.errors);
    assert.ok(Date.now() - startedAt < 15000, '等待角色窗初始化超时：' + JSON.stringify(state));
  } while (!state?.skin || !state.key?.endsWith(':release-bubble'));
  const text = ['第一行', '第二行', '第三行', '第四行', '第五行', '最新一行'].join('\n');
  const turn = { sessionKey: state.key, turnId: 'release-bubble' };
  const started = { ...turn, kind: 'turn-start' };
  const reply = { ...turn, kind: 'ai', text };
  await evaluate('(function(){const w=' + windowExpr + ';w.webContents.send("floatbar:event",' + JSON.stringify(started) + ');w.webContents.send("floatbar:event",' + JSON.stringify(reply) + ');return true;})()');
  const measure = '(' + readPetLayout.toString() + ')()';
  let layout;
  do {
    await wait(100);
    layout = await evaluate(windowExpr + '.webContents.executeJavaScript(' + JSON.stringify(measure) + ')');
    assert.ok(Date.now() - startedAt < 30000, '桌宠未收到测试回复：' + JSON.stringify(layout));
  } while (layout.text !== text);
  return layout;
}

/** 核对真实安装目录 EXE 的主进程、preload、账户 IPC 和新增桌宠控件。 */
async function main() {
  const files = verifyApplicationFiles();
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
  const pet = await samplePet(electron);
  const lines = require(path.join(applicationRoot, 'electron/lib/desktop-pet-config.json')).layout.dialogueLines;
  check(pet.inspect === 'function' && pet.x && pet.y && pet.balance, '实际 EXE 包含桌宠检查接口、眼镜 X/Y 控件和余额');
  // clientHeight 和 scrollHeight 取整，允许一个 CSS 像素的布局舍入差。
  check(Math.abs(pet.contentHeight - lines * pet.lineHeight) <= 1 && pet.overflow === 'hidden' && pet.scrollTop > 0 && Math.abs(pet.bottomGap) <= 1,
    '实际 EXE 桌宠保留长回复并显示最新 ' + lines + ' 行：' + JSON.stringify(pet));
  // 通过真实打包 preload 和主进程 IPC 开启再停止测试任务；长间隔确保不调用任何模型。
  const longAliveCode = '(async function(){const api=window.simple;const tabId="release-verification";await api.longAliveBind({tabId,workspace:' + JSON.stringify(root) + '});const started=await api.longAliveStart({tabId,goal:"仅核对发布 IPC，不执行外部任务",intervalSeconds:86400,timeoutSeconds:60});const stopped=await api.longAliveStop();const status=await api.longAliveStatus();return {button:!!document.getElementById("btn-long-alive"),started:started.enabled,stopped:!stopped.enabled,active:status.task.active,memory:status.memory.rss>0};})()';
  const longAlive = await evaluate('(async function(){const e=' + electron + ';const w=e.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().includes("/index.html");});return w.webContents.executeJavaScript(' + JSON.stringify(longAliveCode) + ');})()');
  check(longAlive.button && longAlive.started && longAlive.stopped && !longAlive.active && longAlive.memory, '实际 EXE 长时入口、启停和内存状态 IPC 可用，未调用模型');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ version, files, checks, state, page, pet, longAlive }, null, 2), 'utf8');
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
