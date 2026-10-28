// 将用户原图离线编译为无损像素数据；运行时用程序重绘，不依赖图片或生图引擎。
'use strict';
const fs=require('fs'),path=require('path'),zlib=require('zlib'),crypto=require('crypto'),assert=require('assert');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
const skinDir=path.join(__dirname,'../electron/lib/desktop-pet-skins/cyber-neko');
const rules=require('../electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json');
/** 解码明确指定的附件，建立独立背景蒙版，再无损压缩原始RGBA并核对逐字节往返。 */
async function run(){
  const input=process.argv[2];
  if(!input)throw new Error('必须指定用户原始参考图');
  const original=fs.readFileSync(input);
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const decoded=await win.webContents.executeJavaScript('(async function(){const im=new Image();im.src='+JSON.stringify(pathToFileURL(path.resolve(input)).href)+';await im.decode();const c=document.createElement("canvas");c.width=im.width;c.height=im.height;const x=c.getContext("2d");x.drawImage(im,0,0);const p=x.getImageData(0,0,c.width,c.height).data;let raw="";for(let i=0;i<p.length;i+=16384)raw+=String.fromCharCode.apply(null,p.subarray(i,i+16384));return {width:c.width,height:c.height,rgba:btoa(raw)};})()');
  assert.strictEqual(decoded.width,rules.pixel.width,'附件宽度与本轮实测不符');
  assert.strictEqual(decoded.height,rules.pixel.height,'附件高度与本轮实测不符');
  const rgba=Buffer.from(decoded.rgba,'base64'),w=decoded.width,h=decoded.height;
  const mask=Buffer.alloc(w*h),queue=new Int32Array(w*h);
  let head=0,tail=0;
  const tolerance2=rules.pixel.backgroundTolerance*rules.pixel.backgroundTolerance;
  /** 只从外边界进入灰底，内部相似颜色不单独抠除，保留人物浅色切面。 */
  function visit(x,y){
    if(x<0||y<0||x>=w||y>=h)return;
    const id=y*w+x;if(mask[id])return;
    const left=y*w*4,right=(y*w+w-1)*4,i=id*4,t=x/(w-1);
    let distance=0;
    for(let k=0;k<3;k++){const base=rgba[left+k]*(1-t)+rgba[right+k]*t;distance+=(rgba[i+k]-base)*(rgba[i+k]-base);}
    if(distance>tolerance2)return;
    mask[id]=1;queue[tail++]=id;
  }
  for(let x=0;x<w;x++){visit(x,0);visit(x,h-1);}
  for(let y=0;y<h;y++){visit(0,y);visit(w-1,y);}
  while(head<tail){const id=queue[head++],x=id%w,y=Math.floor(id/w);visit(x-1,y);visit(x+1,y);visit(x,y-1);visit(x,y+1);}
  const compressed=zlib.deflateSync(rgba),compressedMask=zlib.deflateSync(mask);
  const restored=zlib.inflateSync(compressed);
  assert.ok(restored.equals(rgba),'原图像素无损往返必须完全一致');
  assert.ok(tail>w*h*.1&&tail<w*h*.8,'去底范围必须保留人物主体并清除外部背景');
  const source={version:1,width:w,height:h,encoding:'deflate-rgba',rgba:compressed.toString('base64'),backgroundMask:compressedMask.toString('base64'),referenceSha256:crypto.createHash('sha256').update(original).digest('hex'),pixelSha256:crypto.createHash('sha256').update(rgba).digest('hex')};
  fs.copyFileSync(input,path.join(skinDir,rules.pixel.referenceFile));
  fs.writeFileSync(path.join(skinDir,'pixel-source.js'),'// 用户原图的无损像素数据与独立背景蒙版；由 compile-crystal-pixels.cjs 编译。\nwindow.crystalPixelSource='+JSON.stringify(source)+';\n','utf8');
  const report={width:w,height:h,sourceFile:rules.pixel.referenceFile,sourceSha256:source.referenceSha256,rgbaSha256:source.pixelSha256,sourcePixels:w*h,reconstructionDifferentBytes:0,removedBackgroundPixels:tail,retainedPixels:w*h-tail,originalColorChanges:0};
  fs.writeFileSync(path.join(__dirname,'../generated/desktop-pet-check/pixel-reconstruction-results.json'),JSON.stringify(report,null,2),'utf8');
  console.log(JSON.stringify(report));win.destroy();app.quit();
}
app.whenReady().then(run).catch(function(error){console.error(error.stack||error);app.exit(1);});
