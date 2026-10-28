'use strict';
const path=require('path');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
const fs=require('fs');
const srcPath=path.join(__dirname,'../electron/lib/desktop-pet-skins/cyber-neko/painted-head-source.png');
const outPath=path.join(__dirname,'../generated/desktop-pet-check/crystal-mouth-probe.png');
const jsonPath=path.join(__dirname,'../generated/desktop-pet-check/crystal-mouth-probe.json');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const img=new Image(); img.src=${JSON.stringify(pathToFileURL(srcPath).href)}; await img.decode();
    const w=img.width,h=img.height;
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const ctx=c.getContext('2d'); ctx.drawImage(img,0,0);
    const d=ctx.getImageData(0,0,w,h).data;
    // 眼睛大约在 y=300~360，鼻子错误框 385~445，真嘴应在更低
    // 在 y=450~560、x=300~480 找「比周围肤色暗」的唇线
    const y0=450, y1=560, x0=300, x1=480;
    function lum(x,y){ const o=(y*w+x)*4; return d[o]*0.3+d[o+1]*0.5+d[o+2]*0.2; }
    function isSkin(x,y){ const o=(y*w+x)*4; return d[o+3]>40 && d[o]>200 && d[o+1]>180 && d[o+2]>180; }
    let skinL=0, sn=0;
    for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
      if(isSkin(x,y)){ skinL+=lum(x,y); sn++; }
    }
    skinL = sn? skinL/sn : 220;
    const lips=[];
    for(let y=y0;y<=y1;y++) for(let x=x0;x<=x1;x++){
      const o=(y*w+x)*4; if(d[o+3]<40) continue;
      if(lum(x,y) < skinL - 12) lips.push([x,y]);
    }
    let L=1e9,T=1e9,R=-1,B=-1;
    for(const p of lips){ if(p[0]<L)L=p[0]; if(p[1]<T)T=p[1]; if(p[0]>R)R=p[0]; if(p[1]>B)B=p[1]; }
    // 双眼：在 y=280~370 找左右两个亮青/紫发光簇
    function glowScore(x,y){
      const o=(y*w+x)*4,r=d[o],g=d[o+1],b=d[o+2],a=d[o+3];
      if(a<50) return 0;
      // 青或亮紫瞳
      if(g>160 && b>150 && (g>r+10 || b>r+20)) return (g+b-r);
      return 0;
    }
    const buckets=new Array(w).fill(0);
    for(let y=280;y<=370;y++) for(let x=250;x<=520;x++){
      const sc=glowScore(x,y); if(sc>40) buckets[x]+=sc;
    }
    const sm=new Array(w).fill(0);
    for(let x=8;x<w-8;x++){ let s=0; for(let k=-8;k<=8;k++) s+=buckets[x+k]; sm[x]=s/17; }
    const peaks=[];
    for(let x=260;x<=510;x++){
      if(sm[x]>sm[x-1] && sm[x]>=sm[x+1] && sm[x]>200) peaks.push({x,v:sm[x]});
    }
    peaks.sort((a,b)=>b.v-a.v);
    const picked=[];
    for(const p of peaks){
      if(picked.every(q=>Math.abs(q.x-p.x)>55)) picked.push(p);
      if(picked.length>=2) break;
    }
    picked.sort((a,b)=>a.x-b.x);
    function eyeAt(px){
      let sy=0,sw=0,minY=1e9,maxY=-1,minX=1e9,maxX=-1;
      for(let y=280;y<=370;y++) for(let x=px-32;x<=px+32;x++){
        const sc=glowScore(x,y); if(sc>40){ sy+=y*sc; sw+=sc; if(y<minY)minY=y; if(y>maxY)maxY=y; if(x<minX)minX=x; if(x>maxX)maxX=x; }
      }
      if(!sw) return null;
      return {L:minX,T:minY,R:maxX,B:maxY,cx:px,cy:Math.round(sy/sw)};
    }
    const leftEye=eyeAt(picked[0]&&picked[0].x);
    const rightEye=eyeAt(picked[1]&&picked[1].x);
    const mouth = lips.length>20 ? {L:L-2,T:T-2,R:R+2,B:B+2,cx:(L+R)/2,cy:(T+B)/2,n:lips.length} : null;
    // 标注图
    const mark=document.createElement('canvas'); mark.width=w; mark.height=h;
    const mc=mark.getContext('2d'); mc.drawImage(img,0,0);
    function box(b,col,lab){ if(!b)return; mc.strokeStyle=col; mc.lineWidth=4; mc.strokeRect(b.L,b.T,b.R-b.L,b.B-b.T); mc.fillStyle=col; mc.font='22px sans-serif'; mc.fillText(lab,b.L,b.T-6); }
    box(leftEye,'#00ffcc','L-eye');
    box(rightEye,'#66aaff','R-eye');
    box(mouth,'#ff6688','mouth-FIXED');
    // 旧错误框对比
    mc.strokeStyle='#ffff00'; mc.lineWidth=2; mc.strokeRect(335,385,110,60); mc.fillStyle='#ffff00'; mc.fillText('old-wrong',340,380);
    return {
      leftEye, rightEye, mouth, peaks:picked, lipCount:lips.length, skinL,
      mark: mark.toDataURL('image/png').split(',')[1]
    };
  })()`);
  fs.writeFileSync(outPath, Buffer.from(result.mark,'base64'));
  delete result.mark;
  fs.writeFileSync(jsonPath, JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
  win.destroy(); app.quit();
});
