/** 代码作品工具栏：播放、拖动时间、刷新和导出；动画绘制交给独立作品页。 */
const api=window.artifactStudio;
let item;
let time=0;
let playing=false;
let playGeneration=0;
let lastTick=0;
// 短音轨结束后的无声尾段与 MP4 的 apad 补齐规则一致。
let audioTail=false;
function element(id){return document.getElementById(id);}
/** 更新作品时间显示，不让播放循环创建并行的 seek 请求。 */
function paintTime(){element('art-seek').value=String(time);element('art-time').textContent=time.toFixed(2)+' / '+item.duration.toFixed(2)+' 秒';}
/** 按实际工具栏布局提交预览区域，窗口变小时画布保持原始宽高比。 */
function layout(){const r=element('art-stage').getBoundingClientRect();api.layout({x:r.x+1,y:r.y+1,width:r.width-2,height:r.height-2});}
/** 停止当前播放循环，暂停配乐并使已排队的旧回调失效。 */
function pause(){playing=false;playGeneration++;element('art-play').textContent='播放';element('art-audio').pause();}
/** 明确呈现错误，不将导出失败或绘制失败显示成完成。 */
function failed(error){pause();element('art-status').textContent=error.message;}
/** 串行驱动画面；预览可用实时钟，源稿每一帧仍由传入秒数唯一确定。 */
async function tick(stamp,generation){
  if(!playing||generation!==playGeneration)return;
  // 首次 RAF 的帧起点可能略早于点击时钟，播放时间只前进，不提交负数采样。
  const elapsed=Math.max(0,(stamp-lastTick)/1000);
  // 有音轨时以媒体播放位置为主时钟，解码等待或慢帧不会让画面独自跑到音乐前面。
  const audio=element('art-audio');
  const next=Math.min(item.duration,item.audioPath&&!audioTail?audio.currentTime:time+elapsed);
  lastTick=stamp;
  try{await api.seek(next);}catch(error){failed(error);return;}
  if(generation!==playGeneration)return;
  time=next;paintTime();
  if(time>=item.duration){pause();return;}
  function frame(now){tick(now,generation);}
  requestAnimationFrame(frame);
}
/** 点击播放时从当前时间继续，播放结束后再次点击从头开始。 */
async function togglePlay(){
  if(playing){pause();return;}
  if(time>=item.duration)time=0;
  const audio=element('art-audio');
  if(item.audioPath){audio.currentTime=time;audioTail=Number.isFinite(audio.duration)&&time>=audio.duration;if(!audioTail)await audio.play();}
  playing=true;element('art-play').textContent='暂停';lastTick=performance.now();
  const generation=++playGeneration;
  function frame(now){tick(now,generation);}
  requestAnimationFrame(frame);
}
/** 拖动结束时精确显示所选时刻；拖动期间先暂停，避免旧播放结果覆盖选定时间。 */
async function seek(){pause();time=Number(element('art-seek').value);await api.seek(time);if(item.audioPath)element('art-audio').currentTime=time;paintTime();}
/** 重新加载源稿后从首帧展示；源文件保存也会由主进程自动刷新。 */
async function refresh(){pause();await api.refresh();time=0;if(item.duration!==undefined)paintTime();}
/** 下载先选择文件位置；导出过程锁定同一窗口的下载按钮，可明确停止视频任务。 */
async function download(format){
  pause();
  const buttons=document.querySelectorAll('.artifact-actions button');
  for(const button of buttons)button.disabled=true;
  element('art-cancel').hidden=false;element('art-cancel').disabled=false;
  try{await api.save(format,time);}catch(error){failed(error);}finally{for(const button of buttons)button.disabled=false;element('art-cancel').hidden=true;}
}
/** 将异步按钮异常统一交给本窗口状态栏。 */
function action(run){return function clicked(){Promise.resolve().then(run).catch(failed);};}
/** 设置作品元信息；动画作品才展示时间轴和视频导出入口。 */
function configure(value){
  pause();item=value.item;time=0;
  document.documentElement.dataset.theme=value.theme;
  element('art-title').textContent=item.title;document.title=item.title+' · 作品';
  element('art-size').textContent=item.width+' × '+item.height;
  element('art-player').hidden=item.duration===undefined;element('art-mp4').hidden=item.duration===undefined;
  if(item.duration!==undefined){element('art-seek').max=String(item.duration);paintTime();}
  if(value.audioUrl)element('art-audio').src=value.audioUrl;
  else element('art-audio').removeAttribute('src');
  layout();
}
/** 初始化按钮与 IPC，作品内容不持有这些宿主接口。 */
async function init(){
  configure(await api.state());
  element('art-play').onclick=action(togglePlay);
  element('art-seek').oninput=pause;element('art-seek').onchange=action(seek);
  element('art-refresh').onclick=action(refresh);
  element('art-png').onclick=action(function png(){return download('png');});
  element('art-source').onclick=action(function source(){return download(item.sourcePath.toLowerCase().endsWith('.svg')?'svg':'html');});
  element('art-mp4').onclick=action(function mp4(){return download('mp4');});
  element('art-cancel').onclick=action(function cancel(){return api.cancel();});
  api.onStatus(function status(text){element('art-status').textContent=text;});
  // 音轨已播放完的尾段没有节拍，按导出的补静音规则继续画面，保留原有短音轨语义。
  element('art-audio').onended=function audioEnded(){if(!playing)return;audioTail=true;time=Math.min(item.duration,Math.max(time,element('art-audio').currentTime));lastTick=performance.now();};
  element('art-audio').onerror=function audioFailed(){failed(new Error('作品音轨加载或解码失败'));};
  api.onUpdated(configure);
  window.addEventListener('resize',layout);
  window.addEventListener('beforeunload',pause);
}
init().catch(failed);
