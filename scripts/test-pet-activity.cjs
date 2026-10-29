// 在真实小窗中验证工作图标、真实事件、长正文分离及缩放布局。
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {app,BrowserWindow}=require('electron');
const config=require('../electron/lib/desktop-pet-config.json');
const {execFile}=require('node:child_process');
const root=path.join(__dirname,'..');
const output=path.join(root,'generated','desktop-pet-activity-check');
app.setPath('userData',path.join(require('node:os').tmpdir(),'spcode-activity-check-'+process.pid));
const results=[];
let bar,win,wc;
const errors=[];
/** 等待真实页面动画及 IPC，不以代码存在代替状态切换。 */
function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
/** 记录一个已通过的行为断言。 */
function ok(name,value){assert.ok(value,name);results.push(name);console.log('PASS '+name);}
/** 读取当前图标几何、短标签和详细气泡的真实布局。 */
function inspect(){
  const badge=document.getElementById('pet-activity');
  const text=document.getElementById('pet-activity-text');
  const icon=document.getElementById('pet-activity-path');
  const label=document.getElementById('pet-label');
  const stage=document.getElementById('pet-stage').getBoundingClientRect();
  const b=badge.getBoundingClientRect(),t=text.getBoundingClientRect(),l=label.getBoundingClientRect();
  const style=getComputedStyle(badge);
  const work=document.getElementById('pet-work-indicator'),w=work.getBoundingClientRect();
  const orbit=work.querySelector('.pet-work-orbit'),workStyle=getComputedStyle(work);
  const pet=document.getElementById('pet-canvas').getBoundingClientRect();
  const balance=document.getElementById('pet-balance').getBoundingClientRect();
  return {state:badge.dataset.state,text:text.textContent,path:icon.getAttribute('d'),iconLength:icon.getTotalLength(),
    detail:label.textContent,detailHidden:label.hidden,opacity:style.opacity,display:style.display,
    pointerEvents:style.pointerEvents,badgeBottom:b.bottom,labelTop:l.top,badgeLeft:b.left,badgeRight:b.right,
    stageLeft:stage.left,stageRight:stage.right,badgeHeight:b.height,textHeight:t.height,textScroll:text.scrollWidth,textWidth:t.width,
    workHidden:work.hidden,workState:work.dataset.state,workPath:document.getElementById('pet-work-path').getAttribute('d'),
    workLeft:w.left,workRight:w.right,workTop:w.top,workBottom:w.bottom,workWidth:w.width,petTop:pet.top,petBottom:pet.bottom,
    balanceTop:balance.top,balanceBottom:balance.bottom,stageTop:stage.top,stageBottom:stage.bottom,
    labelClamp:getComputedStyle(label).webkitLineClamp,labelLineHeight:parseFloat(getComputedStyle(label).lineHeight),
    workPointer:workStyle.pointerEvents,workRendering:workStyle.imageRendering,
    labelOpacity:getComputedStyle(label).opacity,labelHeight:l.height,labelBottom:l.bottom,balanceOpacity:getComputedStyle(document.getElementById('pet-balance')).opacity,
    statusClip:style.clipPath,
    orbitTransform:getComputedStyle(orbit).transform,orbitAnimation:getComputedStyle(orbit).animationName,
    expanded:desktopPetInspect().expanded,skin:desktopPetInspect().skin};
}
/** 将核对函数送入实际渲染进程执行。 */
async function snapshot(){return wc.executeJavaScript('('+inspect.toString()+')()');}
/** 用实际小窗入口发送一轮事件，覆盖会话和轮次过滤。 */
function event(data){bar.pushEvent('activity:test',Object.assign({turnId:'work'},data));}
/** 通过原预览控件切动作，验证全部图标，预览标签必须明确区分。 */
async function preview(state){
  await wc.executeJavaScript('document.getElementById("pet-preview").value='+JSON.stringify(state)+';document.getElementById("pet-preview").dispatchEvent(new Event("change"));');
  await wait(130);
}
/** 调整原设置接口并应用页面布局，用于核对允许范围内的缩放。 */
async function scale(value){
  await wc.executeJavaScript('document.getElementById("pet-scale").value='+JSON.stringify(String(value))+';document.getElementById("pet-scale").dispatchEvent(new Event("input"));');
  await wait(150);
}
/**
 * 查询指定屏幕点的原生顶层窗口，不移动用户的系统光标。
 * 坐标由 Electron 的 DIP 转换取得，子进程查询时主进程继续处理鼠标 IPC。
 */
