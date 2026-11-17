/**
 * 在完整源码应用中经真实 preload/IPC 核对内部开关、全文、用户回答及终态。
 * 模型响应使用确定性夹具；只操作自己创建的用户目录和实例。
 */
'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'training-app-'));
const userData = path.join(output, 'user-data');
const dataRoot = path.join(output, 'records');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({
  onboardingCompleted: true, modelsDir: path.join(output, 'models'), trainingDataDir: dataRoot
}));
let child, socket, sequence = 0, checks = 0;
const pending = new Map();
const modulePath = JSON.stringify(path.join(root, 'electron/lib/agent.js'));
const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
const find = 'e.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().includes("/index.html")&&!w.webContents.isLoading();})';
/** 实际行为满足条件才报告通过。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** Inspector 仅连接本脚本创建的实例。 */
function evaluate(expression) {
  return new Promise(function send(resolve, reject) {
    const id = ++sequence; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
/** 收到异常不当成功值使用。 */
function receive(message) {
  const data = JSON.parse(message.data);
  if (!pending.has(data.id)) return;
  const request = pending.get(data.id); pending.delete(data.id);
  if (data.error || data.result.exceptionDetails) request.reject(new Error(JSON.stringify(data)));
  else request.resolve(data.result.result.value);
}
/** 经真实 renderer/preload 调用生产处理器。 */
function page(code) {
  return evaluate('(async function(){const e=' + electron + ';const w=' + find + ';return w.webContents.executeJavaScript(' + JSON.stringify(code) + ');})()');
}
/** 获取本轮所有真实落盘事件，不读取用户自己的训练目录。 */
function allRecords() {
  const out = [];
  if (!fs.existsSync(dataRoot)) return out;
  for (const file of fs.readdirSync(dataRoot, { recursive: true })) {
    if (!file.endsWith('events.jsonl')) continue;
    out.push({ file, rows: fs.readFileSync(path.join(dataRoot, file), 'utf8').trim().split('\n').map(JSON.parse) });
  }
  return out;
}
/** 修改隔离实例中的内部设置，不触及用户原始配置。 */
function enabled(value) {
  return evaluate('(function(){const r=process.getBuiltinModule("module").createRequire(' + modulePath + ');const s=r("./store");s.save({...s.load(),trainingDataEnabled:' + value + '});return s.load().trainingDataEnabled;})()');
}
/** 在主进程装入测试响应，保留真实事件、等待用户回答及停止处理器。 */
function fixture() {
  return evaluate('(function(){const r=process.getBuiltinModule("module").createRequire(' + modulePath + ');const a=r("./agent"),t=r("./training-recorder");a.runTurn=async function(o){o.onEvent({type:"reason",text:"接口公开推理摘要"});if(o.userText==="error"){o.onEvent({type:"error",text:"真实测试失败"});throw new Error("真实测试失败");}if(o.userText==="stopped"){o.onEvent({type:"status",text:"等待停止"});await new Promise(function(resolve,reject){o.signal.addEventListener("abort",function(){reject(Object.assign(new Error("用户停止"),{name:"AbortError"}));},{once:true});});}if(o.userText==="ask"){o.onEvent({type:"ask",question:"确认测试操作？",options:["允许"]});const answer=await o.waitForUserAnswer({question:"确认测试操作？"},o.signal);o.onEvent({type:"text",text:answer});}t.note("fixture-evidence",{text:"完整工具证据"});const result={text:"完整最终回答中文",changes:[{path:"fixture.txt",action:"write"}]};o.onEvent({type:"done",...result});return result;};return true;})()');
}
/** 整个应用启动后核对开关、正常完成、确认、错误与取消。 */
async function main() {
  const address = await new Promise(function start(resolve, reject) {
    let stderr = '';
    child = spawn(require('electron'), [root, '--inspect=127.0.0.1:0', '--user-data-dir=' + userData], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('error', reject);
    child.stderr.on('data', function inspect(chunk) {
      stderr += chunk.toString();
      const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
      if (match) resolve(match[0]);
    });
    child.on('exit', function exited(code) { reject(new Error('应用提前退出：' + code + stderr)); });
  });
  socket = new WebSocket(address); socket.addEventListener('message', receive);
  await new Promise(function open(resolve, reject) {
    socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true });
  });
  // Inspector 在 Electron 引导完成前已监听；先等主上下文建立，避免读取临时 Node 引导上下文。
  await new Promise(function boot(resolve) { setTimeout(resolve, 1500); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    ready = await evaluate('(function(){const e=' + electron + ';return !!e.app&&e.app.isReady()&&!!(' + find + ');})()');
    if (ready) break;
    await new Promise(function pause(resolve) { setTimeout(resolve, 100); });
  }
  check(ready, '完整应用与真实preload加载');
  await fixture();
  const defaults = await evaluate('(function(){const r=process.getBuiltinModule("module").createRequire(' + modulePath + ');return {enabled:r("./store").load().trainingDataEnabled,defaultDir:r("./store").DEFAULTS.trainingDataDir};})()');
  check(defaults.enabled === false && defaults.defaultDir === 'D:\\Shuju', '源码版默认关闭，固定目录默认值正确');
  await page('window.simple.chatSend({tabId:"training-fixture",turnId:"disabled",text:"disabled",workspace:' + JSON.stringify(root) + '})');
  check(allRecords().length === 0, '默认关闭时正常对话不创建训练目录');
  await enabled(true);
  await page('window.simple.chatSend({tabId:"training-fixture",turnId:"normal",text:"normal",workspace:' + JSON.stringify(root) + '})');
  let records = allRecords();
  check(records.length === 1 && records[0].rows.at(-1).kind === 'turn-end', '开启后完整对话经IPC落盘再返回');
  check(records[0].rows.some(function reason(r) { return r.kind === 'event' && r.data.type === 'reason'; }) &&
    records[0].rows.some(function result(r) { return r.kind === 'turn-result' && r.data.text === '完整最终回答中文'; }), '公开推理摘要、文件变更与最终回答保存');
  await page('(async function(){const a=window.simple;const sending=a.chatSend({tabId:"training-fixture",turnId:"ask",text:"ask",workspace:' + JSON.stringify(root) + '});await new Promise(function(r){setTimeout(r,50);});await a.chatAnswer("允许","ask");return sending;})()');
  records = allRecords();
  check(records.some(function answered(f) { return f.rows.some(function answer(r) { return r.kind === 'user-answer' && r.data.answer === '允许'; }); }), '真实提问回答接口保存用户确认原文');
  await page('(async function(){try{await window.simple.chatSend({tabId:"training-fixture",turnId:"error",text:"error",workspace:' + JSON.stringify(root) + '});}catch(e){return e.message;}})()');
  await page('(async function(){const a=window.simple;const sending=a.chatSend({tabId:"training-fixture",turnId:"stopped",text:"stopped",workspace:' + JSON.stringify(root) + '});sending.catch(function(){});await new Promise(function(r){setTimeout(r,50);});await a.chatAbort("stopped");try{await sending;}catch(e){return e.message;}})()');
  records = allRecords();
  const outcomes = {};
  for (const record of records) outcomes[record.rows[0].turnId] = record.rows.at(-1).data.outcome;
  check(outcomes.normal === 'success' && outcomes.ask === 'success' && outcomes.error === 'error' && outcomes.stopped === 'stopped', '成功、报错、停止终态与实际行为一致');
  await enabled(false);
  await page('window.simple.chatSend({tabId:"training-fixture",turnId:"disabled-again",text:"disabled-again",workspace:' + JSON.stringify(root) + '})');
  check(allRecords().length === records.length, '关闭内部开关后新轮次立即停止采集，旧记录保留');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, defaults, outcomes, files: records.map(function file(r) { return r.file; }) }, null, 2));
  console.log(JSON.stringify({ checks, output }));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate', params: { expression: electron + '.app.exit(0)' } }));
  socket.close();
}
const timer = setTimeout(timeout, 45000);
/** 超时只停止本脚本的测试实例。 */
function timeout() { if (child) child.kill(); console.error('训练整应用测试超时'); process.exit(1); }
main().then(done, failed);
function done() { clearTimeout(timer); }
function failed(error) { console.error(error.stack || error); if (socket) socket.close(); if (child) child.kill(); clearTimeout(timer); process.exitCode = 1; }
