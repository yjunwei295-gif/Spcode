'use strict';
const path=require('path');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
const fs=require('fs');
const srcPath=path.join(__dirname,'../electron/lib/desktop-pet-skins/cyber-neko/painted-head-source.png');
const outPath=path.join(__dirname,'../generated/desktop-pet-check/crystal-face-fixed.png');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const img=new Image(); img.src=${JSON.stringify(pathToFileURL(srcPath).href)}; await img.decode();
    const w=img.width,h=img.height;
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const ctx=c.getContext('2d'); ctx.drawImage(img,0,0);
    const d=ctx.getImageData(0,0,w,h).data;
    function lum(x,y){ const o=(y*w+x)*4; return d[o]*0.3+d[o+1]*0.5+d[o+2]*0.2; }
    // 在 448~530 每行统计偏暗像素数，取最密的连续带
    const rows=[];
    for(let y=448;y<=530;y++){
      let n=0, sx=0;
      for(let x=320;x<=460;x++){
        if(lum(x,y)<215){ n++; sx+=x; }
      }
      rows.push({y,n,cx:n?sx/n:390});
    }
    rows.sort((a,b)=>b.n-a.n);
    const top=rows.slice(0,12).map(r=>r.y).sort((a,b)=>a-b);
    const T=top[0], B=top[top.length-1];
    // 在该带内取左右边界
    let L=1e9,R=-1, sumx=0, nn=0;
    for(let y=T;y<=B;y++) for(let x=320;x<=460;x++){
      if(lum(x,y)<215){ if(x<L)L=x; if(x>R)R=x; sumx+=x; nn++; }
    }
    const mouth={L:L-4,T:T-4,R:R+4,B:B+6,cx:nn?sumx/nn:(L+R)/2,cy:(T+B)/2};
    const leftEye={L:275,T:285,R:335,B:340,cx:305,cy:312};
    const rightEye={L:355,T:290,R:420,B:350,cx:387,cy:320};
    const mark=document.createElement('canvas'); mark.width=w; mark.height=h;
    const mc=mark.getContext('2d'); mc.drawImage(img,0,0);
    function box(b,col,lab){ mc.strokeStyle=col; mc.lineWidth=4; mc.strokeRect(b.L,b.T,b.R-b.L,b.B-b.T); mc.fillStyle=col; mc.font='22px sans-serif'; mc.fillText(lab,b.L,b.T-6); }
    box(leftEye,'#00ffcc','L-eye');
    box(rightEye,'#66aaff','R-eye');
    box(mouth,'#ff6688','mouth');
    mc.strokeStyle='#ffff00'; mc.lineWidth=2; mc.strokeRect(335,385,110,60); mc.fillText('OLD-WRONG',340,378);
    return {mouth,leftEye,rightEye,topRows:rows.slice(0,8), mark:mark.toDataURL('image/png').split(',')[1]};
  })()`);
  fs.writeFileSync(outPath, Buffer.from(result.mark,'base64'));
  delete result.mark;
  console.log(JSON.stringify(result,null,2));
  win.destroy(); app.quit();
});
