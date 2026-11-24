/**
 * 启动隔离的真实应用验证主题菜单、设置、持久化和样式。
 * 不连接模型，不使用用户配置；截图与报告保留在 generated 供核对。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'theme-cel-'));
const userData = path.join(output, 'user-data');
fs.mkdirSync(userData);
fs.writeFileSync(path.join(userData, 'settings.json'), JSON.stringify({ onboardingCompleted: true, theme: 'light', modelsDir: path.join(output, 'models') }));
let child, socket;
let sequence = 0;
const pending = new Map();
const passed = [];
/** 断言实际行为并记录报告。 */
function check(value, label) { assert.ok(value, label); passed.push(label); console.log('PASS ' + label); }
/** 通过本次隔离进程的 Inspector 执行检查。 */
function evaluate(expression) {
  return new Promise(function send(resolve, reject) {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
/** Inspector 异常直接使验证失败。 */
function receive(message) {
  const data = JSON.parse(message.data);
  if (!pending.has(data.id)) return;
  const request = pending.get(data.id);
  pending.delete(data.id);
  if (data.error || data.result.exceptionDetails) request.reject(new Error(JSON.stringify(data)));
  else request.resolve(data.result.result.value);
}
const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
const find = 'e.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().includes("/index.html")&&!w.webContents.isLoading();})';
/** 在真实主界面中运行 DOM 交互，沿用生产 preload 与 IPC。 */
function page(code) { return evaluate('(async function(){const e=' + electron + ';const w=' + find + ';return w.webContents.executeJavaScript(' + JSON.stringify(code) + ');})()'); }
/** 有限等待页面条件；不把加载超时当成通过。 */
async function waitPage(condition) {
  for (let i = 0; i < 100; i++) {
    if (await page(condition)) return;
    await new Promise(function pause(resolve) { setTimeout(resolve, 100); });
  }
  throw new Error('页面条件未满足: ' + condition);
}
/** 从菜单真实点击并核对主进程保存值及当前显示值。 */
async function choose(theme) {
  const selector = '[data-act="theme-' + theme + '"]';
  await page('document.querySelector(' + JSON.stringify(selector) + ').click()');
}
/**
 * 保存隔离窗口的实际 Chromium 画面。
 * @param {string} name 验收目录内的 PNG 文件名。
 * @returns {Promise<void>} 成功时写出 PNG 并记一条断言；截图为空时验收失败。
 */
async function captureReference(name) {
  // DOM 切换完成后需等新画面渲染，避免把前一张有效截图误认为当前界面。
  await page(`(async function waitReferencePaint() {
    await document.fonts.ready;
    await new Promise(function waitFrame(resolve) {
      requestAnimationFrame(function afterLayout() { requestAnimationFrame(resolve); });
    });
    return true;
  })()`);
  const file = JSON.stringify(path.join(output, name));
  const captured = await evaluate(`(async function captureThemeFrame() {
    const e = ${electron};
    const w = ${find};
    const image = await w.webContents.capturePage(undefined, { stayAwake: true });
    if (image.isEmpty()) return false;
    process.getBuiltinModule('fs').writeFileSync(${file}, image.toPNG());
    return true;
  })()`);
  check(captured, name + ' 截图非空');
}
/** 完整验证新主题与原有主题可以往返切换。 */
async function main() {
  const address = await new Promise(function start(resolve, reject) {
    let stderr = '';
    child = spawn(require('electron'), [root, '--inspect=127.0.0.1:0', '--user-data-dir=' + userData], { stdio: ['ignore', 'ignore', 'pipe'] });
    child.on('error', reject);
    child.stderr.on('data', function inspect(data) {
      stderr += data.toString();
      const match = stderr.match(/ws:\/\/127\.0\.0\.1:\d+\/[^\s]+/);
      if (match) resolve(match[0]);
    });
    child.on('exit', function exited(code) { reject(new Error('应用提前退出: ' + code + stderr)); });
  });
  socket = new WebSocket(address);
  socket.addEventListener('message', receive);
  await new Promise(function open(resolve, reject) {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  // Inspector 端口先于 Electron 内置模块初始化，沿用完整应用验证的启动等待。
  await new Promise(function boot(resolve) { setTimeout(resolve, 1500); });
  for (let i = 0; i < 100; i++) {
    if (await evaluate('(function(){const e=' + electron + ';return e.app.isReady()&&!!(' + find + ');})()')) break;
    await new Promise(function pause(resolve) { setTimeout(resolve, 100); });
  }
  check(await evaluate(electron + '.app.getPath("userData")') === userData, '只使用隔离配置');
  await waitPage('document.getElementById("status-theme").textContent==="浅色"');
  for (const theme of ['cel', 'dark', 'light', 'system', 'cel']) {
    await choose(theme);
    await waitPage('(async function(){const s=await simple.getState();return s.theme===' + JSON.stringify(theme) + '&&document.documentElement.dataset.theme===s.resolvedTheme;})()');
    check(true, '菜单切换并保存: ' + theme);
  }
  const styles = await page('(function(){const root=getComputedStyle(document.documentElement);const card=getComputedStyle(document.querySelector(".hero-card"));return {name:document.getElementById("status-theme").textContent,bg:root.getPropertyValue("--bg").trim(),pcb:getComputedStyle(document.getElementById("bg-pcb")).display,border:card.borderTopWidth,shadow:card.boxShadow};})()');
  check(styles.name === '锐线赛璐璐' && styles.bg === '#e8ebf0' && styles.pcb === 'none' && styles.border === '2px', '实际 DOM 使用独立主题名称、冷白背景、描边并隐藏 PCB');
  await page('document.querySelector(\'[data-act="settings"]\').click()');
  await waitPage('!!document.getElementById("m-theme")');
  check(await page('document.getElementById("m-theme").value==="cel" && document.getElementById("m-theme").options.length===4'), '设置保留原主题并选中新主题');
  await page('document.getElementById("m-theme").value="dark";document.getElementById("m-theme").dispatchEvent(new Event("change"));');
  await waitPage('document.documentElement.dataset.theme==="dark"');
  await page('document.getElementById("m-theme").value="cel";document.getElementById("m-theme").dispatchEvent(new Event("change"));');
  await waitPage('document.documentElement.dataset.theme==="cel"');
  await evaluate('(function(){const e=' + electron + ';(' + find + ').reload();return true;})()');
  await new Promise(function pause(resolve) { setTimeout(resolve, 1200); });
  await waitPage('document.getElementById("status-theme").textContent==="锐线赛璐璐"');
  check(true, '设置切换与重新加载后恢复新主题');
  const modulePath = JSON.stringify(path.join(root, 'electron/lib/house-style.js'));
  check(await evaluate('(function(){const r=process.getBuiltinModule("module").createRequire(' + modulePath + ');const h=r(' + modulePath + ');return h.currentTheme()==="cel"&&h.promptBlock(false).includes("锐线赛璐璐");})()'), '生成界面提示继承新主题');
  // 只显示本次隔离窗口并解除后台限帧；重载后可见文案先于绘制帧就绪。
  await evaluate(`(function showReferenceWindow() {
    const e = ${electron};
    const w = ${find};
    w.webContents.backgroundThrottling = false;
    w.showInactive();
  })()`);
  await captureReference('cel-welcome.png');
  // 截图夹具只填充 DOM，不保存会话、不调用模型；覆盖消息与深色操作区的布局。
  await page(`document.getElementById('view-welcome').classList.add('hidden');
    document.getElementById('view-chat').classList.remove('hidden');
    document.getElementById('messages').classList.remove('empty-center');
    document.getElementById('tabs').innerHTML='<div class="tab active">主题验收</div>';
    document.getElementById('tree-root-name').textContent='SpCode';
    document.getElementById('tree-body').innerHTML='<div class="tree-row">renderer</div><div class="tree-row">electron</div><div class="tree-row">scripts</div>';
    document.getElementById('messages').innerHTML='<div class="msg user"><div class="role">你</div><div class="bubble">保留开始界面的狂野风格，让对话页面更舒服。</div></div><div class="msg assistant"><div class="role">SimpleCode · 设计核对</div><div class="bubble md"><p>消息区保持清晰阅读，红黑锐线集中在标签和输入操作区。</p><p>主题菜单、设置保存、原主题切换均已验证。</p></div></div>';
    document.getElementById('btn-model').innerHTML='<span class="model-roster-chip">测试模型 <span class="model-role-tag">大脑</span></span><span class="model-roster-chip">代码模型 <span class="model-role-tag">代码</span></span>';
    document.getElementById('input').value='继续完成 MXAPI 接入。';`);
  await captureReference('cel-chat.png');
  check(await page('document.getElementById("btn-send").getBoundingClientRect().right<=document.documentElement.clientWidth && getComputedStyle(document.querySelector(".msg .bubble")).boxShadow==="none"'), '对话页发送按钮可见，正文不叠厚重边框投影');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ passed, styles, userData }, null, 2));
  console.log('RESULT ' + JSON.stringify({ checks: passed.length, output }));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate', params: { expression: electron + '.app.exit(0)' } }));
  socket.close();
}
const timer = setTimeout(timeout, 50000);
/** 超时关闭本测试创建的进程，不影响用户窗口。 */
function timeout() { if (child) child.kill(); console.error('主题验收超时'); process.exit(1); }
/** 结束计时并保留验证产物。 */
function done() { clearTimeout(timer); }
/** 保留错误并设置非零退出码。 */
function failed(error) { console.error(error.stack || error); if (socket) socket.close(); if (child) child.kill(); clearTimeout(timer); process.exitCode = 1; }
main().then(done, failed);
