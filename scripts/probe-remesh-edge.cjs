// 探测 remesh-head 四边不透明像素，验收去底是否清掉整圈底色。
'use strict';
const path=require('path');
const {pathToFileURL}=require('url');
const {app,BrowserWindow}=require('electron');
const root=path.join(__dirname,'..');
const src=path.join(root,'electron/lib/desktop-pet-skins/cyber-neko/remesh-head.png');

app.whenReady().then(async function(){
  const win=new BrowserWindow({show:false,width:64,height:64,webPreferences:{offscreen:true,webSecurity:false}});
  await win.loadURL('about:blank');
  const url=pathToFileURL(src).href;
  const r=await win.webContents.executeJavaScript('(async function(){\n    const im=new Image(); im.src='+JSON.stringify(url)+'; await im.decode();\n    const c=document.createElement("canvas"); c.width=im.width; c.height=im.height;\n    const x=c.getContext("2d"); x.drawImage(im,0,0);\n    const d=x.getImageData(0,0,c.width,c.height).data;\n    function a(X,Y){ return d[(Y*c.width+X)*4+3]; }\n    let edgeOpaque=0, edgeN=0;\n    for(let i=0;i<c.width;i++){\n      edgeN+=4;\n      if(a(i,0)>16) edgeOpaque++;\n      if(a(i,c.height-1)>16) edgeOpaque++;\n      if(a(i,1)>16) edgeOpaque++;\n      if(a(i,c.height-2)>16) edgeOpaque++;\n    }\n    for(let j=0;j<c.height;j++){\n      edgeN+=4;\n      if(a(0,j)>16) edgeOpaque++;\n      if(a(c.width-1,j)>16) edgeOpaque++;\n      if(a(1,j)>16) edgeOpaque++;\n      if(a(c.width-2,j)>16) edgeOpaque++;\n    }\n    return {size:[im.width,im.height], corners:[a(0,0),a(c.width-1,0),a(0,c.height-1),a(c.width-1,c.height-1)], edgeOpaque:edgeOpaque, edgeN:edgeN, midTop:a(Math.floor(c.width/2),0), midBottom:a(Math.floor(c.width/2),c.height-1), midLeft:a(0,Math.floor(c.height/2)), midRight:a(c.width-1,Math.floor(c.height/2))};\n  })()');
  console.log(JSON.stringify(r,null,2));
  win.destroy(); app.quit();
}).catch(function(e){ console.error(e); app.quit(); process.exit(1); });
