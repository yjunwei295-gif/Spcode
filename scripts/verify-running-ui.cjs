/**
 * 启动当前源码的真实主窗口并通过本机调试协议验收 DOM/IPC。
 * 成功后关闭调试端口并保留新窗口供用户使用；失败时保留进程并报告原因，不终止原窗口。
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.join(__dirname, '..');
const reportPath = path.join(root, 'generated', 'running-ui-verification.json');
let child;

/** 有界等待界面异步初始化，不向页面发送聊天消息。 */
function delay(ms) { return new Promise(wait); function wait(resolve) { setTimeout(resolve, ms); } }

/** 连接仅本机开放的临时调试端口，提供请求/响应配对。 */
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise(open);
  function open(resolve, reject) { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); }
  let seq = 0;
  const pending = new Map();
  function message(event) {
    const data = JSON.parse(event.data);
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    clearTimeout(item.timer);
    if (data.error) item.reject(new Error(data.error.message));
    else item.resolve(data.result);
  }
  socket.addEventListener('message', message);
  function request(method, params) {
    return new Promise(send);
    function send(resolve, reject) {
      const id = ++seq;
      const timer = setTimeout(timeout, 45000);
      function timeout() { pending.delete(id); reject(new Error('调试请求超时：' + method)); }
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    }
  }
  return { socket, request };
}

/** 验收主窗口已加载修复代码、Kimi 实时余额及发送前预览。 */
async function main() {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const executable = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
  const existingPort = Number(process.argv[2]);
  const stderrPath = path.join(root, 'generated', 'running-ui-stderr.log');
  const stderrFd = existingPort ? null : fs.openSync(stderrPath, 'w');
  child = existingPort ? { pid: Number(process.argv[3]), unref() {} } : spawn(executable, ['--inspect=0', '.'], { cwd: root, detached: true, stdio: ['ignore', 'ignore', stderrFd], windowsHide: false });
  if (stderrFd !== null) fs.closeSync(stderrFd);
  let stderr = '';
  let inspectorUrl = '';
  if (existingPort) {
    const targets = await fetch('http://127.0.0.1:' + existingPort + '/json/list').then(readTargets);
    function readTargets(response) { return response.json(); }
    inspectorUrl = targets[0].webSocketDebuggerUrl;
  }
  function collect(chunk) {
    stderr += chunk.toString();
    const hit = /Debugger listening on (ws:\/\/127\.0\.0\.1:[^\s]+)/.exec(stderr);
    if (hit) inspectorUrl = hit[1];
  }
  // 调试输出写独立日志，避免验收脚本退出后管道断开使新程序一起退出。
  for (let i = 0; i < 100 && !inspectorUrl; i++) {
    if (!existingPort) collect(fs.readFileSync(stderrPath));
    if (!inspectorUrl) await delay(100);
  }
  assert.ok(inspectorUrl, '未取得新主进程调试地址');
  // 等主模块完成启动；编译期间的临时调试上下文会在模块加载后被回收。
  await delay(1500);
  const cdp = await connect(inspectorUrl);
  async function evaluate(expression) {
    const result = await cdp.request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }
  // 只挑主页面，悬浮栏使用另一份 HTML，不能当成主窗口验收。
  const requireExpr = "process.getBuiltinModule('module').createRequire(process.cwd()+'/package.json')";
  const windowExpr = requireExpr + "('electron').BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().endsWith('/renderer/index.html');})";
  let ready = false;
  for (let i = 0; i < 150; i++) {
    const status = await evaluate("(async function(){const w=" + windowExpr + ";if(!w||w.webContents.isLoading())return false;return w.webContents.executeJavaScript(\"window.__APP_BUILD==='v20261023a' && !!window.simple\");})()");
    if (status) { ready = true; break; }
    await delay(200);
  }
  if (!ready) {
    const detail = await evaluate('({windows:' + requireExpr + "('electron').BrowserWindow.getAllWindows().map(function(w){return {url:w.webContents.getURL(),loading:w.webContents.isLoading()};}),data:" + requireExpr + "('electron').app.getPath('userData'),argv:process.argv})");
    throw new Error('新主窗口未完成初始化：' + JSON.stringify(detail) + ' stderr=' + stderr.slice(-1500));
  }
  const rendererCode = [
    '(async function(){',
    'const api=window.simple;',
    'const settings=await api.getState();',
    "const p=settings.providers.find(function(p){return /^https:\\/\\/api\\.moonshot\\.(cn|ai)(?:\\/|$)/i.test(p.baseUrl||'');});",
    "if(!p)throw new Error('未找到 Kimi 厂商');",
    'const balance=await api.fetchAccountBalance(p.id);',
    "if(!balance.available||!Number.isFinite(balance.remaining))throw new Error('Kimi 余额不可用');",
    'const preview=await api.promptPreview({workspace:' + JSON.stringify(root) + ',modelId:settings.currentModelId,skillIds:[],history:[],contextSummary:"SUMMARY_UI_SHOULD_NOT_LEAK"});',
    "const summaryRemoved=!preview.system.includes('SUMMARY_UI_SHOULD_NOT_LEAK')&&!preview.system.includes('## 更早对话摘要');",
    "return {balance:balance.remaining,currency:balance.currency,quotaText:document.getElementById('quota-text').textContent,summaryRemoved,build:window.__APP_BUILD,modelId:settings.currentModelId};",
    '})()'
  ].join('\n');
  const result = await evaluate(windowExpr + '.webContents.executeJavaScript(' + JSON.stringify(rendererCode) + ')');
  assert.equal(result.summaryRemoved, true);
  assert.equal(result.build, 'v20261023a');
  // 顶栏由启动后的异步查询更新，必须等到显示数值，不能把“无可读取余额”的厂商名当通过。
  for (let i = 0; i < 40; i++) {
    result.quotaText = await evaluate(windowExpr + '.webContents.executeJavaScript("document.getElementById(\\\"quota-text\\\").textContent")');
    if (/Kimi:\s*¥-?\d/.test(result.quotaText)) break;
    await delay(250);
  }
  assert.match(result.quotaText, /Kimi:\s*¥-?\d/);
  await evaluate(windowExpr + '.webContents.executeJavaScript("document.getElementById(\\\"onboarding-skip\\\")?.click();true")');
  const report = { ok: true, pid: child.pid, checkedAt: new Date().toISOString(), ...result };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  // 验收完成后关闭 inspector，不留下供后续使用的调试接口。
  await evaluate("setTimeout(function(){process.getBuiltinModule('inspector').close();},200);true");
  cdp.socket.close();
  if (child.stderr) {
    child.stderr.removeListener('data', collect);
    child.stderr.destroy();
  }
  child.unref();
  console.log(JSON.stringify(report));
}

/** 错误按失败报告落盘，保留原进程与新进程，避免自动关闭用户窗口。 */
function failed(error) {
  const report = { ok: false, pid: child?.pid, error: error.stack || String(error) };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.error(JSON.stringify(report));
  if (child) { child.stderr?.destroy(); child.unref(); }
  process.exit(1);
}
main().catch(failed);
