// 纯代码水晶猫娘烘焙：直接调用 Canvas 绘制每一帧，不读取任何图片源或生成模型。
'use strict';
const fs=require('fs');
const path=require('path');
const assert=require('assert');
const {app,BrowserWindow}=require('electron');
const {getDrawSource}=require('./lib/crystal-neko-draw');
const root=path.join(__dirname,'..');
const skinDir=path.join(root,'electron/lib/desktop-pet-skins/cyber-neko');
const config=require('../electron/lib/desktop-pet-config.json');
const art=require('../electron/lib/desktop-pet-skins/cyber-neko/art.json');
const rules=require('../electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json');
const output=path.join(root,'generated/desktop-pet-check');
/** 在真实 Chromium Canvas 中生成16个动作，检查透明边界、表情差异和帧变化后写入同一皮肤。 */
async function run(){
  const win=new BrowserWindow({show:false,width:100,height:100,webPreferences:{offscreen:true}});
  await win.loadURL('about:blank');
  const data={colors:art.colors,motion:art.motion,poses:art.poses,expressions:rules.expressions,states:config.states,labels:config.labels,frames:config.motion.frames,fps:config.motion.fps};
  const source=getDrawSource();
  const result=await win.webContents.executeJavaScript('(function(){'+source+'\nconst data='+JSON.stringify(data)+';const cell='+rules.bake.cellSize+';const states=data.states,frames=data.frames;'+`
    const atlas=document.createElement('canvas');atlas.width=cell*frames;atlas.height=cell*states.length;
    const target=atlas.getContext('2d');
    const frame=document.createElement('canvas');frame.width=cell;frame.height=cell;
    const ctx=frame.getContext('2d',{willReadFrequently:true});
    const checks=[],signatures={},statePixels={};
    for(let r=0;r<states.length;r++){
      const state=states[r],hashes=[],bounds=[];
      for(let f=0;f<frames;f++){
        const phase=(state==='landing'||state==='success')?f/(frames-1):f/frames;
        drawCrystalPetFrame(ctx,cell,state,phase,data);
        const pixels=ctx.getImageData(0,0,cell,cell).data;
        let opaque=0,edges=0,hash=2166136261;
        for(let y=0;y<cell;y++)for(let x=0;x<cell;x++){
          const i=(y*cell+x)*4;
          if(pixels[i+3]>24){opaque++;if(x===0||y===0||x===cell-1||y===cell-1)edges++;}
          if((x+y)%3===0){hash=Math.imul(hash^pixels[i],16777619);hash=Math.imul(hash^pixels[i+1],16777619);hash=Math.imul(hash^pixels[i+3],16777619);}
        }
        hashes.push(hash>>>0);bounds.push({opaque,edges});
        if(f===0)statePixels[state]=new Uint8ClampedArray(pixels);
        target.drawImage(frame,f*cell,r*cell);
      }
      checks.push({state,uniqueFrames:new Set(hashes).size,minOpaque:Math.min.apply(null,bounds.map(function(b){return b.opaque;})),clippedPixels:bounds.reduce(function(n,b){return n+b.edges;},0)});
      signatures[state]=hashes;
    }
    const eyeBox=[.34,.38,.64,.48],mouthBox=[.43,.54,.57,.62];
    function difference(state,box){
      const a=statePixels.idle,b=statePixels[state];let count=0;
      for(let y=Math.floor(cell*box[1]);y<cell*box[3];y++)for(let x=Math.floor(cell*box[0]);x<cell*box[2];x++){
        const i=(y*cell+x)*4;
        if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])+Math.abs(a[i+2]-b[i+2])>25)count++;
      }
      return count;
    }
    const expressions=['thinking','speaking','success','error','stopped','waiting'].map(function(state){return {state,eyes:difference(state,eyeBox),mouth:difference(state,mouthBox)};});
    const sourceCanvas=document.createElement('canvas');sourceCanvas.width=sourceCanvas.height=`+rules.draw.sourceSize+`;
    drawCrystalNeko(sourceCanvas.getContext('2d'),sourceCanvas.width,{colors:data.colors,lid:data.expressions.idle.lid,mouth:data.expressions.idle.mouth,open:data.expressions.idle.open,glow:data.expressions.idle.glow,wave:0});
    const show=['idle','thinking','speaking','waiting','success','error'];
    const board=document.createElement('canvas');board.width=cell*3;board.height=(cell+42)*2;
    const bc=board.getContext('2d');bc.fillStyle='#141222';bc.fillRect(0,0,board.width,board.height);
    for(let i=0;i<show.length;i++){let x=(i%3)*cell,y=Math.floor(i/3)*(cell+42);bc.fillStyle='#c8b7ee';bc.font='18px Microsoft YaHei';bc.fillText(data.labels[show[i]],x+24,y+28);const row=states.indexOf(show[i]);bc.drawImage(atlas,0,row*cell,cell,cell,x,y+42,cell,cell);}
    return {atlas:atlas.toDataURL('image/png').split(',')[1],source:sourceCanvas.toDataURL('image/png').split(',')[1],board:board.toDataURL('image/png').split(',')[1],checks,expressions,signatures};
  })()`);
  for(const check of result.checks){
    assert.ok(check.uniqueFrames>1,check.state+'必须具有逐帧变化');
    assert.ok(check.minOpaque>rules.bake.cellSize*rules.bake.cellSize*.1,check.state+'必须有可见角色');
    assert.strictEqual(check.clippedPixels,0,check.state+'不能在图格边缘裁掉角色');
  }
  assert.ok(result.expressions.find(function(one){return one.state==='speaking';}).mouth>50,'说话口型必须改变实际脸部像素');
  assert.ok(result.expressions.find(function(one){return one.state==='thinking';}).eyes>50,'思考眼睑必须改变实际脸部像素');
  fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(skinDir,'atlas.png'),Buffer.from(result.atlas,'base64'));
  fs.writeFileSync(path.join(skinDir,'code-head.png'),Buffer.from(result.source,'base64'));
  fs.writeFileSync(path.join(output,'crystal-code-reference.png'),Buffer.from(result.board,'base64'));
  fs.writeFileSync(path.join(output,'crystal-code-data.js'),'window.crystalPetData='+JSON.stringify(data)+';\n','utf8');
  const manifest={version:1,id:'cyber-neko',name:art.name+' · 程序绘制',author:'SpCode',character:'cyber-neko',colors:art.colors,atlas:'atlas.png',cellSize:rules.bake.cellSize,columns:config.motion.frames,fps:config.motion.fps,anchor:[rules.bake.cellSize/2,rules.bake.cellSize],animations:{},drawing:{method:'canvas-paths',source:rules.draw.script}};
  for(let i=0;i<config.states.length;i++)manifest.animations[config.states[i]]={row:i,frames:config.motion.frames,loop:config.states[i]!=='success'&&config.states[i]!=='landing'};
  fs.writeFileSync(path.join(skinDir,'skin.json'),JSON.stringify(manifest,null,2),'utf8');
  fs.writeFileSync(path.join(output,'crystal-code-results.json'),JSON.stringify({method:'canvas-paths',imageInputs:[],checks:result.checks,expressions:result.expressions,signatures:result.signatures},null,2),'utf8');
  console.log('PASS 纯Canvas绘制，图片输入=0；'+config.states.length+'状态×'+config.motion.frames+'帧，格尺寸='+rules.bake.cellSize);
  console.log(JSON.stringify({checks:result.checks,expressions:result.expressions}));
  win.destroy();app.quit();
}
app.whenReady().then(run).catch(function(error){console.error(error.stack||error);app.exit(1);});
