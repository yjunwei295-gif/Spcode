// 把认可插画头像素级复刻成代码绘制：读 remesh-rules.json 可编辑规则 → 去灰底 → fillRect 重画 → 写出规律。
'use strict';
const fs=require('fs');
const path=require('path');
const {pathToFileURL}=require('url');
const {app,BrowserWindow}=require('electron');

const root=path.join(__dirname,'..');
const skinDir=path.join(root,'electron/lib/desktop-pet-skins/cyber-neko');
const outDir=path.join(root,'generated/desktop-pet-check');
const rulesPath=path.join(skinDir,'remesh-rules.json');
const sourcePath=path.join(skinDir,'painted-head-source.png');

async function build(){
  if(!fs.existsSync(sourcePath)){
    console.error('missing painted-head-source.png');
    app.quit();
    return;
  }
  if(!fs.existsSync(rulesPath)){
    console.error('missing remesh-rules.json');
    app.quit();
    return;
  }
  // 可编辑规则：改 floodThresh/expandThresh/edgeStep 后重跑本脚本即可复现或调参
  const rules=JSON.parse(fs.readFileSync(rulesPath,'utf8'));
  const chroma=rules.chroma||{};
  const remeshOpt=rules.remesh||{};
  const edgeStep=chroma.edgeStep||8;
  const floodT=chroma.floodThresh||78;
  const expandT=chroma.expandThresh||95;
  const expandPasses=chroma.expandPasses||2;
  const opaqueMin=remeshOpt.opaqueAlphaMin||16;
  fs.mkdirSync(outDir,{recursive:true});
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const headUrl=pathToFileURL(sourcePath).href;
  const result=await win.webContents.executeJavaScript(`(async function(){
    const head=new Image(); head.src=${JSON.stringify(headUrl)}; await head.decode();
    const w=head.width, h=head.height;
    const raw=document.createElement('canvas'); raw.width=w; raw.height=h;
    const rc=raw.getContext('2d'); rc.drawImage(head,0,0);
    const img=rc.getImageData(0,0,w,h); const d=img.data;
    // 参数来自 remesh-rules.json，可改后重跑
    const edgeStep=${edgeStep}, floodT=${floodT}, expandT=${expandT}, expandPasses=${expandPasses}, opaqueMin=${opaqueMin};
    // 灰底带紫偏且四边色差大：稠密边缘采样 + 多档底色种子 + 边缘洪水，只清与边缘连通的底，不吞发/脸。
    function dist2(r,g,b,R,G,B){ const dr=r-R,dg=g-G,db=b-B; return dr*dr+dg*dg+db*db; }
    // 四角、内缩点、四边每隔 edgeStep px 采样，覆盖灰紫底渐变档位
    const samples=[];
    function addSample(x,y){ if(x<0||y<0||x>=w||y>=h) return; samples.push([x,y]); }
    addSample(0,0); addSample(w-1,0); addSample(0,h-1); addSample(w-1,h-1);
    addSample(20,20); addSample(w-21,20); addSample(20,h-21); addSample(w-21,h-21);
    addSample(8,8); addSample(w-9,8); addSample(8,h-9); addSample(w-9,h-9);
    for(let x=0;x<w;x+=edgeStep){ addSample(x,0); addSample(x,1); addSample(x,h-1); addSample(x,h-2); }
    for(let y=0;y<h;y+=edgeStep){ addSample(0,y); addSample(1,y); addSample(w-1,y); addSample(w-2,y); }
    let sr=0,sg=0,sb=0;
    const seeds=[];
    for(let si=0;si<samples.length;si++){
      const s=samples[si], o=(s[1]*w+s[0])*4;
      sr+=d[o]; sg+=d[o+1]; sb+=d[o+2];
      seeds.push([d[o],d[o+1],d[o+2]]);
    }
    const bgR=sr/samples.length, bgG=sg/samples.length, bgB=sb/samples.length;
    // floodT²：覆盖边缘灰紫底；仍远低于发色距(~199)
    const thresh2=floodT*floodT;
    // expandT²：膨胀清毛边
    const expandThresh2=expandT*expandT;
    function nearBg(r,g,b,limit2){
      if(dist2(r,g,b,bgR,bgG,bgB)<=limit2) return true;
      for(let i=0;i<seeds.length;i++){
        const s=seeds[i];
        if(dist2(r,g,b,s[0],s[1],s[2])<=limit2) return true;
      }
      return false;
    }
    const isBg=new Uint8Array(w*h);
    const qx=new Int32Array(w*h), qy=new Int32Array(w*h); let qh=0, qt=0;
    function tryPush(x,y){
      if(x<0||y<0||x>=w||y>=h) return;
      const id=y*w+x; if(isBg[id]) return;
      const o=id*4; if(d[o+3]<8){ isBg[id]=1; qx[qt]=x; qy[qt]=y; qt++; return; }
      if(nearBg(d[o],d[o+1],d[o+2],thresh2)){ isBg[id]=1; qx[qt]=x; qy[qt]=y; qt++; }
    }
    for(let x=0;x<w;x++){ tryPush(x,0); tryPush(x,h-1); }
    for(let y=0;y<h;y++){ tryPush(0,y); tryPush(w-1,y); }
    while(qh<qt){
      const x=qx[qh], y=qy[qh]; qh++;
      tryPush(x+1,y); tryPush(x-1,y); tryPush(x,y+1); tryPush(x,y-1);
    }
    // 按规则膨胀 N 圈：清毛边残留，只扩仍接近底色的像素
    let expand=new Uint8Array(isBg);
    for(let pass=0;pass<expandPasses;pass++){
      const next=new Uint8Array(expand);
      for(let y=1;y<h-1;y++){
        for(let x=1;x<w-1;x++){
          const id=y*w+x; if(expand[id]) continue;
          if(expand[id-1]||expand[id+1]||expand[id-w]||expand[id+w]){
            const o=id*4;
            if(nearBg(d[o],d[o+1],d[o+2],expandThresh2)) next[id]=1;
          }
        }
      }
      expand=next;
    }
    let keyed=0;
    for(let id=0;id<w*h;id++){
      if(expand[id]){ d[id*4+3]=0; keyed++; }
    }
    rc.putImageData(img,0,0);
    // 包围盒
    let L=w,T=h,R=-1,B=-1, opaque=0;
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        if(d[(y*w+x)*4+3]>opaqueMin){ opaque++; if(x<L)L=x; if(y<T)T=y; if(x>R)R=x; if(y>B)B=y; }
      }
    }
    // 配色桶：把 RGB 量化后统计主色（规律）
    const buckets=Object.create(null);
    for(let y=T;y<=B;y++){
      for(let x=L;x<=R;x++){
        const i=(y*w+x)*4; if(d[i+3]<opaqueMin) continue;
        const key=((d[i]>>3)<<10)|((d[i+1]>>3)<<5)|(d[i+2]>>3);
        if(!buckets[key]) buckets[key]={n:0,r:0,g:0,b:0};
        const bkt=buckets[key]; bkt.n++; bkt.r+=d[i]; bkt.g+=d[i+1]; bkt.b+=d[i+2];
      }
    }
    const palette=Object.keys(buckets).map(function(k){
      const b=buckets[k];
      return {n:b.n, r:Math.round(b.r/b.n), g:Math.round(b.g/b.n), b:Math.round(b.b/b.n)};
    }).sort(function(a,c){ return c.n-a.n; }).slice(0,24);

    // 像素级代码复刻：每个不透明像素 fillRect(1x1)
    const out=document.createElement('canvas'); out.width=w; out.height=h;
    const oc=out.getContext('2d');
    // 透明底
    oc.clearRect(0,0,w,h);
    let painted=0;
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        const i=(y*w+x)*4; const a=d[i+3];
        if(a<opaqueMin) continue;
        oc.fillStyle='rgba('+d[i]+','+d[i+1]+','+d[i+2]+','+(a/255)+')';
        oc.fillRect(x,y,1,1);
        painted++;
      }
    }

    // 对照页：棋盘格衬底，透明区域一眼可见，避免灰底残留被深色底板掩盖
    const board=document.createElement('canvas'); board.width=w*2+48; board.height=h+72;
    const bc=board.getContext('2d');
    bc.fillStyle='#1e2228'; bc.fillRect(0,0,board.width,board.height);
    function checker(ox,oy,size){
      for(let yy=0;yy<size;yy+=16) for(let xx=0;xx<size;xx+=16){
        bc.fillStyle=((xx+yy)/16)%2? '#3a404a':'#2a3038';
        bc.fillRect(ox+xx,oy+yy,16,16);
      }
    }
    checker(16,40,w); checker(w+32,40,w);
    bc.fillStyle='#d7dde8'; bc.font='20px sans-serif';
    bc.fillText('源图边缘洪水去底', 16, 28);
    bc.fillText('代码像素复刻（透明）', w+32, 28);
    bc.drawImage(raw, 16, 40);
    bc.drawImage(out, w+32, 40);

    // 区域采样规律：额/眼/发/领大致带
    function bandStats(y0,y1){
      const acc={r:0,g:0,b:0,n:0};
      for(let y=Math.max(T,y0); y<=Math.min(B,y1); y++){
        for(let x=L;x<=R;x++){
          const i=(y*w+x)*4; if(d[i+3]<opaqueMin) continue;
          acc.r+=d[i]; acc.g+=d[i+1]; acc.b+=d[i+2]; acc.n++;
        }
      }
      if(!acc.n) return null;
      return {r:Math.round(acc.r/acc.n),g:Math.round(acc.g/acc.n),b:Math.round(acc.b/acc.n),n:acc.n};
    }
    const hh=B-T+1;
    const laws={
      size:{w:w,h:h},
      bbox:{L:L,T:T,R:R,B:B,width:R-L+1,height:B-T+1},
      opaquePixels:opaque,
      paintedPixels:painted,
      bands:{
        hairTop: bandStats(T, T+Math.floor(hh*0.22)),
        faceMid: bandStats(T+Math.floor(hh*0.28), T+Math.floor(hh*0.55)),
        collar: bandStats(T+Math.floor(hh*0.72), B)
      },
      paletteTop24: palette,
      keyedPixels: keyed,
      bgSeed: {r:Math.round(bgR),g:Math.round(bgG),b:Math.round(bgB)},
      rulesUsed: {edgeStep:edgeStep, floodThresh:floodT, expandThresh:expandT, expandPasses:expandPasses, opaqueAlphaMin:opaqueMin},
      method: 'edge-flood chroma (purple-gray bg) -> fillRect(1x1) remesh',
      editableRulesPath: 'electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json'
    };

    return {
      remesh: out.toDataURL('image/png').split(',')[1],
      board: board.toDataURL('image/png').split(',')[1],
      cut: raw.toDataURL('image/png').split(',')[1],
      laws: laws
    };
  })()`);

  fs.writeFileSync(path.join(skinDir,'remesh-head.png'), Buffer.from(result.remesh,'base64'));
  fs.writeFileSync(path.join(outDir,'crystal-pixel-compare.png'), Buffer.from(result.board,'base64'));
  fs.writeFileSync(path.join(outDir,'crystal-laws.json'), JSON.stringify(result.laws,null,2), 'utf8');

  const p=result.laws.paletteTop24;
  const lines=[];
  lines.push('# 水晶猫娘头 · 像素复刻规律');
  lines.push('');
  lines.push('方法：去灰底后，对每个不透明像素用代码 `fillRect(x,y,1,1)` 按原色重画（像素级）。');
  lines.push('');
  lines.push('- 画布：'+result.laws.size.w+'×'+result.laws.size.h);
  lines.push('- 不透明包围盒：('+result.laws.bbox.L+','+result.laws.bbox.T+')-('+result.laws.bbox.R+','+result.laws.bbox.B+') 尺寸 '+result.laws.bbox.width+'×'+result.laws.bbox.height);
  lines.push('- 绘制像素数：'+result.laws.paintedPixels);
  lines.push('');
  lines.push('## 主色（量化后 Top）');
  for(let i=0;i<p.length && i<12;i++){
    const c=p[i];
    lines.push('- rgb('+c.r+','+c.g+','+c.b+') ×'+c.n);
  }
  lines.push('');
  lines.push('## 纵向色带均值');
  const bands=result.laws.bands;
  ['hairTop','faceMid','collar'].forEach(function(k){
    const b=bands[k];
    if(!b) return;
    lines.push('- '+k+': rgb('+b.r+','+b.g+','+b.b+') n='+b.n);
  });
  lines.push('');
  lines.push('## 产物');
  lines.push('- electron/lib/desktop-pet-skins/cyber-neko/remesh-head.png');
  lines.push('- generated/desktop-pet-check/crystal-pixel-compare.png');
  lines.push('- generated/desktop-pet-check/crystal-laws.json');
  fs.writeFileSync(path.join(outDir,'crystal-laws.md'), lines.join('\n'), 'utf8');

  console.log('remesh ok pixels='+result.laws.paintedPixels+' bbox='+result.laws.bbox.width+'x'+result.laws.bbox.height);
  win.destroy(); app.quit();
}

app.whenReady().then(build).catch(function(err){
  console.error(err);
  app.quit();
  process.exit(1);
});
