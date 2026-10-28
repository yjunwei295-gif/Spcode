'use strict';
const path=require('path');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
const fs=require('fs');
const atlasPath=path.join(__dirname,'../electron/lib/desktop-pet-skins/cyber-neko/atlas.png');
const outPath=path.join(__dirname,'../generated/desktop-pet-check/crystal-expr-diff.json');
const diffPng=path.join(__dirname,'../generated/desktop-pet-check/crystal-expr-diff.png');

app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const atlas=new Image(); atlas.src=${JSON.stringify(pathToFileURL(atlasPath).href)}; await atlas.decode();
    const cell=384;
    function grab(row){
      const c=document.createElement('canvas'); c.width=cell; c.height=cell;
      c.getContext('2d').drawImage(atlas,0,row*cell,cell,cell,0,0,cell,cell);
      return c.getContext('2d').getImageData(0,0,cell,cell);
    }
    function diff(a,b){
      let n=0, max=0; const heat=new Uint8ClampedArray(a.data.length);
      for(let i=0;i<a.data.length;i+=4){
        const dr=Math.abs(a.data[i]-b.data[i]);
        const dg=Math.abs(a.data[i+1]-b.data[i+1]);
        const db=Math.abs(a.data[i+2]-b.data[i+2]);
        const da=Math.abs(a.data[i+3]-b.data[i+3]);
        const s=dr+dg+db+da;
        if(s>30){ n++; if(s>max) max=s; heat[i]=255; heat[i+1]=40; heat[i+2]=40; heat[i+3]=220; }
        else { heat[i]=a.data[i]; heat[i+1]=a.data[i+1]; heat[i+2]=a.data[i+2]; heat[i+3]=Math.floor(a.data[i+3]*0.25); }
      }
      return {n:n,max:max,heat:heat};
    }
    const idle=grab(0), speaking=grab(2), stopped=grab(13), error=grab(12);
    const d1=diff(idle,speaking), d2=diff(idle,stopped), d3=diff(idle,error);
    const board=document.createElement('canvas'); board.width=cell*3+32; board.height=cell+40;
    const bc=board.getContext('2d');
    bc.fillStyle='#111'; bc.fillRect(0,0,board.width,board.height);
    function putHeat(diffObj,x){
      const img=new ImageData(diffObj.heat, cell, cell);
      const tmp=document.createElement('canvas'); tmp.width=cell; tmp.height=cell;
      tmp.getContext('2d').putImageData(img,0,0);
      bc.drawImage(tmp,x,32);
    }
    putHeat(d1,8); putHeat(d2,16+cell); putHeat(d3,24+cell*2);
    bc.fillStyle='#fff'; bc.font='18px sans-serif';
    bc.fillText('idle vs speaking '+d1.n, 8, 24);
    bc.fillText('idle vs stopped '+d2.n, 16+cell, 24);
    bc.fillText('idle vs error '+d3.n, 24+cell*2, 24);
    return {
      speaking: {changed:d1.n,max:d1.max},
      stopped: {changed:d2.n,max:d2.max},
      error: {changed:d3.n,max:d3.max},
      png: board.toDataURL('image/png').split(',')[1]
    };
  })()`);
  fs.writeFileSync(diffPng, Buffer.from(result.png,'base64'));
  delete result.png;
  fs.writeFileSync(outPath, JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  win.destroy(); app.quit();
});
