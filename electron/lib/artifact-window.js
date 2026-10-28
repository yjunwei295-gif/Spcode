/** 独立作品窗口：工具栏是可信界面，作品由没有 Node 和 preload 的 WebContentsView 运行。 */
const path=require('path');
const fs=require('fs');
const {pathToFileURL}=require('url');
const studio=require('./artifact-studio');
const snapshot=require('./snapshot');
const contexts=new Map();
const SOURCE_WATCH_INTERVAL_MS=500;

/** 将作品页的状态明确显示在工具栏；失败信息保留，不将失败当成已刷新。 */
function status(ctx,text){if(!ctx.win.isDestroyed())ctx.win.webContents.send('artifact:status',text);}

/** 状态和更新事件使用同一份参数，配乐切换也跟随作品清单。 */
function stateOf(ctx){return {item:ctx.item,theme:ctx.theme,audioUrl:ctx.item.audioPath?pathToFileURL(studio.sourceFile(ctx.workspace,ctx.item.audioPath)).href:null};}

/** 读取并重新绘制最新源文件；同一窗口的加载顺序由 ready 串行维护。 */
async function loadPage(ctx){
  await ctx.view.webContents.loadFile(studio.sourceFile(ctx.workspace,ctx.item.sourcePath));
  await ctx.view.webContents.executeJavaScript(studio.paintScript(ctx.item,0,false));
  status(ctx,'已更新 · '+ctx.item.width+' × '+ctx.item.height);
}

/** 刷新失败直接反馈，下一次用户刷新或文件保存可以重新尝试。 */
function reload(ctx){
  async function load(){
    ctx.item=await studio.read(ctx.workspace,ctx.item.manifest);
    await ctx.paint;
    await loadPage(ctx);
    ctx.win.webContents.send('artifact:updated',stateOf(ctx));
  }
  ctx.ready=ctx.ready.then(load,load);
  // watch 回调没有请求响应，错误由状态栏接收；ready 仍保留拒绝供 seek/open 调用方读取。
  ctx.ready.catch(function report(error){status(ctx,'预览失败：'+error.message);});
  return ctx.ready;
}

/** 在独立子视图里按作品尺寸缩放，工具栏和时间轴不参与画布导出。 */
function layout(ctx,bounds){
  const scale=Math.min(bounds.width/ctx.item.width,bounds.height/ctx.item.height);
  const width=Math.max(1,Math.floor(ctx.item.width*scale));
  const height=Math.max(1,Math.floor(ctx.item.height*scale));
  ctx.view.setBounds({x:Math.floor(bounds.x+(bounds.width-width)/2),y:Math.floor(bounds.y+(bounds.height-height)/2),width,height});
  ctx.view.webContents.setZoomFactor(scale);
}

