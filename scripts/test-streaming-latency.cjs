/**
 * 在独立 Chromium 窗口中验证长回复绘制和原生输入，不连接模型或用户会话。
 */
'use strict';
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'renderer/app.js'),'utf8').split('\r\n').join('\n');
const start=source.indexOf('function paintRevealBubble(msg, done)');
const end=source.indexOf('\n}\n',start);
assert.ok(start>=0&&end>start);
/** 加载真实绘制方法与产品样式，测量三万字回复的布局和输入延迟。 */
async function main(){
  await app.whenReady();
  const win=new BrowserWindow({show:false,width:1280,height:840,webPreferences:{backgroundThrottling:false}});
  await win.loadURL('data:text/html,<div id="messages" class="messages"><div class="msg assistant" data-msg-i="0"><div class="bubble typewriter"></div></div></div><textarea id="input"></textarea>');
  await win.webContents.insertCSS(fs.readFileSync(path.join(root,'renderer/styles.css'),'utf8')+'body{display:block}#messages{height:650px;width:800px;padding:12px}#input{height:80px;width:800px}');
  await win.webContents.executeJavaScript('window.$=function(id){return document.getElementById(id)};window.msg={text:"长回复逐帧布局与输入响应。".repeat(5000),revealLen:35000};window.tab={messages:[msg]};window.activeSession=function(){return tab};window.renderMarkdown=function(text){return text};'+source.substring(start,end+3)+';void 0');
  win.showInactive();
  const metrics=await win.webContents.executeJavaScript('('+function measure(){
    const durations=[];
    const bubble=document.querySelector('.bubble');
    paintRevealBubble(msg,false);
    const node=bubble.firstChild;
    for(let i=0;i<80;i++){
      msg.revealLen+=24;
      const before=performance.now();
      paintRevealBubble(msg,false);
      durations.push(performance.now()-before);
    }
    durations.sort(function ascending(a,b){return a-b});
    document.getElementById('input').focus();
    return {sameTextNode:node===bubble.firstChild,p95:durations[Math.floor(durations.length*.95)],max:durations[durations.length-1],textCorrect:bubble.textContent===msg.text.slice(0,msg.revealLen)};
  }.toString()+')()');
  const delays=[];
  const typed='输入响应native-0123456789';
  for(const ch of typed){
    const before=Date.now();
    win.webContents.sendInputEvent({type:'char',keyCode:ch});
    await win.webContents.executeJavaScript('msg.revealLen+=24;paintRevealBubble(msg,false)');
    delays.push(Date.now()-before);
  }
  const value=await win.webContents.executeJavaScript('document.getElementById("input").value');
  assert.equal(value,typed);
  assert.equal(metrics.textCorrect,true);
  console.log('METRIC '+JSON.stringify({...metrics,nativeCharacters:typed.length,inputMaxMs:Math.max(...delays)}));
  if(!process.argv.includes('--baseline'))assert.equal(metrics.sameTextNode,true,'追加必须复用文字节点，不能逐帧替换全文');
  const rewrite=await win.webContents.executeJavaScript('msg.text="改写后的正文";msg.revealLen=7;paintRevealBubble(msg,false);document.querySelector(".bubble").textContent');
  assert.equal(rewrite,'改写后的正文');
  win.destroy();console.log('RESULT PASS');app.exit(0);
}
/** 验收失败返回非零退出码及真实堆栈。 */
function failed(error){console.error(error.stack||error);app.exit(1)}
main().catch(failed);
