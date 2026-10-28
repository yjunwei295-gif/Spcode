// 无位移纯表情头预览：直接在裁切头上改五官，验证表情是否可见。
'use strict';
const fs=require('fs');
const path=require('path');
const {app,BrowserWindow}=require('electron');
const {pathToFileURL}=require('url');
const root=path.join(__dirname,'..');
const skinDir=path.join(root,'electron/lib/desktop-pet-skins/cyber-neko');
const rules=require('../electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json');
const outPath=path.join(root,'generated/desktop-pet-check/crystal-pure-expressions.png');

app.whenReady().then(async()=>{
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const headFile=path.join(skinDir,'remesh-head.png');
  const headUrl=pathToFileURL(fs.existsSync(headFile)?headFile:path.join(skinDir,'painted-head-source.png')).href;
  const result=await win.webContents.executeJavaScript(`(async()=>{
    const head=new Image(); head.src=${JSON.stringify(headUrl)}; await head.decode();
    const w=head.width,h=head.height;
    const raw=document.createElement('canvas'); raw.width=w; raw.height=h;
    const rc=raw.getContext('2d'); rc.drawImage(head,0,0);
    const img=rc.getImageData(0,0,w,h); const d=img.data;
    // 简单去底
    const bg=[[0,0],[w-1,0],[0,h-1],[w-1,h-1]].reduce((a,p)=>{const o=(p[1]*w+p[0])*4;a[0]+=d[o];a[1]+=d[o+1];a[2]+=d[o+2];return a;},[0,0,0]).map(v=>v/4);
    for(let i=0;i<d.length;i+=4){
      const dr=d[i]-bg[0],dg=d[i+1]-bg[1],db=d[i+2]-bg[2];
      if(d[i+3]<8 || dr*dr+dg*dg+db*db<78*78) d[i+3]=0;
    }
    rc.putImageData(img,0,0);
    const face=${JSON.stringify(rules.face)};
    const expressions=${JSON.stringify(rules.expressions)};
    const skin=face.skinMean||[244,226,230];
    const lid=face.lidColor||[180,150,200];
    const lip=face.lipColor||[150,70,120];
    function paint(state){
      const c=document.createElement('canvas'); c.width=w; c.height=h;
      const ctx=c.getContext('2d'); ctx.drawImage(raw,0,0);
      const p=expressions[state]||expressions.idle;
      function eye(box, amount){
        if(!box) return;
        const close=Math.max(0,Math.min(1,amount));
        const cover=Math.floor((box.B-box.T+1)*close);
        ctx.fillStyle='rgba('+lid[0]+','+lid[1]+','+lid[2]+',0.95)';
        ctx.fillRect(box.L-4, box.T-6, (box.R-box.L)+8, cover+8);
        if(close>0.55){
          ctx.strokeStyle='rgba(40,20,60,0.85)'; ctx.lineWidth=5;
          ctx.beginPath(); ctx.moveTo(box.L-2, box.T+cover); ctx.lineTo(box.R+2, box.T+cover-2); ctx.stroke();
        }
      }
      eye(face.leftEye, p.lid||0);
      eye(face.rightEye, (p.lid||0)*0.95);
      // 嘴
      const m=face.mouth; if(m){
        ctx.fillStyle='rgb('+skin[0]+','+skin[1]+','+skin[2]+')';
        ctx.beginPath(); ctx.ellipse(m.cx,m.cy,(m.R-m.L)*0.7,(m.B-m.T)*0.75,0,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle='rgb('+lip[0]+','+lip[1]+','+lip[2]+')';
        ctx.fillStyle='rgba('+Math.max(30,lip[0]-50)+','+Math.max(10,lip[1]-40)+','+Math.max(30,lip[2]-30)+',0.95)';
        ctx.lineWidth=6; ctx.lineCap='round'; ctx.lineJoin='round';
        const half=(m.R-m.L)*0.55; const open=p.open||0.15; const y=m.cy;
        if(p.mouth==='frown'){
          ctx.beginPath(); ctx.moveTo(m.cx-half,y+8); ctx.quadraticCurveTo(m.cx,y-16-open*20,m.cx+half,y+8); ctx.stroke();
        } else if(p.mouth==='flat'){
          ctx.beginPath(); ctx.moveTo(m.cx-half*0.9,y); ctx.lineTo(m.cx+half*0.9,y); ctx.stroke();
        } else if(p.mouth==='open'){
          const oh=12+open*36;
          ctx.beginPath();
          ctx.moveTo(m.cx-half,y-4); ctx.lineTo(m.cx-half*0.3,y+oh); ctx.lineTo(m.cx+half*0.3,y+oh+2); ctx.lineTo(m.cx+half,y-2);
          ctx.closePath(); ctx.fill(); ctx.stroke();
        } else {
          const lift=10+open*22;
          ctx.beginPath(); ctx.moveTo(m.cx-half,y-2); ctx.lineTo(m.cx-half*0.2,y+lift); ctx.lineTo(m.cx+half,y-6); ctx.stroke();
          if(open>0.2){ ctx.beginPath(); ctx.moveTo(m.cx-half*0.55,y+2); ctx.lineTo(m.cx,y+lift*0.75); ctx.lineTo(m.cx+half*0.15,y+4); ctx.closePath(); ctx.fill(); }
        }
      }
      return c;
    }
    const states=['idle','thinking','speaking','success','error','stopped'];
    const board=document.createElement('canvas');
    const cw=360, ch=360;
    board.width=cw*states.length+24; board.height=ch+56;
    const bc=board.getContext('2d');
    bc.fillStyle='#1a1d22'; bc.fillRect(0,0,board.width,board.height);
    bc.fillStyle='#e8edf5'; bc.font='26px sans-serif';
    for(let i=0;i<states.length;i++){
      const c=paint(states[i]);
      bc.drawImage(c, 12+i*cw, 44, cw, ch);
      bc.fillText(states[i], 24+i*cw, 34);
    }
    return board.toDataURL('image/png').split(',')[1];
  })()`);
  fs.writeFileSync(outPath, Buffer.from(result,'base64'));
  console.log('wrote', outPath);
  win.destroy(); app.quit();
});