/** 打开或更新同一源稿的窗口；关闭时释放子页面、文件监听以及本窗口的导出任务。 */
async function open({workspace,manifest,owner,theme}){
  const {BrowserWindow,WebContentsView,session}=require('electron');
  const item=await studio.read(workspace,manifest);
  for(const ctx of contexts.values()){
    if(ctx.workspace===workspace&&ctx.item.manifest===item.manifest){
      ctx.item=item;
      await reload(ctx);
      ctx.win.webContents.send('artifact:updated',stateOf(ctx));
      ctx.win.show();ctx.win.focus();return ctx;
    }
  }
  const win=new BrowserWindow({width:1100,height:820,minWidth:660,minHeight:480,parent:owner,show:false,title:item.title+' · 作品',webPreferences:{preload:path.join(__dirname,'../artifact-preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  // 作品独立会话不共享聊天窗口权限；网页自身不接触宿主 API。
  const isolated=session.fromPartition('artifact-'+win.id);
  function denyPermission(_contents,_permission,callback){callback(false);}
  isolated.setPermissionRequestHandler(denyPermission);
  const view=new WebContentsView({webPreferences:{session:isolated,nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  function denyWindow(){return {action:'deny'};}
  view.webContents.setWindowOpenHandler(denyWindow);
  // 首帧提交后再设置透明背景，避免空白的透明子视图在显示前停止绘制。
  win.contentView.addChildView(view);
  const ctx={id:win.webContents.id,win,view,workspace,item,theme,ready:Promise.resolve(),paint:Promise.resolve(),exporting:null};
  contexts.set(win.webContents.id,ctx);
  const source=studio.sourceFile(workspace,item.sourcePath);
  function sourceChanged(current,previous){if(current.mtimeMs!==previous.mtimeMs)reload(ctx);}
  const recordFile=path.join(workspace,item.manifest);
  fs.watchFile(source,{interval:SOURCE_WATCH_INTERVAL_MS,persistent:false},sourceChanged);
  fs.watchFile(recordFile,{interval:SOURCE_WATCH_INTERVAL_MS,persistent:false},sourceChanged);
  function closed(){
    fs.unwatchFile(source,sourceChanged);
    fs.unwatchFile(recordFile,sourceChanged);
    if(ctx.exporting)ctx.exporting.abort();
    if(!view.webContents.isDestroyed())view.webContents.close();
    contexts.delete(ctx.id);
  }
  win.on('closed',closed);
  await win.loadFile(path.join(__dirname,'../../renderer/artifact.html'));
  // 可见窗口先显示再等待绘制帧；隐藏的普通子视图不会提交 RAF，反过来等待会卡住打开。
  win.show();
  ctx.ready=loadPage(ctx);
  await ctx.ready;
  view.setBackgroundColor('#00000000');
  return ctx;
}

/** 只接受作品工具栏自己的 IPC；作品 WebContentsView 没有这份 preload。 */
function context(event){
  const ctx=contexts.get(event.sender.id);
  if(!ctx)throw new Error('作品窗口已关闭');
  return ctx;
}

/** 导出前先让用户选择下载位置；取消不会启动渲染。项目内导出文件接入现有快照。 */
async function save(ctx,format,time){
  const {dialog,app}=require('electron');
  if(ctx.exporting)throw new Error('当前作品正在导出');
  const name=path.basename(ctx.item.sourcePath,path.extname(ctx.item.sourcePath))+'.'+format;
  const selected=await dialog.showSaveDialog(ctx.win,{title:'下载作品',defaultPath:path.join(app.getPath('downloads'),name),filters:[{name:format.toUpperCase(),extensions:[format]}]});
  if(selected.canceled)return {cancelled:true};
  ctx.exporting=new AbortController();
  let snap;
  function record(relative){if(!snap)snap=snapshot.create(ctx.workspace,'作品导出');snapshot.recordChange(ctx.workspace,snap,relative,'write');}
  function progress(value){status(ctx,'视频导出 '+value.percent+'%（'+value.frame+'/'+value.totalFrames+' 帧）');}
  try{
    /** 下载 PNG 截取用户当前交互状态，等待在途绘制后再采样，输出保持登记尺寸。 */
    async function currentImage(){
      await ctx.ready;await ctx.paint;
      // 直接让 Chromium 截取作品视口，透明或被其他应用遮挡时也不依赖桌面显示表面。
      const debuggerApi=ctx.view.webContents.debugger;
      debuggerApi.attach('1.3');
      try{
        const image=await debuggerApi.sendCommand('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
        const shot=require('electron').nativeImage.createFromBuffer(Buffer.from(image.data,'base64'));
        return shot.resize({width:ctx.item.width,height:ctx.item.height,quality:'best'}).toPNG();
      }finally{debuggerApi.detach();}
    }
    const result=await studio.exportArtifact({workspace:ctx.workspace,args:{manifest:ctx.item.manifest,format,time},signal:ctx.exporting.signal,beforeWrite:record,onProgress:progress,captureImage:currentImage});
    await fs.promises.copyFile(studio.sourceFile(ctx.workspace,result.file),selected.filePath);
    status(ctx,'已下载：'+selected.filePath);
    return {path:selected.filePath,result};
  }finally{ctx.exporting=null;}
}

/** 注册主窗入口与作品工具栏操作；项目绑定由既有主进程提供，页面不能指定其他项目。 */
function registerIpc({ipcMain,getWorkspace,getOwner}){
  ipcMain.handle('artifact:list',function list(event){return studio.list(getWorkspace(event));});
  ipcMain.handle('artifact:open',function show(event,payload){return open({workspace:getWorkspace(event),manifest:payload.manifest,owner:getOwner(event),theme:payload.theme}).then(function shown(){return true;});});
  ipcMain.handle('artifact:state',function state(event){const ctx=context(event);return stateOf(ctx);});
  ipcMain.on('artifact:layout',function resized(event,bounds){layout(context(event),bounds);});
  ipcMain.handle('artifact:seek',async function seek(event,time){
    const ctx=context(event);
    if(!Number.isFinite(time)||time<0||time>ctx.item.duration)throw new Error('预览时间超出范围');
    await ctx.ready;
    /** 每个窗口串行提交时间采样，暂停后下载不会截到尚未完成的上一帧。 */
    function paint(){return ctx.view.webContents.executeJavaScript(studio.paintScript(ctx.item,time,false));}
    const painting=ctx.paint.then(paint);
    /** 已失败的帧也结束队列占用；原始错误仍交给当前调用方和状态栏，不影响修正源稿后的刷新。 */
    function failedFrame(error){status(ctx,'绘制失败：'+error.message);}
    ctx.paint=painting.then(function finished(){},failedFrame);
    await painting;
    return time;
  });
  ipcMain.handle('artifact:refresh',function refresh(event){return reload(context(event));});
  ipcMain.handle('artifact:save',function download(event,payload){return save(context(event),payload.format,payload.time);});
  ipcMain.handle('artifact:cancel',function cancel(event){const ctx=context(event);if(ctx.exporting)ctx.exporting.abort();return true;});
}
module.exports={registerIpc,open,contexts,layout,save};
