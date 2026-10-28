/**
 * 使用真实HTML、CSS和聊天事件验证待办动画的生命周期。
 * 页面API使用已有本地夹具，不连接模型、不读写用户项目或会话。
 */
const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'renderer/app.js'),'utf8').split('\r\n').join('\n');
const fixture=fs.readFileSync(path.join(root,'scripts/test-ui-performance.cjs'),'utf8').split('\r\n').join('\n');
const output=fs.mkdtempSync(path.join(root,'generated','todo-animation-'));
app.setPath('userData',path.join(output,'user-data'));
app.on('window-all-closed',function keepAlive(){});
const checks=[];
/** 提取项目内真实函数，不复制实现逻辑到测试中。 */
function extract(text,signature){
  const start=text.indexOf(signature),end=text.indexOf('\n}\n',start);
  assert.ok(start>=0&&end>start,signature);
  return text.substring(start,end+3);
}
/** 记录行为断言；失败保留真实堆栈并中止验收。 */
function check(value,message){assert.ok(value,message);checks.push(message);console.log('PASS '+message);}
/** 等待页面事件更新DOM，不以固定长延时掩盖失败。 */
async function wait(win,expression){
  return win.webContents.executeJavaScript('(async function waitForView(){for(let i=0;i<150;i++){if('+expression+')return true;await new Promise(function pause(resolve){setTimeout(resolve,20);});}throw new Error("页面状态未达预期");})()');
}
/** 从真实计算样式读取动画，不能仅凭CSS类存在判断是否停止。 */
async function marks(win){
  return win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".todo-item")).map(function read(li){const mark=li.querySelector(".todo-mark");return {status:li.className,animation:getComputedStyle(mark).animationName,animations:mark.getAnimations().length,text:li.querySelector(".todo-text").textContent};})');
}
/** 通过实际输入与发送入口建立一轮会话，随后由本地API发送真实事件。 */
async function start(win,label){
  await win.webContents.executeJavaScript('fullPageRecord.turnId=null;document.getElementById("input").value='+JSON.stringify(label)+';document.getElementById("btn-send").click();');
  await wait(win,'!!fullPageRecord.turnId');
  return win.webContents.executeJavaScript('fullPageRecord.turnId');
}
/** 将主进程同名事件送入完整页面已注册的真实处理器。 */
async function emit(win,turnId,event){
  await win.webContents.executeJavaScript('emitTestChat('+JSON.stringify({...event,turnId})+')');
}
/** 结束本地模型等待，保留页面自己的发送收尾过程。 */
async function finish(win){
  await win.webContents.executeJavaScript('fullPageRecord.resolveTurn({text:"本地测试完成",changes:[]});new Promise(function settle(resolve){setTimeout(resolve,80);})');
}
/** 运行当前任务、旧快照、等待答复、失败和最终状态同步用例。 */
async function run(){
  await app.whenReady();
  const win=new BrowserWindow({show:false,width:1280,height:840,webPreferences:{backgroundThrottling:false,offscreen:true}});
  await win.loadURL('about:blank');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Page.enable');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'no-preference'}]});
  await win.webContents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument',{source:'('+extract(fixture,'function fullPageSetup()')+')();'});
  await win.loadFile(path.join(root,'renderer/index.html'));
  await wait(win,'!!document.querySelector("#tabs .tab")&&!document.getElementById("view-chat").classList.contains("hidden")');

  let turn=await start(win,'运行后结束但任务仍待续');
  await emit(win,turn,{type:'working_memory',workingMemory:{todos:[{id:'first',content:'第一条任务',status:'in_progress'}]}});
  let list=await marks(win);
  check(list.length===1&&list[0].animation==='todo-spin'&&list[0].animations===1,'实际执行中的任务产生真实CSS旋转动画');
  await emit(win,turn,{type:'done',text:'本轮结束，任务待继续'});
  list=await marks(win);
  check(list[0].animation==='none'&&list[0].animations===0,'完成事件后旧进行中标记立刻停止旋转');
  check(list[0].status.includes('todo-in_progress')&&!list[0].status.includes('todo-completed'),'回合结束不会把尚未完成任务伪标为已完成');
  await finish(win);

  turn=await start(win,'同步最终任务状态');
  await emit(win,turn,{type:'working_memory',workingMemory:{todos:[{id:'second',content:'第二条任务',status:'in_progress'}]}});
  list=await marks(win);
  check(list.filter(function active(x){return x.animation==='todo-spin';}).length===1&&list[0].animation==='none','新一轮只旋转当前卡片，上一轮快照保持静止');
  await emit(win,turn,{type:'done',text:'任务已完成',workingMemory:{todos:[{id:'second',content:'第二条任务',status:'completed'}]}});
  list=await marks(win);
  check(list[1].status.includes('todo-completed')&&list[1].animation==='none','完成事件携带的最终清单同步为已完成且不旋转');
  check(list[0].status.includes('todo-in_progress'),'更新本轮清单不改写历史任务快照');
  await finish(win);

  turn=await start(win,'等待用户答复');
  await emit(win,turn,{type:'working_memory',workingMemory:{todos:[{id:'third',content:'等待材料',status:'in_progress'}]}});
  await emit(win,turn,{type:'ask',question:'本地测试提问',options:[],allowFreeText:true});
  list=await marks(win);
  check(list[2].animation==='none'&&list[2].animations===0,'等待用户答复时不继续旋转');
  await emit(win,turn,{type:'done',text:'等待状态测试结束'});
  await finish(win);

  turn=await start(win,'错误结束');
  await emit(win,turn,{type:'working_memory',workingMemory:{todos:[{id:'fourth',content:'失败任务',status:'in_progress'}]}});
  await emit(win,turn,{type:'error',message:'fixture-todo-error'});
  list=await marks(win);
  check(list[3].animation==='none'&&list[3].animations===0,'错误事件结束任务执行动画');
  await finish(win);

  // 使用实际卡片函数和实际恢复函数，核对重开历史、停止和减少动态效果。
  const cardSource=extract(source,'function renderTodoCard(m)');
  const restoreSource=extract(source,'function settleDeadTurns(messages)');
  const setup='function escapeHtml(value){return String(value);} function t(key){return key;}\n'+cardSource+restoreSource
    +'\nwindow.renderTestTodo=renderTodoCard;window.restoreTestTodos=settleDeadTurns;void 0;';
  await win.webContents.executeJavaScript(setup);
  const recovered=await win.webContents.executeJavaScript('('+function restored(){
    const message={role:'assistant',thinkingOpen:true,text:'历史',todos:[{id:'saved',content:'恢复任务',status:'in_progress'}]};
    restoreTestTodos([message]);
    const host=document.createElement('div');host.innerHTML=renderTestTodo(message);document.body.appendChild(host);
    const mark=host.querySelector('.todo-mark');
    const result={animation:getComputedStyle(mark).animationName,status:host.querySelector('li').className};
    host.remove();return result;
  }.toString()+')()');
  check(recovered.animation==='none'&&recovered.status.includes('todo-in_progress'),'重开会话后历史进行中任务静止且保留原状态');
  const stopped=await win.webContents.executeJavaScript('('+function stoppedCard(){
    const host=document.createElement('div');
    host.innerHTML=renderTestTodo({thinkingOpen:true,stopped:true,todos:[{id:'stop',status:'in_progress',content:'已停止'}]});
    document.body.appendChild(host);const value=getComputedStyle(host.querySelector('.todo-mark')).animationName;host.remove();return value;
  }.toString()+')()');
  check(stopped==='none','已停止的回复即使残留执行标志也不旋转');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  const reduced=await win.webContents.executeJavaScript('('+function reducedCard(){
    const host=document.createElement('div');
    host.innerHTML=renderTestTodo({thinkingOpen:true,todos:[{id:'reduce',status:'in_progress',content:'减少动态'}]});
    document.body.appendChild(host);const value=getComputedStyle(host.querySelector('.todo-mark')).animationName;host.remove();return value;
  }.toString()+')()');
  check(reduced==='none','系统减少动态效果设置仍然生效');
  const errors=await win.webContents.executeJavaScript('fullPageRecord.errors');
  check(errors.length===0,'完整页面事件测试无脚本异常');
  fs.writeFileSync(path.join(output,'verification.json'),JSON.stringify({ok:true,checks},null,2),'utf8');
  win.destroy();console.log('RESULT '+JSON.stringify({failures:0,checks:checks.length,output:path.relative(root,output)}));app.exit(0);
}
/** 失败以非零状态退出，不能把脚本跑完当作功能通过。 */
function failed(error){console.error(error.stack||error);app.exit(1);}
setTimeout(function timeout(){failed(new Error('待办动画验收超时'));},20000);
run().catch(failed);