function nativeAt(x,y){
  const point=require('electron').screen.dipToScreenPoint({x,y});
  const source='using System;using System.Runtime.InteropServices;public class ActivityMouse{[StructLayout(LayoutKind.Sequential)]public struct P{public int X;public int Y;}[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(P p);[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);public static long At(int x,int y){P p=new P();p.X=x;p.Y=y;return GetAncestor(WindowFromPoint(p),2).ToInt64();}}';
  const script="Add-Type -TypeDefinition '"+source+"';[ActivityMouse]::SetProcessDPIAware()|Out-Null;[ActivityMouse]::At("+point.x+","+point.y+")";
  return new Promise(function(resolve,reject){execFile('powershell.exe',['-NoProfile','-Command',script],function(error,out){if(error)reject(error);else resolve(out.trim());});});
}
/** 覆盖真实工具状态、完成原因与现有角色交互，并保存真实小窗截图。 */
async function run(){
  fs.mkdirSync(output,{recursive:true});
  const createFloatBar=require('../electron/lib/float-bar').createFloatBar;
  bar=createFloatBar({slotIndex:97,onBind:function(){bar.setBoundKey('activity:test');}});
  bar.setBoundKey('activity:test');bar.show();bar.moveToPlace('tl');
  for(const one of BrowserWindow.getAllWindows())if(bar.ownsWindow(one))win=one;
  wc=win.webContents;
  wc.on('console-message',function(ev,level,message){if(level>=3)errors.push(message);});
  for(let i=0;i<80;i++){
    await wait(100);
    if(await wc.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin)'))break;
  }
  let current=await snapshot();
  ok('实际空闲清空状态短句与图标',current.state==='idle'&&current.text===''&&current.path===''&&current.display==='none');
  ok('精简常态只显示一行余额',current.detailHidden&&current.detail===''&&current.balanceOpacity==='1');
  const initialBounds=win.getBounds();
  ok('默认窗口按配置容纳三行正文与余额且角色尺寸保持不变',initialBounds.width===Math.max(config.layout.hudMinWidth,Math.round(config.layout.petWidth*config.defaultScale))&&initialBounds.height===Math.max(Math.round(config.layout.petHeight*config.defaultScale),Math.ceil(config.layout.petSize*config.defaultScale+config.layout.hudHeight)));
  ok('图标不抢角色鼠标命中和拖动',current.pointerEvents==='none');
  ok('空闲不显示右上角工作 HUD',current.workHidden);
  // HUD 专项不执行依赖外部桌面置顶窗口的原生命中测试，完整测试仍保留该项。
  if(!process.argv.includes('--hud-only')){
  // 从当前皮肤的实际不透明像素取鼠标目标，避免旧测试固定坐标落在角色透明区。
  const target=await wc.executeJavaScript('('+function opaquePoint(){
    const c=document.getElementById('pet-canvas'),r=c.getBoundingClientRect();
    const pixels=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
    const bottom=document.getElementById('pet-label').getBoundingClientRect().bottom;
    for(let y=4;y<c.height-4;y++){
      const cy=r.top+(y+.5)*r.height/c.height;
      if(cy<bottom+8)continue;
      for(let x=4;x<c.width-4;x++){
        let solid=true;
        for(let dy=-4;dy<=4;dy++)for(let dx=-4;dx<=4;dx++)if(pixels[((y+dy)*c.width+x+dx)*4+3]<=220)solid=false;
        if(solid)return {x:r.left+(x+.5)*r.width/c.width,y:cy};
      }
    }
    throw Error('找不到详细气泡下方的角色像素');
  }.toString()+')()');
  const b=win.getBounds();
  const background=new BrowserWindow({x:b.x,y:b.y,width:b.width,height:b.height,frame:false,show:false});
  await background.loadURL('data:text/html,<body style="background:white">');
  background.setAlwaysOnTop(true,'pop-up-menu');background.showInactive();
  win.setAlwaysOnTop(true,'screen-saver');win.showInactive();win.moveTop();
  // 测试窗口不抢焦点；直接派发指针事件经过生产命中逻辑，避免 sendInputEvent 依赖前台焦点。
  await wc.executeJavaScript('document.dispatchEvent(new PointerEvent("pointermove",{bubbles:true,clientX:-1,clientY:-1}))');
  await wait(80);
  ok('透明边角仍穿透到真实底层窗口',(await nativeAt(b.x+2,b.y+2))===background.getNativeWindowHandle().readBigUInt64LE().toString());
  await wc.executeJavaScript('document.getElementById("pet-canvas").dispatchEvent(new PointerEvent("pointermove",{bubbles:true,clientX:'+Math.round(target.x)+',clientY:'+Math.round(target.y)+'}))');
  await wait(80);
  const actual=await nativeAt(Math.round(b.x+target.x),Math.round(b.y+target.y));
  console.log('NATIVE '+JSON.stringify({actual,expected:win.getNativeWindowHandle().readBigUInt64LE().toString(),target,b}));
  ok('页面输入命中实际角色像素后恢复原生窗口命中',actual===win.getNativeWindowHandle().readBigUInt64LE().toString());
  background.destroy();
  }else console.log('SKIP 原生桌面命中；本次仅运行 HUD 专项');
  const paths=new Set();
  for(const state of config.states){
    await preview(state);
    current=await snapshot();
    ok('预览图标 '+state,current.state===state&&current.text==='预览 · '+config.labels[state]&&current.iconLength>5);
    const active=['thinking','speaking','reading','searching','writing','running','testing','desktop','generating'].includes(state);
    ok('工作 HUD 显隐与状态一致 '+state,current.workHidden===!active&&current.workState===state&&current.workPath===current.path);
    paths.add(current.path);
  }
  ok('十六种状态各有独立图标',paths.size===config.states.length);
  await preview('');
  event({kind:'turn-start'});
  const activities=[
    {name:'read_file',state:'reading'},
    {name:'map_lookup',state:'searching'},
    {name:'edit_file',state:'writing'},
    {name:'run_command',state:'running'},
    {name:'run_command',activity:'testing',state:'testing'},
    {name:'screen_read',state:'desktop'},
    {name:'generate_media',state:'generating'}
  ];
  for(let i=0;i<activities.length;i++){
    const one=activities[i];
    event({kind:'tool',callId:'call-'+i,name:one.name,activity:one.activity,status:'running',text:one.name});
    await wait(550);
    current=await snapshot();
    ok('真实工具驱动动作且不显示工具文本 '+one.state,current.state===one.state&&current.text===config.labels[one.state]&&current.detail===config.labels[one.state]);
    ok('真实工具点亮右上角工作 HUD '+one.state,!current.workHidden&&current.workState===one.state);
    event({kind:'tool',callId:'call-'+i,name:one.name,status:'done'});
  }
  await wait(550);
  event({kind:'reason',text:'这是完整推理正文，工作类别仍应单独可见。'.repeat(40)});
  await wait(550);
  current=await snapshot();
  ok('长推理保留全文且不覆盖思考短标签',current.text===config.labels.thinking&&current.detail.length>600);
  ok('工作时正文与下方余额同时可见，不挤占角色空间',current.labelOpacity==='1'&&current.balanceOpacity==='1'&&current.labelBottom<=current.petTop&&current.balanceTop-current.petBottom>=config.layout.infoGap-0.1&&current.balanceBottom<=current.stageBottom);
  const frames=[];
  for(const value of [config.layout.minScale,config.defaultScale,1,config.layout.maxScale]){
    await scale(value);
    current=await snapshot();
    ok('缩放 '+value+' 精简信息槽与角色不重叠',
      current.labelBottom<=current.petTop&&current.balanceTop-current.petBottom>=config.layout.infoGap-0.1&&current.balanceBottom<=current.stageBottom&&current.labelClamp===String(config.layout.dialogueLines)&&Math.abs(current.labelHeight-current.labelLineHeight*config.layout.dialogueLines-10)<1);
    ok('缩放 '+value+' 工作 HUD 位于角色右上且不遮挡信息区',
      !current.workHidden&&current.workLeft>(current.stageLeft+current.stageRight)/2&&current.workRight<=current.stageRight&&
      current.workTop>=current.petTop&&current.workBottom<=current.petBottom&&current.workWidth>=38);
    frames.push({scale:value,...current});
  }
  await scale(config.defaultScale);
  event({kind:'tool',callId:'capture',name:'edit_file',status:'running',text:'electron/lib/desktop-pet.js'});
  await wait(550);
  current=await snapshot();
  ok('工作 HUD 平滑矢量缩放且鼠标穿透',current.workRendering==='auto'&&current.workPointer==='none');
  // 强制浏览器真实 :hover 状态，核对悬停及移开均同时显示正文和余额，不抢用户鼠标焦点。
  wc.debugger.attach('1.3');
  await wc.debugger.sendCommand('DOM.enable');
  await wc.debugger.sendCommand('CSS.enable');
  const dom=await wc.debugger.sendCommand('DOM.getDocument');
  const stageNode=await wc.debugger.sendCommand('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#pet-stage'});
  await wc.debugger.sendCommand('CSS.forcePseudoState',{nodeId:stageNode.nodeId,forcedPseudoClasses:['hover']});
  await wait(200);
  current=await snapshot();
  ok('悬停时正文与下方余额同时显示',current.labelOpacity==='1'&&current.balanceOpacity==='1'&&current.labelBottom<=current.petTop&&current.petBottom<current.balanceTop);
  fs.writeFileSync(path.join(output,'hover.png'),(await wc.capturePage()).toPNG());
  await wc.debugger.sendCommand('CSS.forcePseudoState',{nodeId:stageNode.nodeId,forcedPseudoClasses:[]});
  await wait(200);
  current=await snapshot();
  ok('移开后正文与下方余额仍同时显示',current.labelOpacity==='1'&&current.balanceOpacity==='1'&&current.labelBottom<=current.petTop&&current.petBottom<current.balanceTop);
  wc.debugger.detach();
  const firstTransform=current.orbitTransform;
  await wait(180);
  current=await snapshot();
  ok('工作光环确实随时间旋转',current.orbitAnimation==='pet-work-orbit'&&current.orbitTransform!==firstTransform);
  fs.writeFileSync(path.join(output,'writing.png'),(await wc.capturePage()).toPNG());
  // 截取实际渲染的 HUD，不以 CSS 声明代替像素输出。
  fs.writeFileSync(path.join(output,'work-icon.png'),(await wc.capturePage({x:Math.floor(current.workLeft),y:Math.floor(current.workTop),width:Math.ceil(current.workWidth),height:Math.ceil(current.workWidth)})).toPNG());
  await wc.executeJavaScript('document.getElementById("pet-reduced").checked=true;document.getElementById("pet-reduced").dispatchEvent(new Event("change"))');
  await wait(180);
  current=await snapshot();
  ok('减少动态效果停转但保留工作标识',!current.workHidden&&current.orbitAnimation==='none');
  await wc.executeJavaScript('document.getElementById("pet-reduced").checked=false;document.getElementById("pet-reduced").dispatchEvent(new Event("change"))');
  await wait(180);
  ok('恢复动态效果重新启动光环',(await snapshot()).orbitAnimation==='pet-work-orbit');
  bar.pushEvent('another:tab',{kind:'tool',turnId:'other',callId:'other',name:'read_file',status:'running'});
  await wait(100);
  ok('其他会话不改变工作图标',(await snapshot()).state==='writing');
  event({kind:'ask',question:'请确认测试操作'});
  await wait(220);
  current=await snapshot();
  ok('等待回答同时显示正文与下方余额并关闭工作 HUD',current.state==='waiting'&&current.workHidden&&current.labelOpacity==='1'&&current.balanceOpacity==='1'&&current.labelBottom<=current.petTop&&current.petBottom<current.balanceTop);
  event({kind:'answered'});
  await wait(120);
  ok('回答后恢复仍在执行的工作',(await snapshot()).state==='writing');
  event({kind:'tool',callId:'capture',name:'edit_file',status:'done'});
  await wait(550);
  event({kind:'ai-delta',text:'完成核对'});
  await wait(550);
  ok('回复时显示对话图标',(await snapshot()).state==='speaking');
  event({kind:'turn-end',outcome:'success'});
  await wait(120);
  current=await snapshot();
  ok('完成时显示完成图标并关闭工作 HUD',current.state==='success'&&current.workHidden);
  event({kind:'turn-start'});
  event({kind:'turn-end',outcome:'error'});
  await wait(120);
  current=await snapshot();
  ok('失败时显示问题图标并关闭工作 HUD',current.state==='error'&&current.workHidden);
  ok('图标加载与绘制没有渲染错误',errors.length===0);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:results,skipped:process.argv.includes('--hud-only')?['原生桌面命中：外部置顶窗口与系统光标独立影响，未计为通过']:[],initialBounds,frames,errors},null,2),'utf8');
  console.log('RESULT '+results.length+' 项通过；截图 '+path.join(output,'writing.png'));
  bar.destroy();app.quit();
}
/** 失败保留错误与实际画面，非零退出。 */
async function failed(error){
  console.error(error.stack||error);
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'failure.txt'),String(error.stack||error),'utf8');
  if(wc&&!wc.isDestroyed())fs.writeFileSync(path.join(output,'failure.png'),(await wc.capturePage()).toPNG());
  app.exit(1);
}
app.whenReady().then(run).catch(failed);
