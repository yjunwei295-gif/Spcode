/** 在独立 Electron 进程验收真实 Agent、作品窗口、像素导出、视频解码及完整聊天页面。 */
const {app,BrowserWindow,ipcMain,dialog,nativeImage}=require('electron');
const fs=require('fs');
const path=require('path');
const assert=require('node:assert/strict');
const Module=require('module');
const {spawnSync}=require('child_process');
const studio=require('../electron/lib/artifact-studio');
const windows=require('../electron/lib/artifact-window');
const root=path.resolve(__dirname,'..');
const errors=[];
let checks=0;
let workspace;
function keepAlive(event){event.preventDefault();}
app.on('window-all-closed',keepAlive);
process.on('unhandledRejection',function unhandled(error){errors.push(String(error.stack||error));});
/** 断言和逐项日志共同记录行为，不能仅凭退出码宣称通过。 */
function check(value,label){assert.ok(value,label);checks++;console.log('PASS '+label);}
function pause(ms){return new Promise(function wait(resolve){setTimeout(resolve,ms);});}
/** 等待真实 UI/文件事件，超时明确失败。 */
async function until(predicate,label){for(let i=0;i<150;i++){if(await predicate())return;await pause(20);}throw new Error('等待超时：'+label);}
/** 仅导出真实 Agent 内部入口，不替换其作品、快照或工具实现。 */
function agentApi(){const file=path.join(root,'electron/lib/agent.js');const loaded=new Module(file,module);loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));loaded._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.artifactTest={execTool,toolsFor,HAND_OFF_TOOLS,MUTATE_FILE_TOOLS};',file);return loaded.exports;}
/** 用可计算颜色检查时间采样，不依赖截图观感猜测帧是否正确。 */
function animation(){return '<!doctype html><meta charset="utf-8"><style>html,body{margin:0;overflow:hidden}button{position:fixed;right:8px;top:8px}</style><canvas id="canvas"></canvas><button id="interactive">点我</button><script>window.clicks=0;document.getElementById("interactive").onclick=function clicked(){window.clicks++;};window.renderFrame=function renderFrame(t,f,info){const c=document.getElementById("canvas");c.width=info.width;c.height=info.height;const x=c.getContext("2d");x.fillStyle="rgb("+(10+Math.floor(t*50))+",20,30)";x.fillRect(0,0,c.width,c.height);x.fillStyle="white";x.font="20px sans-serif";x.fillText("代码作品验收",20,80);};</script>';}
function pixel(png,x,y){const img=nativeImage.createFromBuffer(png);const size=img.getSize();const b=img.toBitmap();return {size,r:b[(y*size.width+x)*4+2],a:b[(y*size.width+x)*4+3]};}
/** 从已有全页性能测试复用真实界面初始化夹具，作品 IPC 使用本轮实际主进程实现。 */
function fullSetup(){const text=fs.readFileSync(path.join(root,'scripts/test-ui-performance.cjs'),'utf8');const start=text.indexOf('function fullPageSetup() {');const end=text.indexOf('\n/**',start);return text.slice(start,end);}

