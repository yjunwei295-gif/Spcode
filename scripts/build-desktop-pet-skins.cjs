// 用透明Canvas烘焙三套完整皮肤，输出运行时直接播放的PNG图集。
'use strict';
const fs=require('fs');
const path=require('path');
const {app,BrowserWindow}=require('electron');
const root=path.join(__dirname,'..');
const config=require('../electron/lib/desktop-pet-config.json');
// 原稿、配色和动作参数集中在皮肤目录，图集构建与独立预览复用同一份配置。
const vectorArt=require('../electron/lib/desktop-pet-skins/cyber-neko/art.json');
const definitions=[
{id:'cyber-neko',name:vectorArt.name,author:'SpCode',character:'cyber-neko',colors:vectorArt.colors},
{id:'spcode',name:'SpCode 电路伙伴',author:'SpCode',character:'robot',colors:{body:'#f7fcf9',ink:'#214e3e',accent:'#0e9f67',secondary:'#76dfb3'}},
{id:'cat',name:'奶油猫咪',author:'SpCode',character:'cat',colors:{body:'#f4d8b4',ink:'#654c3c',accent:'#388b75',secondary:'#d98e83'}}
];
/** 按固定帧序烘焙，保证同一份源码可以重新生成一致的图集。 */
async function build(){
  const win=new BrowserWindow({show:false,width:256,height:256,webPreferences:{offscreen:true}});
  await win.loadFile(path.join(root,'electron/lib/desktop-pet-bake.html'));
  // 在离屏页面解码每个矢量部件，高分辨率原稿只参与构建，不增加运行时解码负担。
  const vector=fs.readFileSync(path.join(root,'electron/lib/desktop-pet-vector.js'),'utf8');
  const source=fs.readFileSync(path.join(root,'electron/lib/desktop-pet-skins/cyber-neko/art.svg'),'utf8');
  await win.webContents.executeJavaScript(vector);
  await win.webContents.executeJavaScript('window.DesktopPetVector.prepare('+JSON.stringify(source)+','+JSON.stringify(vectorArt)+','+JSON.stringify(vectorArt.colors)+')');
  const art=fs.readFileSync(path.join(root,'electron/lib/desktop-pet-art.js'),'utf8');
  await win.webContents.executeJavaScript(art);
  for(const def of definitions){
    const manifest=Object.assign({version:1,atlas:'atlas.png',cellSize:192,columns:config.motion.frames,fps:config.motion.fps,anchor:[96,192],animations:{}},def);
    // 所有皮肤只烘焙工作协议中的动作，已取消躺卧姿态和空闲轮换。
    const states=config.states;
    for(let i=0;i<states.length;i++) manifest.animations[states[i]]={row:i,frames:config.motion.frames,loop:['success','landing'].indexOf(states[i])<0};
    const expression='(async function(){const def='+JSON.stringify(def)+';const config='+JSON.stringify(Object.assign({},config,{states:states}))+';const icon=new Image();icon.src='+JSON.stringify(require('url').pathToFileURL(path.join(root,'icons.png')).href)+';await icon.decode();const atlas=document.createElement("canvas");atlas.width=192*config.motion.frames;atlas.height=192*config.states.length;const ctx=atlas.getContext("2d");const cell=document.createElement("canvas");cell.width=192;cell.height=192;const c=cell.getContext("2d");for(let r=0;r<config.states.length;r++){for(let f=0;f<config.motion.frames;f++){window.DesktopPetArt.draw(c,def,config.states[r],(config.states[r]==="landing"||config.states[r]==="success")?f/(config.motion.frames-1):f/config.motion.frames,icon);ctx.drawImage(cell,f*192,r*192);}}return atlas.toDataURL("image/png").split(",")[1];})()';
    const png=await win.webContents.executeJavaScript(expression);
    const dir=path.join(root,'electron/lib/desktop-pet-skins',def.id);
    fs.writeFileSync(path.join(dir,'atlas.png'),Buffer.from(png,'base64'));
    fs.writeFileSync(path.join(dir,'skin.json'),JSON.stringify(manifest,null,2),'utf8');
    console.log(def.id+': '+states.length+' states, '+config.motion.frames+' frames each');
  }
  win.destroy();app.quit();
}
app.whenReady().then(build).catch(function(error){console.error(error);app.exit(1);});
