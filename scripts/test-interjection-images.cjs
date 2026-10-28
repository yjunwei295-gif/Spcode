// 核对原始图片确实跨过UI、会话队列与MCP边界，不只检查接口字段存在。
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
/** 测试生产队列、工具边界图片以及SDK收尾后的带图续接。 */
async function queueAndDirect(){
 const context={require:createRequire(agentFile),fs,path,interjectInbox:new Map(),activeInterjectKeys:new Set(['a','b']),desktopOn:function(){return true;},modelSupportsVision:function(){return true;},attachmentsToParts:async function(list){return {parts:list.map(function(){return {type:'image_url',image_url:{url}};}),extraTexts:[]};},answerImagesForModel:async function(){throw new Error('原生视觉不应调用视觉代理');}};
 vm.createContext(context);
 vm.runInContext(between(source,'function pushInterjection(','// 桌面工具只在'),context);
 ok('纯图插话可入队',context.pushInterjection('a','',[{path:imageFile,name:'参考.png'}])===true);
 context.pushInterjection('b','另一会话');
 const received=context.takeInterjections('a');
 ok('原附件路径被保留且会话隔离',received[0].attachments[0].path===imageFile&&context.interjectInbox.get('b').length===1);
 const events=[];
 const args={modelCfg:{model:'gpt-6.1-sol'},turnText:'原任务',userContent:'原任务',onEvent:function(ev){events.push(ev);},runTool:async function(){context.pushInterjection('a','看图调整',[{path:imageFile,name:'参考.png'}]);return '已运行';}};
 let envelope=null;
 const direct={runTurn:async function(input){envelope=await input.runTool('read_file',{});return {content:'结束'};}};
 await context.runDirectWithInterjections(direct,args,'a');
 ok('执行中的工具结果携带MCP图片块',envelope.spcodeContent&&envelope.spcodeContent[1].type==='image');
 ok('MCP图片数据与原PNG逐字节一致',Buffer.from(envelope.spcodeContent[1].data,'base64').equals(bytes));
 let calls=0,continuation=null;
 const finalDirect={runTurn:async function(input){calls++;if(calls===1){context.pushInterjection('a','收尾时发图',[{path:imageFile,name:'参考.png'}]);return {content:'第一轮'};}continuation=input;return {content:'续接完成'};}};
 await context.runDirectWithInterjections(finalDirect,args,'a');
 ok('SDK收尾后的插话仍带原图续接同一会话',calls===2&&continuation.userContent[0].image_url.url===url&&continuation.fresh===false);
 ok('需求概要不出现对象占位文本',events.every(function(ev){return ev.type!=='interjection'||ev.texts.every(function(s){return !s.includes('[object Object]');});}));
 return envelope;
}
/** 使用真实本机HTTP MCP桥检查返回序列化，不访问模型服务。 */
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
  console.log('bridge '+JSON.stringify({status:response.status,types:result.content&&result.content.map(function(p){return p.type;}),error:result.error,text:result.content&&result.content[0].type==='text'?result.content[0].text.slice(0,100):''}));
  ok('真实MCP HTTP响应保留图片而非JSON字符串',response.ok&&result.content[1].type==='image'&&Buffer.from(result.content[1].data,'base64').equals(bytes));
 }finally{bridge.server.close();}
 const cursorFile=path.join(root,'electron/lib/cursor-direct.js'),cursorText=fs.readFileSync(cursorFile,'utf8');
 const cursor={console};vm.createContext(cursor);
 vm.runInContext(between(cursorText,'function toolResultText(','function imagesOf('),cursor);
 const tools=cursor.buildCustomTools([{name:'read_file'}],{ctx:{runTool:async function(){return envelope;},stats:{calls:[]}}});
 const result=await tools.read_file.execute({},{});
 ok('Cursor工具返回同样保留图片内容块',result.content[1].type==='image'&&Buffer.from(result.content[1].data,'base64').equals(bytes));
}
/** 运行真实渲染发送分支，确保纯图不会被改成下一轮排队，附件持久化且草稿消费。 */
async function renderer(){
 const app=fs.readFileSync(path.join(root,'renderer/app.js'),'utf8');
 const tab={id:'tab',workspace:'project',sending:true,draining:false,messages:[]};
 const state={attachments:[{path:imageFile,name:'参考.png',preview:url}],contextPaths:[],refillFromIndex:null};
 const input={value:''};let request=null;
 const context={state,activeTab:function(){return tab;},activeSession:function(){return tab;},$:function(){return input;},tabQueue:function(){return [];},currentModel:function(){return {};},refillHasTail:function(){return false;},recordSubmittedText:function(){},skillStack:function(){return [];},clearComposer:function(){},scheduleComposerSave:function(){},renderChips:function(){},persistTab:function(){},isActiveTab:function(){return true;},renderMessages:function(){},scrollMessagesToBottom:function(){},api:{chatInterject:async function(data){request=data;return {ok:true};}}};
 vm.createContext(context);
 // send函数后续还有其他分支；原函数完整截取到紧随的下一条顶层函数声明。
 const start=app.indexOf('async function send(options = {})');
 const end=app.indexOf('\nfunction ',start);
 const endAsync=app.indexOf('\nasync function ',start+10);
 const boundary=Math.min(end>0?end:Infinity,endAsync>0?endAsync:Infinity);
 vm.runInContext(app.substring(start,boundary),context);
 await context.send();
 ok('主窗纯图消息走插话API且携带原路径',request&&request.attachments[0].path===imageFile);
 ok('插话记录保存图片预览与附件路径',tab.messages[0].images[0]===url&&tab.messages[0].attachments[0].path===imageFile);
 ok('提交成功消费附件而不重复排队',state.attachments.length===0);
}
async function run(){
 const capabilities={isLocalGguf:function(){return false;}};vm.createContext(capabilities);
 vm.runInContext(between(source,'function modelSupportsVision(','function noVisionHint('),capabilities);
 ok('当前GPT6模型识别为原生视觉能力',capabilities.modelSupportsVision({model:'gpt-6.1-sol'})===true);
 ok('用户显式关闭原生视觉仍被尊重',capabilities.modelSupportsVision({model:'gpt-6.1-sol',vision:false})===false);
 const envelope=await queueAndDirect();await mcpBridge(envelope);await renderer();fs.writeFileSync(path.join(root,'generated/desktop-pet-check/interjection-results.json'),JSON.stringify({passed:results,imageBytes:bytes.length},null,2));}
run().catch(function(error){console.error(error.stack||error);process.exitCode=1;});
