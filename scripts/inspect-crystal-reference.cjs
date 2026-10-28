// 从用户明确提供的参考文件提取实测像素，供无损编码与表情区域定位。
'use strict';
const fs=require('fs'),path=require('path');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
/** 原图只在离线编译时解码，输出RGBA采样和原始数据，不修改原附件。 */
async function run(){
  const file=process.argv[2];
  if(!file)throw new Error('必须指定原始参考图');
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const result=await win.webContents.executeJavaScript('(async function(){const im=new Image();im.src='+JSON.stringify(pathToFileURL(path.resolve(file)).href)+';await im.decode();const c=document.createElement("canvas");c.width=im.width;c.height=im.height;const ctx=c.getContext("2d");ctx.drawImage(im,0,0);const p=ctx.getImageData(0,0,c.width,c.height).data;let transparent=0;for(let i=3;i<p.length;i+=4)if(p[i]<255)transparent++;const samples=[];for(let y=0;y<c.height;y+=40){let line="";for(let x=0;x<c.width;x+=24){let i=(y*c.width+x)*4,r=p[i],g=p[i+1],b=p[i+2];line+=p[i+3]<8?".":(g>r*1.1&&b>r*1.1?"C":(r>180&&g>145&&b>155&&r>g*1.03?"S":(b>r*1.1&&r>g*1.2?"P":(Math.max(r,g,b)-Math.min(r,g,b)<25?"G":"K"))));}samples.push({y,line});}const corners=[[0,0],[c.width-1,0],[0,c.height-1],[c.width-1,c.height-1]].map(function(v){const i=(v[1]*c.width+v[0])*4;return Array.from(p.slice(i,i+4));});let raw="";for(let i=0;i<p.length;i+=16384)raw+=String.fromCharCode.apply(null,p.subarray(i,i+16384));return {width:c.width,height:c.height,transparent,corners,samples,rgba:btoa(raw)};})()');
  const output=path.join(__dirname,'../generated/desktop-pet-check');
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'user-reference.rgba'),Buffer.from(result.rgba,'base64'));
  delete result.rgba;
  fs.writeFileSync(path.join(output,'user-reference-samples.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));win.destroy();app.quit();
}
app.whenReady().then(run).catch(function(error){console.error(error);app.exit(1);});
