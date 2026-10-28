/**
 * 核对纤细腰身、躺卧图集及真实页面的休息轮换和工作打断。
 * 独立用户目录隔离偏好；可控帧时钟只替代等待，不替代生产状态模型或 IPC。
 */
'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..'),passed=[];
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'spcode-slender-')));
/** 等待图像解码、页面初始化与 IPC 落地。 */
function wait(ms){return new Promise(function done(resolve){setTimeout(resolve,ms);});}
/** 输出并累计实际断言，失败直接抛出。 */
function ok(name,value){assert.ok(value,name);passed.push(name);console.log('PASS '+name);}
/** 从真实 PNG 测量腰胸髋宽、休息姿态及每帧边界，半透明阴影不计入角色轮廓。 */
async function inspect(manifest){
 await ready;
 const cell=document.createElement('canvas');cell.width=192;cell.height=192;
 const ctx=cell.getContext('2d',{willReadFrequently:true});
 function sample(image,row,frame){
  ctx.clearRect(0,0,192,192);ctx.drawImage(image,frame*192,row*192,192,192,0,0,192,192);
  const data=ctx.getImageData(0,0,192,192).data;
  let left=192,top=192,right=-1,bottom=-1,count=0,pink=0;
  for(let y=0;y<192;y++)for(let x=0;x<192;x++){
   const i=(y*192+x)*4;
   if(data[i+3]<=128)continue;
   left=Math.min(left,x);right=Math.max(right,x);top=Math.min(top,y);bottom=Math.max(bottom,y);count++;
   if(y>80&&data[i]>data[i+1]*1.5&&data[i]>70&&data[i+2]>25)pink++;
  }
  return {left,top,right,bottom,count,pink,data,signature:cell.toDataURL()};
 }
 function widthAt(data,y){
  let left=96,right=96;
  while(left>0&&data[(y*192+left-1)*4+3]>128)left--;
  while(right<191&&data[(y*192+right+1)*4+3]>128)right++;
  return right-left+1;
 }
 const old=sample(before,0,0),standing=sample(atlas,0,0);
 const shape={oldWaist:widthAt(old.data,134),waist:widthAt(standing.data,108),chest:widthAt(standing.data,87),hips:widthAt(standing.data,126),pinkBodyPixels:standing.pink};
 const clips=[];
 for(const name of Object.keys(manifest.animations)){
  const clip=manifest.animations[name];
  for(let frame=0;frame<clip.frames;frame++){
   const p=sample(atlas,clip.row,frame);
   clips.push({name,frame,left:p.left,top:p.top,right:p.right,bottom:p.bottom,count:p.count});
  }
 }
 const half=sample(atlas,16,0),side=sample(atlas,17,0),halfMoved=sample(atlas,16,3),sideMoved=sample(atlas,17,3);
 return {shape,clips,halfAspect:(half.right-half.left)/(half.bottom-half.top),sideAspect:(side.right-side.left)/(side.bottom-side.top),different:half.signature!==side.signature,halfMoves:half.signature!==halfMoved.signature,sideMoves:side.signature!==sideMoved.signature};
}
/** 真实 BrowserWindow 解码图集，随后运行实际小窗、preload、菜单和状态模型。 */
async function run(){
 const manifest=require('../electron/lib/desktop-pet-skins/cyber-neko/skin.json');
 const preview=new BrowserWindow({show:false,webPreferences:{offscreen:true}});
 await preview.loadFile(path.join(root,'generated/desktop-pet-check/slender.html'));
 const measured=await preview.webContents.executeJavaScript('('+inspect.toString()+')('+JSON.stringify(manifest)+')');
 preview.destroy();console.log('MEASURE '+JSON.stringify(measured.shape));
 ok('实际腰宽小于调整前且小于胸髋宽度',measured.shape.waist<measured.shape.oldWaist&&measured.shape.waist<measured.shape.chest&&measured.shape.waist<measured.shape.hips);
 ok('身体具有接续头发的洋红主色',measured.shape.pinkBodyPixels>1000);
 const clipped=measured.clips.filter(function bad(p){return p.count<=500||p.left<=0||p.top<=0||p.right>=191||p.bottom>=191;});
 console.log('CLIPPED '+JSON.stringify(clipped));
 ok('18种动作216帧均非空且不触及帧边界',measured.clips.length===216&&clipped.length===0);
 ok('两种躺姿轮廓不同且均有实际帧变化',measured.halfAspect>1.4&&measured.sideAspect>1.4&&measured.different&&measured.halfMoves&&measured.sideMoves);
 const {createFloatBar}=require('../electron/lib/float-bar');
 const bar=createFloatBar({slotIndex:97,onBind:function(){bar.setBoundKey('slender:tab');}});
 bar.setBoundKey('slender:tab');
 const win=BrowserWindow.getAllWindows().find(function owned(one){return bar.ownsWindow(one);}),wc=win.webContents;
 for(let i=0;i<50;i++){await wait(100);if(await wc.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin)'))break;}
 ok('真实菜单列出两种休息姿态',await wc.executeJavaScript('Array.from(document.querySelectorAll("#pet-preview option")).some(function(o){return o.value==="reclining"})&&Array.from(document.querySelectorAll("#pet-preview option")).some(function(o){return o.value==="lying"})'));
 // 生产 tick 接收 requestAnimationFrame 的时间戳；只接管下一帧调度来核对长时间空闲边界。
 await wc.executeJavaScript('window.requestAnimationFrame=function savePetFrame(callback){window.stepPet=callback;};');
 await wait(120);
 const clock=await wc.executeJavaScript('performance.now()'),interval=require('../electron/lib/desktop-pet-config.json').motion.idlePoseMs;
 await wc.executeJavaScript('stepPet('+(clock+interval+200)+')');
 ok('空闲一个周期后撑头半躺',await wc.executeJavaScript('desktopPetInspect().presentedState==="reclining"'));
 await wc.executeJavaScript('stepPet('+(clock+interval*2+200)+')');
 ok('空闲两个周期后侧躺',await wc.executeJavaScript('desktopPetInspect().presentedState==="lying"'));
 await wc.executeJavaScript('document.getElementById("pet-reduced").checked=true;document.getElementById("pet-reduced").dispatchEvent(new Event("change"))');
 await wait(120);await wc.executeJavaScript('stepPet('+(clock+interval*2+400)+')');
 ok('减少动态时保持站姿',await wc.executeJavaScript('desktopPetInspect().presentedState==="idle"'));
 await wc.executeJavaScript('document.getElementById("pet-preview").value="lying";document.getElementById("pet-preview").dispatchEvent(new Event("change"));stepPet('+(clock+interval*2+600)+')');
 ok('菜单可单独预览侧躺',await wc.executeJavaScript('desktopPetInspect().presentedState==="lying"'));
 await wc.executeJavaScript('document.getElementById("pet-preview").value="";document.getElementById("pet-preview").dispatchEvent(new Event("change"))');
 bar.pushEvent('slender:tab',{kind:'turn-start',turnId:'work'});
 bar.pushEvent('slender:tab',{kind:'tool',turnId:'work',callId:'read',name:'read_file',status:'running'});
 await wait(150);await wc.executeJavaScript('stepPet('+(clock+interval*2+900)+')');
 ok('真实工作事件打断休息',await wc.executeJavaScript('desktopPetInspect().presentedState==="reading"'));
 await wc.executeJavaScript('document.getElementById("pet-skin").value="cat";document.getElementById("pet-skin").dispatchEvent(new Event("change"))');
 await wait(180);
 ok('换成普通皮肤后移除额外躺姿且无错误',await wc.executeJavaScript('desktopPetInspect().skin==="cat"&&!desktopPetInspect().errors&&!Array.from(document.querySelectorAll("#pet-preview option")).some(function(o){return o.value==="lying"})'));
 fs.writeFileSync(path.join(root,'generated/desktop-pet-check/slender-results.json'),JSON.stringify({passed,measured},null,2),'utf8');
 bar.destroy();app.exit(0);
}
/** 实际失败报告堆栈并以非零码结束。 */
function failed(error){console.error(error.stack||error);app.exit(1);}
app.whenReady().then(run).catch(failed);
