'use strict';
const path=require('path');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
const sourcePath=path.join(__dirname,'../electron/lib/desktop-pet-skins/cyber-neko/painted-head-source.png');
app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const headUrl=pathToFileURL(sourcePath).href;
  const r=await win.webContents.executeJavaScript(`(async()=>{
    const head=new Image(); head.src=${JSON.stringify(headUrl)}; await head.decode();
    const w=head.width,h=head.height,c=document.createElement('canvas'); c.width=w;c.height=h;
    const ctx=c.getContext('2d'); ctx.drawImage(head,0,0); const d=ctx.getImageData(0,0,w,h).data;
    function score(x,y){ const o=(y*w+x)*4,r=d[o],g=d[o+1],b=d[o+2],a=d[o+3];
      if(a<50||g<140||b<120||g<r+10) return 0; return (g-r)+(b-r)*0.3+(g+b-280)*0.15; }
    // 按 x 把眼带分成桶，找两个山峰
    const eyeT=220, eyeB=380, buckets=new Array(w).fill(0), counts=new Array(w).fill(0);
    for(let y=eyeT;y<=eyeB;y++) for(let x=160;x<=560;x++){
      const sc=score(x,y); if(sc>10){ buckets[x]+=sc; counts[x]++; }
    }
    // 平滑
    const sm=new Array(w).fill(0);
    for(let x=5;x<w-5;x++){ let s=0; for(let k=-5;k<=5;k++) s+=buckets[x+k]; sm[x]=s/11; }
    let peaks=[];
    for(let x=180;x<=540;x++){
      if(sm[x]>sm[x-1] && sm[x]>=sm[x+1] && sm[x]>80) peaks.push({x:x,v:sm[x],n:counts[x]});
    }
    peaks.sort((a,b)=>b.v-a.v);
    // 取相距>50 的前两个
    const picked=[];
    for(const p of peaks){
      if(picked.every(q=>Math.abs(q.x-p.x)>50)) picked.push(p);
      if(picked.length>=4) break;
    }
    picked.sort((a,b)=>a.x-b.x);
    // 每个峰的 y 质心
    const detail=picked.map(p=>{
      let sy=0,sw=0,minY=1e9,maxY=-1;
      for(let y=eyeT;y<=eyeB;y++) for(let x=p.x-25;x<=p.x+25;x++){
        const sc=score(x,y); if(sc>10){ sy+=y*sc; sw+=sc; if(y<minY)minY=y; if(y>maxY)maxY=y; }
      }
      return {x:p.x,y:sw?Math.round(sy/sw):300,v:p.v,y0:minY,y1:maxY};
    });
    return {detail, topPeaks:peaks.slice(0,8)};
  })()`);
  console.log(JSON.stringify(r,null,2));
  win.destroy(); app.quit();
});
