// 水晶猫娘高清烘焙：去底头图 + 五官表情（眨眼/嘴型）+ 大格图集，不再整张静图硬贴。
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow } = require('electron');
const root = path.join(__dirname, '..');
const skinDir = path.join(root, 'electron/lib/desktop-pet-skins/cyber-neko');
const config = require('../electron/lib/desktop-pet-config.json');
const vectorArt = require('../electron/lib/desktop-pet-skins/cyber-neko/art.json');
const remeshRules = require('../electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json');

async function build() {
  const win = new BrowserWindow({ show: false, width: 256, height: 256, webPreferences: { offscreen: true, webSecurity: false } });
  await win.loadFile(path.join(root, 'electron/lib/desktop-pet-bake.html'));

  const remeshFile = path.join(skinDir, 'remesh-head.png');
  const headFile = fs.existsSync(remeshFile) ? remeshFile : path.join(skinDir, 'painted-head-source.png');
  const headUrl = pathToFileURL(headFile).href;
  const states = config.states;
  const frames = config.motion.frames;
  const chroma = remeshRules.chroma || {};
  const bakeOpt = remeshRules.bake || {};
  // 优先用分析脚本输出的 landmarks，保证眼嘴框与原图实测一致
  const landmarksPath = path.join(root, 'generated/desktop-pet-check/crystal-face-landmarks.json');
  let face = remeshRules.face || {};
  if (fs.existsSync(landmarksPath)) {
    const lm = JSON.parse(fs.readFileSync(landmarksPath, 'utf8'));
    face = {
      说明: face.说明,
      paintMouth: face.paintMouth === true,
      paintBlink: face.paintBlink === true,
      size: lm.size || face.size,
      skinMean: lm.skinMean || face.skinMean,
      lidColor: face.lidColor || [210, 180, 220],
      lipColor: face.lipColor || [160, 90, 140],
      leftEye: lm.leftEye,
      rightEye: lm.rightEye,
      mouth: lm.mouth
    };
  }
  const expressions = remeshRules.expressions || {};
  const paintMouth = face.paintMouth === true;
  const paintBlink = face.paintBlink === true;
  const cell = bakeOpt.cellSize || 384;
  if (cell < 32 || cell > 512) throw new Error('bake.cellSize 必须在 32~512');
  const headMaxRatio = bakeOpt.headMaxRatio || 0.92;
  const edgeStep = chroma.edgeStep || 8;
  const floodT = chroma.floodThresh || 78;
  const expandT = chroma.expandThresh || 95;
  const expandPasses = chroma.expandPasses || 2;

  const png = await win.webContents.executeJavaScript(`(async function(){
    const head=new Image(); head.src=${JSON.stringify(headUrl)}; await head.decode();
    const raw=document.createElement('canvas'); raw.width=head.width; raw.height=head.height;
    const rc=raw.getContext('2d'); rc.drawImage(head,0,0);
    const img=rc.getImageData(0,0,raw.width,raw.height); const d=img.data;
    const w=raw.width, h=raw.height;
    const edgeStep=${edgeStep}, floodT=${floodT}, expandT=${expandT}, expandPasses=${expandPasses};
    function dist2(r,g,b,R,G,B){ const dr=r-R,dg=g-G,db=b-B; return dr*dr+dg*dg+db*db; }
    const samples=[];
    function addSample(x,y){ if(x<0||y<0||x>=w||y>=h) return; samples.push([x,y]); }
    addSample(0,0); addSample(w-1,0); addSample(0,h-1); addSample(w-1,h-1);
    addSample(20,20); addSample(w-21,20); addSample(20,h-21); addSample(w-21,h-21);
    addSample(8,8); addSample(w-9,8); addSample(8,h-9); addSample(w-9,h-9);
    for(let x=0;x<w;x+=edgeStep){ addSample(x,0); addSample(x,1); addSample(x,h-1); addSample(x,h-2); }
    for(let y=0;y<h;y+=edgeStep){ addSample(0,y); addSample(1,y); addSample(w-1,y); addSample(w-2,y); }
    let sr=0,sg=0,sb=0; const seeds=[];
    for(let si=0;si<samples.length;si++){
      const s=samples[si], o=(s[1]*w+s[0])*4;
      sr+=d[o]; sg+=d[o+1]; sb+=d[o+2]; seeds.push([d[o],d[o+1],d[o+2]]);
    }
    const bgR=sr/samples.length, bgG=sg/samples.length, bgB=sb/samples.length;
    const thresh2=floodT*floodT;
    const expandThresh2=expandT*expandT;
    function nearBg(r,g,b,limit2){
      if(dist2(r,g,b,bgR,bgG,bgB)<=limit2) return true;
      for(let i=0;i<seeds.length;i++){
        const s=seeds[i]; if(dist2(r,g,b,s[0],s[1],s[2])<=limit2) return true;
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
    while(qh<qt){ const x=qx[qh], y=qy[qh]; qh++; tryPush(x+1,y); tryPush(x-1,y); tryPush(x,y+1); tryPush(x,y-1); }
    let expand=new Uint8Array(isBg);
    for(let pass=0;pass<expandPasses;pass++){
      const next=new Uint8Array(expand);
      for(let y=1;y<h-1;y++){
        for(let x=1;x<w-1;x++){
          const id=y*w+x; if(expand[id]) continue;
          if(expand[id-1]||expand[id+1]||expand[id-w]||expand[id+w]){
            const o=id*4; if(nearBg(d[o],d[o+1],d[o+2],expandThresh2)) next[id]=1;
          }
        }
      }
      expand=next;
    }
    for(let id=0;id<w*h;id++){ if(expand[id]) d[id*4+3]=0; }
    rc.putImageData(img,0,0);
    let L=raw.width,T=raw.height,R=-1,B=-1;
    for(let y=0;y<raw.height;y++){
      for(let x=0;x<raw.width;x++){
        if(d[(y*raw.width+x)*4+3]>16){ if(x<L)L=x; if(y<T)T=y; if(x>R)R=x; if(y>B)B=y; }
      }
    }
    const pad=10; L=Math.max(0,L-pad); T=Math.max(0,T-pad); R=Math.min(raw.width-1,R+pad); B=Math.min(raw.height-1,B+pad);
    const bw=R-L+1, bh=B-T+1;
    const cut=document.createElement('canvas'); cut.width=bw; cut.height=bh;
    cut.getContext('2d').drawImage(raw,L,T,bw,bh,0,0,bw,bh);

    // 五官在源图坐标 → 裁切后局部坐标
    const face=${JSON.stringify(face)};
    const expressions=${JSON.stringify(expressions)};
    const motion=${JSON.stringify(vectorArt.motion)};
    const poses=${JSON.stringify(vectorArt.poses)};
    const palette=${JSON.stringify(vectorArt.colors)};
    function mapBox(box){
      if(!box) return null;
      return {
        L: box.L - L, T: box.T - T, R: box.R - L, B: box.B - T,
        cx: box.cx - L, cy: box.cy - T,
        w: box.R - box.L + 1, h: box.B - box.T + 1
      };
    }
    const leftEye=mapBox(face.leftEye);
    const rightEye=mapBox(face.rightEye);
    const mouthBox=mapBox(face.mouth);
    const skinMean=face.skinMean || [244,226,230];
    const lidColor=face.lidColor || [210,180,220];
    const lipColor=face.lipColor || [160,90,140];
    const doPaintMouth=${paintMouth};
    const doPaintBlink=${paintBlink};

    // 在透明头副本上画表情（源分辨率，清晰）
    function cloneHead(){
      const c=document.createElement('canvas'); c.width=bw; c.height=bh;
      c.getContext('2d').drawImage(cut,0,0);
      return c;
    }
    function applyBlink(ctx, eye, lidAmount){
      if(!eye || lidAmount<=0.02) return;
      const close=Math.max(0, Math.min(1, lidAmount));
      const cover=Math.floor(eye.h * close);
      if(cover<=0) return;
      // 上眼睑：实色盖住瞳孔，闭合多时画成一条缝，验收一眼能看出在眨眼
      ctx.fillStyle='rgba('+lidColor[0]+','+lidColor[1]+','+lidColor[2]+',0.96)';
      ctx.fillRect(eye.L-6, eye.T-8, eye.w+12, cover+10);
      ctx.strokeStyle='rgba(40,20,60,0.85)';
      ctx.lineWidth=4;
      ctx.beginPath();
      ctx.moveTo(eye.L-4, eye.T+cover);
      ctx.lineTo(eye.R+4, eye.T+cover-2);
      ctx.stroke();
    }
    function applyGlow(ctx, eye, glow){
      if(!eye) return;
      if(glow>=0.98 && glow<=1.02) return;
      const img=ctx.getImageData(Math.max(0,eye.L-4), Math.max(0,eye.T-4), eye.w+8, eye.h+8);
      const pd=img.data;
      const factor=glow;
      for(let i=0;i<pd.length;i+=4){
        const r=pd[i], g=pd[i+1], b=pd[i+2], a=pd[i+3];
        if(a<40) continue;
        // 只动青绿发光像素
        if(g>150 && g>r+12 && b>130){
          pd[i]=Math.max(0, Math.min(255, Math.round(r*Math.min(1, factor*0.9))));
          pd[i+1]=Math.max(0, Math.min(255, Math.round(g*factor)));
          pd[i+2]=Math.max(0, Math.min(255, Math.round(b*factor)));
        }
      }
      ctx.putImageData(img, Math.max(0,eye.L-4), Math.max(0,eye.T-4));
    }
    function paintMouth(ctx, profile, wave){
      if(!mouthBox) return;
      const m=mouthBox;
      // 先用更大肤色区盖住原斜笑，避免新旧嘴叠在一起
      ctx.save();
      ctx.fillStyle='rgb('+skinMean[0]+','+skinMean[1]+','+skinMean[2]+')';
      ctx.beginPath();
      ctx.ellipse(m.cx, m.cy, m.w*0.75, m.h*0.8, 0, 0, Math.PI*2);
      ctx.fill();
      // 几何嘴：线更粗、开合更大，状态之间肉眼可辨
      const kind=profile.mouth||'smile';
      let open=(profile.open||0.15);
      if(kind==='open') open = open + (wave+1)*0.18;
      const halfW=m.w*0.55;
      const baseY=m.cy;
      ctx.lineCap='round'; ctx.lineJoin='round';
      ctx.strokeStyle='rgb('+lipColor[0]+','+lipColor[1]+','+lipColor[2]+')';
      ctx.fillStyle='rgba('+Math.max(30,lipColor[0]-50)+','+Math.max(10,lipColor[1]-40)+','+Math.max(30,lipColor[2]-30)+',0.95)';
      ctx.lineWidth=5.5;
      if(kind==='frown'){
        ctx.beginPath();
        ctx.moveTo(m.cx-halfW, baseY+10);
        ctx.quadraticCurveTo(m.cx, baseY-18-open*18, m.cx+halfW, baseY+10);
        ctx.stroke();
      } else if(kind==='flat'){
        ctx.beginPath();
        ctx.moveTo(m.cx-halfW*0.9, baseY);
        ctx.lineTo(m.cx+halfW*0.9, baseY+1);
        ctx.stroke();
      } else if(kind==='open'){
        const oh=12+open*34;
        ctx.beginPath();
        ctx.moveTo(m.cx-halfW, baseY-4);
        ctx.lineTo(m.cx-halfW*0.3, baseY+oh);
        ctx.lineTo(m.cx+halfW*0.3, baseY+oh+2);
        ctx.lineTo(m.cx+halfW, baseY-2);
        ctx.closePath();
        ctx.fill(); ctx.stroke();
      } else {
        // smile：折纸斜笑，匹配原设
        const lift=10+open*22;
        ctx.beginPath();
        ctx.moveTo(m.cx-halfW, baseY-2);
        ctx.lineTo(m.cx-halfW*0.2, baseY+lift);
        ctx.lineTo(m.cx+halfW*0.15, baseY+lift*0.5);
        ctx.lineTo(m.cx+halfW, baseY-6);
        ctx.stroke();
        if(open>0.2){
          ctx.beginPath();
          ctx.moveTo(m.cx-halfW*0.55, baseY+2);
          ctx.lineTo(m.cx, baseY+lift*0.75);
          ctx.lineTo(m.cx+halfW*0.15, baseY+4);
          ctx.closePath();
          ctx.fill();
        }
      }
      ctx.restore();
    }
    function expressHead(state, wave, blinkPulse){
      const canvas=cloneHead();
      const ctx=canvas.getContext('2d');
      const profile=expressions[state]||expressions.idle||{lid:0.1,mouth:'smile',open:0.15,glow:1};
      let lid=profile.lid||0;
      // 周期眨眼：在 blinkPulse 高峰时额外闭合
      if(blinkPulse>0.7) lid = Math.max(lid, 0.15 + (blinkPulse-0.7)/0.3*0.85);
      // paintBlink/paintMouth 来自 remesh-rules.face，false 时保住原插画五官
      if(doPaintBlink){
        applyBlink(ctx, leftEye, lid);
        applyBlink(ctx, rightEye, lid);
      }
      applyGlow(ctx, leftEye, profile.glow||1);
      applyGlow(ctx, rightEye, profile.glow||1);
      if(doPaintMouth){
        paintMouth(ctx, profile, wave);
      }
      return canvas;
    }

    function badge(c,x,y,rad,fill){
      c.beginPath(); c.arc(x,y,rad,0,Math.PI*2); c.fillStyle=fill; c.fill();
      c.strokeStyle=palette.ink; c.lineWidth=4; c.stroke();
    }
    function prop(c,state,wave){
      if(state==='idle'||state==='dragging'||state==='landing') return;
      const ox=cell*0.78, oy=cell*0.22, sc=cell/192;
      if(state==='thinking'||state==='speaking'){
        badge(c,ox,oy,18*sc,palette.secondary);
        c.fillStyle=palette.jacket; c.fillRect(ox-12*sc,oy-8*sc,24*sc,14*sc);
      } else if(state==='error'){
        badge(c,ox,oy,18*sc,palette.error);
        c.strokeStyle=palette.ink; c.lineWidth=4*sc;
        c.beginPath(); c.moveTo(ox-7*sc,oy-7*sc); c.lineTo(ox+7*sc,oy+7*sc);
        c.moveTo(ox+7*sc,oy-7*sc); c.lineTo(ox-7*sc,oy+7*sc); c.stroke();
      } else if(state==='success'){
        badge(c,ox,oy,18*sc,palette.accent);
        c.strokeStyle=palette.ink; c.lineWidth=4*sc;
        c.beginPath(); c.moveTo(ox-7*sc,oy); c.lineTo(ox-2*sc,oy+7*sc); c.lineTo(ox+9*sc,oy-7*sc); c.stroke();
      } else {
        badge(c,ox,oy,16*sc,palette.hair);
        c.fillStyle=palette.jacket; c.font='bold '+Math.round(12*sc)+'px sans-serif';
        c.fillText(state[0].toUpperCase(), ox-5*sc, oy+4*sc);
      }
    }

    const cell=${cell}, frames=${frames}, states=${JSON.stringify(states)}, headMaxRatio=${headMaxRatio};
    const atlas=document.createElement('canvas');
    atlas.width=cell*frames; atlas.height=cell*states.length;
    const actx=atlas.getContext('2d');
    const cellCanvas=document.createElement('canvas'); cellCanvas.width=cell; cellCanvas.height=cell;
    const c=cellCanvas.getContext('2d');

    // 预生成每状态一帧的表情头，同状态内再随 wave 微调嘴/眨眼（说话口型每帧重画）
    for(let r=0;r<states.length;r++){
      const state=states[r];
      for(let f=0;f<frames;f++){
        const t=(state==='landing'||state==='success')?f/(frames-1):f/frames;
        const wave=Math.sin(t*Math.PI*2);
        // 眨眼脉冲：每圈一次，落在 0.78~0.92
        const phase=(t+0.84)%1;
        const blinkPulse = phase>0.78 && phase<0.92 ? (1-Math.abs(phase-0.85)/0.07) : 0;
        let bounce=wave*motion.bounce*0.45;
        if(state==='success') bounce=-Math.pow(Math.sin(t*Math.PI),2)*motion.successJump*0.4;
        if(state==='dragging') bounce=-motion.dragLift*0.4+wave;
        const expressed=expressHead(state, wave, blinkPulse);
        c.clearRect(0,0,cell,cell);
        c.fillStyle='rgba(25,32,55,.10)';
        c.beginPath(); c.ellipse(cell/2, cell*0.95, cell*0.14, cell*0.02, 0,0,Math.PI*2); c.fill();
        c.save();
        const tilt=((poses[state]&&poses[state][4])||0)*0.55 + wave*motion.hairSwing*0.35;
        c.translate(cell/2, cell*0.56 + bounce);
        c.rotate(tilt*Math.PI/180);
        const maxH=cell*headMaxRatio, maxW=cell*headMaxRatio;
        const scale=Math.min(maxW/bw, maxH/bh);
        const dw=bw*scale, dh=bh*scale;
        // 高清缩放：先关平滑画整数倍，再开高质量收尾
        c.imageSmoothingEnabled=true;
        c.imageSmoothingQuality='high';
        c.drawImage(expressed, -dw/2, -dh*0.52, dw, dh);
        c.restore();
        prop(c, state, wave);
        actx.drawImage(cellCanvas, f*cell, r*cell);
      }
    }
    // 额外导出表情对照条（idle/thinking/speaking/success/error）方便验收
    const show=['idle','thinking','speaking','success','error'];
    const strip=document.createElement('canvas');
    strip.width=cell*show.length; strip.height=cell+48;
    const sc=strip.getContext('2d');
    sc.fillStyle='#1e2228'; sc.fillRect(0,0,strip.width,strip.height);
    sc.fillStyle='#d7dde8'; sc.font='22px sans-serif';
    for(let i=0;i<show.length;i++){
      const state=show[i];
      const row=states.indexOf(state);
      sc.drawImage(atlas, 0, row*cell, cell, cell, i*cell, 40, cell, cell);
      sc.fillText(state, i*cell+16, 30);
    }
    return {
      atlas: atlas.toDataURL('image/png').split(',')[1],
      strip: strip.toDataURL('image/png').split(',')[1],
      cut: cut.toDataURL('image/png').split(',')[1],
      cell: cell,
      bbox: {L:L,T:T,R:R,B:B,bw:bw,bh:bh}
    };
  })()`);

  fs.writeFileSync(path.join(skinDir, 'atlas.png'), Buffer.from(png.atlas, 'base64'));
  fs.writeFileSync(path.join(skinDir, 'painted-head.png'), Buffer.from(png.cut, 'base64'));
  const outDir = path.join(root, 'generated/desktop-pet-check');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'crystal-expression-strip.png'), Buffer.from(png.strip, 'base64'));

  const manifest = {
    version: 1,
    id: 'cyber-neko',
    name: vectorArt.name,
    author: 'SpCode',
    character: 'cyber-neko',
    colors: vectorArt.colors,
    atlas: 'atlas.png',
    cellSize: cell,
    columns: frames,
    fps: config.motion.fps,
    anchor: [cell / 2, cell],
    animations: {}
  };
  for (let i = 0; i < states.length; i++) {
    manifest.animations[states[i]] = {
      row: i,
      frames: frames,
      loop: ['success', 'landing'].indexOf(states[i]) < 0
    };
  }
  fs.writeFileSync(path.join(skinDir, 'skin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log('cyber-neko HD atlas cell=' + cell + ' states=' + states.length + ' frames=' + frames + ' bbox=' + png.bbox.bw + 'x' + png.bbox.bh);
  win.destroy();
  app.quit();
}

app.whenReady().then(build).catch(function (err) {
  console.error(err);
  process.exit(1);
});
