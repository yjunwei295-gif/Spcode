// 分析水晶猫娘源图：用青绿瞳孔峰值定位双眼与嘴，写出 landmarks 供表情烘焙。
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { pathToFileURL } = require('url');

const root = path.join(__dirname, '..');
const skinDir = path.join(root, 'electron/lib/desktop-pet-skins/cyber-neko');
const sourcePath = path.join(skinDir, 'painted-head-source.png');
const outDir = path.join(root, 'generated/desktop-pet-check');

app.whenReady().then(async function () {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { offscreen: true, webSecurity: false } });
  await win.loadURL('about:blank');
  const headUrl = pathToFileURL(sourcePath).href;
  const result = await win.webContents.executeJavaScript(`(async function(){
    const head=new Image(); head.src=${JSON.stringify(headUrl)}; await head.decode();
    const w=head.width, h=head.height;
    const c=document.createElement('canvas'); c.width=w; c.height=h;
    const ctx=c.getContext('2d'); ctx.drawImage(head,0,0);
    const img=ctx.getImageData(0,0,w,h); const d=img.data;
    function at(x,y){ const o=(y*w+x)*4; return [d[o],d[o+1],d[o+2],d[o+3]]; }
    const corners=[at(0,0),at(w-1,0),at(0,h-1),at(w-1,h-1)];
    let br=0,bg=0,bb=0; for(let i=0;i<4;i++){ br+=corners[i][0]; bg+=corners[i][1]; bb+=corners[i][2]; }
    br/=4; bg/=4; bb/=4;
    function isBg(r,g,b,a){ if(a<16) return true; const dr=r-br,dg=g-bg,db=b-bb; return dr*dr+dg*dg+db*db<78*78; }
    function isSkin(r,g,b,a){ return a>40 && r>205 && g>185 && b>185 && r>=g-5 && (r-b)<55; }
    // 瞳孔分数：青绿且很亮，排除灰底与暗红
    function pupilScore(r,g,b,a){
      if(a<50) return 0;
      if(g<160 || b<140) return 0;
      if(g < r+15) return 0;
      // 越亮越青分越高
      return (g-r) + (b-r)*0.35 + (g+b-320)*0.2;
    }
    // 先找肤色包围，收窄搜索
    let sL=w,sT=h,sR=-1,sB=-1, sn=0;
    for(let y=0;y<h;y++) for(let x=0;x<w;x++){
      const p=at(x,y); if(!isSkin(p[0],p[1],p[2],p[3])) continue;
      sn++; if(x<sL)sL=x; if(y<sT)sT=y; if(x>sR)sR=x; if(y>sB)sB=y;
    }
    const face={L:sL,T:sT,R:sR,B:sB,w:sR-sL+1,h:sB-sT+1,n:sn};
    // 眼带：脸高 28%~48%
    const eyeT = Math.round(sT + face.h*0.28);
    const eyeB = Math.round(sT + face.h*0.48);
    const eyeL = Math.round(sL + face.w*0.12);
    const eyeR = Math.round(sL + face.w*0.88);
    // 热力找峰值
    let best=[], heat=[];
    for(let y=eyeT;y<=eyeB;y++){
      for(let x=eyeL;x<=eyeR;x++){
        const p=at(x,y); const sc=pupilScore(p[0],p[1],p[2],p[3]);
        if(sc>18){ heat.push({x:x,y:y,sc:sc,r:p[0],g:p[1],b:p[2]}); }
      }
    }
    // 左右外区各自取最高瞳孔峰：中间留出双眼间距，避免两峰贴在脸中
    const midX = Math.round((eyeL + eyeR) / 2);
    const minEyeDist = Math.max(70, Math.round(face.w * 0.13));
    const leftMaxX = midX - Math.round(minEyeDist / 2);
    const rightMinX = midX + Math.round(minEyeDist / 2);
    let leftPeak=null, rightPeak=null;
    for(let i=0;i<heat.length;i++){
      const cand=heat[i];
      if(cand.x <= leftMaxX){
        if(!leftPeak || cand.sc>leftPeak.sc) leftPeak=cand;
      } else if(cand.x >= rightMinX){
        if(!rightPeak || cand.sc>rightPeak.sc) rightPeak=cand;
      }
    }
    const peaks=[];
    if(leftPeak) peaks.push(leftPeak);
    if(rightPeak) peaks.push(rightPeak);
    peaks.sort(function(a,b){ return a.x-b.x; });
    function eyeAround(peak){
      if(!peak) return null;
      // 固定半径框住瞳孔，避免发光拖尾把框拉歪
      const hw=28, hh=22;
      const L=Math.max(0, peak.x-hw), R=Math.min(w-1, peak.x+hw);
      const T=Math.max(0, peak.y-hh), B=Math.min(h-1, peak.y+hh);
      return {L:L,T:T,R:R,B:B,cx:peak.x,cy:peak.y,w:R-L+1,h:B-T+1,n:1,
        mean:[peak.r,peak.g,peak.b], peak:peak};
    }
    const leftEye=eyeAround(leftPeak);
    const rightEye=eyeAround(rightPeak);
    // 眼框不得越过脸中线，防止左右框重叠
    if(leftEye && leftEye.R > midX){ leftEye.R=midX; leftEye.w=leftEye.R-leftEye.L+1; leftEye.cx=(leftEye.L+leftEye.R)/2; }
    if(rightEye && rightEye.L < midX){ rightEye.L=midX; rightEye.w=rightEye.R-rightEye.L+1; rightEye.cx=(rightEye.L+rightEye.R)/2; }
    // 嘴框：按双眼几何下移，避开鼻梁暗部（深色搜索会误贴鼻梁）
    let mouth=null, skinMean=[244,229,233];
    if(leftEye && rightEye){
      const eyeDist = Math.max(48, Math.abs(rightEye.cx - leftEye.cx));
      const eyeMidY = (leftEye.cy + rightEye.cy) / 2;
      const mcx = (leftEye.cx + rightEye.cx) / 2;
      // 嘴心约在眼距 1.2 倍下方；框高约眼距 0.55，宽约眼距 1.15
      const mcy = eyeMidY + eyeDist * 1.2;
      const halfW = eyeDist * 0.58;
      const halfH = eyeDist * 0.28;
      const mL = Math.round(mcx - halfW);
      const mR = Math.round(mcx + halfW);
      const mT = Math.round(mcy - halfH);
      const mB = Math.round(mcy + halfH);
      let sr=0,sg=0,sb=0,sn2=0;
      for(let y=mT;y<=mB;y++) for(let x=mL;x<=mR;x++){
        if(x<0||y<0||x>=w||y>=h) continue;
        const p=at(x,y); if(!isSkin(p[0],p[1],p[2],p[3])) continue;
        sr+=p[0]; sg+=p[1]; sb+=p[2]; sn2++;
      }
      if(sn2) skinMean=[Math.round(sr/sn2),Math.round(sg/sn2),Math.round(sb/sn2)];
      mouth={L:mL,T:mT,R:mR,B:mB,cx:mcx,cy:mcy,w:mR-mL+1,h:mB-mT+1,n:sn2, method:'eye-anatomy'};
    }
    // 标注
    const mark=document.createElement('canvas'); mark.width=w; mark.height=h;
    const mc=mark.getContext('2d'); mc.drawImage(head,0,0);
    function box(b,col){ if(!b)return; mc.strokeStyle=col; mc.lineWidth=3; mc.strokeRect(b.L,b.T,b.w,b.h); mc.fillStyle=col; mc.fillRect(b.cx-3,b.cy-3,6,6); }
    mc.strokeStyle='#ffe566'; mc.lineWidth=2; mc.strokeRect(face.L,face.T,face.w,face.h);
    box(leftEye,'#00ffcc'); box(rightEye,'#66aaff'); box(mouth,'#ff6688');
    mc.fillStyle='#fff'; mc.font='20px sans-serif';
    if(leftEye) mc.fillText('L-eye', leftEye.L, leftEye.T-8);
    if(rightEye) mc.fillText('R-eye', rightEye.L, rightEye.T-8);
    if(mouth) mc.fillText('mouth', mouth.L, mouth.T-8);
    return {
      size:{w:w,h:h}, face:face, leftEye:leftEye, rightEye:rightEye, mouth:mouth,
      skinMean:skinMean, eyeBand:{L:eyeL,T:eyeT,R:eyeR,B:eyeB},
      peaks:peaks, heatCount:heat.length,
      mark:mark.toDataURL('image/png').split(',')[1]
    };
  })()`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'crystal-face-landmarks.png'), Buffer.from(result.mark, 'base64'));
  delete result.mark;
  fs.writeFileSync(path.join(outDir, 'crystal-face-landmarks.json'), JSON.stringify(result, null, 2), 'utf8');
  // 同步写进 remesh-rules 的 face 段（保留 paintMouth/paintBlink/眼睑唇色），烘焙可读
  const rulesPath = path.join(skinDir, 'remesh-rules.json');
  const rules = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
  const prevFace = rules.face || {};
  rules.face = {
    说明: '由 analyze-crystal-face.cjs 实测写入；bake 读 landmarks 与 paintMouth/paintBlink',
    paintMouth: prevFace.paintMouth === true,
    paintBlink: prevFace.paintBlink === true,
    size: result.size,
    face: result.face,
    leftEye: result.leftEye,
    rightEye: result.rightEye,
    mouth: result.mouth,
    skinMean: result.skinMean,
    lidColor: prevFace.lidColor || [210, 180, 220],
    lipColor: prevFace.lipColor || [160, 90, 140]
  };
  fs.writeFileSync(rulesPath, JSON.stringify(rules, null, 2), 'utf8');
  console.log(JSON.stringify({
    leftEye: result.leftEye && { L: result.leftEye.L, T: result.leftEye.T, R: result.leftEye.R, B: result.leftEye.B, cx: result.leftEye.cx, cy: result.leftEye.cy },
    rightEye: result.rightEye && { L: result.rightEye.L, T: result.rightEye.T, R: result.rightEye.R, B: result.rightEye.B, cx: result.rightEye.cx, cy: result.rightEye.cy },
    mouth: result.mouth && { L: result.mouth.L, T: result.mouth.T, R: result.mouth.R, B: result.mouth.B, cx: result.mouth.cx, cy: result.mouth.cy },
    peaks: result.peaks,
    heatCount: result.heatCount
  }, null, 2));
  win.destroy();
  app.quit();
}).catch(function (err) {
  console.error(err);
  process.exit(1);
});
