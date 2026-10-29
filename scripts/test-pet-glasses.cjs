// 在真实 Chromium Canvas 核对上挑三角墨镜、16种矢量工作图标与原图保护。
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {app,BrowserWindow,nativeImage}=require('electron');
const {pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
const dir=path.join(root,'electron/lib/desktop-pet-skins/cyber-neko');
const config=require('../electron/lib/desktop-pet-config.json');
const skin=require('../electron/lib/desktop-pet-skins/cyber-neko/skin.json');
const baseline={'atlas.png':'39549baec6eaf471f504bf3b7668317b98727a0da0517a45fc804e702b9afb91','painted-head-source.png':'8188cefbee9e5c44bcc8c2c65de5e44fe68a7c3273b457c402eabbb78737788c','remesh-head.png':'6502d29555949a863d29d36de1583db20ef7baa5a5b3c46f475e80488cdf37c2','painted-head.png':'a3f2d159d95a744f80705cebb32d25bc3b345fb6857391a35bd9c6b61213f3e0'};
const passed=[];
/** 原图保护以本轮修改前实测哈希为准，测试前后各核对一次。 */
function originals(){for(const name of Object.keys(baseline))assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,name))).digest('hex'),baseline[name],name+'原像素不得改变');}
/** 记录可核实的行为断言，失败直接中止并返回非零状态。 */
function ok(name,value){assert.ok(value,name);passed.push(name);console.log('PASS '+name);}
/**
 * 记录生产镜片实际裁切的三角路径及其头部变换。
 * 保留原始 Canvas 绘制，只观测镜框几何，避免用另一份镜片实现自证。
 */
function recordGeometry(ctx){
 const lenses=[],original={beginPath:ctx.beginPath,moveTo:ctx.moveTo,lineTo:ctx.lineTo,clip:ctx.clip};
 let points=[];
 ctx.beginPath=function beginRecordedPath(){points=[];return original.beginPath.call(ctx);};
 ctx.moveTo=function moveRecordedPoint(x,y){points.push({x,y});return original.moveTo.call(ctx,x,y);};
 ctx.lineTo=function lineRecordedPoint(x,y){points.push({x,y});return original.lineTo.call(ctx,x,y);};
 ctx.clip=function clipRecordedLens(){
  const matrix=ctx.getTransform();
  lenses.push({points:points.slice(),matrix:{a:matrix.a,b:matrix.b,c:matrix.c,d:matrix.d,e:matrix.e,f:matrix.f}});
  return original.clip.call(ctx);
 };
 lenses.restore=function restoreGeometry(){for(const name of Object.keys(original))ctx[name]=original[name];};
 return lenses;
}
/**
 * 核对真实镜框共线、放大及虹膜覆盖。
 * idle 首帧的虹膜点来自无眼镜图集的实测位置，独立于眼镜配置；其他帧核对同一头部坐标中的镜框基线。
 */
