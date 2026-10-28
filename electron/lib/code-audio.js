/**
 * 代码合成音轨与本地音频卡点分析。
 * 合成页只持有 Web Audio；分析读取 FFmpeg 解码后的真实采样，不从视频时长猜节拍。
 */
const fs = require('fs');
const path = require('path');
const {spawn} = require('child_process');
const {resolveRead} = require('./workspace');
const {awaitAbort} = require('./code-video');

const toolSpecs = [
  {type:'function',function:{
    name:'render_code_audio',
    description:'先编写项目内 HTML，定义 async window.renderAudio(info)，用 OfflineAudioContext 合成旋律、鼓点、音效并返回 AudioBuffer，再调用本工具导出 PCM WAV。info 含明确的 duration 秒、sampleRate、channels。音频长度必须与参数一致，采样在 [-1,1]，不自动归一化或削波。之后 analyze_audio 提取实际卡点，动画引用时间线，audioPath 合入同一 WAV。自然人声需另用语音合成引擎。',
    parameters:{type:'object',properties:{sourcePath:{type:'string'},duration:{type:'number'},sampleRate:{type:'integer'},channels:{type:'integer',enum:[1,2]}},required:['sourcePath','duration','sampleRate','channels']}
  }},
  {type:'function',function:{
    name:'analyze_audio',
    description:'分析已有音乐/配音的真实音频采样，导出 waveform/RMS、瞬态起音 onsets、能量变强 energyRises 和 tempoEstimate 时间线 JSON/JS。用于先听音乐再安排镜头、字幕和转场。起音候选不等于准确音乐拍点或小节重拍；复杂音乐必须试听核对，可按歌曲调整参数，不把估算 BPM 当事实。JS 暴露 window.audioTimeline，可由动画 script src 引用。hopMs 是包络采样毫秒，minGapMs 为起音最小间距，peakThreshold 为相对最大包络上升幅度的阈值(0,1)，energyWindowMs 为能量分段毫秒，riseRatio 为相邻能量增幅倍数(>1)。',
    parameters:{type:'object',properties:{audioPath:{type:'string'},hopMs:{type:'number'},minGapMs:{type:'number'},peakThreshold:{type:'number'},energyWindowMs:{type:'number'},riseRatio:{type:'number'}},required:['audioPath','hopMs','minGapMs','peakThreshold','energyWindowMs','riseRatio']}
  }}
];

/** 为每次音轨/分析创建独立目录；不覆盖旧产物。 */
async function outputDirectory(workspace,prefix) {
  const base=path.join(workspace,'generated');
  await fs.promises.mkdir(base,{recursive:true});
  return fs.promises.mkdtemp(path.join(base,prefix));
}

/** 写入前登记快照，返回可移动项目的相对路径。 */
async function save(workspace,file,data,beforeWrite) {
  const relative=path.relative(workspace,file).replace(/\\/g,'/');
  if(beforeWrite)beforeWrite(relative);
  await fs.promises.writeFile(file,data);
  return relative;
}

/**
 * 将页面生成的 AudioBuffer 编为交错 PCM16 WAV。
 * 精确保留时长、声道与采样率；非有限值或超幅采样报错，避免悄悄改变音量。
 */
function encodeWav(rendered,info) {
  const frames=Math.ceil(info.duration*info.sampleRate);
  if(rendered.sampleRate!==info.sampleRate||rendered.channels.length!==info.channels)throw Error('音频采样率/声道与请求不一致');
  const buffer=Buffer.alloc(44+frames*info.channels*2);
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);
  buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(info.channels,22);
  buffer.writeUInt32LE(info.sampleRate,24);buffer.writeUInt32LE(info.sampleRate*info.channels*2,28);
  buffer.writeUInt16LE(info.channels*2,32);buffer.writeUInt16LE(16,34);buffer.write('data',36);buffer.writeUInt32LE(buffer.length-44,40);
  for(let channel=0;channel<info.channels;channel++){
    const samples=rendered.channels[channel];
    if(samples.length!==frames)throw Error('音轨长度与 duration 不一致');
    for(let frame=0;frame<frames;frame++){
      const value=samples[frame];
      if(!Number.isFinite(value)||value < -1||value > 1)throw Error('音频采样超幅或无效，请在源稿调整混音音量');
      buffer.writeInt16LE(Math.round(value*(value<0?32768:32767)),44+(frame*info.channels+channel)*2);
    }
  }
  return buffer;
}

