// 核对原始图片从界面经会话队列进入续接用户消息，并验证桥接层原样返回工具文本。
'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm'),assert=require('assert'),http=require('http');
const {createRequire}=require('module');
const root=path.join(__dirname,'..'),agentFile=path.join(root,'electron/lib/agent.js');
const source=fs.readFileSync(agentFile,'utf8');
const imageFile=path.join(root,'icons.png'),bytes=fs.readFileSync(imageFile),url='data:image/png;base64,'+bytes.toString('base64');
const results=[];
/** 从实际源码按唯一声明截取整个函数组，依赖通过受控传输提供。 */
function between(text,start,end){const a=text.indexOf(start),b=text.indexOf(end,a);assert(a>=0&&b>a);return text.substring(a,b);}
/** 断言真实载荷与字节，记录可复查证据。 */
function ok(name,value){assert.ok(value,name);results.push(name);console.log('PASS '+name);}
/**
 * 核对续接用户消息的正文和 PNG 附件。
 * input 是直通适配器收到的续接参数，message 是本次插话正文，name 用于记录断言。
 * 断言失败时抛错，成功时记录检查结果。
 */
function checkImageContinuation(input,message,name){
 const parts=input.userContent;
 const prefix='data:image/png;base64,';
 ok(name,input.fresh===false&&input.turnText.includes(message)&&Array.isArray(parts)&&parts.length===1&&
  parts[0].type==='image_url'&&parts[0].image_url.url.startsWith(prefix)&&
  Buffer.from(parts[0].image_url.url.slice(prefix.length),'base64').equals(bytes));
}
/**
 * 将测试队列传来的 PNG 路径解析成模型图片内容块。
 * list 是队列保留的附件，读取路径对应的实际字节并返回内容块，无额外文本。
 */
async function parseImages(list){
 const parts=[];
 for(const attachment of list){
  const data=fs.readFileSync(attachment.path).toString('base64');
  parts.push({type:'image_url',image_url:{url:'data:image/png;base64,'+data}});
 }
 return {parts,extraTexts:[]};
}
/**
 * 核对生产队列、工具结果和 SDK 收尾后的带图续接。
 * VM 提供测试用附件解析和直通转发；返回原始工具结果，供桥接回归复用。
 */
async function queueAndDirect(){
  /** 附件会话各用自己的真实收件记录，以便在投递前分配编号。 */
  function imageInbox(key) {
    const { InterjectionTodos } = require('../electron/lib/interjection-todos');
    return new InterjectionTodos({ current: { interjectionTodos: [] } }, key, function record() {});
  }
 const context={require:createRequire(agentFile),fs,path,parallelWakeups:new Map(),batchWaiters:new Map(),interjectInbox:new Map(),interjectInFlight:new Map(),interjectWakeups:new Map(),interjectArchives:new Map(),trainingArchive:{direct:function forwardDirect(provider,args){return provider.runTurn(args);}},activeInterjectKeys:new Map([['a', imageInbox('a')], ['b', imageInbox('b')]]),desktopOn:function(){return true;},modelSupportsVision:function(){return true;},attachmentsToParts:parseImages,answerImagesForModel:async function(){throw new Error('原生视觉不应调用视觉代理');}};
 vm.createContext(context);
 vm.runInContext(between(source,'function notifyParallelBranches(','// 桌面工具只在'),context);
 ok('纯图插话可入队',context.pushInterjection('a','',[{path:imageFile,name:'参考.png'}])===true);
 context.pushInterjection('b','另一会话');
 const received=context.takeInterjections('a');
 ok('原附件路径被保留且会话隔离',received[0].attachments[0].path===imageFile&&context.interjectInbox.get('b').length===1);
 const events=[];
 let toolCalls=0,requests=0,envelope,continuation;
 const toolOutput='已运行';
 const inFlightMessage='看图调整';
 const finishMessage='收尾时发图';
 /**
  * 在唯一一次实际工具执行中提交带图插话，并返回原始工具文本。
  * 重复调用直接触发断言，避免测试夹具为每次续接继续入队。
  */
 async function runTool(){
  assert.strictEqual(++toolCalls,1);
  assert.strictEqual(context.pushInterjection('a',inFlightMessage,[{path:imageFile,name:'参考.png'}]),true);
  return toolOutput;
 }
 const args={modelCfg:{model:'gpt-6.1-sol'},turnText:'原任务',userContent:'原任务',onEvent:function(ev){events.push(ev);},runTool};
 /**
  * 首次接收原任务并执行工具，第二次捕获插话用户消息。
  * input 是直通请求参数；每次返回对应答复，第三次调用触发断言。
  */
 async function runTurn(input){
  requests++;
  if(requests===1){
   envelope=await input.runTool('read_file',{});
   return {content:'旧请求结束'};
  }
  assert.strictEqual(requests,2);
  continuation=input;
  return {content:'已按插话续接'};
 }
 const result=await context.runDirectWithInterjections({runTurn},args,'a');
 ok('在途工具仅执行一次且原始工具结果原样返回',toolCalls===1&&envelope===toolOutput);
 ok('原直通会话只续接一次并交付续接答复',requests===2&&result.content==='已按插话续接');
 checkImageContinuation(continuation,inFlightMessage,'在途插话的续接用户消息收到逐字节一致的原图');
 let calls=0,finalContinuation;
 /**
  * 模拟无工具请求收尾时提交带图插话，并捕获下一次直通用户请求。
  * input 是适配器接收的请求参数，返回对应的收尾或续接答复。
  */
 async function finishTurn(input){
  calls++;
  if(calls===1){
   assert.strictEqual(context.pushInterjection('a',finishMessage,[{path:imageFile,name:'参考.png'}]),true);
   return {content:'第一轮'};
  }
  assert.strictEqual(calls,2);
  finalContinuation=input;
  return {content:'续接完成'};
 }
 await context.runDirectWithInterjections({runTurn:finishTurn},args,'a');
 ok('SDK收尾后的插话只续接一次',calls===2);
 checkImageContinuation(finalContinuation,finishMessage,'SDK收尾后的续接用户消息收到逐字节一致的原图');
 ok('需求概要不出现对象占位文本',events.every(function(ev){return ev.type!=='interjection'||ev.texts.every(function(s){return !s.includes('[object Object]');});}));
 return envelope;
}
/**
 * 检查 Codex 本机 HTTP MCP 桥和 Cursor 工具适配器的实际响应。
 * envelope 是上一步返回的原始工具文本；无返回值，响应不一致时抛错。
 */