function checkGeometry(lenses,state,frame){
 if(lenses.length!==2)throw new Error('必须绘制两个完整镜片轮廓');
 for(const lens of lenses){
  if(lens.points.length!==3)throw new Error('镜片必须是三角轮廓，不能是普通矩形或圆框');
  const a=lens.points[0],b=lens.points[1],c=lens.points[2];
  if(Math.max(a.x,b.x,c.x)-Math.min(a.x,b.x,c.x)<80||c.y-a.y<50)throw new Error('外翼与下角的延展不足');
  if(a.y>=b.y||b.y>=c.y)throw new Error('外尖角必须明显上挑，内角和下角依次降低');
 }
 for(let i=0;i<3;i++){
  if(Math.abs(lenses[0].points[i].x+lenses[1].points[i].x)>0.001||lenses[0].points[i].y!==lenses[1].points[i].y)throw new Error('两侧三角镜形没有严格镜像');
 }
 const left=lenses[0].matrix,right=lenses[1].matrix;
 const cross=(right.e-left.e)*left.b-(right.f-left.f)*left.a;
 if(Math.abs(cross)>0.001)throw new Error('左右镜片未沿头部的同一条眼线排列');
 if(state==='idle'&&frame===0){
  const irises=[{x:150,y:210},{x:229,y:205}],fitTolerance=3;
  for(let i=0;i<irises.length;i++){
   const lens=lenses[i],matrix=lens.matrix,eye=irises[i],world=[];
   if(Math.abs(eye.x-matrix.e)>fitTolerance||Math.abs(eye.y-matrix.f)>fitTolerance)throw new Error('眼部锚点偏离实测虹膜超过3个图集像素');
   for(const point of lens.points)world.push({x:matrix.a*point.x+matrix.c*point.y+matrix.e,y:matrix.b*point.x+matrix.d*point.y+matrix.f});
   let direction=0;
   for(let j=0;j<world.length;j++){
    const a=world[j],b=world[(j+1)%world.length],edge=(b.x-a.x)*(eye.y-a.y)-(b.y-a.y)*(eye.x-a.x);
    if(direction*edge<0)throw new Error('实际虹膜没有落入三角镜片内部');
    if(edge!==0)direction=edge;
   }
  }
 }
}
/** 检查每帧镜框共线及眼部贴合，并导出实际合成的状态对照图。 */
async function run(){
 originals();
 const win=new BrowserWindow({show:false,webPreferences:{webSecurity:false}});
 await win.loadURL('about:blank');
 const source=fs.readFileSync(path.join(root,'electron/lib/desktop-pet-glasses.js'),'utf8');
 const result=await win.webContents.executeJavaScript('(async function(){'+source+'\n'+String(recordGeometry)+'\n'+String(checkGeometry)+'\nconst config='+JSON.stringify(config)+';const skin='+JSON.stringify(skin)+';'+
 'const image=new Image();image.src='+JSON.stringify(pathToFileURL(path.join(dir,'atlas.png')).href)+';await image.decode();'+
 'const cell=skin.cellSize,base=document.createElement("canvas"),layer=document.createElement("canvas");base.width=base.height=layer.width=layer.height=cell;const b=base.getContext("2d",{willReadFrequently:true}),g=layer.getContext("2d",{willReadFrequently:true});'+
 'const board=document.createElement("canvas");board.width=cell*4;board.height=(cell+32)*4;const out=board.getContext("2d");out.fillStyle="#121225";out.fillRect(0,0,board.width,board.height);const checks=[];'+
 'for(let s=0;s<config.states.length;s++){const state=config.states[s],clip=skin.animations[state];let minContact=1,minVisible=cell*cell,hashes=[];for(let frame=0;frame<clip.frames;frame++){b.clearRect(0,0,cell,cell);b.drawImage(image,frame*cell,clip.row*cell,cell,cell,0,0,cell,cell);const before=base.toDataURL();const rectangles=recordGeometry(g);DesktopPetGlasses.paint(g,config.glasses,skin,state,frame);checkGeometry(rectangles,state,frame,config,skin);rectangles.restore();if(before!==base.toDataURL())throw new Error("眼镜绘制改变了角色画布");const a=b.getImageData(0,0,cell,cell).data,p=g.getImageData(0,0,cell,cell).data;let contact=0,visible=0;for(let i=3;i<p.length;i+=4){if(p[i]>24){visible++;if(a[i]>24)contact++;}}minContact=Math.min(minContact,contact/visible);minVisible=Math.min(minVisible,visible);hashes.push(layer.toDataURL());if(frame===0){const x=s%4*cell,y=Math.floor(s/4)*(cell+32);out.fillStyle="#d2b3ff";out.font="18px Microsoft YaHei";out.fillText(config.labels[state],x+12,y+24);out.drawImage(base,x,y+32);out.drawImage(layer,x,y+32);}}checks.push({state,minContact,minVisible,uniqueFrames:new Set(hashes).size});}return {checks,board:board.toDataURL().split(",")[1]};})()');
 for(const check of result.checks){ok(check.state+' 眼镜在全部动作帧贴合角色区域',check.minContact>.9&&check.minVisible>500);}
 ok('全部动作帧为镜像上挑三角形、眼线共线且覆盖实测虹膜',true);
 ok('16个工作状态使用独立矢量图标',new Set(Object.values(config.glasses.symbols)).size===config.states.length);
 ok('扫描条按动画帧变化',result.checks.every(function(check){return check.uniqueFrames>1;}));
 originals();ok('原图、重绘、透明头图、动作图集哈希全部不变',true);
 const output=path.join(root,'generated/desktop-pet-glasses-check');fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'states.png'),Buffer.from(result.board,'base64'));
 // 单角色预览直接裁取实际合成结果，便于验收三角镜形，不生成另一份效果实现。
 const preview=nativeImage.createFromBuffer(Buffer.from(result.board,'base64')).crop({x:0,y:32,width:skin.cellSize,height:skin.cellSize});
 fs.writeFileSync(path.join(output,'preview.png'),preview.toPNG());
 fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed,checks:result.checks,originalHashes:baseline},null,2),'utf8');
 console.log('RESULT '+passed.length+' 项通过；图像 '+path.join(output,'states.png'));win.destroy();app.quit();
}
app.whenReady().then(run).catch(function(error){console.error(error.stack||error);app.exit(1);});
