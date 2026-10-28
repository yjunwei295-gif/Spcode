'use strict';
const fs=require('fs');
const path=require('path');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
const root=path.join(__dirname,'..');
const atlasPath=path.join(root,'electron/lib/desktop-pet-skins/cyber-neko/atlas.png');
const outPath=path.join(root,'generated/desktop-pet-check/crystal-expr-compare.png');
const markPath=path.join(root,'generated/desktop-pet-check/crystal-face-on-source.png');
const sourcePath=path.join(root,'electron/lib/desktop-pet-skins/cyber-neko/painted-head-source.png');
const rules=require('../electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json');

app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const atlas=new Image(); atlas.src=${JSON.stringify(pathToFileURL(atlasPath).href)}; await atlas.decode();
    const src=new Image(); src.src=${JSON.stringify(pathToFileURL(sourcePath).href)}; await src.decode();
    const cell=384;
    const rows=[0,2,11,12,13]; // idle speaking success error stopped
    const names=['idle','speaking','success','error','stopped'];
    const board=document.createElement('canvas');
    board.width=cell*5+48; board.height=cell+80;
    const bc=board.getContext('2d');
    bc.fillStyle='#1a1d22'; bc.fillRect(0,0,board.width,board.height);
    bc.fillStyle='#e8edf5'; bc.font='24px sans-serif';
    for(let i=0;i<rows.length;i++){
      bc.drawImage(atlas, 0, rows[i]*cell, cell, cell, 16+i*(cell+4), 48, cell, cell);
      bc.fillText(names[i], 24+i*(cell+4), 36);
    }
    // 源图上画五官框，核对是否对准
    const mark=document.createElement('canvas'); mark.width=src.width; mark.height=src.height;
    const mc=mark.getContext('2d'); mc.drawImage(src,0,0);
    const face=${JSON.stringify(rules.face)};
    function box(b,col,label){
      if(!b) return;
      mc.strokeStyle=col; mc.lineWidth=4;
      mc.strokeRect(b.L,b.T,b.R-b.L,b.B-b.T);
      mc.fillStyle=col; mc.font='22px sans-serif'; mc.fillText(label, b.L, b.T-8);
    }
    box(face.leftEye,'#00ffcc','L-eye');
    box(face.rightEye,'#66aaff','R-eye');
    box(face.mouth,'#ff6688','mouth');
    return { board: board.toDataURL('image/png').split(',')[1], mark: mark.toDataURL('image/png').split(',')[1] };
  })()`);
  fs.writeFileSync(outPath, Buffer.from(result.board,'base64'));
  fs.writeFileSync(markPath, Buffer.from(result.mark,'base64'));
  console.log('wrote', outPath, markPath);
  win.destroy(); app.quit();
});
