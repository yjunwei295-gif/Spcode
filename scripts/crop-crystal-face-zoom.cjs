'use strict';
const fs=require('fs');
const path=require('path');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
const srcPath=path.join(__dirname,'../electron/lib/desktop-pet-skins/cyber-neko/painted-head-source.png');
const outPath=path.join(__dirname,'../generated/desktop-pet-check/crystal-face-zoom.png');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const b64=await win.webContents.executeJavaScript(`(async()=>{
    const img=new Image(); img.src=${JSON.stringify(pathToFileURL(srcPath).href)}; await img.decode();
    // 只裁脸中部：大约 250,250 - 520,560
    const sx=250, sy=250, sw=280, sh=320;
    const c=document.createElement('canvas'); c.width=sw*2; c.height=sh*2;
    const ctx=c.getContext('2d');
    ctx.imageSmoothingEnabled=false;
    ctx.drawImage(img,sx,sy,sw,sh,0,0,c.width,c.height);
    // 画网格与坐标，方便标嘴
    ctx.strokeStyle='rgba(255,255,0,0.35)'; ctx.lineWidth=1;
    for(let x=0;x<=sw;x+=20){ ctx.beginPath(); ctx.moveTo(x*2,0); ctx.lineTo(x*2,c.height); ctx.stroke(); }
    for(let y=0;y<=sh;y+=20){ ctx.beginPath(); ctx.moveTo(0,y*2); ctx.lineTo(c.width,y*2); ctx.stroke(); }
    ctx.fillStyle='#fff'; ctx.font='16px monospace';
    for(let y=0;y<=sh;y+=40){ ctx.fillText(String(sy+y), 4, y*2+14); }
    for(let x=0;x<=sw;x+=40){ ctx.fillText(String(sx+x), x*2+2, 14); }
    // 当前错误嘴框（源坐标）映射到裁切
    const mouth={L:335,T:385,R:445,B:445};
    ctx.strokeStyle='#ff2244'; ctx.lineWidth=3;
    ctx.strokeRect((mouth.L-sx)*2,(mouth.T-sy)*2,(mouth.R-mouth.L)*2,(mouth.B-mouth.T)*2);
    ctx.fillStyle='#ff2244'; ctx.fillText('WRONG mouth box', (mouth.L-sx)*2, (mouth.T-sy)*2-6);
    return c.toDataURL('image/png').split(',')[1];
  })()`);
  fs.writeFileSync(outPath, Buffer.from(b64,'base64'));
  console.log('wrote', outPath);
  win.destroy(); app.quit();
});