async function mcpBridge(envelope){
 const file=path.join(root,'electron/lib/codex-direct.js'),text=fs.readFileSync(file,'utf8');
 const context={require:createRequire(file),http,crypto:require('crypto'),READ_ONLY_TOOLS:new Set(),console,Buffer};
 vm.createContext(context);
 vm.runInContext(between(text,'function toolDefs(','async function createSession('),context);
 const session={ctx:{tools:[{name:'read_file',parameters:{type:'object'}}],runTool:async function(){return envelope;},stats:{calls:[]}}};
 const bridge=await context.startBridge(session);
 try{
  const response=await fetch('http://127.0.0.1:'+bridge.port+'/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+bridge.token},body:JSON.stringify({method:'tools/call',params:{name:'read_file',arguments:{}}})});
  const result=await response.json();
  ok('真实 MCP HTTP 响应只包含原始工具文本',response.ok&&result.content.length===1&&result.content[0].type==='text'&&result.content[0].text===envelope);
 }finally{bridge.server.close();}
 const cursorFile=path.join(root,'electron/lib/cursor-direct.js'),cursorText=fs.readFileSync(cursorFile,'utf8');
 const cursor={console};vm.createContext(cursor);
 vm.runInContext(between(cursorText,'function toolResultText(','function imagesOf('),cursor);
 const tools=cursor.buildCustomTools([{name:'read_file'}],{ctx:{runTool:async function(){return envelope;},stats:{calls:[]}}});
 const result=await tools.read_file.execute({},{});
  ok('Cursor 工具响应只包含原始工具文本',result.content.length===1&&result.content[0].type==='text'&&result.content[0].text===envelope);
}
/** 用真实发送函数验证运行中提交的纯图进入当前会话队列，原图和预览留待合并。 */
async function renderer(){
 const app=fs.readFileSync(path.join(root,'renderer/app.js'),'utf8');
 const tab={id:'tab',workspace:'project',sending:true,draining:false,messages:[],queue:[]};
 const state={attachments:[{path:imageFile,name:'参考.png',preview:url}],contextPaths:[],refillFromIndex:null};
 const input={value:''};
 /** 此夹具没有输入预测控件，提交时刷新预测不产生界面操作。 */
 function refreshComposerPrediction(){}
 const context={state,refreshComposerPrediction,
  activeSession:function(){return tab;},$:function(){return input;},tabQueue:function(){return tab.queue;},
  currentModel:function(){return {};},refillHasTail:function(){return false;},recordSubmittedText:function(){},
  skillStack:function(){return [];},clearComposer:function(){},scheduleComposerSave:function(){},
  renderChips:function(){},renderQueue:function(){},persistTab:function(){},isActiveTab:function(){return true;}};
 vm.createContext(context);
 // send函数后续还有其他分支；原函数完整截取到紧随的下一条顶层函数声明。
 const start=app.indexOf('async function send(options = {})');
 const end=app.indexOf('\nfunction ',start);
 const endAsync=app.indexOf('\nasync function ',start+10);
 const boundary=Math.min(end>0?end:Infinity,endAsync>0?endAsync:Infinity);
 vm.runInContext(app.substring(start,boundary),context);
 await context.send();
 const queued=tab.queue[0];
 ok('主窗纯图消息加入当前会话的整合队列',tab.queue.length===1&&queued.integrate&&queued.attachments[0].path===imageFile);
 ok('整合前保留图片预览，当前回复不追加消息',queued.attachments[0].preview===url&&tab.messages.length===0);
 ok('提交成功消费附件',state.attachments.length===0);
}
async function run(){
 const capabilities={isLocalGguf:function(){return false;}};vm.createContext(capabilities);
 vm.runInContext(between(source,'function modelSupportsVision(','function noVisionHint('),capabilities);
 ok('当前GPT6模型识别为原生视觉能力',capabilities.modelSupportsVision({model:'gpt-6.1-sol'})===true);
 ok('用户显式关闭原生视觉仍被尊重',capabilities.modelSupportsVision({model:'gpt-6.1-sol',vision:false})===false);
 const envelope=await queueAndDirect();await mcpBridge(envelope);await renderer();fs.writeFileSync(path.join(root,'generated/desktop-pet-check/interjection-results.json'),JSON.stringify({passed:results,imageBytes:bytes.length},null,2));}
run().catch(function(error){console.error(error.stack||error);process.exitCode=1;});
