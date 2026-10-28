/** 核对矢量桌宠烘焙后的192帧、透明边界、口型变化及可独立导入的皮肤包。 */
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {app,BrowserWindow,nativeImage}=require('electron');
const JSZip=require('jszip');
const root=path.join(__dirname,'..'),folder=path.join(root,'generated/desktop-pet-check');
const skinDir=path.join(root,'electron/lib/desktop-pet-skins/cyber-neko');
const config=require('../electron/lib/desktop-pet-config.json');
const manifest=require('../electron/lib/desktop-pet-skins/cyber-neko/skin.json');
const art=require('../electron/lib/desktop-pet-skins/cyber-neko/art.json');
const passed=[];
/** 失败保留实际断言，成功记录到交付清单。 */
function check(name,condition){assert.ok(condition,name);passed.push(name);console.log('PASS '+name);}
/** 对真实帧字节取摘要，用于核对姿态、口型和确定性。 */
function digest(buffer){return crypto.createHash('sha256').update(buffer).digest('hex');}
/** 扫描帧内Alpha，忽略阴影，返回可见身体和道具的范围。 */
function bounds(frame){
 const pixels=frame.toBitmap(),size=frame.getSize();let left=size.width,top=size.height,right=-1,bottom=-1,count=0;
 for(let y=0;y<size.height;y++){
  for(let x=0;x<size.width;x++){
   if(pixels[(y*size.width+x)*4+3]<=config.motion.alphaThreshold)continue;
   count++;left=Math.min(left,x);top=Math.min(top,y);right=Math.max(right,x);bottom=Math.max(bottom,y);
  }
 }
 return {left,top,right,bottom,count};
}
/** 逐帧检查实际PNG，再导出同一图集的预览与标准ZIP，不替代真实窗口交互验收。 */
async function run(){
 const atlas=nativeImage.createFromPath(path.join(skinDir,manifest.atlas)),size=atlas.getSize(),cell=manifest.cellSize;
 check('图集完整覆盖16行12列',size.width===cell*config.motion.frames&&size.height===cell*config.states.length);
 const stats=[],poses=new Set();let minimumMargin=cell;
 for(const state of config.states){
  const clip=manifest.animations[state],hashes=new Set();let smallest=cell*cell;
  for(let index=0;index<clip.frames;index++){
   const frame=atlas.crop({x:index*cell,y:clip.row*cell,width:cell,height:cell}),box=bounds(frame);
   assert.ok(box.count>1000,state+' 第'+index+'帧主体为空或过少');
   assert.ok(box.left>0&&box.top>0&&box.right<cell-1&&box.bottom<cell-1,state+' 第'+index+'帧被边缘裁切 '+JSON.stringify(box));
   smallest=Math.min(smallest,box.count);minimumMargin=Math.min(minimumMargin,box.left,box.top,cell-1-box.right,cell-1-box.bottom);
   hashes.add(digest(frame.toBitmap()));
  }
  check(state+'包含连续动作帧且无裁切',hashes.size>=4);
  poses.add(digest(atlas.crop({x:0,y:clip.row*cell,width:cell,height:cell}).toBitmap()));
  stats.push({state,frames:clip.frames,distinctFrames:hashes.size,minimumOpaque:smallest});
 }
 check('16种状态具有不同的首帧姿态或道具',poses.size===config.states.length);
 const scale=art.canvas.figureHeight/art.canvas.sourceHeight;
 const mouthX=Math.round(art.canvas.anchor[0]+(400-art.canvas.foot[0])*scale);
 const mouthY=Math.round(art.canvas.anchor[1]+(420-art.canvas.foot[1])*scale);
 const mouthHashes=new Set(),speaking=manifest.animations.speaking;
 for(let index=0;index<speaking.frames;index++)mouthHashes.add(digest(atlas.crop({x:index*cell+mouthX-10,y:speaking.row*cell+mouthY-5,width:20,height:16}).toBitmap()));
 check('回复动作的实际嘴部像素随帧变化',mouthHashes.size>=4);
 const source=fs.readFileSync(path.join(skinDir,'art.svg'),'utf8');
 // 只画头：核对头部独立部件，不再要求四肢部件。
 check('角色由独立矢量头部部件构成且没有嵌入参考位图',source.indexOf('<image')<0&&source.indexOf('data:image')<0&&source.indexOf('data-part="face"')>=0&&source.indexOf('data-part="hair-front"')>=0&&source.indexOf('data-part="eyes"')>=0&&source.indexOf('data-part="leg-left-upper"')<0);
 const win=new BrowserWindow({show:false,width:1200,height:1000,webPreferences:{offscreen:true}});
 await win.loadFile(path.join(folder,'mist-pet.html'));
 const expression='(async function(){await window.renderFrame(.25,3,{});return document.getElementById("sheet").toDataURL("image/png").split(",")[1];})()';
 const first=await win.webContents.executeJavaScript(expression),second=await win.webContents.executeJavaScript(expression);
 check('相同时间得到相同的完整预览画布',digest(Buffer.from(first,'base64'))===digest(Buffer.from(second,'base64')));
 fs.writeFileSync(path.join(folder,'mist-pet.png'),Buffer.from(first,'base64'));
 // 保持离屏窗口存活，等ZIP异步压缩和协议核对结束后再退出Electron。
 const zip=new JSZip(),portable=Object.assign({},manifest,{id:'mist-neko',name:art.name+' · 独立皮肤'});
 zip.file('skin.json',JSON.stringify(portable,null,2));zip.file(portable.atlas,fs.readFileSync(path.join(skinDir,manifest.atlas)));
 const packagePath=path.join(folder,'mist-neko.zip');fs.writeFileSync(packagePath,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
 const library=require('../electron/lib/desktop-pet-skins');
 const packed=await JSZip.loadAsync(fs.readFileSync(packagePath)),packedManifest=JSON.parse(await packed.file('skin.json').async('string')),packedPng=await packed.file(packedManifest.atlas).async('nodebuffer');
 function asset(){return packedPng;}
 library.validate(packedManifest,asset);
 check('交付ZIP经过真实读取并满足运行时皮肤协议',packedManifest.id==='mist-neko'&&packedPng.equals(fs.readFileSync(path.join(skinDir,manifest.atlas))));
 fs.writeFileSync(path.join(folder,'mist-pet-results.json'),JSON.stringify({passed,minimumMargin,stats,portable:'generated/desktop-pet-check/mist-neko.zip'},null,2),'utf8');
 win.destroy();app.exit(0);
}
/** 保留错误堆栈并返回失败，禁止以生成了文件代替验收通过。 */
function failed(error){console.error(error.stack||error);app.exit(1);}
app.whenReady().then(run).catch(failed);
