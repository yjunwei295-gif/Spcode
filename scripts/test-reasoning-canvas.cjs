/**
 * 在隔离的 Electron 用户目录验证推理参数、真实工具分发及完整画布界面。
 * 网络与模型结果使用明确夹具，测试不会修改用户配置或调用收费模型。
 */
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'reasoning-canvas-check-'));
app.setPath('userData', path.join(output, 'user-data'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
app.on('window-all-closed', function keepAlive() {});
const store = require('../electron/lib/store');
const passed = [];
let win;

/** 留下行为断言，失败时保留完整错误。 */
function check(value, label) { assert.ok(value, label); passed.push(label); console.log('PASS ' + label); }

/** 加载真实源码，只在测试内存中替换指定外部边界或暴露内部入口。 */
function expose(file, suffix, overrides = {}) {
  const filename = path.join(root, file);
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = function dependency(name) {
    if (Object.hasOwn(overrides, name)) return overrides[name];
    return Module.prototype.require.call(loaded, name);
  };
  loaded._compile(fs.readFileSync(filename, 'utf8') + '\n' + suffix, filename);
  return loaded.exports;
}

/** 提取真实 IPC 处理器注册语句，确保主进程接线也经过测试。 */
function registerHandler(name, context) {
  const source = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('" + name + "'");
  const end = source.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start, name);
  vm.runInNewContext(source.substring(start, end + 4), context);
}

/** 核对分块、重复记录和双管道入口使用的真实步数解析器。 */
function testProgress() {
  const { createSdProgressReader } = require('../electron/lib/image-generation-progress');
  const seen = [];
  const read = createSdProgressReader(function progress(value) { seen.push(value.percent); });
  read(Buffer.from('模型加载中\r|###| 1/'));
  read(Buffer.from('4 - 0.5s/it\r|###| 2/4 - 0.'));
  read(Buffer.from('5s/it\r|###| 2/4 - 0.5s/it\r'));
  read(Buffer.from('|###| 4/4 - 2.0it/s\n'));
  assert.deepEqual(seen, [25, 50, 100]);
  check(true, '真实步数日志跨块拼接、去重并产生25/50/100%，不使用计时模拟');
}

/** 核对厂商目录、参数透传及默认不发送推理字段的行为。 */
async function testReasoning() {
  let requestBody;
  async function fetcher(url, options) {
    if (url.endsWith('/models')) return { ok: true, json: async function models() { return { data: [
      { id: 'supported', supported_parameters: ['reasoning_effort'] }, { id: 'plain' }] }; } };
    requestBody = JSON.parse(options.body);
    return { ok: true, json: async function response() { return { choices: [{ message: {role:'assistant',content:'OK'} }] }; } };
  }
  const protocol = expose('electron/lib/api-protocol.js', '', { './http-fetch': {httpFetch:fetcher} });
  const cfg = {type:'api',protocol:'openai',model:'supported',baseUrl:'https://fixture.invalid/v1'};
  const list = await protocol.listModels(cfg);
  assert.deepEqual(list.catalog.supported.reasoningOptions.map(function value(item){return item.value;}), ['low','medium','high']);
  check(list.catalog.plain.reasoningOptions.length === 0, '厂商未声明能力的API模型不显示可调档位');
  await protocol.complete({modelCfg:{...cfg,reasoningEffort:'low'},messages:[{role:'user',content:'test'}],stream:false});
  check(requestBody.reasoning_effort === 'low', '实际OpenAI协议请求体接收到用户选择的低强度');
  await protocol.complete({modelCfg:cfg,messages:[{role:'user',content:'test'}],stream:false});
  check(!Object.hasOwn(requestBody,'reasoning_effort'), '模型默认不发送强度参数');

  const cursor = expose('electron/lib/cursor-model.js',
    'module.exports.test={reasoningOptionsOf,modelParameterCache};');
  const rows = [{id:'cursor-fixture',parameters:[{id:'reasoning',values:[{value:'low',displayName:'低'},{value:'xhigh',displayName:'超高'}]}]}];
  cursor.test.modelParameterCache.set('', {at:Date.now(),rows});
  const choice = await cursor.highModelSelection({model:'cursor-fixture',reasoningEffort:'low'});
  assert.deepEqual(choice.params,[{id:'reasoning',value:'low'}]);
  assert.deepEqual(await cursor.highModelSelection({model:'cursor-fixture'}),{id:'cursor-fixture'});
  await assert.rejects(cursor.highModelSelection({model:'cursor-fixture',reasoningEffort:'absent'}),/不支持/);
  check(true,'Cursor使用目录原始参数，默认不强推高档，失效档位明确报错');

  const codex = expose('electron/lib/codex-model.js',
    'module.exports.test={seed:function(rows){modelListCache=rows;modelListCacheAt=Date.now();},setClient:function(client){makeCodex=async function(){return client;};}};');
  codex.test.seed([{id:'codex-fixture',name:'测试Codex',isDefault:true,reasoningOptions:[{value:'low',label:'low'},{value:'xhigh',label:'xhigh'}]}]);
  const catalog = await codex.listModels({apiKey:'fixture-key'});
  check(catalog.catalog.default.reasoningOptions[1].value === 'xhigh', 'Codex默认模型别名继承真实目录档位');
  let sdkOptions;
  codex.test.setClient({startThread:function startThread(options){sdkOptions=options;return {run:async function run(){return {finalResponse:'OK'};}};}});
  await codex.complete({modelCfg:{model:'codex-fixture',reasoningEffort:'xhigh'},messages:[{role:'user',content:'test'}],stream:false});
  check(sdkOptions.modelReasoningEffort === 'xhigh', 'Codex普通SDK请求使用已选超高档位');
  const sdk = await import('@openai/codex-sdk');
  const original = sdk.Codex.prototype.startThread;
  sdk.Codex.prototype.startThread = function capture(options) {sdkOptions=options;return {};};
  const direct = expose('electron/lib/codex-direct.js', 'module.exports.test={createSession};');
  try {
    await direct.test.createSession('reasoning-test','signature',{model:'codex-fixture',reasoningEffort:'low'},[],function event(){},false);
    check(sdkOptions.modelReasoningEffort === 'low', 'Codex直通创建的真实SDK线程收到低档参数');
  } finally {direct.closeSession('reasoning-test');sdk.Codex.prototype.startThread=original;}
}

/** 用完整生图工具入口验证进度、完成文件、失败和停止的事件生命周期。 */
async function testGeneration() {
  const reference = path.join(output,'fixture.png');
  fs.writeFileSync(reference,nativeImage.createFromBitmap(Buffer.from([60,120,200,255]),{width:1,height:1}).toPNG());
  const modelPath=path.join(output,'fixture.gguf');
  fs.writeFileSync(modelPath,'仅供路由测试，不用于推理');
  const config = store.load();
  config.models = [
    {id:'fixture',name:'测试模型一',type:'api',model:'fixture',providerId:'p'},
    {id:'second',name:'测试模型二',type:'api',model:'second',providerId:'p'},
    {id:'plain',name:'不可调模型',type:'api',model:'plain',providerId:'p'}
  ];
  config.providers = [{id:'p',name:'测试厂商',protocol:'openai',baseUrl:'https://fixture.invalid/v1'}];
  config.currentModelId='fixture';
  config.modelsDir=output;
  config.assemblies={'api:fixture':{slots:[{id:'image',role:'imageGen',type:'local',modelPath}]}};
  store.save(config);
  const engine=require('../electron/lib/image-gen-engine');
  const original=engine.generate;
  const agent=expose('electron/lib/agent.js','module.exports.test={execTool};');
  const events=[];
  function collect(event){if(event.type==='image_generation')events.push(event);}
  engine.generate=async function fixture(args){
    args.onProgress({percent:25,step:1,total:4,phase:'sampling',text:'第1/4步'});
    args.onProgress({percent:75,step:3,total:4,phase:'sampling',text:'第3/4步'});
    return {buf:fs.readFileSync(reference),ext:'.png'};
  };
  try {
    await agent.test.execTool(output,{},'generate_media',{kind:'image',prompt:'绘图进度测试'},collect,[],undefined,'zh');
    const complete=events.find(function completed(event){return event.status==='completed';});
    check(events.some(function progress(event){return event.percent===75;})&&complete&&fs.existsSync(path.join(output,complete.rel)), '真实工具→媒体→引擎→会话事件完整透传，图片落盘后才报告100%完成');
    check(new Set(events.map(function id(event){return event.taskId;})).size===1,'单次生成全过程保持同一任务ID');
    engine.generate=async function failure(){throw new Error('明确的生成失败夹具');};
    events.length=0;
    await agent.test.execTool(output,{},'generate_media',{kind:'image',prompt:'失败测试'},collect,[],undefined,'zh');
    check(events.at(-1).status==='failed','生成失败结束画布任务，不伪装为完成');
    engine.generate=async function cancelled(){const error=new Error('停止');error.name='AbortError';throw error;};
    events.length=0;
    await assert.rejects(agent.test.execTool(output,{},'generate_media',{kind:'image',prompt:'停止测试'},collect,[],undefined,'zh'),/停止/);
    check(events.at(-1).status==='cancelled','停止生成发送取消状态');
  } finally {engine.generate=original;}
  return reference;
}

/** 等待确定的页面条件，超时报告真实界面异常。 */
async function waitFor(expression) {
  await win.webContents.executeJavaScript('(async function wait(){for(let n=0;n<200;n++){if('+expression+')return true;await new Promise(function pause(resolve){setTimeout(resolve,20);});}throw Error("页面条件超时："+JSON.stringify(fullPageRecord.errors));})()');
}

/**
 * 在真实模型管理界面分别设置两个模型，核对独立保存、重开恢复和实际请求体。
 * 使用隔离设置及明确能力目录，测试不会切换用户模型或调用在线生成。
 */
async function testManagedReasoning() {
  await win.webContents.executeJavaScript('document.querySelector("#model-menu [data-act=settings]").click();');
  await waitFor('document.querySelector("#api-model-list [data-reasoning-model=second]")');
  check(await win.webContents.executeJavaScript('document.querySelectorAll("#api-model-list [data-reasoning-model]").length===2 && !document.querySelector("#api-model-list [data-model-reasoning=plain] select") && document.querySelector("#api-model-list [data-model-reasoning=plain]").textContent.includes("厂商目录未声明")'),
    '模型管理逐项展示真实支持的强度，不可调模型明确说明');
  await win.webContents.executeJavaScript('const second=document.querySelector("#api-model-list [data-reasoning-model=second]");second.value="high";second.dispatchEvent(new Event("change"));');
  await waitFor('document.querySelector("#api-model-list [data-model-reasoning=second] small").textContent.includes("已保存")');
  const saved = store.load();
  check(saved.models.find(function first(model){return model.id==='fixture';}).reasoningEffort==='low' &&
    saved.models.find(function second(model){return model.id==='second';}).reasoningEffort==='high',
    '模型一为低、模型二为高，分别通过真实保存IPC持久化，互不覆盖');
  check(saved.currentModelId==='fixture' && await win.webContents.executeJavaScript('document.getElementById("m-brain").value==="fixture" && document.querySelector("#reasoning-control select").value==="low"'),
    '设置非当前模型强度不切换当前模型，顶栏仍显示当前模型的独立档位');

  const bodies=[];
  const protocol=expose('electron/lib/api-protocol.js','',{'./http-fetch':{httpFetch:async function capture(url,options){
    bodies.push(JSON.parse(options.body));
    return {ok:true,json:async function response(){return {choices:[{message:{role:'assistant',content:'OK'}}]};}};
  }}});
  for (const id of ['fixture','second']) {
    await protocol.complete({modelCfg:store.resolveModelCfg(id),messages:[{role:'user',content:'独立档位验证'}],stream:false});
  }
  check(bodies[0].model==='fixture' && bodies[0].reasoning_effort==='low' &&
    bodies[1].model==='second' && bodies[1].reasoning_effort==='high',
    '两个模型使用各自已保存配置，实际协议请求分别携带低和高强度');

  await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));');
  await waitFor('document.getElementById("modal").classList.contains("hidden")');
  await win.webContents.executeJavaScript('document.querySelector("#model-menu [data-act=settings]").click();');
  await waitFor('document.querySelector("#api-model-list [data-reasoning-model=second]")');
  check(await win.webContents.executeJavaScript('document.querySelector("#api-model-list [data-reasoning-model=fixture]").value==="low" && document.querySelector("#api-model-list [data-reasoning-model=second]").value==="high"'),
    '关闭并重开模型管理后，两个模型分别恢复自己的档位');
  await win.webContents.executeJavaScript('document.querySelector("#api-model-list [data-model-id=second]").scrollIntoView({block:"center"});');
  fs.writeFileSync(path.join(output,'model-reasoning.png'),(await win.webContents.capturePage()).toPNG());

  await win.webContents.executeJavaScript('const reset=document.querySelector("#api-model-list [data-reasoning-model=second]");reset.value="";reset.dispatchEvent(new Event("change"));');
  await waitFor('document.querySelector("#api-model-list [data-model-reasoning=second] small").textContent.includes("已保存")');
  await protocol.complete({modelCfg:store.resolveModelCfg('second'),messages:[{role:'user',content:'模型默认验证'}],stream:false});
  check(!Object.hasOwn(bodies.at(-1),'reasoning_effort') && store.resolveModelCfg('fixture').reasoningEffort==='low',
    '单独恢复模型二默认仅清除其请求强度，模型一仍保持低档');
  await win.webContents.executeJavaScript('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}));');
  await waitFor('document.getElementById("modal").classList.contains("hidden")');
}

