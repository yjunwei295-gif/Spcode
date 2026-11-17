/**
 * 使用空白配置启动真实应用，检查 MXAPI 模板、编辑回填、视频槽与持久化。
 * 可传打包后的 EXE 路径；第二个参数 --legacy 只核对旧包的密钥行为。
 * 全部交互走真实 preload/IPC；测试凭据仅保存在隔离目录，不发送生成请求。
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'mxapi-settings-'));
const userData = path.join(output, 'user-data');
const appData = path.join(output, 'app-data');
fs.mkdirSync(userData);
fs.mkdirSync(appData);
const executable = process.argv[2] ? path.resolve(process.argv[2]) : require('electron');
const legacy = process.argv.includes('--legacy');
const args = process.argv[2] ? [] : [root];
args.push('--inspect=127.0.0.1:0', '--user-data-dir=' + userData);
const fixtureKey = 'mxapi-ui-test-credential';
let child, socket, sequence = 0;
const pending = new Map();
const passed = [];
const electron = "process.getBuiltinModule('module').createRequire(process.execPath)('electron')";
const find = 'e.BrowserWindow.getAllWindows().find(function(w){return w.webContents.getURL().includes("/index.html")&&!w.webContents.isLoading();})';
/** 记录行为断言，不输出凭据。 */
function check(value, label) { assert.ok(value, label); passed.push(label); console.log('PASS ' + label); }
/** 经本测试进程的 Inspector 执行代码，异常直接失败。 */
function evaluate(expression) {
  return new Promise(function send(resolve, reject) {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
/** 接收执行结果，保留异常定位信息。 */
function receive(message) {
  const data = JSON.parse(message.data);
  if (!pending.has(data.id)) return;
  const request = pending.get(data.id);
  pending.delete(data.id);
  if (data.error || data.result.exceptionDetails) request.reject(new Error(JSON.stringify(data)));
  else request.resolve(data.result.result.value);
}
/** 在真实主页面运行交互。 */
function page(code) { return evaluate('(async function(){const e=' + electron + ';const w=' + find + ';return w.webContents.executeJavaScript(' + JSON.stringify(code) + ');})()'); }
/** 在当前应用路径加载模块，兼容源码和 app.asar，不访问用户的其它实例。 */
function moduleCheck(code) {
  return evaluate('(async function(){const e=' + electron + ';const r=process.getBuiltinModule("module").createRequire(e.app.getAppPath()+"/package.json");const store=r("./electron/lib/store");' + code + '})()');
}
/** 等待明确页面条件，超时即失败。 */
async function waitPage(condition) {
  for (let i = 0; i < 120; i++) {
    if (await page(condition)) return;
    await new Promise(function pause(resolve) { setTimeout(resolve, 100); });
  }
  throw new Error('页面条件超时: ' + condition);
}
/** 重新加载已保存的隔离配置。 */
async function reload() {
  await evaluate('(function(){const e=' + electron + ';(' + find + ').reload();return true;})()');
  await new Promise(function pause(resolve) { setTimeout(resolve, 1200); });
  await waitPage('!!document.querySelector(\'[data-act="settings"]\')');
}
/** 隔离测试中的实际 HTTP 出口；保留生产协议和 IPC，禁止 MXAPI /models 请求蒙混通过。 */
async function installCatalogFixture() {
  await moduleCheck('globalThis.mxapiCatalogCalls=[];globalThis.mxapiCatalogDenied=false;const direct=e.session.fromPartition("spcode-direct");const original=direct.fetch.bind(direct);direct.fetch=async function catalogHttp(url,options){const address=String(url);if(!address.startsWith("https://open.mxapi.org/"))return original(url,options);globalThis.mxapiCatalogCalls.push(address);const balance=address==="https://open.mxapi.org/api/v2/points/balance";const status=balance?(globalThis.mxapiCatalogDenied?401:200):404;const data=status===200?{code:200,data:{remaining_points:100}}:{code:status,message:status===401?"fixture-invalid-key":"fixture-no-models"};return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json"}});};return true;');
}

/** 三个模板依次实际拉取、勾选和保存能力，重新加载后核对模型引用与厂商地址。 */
async function checkCatalogSelection() {
  await page('document.getElementById("vs-done").click()');
  await installCatalogFixture();
  const cases = [
    { preset: 'mxapi-video', count: 6, model: 'veo-3.1-fast', role: 'videoGen', baseUrl: 'https://open.mxapi.org/api/v2' },
    { preset: 'mxapi', count: 10, model: 'gpt-image-2', role: 'imageGen', baseUrl: 'https://open.mxapi.org/v1' },
    { preset: 'mxapi-nano', count: 1, model: 'nano-banana', role: 'imageGen', baseUrl: 'https://open.mxapi.org/api/v2/nano' }
  ];
  for (const item of cases) {
    await page('document.querySelector(\'[data-act="settings"]\').click()');
    await waitPage('!!document.querySelector(\'#p-preset option[value="' + item.preset + '"]\')');
    if (item.preset !== 'mxapi-video') {
      const providerCount = await page('(async function(){return (await simple.getState()).providers.length;})()');
      await page('document.getElementById("p-preset").value=' + JSON.stringify(item.preset) + ';document.getElementById("p-preset").dispatchEvent(new Event("change"));document.getElementById("p-key").value=' + JSON.stringify(fixtureKey) + ';document.getElementById("p-save").click();');
      await waitPage('document.querySelectorAll("[data-prov-edit]").length===' + (providerCount + 1));
    }
    const providerId = await page('(async function(){const s=await simple.getState();return s.providers.find(function(p){return p.baseUrl===' + JSON.stringify(item.baseUrl) + ';}).id;})()');
    await page('document.getElementById("mm-provider").value=' + JSON.stringify(providerId) + ';document.getElementById("mm-provider").dispatchEvent(new Event("change"));document.getElementById("mm-fetch").click();');
    await waitPage('!document.getElementById("mm-fetch").disabled&&document.querySelectorAll("[data-remote-id]").length===' + item.count);
    check(await page('(async function(){const s=await simple.getState();return !s.models.some(function(m){return m.providerId===' + JSON.stringify(providerId) + ';});})()'), item.preset + ' 拉取显示目录但不自动添加模型');
    await page('document.querySelector(' + JSON.stringify('[data-remote-id="' + item.model + '"]') + ').click()');
    await waitPage('(async function(){const s=await simple.getState();return s.models.some(function(m){return m.providerId===' + JSON.stringify(providerId) + '&&m.model===' + JSON.stringify(item.model) + ';});})()');
    const modelId = await page('(async function(){const s=await simple.getState();return s.models.find(function(m){return m.providerId===' + JSON.stringify(providerId) + '&&m.model===' + JSON.stringify(item.model) + ';}).id;})()');
    const select = 'select[data-cap-role="' + item.role + '"][data-cap-which="primary"]';
    await waitPage('!!document.querySelector(' + JSON.stringify(select + ' option[value="api:' + modelId + '"]') + ')');
    await page('(function(){const select=document.querySelector(' + JSON.stringify(select) + ');select.value=' + JSON.stringify('api:' + modelId) + ';select.dispatchEvent(new Event("change",{bubbles:true}));document.getElementById("m-ok").click();})()');
    await waitPage('(async function(){const s=await simple.getState();return s.capabilityDefaults[' + JSON.stringify(item.role) + ']?.primary?.apiId===' + JSON.stringify(modelId) + ';})()');
    await reload();
    check(await moduleCheck('const s=store.load();const a=r("./electron/lib/assembly");const cfg=a.slotToModelCfg(s.capabilityDefaults[' + JSON.stringify(item.role) + '].primary,s);return cfg.model===' + JSON.stringify(item.model) + '&&cfg.baseUrl===' + JSON.stringify(item.baseUrl) + '&&cfg.apiKey===' + JSON.stringify(fixtureKey) + ';'), item.preset + ' 勾选、保存能力并重载后仍指向正确厂商');
  }
  // 已保存模型还会查询推理能力目录，允许这些真实调用重复验证凭据，但不能访问 /models。
  const catalogRequests = await moduleCheck('return globalThis.mxapiCatalogCalls;');
  check(catalogRequests.filter(function balanceRequest(url) { return url === 'https://open.mxapi.org/api/v2/points/balance'; }).length >= cases.length && !catalogRequests.some(function modelRequest(url) { return url.endsWith('/models'); }), '三个模板通过真实 IPC 获取目录，均不发送 /models 请求');
  await moduleCheck('globalThis.mxapiCatalogDenied=true;return true;');
  check(await page('(async function(){const s=await simple.getState();try{await simple.listRemoteModels(s.providers[0].id);return false;}catch(error){return String(error.message).includes("401")&&String(error.message).includes("fixture-invalid-key");}})()'), '真实 IPC 保留无效 Key 错误，不冒充拉取成功');
}

/** 验证首启、用户保存回填和不复制密钥的视频模型引用。 */
async function main() {
  const address = await new Promise(function start(resolve, reject) {
    let stderr = '';
    child = spawn(executable, args, { env: { ...process.env, APPDATA: appData }, stdio: ['ignore', 'ignore', 'pipe'] });
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
  await new Promise(function boot(resolve) { setTimeout(resolve, 1500); });
  let ready = false;
  for (let i = 0; i < 120; i++) {
    ready = await evaluate('(function(){const e=' + electron + ';return e.app.isReady()&&!!(' + find + ');})()');
    if (ready) break;
    await new Promise(function pause(resolve) { setTimeout(resolve, 100); });
  }
  check(ready && await evaluate(electron + '.app.getPath("userData")') === userData, '使用空白隔离配置启动真实应用');
  check(await page('(async function(){const s=await simple.getState();return s.providers.length===0&&s.models.every(function(m){return !m.apiKey;});})()'), '首次启动没有预置厂商或密钥');
  check(await page('(async function(){const p=await simple.listProviderPresets();return p.filter(function(x){return x.id.startsWith("mxapi");}).every(function(x){return !x.apiKey;});})()'), 'MXAPI 厂商模板不含密钥');
  await moduleCheck('const s=store.load();s.onboardingCompleted=true;s.modelsDir=' + JSON.stringify(path.join(output, 'models')) + ';store.save(s);return true;');
  await reload();
  await page('document.querySelector(\'[data-act="settings"]\').click()');
  const preset = legacy ? 'mxapi-nano' : 'mxapi-video';
  await waitPage('!!document.querySelector(\'#p-preset option[value="' + preset + '"]\')');
  await page('document.getElementById("p-preset").value=' + JSON.stringify(preset) + ';document.getElementById("p-preset").dispatchEvent(new Event("change"));');
  check(await page('document.getElementById("p-key").value===""'), '选择 MXAPI 模板不会自动填写 Key');
  await page('document.getElementById("p-save").click()');
  await waitPage('document.querySelectorAll("[data-prov-edit]").length===1&&document.getElementById("p-cancel").style.display==="none"');
  await page('document.querySelector("[data-prov-edit]").click()');
  check(await page('document.getElementById("p-key").value===""'), '新建空 Key 厂商后点编辑仍为空');
  await page('document.getElementById("p-key").value=' + JSON.stringify(fixtureKey) + ';document.getElementById("p-save").click()');
  await waitPage('document.getElementById("p-cancel").style.display==="none"');
  await page('document.querySelector("[data-prov-edit]").click()');
  check(await page('document.getElementById("p-key").value===' + JSON.stringify(fixtureKey)), '编辑只回填本次明确保存的测试 Key');
  await page('document.getElementById("p-cancel").click()');
  if (!legacy) {
    const videoSelect = 'select[data-cap-role="videoGen"][data-cap-which="primary"]';
    check(await page('(function(){const select=document.querySelector(' + JSON.stringify(videoSelect) + ');return Array.from(select.options).filter(function(o){return o.value.startsWith("api:mxapi-video/");}).length===6;})()'), '仅添加厂商即提供六个视频候选，无需注册模型');
    check(await page('(async function(){const s=await simple.getState();return !s.models.some(function(m){return m.providerId===s.providers[0].id;})&&s.videoProviderModels.every(function(m){return !m.apiKey;});})()'), '派生候选不污染普通模型目录也不复制 Key');
    check(await page('!document.querySelector(\'select[data-cap-role="imageGen"] option[value^="api:mxapi-video/"]\')'), '视频候选不混入生图能力');
    const selected = await page('(function(){const select=document.querySelector(' + JSON.stringify(videoSelect) + ');const o=Array.from(select.options).find(function(x){return x.value.includes("veo-3.1-fast");});select.value=o.value;select.dispatchEvent(new Event("change",{bubbles:true}));return o.value;})()');
    await page('document.getElementById("m-ok").click()');
    await waitPage('(async function(){const s=await simple.getState();return s.capabilityDefaults.videoGen?.primary?.apiId===' + JSON.stringify(selected.slice(4)) + ';})()');
    await page('document.getElementById("btn-vision-settings").click()');
    await waitPage('!!document.getElementById("vs-add-slot")');
    await page('document.getElementById("vs-add-slot").click()');
    await waitPage('document.querySelectorAll("[data-slot-role]").length===1');
    await page('(function(){const el=document.querySelector("[data-slot-role]");el.value="videoGen";el.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await waitPage('document.querySelectorAll(\'[data-slot-model] option[value^="api:mxapi-video/"]\').length===6');
    await page('(function(){const el=document.querySelector("[data-slot-model]");el.value=' + JSON.stringify(selected) + ';el.dispatchEvent(new Event("change",{bubbles:true}));})()');
    await waitPage('(async function(){const s=await simple.getState();return s.assemblies[s.assemblyKey].slots[0].apiId===' + JSON.stringify(selected.slice(4)) + ';})()');
    await page('document.getElementById("vs-done").click()');
    await reload();
    check(await moduleCheck('const s=store.load();const a=r("./electron/lib/assembly");const slot=s.assemblies[a.assemblyKey(s)].slots[0];const cfg=a.slotToModelCfg(slot,s);return slot.apiId===' + JSON.stringify(selected.slice(4)) + '&&!slot.apiKey&&cfg.model==="veo-3.1-fast"&&cfg.apiKey===' + JSON.stringify(fixtureKey) + ';'), '组合槽重新加载后按引用解析厂商 Key');
    check(await moduleCheck('const s=store.load();const a=r("./electron/lib/assembly");const cfg=a.slotToModelCfg(s.capabilityDefaults.videoGen.primary,s);return cfg.model==="veo-3.1-fast"&&cfg.apiKey===' + JSON.stringify(fixtureKey) + ';'), '全局视频能力持久化并解析正确模型');
    await page('document.getElementById("btn-vision-settings").click()');
    await waitPage('document.querySelector("[data-slot-model]")?.value===' + JSON.stringify(selected));
    check(true, '组合界面重开仍选中保存的视频模型');
    await checkCatalogSelection();
  }
  const packaged = await evaluate(electron + '.app.isPackaged');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ executable, packaged, legacy, passed }, null, 2));
  console.log('RESULT ' + JSON.stringify({ checks: passed.length, packaged, output }));
  socket.send(JSON.stringify({ id: ++sequence, method: 'Runtime.evaluate', params: { expression: electron + '.app.exit(0)' } }));
  socket.close();
}
const timer = setTimeout(timeout, 60000);
/** 超时仅终止本脚本创建的进程。 */
function timeout() { if (child) child.kill(); console.error('MXAPI 界面验收超时'); process.exit(1); }
/** 清除验收计时。 */
function done() { clearTimeout(timer); }
/** 保留失败详情，不将写入成功当功能通过。 */
function failed(error) { console.error(error.stack || error); if (socket) socket.close(); if (child) child.kill(); clearTimeout(timer); process.exitCode = 1; }
main().then(done, failed);
