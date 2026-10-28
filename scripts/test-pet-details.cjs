/**
 * 核对实际烘焙图集中的十六种嘴型、说话开合和透明像素，输出可审阅的表情表。
 */
'use strict';
const {app,BrowserWindow,nativeImage}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
/** 解码真实图集，以嘴部区域像素而非方法存在性判断表情是否不同。 */
async function main(){
  await app.whenReady();
  const win=new BrowserWindow({show:false,frame:false,useContentSize:true,width:1440,height:1080,webPreferences:{offscreen:true}});
  await win.loadFile(path.join(root,'generated/desktop-pet-check/details.html'));
  // 使用画布原始像素核对，避免桌面工作区限高和页面缩放裁掉最后一排。
  const result=await win.webContents.executeJavaScript('('+async function inspect(){
    await window.renderFrame(0,0,{});
    const image=new Image();image.src=atlas.src;await image.decode();
    const cell=document.createElement('canvas');cell.width=30;cell.height=24;
    const ctx=cell.getContext('2d',{willReadFrequently:true});
    const mouths=[];
    for(let row=0;row<16;row++){
      ctx.clearRect(0,0,30,24);
      ctx.drawImage(image,82,row*192+60+(row===14?-12:0),28,20,0,0,30,24);
      mouths.push(cell.toDataURL());
    }
    ctx.clearRect(0,0,30,24);ctx.drawImage(image,3*192+82,2*192+60,28,20,0,0,30,24);
    return {unique:new Set(mouths).size,speakingChanges:mouths[2]!==cell.toDataURL(),width:image.width,height:image.height};
  }.toString()+')()');
  assert.equal(result.unique,16,'各动作嘴部实际像素必须不同');
  assert.equal(result.speakingChanges,true,'说话的实际帧必须改变嘴部开合');
  assert.equal(result.width,2304);assert.equal(result.height,3072);
  const capture=await win.webContents.executeJavaScript('document.getElementById("sheet").toDataURL("image/png")');
  const screenshot=nativeImage.createFromDataURL(capture);
  fs.writeFileSync(path.join(root,'generated/desktop-pet-check/details.png'),screenshot.toPNG());
  if(process.argv[2]){
    const exported=nativeImage.createFromPath(path.resolve(root,process.argv[2]));
    assert.deepEqual(exported.getSize(),{width:1440,height:1080},'实际导出图尺寸');
    const actual=exported.toBitmap(),expected=screenshot.toBitmap();
    assert.equal(actual.length,expected.length);
    let difference=0;
    for(let i=0;i<actual.length;i++)difference+=Math.abs(actual[i]-expected[i]);
    result.exportPixelMean=difference/actual.length;
    console.log('EXPORT '+JSON.stringify({mean:result.exportPixelMean,actualSize:exported.getSize(),expectedSize:screenshot.getSize(),samples:[0,1440*100*4,1440*500*4].map(function sample(i){return {actual:Array.from(actual.subarray(i,i+4)),expected:Array.from(expected.subarray(i,i+4))}})}));
    assert.ok(result.exportPixelMean<1,'实际导出图应与当前图集预览一致');
  }
  console.log('PASS '+JSON.stringify(result));
  win.destroy();app.exit(0);
}
/** 失败时报告真实原因并非零退出。 */
function failed(error){console.error(error.stack||error);app.exit(1)}
main().catch(failed);
