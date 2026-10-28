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
  return {state:badge.dataset.state,text:text.textContent,path:icon.getAttribute('d'),iconLength:icon.getTotalLength(),
    detail:label.textContent,detailHidden:label.hidden,opacity:style.opacity,display:style.display,
    pointerEvents:style.pointerEvents,badgeBottom:b.bottom,labelTop:l.top,badgeLeft:b.left,badgeRight:b.right,
    stageLeft:stage.left,stageRight:stage.right,badgeHeight:b.height,textHeight:t.height,textScroll:text.scrollWidth,textWidth:t.width,
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
    if(await wc.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin&&document.getElementById("pet-activity-text").textContent)'))break;
  }
  let current=await snapshot();
  ok('空闲时图标与文字常驻，无需悬停',current.state==='idle'&&current.text===config.labels.idle&&current.opacity==='1'&&current.display==='flex');
  ok('图标不抢角色鼠标命中和拖动',current.pointerEvents==='none');
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
  // 当前桌面存在并行鼠标操作；用渲染进程输入核对命中逻辑，不与用户争用系统光标。
  wc.sendInputEvent({type:'mouseMove',x:-1,y:-1});
  await wc.executeJavaScript('desktopPet.call("hit",false)');
  ok('透明边角仍穿透到真实底层窗口',(await nativeAt(b.x+2,b.y+2))===background.getNativeWindowHandle().readBigUInt64LE().toString());
  wc.sendInputEvent({type:'mouseMove',x:Math.round(target.x),y:Math.round(target.y)});
  await wait(80);
  const actual=await nativeAt(Math.round(b.x+target.x),Math.round(b.y+target.y));
  console.log('NATIVE '+JSON.stringify({actual,expected:win.getNativeWindowHandle().readBigUInt64LE().toString(),target,b}));
  ok('页面输入命中实际角色像素后恢复原生窗口命中',actual===win.getNativeWindowHandle().readBigUInt64LE().toString());
  background.destroy();
  const paths=new Set();
  for(const state of config.states){
    await preview(state);
    current=await snapshot();
    ok('预览图标 '+state,current.state===state&&current.text==='预览 · '+config.labels[state]&&current.iconLength>5);
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
    ok('真实工具驱动 '+one.state,current.state===one.state&&current.text===config.labels[one.state]&&current.detail===one.name);
    event({kind:'tool',callId:'call-'+i,name:one.name,status:'done'});
  }
  await wait(550);
  event({kind:'reason',text:'这是完整推理正文，工作类别仍应单独可见。'.repeat(40)});
  await wait(550);
  current=await snapshot();
  ok('长推理保留全文且不覆盖思考短标签',current.text===config.labels.thinking&&current.detail.length>600);
  ok('详细气泡位于状态图标下方',current.labelTop>=current.badgeBottom+5);
  const frames=[];
  for(const value of [config.layout.minScale,config.defaultScale,1,config.layout.maxScale]){
    await scale(value);
    current=await snapshot();
    ok('缩放 '+value+' 图标与文字不越界且气泡不重叠',
      current.badgeLeft>=current.stageLeft&&current.badgeRight<=current.stageRight&&current.labelTop>=current.badgeBottom+5&&current.textScroll<=Math.ceil(current.textWidth));
    frames.push({scale:value,...current});
  }
  await scale(config.defaultScale);
  event({kind:'tool',callId:'capture',name:'edit_file',status:'running',text:'electron/lib/desktop-pet.js'});
  await wait(550);
  fs.writeFileSync(path.join(output,'writing.png'),(await wc.capturePage()).toPNG());
  bar.pushEvent('another:tab',{kind:'tool',turnId:'other',callId:'other',name:'read_file',status:'running'});
  await wait(100);
  ok('其他会话不改变工作图标',(await snapshot()).state==='writing');
  event({kind:'ask',question:'请确认测试操作'});
  await wait(120);
  ok('等待回答优先显示独立图标',(await snapshot()).state==='waiting');
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
  ok('完成时显示完成图标',(await snapshot()).state==='success');
  event({kind:'turn-start'});
  event({kind:'turn-end',outcome:'error'});
  await wait(120);
  ok('失败时显示问题图标',(await snapshot()).state==='error');
  ok('图标加载与绘制没有渲染错误',errors.length===0);
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed:results,frames,errors},null,2),'utf8');
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
