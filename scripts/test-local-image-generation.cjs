/**
 * 本地生图专项：真实工具分发、共享参数、完整设置页面、隔离 IPC 持久化。
 * --real 使用已安装的本地模型实际生成两帧，测试输出和配置仅写 generated 独立目录。
 */
const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const Module = require('module');
const vm = require('vm');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'local-image-check-'));
const actualUserData = path.join(app.getPath('appData'), 'SimpleCode');
app.setPath('userData', path.join(output, 'user-data'));
fs.mkdirSync(app.getPath('userData'), { recursive: true });
app.on('window-all-closed', function keepAlive() {});
const store = require('../electron/lib/store');
const options = require('../electron/lib/image-gen-options');
const passed = [];
let realResults = null;

/** 留下逐项行为证据，失败不继续宣称通过。 */
function check(value, label) { assert.ok(value, label); passed.push(label); console.log('PASS ' + label); }
/** 在内存暴露真实内部入口，不改写生产文件。 */
function expose(file, suffix) {
  const abs = path.join(root, file), loaded = new Module(abs, module);
  loaded.filename = abs; loaded.paths = Module._nodeModulePaths(path.dirname(abs));
  loaded._compile(fs.readFileSync(abs, 'utf8') + '\n' + suffix, abs);
  return loaded.exports;
}
/** 按明确边界提取现有顶层夹具，边界缺失立即失败。 */
function extract(source, signature) {
  const start = source.indexOf(signature), end = source.indexOf('\n}\n', start);
  assert.ok(start >= 0 && end > start, signature);
  return source.substring(start, end + 3);
}
/** 轮询页面自身状态，超时报告真实界面错误。 */
async function waitFor(win, expression) {
  return win.webContents.executeJavaScript('(async function wait(){for(let i=0;i<150;i++){if(' + expression +
    ')return true;await new Promise(function pause(resolve){setTimeout(resolve,20);});}throw Error("页面等待超时 "+JSON.stringify(window.fullPageRecord?.errors));})()');
}
/** 注册原始主进程保存处理器，使用隔离的真实 store。 */
function registerSettings() {
  const text = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  const start = text.indexOf("ipcMain.handle('app:localImageGeneration'");
  const end = text.indexOf('\n});', start);
  assert.ok(start >= 0 && end > start);
  function dependency(name) { assert.equal(name, './lib/image-gen-options'); return options; }
  vm.runInNewContext(text.substring(start, end + 4), { ipcMain, store, require: dependency });
}
/** 用真实 HTML / ES 模块运行设置，并把新增保存动作接到真实 IPC。 */
async function openSettingsPage() {
  const source = fs.readFileSync(path.join(root, 'scripts/test-ui-performance.cjs'), 'utf8').split('\r\n').join('\n');
  const saved = store.load();
  const setup = '(' + extract(source, 'function fullPageSetup()') + ')();\n' +
    'const savedImageSettings=' + JSON.stringify(saved.localImageGeneration) + ';\n' +
    'const baseState=simple.getState;simple.getState=async function(){return {...await baseState(),localImageGeneration:savedImageSettings};};\n' +
    'simple.indexStatus=async function(){return null;};simple.listLocalModels=async function(){return {files:[]};};\n' +
    'simple.listProviderPresets=async function(){return [];};simple.getProviderQuota=async function(){return {};};\n' +
    'simple.saveSearchSites=async function(v){return v;};simple.saveProxy=async function(){};simple.saveCommandSandbox=async function(v){return v;};\n' +
    'simple.saveMaxAgentRounds=async function(v){return Number(v);};simple.saveCapabilityDefaults=async function(v){return v;};simple.setTheme=async function(){return "dark";};\n' +
    'simple.saveLocalImageGeneration=function(v){return require("electron").ipcRenderer.invoke("app:localImageGeneration",v);};\n' +
    'window.alert=function(message){fullPageRecord.errors.push({alert:message});};';
  const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: setup });
  await win.loadFile(path.join(root, 'renderer/index.html'));
  await waitFor(win, 'document.getElementById("input") && window.fullPageRecord');
  await win.webContents.executeJavaScript('document.querySelector("[data-act=settings]").click()');
  await waitFor(win, 'document.getElementById("image-preset")');
  return win;
}
/** 验证完整参数设置、手动覆盖、重开恢复和 preload 桥接。 */
async function testSettings() {
  registerSettings();
  store.save({ ...store.load(), retained: '不改其他设置', localImageGeneration: {} });
  let win = await openSettingsPage();
  check((await win.webContents.executeJavaScript('fullPageRecord.errors')).length === 0, '完整设置页面和新模块初始化无异常');
  await win.webContents.executeJavaScript('document.getElementById("m-ok").click()');
  await waitFor(win, 'document.getElementById("modal").classList.contains("hidden")');
  check(store.load().localImageGeneration.samplingMethod === undefined && store.load().localImageGeneration.steps === undefined, '留空参数和采样器可正常保存，继续使用模型配方');
  win.destroy();
  win = await openSettingsPage();
  await win.webContents.executeJavaScript('document.getElementById("image-preset").value="pixel";document.getElementById("image-preset").dispatchEvent(new Event("change"));');
  check(await win.webContents.executeJavaScript('document.getElementById("image-width").value==="512" && document.getElementById("image-strength").value==="0.35"'), '用户选择像素动画后填入可编辑预设');
  await win.webContents.executeJavaScript('document.getElementById("image-width").value="640";document.getElementById("image-height").value="384";document.getElementById("image-steps").value="12";document.getElementById("image-seed").value="0";document.getElementById("image-strength").value="0.4";document.getElementById("image-cfgScale").value="3";document.getElementById("image-negativePrompt").value="";document.getElementById("m-ok").click();');
  await waitFor(win, 'document.getElementById("modal").classList.contains("hidden")');
  const saved = store.load().localImageGeneration;
  check(saved.width === 640 && saved.height === 384 && saved.steps === 12 && saved.seed === 0 && saved.strength === 0.4 && saved.cfgScale === 3, '真实设置按钮通过 IPC 持久化宽高步数种子和强度');
  check(saved.negativePrompt === '' && store.load().retained === '不改其他设置', '允许清空反向提示词且保留其他用户设置');
  check((await win.webContents.executeJavaScript('fullPageRecord.errors')).length === 0, '完整保存流程无界面异常');
  win.destroy();
  win = await openSettingsPage();
  check(await win.webContents.executeJavaScript('document.getElementById("image-preset").value==="pixel" && document.getElementById("image-width").value==="640" && document.getElementById("image-steps").value==="12"'), '重开真实页面恢复预设及手改参数');
  await win.webContents.executeJavaScript('document.getElementById("image-steps").value="0";document.getElementById("m-ok").click();');
  await waitFor(win, 'fullPageRecord.errors.length>0');
  check(store.load().localImageGeneration.steps === 12, '无效步数阻止保存，不改成默认步数');
  win.showInactive();
  await win.webContents.executeJavaScript('document.getElementById("local-image-settings").scrollIntoView();new Promise(function painted(resolve){setTimeout(resolve,350);});');
  fs.writeFileSync(path.join(output, 'settings.png'), (await win.webContents.capturePage()).toPNG());
  win.destroy();
  const bridge = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false } });
  await bridge.loadURL('about:blank');
  const result = await bridge.webContents.executeJavaScript('simple.saveLocalImageGeneration({steps:9,width:512,height:320,seed:-1})');
  check(result.steps === 9 && store.load().localImageGeneration.height === 320, '真实隔离 preload 支持新增参数保存 IPC');
  bridge.destroy();
}
/** 验证普通和直通共用工具入口，没有在路由中丢失参考图或单次参数。 */
async function testDispatch() {
  const agent = expose('electron/lib/agent.js', 'module.exports.imageTest={execTool,attachmentsToParts};');
  const spec = agent.toolsSpec().find(function match(t) { return t.function.name === 'generate_media'; }).function.parameters.properties;
  check(['imagePath','preset','steps','width','height','seed','strength','cfgScale','samplingMethod','negativePrompt'].every(function has(key) { return !!spec[key]; }), '真实工具 schema 暴露参考图和全部可调参数');
  const reference = path.join(output, 'reference.png');
  // 极小 PNG 夹具只用于路径透传，不用假图片模拟真实模型运行。
  fs.writeFileSync(reference, nativeImage.createFromBuffer(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64')).toPNG());
  const attachments = await agent.imageTest.attachmentsToParts([{path:reference}], {vision:true});
  check(attachments.extraTexts.some(function has(t){return t.includes(reference);}), '图片附件向模型提供真实本机路径，可直接用于图生图');
  const engine = require('../electron/lib/image-gen-engine'), original = engine.generate;
  let captured;
  engine.generate = async function capture(args) { captured = args; return { buf:fs.readFileSync(reference),ext:'.png',parameters:args.imageOptions }; };
  const s = store.load();
  s.modelsDir = output;
  s.assemblies = { test: { slots: [{id:'image',role:'imageGen',type:'local',modelPath:reference + '.gguf'}] } };
  s.localImageGeneration = {preset:'pixel',width:512,height:512,steps:28,strength:0.35,seed:42};
  fs.writeFileSync(reference + '.gguf', '路由夹具，不用于推理');
  store.save(s);
  try {
    const reply = await agent.imageTest.execTool(output, {}, 'generate_media', {kind:'image',prompt:'下一帧抬手',imagePath:'reference.png',steps:7,width:640,height:384,seed:0,strength:0.5}, function event(){}, [], undefined, 'zh');
    check(captured.imagePath === reference && captured.imageOptions.steps === 7 && captured.imageOptions.width === 640 && captured.imageOptions.height === 384 && captured.imageOptions.seed === 0 && captured.imageOptions.strength === 0.5, '真实工具分发和媒体路由完整透传参考图及单次覆盖参数');
    check(captured.imageOptions.preset === 'pixel' && reply.includes('本次本地生图参数'), '未指定参数保留设置，成功结果回报本次参数');
    await assert.rejects(agent.imageTest.execTool(output, {}, 'generate_media', {kind:'image',prompt:'测试',imagePath:path.join(output,'missing.png')}, function event(){}, [], undefined, 'zh'), /路径|不存在/);
    check(true, '参考图不存在明确报错，不静默退回文生图');
  } finally { engine.generate = original; }
  const internal = expose('electron/lib/image-gen-engine.js', 'module.exports.testArgs={generationArgs,resolveSimpleArgs};').testArgs;
  const resolved = options.resolve({preset:'pixel',width:640,height:384,steps:7,seed:0,strength:0.5,cfgScale:3,negativePrompt:''}, 'qwen-image');
  const args = internal.generationArgs('抬手', 'out.png', resolved, reference);
  check(args[args.indexOf('--steps')+1] === '7' && args[args.indexOf('-W')+1] === '640' && args[args.indexOf('-H')+1] === '384' && args[args.indexOf('--seed')+1] === '0', '最终 CLI 参数保留步数、非方形尺寸和零种子');
  check(args.includes('--init-img') && args.includes('--image-preprocess') && args[args.indexOf('--strength')+1] === '0.5', '图生图实际参数包含参考图、重绘强度与像素最近邻预处理');
  check(options.resolve({}, 'qwen-image').steps === 28 && options.resolve({}, 'single').steps === 20 && options.resolve({}, 'single').width === 768, '没有显式设置时保留原 Qwen / SD 配方默认行为');
  assert.throws(function invalid(){options.normalize({width:513});}, /倍数/);
  assert.throws(function invalid(){options.normalize({steps:0});}, /不能小于/);
  check(true, '不合法尺寸和步数明确拒绝，不静默修正');
}
/** 真实推理从 PNG 头和引擎嵌入的元数据检查尺寸、参考图与采样参数。 */
async function testReal() {
  const userSettings = JSON.parse(fs.readFileSync(path.join(actualUserData, 'settings.json'),'utf8'));
  const s = store.load();
  s.modelsDir = userSettings.modelsDir;
  s.assemblies = userSettings.assemblies;
  s.localImageGeneration = {};
  store.save(s);
  const markerDir = path.join(app.getPath('userData'),'engines','stable-diffusion.cpp');
  fs.mkdirSync(markerDir,{recursive:true});
  for(const flavor of ['vulkan','cpu']) fs.copyFileSync(path.join(actualUserData,'engines','stable-diffusion.cpp','ready-'+flavor+'.json'),path.join(markerDir,'ready-'+flavor+'.json'));
  const draw = new BrowserWindow({show:false,webPreferences:{contextIsolation:true}});
  await draw.loadURL('about:blank');
  const url = await draw.webContents.executeJavaScript('(function(){const c=document.createElement("canvas");c.width=256;c.height=256;const x=c.getContext("2d");x.fillStyle="#efe8d2";x.fillRect(0,0,256,256);x.fillStyle="#223355";x.fillRect(96,48,64,64);x.fillStyle="#de4545";x.fillRect(80,112,96,80);x.fillStyle="#223355";x.fillRect(80,192,32,48);x.fillRect(144,192,32,48);return c.toDataURL();})()');
  draw.destroy();
  fs.writeFileSync(path.join(output,'input.png'),Buffer.from(url.slice(url.indexOf(',')+1),'base64'));
  const agent = expose('electron/lib/agent.js','module.exports.imageTest={generateRole};');
  const files=[];
  let imagePath='input.png';
  for(let frame=0;frame<2;frame++){
    const result=await agent.imageTest.generateRole({vs:store.load(),role:'imageGen',prompt:'A pixel art game character in a red shirt, dark blue hair and boots, standing front view on a plain cream background, '+(frame===0?'arms resting':'right arm slightly raised')+', preserve the reference character and palette',workspace:output,extra:[],onEvent:function event(e){if(e.type==='status')console.log('MODEL '+e.text);},snap:{},lang:'zh',imageRequest:{imagePath,preset:'pixel',width:256,height:256,steps:6,seed:42,strength:0.5}});
    assert.ok(result.ok,result.detail);
    const file=path.join(output,result.rel);
    const buf=fs.readFileSync(file);
    check(buf.readUInt32BE(16)===256 && buf.readUInt32BE(20)===256,'真实 Qwen 第 '+frame+' 帧输出指定 256×256 PNG');
    check(result.parameters.steps===6 && result.parameters.seed===42 && result.parameters.imagePath===path.join(output,imagePath),'真实 Qwen 第 '+frame+' 帧使用指定步数种子及参考帧');
    const marker=JSON.parse(fs.readFileSync(path.join(markerDir,'ready-vulkan.json'),'utf8'));
    const metadata=spawnSync(marker.exe,['--mode','metadata','--image',file,'--metadata-format','json'],{encoding:'utf8',windowsHide:true,timeout:15000});
    assert.equal(metadata.status,0,metadata.stderr);
    fs.writeFileSync(path.join(output,'frame-'+frame+'-metadata.json'),metadata.stdout,'utf8');
    const entries=JSON.parse(metadata.stdout).entries;
    const parameters=entries.find(function parameters(entry){return entry.data?.keyword==='parameters';}).data.text;
    const start=parameters.indexOf('SDCPP: ');
    assert.ok(start>=0,'引擎结构化参数存在');
    const actual=JSON.parse(parameters.substring(start+'SDCPP: '.length));
    check(actual.sampling.steps===6 && actual.seed===42 && actual.width===256 && actual.height===256 && actual.strength===0.5 && actual.sampling.guidance.txt_cfg===2.5 && actual.sampling.method==='euler' && actual.image_preprocess==='target=init,filter=nearest,antialias=false','真实 PNG 引擎元数据精确确认步数、尺寸、种子、强度、CFG、采样器与最近邻，第 '+frame+' 帧');
    files.push(result.rel);imagePath=result.rel;
  }
  check(!fs.readFileSync(path.join(output,files[0])).equals(fs.readFileSync(path.join(output,files[1]))),'第二帧引用第一帧生成，输出文件确有变化');
  realResults={files,input:'input.png'};
}
/** 主流程只在所有行为检查通过后写通过结论。 */
async function run(){
  await app.whenReady();
  if(process.argv.includes('--real')) await testReal();
  else {await testSettings();await testDispatch();}
  const report={ok:true,checks:passed.length,passed,realResults,output};
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify(report,null,2),'utf8');
  console.log('RESULT '+JSON.stringify(report));app.exit(0);
}
/** 失败留下真实错误与输出目录，不伪造成功记录。 */
function failed(error){console.error(error.stack||error);console.error('OUTPUT '+output);app.exit(1);}
setTimeout(function timeout(){failed(Error('本地生图专项超时'));},process.argv.includes('--real')?20*60*1000:60000);
run().catch(failed);
