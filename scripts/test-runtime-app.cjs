/**
 * 启动完整源码应用的隔离实例，从真实页面调用长时存活 IPC，核对新观察工具注册。
 * 不重启当前对话实例，不使用用户配置，不发送模型请求。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'runtime-app-'));
const userData = path.join(output, 'user-data');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboardingCompleted: true, modelsDir: path.join(output, 'models') }));
let child, socket;
let sequence = 0;
let checks = 0;
const pending = new Map();
/** 必须满足断言才能报告通过。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 在当前测试实例执行只读诊断或测试会话，不接入用户主进程。 */
function evaluate(expression) {
  return new Promise(function send(resolve, reject) {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
/** 接收 Inspector 结果，异常按失败处理。 */
function receive(message) {
  const data = JSON.parse(message.data);
  if (!pending.has(data.id)) return;
  const request = pending.get(data.id);
  pending.delete(data.id);
  if (data.error || data.result.exceptionDetails) request.reject(new Error(JSON.stringify(data)));
  else request.resolve(data.result.result.value);
}
/** 等待主窗初始化，不操作用户前台。 */
function pause(ms) { return new Promise(function delay(resolve) { setTimeout(resolve, ms); }); }
/** 完整启动后从 renderer 经 preload 进入生产 IPC。 */
async function main() {
  const address = await new Promise(function start(resolve, reject) {
    let stderr = '';
    // 可传实际 EXE 验收新包；源码与打包程序均使用同一隔离数据目录。
    const executable = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
    const args = process.argv[2] ? [] : [root];
    args.push('--inspect=127.0.0.1:0', '--user-data-dir=' + userData);
    child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('error', reject);
    child.stderr.on('data', function inspect(data) {
      stderr += data.toString();
      const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
      if (match) resolve(match[0]);
    });
    child.on('exit', function exited(code) { reject(new Error('应用提前退出：' + code + stderr)); });
  });
  socket = new WebSocket(address);
  socket.addEventListener('message', receive);
  await new Promise(function open(resolve, reject) {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
  const find = 'e.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().includes("/index.html")&&!w.webContents.isLoading();})';
  await pause(1500);
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await evaluate('(function(){const e=' + electron + ';return e.app.isReady()&&!!(' + find + ');})()');
    if (ready) break;
    await pause(100);
  }
  check(ready, '完整应用主界面加载完成');
  const details = await evaluate('(function(){const e=' + electron + ';return {version:e.app.getVersion(),data:e.app.getPath("userData")};})()');
  check(path.resolve(details.data) === userData, '新实例使用独立用户数据');
  const startup = await evaluate('(function(){const e=' + electron + ';return e.BrowserWindow.getAllWindows().map(function(w){return {url:w.webContents.getURL(),visible:w.isVisible()};});})()');
  check(startup.length === 2 && !startup.some(function dialogue(w) { return w.url.includes("dialogue=1"); }) && startup.some(function pet(w) { return w.url.includes("float-bar.html") && !w.visible; }), '完整应用启动只显示主窗，独立对话窗未创建');
  const pageCode = '(async function(){const a=window.simple;const tabId="runtime-app-check";await a.longAliveBind({tabId,workspace:' + JSON.stringify(root) + '});const started=await a.longAliveStart({tabId,goal:"只验证接口，不执行外部任务",intervalSeconds:86400,timeoutSeconds:60});const stopped=await a.longAliveStop();const status=await a.longAliveStatus();return {started:started.enabled,stopped:!stopped.enabled,active:status.task.active,memory:status.memory.rss>0};})()';
  const longAlive = await evaluate('(async function(){const e=' + electron + ';const w=' + find + ';return w.webContents.executeJavaScript(' + JSON.stringify(pageCode) + ');})()');
  check(longAlive.started && longAlive.stopped && !longAlive.active && longAlive.memory, '真实 preload 与主进程的长时存活绑定、开启、停止和状态接口可用');
  const registered = await evaluate('(function(){const e=' + electron + ';const r=process.getBuiltinModule("module").createRequire(e.app.getAppPath()+"/package.json");const d=r("./electron/lib/desktop-hand");d.setAlive(true);const on=r("./electron/lib/agent").toolsSpec().some(function(s){return s.function.name==="runtime_state";});d.setAlive(false);const off=r("./electron/lib/agent").toolsSpec().some(function(s){return s.function.name==="runtime_state";});return {on,off};})()');
  check(registered.on && !registered.off, '完整应用的运行时工具随 AGI 开关注册');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, details, longAlive, registered }, null, 2));
  console.log(JSON.stringify({ checks, output: path.relative(root, output) }));
  // 本测试只关闭自己创建的实例。
  socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate', params: { expression: electron + '.app.exit(0)' } }));
  socket.close();
}
const timer = setTimeout(timeout, 40000);
/** 超时保留结果目录并关闭测试实例。 */
function timeout() { if (child) child.kill(); console.error('完整应用验收超时'); process.exit(1); }
main().then(done, failed);
/** 正常完成不留下计时器。 */
function done() { clearTimeout(timer); }
/** 错误保留真实信息，不报告成功。 */
function failed(error) { console.error(error.stack || error); if (socket) socket.close(); if (child) child.kill(); clearTimeout(timer); process.exitCode = 1; }