/** 在独立无 Node/预加载页执行音轨源稿，取消时结束异步等待并销毁页面。 */
async function render({workspace,extra,args,signal,beforeWrite}) {
  if(!workspace)throw Error('请先打开项目');
  if(path.extname(args.sourcePath||'').toLowerCase()!=='.html')throw Error('音轨源稿必须是 HTML');
  if(!Number.isFinite(args.duration)||args.duration<=0)throw Error('duration 必须是正数');
  if(!Number.isInteger(args.sampleRate)||args.sampleRate<=0||![1,2].includes(args.channels))throw Error('请明确有效 sampleRate 和 channels');
  if(signal)signal.throwIfAborted();
  const source=resolveRead(workspace,extra||[],args.sourcePath);
  const {app,BrowserWindow}=require('electron');
  await app.whenReady();
  const win=new BrowserWindow({show:false,webPreferences:{nodeIntegration:false,contextIsolation:true,sandbox:true,backgroundThrottling:false}});
  function denyWindow(){return {action:'deny'};}
  function cancelled(){if(!win.isDestroyed())win.destroy();}
  win.webContents.setWindowOpenHandler(denyWindow);
  if(signal)signal.addEventListener('abort',cancelled,{once:true});
  try {
    await awaitAbort(win.loadFile(source),signal);
    const info={duration:args.duration,sampleRate:args.sampleRate,channels:args.channels};
    const script='(async function codeAudio(){if(typeof window.renderAudio!=="function")throw Error("HTML 必须定义 window.renderAudio(info)");const audio=await window.renderAudio('+JSON.stringify(info)+');if(!(audio instanceof AudioBuffer))throw Error("renderAudio 必须返回 AudioBuffer");const channels=[];for(let i=0;i<audio.numberOfChannels;i++)channels.push(audio.getChannelData(i));return {sampleRate:audio.sampleRate,channels};})()';
    const rendered=await awaitAbort(win.webContents.executeJavaScript(script),signal);
    if(signal)signal.throwIfAborted();
    const wav=encodeWav(rendered,info);
    const dir=await outputDirectory(workspace,'code-audio-');
    const audio=await save(workspace,path.join(dir,'audio.wav'),wav,beforeWrite);
    const result={audio,source:args.sourcePath,duration:Math.ceil(args.duration*args.sampleRate)/args.sampleRate,sampleRate:args.sampleRate,channels:args.channels,bytes:wav.length};
    const manifest=await save(workspace,path.join(dir,'render.json'),JSON.stringify(result,null,2)+'\n',beforeWrite);
    return Object.assign({manifest},result);
  } finally {
    if(signal)signal.removeEventListener('abort',cancelled);
    cancelled();
  }
}

/**
 * 流式解码为单声道包络；内存只累计每 hop 的 RMS，不存整首歌的 PCM。
 * 解码错误和取消原样传播；固定 22050Hz 足够测量音量/瞬态时间，不改变交付原音轨。
 */
function envelope(file,hopMs,signal) {
  const sampleRate=22050;
  const hop=Math.max(1,Math.round(sampleRate*hopMs/1000));
  return new Promise(function decode(resolve,reject){
    const child=spawn('ffmpeg',['-v','error','-i',file,'-vn','-ac','1','-ar',String(sampleRate),'-f','f32le','pipe:1'],{windowsHide:true,signal});
    let tail=Buffer.alloc(0),sum=0,count=0,total=0,stderr='';
    const rms=[];
    function data(chunk){
      const bytes=Buffer.concat([tail,chunk]);
      const length=bytes.length-bytes.length%4;
      for(let i=0;i<length;i+=4){
        const value=bytes.readFloatLE(i);sum+=value*value;count++;total++;
        if(count===hop){rms.push(Math.sqrt(sum/count));sum=0;count=0;}
      }
      tail=bytes.subarray(length);
    }
    function diagnostic(chunk){stderr=(stderr+chunk.toString()).slice(-8192);}
    function completed(code){
      if(signal&&signal.aborted){reject(signal.reason);return;}
      if(code!==0){reject(Error('音频解码失败：'+stderr));return;}
      if(!total){reject(Error('音轨没有可分析采样'));return;}
      if(count)rms.push(Math.sqrt(sum/count));
      resolve({rms,hopSeconds:hop/sampleRate,duration:total/sampleRate});
    }
    child.stdout.on('data',data);child.stderr.on('data',diagnostic);
    child.once('error',reject);child.once('close',completed);
  });
}