async function main(){
  await app.whenReady();
  const deadline=setTimeout(function timeout(){console.error('FAIL 作品验收超时');app.exit(1);},55000);
  fs.mkdirSync(path.join(root,'generated'),{recursive:true});workspace=fs.mkdtempSync(path.join(root,'generated','artifact-test-'));
  fs.writeFileSync(path.join(workspace,'scene.html'),animation(),'utf8');
  fs.writeFileSync(path.join(workspace,'drawing.svg'),'<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect x="40" y="40" width="80" height="80" fill="red"/></svg>','utf8');
  const agent=agentApi();const api=agent.artifactTest;
  for(const name of ['present_artifact','export_artifact']){
    check(agent.toolsSpec().some(function has(t){return t.function.name===name;})&&api.toolsFor('worker').some(function has(t){return t.function.name===name;}),'普通/直通共享工具定义且实现端可用：'+name);
    check(api.HAND_OFF_TOOLS.has(name)&&api.MUTATE_FILE_TOOLS.has(name),'作品写入遵守既有授权/只读门槛：'+name);
    const call=require('../electron/lib/tool-xml').parseXmlToolCalls(JSON.stringify({name,arguments:{sourcePath:'scene.html'}}));
    check(call[0].function.name===name,'文本工具调用识别：'+name);
  }
  const snap={};const events=[];function event(value){events.push(value);}
  await api.execTool(workspace,snap,'present_artifact',{sourcePath:'scene.html',title:'代码动画验收',width:320,height:180,fps:12,duration:2},event,[],undefined,'zh');
  const item=events.find(function artifact(e){return e.type==='artifact';}).artifact;
  check(!!item.manifest&&snap.createdFiles.has(item.manifest),'真实 Agent 分发登记作品、发卡片事件并追踪清单');
  const updated=await studio.present({workspace,args:{...item,title:'动画更新'}});
  check(updated.id===item.id&&(await studio.list(workspace)).length===1,'修改同一源稿更新同一作品，不重复建卡');
  await api.execTool(workspace,snap,'export_artifact',{manifest:item.manifest,format:'png',time:1},event,[],undefined,'zh');
  // 工具完成后还会发送动作状态；从真实导出事件取结果，不把末尾状态当成作品。
  const exported=events.findLast(function exportedArtifact(value){return value.type==='artifact'&&value.exported;}).exported;
  const px=pixel(fs.readFileSync(path.join(workspace,exported.file)),10,10);
  check(px.size.width===320&&px.size.height===180&&px.r===60,'PNG 按目标尺寸采样到准确时间，未采到旧帧');
  check(snap.createdFiles.has(exported.file),'导出图片也登记 Agent 快照');
  const svg=await studio.present({workspace,args:{sourcePath:'drawing.svg',title:'透明矢量图',width:320,height:180}});
  const svgPng=await studio.exportArtifact({workspace,args:{manifest:svg.manifest,format:'png'}});
  const png=fs.readFileSync(path.join(workspace,svgPng.file));
  check(pixel(png,5,5).a===0&&pixel(png,60,60).r===255,'SVG 导出 PNG 保留透明背景和矢量画面');
  const svgSource=await studio.exportArtifact({workspace,args:{manifest:svg.manifest,format:'svg'}});
  check(fs.readFileSync(path.join(workspace,svgSource.file)).equals(fs.readFileSync(path.join(workspace,'drawing.svg'))),'下载 SVG 源文件保持原文');
  const mp4=await studio.exportArtifact({workspace,args:{manifest:item.manifest,format:'mp4'}});
  const probe=spawnSync('ffprobe',['-v','error','-count_frames','-show_streams','-of','json',path.join(workspace,mp4.file)],{encoding:'utf8',windowsHide:true});
  assert.equal(probe.status,0,probe.stderr);const stream=JSON.parse(probe.stdout).streams[0];
  check(stream.codec_name==='h264'&&stream.width===320&&stream.height===180&&Number(stream.nb_read_frames)===24,'作品 MP4 导出复用真实渲染器，视频可解码且帧数正确');
  await assert.rejects(studio.present({workspace,args:{sourcePath:'scene.html',title:'缺时长',width:320,height:180,fps:24}}),/同时提供/);
  await assert.rejects(studio.exportArtifact({workspace,args:{manifest:svg.manifest,format:'mp4'}}),/静态/);
  await assert.rejects(studio.read(workspace,'scene.html'),/不是作品清单/);
  check(true,'缺时序、静态转视频、伪造清单明确失败');
  windows.registerIpc({ipcMain,getWorkspace:function ws(){return workspace;},getOwner:function owner(e){return BrowserWindow.fromWebContents(e.sender);}});
  const owner=new BrowserWindow({show:false});
  const ctx=await windows.open({workspace,manifest:item.manifest,owner,theme:'dark'});
  await until(function toolbar(){return ctx.win.webContents.executeJavaScript('!!document.getElementById("art-title").textContent.includes("动画更新")');},'工具栏初始化');
  check(await ctx.view.webContents.executeJavaScript('typeof require==="undefined"&&typeof window.simple==="undefined"&&typeof window.artifactStudio==="undefined"'),'生成页面隔离 Node 与宿主桥接');
  await ctx.view.webContents.executeJavaScript('document.getElementById("interactive").click();true');
  check(await ctx.view.webContents.executeJavaScript('window.clicks===1'),'真实网页交互可用');
  await ctx.win.webContents.executeJavaScript('document.getElementById("art-seek").value="1";document.getElementById("art-seek").dispatchEvent(new Event("change",{bubbles:true}));true');
  await until(function sampled(){return ctx.view.webContents.executeJavaScript('document.getElementById("canvas").getContext("2d").getImageData(10,10,1,1).data[0]===60');},'时间轴按钮采样');
  check(await ctx.view.webContents.executeJavaScript('document.getElementById("canvas").getContext("2d").getImageData(10,10,1,1).data[0]===60'),'真实工具栏 IPC 拖动时间后画面正确');
  await ctx.win.webContents.executeJavaScript('document.getElementById("art-play").click();true');
  await pause(300);
  await ctx.win.webContents.executeJavaScript('document.getElementById("art-play").click();true');
  check(await ctx.win.webContents.executeJavaScript('Number(document.getElementById("art-seek").value)>0'),'播放/暂停真实推进时间轴');
  await ctx.view.webContents.executeJavaScript('window.renderFrame=function brokenFrame(){throw Error("FRAME_TEST_FAILURE")};true');
  await assert.rejects(ctx.win.webContents.executeJavaScript('artifactStudio.seek(1)'));
  await ctx.win.webContents.executeJavaScript('artifactStudio.refresh()');
  check(await ctx.view.webContents.executeJavaScript('document.getElementById("canvas").getContext("2d").getImageData(10,10,1,1).data[0]===10'),'帧错误明确上报后刷新正确源稿，首帧像素恢复准确');
  const same=await windows.open({workspace,manifest:item.manifest,owner,theme:'dark'});
  check(same===ctx&&windows.contexts.size===1,'重开同一作品复用窗口');
  fs.writeFileSync(path.join(workspace,'scene.html'),animation().replace('10+Math.floor(t*50)','80+Math.floor(t*50)'),'utf8');
  await until(function changed(){return ctx.view.webContents.executeJavaScript('document.getElementById("canvas").getContext("2d").getImageData(10,10,1,1).data[0]===80');},'源稿保存刷新');
  check(true,'编辑同一源文件后预览自动刷新');
  const originalDialog=dialog.showSaveDialog;
  dialog.showSaveDialog=async function cancelled(){return {canceled:true};};
  const cancelled=await ctx.win.webContents.executeJavaScript('artifactStudio.save("png",0)');
  check(cancelled.cancelled&&!ctx.exporting,'取消下载对话框不启动渲染');
  const destination=path.join(workspace,'downloaded.png');
  dialog.showSaveDialog=async function chosen(){return {canceled:false,filePath:destination};};
  await ctx.view.webContents.executeJavaScript('const x=document.getElementById("canvas").getContext("2d");x.fillStyle="rgb(200,20,30)";x.fillRect(0,0,20,20);true');
  await ctx.win.webContents.executeJavaScript('document.getElementById("art-png").click();true');
  await until(function downloaded(){return fs.existsSync(destination);},'下载 PNG 按钮');
  check(pixel(fs.readFileSync(destination),10,10).r===200,'下载路径保留用户当前网页交互画面，未重置为源稿首帧');
  dialog.showSaveDialog=originalDialog;
  ctx.win.close();owner.destroy();await pause(50);
  check(windows.contexts.size===0,'关闭作品窗口释放子视图与监听');
  const svgWindow=await windows.open({workspace,manifest:svg.manifest,theme:'light'});
  const transparentDestination=path.join(workspace,'transparent-download.png');
  dialog.showSaveDialog=async function svgTarget(){return {canceled:false,filePath:transparentDestination};};
  await svgWindow.win.webContents.executeJavaScript('artifactStudio.save("png",0)');
  dialog.showSaveDialog=originalDialog;
  check(pixel(fs.readFileSync(transparentDestination),5,5).a===0,'实际作品窗口下载 SVG 画面也保留透明背景');
  svgWindow.win.close();

  // 完整聊天 HTML/CSS/ES 模块：工具事件到卡片、磁盘历史、作品库与真正的独立预览窗口。
  const preload=path.join(workspace,'test-preload.cjs');
  fs.writeFileSync(preload,'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("testBridge",{list:function(){return ipcRenderer.invoke("artifact:list")},open:function(p){return ipcRenderer.invoke("artifact:open",p)},save:function(p){return ipcRenderer.invoke("fixture:save",p)}});','utf8');
  const saved=path.join(workspace,'history.json');
  ipcMain.handle('fixture:save',async function save(_e,data){await fs.promises.writeFile(saved,JSON.stringify(data),'utf8');return true;});
  const chat=new BrowserWindow({show:false,width:1280,height:840,webPreferences:{preload,backgroundThrottling:false}});
  await chat.loadURL('about:blank');chat.webContents.debugger.attach('1.3');
  await chat.webContents.debugger.sendCommand('Page.enable');
  const setup=fullSetup()+'\nfullPageSetup();window.simple.listArtifacts=function(){return testBridge.list()};window.simple.openArtifact=function(p){window.fixtureOpenPromise=testBridge.open(p);return window.fixtureOpenPromise};window.simple.saveSession=function(p){return testBridge.save(p)};';
  await chat.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:setup});
  await chat.loadFile(path.join(root,'renderer/index.html'));
  chat.showInactive();
  await pause(200);
  console.log('UI_DIAGNOSTIC '+JSON.stringify(await chat.webContents.executeJavaScript('({errors:window.fullPageRecord?.errors,build:window.__APP_BUILD})')));
  await until(function ready(){return chat.webContents.executeJavaScript('if(fullPageRecord.errors.length)throw Error(JSON.stringify(fullPageRecord.errors));!!document.querySelector("#tabs .tab")');},'完整聊天加载');
  await chat.webContents.executeJavaScript('document.getElementById("input").value="用代码创作";document.getElementById("btn-send").click();true');
  await until(function sent(){return chat.webContents.executeJavaScript('!!fullPageRecord.turnId');},'真实发送入口');
  await chat.webContents.executeJavaScript('emitTestChat({type:"artifact",turnId:fullPageRecord.turnId,artifact:'+JSON.stringify(item)+'});true');
  check(await chat.webContents.executeJavaScript('!!document.querySelector(".msg.assistant [data-open-artifact]")'),'真实工具事件在完整聊天页面出现作品卡片');
  await chat.webContents.executeJavaScript('emitTestChat({type:"done",turnId:fullPageRecord.turnId,text:"作品已完成"});fullPageRecord.resolveTurn(true);true');
  await until(function persisted(){return fs.existsSync(saved)&&JSON.parse(fs.readFileSync(saved,'utf8')).messages.some(function m(value){return value.artifacts&&value.artifacts.length;});},'作品历史保存');
  check(true,'真实会话保存包含作品清单入口');
  await chat.webContents.executeJavaScript('document.querySelector(".msg.assistant [data-open-artifact]").click();true');
  await until(function opened(){return windows.contexts.size===1;},'卡片重开作品');
  await chat.webContents.executeJavaScript('window.fixtureOpenPromise');
  check(true,'完整聊天卡片通过实际 preload/IPC 重开作品');
  await chat.webContents.executeJavaScript('document.getElementById("btn-artifacts").click();true');
  await until(function library(){return chat.webContents.executeJavaScript('document.querySelectorAll("#artifact-library .artifact-card").length===2');},'磁盘作品库');
  check(true,'作品库从磁盘清单恢复静态和动画作品');
  const uiErrors=await chat.webContents.executeJavaScript('fullPageRecord.errors');check(uiErrors.length===0,'完整界面无脚本异常');
  for(const preview of windows.contexts.values())preview.win.close();chat.destroy();await pause(100);
  check(errors.length===0,'全部专项无未处理异步拒绝');
  const result={ok:true,checks,workspace,mp4:mp4.file,image:exported.file};fs.writeFileSync(path.join(workspace,'verification.json'),JSON.stringify(result,null,2),'utf8');console.log('RESULT '+JSON.stringify(result));clearTimeout(deadline);app.exit(0);
}
main().catch(function failed(error){console.error(error.stack);app.exit(1);});
