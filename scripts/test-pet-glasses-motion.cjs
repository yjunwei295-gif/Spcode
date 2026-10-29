// 用实际图集的固定发丝纹理核对眼镜跟随，不以眼镜自身的帧号或 HUD 变化代替头部运动。
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('node:url');
const root=path.join(__dirname,'..');
const config=require('../electron/lib/desktop-pet-config.json');
const skin=require('../electron/lib/desktop-pet-skins/cyber-neko/skin.json');
app.setPath('userData',path.join(require('node:os').tmpdir(),'spcode-glasses-motion-'+process.pid));
/** 等待真实小窗完成加载，不改变用户的运行实例和设置。 */
function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
/**
 * 冻结真实页面的 RAF 时钟，逐次切换预览动作并核对两个实际 Canvas 的像素。
 * 新动作首帧必须完整保留上张画面，下一帧必须与同权重合成相等，连续切换也使用当前混合结果。
 */
async function checkTransitions(config,skin,url){
 const image=new Image();image.src=url;await image.decode();
 const base=document.getElementById('pet-canvas'),layer=document.getElementById('pet-glasses'),cell=skin.cellSize;
 let clock=performance.now()+1000,next;
 window.requestAnimationFrame=function holdAnimation(callback){next=callback;return 1;};
 Object.defineProperty(performance,'now',{value:function controlledNow(){return clock;},configurable:true});
 await new Promise(function(resolve){setTimeout(resolve,150);});
 if(!next)throw new Error('真实动画未进入受控 RAF');
 /** 保存实际上一帧，避免预设状态代替当前混合结果。 */
 function copy(canvas){const result=document.createElement('canvas');result.width=result.height=cell;result.getContext('2d').drawImage(canvas,0,0);return result;}
 /** 以 Canvas 像素输出比较实际与期望合成，任何描边、HUD 或底图偏差均失败。 */
 function same(actual,expected,message){if(actual.toDataURL()!==expected.toDataURL())throw new Error(message);}
 const checks=[];next(clock);
 for(const state of ['thinking','success','landing','idle']){
  const oldBase=copy(base),oldLayer=copy(layer);
  const preview=document.getElementById('pet-preview');preview.value=state;preview.dispatchEvent(new Event('change'));
  next(clock);
  same(base,oldBase,state+' 切换起点改变了角色上一帧');
  same(layer,oldLayer,state+' 切换起点的眼镜抢先跳到新姿势');
  const step=state==='landing'?config.motion.landingMs/skin.animations[state].frames:1000/skin.fps;
  clock+=step+0.01;next(clock);
  const elapsed=step+0.01,blend=1-Math.pow(1-Math.min(1,elapsed/config.motion.blendMs),3),clip=skin.animations[state];
  const expectedBase=document.createElement('canvas'),expectedLayer=document.createElement('canvas'),newLayer=document.createElement('canvas');
  expectedBase.width=expectedBase.height=expectedLayer.width=expectedLayer.height=newLayer.width=newLayer.height=cell;
  const b=expectedBase.getContext('2d'),g=expectedLayer.getContext('2d');
  b.globalAlpha=1-blend;b.drawImage(oldBase,0,0);b.globalAlpha=blend;b.drawImage(image,cell,clip.row*cell,cell,cell,0,0,cell,cell);
  DesktopPetGlasses.paint(newLayer.getContext('2d'),config.glasses,skin,state,1);
  g.globalAlpha=1-blend;g.drawImage(oldLayer,0,0);g.globalAlpha=blend;g.drawImage(newLayer,0,0);
  same(base,expectedBase,state+' 角色合成与时钟不一致');same(layer,expectedLayer,state+' 眼镜没有复用角色交叉淡化权重');
  checks.push(state+' 首帧与交叉淡化像素一致');
 }
 return checks;
}
/**
 * 从 idle 首帧抽取有纹理的发丝采样，独立追踪实际图集头部的平移和旋转。
 * 采样避开眼嘴表情区域；以粗到细搜索测出最佳配准，再与眼镜的真实 Canvas 矩阵比较。
 */