/**
 * 从音量包络上升峰提取起音候选及分段能量增强。
 * 不外推规则拍网格；tempoEstimate 仅为起音间距中位数的换算，稀疏/切分/倍速会影响结果。
 */
function timing(data,args) {
  const {rms,hopSeconds,duration}=data;
  const strength=[];
  let maximum=0;
  for(let i=0;i<rms.length;i++){const value=Math.max(0,rms[i]-(i===0?0:rms[i-1]));strength.push(value);maximum=Math.max(maximum,value);}
  const onsets=[];
  for(let i=0;i<strength.length;i++){
    const value=strength[i];
    if(value===0||value<maximum*args.peakThreshold)continue;
    if(i>0&&value<strength[i-1])continue;
    if(i+1<strength.length&&value<=strength[i+1])continue;
    const onset={time:i*hopSeconds,strength:value/maximum};
    const previous=onsets[onsets.length-1];
    if(previous&&(onset.time-previous.time)*1000<args.minGapMs){if(onset.strength>previous.strength)onsets[onsets.length-1]=onset;}
    else onsets.push(onset);
  }
  const energy=[],energyRises=[];
  const window=Math.max(1,Math.round(args.energyWindowMs/1000/hopSeconds));
  for(let start=0;start<rms.length;start+=window){
    let power=0;
    const end=Math.min(rms.length,start+window);
    for(let i=start;i<end;i++)power+=rms[i]*rms[i];
    const point={time:start*hopSeconds,rms:Math.sqrt(power/(end-start))};
    const previous=energy[energy.length-1];
    if(previous&&previous.rms>0&&point.rms/previous.rms>=args.riseRatio)energyRises.push({time:point.time,ratio:point.rms/previous.rms});
    energy.push(point);
  }
  let tempoEstimate=null;
  if(onsets.length>=3){
    const intervals=[];
    for(let i=1;i<onsets.length;i++)intervals.push(onsets[i].time-onsets[i-1].time);
    intervals.sort(function numeric(a,b){return a-b;});
    const middle=Math.floor(intervals.length/2);
    const seconds=intervals.length%2?intervals[middle]:(intervals[middle-1]+intervals[middle])/2;
    tempoEstimate={bpm:60/seconds,basis:'起音间距中位数；不是已确认的音乐 BPM 或小节重拍'};
  }
  return {duration,hopSeconds,waveform:rms,onsets,energy,energyRises,tempoEstimate,method:'音量包络上升峰；候选需试听核对，弱鼓点/持续音/复杂混音可能漏检或误检'};
}

/** 分析真实音频并写 JSON/可直接引用的 JS，所有可调检测参数由调用方明确提供。 */
async function analyze({workspace,extra,args,signal,beforeWrite}) {
  if(!workspace)throw Error('请先打开项目');
  for(const key of ['hopMs','minGapMs','energyWindowMs'])if(!Number.isFinite(args[key])||args[key]<=0)throw Error(key+' 必须是正数');
  if(args.minGapMs<args.hopMs||args.energyWindowMs<args.hopMs)throw Error('起音间隔和能量窗口不能小于 hopMs');
  if(!Number.isFinite(args.peakThreshold)||args.peakThreshold<=0||args.peakThreshold>=1)throw Error('peakThreshold 必须在 0 和 1 之间');
  if(!Number.isFinite(args.riseRatio)||args.riseRatio<=1)throw Error('riseRatio 必须大于 1');
  if(signal)signal.throwIfAborted();
  const file=resolveRead(workspace,extra||[],args.audioPath);
  const data=await envelope(file,args.hopMs,signal);
  const report=Object.assign({audio:args.audioPath,parameters:args},timing(data,args));
  if(signal)signal.throwIfAborted();
  const dir=await outputDirectory(workspace,'audio-analysis-');
  const json=JSON.stringify(report,null,2);
  const timeline=await save(workspace,path.join(dir,'timeline.json'),json+'\n',beforeWrite);
  const script=await save(workspace,path.join(dir,'timeline.js'),'/** 来自实际音频采样的卡点候选；修改源音轨后重新分析。 */\nwindow.audioTimeline='+json+';\n',beforeWrite);
  return {timeline,script,duration:report.duration,onsets:report.onsets,energyRises:report.energyRises,tempoEstimate:report.tempoEstimate,method:report.method};
}
module.exports={toolSpecs,render,analyze,timing,encodeWav};