/** 加载真实HTML/CSS与所有ES模块，验证控件、保存、切换和图片展示。 */
async function testPage(reference) {
  const {mergeCatalogEdits}=require('../electron/lib/model-catalog');
  const snapshots=new WeakMap();
  const apiProtocol={listModels:async function listModels(){return {catalog:{fixture:{reasoningOptions:[{value:'low',label:'low'},{value:'high',label:'high'}]},second:{reasoningOptions:[{value:'low',label:'low'},{value:'high',label:'high'}]},plain:{reasoningOptions:[]}}};}};
  registerHandler('models:reasoningOptions',{ipcMain,store,apiProtocol});
  registerHandler('models:save',{ipcMain,store,mergeCatalogEdits,modelCatalogBySender:snapshots,structuredClone,syncCursorDirect:function noOp(){}});
  ipcMain.handle('test:state',function state(event){
    const settings=store.load();
    snapshots.set(event.sender,structuredClone({models:settings.models,providers:settings.providers}));
    return {...settings,workspace:'fixture',resolvedTheme:'dark',theme:'dark',locale:'zh',recents:[],localFiles:[]};
  });
  const source=fs.readFileSync(path.join(root,'scripts/test-ui-performance.cjs'),'utf8').split('\r\n').join('\n');
  const start=source.indexOf('function fullPageSetup()'),end=source.indexOf('\n}\n',start);
  assert.ok(start>=0&&end>start);
  const setup='('+source.substring(start,end+3)+')();\n'+
    'simple.getState=function(){return require("electron").ipcRenderer.invoke("test:state");};\n'+
    'simple.modelReasoningOptions=function(id){return require("electron").ipcRenderer.invoke("models:reasoningOptions",id);};\n'+
    'simple.saveModels=function(models,currentModelId,providers){return require("electron").ipcRenderer.invoke("models:save",{models,currentModelId,providers});};\n'+
    'simple.readWorkspaceFile=async function(){return {kind:"image",content:'+JSON.stringify('data:image/png;base64,'+fs.readFileSync(reference).toString('base64'))+'};};\n'+
    'simple.showInFolder=function(){};simple.indexStatus=async function(){return null;};simple.fetchAccountBalance=async function(){return {available:false};};simple.listLocalModels=async function(){return {files:[]};};\n';
  win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{nodeIntegration:true,contextIsolation:false,backgroundThrottling:false}});
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:setup});
  await win.loadFile(path.join(root,'renderer/index.html'));
  await waitFor('document.querySelector("#tabs .tab") && document.querySelector("[data-reasoning-model]")');
  const pageErrors = await win.webContents.executeJavaScript('fullPageRecord.errors');
  check(pageErrors.length===0,'完整页面加载推理控件与画布，无脚本异常：'+JSON.stringify(pageErrors));
  await win.webContents.executeJavaScript('document.getElementById("btn-model").click();');
  await waitFor('document.getElementById("model-menu").classList.contains("show") && document.querySelector("[data-reasoning-model]")');
  await win.webContents.executeJavaScript('const select=document.querySelector("[data-reasoning-model]");select.value="low";select.dispatchEvent(new Event("change"));');
  await waitFor('document.querySelector("#reasoning-control small").textContent.includes("已保存")');
  check(store.load().models.find(function model(item){return item.id==='fixture';}).reasoningEffort==='low','真实下拉框通过模型保存IPC持久化推理档位');
  check(store.resolveModelCfg('fixture').reasoningEffort==='low','保存档位经过厂商配置解析后仍进入实际模型请求配置');
  await testManagedReasoning();
  await win.webContents.executeJavaScript('document.getElementById("input").value="绘图测试";document.getElementById("btn-send").click();');
  await waitFor('fullPageRecord.turnId');
  await win.webContents.executeJavaScript('emitTestChat({type:"image_generation",turnId:fullPageRecord.turnId,taskId:"canvas-1",status:"running",prompt:"小屋",model:"本地绘图",percent:null,text:"加载中"});');
  check(await win.webContents.executeJavaScript('!document.getElementById("image-canvas").classList.contains("hidden") && document.querySelector(".image-canvas-card header span").textContent==="进度未知" && !document.querySelector(".image-canvas-card progress").hasAttribute("value")'),'生成开始自动打开画布，未知进度不显示假百分比');
  await win.webContents.executeJavaScript('emitTestChat({type:"image_generation",turnId:fullPageRecord.turnId,taskId:"canvas-1",percent:75,step:3,total:4,text:"第3/4步"});');
  check(await win.webContents.executeJavaScript('document.querySelector(".image-canvas-card progress").value===75 && document.querySelector(".image-canvas-card header span").textContent==="75%"'),'真实页面显示75%和相应进度条');
  check(await win.webContents.executeJavaScript('(function(){const panel=document.getElementById("image-canvas");const box=panel.getBoundingClientRect();return box.width>=260&&box.right<=innerWidth&&panel.scrollWidth<=box.width;})()'),'画布在窗口内完整布局，没有横向溢出');
  win.showInactive();
  await win.webContents.executeJavaScript('new Promise(function painted(resolve){requestAnimationFrame(function frame(){requestAnimationFrame(resolve);});})');
  fs.writeFileSync(path.join(output,'canvas-progress.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('emitTestChat({type:"image_generation",turnId:fullPageRecord.turnId,taskId:"canvas-1",status:"completed",percent:100,rel:"fixture.png",text:"绘图完成"});');
  await waitFor('document.querySelector(".image-canvas-preview img")?.naturalWidth>0');
  check(await win.webContents.executeJavaScript('document.querySelector(".image-canvas-card header span").textContent==="100%" && !document.querySelector(".image-canvas-card progress")'),'图片实际加载成功后显示100%，结束进度动画');
  await win.webContents.executeJavaScript('document.querySelector(".image-canvas-preview img").click()');
  check(await win.webContents.executeJavaScript('!document.getElementById("lightbox").classList.contains("hidden")'),'画布成图可以点击放大');
  await win.webContents.executeJavaScript('document.getElementById("lightbox").click();emitTestChat({type:"done",turnId:fullPageRecord.turnId,text:"已完成"});fullPageRecord.resolveTurn({text:"已完成",changes:[]});');
  await win.webContents.executeJavaScript('new Promise(function settle(resolve){setTimeout(resolve,150);})');
  fs.writeFileSync(path.join(output,'canvas-complete.png'),(await win.webContents.capturePage()).toPNG());
  await win.webContents.executeJavaScript('document.getElementById("btn-new-tab").click()');
  check(await win.webContents.executeJavaScript('document.querySelectorAll(".image-canvas-card").length===0'),'切换到新会话后不显示上一会话绘图任务');
  check((await win.webContents.executeJavaScript('fullPageRecord.errors')).length===0,'交互、流式事件和切换会话后均无界面异常');
  if (!process.argv.includes('--inspect-ui')) {win.destroy();win=null;}
}

/** 顺序执行全部专项检查并保存可复核证据。 */
async function main(){
  await app.whenReady();
  testProgress();
  await testReasoning();
  if (process.argv.includes('--live-catalog')) {
    const actual = await require('../electron/lib/codex-model').listModels({});
    const adjustable = [];
    for (const id of actual.models) {
      const choices = actual.catalog[id].reasoningOptions || [];
      if (choices.length) adjustable.push({model:id,efforts:choices.map(function effort(choice){return choice.value;})});
    }
    check(adjustable.length>0,'本机Codex真实目录可读取并返回可调档位');
    fs.writeFileSync(path.join(output,'live-catalog.json'),JSON.stringify(adjustable,null,2),'utf8');
  }
  const reference=await testGeneration();
  await testPage(reference);
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({passed},null,2),'utf8');
  console.log('EVIDENCE '+output);
  if (process.argv.includes('--inspect-ui')) {
    win.setTitle('SpCode 推理与画布验收');
    await win.webContents.executeJavaScript('document.querySelector("#tabs .tab").click();if(document.getElementById("image-canvas").classList.contains("hidden"))document.getElementById("btn-image-canvas").click();document.getElementById("btn-model").click();');
    win.show();win.focus();
    console.log('UI_PID '+process.pid);
  } else app.exit(0);
}
main().catch(function failed(error){console.error(error.stack||error);if(win)win.destroy();app.exit(1);});
