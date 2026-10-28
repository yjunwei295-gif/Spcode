// 核对交互作品真实载入、三栏布局、原图像素、动作切换及已导出的PNG。
'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert'),crypto=require('crypto');
const {app,BrowserWindow,nativeImage}=require('electron');
const output=path.join(__dirname,'../generated/desktop-pet-check');
/** 在与登记相同的画布尺寸运行完整源稿，检查实际DOM与绘制结果。 */
async function run(){
  const win=new BrowserWindow({width:1600,height:1100,useContentSize:true,show:false,frame:false,webPreferences:{offscreen:true}});
  await win.loadFile(path.join(output,'crystal-code-draw.html'));
  await win.webContents.executeJavaScript('document.getElementById("reference").decode()');
  await win.webContents.executeJavaScript('window.renderFrame(0)');
  const result=await win.webContents.executeJavaScript('(async function(){const c=document.getElementById("copy"),x=c.getContext("2d"),p=x.getImageData(0,0,c.width,c.height).data;let raw="";for(let n=0;n<p.length;n+=16384)raw+=String.fromCharCode.apply(null,p.subarray(n,n+16384));const boxes=Array.from(document.querySelectorAll(".picture")).map(function(one){const child=one.firstElementChild,a=one.getBoundingClientRect(),b=child.getBoundingClientRect();return {inside:b.left>=a.left-1&&b.top>=a.top-1&&b.right<=a.right+1&&b.bottom<=a.bottom+1,width:b.width,height:b.height};});const pet=document.getElementById("pet"),a=pet.getContext("2d").getImageData(0,0,pet.width,pet.height).data;document.getElementById("state").value="speaking";document.getElementById("state").dispatchEvent(new Event("change"));await window.renderFrame(.25);const b=pet.getContext("2d").getImageData(0,0,pet.width,pet.height).data;let different=0;for(let i=0;i<a.length;i+=4)if(a[i]!==b[i]||a[i+1]!==b[i+1]||a[i+2]!==b[i+2])different++;return {raw:btoa(raw),boxes,different,label:document.getElementById("state-label").textContent,images:document.getElementById("reference").complete};})()');
  const report=JSON.parse(fs.readFileSync(path.join(output,'pixel-reconstruction-results.json'),'utf8'));
  const hash=crypto.createHash('sha256').update(Buffer.from(result.raw,'base64')).digest('hex');
  assert.strictEqual(hash,report.rgbaSha256,'交互源稿中的重绘图必须与用户附件像素一致');
  assert.ok(result.images,'原图对照必须真实载入');
  assert.ok(result.boxes.every(function(b){return b.inside&&b.width>200&&b.height>200;}),'三栏图像必须完整显示在自己的面板中');
  assert.ok(result.different>1000&&result.label==='正在回复','选择动作必须改变真实画面和状态');
  const exported=nativeImage.createFromPath(path.resolve(process.argv[2]));
  assert.deepStrictEqual(exported.getSize(),{width:1600,height:1100},'实际导出PNG尺寸必须与登记一致');
  assert.ok(exported.toBitmap().some(function(v,i){return i%4!==3&&v>180;}),'导出的PNG必须具有可见图像内容');
  await win.webContents.executeJavaScript('document.getElementById("state").value="idle";document.getElementById("state").dispatchEvent(new Event("change"));window.renderFrame(0)');
  fs.writeFileSync(path.join(output,'pixel-preview-verified.png'),(await win.webContents.capturePage()).toPNG());
  delete result.raw;
  fs.writeFileSync(path.join(output,'pixel-preview-results.json'),JSON.stringify({passed:6,sourceRgbaSha256:hash,layout:result.boxes,animationDifferentPixels:result.different,exportSize:exported.getSize()},null,2),'utf8');
  console.log('PASS 原图载入、Canvas逐像素还原、三栏无裁切、动作切换、实际PNG尺寸与内容，共6项');
  win.destroy();app.quit();
}
app.whenReady().then(run).catch(function(error){console.error(error.stack||error);app.exit(1);});
