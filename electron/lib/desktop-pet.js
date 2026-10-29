/* 桌宠呈现层：播放皮肤、透明像素命中与拖动，复用原小窗聊天和确认。 */
(function () {
  'use strict';
  var bridge=window.desktopPet;
  var chat=window.floatBar;
  var canvas=document.getElementById('pet-canvas');
  var ctx=canvas.getContext('2d',{willReadFrequently:true});
  // 配饰独占透明画布，绝不把眼镜写进角色图集或主角色像素。
  var glasses=document.getElementById('pet-glasses');
  var glassesContext=glasses.getContext('2d');
  var label=document.getElementById('pet-label');
  var activityBadge=document.getElementById('pet-activity');
  var activityPath=document.getElementById('pet-activity-path');
  var activityText=document.getElementById('pet-activity-text');
  var lastActivity='';
  var workIndicator=document.getElementById('pet-work-indicator');
  var workPath=document.getElementById('pet-work-path');
  // 仅正在产出或执行操作时点亮；等待、终止与拖动预览不伪装为工作。
  var workingStates=['thinking','speaking','reading','searching','writing','running','testing','desktop','generating'];
  // 每种工作有独立矢量图标；文字复用状态配置，换肤不改变工作含义。
  var activityIcons={
    idle:'M5 8h12v8a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4ZM17 9h2a3 3 0 0 1 0 6h-2M8 3v2M12 3v2',
    thinking:'M9 18h6M10 21h4M8 14a7 7 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3M12 6v3M10.5 7.5h3',
    speaking:'M21 11a8 8 0 0 1-8 8H8l-5 3 1-6a8 8 0 1 1 17-5ZM8 10h8M8 14h5',
    reading:'M12 5v15M12 5C9 3 6 3 2 4v15c4-1 7-1 10 1 3-2 6-2 10-1V4c-4-1-7-1-10 1M5 8h4M15 8h4M5 12h4M15 12h4',
    searching:'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0ZM14.5 14.5 21 21M7 10h6M10 7v6',
    writing:'M4 16 16 4a2.8 2.8 0 0 1 4 4L8 20l-5 1ZM14 6l4 4M4 16l4 4',
    running:'M3 4h18v16H3ZM7 9l3 3-3 3M13 16h4',
    testing:'M9 3h6M10 3v7L4 19a1.3 1.3 0 0 0 1 2h14a1.3 1.3 0 0 0 1-2l-6-9V3M8 14h8M9 17l2 2 4-4',
    desktop:'M3 4h18v12H3ZM8 21h8M12 16v5M11 8l7 3-3 1-1 3Z',
    generating:'M13 4H3v17h17v-9M3 16l5-5 5 5 3-3 4 4M18 2v6M15 5h6M6 7h.01',
    waiting:'M6 3h12M6 21h12M7 3v4l10 10v4M17 3v4 0L7 17v4M9 17h6',
    success:'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0ZM7 12l3 3 7-7',
    error:'M12 3 1 21h22ZM12 9v5M12 18h.01',
    stopped:'M4 4h16v16H4ZM9 9h6v6H9Z',
    dragging:'M12 3v12M8 7l4-4 4 4M4 14v6h16v-6',
    landing:'M12 3v12M8 11l4 4 4-4M4 20h16'
  };
  var menu=document.getElementById('pet-menu');
  var skinSelect=document.getElementById('pet-skin');
  var preview=document.getElementById('pet-preview');
  var errorEl=document.getElementById('pet-error');
  var current=null,model=null,skin=null,image=null,queue=[],drag=null,lastHit=null;
  var animationStart=0,lastState='',landingUntil=0,lastPaint=0,previewState='',generation=0;
  // 空闲保持站姿，所有呈现动作均来自工作状态或用户手动预览。
  var presentedState='idle';
  var previousFrame=document.createElement('canvas');
  var previousContext=previousFrame.getContext('2d');
  // 配饰保存上一张实际显示帧，并在离屏画布绘制新帧，与角色共用同一个交叉淡化进度。
  var previousGlasses=document.createElement('canvas');
  var previousGlassesContext=previousGlasses.getContext('2d');
  var glassesFrame=document.createElement('canvas');
  var glassesFrameContext=glassesFrame.getContext('2d');
  /** 显示实际接口或资源错误，不用其他皮肤掩盖加载失败。 */
  function showError(error) { errorEl.textContent=String(error.message||error);menu.hidden=false; }
  /** 界面配置跟随主进程，大小变化不会重建消息区或输入框。 */
  function view(data) {
    if(!current)return; // 初始化响应之后会应用主进程当前形态。
    current.expanded=data.expanded;current.settings=data.settings;
    document.body.classList.toggle('pet-expanded',data.expanded);
    document.body.classList.toggle('pet-collapsed',!data.expanded);
    document.body.classList.toggle('pet-reduced-motion',data.settings.reducedMotion);
    document.documentElement.style.setProperty('--pet-size',current.config.layout.petSize*data.settings.scale+'px');
    document.documentElement.style.setProperty('--pet-dialogue-lines',String(current.config.layout.dialogueLines));
    // 脚下余额独占底部留白，角色与眼镜同步上移；尺寸及间隔统一由布局配置提供。
    document.documentElement.style.setProperty('--pet-balance-height',current.config.layout.balanceHeight+'px');
    document.documentElement.style.setProperty('--pet-info-gap',current.config.layout.infoGap+'px');
    document.documentElement.style.setProperty('--pet-info-inset',current.config.layout.infoInset+'px');
    document.documentElement.style.setProperty('--pet-footer-height',(current.config.layout.balanceHeight+current.config.layout.infoGap+current.config.layout.infoInset)+'px');
    var p=data.placement;
    document.documentElement.style.setProperty('--pet-height',p.petHeight+'px');
    document.documentElement.style.setProperty('--pet-width',p.petWidth+'px');
    document.documentElement.style.setProperty('--pet-left',p.petLeft+'px');
    document.documentElement.style.setProperty('--pet-top',p.petTop+'px');
    document.documentElement.style.setProperty('--panel-left',p.panelLeft+'px');
    document.documentElement.style.setProperty('--panel-top',p.panelTop+'px');
    document.documentElement.style.setProperty('--panel-width',p.panelWidth+'px');
    document.documentElement.style.setProperty('--panel-height',p.panelHeight+'px');
    lastHit=null;
    lastActivity=''; // 缩放或减少动态设置改变后同步信息槽与工作标记。
  }
  /** 先解码新图集再原子切换，异步加载顺序不会让旧皮肤覆盖新选择。 */
  async function loadSkin() {
    var token=++generation;
    var selected=null;
    for(var i=0;i<current.skins.length;i++)if(current.skins[i].id===current.settings.skin)selected=current.skins[i];
    if(!selected||selected.error)throw new Error(selected?selected.error:'找不到所选皮肤');
    var next=new Image();next.src=selected.atlasUrl;await next.decode();
    if(token!==generation)return;
    skin=selected;image=next;animationStart=performance.now();lastState='';
    previewState='';paintMenu();
    canvas.width=skin.cellSize;canvas.height=skin.cellSize;
    glasses.width=skin.cellSize;glasses.height=skin.cellSize;
    glassesFrame.width=skin.cellSize;glassesFrame.height=skin.cellSize;
  }
  /** 菜单只更新皮肤选项，不触碰真实任务状态。 */
  function paintMenu() {
    skinSelect.textContent='';
    for(var i=0;i<current.skins.length;i++){
      var one=current.skins[i],option=document.createElement('option');
      option.value=one.id;option.textContent=one.name+(one.error?' · '+one.error:'');option.disabled=!!one.error;skinSelect.appendChild(option);
    }
    skinSelect.value=current.settings.skin;
    document.getElementById('pet-scale').value=String(current.settings.scale);
    document.getElementById('pet-speed').value=String(current.settings.speed);
    document.getElementById('pet-reduced').checked=current.settings.reducedMotion;
    document.getElementById('pet-glasses-enabled').checked=current.settings.glasses;
    // 控件与主进程共用图集像素范围，数值不随桌宠显示缩放变化。
    var horizontal=document.getElementById('pet-glasses-offset-x');
    horizontal.min=String(current.config.glasses.position.min);horizontal.max=String(current.config.glasses.position.max);horizontal.step=String(current.config.glasses.position.step);
    horizontal.value=String(current.settings.glassesOffsetX);
    document.getElementById('pet-glasses-offset-x-value').textContent=String(current.settings.glassesOffsetX)+' px（负数左移）';
    var offset=document.getElementById('pet-glasses-offset-y');
    offset.min=String(current.config.glasses.position.min);offset.max=String(current.config.glasses.position.max);offset.step=String(current.config.glasses.position.step);
    offset.value=String(current.settings.glassesOffsetY);
    document.getElementById('pet-glasses-offset-value').textContent=String(current.settings.glassesOffsetY)+' px（负数上移）';
    document.getElementById('pet-scale').min=String(current.config.layout.minScale);
    document.getElementById('pet-scale').max=String(current.config.layout.maxScale);
    document.getElementById('pet-scale').step=String(current.config.layout.scaleStep);
    // 换肤后按实际图集重新列动作，避免沿用上一套皮肤的预览选择。
    if(skin){
      preview.textContent='';
      var real=document.createElement('option');real.value='';real.textContent='跟随 AI 实际工作';preview.appendChild(real);
      for(var pose in skin.animations){var opt=document.createElement('option');opt.value=pose;opt.textContent=current.config.labels[pose];preview.appendChild(opt);}
      preview.value=previewState;
    }
  }
  /** 设置成功后更新外观；失败显示原因并保留输入内容。 */
  async function settings(patch) {
    errorEl.textContent='';
    var oldSkin=current.settings.skin;
    current=await bridge.call('settings',patch);
    view(current);paintMenu();
    if(oldSkin!==current.settings.skin)await loadSkin();
  }
  /** 事件先通过绑定与轮次过滤，再驱动动作，历史回灌不会重放庆祝。 */
  function event(ev) {
    if(!model){queue.push(ev);return;}
    model.apply(ev,performance.now(),false);
  }
  /** 等待确认使用同一状态入口，原页面继续负责问句与回答选项。 */
  function ask(ev) { event(Object.assign({},ev,{kind:'ask'})); }
  /**
   * 将真实工作类别同步到右上角 HUD 与辅助阅读短句。
   * state 来自已过滤会话事件的状态机；预览明确标注，拖动不覆盖正在执行的工作。
   * 只在状态或布局变化时更新 DOM；正文与余额由纵向信息区排布，同时显示。
   */
  function paintActivity(state) {
    var key=(previewState?'preview:':'actual:')+state;
    if(key===lastActivity)return;
    lastActivity=key;
    // 实际空闲不输出状态短句或图标；手动动作预览仍明确标注。
    var idle=state==='idle'&&!previewState;
    var text=idle?'':(previewState?'预览 · ':'')+current.config.labels[state];
    activityBadge.hidden=idle;
    activityPath.setAttribute('d',idle?'':activityIcons[state]);
    activityText.textContent=text;
    activityBadge.dataset.state=state;
    activityBadge.title=text;
    // 与短标签共用状态来源和图形，不受角色拖起/落地姿态覆盖；预览沿用明确的预览标注。
    workIndicator.hidden=workingStates.indexOf(state)<0;
    workIndicator.dataset.state=state;
    workIndicator.title=text;
    workPath.setAttribute('d',activityIcons[state]);
    // 正文与脚下余额独立布局，实际空闲隐藏正文时余额仍保持在角色下方。
  }
  /** 帧序来自皮肤声明，减少动态时固定展示有辨识度的首帧。 */
  function tick(now) {
    requestAnimationFrame(tick);
    if(!current||!image)return;
    model.select(now,false);
    var state=previewState||model.state;
    paintActivity(state);
    if(drag&&drag.moved)state='dragging';
    else if(now<landingUntil)state='landing';
    presentedState=state;
    document.body.dataset.petState=state;
    // 实际空闲只显示余额；提起和落地也不显示动作提示气泡。
    label.hidden=(state==='idle'&&!previewState)||state==='dragging'||state==='landing';
    if(state!==lastState){
      previousFrame.width=canvas.width;previousFrame.height=canvas.height;
      previousContext.drawImage(canvas,0,0);
      previousGlasses.width=glasses.width;previousGlasses.height=glasses.height;
      previousGlassesContext.drawImage(glasses,0,0);
      lastState=state;animationStart=now;
    }
    var clip=skin.animations[state];
    var fps=state==='landing'?clip.frames/current.config.motion.landingMs*1000:skin.fps*current.settings.speed;
    if(now-lastPaint<1000/fps)return;
    lastPaint=now;
    var frame=current.settings.reducedMotion?0:Math.floor((now-animationStart)*fps/1000);
    frame=clip.loop?frame%clip.frames:Math.min(frame,clip.frames-1);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    // 状态换姿势时以缓出曲线交叉淡化，像素命中读取的是实际混合后的画面。
    var blend=current.settings.reducedMotion?1:Math.min(1,(now-animationStart)/current.config.motion.blendMs);
    blend=1-Math.pow(1-blend,3);
    ctx.globalAlpha=1-blend;ctx.drawImage(previousFrame,0,0);
    ctx.globalAlpha=blend;
    ctx.drawImage(image,frame*skin.cellSize,clip.row*skin.cellSize,skin.cellSize,skin.cellSize,0,0,canvas.width,canvas.height);
    ctx.globalAlpha=1;
    // 配饰复用角色的动作、帧号与缓出权重，连续切换时保留上一张实际混合画面。
    glassesContext.clearRect(0,0,glasses.width,glasses.height);
    if(current.settings.glasses){
      var glassesConfig=Object.assign({},current.config.glasses,{horizontalOffset:current.settings.glassesOffsetX,verticalOffset:current.settings.glassesOffsetY});
      window.DesktopPetGlasses.paint(glassesFrameContext,glassesConfig,skin,state,frame);
      glassesContext.globalAlpha=1-blend;glassesContext.drawImage(previousGlasses,0,0);
      glassesContext.globalAlpha=blend;glassesContext.drawImage(glassesFrame,0,0);
      glassesContext.globalAlpha=1;
      glasses.dataset.state=glassesFrame.dataset.state;glasses.dataset.frame=String(frame);
    }else glasses.dataset.state='';
    // 气泡仅使用已筛选的思考与对话，全文可在展开面板阅读；工具只改变动作。
    var shown=previewState?('预览 · '+current.config.labels[state]):(model.detail&&String(model.detail).trim()?String(model.detail):current.config.labels[state]);
    label.textContent=label.hidden?'':shown;
    // 外侧正文按配置保留三行阅读并省略溢出；点击查看完整对话，脚下余额同时保留。
    label.title=label.hidden?'':'点击展开完整对话';
    canvas.setAttribute('aria-label',shown||current.config.labels[state]);
  }
  /** 当前帧 Alpha 决定角色可点击区，透明边角与手脚间的空隙可穿透。 */
  function hit(e) {
    if(!image)return false;
    if(!menu.hidden&&menu.contains(e.target))return true;
    if(current.expanded&&document.getElementById('frame').contains(e.target))return true;
    if(e.target===label||document.getElementById('pet-balance').contains(e.target))return true;
    var b=canvas.getBoundingClientRect();
    if(e.clientX<b.left||e.clientX>=b.right||e.clientY<b.top||e.clientY>=b.bottom)return false;
    var x=Math.floor((e.clientX-b.left)*canvas.width/b.width),y=Math.floor((e.clientY-b.top)*canvas.height/b.height);
    return ctx.getImageData(x,y,1,1).data[3]>=current.config.motion.alphaThreshold;
  }
  /** 只在命中状态变化时通知主进程，避免每帧 IPC。 */
  function pointerMove(e) {
    if(!current)return;
    if(drag) {
      var moved=Math.hypot(e.screenX-drag.x,e.screenY-drag.y)>current.config.motion.dragThreshold;
      if(moved)drag.moved=true;
      if(drag.moved)bridge.call('drag',{phase:'move'}).catch(showError);
      return;
    }
    var inside=hit(e);
    if(inside!==lastHit){lastHit=inside;bridge.call('hit',inside).catch(showError);}
  }
  /** 拖动仅从实际角色像素开始，短点击则展开原聊天。 */
  function pointerDown(e) {
    if(e.button!==0||e.target!==canvas||!hit(e))return;
    e.preventDefault();drag={x:e.screenX,y:e.screenY,moved:false};
    canvas.setPointerCapture(e.pointerId);
    bridge.call('drag',{phase:'start'}).catch(showError);
  }
  /** 松开后恢复实际工作动作；位移产生落地动画。 */
  async function pointerUp(e) {
    if(!drag)return;
    var moved=drag.moved;drag=null;
    await bridge.call('drag',{phase:'end'});
    if(canvas.hasPointerCapture(e.pointerId))canvas.releasePointerCapture(e.pointerId);
    if(moved)landingUntil=performance.now()+current.config.motion.landingMs;
    else await bridge.call('expand',!current.expanded);
  }
  /** 右键只打开换肤菜单，不改变会话绑定。 */
  async function openMenu(e) {
    if(e){e.preventDefault();if(!hit(e))return;}
    await bridge.call('expand',true);menu.hidden=false;paintMenu();
  }
  /** 初始化过程中暂存推送，避免新页面漏掉刚开始的一轮。 */
  async function init() {
    current=await bridge.call('init');model=new window.DesktopPetState.Model(current.config);
    view(current);paintMenu();await loadSkin();
    for(var i=0;i<queue.length;i++)event(queue[i]);
    queue=[];
    chat.bind('');
    requestAnimationFrame(tick);
  }
  chat.onEvent(event);chat.onAsk(ask);bridge.onView(view);
  /** Ctrl 滚轮直接调整显示大小，脚底锚点和当前任务保持不变。 */
  document.addEventListener('wheel',function(e){
    if(!current||!e.ctrlKey||!hit(e))return;
    e.preventDefault();
    var step=current.config.layout.scaleStep*(e.deltaY<0?1:-1);
    var value=Math.max(current.config.layout.minScale,Math.min(current.config.layout.maxScale,Math.round((current.settings.scale+step)*100)/100));
    settings({scale:value}).catch(showError);
  },{passive:false});
  document.addEventListener('pointermove',pointerMove);
  canvas.addEventListener('pointerdown',pointerDown);
  document.addEventListener('pointerup',function(e){pointerUp(e).catch(showError);});
  document.addEventListener('pointercancel',function(e){pointerUp(e).catch(showError);});
  document.addEventListener('contextmenu',function(e){openMenu(e).catch(showError);});
  document.addEventListener('mouseleave',function(){if(!drag){lastHit=false;bridge.call('hit',false).catch(showError);}});
  label.addEventListener('click',function(){bridge.call('expand',!current.expanded).catch(showError);});
  document.getElementById('pet-menu-close').addEventListener('click',function(){menu.hidden=true;previewState='';preview.value='';});
  document.getElementById('pet-settings-open').addEventListener('click',function(){openMenu().catch(showError);});
  skinSelect.addEventListener('change',function(){settings({skin:skinSelect.value}).catch(showError);});
  document.getElementById('pet-scale').addEventListener('input',function(e){settings({scale:Number(e.target.value)}).catch(showError);});
  document.getElementById('pet-speed').addEventListener('change',function(e){settings({speed:Number(e.target.value)}).catch(showError);});
  document.getElementById('pet-reduced').addEventListener('change',function(e){settings({reducedMotion:e.target.checked}).catch(showError);});
  /** 将用户勾选的眼镜开关交给现有设置接口，保存成功后同步菜单与叠加层。 */
  function changeGlasses(e) { settings({glasses:e.target.checked}).catch(showError); }
  document.getElementById('pet-glasses-enabled').addEventListener('change',changeGlasses);
  /** 拖动左右滑条实时保存水平图集像素偏移，保留上下位置与角色状态。 */
  function changeGlassesHorizontalPosition(e) { settings({glassesOffsetX:Number(e.target.value)}).catch(showError); }
  document.getElementById('pet-glasses-offset-x').addEventListener('input',changeGlassesHorizontalPosition);
  /** 拖动上下滑条实时保存图集像素偏移；不修改眼部锚点、角色图集或工作状态。 */
  function changeGlassesPosition(e) { settings({glassesOffsetY:Number(e.target.value)}).catch(showError); }
  document.getElementById('pet-glasses-offset-y').addEventListener('input',changeGlassesPosition);
  preview.addEventListener('change',function(){previewState=preview.value;animationStart=performance.now();});
  document.getElementById('pet-import').addEventListener('click',async function(){try{var result=await bridge.call('import');if(!result.cancelled){current=result;paintMenu();}}catch(error){showError(error);}});
  document.getElementById('pet-hide').addEventListener('click',function(){chat.hide();});
  // 供自动化核对实际页面状态与当前帧，不提供修改真实 AI 状态的接口。
  window.desktopPetInspect=function(){return {state:model?model.state:null,presentedState:presentedState,key:model?model.key:null,skin:skin?skin.id:null,expanded:current?current.expanded:null,scale:current?current.settings.scale:null,errors:errorEl.textContent};};
  init().catch(showError);
})();
