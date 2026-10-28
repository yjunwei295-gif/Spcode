// 运行真实小窗、preload 和系统鼠标，核对同窗变形、像素穿透与原聊天回调。
'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const {execFile}=require('child_process');
const {app,BrowserWindow}=require('electron');
const root=path.join(__dirname,'..');
app.setPath('userData',path.join(require('os').tmpdir(),'spcode-pet-check-'+process.pid));
const results=[];
/** 等待 IPC 与绘制完成，不把语法检查当作交互验收。 */
function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
/** 驱动真实系统鼠标，主进程保持响应以处理穿透切换。 */
function click(x,y){
 const script='Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class PetMouse{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint x,uint y,uint d,UIntPtr e);}\';[PetMouse]::SetCursorPos('+x+','+y+')|Out-Null;Start-Sleep -Milliseconds 350;[PetMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero);[PetMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero)';
 return new Promise(function(resolve,reject){execFile('powershell.exe',['-NoProfile','-Command',script],function(error){if(error)reject(error);else resolve();});});
}
/** 用真实鼠标移入角色，核对透明窗口转发的原生悬停事件。 */
function hover(x,y){
 const point=require('electron').screen.dipToScreenPoint({x,y});
 const script='Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class PetHover{[DllImport("user32.dll")]public static extern bool SetProcessDPIAware();[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);}\';[PetHover]::SetProcessDPIAware()|Out-Null;[PetHover]::SetCursorPos('+point.x+','+point.y+')|Out-Null;Start-Sleep -Milliseconds 400';
 return new Promise(function(resolve,reject){execFile('powershell.exe',['-NoProfile','-Command',script],function(error){if(error)reject(error);else resolve();});});
}
/** 查询 Windows 在指定位置命中的顶层窗口，不移动用户鼠标。 */
function nativeHit(x,y) {
 const point=require('electron').screen.dipToScreenPoint({x,y});x=point.x;y=point.y;
 const source='using System;using System.Runtime.InteropServices;public class PetHit{[StructLayout(LayoutKind.Sequential)]public struct P{public int X;public int Y;}[DllImport("user32.dll")]public static extern IntPtr WindowFromPoint(P p);[DllImport("user32.dll")]public static extern IntPtr GetAncestor(IntPtr h,uint f);public static long At(int x,int y){P p=new P();p.X=x;p.Y=y;return GetAncestor(WindowFromPoint(p),2).ToInt64();}}';
 const script="Add-Type -TypeDefinition '"+source+"';[PetHit]::At("+x+","+y+")";
 return new Promise(function(resolve,reject){execFile('powershell.exe',['-NoProfile','-Command',script],function(error,out){if(error)reject(error);else resolve(out.trim());});});
}
/** 每项断言记录到交付核对文件。 */
function ok(name,value){assert.ok(value,name);results.push(name);console.log('PASS '+name);}
/** 完整覆盖真实页面的工作动作、换肤、问答和同一窗口收放。 */
async function run(){
 const {createFloatBar}=require('../electron/lib/float-bar');
 const background=new BrowserWindow({x:0,y:0,width:800,height:1040,show:true,webPreferences:{contextIsolation:true}});
 await background.loadURL('data:text/html,<body style="margin:0;background:%23e9f2ed"><button style="width:100vw;height:100vh" onclick="window.clicks=(window.clicks||0)+1">桌宠透明区点击核对</button>');
 let sent=null,answered=null,stopped=null,bar;
 bar=createFloatBar({slotIndex:98,onBind:function(){bar.setBoundKey('pet-test:tab');},onSend:function(key,text,atts){sent={key,text,atts};},onAnswer:function(data){answered=data;},onAbort:function(data){stopped=data;}});
 bar.setBoundKey('pet-test:tab');bar.show();bar.moveToPlace('bl');
 const win=BrowserWindow.getAllWindows().find(function(one){return bar.ownsWindow(one);});
 const wc=win.webContents;
 win.setTitle('SpCode 桌宠功能验收');
 for(let i=0;i<40;i++){await wait(100);if(await wc.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin)'))break;}
 const fresh=await wc.executeJavaScript('desktopPetInspect()');
 ok('首次启动使用小尺寸几何猫娘',fresh.skin==='cyber-neko'&&fresh.scale===0.6);
 await wc.executeJavaScript('document.getElementById("pet-scale").value="0.5";document.getElementById("pet-scale").dispatchEvent(new Event("input"))');await wait(100);
 ok('滑条实时缩放到50%',(await wc.executeJavaScript('desktopPetInspect().scale'))===0.5);
 // 从当前帧寻找实际不透明像素，避免人形双腿间的透明空隙被误当作滚轮命中。
  await wc.executeJavaScript('(function(){const c=document.getElementById("pet-canvas"),r=c.getBoundingClientRect(),p=c.getContext("2d").getImageData(0,0,c.width,c.height).data;let hit=-1;for(let y=Math.floor(c.height*.2);y<Math.floor(c.height*.6)&&hit<0;y++){for(let x=Math.floor(c.width*.35);x<Math.floor(c.width*.65);x++){if(p[(y*c.width+x)*4+3]>200&&p[(y*c.width+x-2)*4+3]>200&&p[(y*c.width+x+2)*4+3]>200&&p[((y-2)*c.width+x)*4+3]>200&&p[((y+2)*c.width+x)*4+3]>200){hit=y*c.width+x;break;}}}if(hit<0)throw Error("角色上半身没有不透明像素");c.dispatchEvent(new WheelEvent("wheel",{bubbles:true,cancelable:true,ctrlKey:true,deltaY:-100,clientX:r.left+(hit%c.width+.5)*r.width/c.width,clientY:r.top+(Math.floor(hit/c.width)+.5)*r.height/c.height}));})()');await wait(100);
 ok('Ctrl滚轮随时缩放',(await wc.executeJavaScript('desktopPetInspect().scale'))===0.55);
 await wc.executeJavaScript('document.getElementById("pet-scale").value="1";document.getElementById("pet-scale").dispatchEvent(new Event("input"))');await wait(100);
 await wc.executeJavaScript('document.getElementById("pet-skin").value="spcode";document.getElementById("pet-skin").dispatchEvent(new Event("change"))');await wait(150);
 const initial=await wc.executeJavaScript('desktopPetInspect()');
 ok('初始化默认皮肤且无资源错误',initial.skin==='spcode'&&!initial.errors);
 ok('初始只显示宠物且仍是同一窗口',initial.expanded===false&&BrowserWindow.getAllWindows().length===2);
 const b=win.getBounds();background.setBounds({x:b.x-20,y:Math.max(0,b.y-20),width:400,height:Math.min(500,1080-b.y+20)});background.setAlwaysOnTop(true,'pop-up-menu');background.show();win.setAlwaysOnTop(true,'screen-saver');win.showInactive();win.moveTop();
 await wc.executeJavaScript('desktopPet.call("hit",false)');
 const backgroundHandle=background.getNativeWindowHandle().readBigUInt64LE().toString();
 const hitHandle=await nativeHit(b.x+4,b.y+90);console.log('HIT '+JSON.stringify({actual:hitHandle,expected:backgroundHandle,pet:win.getNativeWindowHandle().readBigUInt64LE().toString(),b,back:background.getBounds()}));
 ok('透明模式Windows命中底层窗口',hitHandle===backgroundHandle);
 // 先验证原生悬停能从穿透状态恢复命中，不能用派发页面事件掩盖转发链路缺失。
 const petHandle=win.getNativeWindowHandle().readBigUInt64LE().toString();
 await hover(b.x+120,b.y+181);
 ok('真实鼠标移入角色能恢复Windows命中',(await nativeHit(b.x+120,b.y+181))===petHandle);
 // 再覆盖页面像素检测入口，保留原先对不透明帧的检查。
 await wc.executeJavaScript('document.getElementById("pet-canvas").dispatchEvent(new MouseEvent("pointermove",{bubbles:true,clientX:120,clientY:181}))');await wait(80);
 ok('不透明角色Windows命中宠物窗口',(await nativeHit(b.x+120,b.y+181))===petHandle);
 wc.sendInputEvent({type:'mouseDown',x:120,y:181,button:'left',clickCount:1});
 wc.sendInputEvent({type:'mouseUp',x:120,y:181,button:'left',clickCount:1});await wait(150);
 const anchored=await wc.executeJavaScript('desktopPet.call("init")');
 ok('屏幕左边缘展开保持角色脚底不漂移',Math.abs(anchored.settings.footX-(b.x+b.width/2))<=1&&Math.abs(anchored.settings.footY-(b.y+b.height))<=1);
 ok('角色点击展开原聊天',(await wc.executeJavaScript('desktopPetInspect().expanded'))===true);
 ok('角色点击没有误触底层',(await background.webContents.executeJavaScript('window.clicks||0'))===0);
 await wc.executeJavaScript('document.getElementById("input").value="换皮肤保留的输入"');
 await wc.executeJavaScript('document.getElementById("pet-skin").value="cat";document.getElementById("pet-skin").dispatchEvent(new Event("change"))');
 await wait(200);
 ok('换肤生效且输入内容保留',(await wc.executeJavaScript('desktopPetInspect().skin==="cat"&&document.getElementById("input").value==="换皮肤保留的输入"')));
 bar.pushEvent('pet-test:tab',{kind:'turn-start',turnId:'turn-1'});
 bar.pushEvent('pet-test:tab',{kind:'tool',turnId:'turn-1',callId:'read-1',name:'read_file',status:'running',text:'读文件'});
 await wait(650);ok('真实IPC工具状态驱动读文件动作',(await wc.executeJavaScript('desktopPetInspect().state'))==='reading');
 bar.pushEvent('another:tab',{kind:'tool',turnId:'other',callId:'write',name:'write_file',status:'running'});
 await wait(100);ok('其他会话事件不会串到当前宠物',(await wc.executeJavaScript('desktopPetInspect().state'))==='reading');
 bar.pushAsk({sessionKey:'pet-test:tab',turnId:'turn-1',question:'核对确认卡片',options:['允许这一步','不允许']});
 await wait(100);ok('确认卡片展开且状态优先于工作动作',(await wc.executeJavaScript('desktopPetInspect().state==="waiting"&&!document.getElementById("ask").classList.contains("hidden")')));
 await wc.executeJavaScript('document.querySelector("#askOpts button").click()');await wait(100);
 ok('原回答回调保留会话和轮次',answered&&answered.key==='pet-test:tab'&&answered.turnId==='turn-1');
 await wc.executeJavaScript('document.getElementById("input").value="桌宠发送核对";document.getElementById("send").click()');await wait(100);
 ok('复用原发送入口',sent&&sent.key==='pet-test:tab'&&sent.text==='桌宠发送核对');
 await wc.executeJavaScript('document.getElementById("btnStop").click()');await wait(100);
 ok('复用原停止入口',stopped&&stopped.key==='pet-test:tab');
 bar.pushEvent('pet-test:tab',{kind:'tool',turnId:'turn-1',callId:'read-1',name:'read_file',status:'done',outcome:'error'});
 bar.pushEvent('pet-test:tab',{kind:'turn-end',turnId:'turn-1',outcome:'success'});await wait(100);
 ok('工具失败不会播放成功动作',(await wc.executeJavaScript('desktopPetInspect().state'))==='error');
 await wc.executeJavaScript('document.getElementById("btnHide").click()');await wait(100);
 ok('收起聊天保留宠物',(await wc.executeJavaScript('desktopPetInspect().expanded'))===false&&win.isVisible());
 const image=await wc.capturePage();fs.writeFileSync(path.join(root,'generated/desktop-pet-check/cat.png'),image.toPNG());
 await wc.executeJavaScript('desktopPet.call("settings",{skin:"spcode"})');
 // 通过真正的选择控件触发图集解码。
 await wc.executeJavaScript('document.getElementById("pet-skin").value="spcode";document.getElementById("pet-skin").dispatchEvent(new Event("change"))');await wait(200);
 // 每个内置动作都应有非空 Alpha 与相邻帧变化，核对图集实际像素。
 const pixels=await wc.executeJavaScript('(async function(){const d=await desktopPet.call("init");const out=[];for(const s of d.skins){if(s.error)throw Error(s.error);const im=new Image();im.src=s.atlasUrl;await im.decode();const c=document.createElement("canvas");c.width=s.cellSize;c.height=s.cellSize;const x=c.getContext("2d");for(const k of d.config.states){const a=s.animations[k];x.clearRect(0,0,c.width,c.height);x.drawImage(im,0,a.row*s.cellSize,s.cellSize,s.cellSize,0,0,c.width,c.height);const p=x.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<p.length;i+=4)if(p[i]>24)n++;out.push({skin:s.id,state:k,opaque:n});}}return out;})()');
 ok('三套皮肤全部48个动作均有真实透明图像',pixels.length===require('../electron/lib/desktop-pet-config.json').states.length*3&&pixels.every(function(p){return p.opaque>1000&&p.opaque<192*192*.8;}));
 // 直接选择两个动作，核对真实页面标签隐藏且文字为空；动画本身仍在绘制。
 for(const silentState of ['dragging','landing']){
   await wc.executeJavaScript('document.getElementById("pet-preview").value='+JSON.stringify(silentState)+';document.getElementById("pet-preview").dispatchEvent(new Event("change"))');
   await wait(200);
   const silent=await wc.executeJavaScript('({state:desktopPetInspect().presentedState,hidden:document.getElementById("pet-label").hidden,text:document.getElementById("pet-label").textContent})');
   ok(silentState+'只播放动画且无台词气泡',silent.state===silentState&&silent.hidden&&silent.text==='');
 }
 await wc.executeJavaScript('document.getElementById("pet-preview").value="";document.getElementById("pet-preview").dispatchEvent(new Event("change"))');
 await wc.executeJavaScript('document.getElementById("pet-skin").value="cyber-neko";document.getElementById("pet-skin").dispatchEvent(new Event("change"))');await wait(180);
 await wc.executeJavaScript('document.getElementById("pet-scale").value="0.6";document.getElementById("pet-scale").dispatchEvent(new Event("input"))');await wait(2400);
 const saved=JSON.parse(fs.readFileSync(path.join(app.getPath('userData'),'desktop-pets','slot-98.json'),'utf8'));
 ok('皮肤与缩放已实际写入用户配置',saved.skin==='cyber-neko'&&saved.scale===0.6);
 fs.writeFileSync(path.join(root,'generated/desktop-pet-check/cyber-neko.png'),(await wc.capturePage()).toPNG());
 fs.writeFileSync(path.join(root,'generated/desktop-pet-check/results.json'),JSON.stringify({passed:results,pixels},null,2));
 bar.destroy();background.destroy();app.quit();
}
app.whenReady().then(run).catch(function(error){console.error(error.stack||error);fs.writeFileSync(path.join(root,'generated/desktop-pet-check/failure.txt'),String(error.stack||error));app.exit(1);});
