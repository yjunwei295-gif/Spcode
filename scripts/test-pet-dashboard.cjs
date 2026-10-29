// 用真实 Electron 小窗与 preload IPC 核对余额同步、消息过滤、历史恢复和 HUD 布局。
'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {app,BrowserWindow,ipcMain}=require('electron');
const root=path.join(__dirname,'..');
const output=path.join(root,'generated','desktop-pet-dashboard-check');
const config=require('../electron/lib/desktop-pet-config.json');
app.setPath('userData',path.join(require('node:os').tmpdir(),'spcode-dashboard-'+process.pid));
const passed=[],errors=[],layouts=[];
let bar,win,wc,owner,other,router;
let bound='1:dashboard';
/** 等待跨进程事件与实际动画状态，不以源码存在代替功能验证。 */
function wait(ms){return new Promise(function(resolve){setTimeout(resolve,ms);});}
/** 记录有明确行为断言的核对结果，失败时保留实际画面。 */
function ok(name,value){assert.ok(value,name);passed.push(name);console.log('PASS '+name);}
/** 精确截取生产函数用于接入真实 IPC；不复制一份测试专用实现。 */
function production(source,name){
  const start=source.indexOf('function '+name+'(');
  assert.ok(start>=0,'生产函数存在 '+name);
  const end=source.indexOf('\n}',start);
  assert.ok(end>=0,'生产函数完整 '+name);
  return source.substring(start,end+2);
}
/** 使用生产余额与模型菜单函数，通过真实 preload IPC 核对当前大脑的切换和额度更新。 */
async function report(target,providers,balances,modelId){
  const source=fs.readFileSync(path.join(root,'renderer','app.js'),'utf8');
  const names=['formatQuotaMoney','quotaCanShow','walletSnapshotOf','providerCacheKey','aggregateQuotaSnapshot','currentModel','modelLabel','currentBrainQuotaSnapshot','showAggregateQuota','renderModelMenu'];
  const definitions=names.map(function(name){return production(source,name);}).join('\n');
  const models=providers.map(function(p){return {id:p.id,providerId:p.id,name:p.name,model:'测试模型 '+p.id,type:'api'};});
  models.push({id:'local-test',name:'本地测试模型',type:'local'});
  return target.webContents.executeJavaScript('(function(){var state='+JSON.stringify({providers,models,currentModelId:modelId})+';var quotaMem={providers:new Map()};var balances='+JSON.stringify(balances)+';'+definitions+'\n'+
    'function t(key,values){if(key==="quotaUnavailable")return "暂不可用";if(key==="quotaTotal")return "合计 "+values.text;return key;}'+
    'var api=window.simple;var painted=null;function paintQuotaBar(value){painted=value;}'+
    'for(var i=0;i<state.providers.length;i++){var p=state.providers[i];if(balances[p.id])quotaMem.providers.set(p.id,{balance:balances[p.id],configKey:providerCacheKey(p)});}'+
    'function $(id){return {};}function paintModelButton(){}function escapeHtml(text){return String(text);}'+
    'window.dashboardSelectModel=function(id){state.currentModelId=id;renderModelMenu();return currentBrainQuotaSnapshot();};'+
    'showAggregateQuota();return painted;})()');
}
/** 从页面读取可见正文与实际几何，覆盖 title 中隐蔽泄漏命令的情况。 */
function inspect(){
  function box(id){const r=document.getElementById(id).getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};}
  const label=document.getElementById('pet-label');
  // 读取独立画布的实际 Alpha，验证开关是否真正移除镜片。
  const glasses=document.getElementById('pet-glasses'),pixels=glasses.getContext('2d').getImageData(0,0,glasses.width,glasses.height).data;
  let glassesPixels=0;
  for(let i=3;i<pixels.length;i+=4)if(pixels[i]>24)glassesPixels++;
  const thoughts=Array.from(document.querySelectorAll('.thought-content'),function(el){return el.textContent;});
  const replies=Array.from(document.querySelectorAll('#msgs .ai'),function(el){return el.textContent;});
  return {balance:document.getElementById('pet-balance-value').textContent,total:document.getElementById('pet-wallet-total').textContent,
    accounts:document.getElementById('pet-wallet-accounts').textContent,chat:document.getElementById('msgs').textContent,
    thoughts,replies,toolRows:document.querySelectorAll('#msgs .tool').length,detail:label.textContent,
    detailTitle:label.title,status:document.getElementById('status').textContent,thoughtOpen:document.querySelector('.thought')?.open,
    glassesRendering:getComputedStyle(glasses).imageRendering,glassesPixels,glassesEnabled:document.getElementById('pet-glasses-enabled').checked,glassesState:document.getElementById('pet-glasses').dataset.state,glassesFrame:document.getElementById('pet-glasses').dataset.frame,glassesPointer:getComputedStyle(document.getElementById('pet-glasses')).pointerEvents,glassesBox:box('pet-glasses'),
    labelOpacity:getComputedStyle(label).opacity,balanceOpacity:getComputedStyle(document.getElementById('pet-balance')).opacity,
    bubbleClamp:getComputedStyle(label).webkitLineClamp,bubbleOverflow:getComputedStyle(label).overflow,bubbleLineHeight:parseFloat(getComputedStyle(label).lineHeight),bubbleScrollHeight:label.scrollHeight,bubbleClientHeight:label.clientHeight,
    wallet:box('pet-wallet'),badge:box('pet-activity'),balanceBox:box('pet-balance'),label:box('pet-label'),canvas:box('pet-canvas'),stage:box('pet-stage'),
    input:box('input'),msgs:box('msgs'),frame:box('frame'),pet:desktopPetInspect()};
}
/** 读取当前窗口状态；发送和检查始终使用同一个真实页面。 */
async function snapshot(){return wc.executeJavaScript('('+inspect.toString()+')()');}
/** 从原主进程入口向当前会话投递事件。 */
function event(data){bar.pushEvent(bound,Object.assign({turnId:'turn'},data));}
/** 按生产绑定流程恢复历史和该窗口最新余额。 */
async function bind(key){bound=key;bar.setBoundKey(key);router.pushAccountQuota(key);await wait(180);}
/** 保存实际渲染截图，供人工检查观感。 */
async function capture(name){fs.writeFileSync(path.join(output,name),(await wc.capturePage()).toPNG());}
/** 核对余额路由、流式文本、工具过滤、等待回答及缩放，所有模型数据为明确测试夹具。 */
async function run(){
  fs.mkdirSync(output,{recursive:true});
  const preload=path.join(root,'electron','preload.js');
  owner=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:false}});
  other=new BrowserWindow({show:false,webPreferences:{preload,contextIsolation:true,nodeIntegration:false,sandbox:false}});
  await owner.loadURL('data:text/html,<title>账户测试来源一</title>');
  await other.loadURL('data:text/html,<title>账户测试来源二</title>');
  const main=fs.readFileSync(path.join(root,'electron','main.js'),'utf8');
  router={BrowserWindow,winById:new Map([[1,owner],[2,other]]),sessionsByKey:new Map([['1:dashboard','一'],['1:other','二'],['2:dashboard','三']]),
    accountQuotaByWin:new WeakMap(),broadcastToFloatBars:function(data){bar.pushEvent(data);}};
  vm.createContext(router);
  for(const name of ['getWin','looksLikeSessionKey','winFromKey','pushAccountQuota','noteAccountQuota'])vm.runInContext(production(main,name),router);
  ok('生产主进程已注册余额通道',main.includes("ipcMain.on('floatbar:account-quota', noteAccountQuota)"));
  ipcMain.on('floatbar:account-quota',router.noteAccountQuota);
  bar=require('../electron/lib/float-bar').createFloatBar({slotIndex:96,onBind:function(key){if(key)bound=key;bar.setBoundKey(bound);router.pushAccountQuota(bound);}});
  bar.setBoundKey(bound);bar.show();bar.moveToPlace('right');
  win=BrowserWindow.getAllWindows().find(function(one){return bar.ownsWindow(one);});wc=win.webContents;
  wc.on('console-message',function(ev,level,message){if(level>=3)errors.push(message);});
  wc.on('render-process-gone',function(_ev,details){errors.push(JSON.stringify(details));});
  for(let i=0;i<80;i++){
    await wait(100);
    if(await wc.executeJavaScript('!!(window.desktopPetInspect&&desktopPetInspect().skin)'))break;
  }
  let current=await snapshot();
  ok('未收到余额时不伪造零余额',current.balance==='暂无余额数据');
  ok('实际空闲时余额也固定在桌宠脚下',current.balanceBox.top-current.canvas.bottom>=config.layout.infoGap-0.1&&current.balanceBox.bottom<=current.stage.bottom&&current.balanceBox.height===config.layout.balanceHeight);
  // 强制浏览器真实悬停样式，不依赖用户正在移动的系统鼠标。
  wc.debugger.attach('1.3');
  const documentNode=await wc.debugger.sendCommand('DOM.getDocument');
  const stageNode=await wc.debugger.sendCommand('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'#pet-stage'});
  await wc.debugger.sendCommand('CSS.enable');
  await wc.debugger.sendCommand('CSS.forcePseudoState',{nodeId:stageNode.nodeId,forcedPseudoClasses:['hover']});
  await wait(220);
  ok('实际空闲即使悬停也只显示余额，没有状态气泡',await wc.executeJavaScript('document.getElementById("pet-label").hidden&&document.getElementById("pet-label").textContent===""&&getComputedStyle(document.getElementById("pet-label")).display==="none"&&document.getElementById("pet-activity").hidden&&document.getElementById("pet-activity-text").textContent===""&&getComputedStyle(document.getElementById("pet-balance")).opacity==="1"'));
  await capture('idle-hover.png');
  await wc.debugger.sendCommand('CSS.forcePseudoState',{nodeId:stageNode.nodeId,forcedPseudoClasses:[]});
  wc.debugger.detach();
  ok('护目镜使用平滑缩放，不启用像素放大',current.glassesRendering==='auto');
  const providers=[{id:'cny',name:'DeepSeek',apiKey:'test-secret-not-for-display'},{id:'usd',name:'美元账户'},
    {id:'credits',name:'积分账户',wallet:{remainingStart:120,spent:20,unit:'CREDITS'}},{id:'codex',name:'Codex'},{id:'missing',name:'未接入账户'}];
  const balances={cny:{available:true,remaining:12.5,currency:'CNY'},usd:{available:true,remaining:7.25,currency:'USD'},
    codex:{available:true,kind:'rate-limits',text:'5 小时剩余 75% · 每周剩余 48%'}};
  const aggregate=await report(owner,providers,balances,'cny');await wait(220);current=await snapshot();
  ok('桌宠只显示当前大脑人民币余额，主窗保留总览',current.balance==='¥12.5'&&current.accounts.includes('DeepSeek')&&!current.accounts.includes('美元账户')&&aggregate.totals.includes('$7.25'));
  const brain=await owner.webContents.executeJavaScript('dashboardSelectModel("usd")');await wait(160);current=await snapshot();
  ok('生产模型菜单切换后立即显示美元余额',current.balance==='$7.25'&&!current.accounts.includes('DeepSeek'));
  ok('余额快照不携带密钥或厂商配置',!JSON.stringify(brain).includes('test-secret')&&!JSON.stringify(brain).includes('apiKey'));
  await owner.webContents.executeJavaScript('dashboardSelectModel("credits")');await wait(160);current=await snapshot();
  ok('当前大脑积分保留原单位及手动记账来源',current.balance==='100 CREDITS'&&current.accounts.includes('手动记账'));
  await owner.webContents.executeJavaScript('dashboardSelectModel("codex")');await wait(160);current=await snapshot();
  ok('当前 Codex 大脑显示百分比额度而非其他账户金额',current.balance===balances.codex.text&&!current.accounts.includes('DeepSeek'));
  await owner.webContents.executeJavaScript('dashboardSelectModel("missing")');await wait(160);
  ok('无额度账户不沿用上一个大脑数值',(await snapshot()).balance==='暂不可用');
  await owner.webContents.executeJavaScript('dashboardSelectModel("local-test")');await wait(160);
  ok('切到本地大脑清空外部账户余额',(await snapshot()).balance==='暂无余额数据');
  await owner.webContents.executeJavaScript('dashboardSelectModel("cny")');await wait(160);current=await snapshot();
  await report(other,[{id:'x',name:'另一窗口'}],{x:{available:true,remaining:88,currency:'USD'}},'x');await wait(160);
  ok('其他窗口余额不污染当前宠物',(await snapshot()).balance===current.balance);
  await bind('2:dashboard');ok('切到另一窗口恢复其缓存余额',(await snapshot()).balance==='$88.0');
  await bind('1:dashboard');ok('切回原窗口恢复其账户明细',(await snapshot()).accounts.includes('DeepSeek'));
  await wc.executeJavaScript('document.getElementById("pet-balance").click()');await wait(160);
  ok('余额 HUD 可展开现有聊天面板',(await snapshot()).pet.expanded===true);
  event({kind:'user',text:'显示本轮进度'});event({kind:'turn-start'});
  event({kind:'think',text:'正在核对余额来源'});
  event({kind:'reason',text:'先确认账户余额来自真实接口。\n'});
  event({kind:'reason',text:'再检查不同币种独立展示，积分不参与金额合计。'});
  await wait(520);current=await snapshot();
  ok('思考增量完整合并并替换短提示',current.thoughts.length===1&&current.thoughts[0]==='先确认账户余额来自真实接口。\n再检查不同币种独立展示，积分不参与金额合计。');
  await wc.executeJavaScript('document.querySelector(".thought").open=false');await wait(60);
  event({kind:'reason',text:'\n核对通过。'});await wait(100);
  ok('手动折叠在流式更新后保持',(await snapshot()).thoughtOpen===false);
  await wc.executeJavaScript('document.querySelector(".thought").open=true');await wait(60);
  const hidden='DO_NOT_SHOW_COMMAND_7291 powershell -Command secret-output';
  event({kind:'tool',callId:'cmd',name:'run_command',status:'running',text:hidden});
  event({kind:'status',text:hidden});await wait(520);current=await snapshot();
  ok('工具仍驱动真实动作',current.pet.state==='running');
  ok('独立眼镜层随真实工具切换执行状态且不抢点击',current.glassesState==='running'&&current.glassesPointer==='none');
  ok('命令与工具输出不出现在消息、顶栏、气泡或标题',current.toolRows===0&&![current.chat,current.status,current.detail,current.detailTitle].join(' ').includes('DO_NOT_SHOW'));
  ok('执行工具时保留思考正文',current.detail.includes('账户余额来自真实接口'));
  event({kind:'tool',callId:'cmd',name:'run_command',status:'done'});
  event({kind:'ai-delta',text:'余额面板'});event({kind:'reason',text:'\n对话也单独核对。'});event({kind:'ai-delta',text:'已同步。'});
  // 等待状态最短驻留及后续绘制帧，避免 520ms 恰好早于 450ms 驻留后的下一帧。
  await wait(config.motion.minStateMs+3*1000/config.motion.fps);current=await snapshot();
  ok('交错到达的思考与回复分别合并',current.replies.length===1&&current.replies[0]==='余额面板已同步。'&&current.thoughts[0].includes('对话也单独核对'));
  ok('角色气泡显示当前对话而非上一段思考：'+JSON.stringify({detail:current.detail,state:current.pet.state,presented:current.pet.presentedState}),current.detail==='余额面板已同步。');
  event({kind:'reason',text:'\n'+('账户来源与显示值已核对。'.repeat(45))});await wait(100);
  ok('长思考正文没有在消息区截断',(await snapshot()).thoughts[0].length>500);
  for(let i=0;i<40;i++)bar.pushEvent(bound,{kind:'quota',snapshot:aggregate});
  await bind('1:other');await bind('1:dashboard');current=await snapshot();
  ok('余额刷新不挤掉对话与思考历史',current.thoughts.length===1&&current.replies[0]==='余额面板已同步。');
  ok('历史回灌同样过滤命令与工具输出',!current.chat.includes('DO_NOT_SHOW')&&!current.detail.includes('DO_NOT_SHOW'));
  for(const value of [config.layout.minScale,config.defaultScale,1,config.layout.maxScale]){
    await wc.executeJavaScript('document.getElementById("pet-scale").value='+JSON.stringify(String(value))+';document.getElementById("pet-scale").dispatchEvent(new Event("input"));');
    await wait(180);current=await snapshot();layouts.push({scale:value,...current});
    ok('缩放 '+value+' 对话在上、角色居中、脚下余额同时显示且不重叠',current.labelOpacity==='1'&&current.balanceOpacity==='1'&&current.label.bottom<=current.canvas.top&&current.balanceBox.top-current.canvas.bottom>=config.layout.infoGap-0.1&&current.balanceBox.bottom<=current.stage.bottom&&current.balanceBox.left>=current.stage.left&&current.balanceBox.right<=current.stage.right);
    ok('缩放 '+value+' 长气泡限三行且省略溢出',current.bubbleClamp===String(config.layout.dialogueLines)&&Math.abs(current.label.height-current.bubbleLineHeight*config.layout.dialogueLines-10)<1&&current.bubbleOverflow==='hidden'&&current.bubbleScrollHeight>current.bubbleClientHeight);
    ok('缩放 '+value+' 展开额度在对话区下面',current.msgs.bottom<=current.wallet.top);
    ok('缩放 '+value+' 眼镜与角色画布完全对齐',JSON.stringify(current.glassesBox)===JSON.stringify(current.canvas));
    ok('缩放 '+value+' 输入框仍完整可见',current.input.top>=current.frame.top&&current.input.bottom<=current.frame.bottom&&current.msgs.height>30);
  }
  await wc.executeJavaScript('document.getElementById("pet-scale").value='+JSON.stringify(String(config.defaultScale))+';document.getElementById("pet-scale").dispatchEvent(new Event("input"));');await wait(200);
  bar.pushAsk({kind:'ask',sessionKey:bound,turnId:'turn',question:'确认继续测试？',options:['允许','不允许']});await wait(120);
  ok('隐藏工具文本不妨碍必要确认卡片',await wc.executeJavaScript('!document.getElementById("ask").classList.contains("hidden")&&document.getElementById("askText").textContent.includes("确认继续测试")'));
  event({kind:'answered'});await wait(150);
  await wc.executeJavaScript('document.getElementById("pet-wallet").open=true');await wait(100);
  await capture('expanded.png');
  await wc.executeJavaScript('desktopPet.call("expand",false)');await wait(150);await capture('compact.png');
  await wc.executeJavaScript('desktopPet.call("expand",true)');await wait(150);
  wc.reload();await wait(1000);current=await snapshot();
  ok('重载后恢复账户和同轮思考对话',current.accounts.includes('DeepSeek')&&current.thoughts.length===1&&current.replies[0]==='余额面板已同步。');
  await report(owner,[],{},'');await wait(100);
  ok('删除全部账户后清空旧余额',(await snapshot()).balance==='暂无余额数据'&&(await snapshot()).accounts==='');
  await report(owner,providers,balances,'cny');await wait(100);
  await wc.executeJavaScript('document.getElementById("pet-reduced").checked=true;document.getElementById("pet-reduced").dispatchEvent(new Event("change"));');await wait(200);
  ok('减少动态时眼镜与角色一起固定首帧',(await snapshot()).glassesFrame==='0');
  // 固定静止姿势，直接测量实际眼镜像素的重心位移，不以滑条数值代替绘制验证。
  await wc.executeJavaScript('document.getElementById("pet-preview").value="idle";document.getElementById("pet-preview").dispatchEvent(new Event("change"));');await wait(220);
  const originalPet=await wc.executeJavaScript('document.getElementById("pet-canvas").toDataURL()');
  const positionChecks=await wc.executeJavaScript('('+async function checkPositions(){
    /** 按实际 Alpha 计算重心，独立核对正负及半像素移动方向。 */
    function center(){
      const c=document.getElementById('pet-glasses'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let sum=0,x=0,y=0;
      for(let i=3;i<p.length;i+=4){const a=p[i],pixel=(i-3)/4;sum+=a;x+=(pixel%c.width)*a;y+=Math.floor(pixel/c.width)*a;}
      return {x:x/sum,y:y/sum};
    }
    const baseline=center(),results=[];
    const input=document.getElementById('pet-glasses-offset-y');
    for(const value of [-8,6.5]){
      input.value=String(value);input.dispatchEvent(new Event('input'));
      await new Promise(function(resolve){setTimeout(resolve,220);});
      const actual=center();
      results.push({value,dx:actual.x-baseline.x,dy:actual.y-baseline.y,text:document.getElementById('pet-glasses-offset-value').textContent});
    }
    return results;
  }.toString()+')()');
  for(const row of positionChecks)ok('眼镜实际像素上下偏移 '+row.value+' 且数值同步',Math.abs(row.dx)<0.05&&Math.abs(row.dy-row.value)<0.1&&row.text.includes(String(row.value)));
  ok('上下微调不改变主角色像素',originalPet===await wc.executeJavaScript('document.getElementById("pet-canvas").toDataURL()'));
  const horizontalChecks=await wc.executeJavaScript('('+async function checkHorizontalPositions(){
    /** 读取整层实际 Alpha 重心，检查左右方向、半像素及两轴互不覆盖。 */
    function center(){
      const c=document.getElementById('pet-glasses'),p=c.getContext('2d').getImageData(0,0,c.width,c.height).data;
      let sum=0,x=0,y=0;
      for(let i=3;i<p.length;i+=4){const a=p[i],pixel=(i-3)/4;sum+=a;x+=(pixel%c.width)*a;y+=Math.floor(pixel/c.width)*a;}
      return {x:x/sum,y:y/sum};
    }
    const input=document.getElementById('pet-glasses-offset-x'),baseline=center(),results=[];
    for(const value of [Number(input.min),-8,6.5,Number(input.max),-3.5]){
      input.value=String(value);input.dispatchEvent(new Event('input'));
      await new Promise(function(resolve){setTimeout(resolve,220);});
      const actual=center();
      results.push({value,dx:actual.x-baseline.x,dy:actual.y-baseline.y,text:document.getElementById('pet-glasses-offset-x-value').textContent,y:document.getElementById('pet-glasses-offset-y').value});
    }
    return results;
  }.toString()+')()');
  for(const row of horizontalChecks)ok('眼镜实际像素左右偏移 '+row.value+'，数值同步且保留 Y',Math.abs(row.dx-row.value)<0.1&&Math.abs(row.dy)<0.05&&row.text.includes(String(row.value))&&row.y==='6.5');
  ok('左右滑条范围和步长来自配置',await wc.executeJavaScript('document.getElementById("pet-glasses-offset-x").min==='+JSON.stringify(String(config.glasses.position.min))+'&&document.getElementById("pet-glasses-offset-x").max==='+JSON.stringify(String(config.glasses.position.max))+'&&document.getElementById("pet-glasses-offset-x").step==='+JSON.stringify(String(config.glasses.position.step))));
  ok('左右微调不改变主角色像素',originalPet===await wc.executeJavaScript('document.getElementById("pet-canvas").toDataURL()'));
  const baseBeforeToggle=await wc.executeJavaScript('document.getElementById("pet-canvas").toDataURL()');
  await wc.executeJavaScript('document.getElementById("pet-glasses-enabled").checked=false;document.getElementById("pet-glasses-enabled").dispatchEvent(new Event("change"));');await wait(180);
  current=await snapshot();
  ok('菜单关闭眼镜后实际透明画布清空',!current.glassesEnabled&&current.glassesPixels===0);
  ok('开关眼镜不改变主角色像素',baseBeforeToggle===await wc.executeJavaScript('document.getElementById("pet-canvas").toDataURL()'));
  const settingsPath=path.join(app.getPath('userData'),'desktop-pets','slot-96.json');
  ok('眼镜关闭偏好已写入当前桌宠设置',JSON.parse(fs.readFileSync(settingsPath,'utf8')).glasses===false);
  ok('眼镜上下微调已持久化',JSON.parse(fs.readFileSync(settingsPath,'utf8')).glassesOffsetY===6.5);
  ok('眼镜左右微调已持久化',JSON.parse(fs.readFileSync(settingsPath,'utf8')).glassesOffsetX===-3.5);
  // 新建实际主进程控制器读取刚保存的文件，核对重新启动后的偏好。
  const restartedWindow=new BrowserWindow({show:false});
  const restartedHost=require('../electron/lib/desktop-pet-host').attach(restartedWindow,96,win.getBounds());
  ok('重新创建桌宠控制器仍保留关闭偏好',restartedHost.payload().settings.glasses===false);
  ok('重新创建控制器仍保留上下微调',restartedHost.payload().settings.glassesOffsetY===6.5);
  ok('重新创建控制器仍保留左右微调',restartedHost.payload().settings.glassesOffsetX===-3.5);
  // 用隔离的旧版偏好验证新增 X 字段，不覆盖用户原有的 Y、皮肤或开关。
  const legacy=JSON.parse(fs.readFileSync(settingsPath,'utf8'));delete legacy.glassesOffsetX;
  fs.writeFileSync(path.join(app.getPath('userData'),'desktop-pets','slot-97.json'),JSON.stringify(legacy),'utf8');
  const legacyWindow=new BrowserWindow({show:false});
  const legacyHost=require('../electron/lib/desktop-pet-host').attach(legacyWindow,97,win.getBounds()),migrated=legacyHost.payload().settings;
  ok('旧版偏好按配置补齐 X 且保留 Y、皮肤与开关',migrated.glassesOffsetX===config.glasses.horizontalOffset&&migrated.glassesOffsetY===legacy.glassesOffsetY&&migrated.skin===legacy.skin&&migrated.glasses===legacy.glasses);
  legacyWindow.destroy();
  restartedWindow.destroy();
  wc.reload();await wait(1000);current=await snapshot();
  ok('页面重载后菜单和画布仍为关闭状态',!current.glassesEnabled&&current.glassesPixels===0);
  ok('页面重载后滑条及数值恢复上下微调',await wc.executeJavaScript('document.getElementById("pet-glasses-offset-y").value==="6.5"&&document.getElementById("pet-glasses-offset-value").textContent.includes("6.5")'));
  ok('页面重载后滑条及数值恢复左右微调',await wc.executeJavaScript('document.getElementById("pet-glasses-offset-x").value==="-3.5"&&document.getElementById("pet-glasses-offset-x-value").textContent.includes("-3.5")'));
  await wc.executeJavaScript('document.getElementById("pet-glasses-enabled").checked=true;document.getElementById("pet-glasses-enabled").dispatchEvent(new Event("change"));');await wait(180);
  current=await snapshot();
  ok('重新开启眼镜恢复实际叠加像素',current.glassesEnabled&&current.glassesPixels>500);
  await wc.executeJavaScript('document.getElementById("pet-reduced").checked=false;document.getElementById("pet-reduced").dispatchEvent(new Event("change"));');await wait(100);
  ok('页面无脚本或渲染错误',errors.length===0&&(await snapshot()).pet.errors==='');
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({passed,errors,layouts,fixture:true},null,2),'utf8');
  console.log('RESULT '+passed.length+' 项通过；截图 '+output);
  if(process.argv.includes('--preview')||process.argv.includes('--screenshot')){
    await bind('1:preview');
    event({kind:'user',text:'看看桌宠的新面板'});
    event({kind:'turn-start'});
    event({kind:'reason',text:'余额只跟随当前大脑，放在桌宠脚下，三行对话位于角色上方。对话与思考各自成卡，工具只驱动动作。'});
    event({kind:'ai',text:'当前大脑额度已同步。气泡最多显示三行，长内容显示省略号，点击后可以展开阅读完整对话。'});
    await wc.executeJavaScript('document.getElementById("pet-wallet").open=true');
    bar.moveToPlace('right');await wait(520);await capture('preview.png');
    if(process.argv.includes('--preview')){console.log('PREVIEW_PID '+process.pid);setTimeout(finish,55000);}
    else finish();
  }else finish();
}
/** 关闭仅由测试创建的窗口，不触碰用户运行中的 SpCode。 */
function finish(){bar.destroy();owner.destroy();other.destroy();app.quit();}
/** 失败保存诊断和真实截图，并以非零状态退出。 */
async function failed(error){
  console.error(error.stack||error);fs.mkdirSync(output,{recursive:true});
  fs.writeFileSync(path.join(output,'failure.txt'),String(error.stack||error),'utf8');
  if(wc&&!wc.isDestroyed())await capture('failure.png');
  app.exit(1);
}
app.whenReady().then(run).catch(failed);
