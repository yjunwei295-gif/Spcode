/** 代码作品的登记、重开与导出；网页源稿保留在项目内，作品清单只保存相对路径。 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { isInside } = require('./workspace');
const video = require('./code-video');

const toolSpecs = [
  { type: 'function', function: {
    name: 'present_artifact',
    description: '将已写好的 HTML/Canvas/SVG 作品登记为可交互的网页作品卡片，用户可打开预览、刷新、下载图片和源文件；动画可播放、拖动时间和导出 MP4。先写源文件，再调用本工具。width/height 明确指定作品像素尺寸；动画必须同时提供 fps/duration，HTML 定义 window.renderFrame(time,frame,info)，每帧由时间决定；已有配乐可填 audioPath。修改同一源文件后再次调用会更新同一作品。图片、流程图、方案优先用网页代码表达，需要模型素材时另用 generate_media。',
    parameters: {type:'object',properties:{sourcePath:{type:'string',description:'项目内的 HTML 或 SVG 文件'},title:{type:'string',description:'作品标题'},width:{type:'integer',description:'作品宽度，像素'},height:{type:'integer',description:'作品高度，像素'},fps:{type:'number',description:'动画帧率，与 duration 同时提供'},duration:{type:'number',description:'动画时长，秒，与 fps 同时提供'},audioPath:{type:'string',description:'可选，项目内配乐/配音文件'}},required:['sourcePath','title','width','height']}
  }},
  { type: 'function', function: {
    name: 'export_artifact',
    description: '导出 present_artifact 登记的代码作品。manifest 用登记结果中的路径；format=png 导出指定时刻的完整画布，svg/html 下载同格式源文件，mp4 按登记的动画参数调用既有视频渲染器。time 为 PNG 的采样秒数，省略表示首帧。产物写入 generated/ 唯一目录，返回实际文件路径；需要检查真实画面后再交付。',
    parameters:{type:'object',properties:{manifest:{type:'string',description:'登记结果中的作品清单相对路径'},format:{type:'string',enum:['png','svg','html','mp4']},time:{type:'number',description:'PNG 采样时间，秒'}},required:['manifest','format']}
  }}
];

/** 定位项目内真实文件；不将相邻目录或符号链接指向的项目外文件当成作品。 */
function sourceFile(workspace, relative) {
  if (!workspace || !relative) throw new Error('请提供已打开的项目和作品路径');
  const file = fs.realpathSync(path.resolve(workspace, relative));
  if (!isInside(fs.realpathSync(workspace), file)) throw new Error('作品文件必须位于当前项目内');
  return file;
}

/** 检查作品尺寸、源稿类型与动画时序，错误直接报告，不替换参数。 */
function validate(workspace, args) {
  const source = sourceFile(workspace, args.sourcePath);
  const ext = path.extname(source).toLowerCase();
  if (ext !== '.html' && ext !== '.svg') throw new Error('作品源文件必须是 HTML 或 SVG');
  if (typeof args.title !== 'string' || !args.title.trim()) throw new Error('作品需要标题');
  for (const key of ['width','height']) if (!Number.isInteger(args[key]) || args[key] <= 0) throw new Error(key + ' 必须是正整数');
  const animated = args.fps !== undefined || args.duration !== undefined;
  if (animated && (ext !== '.html' || !Number.isFinite(args.fps) || args.fps <= 0 || !Number.isFinite(args.duration) || args.duration <= 0)) throw new Error('HTML 动画必须同时提供正数 fps 和 duration');
  if (args.audioPath && !animated) throw new Error('配乐仅用于已声明时序的 HTML 动画');
  if (args.audioPath) sourceFile(workspace, args.audioPath);
  return {source,ext,animated};
}

/** 作品记录统一位于 generated/artifacts；同一源稿使用稳定标识，重复展示只更新它。 */
function directory(workspace) { return path.join(workspace, 'generated', 'artifacts'); }

/** 登记源稿和参数，写前通知快照；返回的记录可直接保存到聊天历史。 */
async function present({workspace,args,beforeWrite}) {
  validate(workspace,args);
  const sourcePath = path.relative(workspace, sourceFile(workspace,args.sourcePath)).replace(/\\/g,'/');
  const id = createHash('sha256').update(sourcePath).digest('hex').slice(0,24);
  const manifest = 'generated/artifacts/' + id + '.json';
  const item = {id,manifest,sourcePath,title:args.title.trim(),width:args.width,height:args.height};
  if (args.fps !== undefined) { item.fps=args.fps; item.duration=args.duration; }
  if (args.audioPath) item.audioPath=path.relative(workspace,sourceFile(workspace,args.audioPath)).replace(/\\/g,'/');
  await fs.promises.mkdir(directory(workspace),{recursive:true});
  if (beforeWrite) beforeWrite(manifest);
  await fs.promises.writeFile(path.join(workspace,manifest),JSON.stringify(item,null,2)+'\n','utf8');
  return item;
}