async function trackAtlas(config,skin,url){
 const image=new Image();image.src=url;await image.decode();
 const cell=skin.cellSize,canvas=document.createElement('canvas');canvas.width=canvas.height=cell;
 const ctx=canvas.getContext('2d',{willReadFrequently:true});
 ctx.drawImage(image,0,0,cell,cell,0,0,cell,cell);
 const base=ctx.getImageData(0,0,cell,cell).data,samples=[];
 for(let y=60;y<175;y+=5)for(let x=70;x<315;x+=5){
  const i=(y*cell+x)*4,j=i+4;
  if(base[i+3]<250||Math.abs(base[i]-base[j])+Math.abs(base[i+1]-base[j+1])+Math.abs(base[i+2]-base[j+2])<18)continue;
  samples.push({x:x-cell/2,y:y-cell*config.glasses.motionOriginY,r:base[i],g:base[i+1],b:base[i+2]});
 }
 if(samples.length<40)throw new Error('发丝纹理采样不足');
 const layer=document.createElement('canvas');layer.width=layer.height=cell;
 const g=layer.getContext('2d'),translate=g.translate,rotate=g.rotate,scale=g.scale;
 let origin,angle,stretch;
 g.scale=function recordScale(x,y){if(!stretch)stretch={x,y};return scale.call(g,x,y);};
 g.translate=function recordTranslation(x,y){if(!origin)origin={x,y};return translate.call(g,x,y);};
 g.rotate=function recordRotation(value){if(angle===undefined)angle=value;return rotate.call(g,value);};
 const rows=[];
 for(const state of config.states){
  const clip=skin.animations[state];
  for(let frame=0;frame<clip.frames;frame++){
   ctx.clearRect(0,0,cell,cell);ctx.drawImage(image,frame*cell,clip.row*cell,cell,cell,0,0,cell,cell);
   const pixels=ctx.getImageData(0,0,cell,cell).data;
   origin=null;angle=undefined;stretch=null;DesktopPetGlasses.paint(g,config.glasses,skin,state,frame);
   /** 按双线性采样比较实际图集颜色，降低亚像素旋转重采样造成的误差。 */
   function score(tx,ty,a){
    const c=Math.cos(a),s=Math.sin(a);let error=0;
    for(const p of samples){
     const x=c*p.x*stretch.x-s*p.y*stretch.y+tx,y=s*p.x*stretch.x+c*p.y*stretch.y+ty,ix=Math.floor(x),iy=Math.floor(y),fx=x-ix,fy=y-iy,i=(iy*cell+ix)*4;
     for(let k=0;k<3;k++){
      const v=(pixels[i+k]*(1-fx)+pixels[i+4+k]*fx)*(1-fy)+(pixels[i+cell*4+k]*(1-fx)+pixels[i+cell*4+4+k]*fx)*fy;
      const original=k===0?p.r:k===1?p.g:p.b;error+=(v-original)*(v-original);
     }
    }
    return error/samples.length/3;
   }
   let best={x:origin.x,y:origin.y,a:angle,error:score(origin.x,origin.y,angle)},step=4;
   const initial=best.error;
   for(let pass=0;pass<4;pass++){
    const center=best;
    for(let dx=-2;dx<=2;dx++)for(let dy=-2;dy<=2;dy++)for(let da=-2;da<=2;da++){
     const x=center.x+dx*step,y=center.y+dy*step,a=center.a+da*step*Math.PI/360,error=score(x,y,a);
     if(error<best.error)best={x,y,a,error};
    }
    step/=2;
   }
   rows.push({state,frame,dx:best.x-origin.x,dy:best.y-origin.y,degrees:(best.a-angle)*180/Math.PI,initial,error:best.error});
  }
 }
 return {samples:samples.length,rows};
}
/** 在真实 Chromium 中执行纹理配准并保存实测记录。 */
async function run(){
 const win=new BrowserWindow({show:false,webPreferences:{webSecurity:false}});
 await win.loadURL('about:blank');
 const source=fs.readFileSync(path.join(root,'electron/lib/desktop-pet-glasses.js'),'utf8');
 const url=pathToFileURL(path.join(root,'electron/lib/desktop-pet-skins/cyber-neko/atlas.png')).href;
 const result=await win.webContents.executeJavaScript(source+'\n('+String(trackAtlas)+')('+JSON.stringify(config)+','+JSON.stringify(skin)+','+JSON.stringify(url)+')');
 const output=path.join(root,'generated/desktop-pet-glasses-check');fs.mkdirSync(output,{recursive:true});
 fs.writeFileSync(path.join(output,'motion-results.json'),JSON.stringify(result,null,2),'utf8');
 for(const row of result.rows)assert.ok(Math.abs(row.dx)<=0.5&&Math.abs(row.dy)<=0.5&&Math.abs(row.degrees)<=0.25&&row.initial<150,JSON.stringify(row));
 console.log('PASS 实际图集 '+result.rows.length+' 帧、'+result.samples+' 个发丝纹理采样与眼镜变换配准；最大修正 '+Math.max.apply(null,result.rows.map(function(row){return Math.hypot(row.dx,row.dy);}))+'px');
 const bar=require('../electron/lib/float-bar').createFloatBar({slotIndex:95,onBind:function(){}});bar.show();
 const actual=BrowserWindow.getAllWindows().find(function(one){return bar.ownsWindow(one);});
 for(let i=0;i<80;i++){await wait(100);if(await actual.webContents.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin)'))break;}
 // 在生产页面同时保存非零 X/Y，再核对动作切换实际像素，防止渲染调用漏传其中一轴。
 const adjusted=Object.assign({},config,{glasses:Object.assign({},config.glasses,{horizontalOffset:-3.5,verticalOffset:6.5})});
 await actual.webContents.executeJavaScript('desktopPet.call("settings",{glassesOffsetX:-3.5,glassesOffsetY:6.5})');
 actual.webContents.reload();
 await wait(1000);
 const transitions=await actual.webContents.executeJavaScript('('+String(checkTransitions)+')('+JSON.stringify(adjusted)+','+JSON.stringify(skin)+','+JSON.stringify(url)+')');
 result.transitions=transitions;fs.writeFileSync(path.join(output,'motion-results.json'),JSON.stringify(result,null,2),'utf8');
 for(const check of transitions)console.log('PASS '+check);
 actual.destroy();win.destroy();app.quit();
}
app.whenReady().then(run).catch(function failed(error){console.error(error.stack||error);app.exit(1);});