/** 从受限清单目录重开记录，并核对其源稿仍是项目内作品。 */
async function read(workspace,manifest) {
  const file=sourceFile(workspace,manifest);
  if (!isInside(directory(workspace),file) || path.extname(file)!=='.json') throw new Error('不是作品清单');
  const item=JSON.parse(await fs.promises.readFile(file,'utf8'));
  validate(workspace,item);
  item.manifest=path.relative(workspace,file).replace(/\\/g,'/');
  return item;
}

/** 只读取作品清单目录，重开项目无需扫描所有生成文件或依赖目录。 */
async function list(workspace) {
  if (!workspace || !fs.existsSync(directory(workspace))) return [];
  const names=await fs.promises.readdir(directory(workspace));
  const items=[];
  for (const name of names) if (path.extname(name)==='.json') items.push(await read(workspace,'generated/artifacts/'+name));
  return items;
}

/** 生成播放与导出共用的确定性画面调用；普通 HTML/SVG 仅等待字体、图片和绘制完成。 */
function paintScript(item,time,waitForPaint=true) {
  const info={width:item.width,height:item.height,fps:item.fps,duration:item.duration,totalFrames:Math.ceil(item.fps*item.duration)};
  let paint='';
  if (item.duration !== undefined) paint='if(typeof window.renderFrame!=="function")throw Error("动画必须定义 window.renderFrame");await window.renderFrame('+JSON.stringify(time)+','+Math.floor(time*item.fps)+','+JSON.stringify(info)+');';
  // 隐藏导出页需要等待合成帧；普通预览页可能被其他应用遮挡，不能用 RAF 作为 IPC 完成条件。
  const commit=waitForPaint?'await new Promise(function painted(resolve){requestAnimationFrame(function next(){requestAnimationFrame(resolve);});});':'';
  return '(async function paintArtifact(){await document.fonts.ready;for(const image of document.querySelectorAll("img")){await image.decode();}'+paint+commit+'return true;})()';
}

/** 在无 Node/预加载脚本的独立 Chromium 页面截图；取消和异常都释放隐藏窗口。 */
async function capture({workspace,item,time,signal}) {
  const {BrowserWindow,app}=require('electron');
  await app.whenReady();
  if (signal) signal.throwIfAborted();
  const win=new BrowserWindow({width:item.width,height:item.height,useContentSize:true,show:false,transparent:true,backgroundColor:'#00000000',webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,offscreen:true,backgroundThrottling:false}});
  function denyWindow(){return {action:'deny'};}
  function cancelled(){if(!win.isDestroyed())win.destroy();}
  win.webContents.setWindowOpenHandler(denyWindow);
  if(signal)signal.addEventListener('abort',cancelled,{once:true});
  try {
    await video.awaitAbort(win.loadFile(sourceFile(workspace,item.sourcePath)),signal);
    await video.awaitAbort(win.webContents.executeJavaScript(paintScript(item,time)),signal);
    const shot=await video.awaitAbort(win.webContents.capturePage(),signal);
    return shot.resize({width:item.width,height:item.height,quality:'best'}).toPNG();
  } finally {
    if(signal)signal.removeEventListener('abort',cancelled);
    if(!win.isDestroyed())win.destroy();
  }
}

/** 导出真实文件并沿用既有 MP4 渲染器；失败不改成其他格式，也不报告为成功。 */
async function exportArtifact({workspace,args,signal,beforeWrite,onProgress,captureImage}) {
  const item=await read(workspace,args.manifest);
  const format=args.format;
  const time=args.time===undefined?0:args.time;
  if(!Number.isFinite(time)||time<0||(item.duration!==undefined&&time>item.duration))throw new Error('采样时间超出作品范围');
  if(format==='mp4') {
    if(item.duration===undefined)throw new Error('静态作品没有视频时序');
    const result=await video.render({workspace,extra:[],args:item,signal,beforeWrite,onProgress});
    return Object.assign({file:result.video,format},result);
  }
  if(!['png','svg','html'].includes(format))throw new Error('不支持的导出格式');
  const source=sourceFile(workspace,item.sourcePath);
  if(format!=='png'&&path.extname(source).toLowerCase()!=='.'+format)throw new Error('源文件不是 '+format+' 格式');
  const base=path.join(workspace,'generated');
  await fs.promises.mkdir(base,{recursive:true});
  const dir=await fs.promises.mkdtemp(path.join(base,'artifact-export-'));
  const output=path.join(dir,'artwork.'+format);
  const file=path.relative(workspace,output).replace(/\\/g,'/');
  if(beforeWrite)beforeWrite(file);
  if(format==='png') {
    // 工具导出按源稿重绘；窗口下载使用当前交互画面，保留用户在网页上调整的状态。
    let png;
    if(captureImage)png=await captureImage();
    else png=await capture({workspace,item,time,signal});
    if(signal)signal.throwIfAborted();
    await fs.promises.writeFile(output,png);
  } else await fs.promises.copyFile(source,output);
  return {file,format,width:item.width,height:item.height,time,bytes:(await fs.promises.stat(output)).size};
}

module.exports={toolSpecs,present,read,list,sourceFile,paintScript,capture,exportArtifact};
