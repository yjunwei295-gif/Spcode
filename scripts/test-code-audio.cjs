/**
 * 独立 Electron 音频专项：真实工具分发、采样检测、音频主时钟、MP4 解码卡点。
 * 所有测试数据保留在 generated 独立目录，不修改用户会话和音频设置。
 */
const {app,BrowserWindow,ipcMain}=require('electron');
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),Module=require('module');
const {spawnSync}=require('child_process');
const audio=require('../electron/lib/code-audio');
const studio=require('../electron/lib/artifact-studio');
const windows=require('../electron/lib/artifact-window');
const root=path.resolve(__dirname,'..');
let checks=0;
const unhandled=[];
app.on('window-all-closed',function keepAlive(event){event.preventDefault();});
process.on('unhandledRejection',function remember(error){unhandled.push(String(error));});
/** 每个实际行为断言独立报告，失败立即退出。 */
function check(value,label){assert.ok(value,label);checks++;console.log('PASS '+label);}
/** 外部解码命令须成功，不以空输出代替采样。 */
function command(program,args,binary){const result=spawnSync(program,args,{encoding:binary?null:'utf8',windowsHide:true,timeout:15000,maxBuffer:32*1024*1024});assert.ifError(result.error);assert.equal(result.status,0,String(result.stderr));return result.stdout;}
/** 在内存暴露真实工具分发接口，不替换生产实现。 */
function agentApi(){const file=path.join(root,'electron/lib/agent.js'),loaded=new Module(file,module);loaded.filename=file;loaded.paths=Module._nodeModulePaths(path.dirname(file));loaded._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.audioTest={execTool,toolsFor,HAND_OFF_TOOLS,MUTATE_FILE_TOOLS};',file);return {agent:loaded.exports,api:loaded.exports.audioTest};}
/** 从实际工具响应中提取交付记录。 */
function parsed(reply){return JSON.parse(reply.slice(reply.indexOf('{'),reply.lastIndexOf('}')+1));}
/** 给实际 Chromium/音频时钟让出事件循环。 */
function pause(ms){return new Promise(function wait(resolve){setTimeout(resolve,ms);});}
/** 等待真实工具栏初始化与媒体元数据，超时作为测试失败。 */
async function until(run,label){for(let i=0;i<100;i++){if(await run())return;await pause(30);}throw Error('等待超时：'+label);}
// 纯正弦夹具的弱起音比演示鼓点更平缓，阈值按此音轨明确设置，不修改检测器语义。
const settings={hopMs:10,minGapMs:300,peakThreshold:0.1,energyWindowMs:600,riseRatio:1.5};
/** 用实际分析结果驱动画布的脉冲；测试不另造固定节拍。 */
function scene(){return '<!doctype html><meta charset="utf-8"><style>html,body{margin:0}canvas{display:block}</style><canvas id="c" width="320" height="180"></canvas><script src="timeline.js"></script><script>window.renderFrame=function frame(t){window.lastTime=t;let hit=false;for(const onset of audioTimeline.onsets)if(t>=onset.time&&t-onset.time<0.08)hit=true;const c=document.getElementById("c").getContext("2d");c.fillStyle=hit?"rgb(220,0,0)":"rgb(20,0,0)";c.fillRect(0,0,320,180);};</script>';}
async function main(){
 await app.whenReady();
 const workspace=fs.mkdtempSync(path.join(root,'generated/audio-test-'));
 const fixture=fs.readFileSync(path.join(__dirname,'fixtures/code-audio.html'),'utf8');
 fs.writeFileSync(path.join(workspace,'audio.html'),fixture,'utf8');
 const {agent,api}=agentApi(),snap={};
 function event(){}
 for(const name of ['render_code_audio','analyze_audio']){
  check(agent.toolsSpec().some(function has(t){return t.function.name===name;})&&api.toolsFor('worker').some(function has(t){return t.function.name===name;}),name+' 注册真实普通/直通/实现端工具');
  check(api.HAND_OFF_TOOLS.has(name)&&api.MUTATE_FILE_TOOLS.has(name),name+' 纳入写入授权与只读门槛');
  check(require('../electron/lib/tool-xml').parseXmlToolCalls(JSON.stringify({name,arguments:{}}))[0].function.name===name,name+' 支持文本工具解析');
 }
 const rendered=parsed(await api.execTool(workspace,snap,'render_code_audio',{sourcePath:'audio.html',duration:9.6,sampleRate:48000,channels:2},event,[],undefined,'zh'));
 const wav=path.join(workspace,rendered.audio),data=fs.readFileSync(wav);
 check(data.toString('ascii',0,4)==='RIFF'&&data.readUInt32LE(40)===9.6*48000*2*2,'真实 OfflineAudioContext 导出精确长度 PCM WAV');
 check(data.readUInt32LE(24)===48000&&data.readUInt16LE(22)===2,'采样率/双声道保留');
 let peak=0;for(let i=44;i<data.length;i+=2)peak=Math.max(peak,Math.abs(data.readInt16LE(i)));
 check(peak>1000&&peak<32768,'音轨确有非静音内容且未削波');
 const analyzed=parsed(await api.execTool(workspace,snap,'analyze_audio',Object.assign({audioPath:rendered.audio},settings),event,[],undefined,'zh'));
 check(snap.wroteFiles===4&&snap.createdFiles.has(analyzed.timeline),'WAV/音轨记录/时间线 JSON/JS 全部进入快照');
 check(analyzed.onsets.length===16,'从真实采样检出 16 个起音');
 let maxError=0;for(let i=0;i<16;i++)maxError=Math.max(maxError,Math.abs(analyzed.onsets[i].time-(0.12+i*0.6)));
 check(maxError<0.02,'检测起音与乐谱已知位置偏差小于 20ms（'+maxError.toFixed(4)+'s）');
 check(Math.abs(analyzed.tempoEstimate.bpm-100)<1,'BPM 估值来自采样间距且明确标记为估计');
 check(analyzed.energyRises.length===2&&Math.abs(analyzed.energyRises[0].time-2.4)<0.03&&Math.abs(analyzed.energyRises[1].time-6)<0.03,'两次音乐增强来自实际 RMS，位置正确');
 command('ffmpeg',['-v','error','-i',wav,'-af','adelay=337:all=1',path.join(workspace,'shifted.wav')]);
 const shifted=await audio.analyze({workspace,args:Object.assign({audioPath:'shifted.wav'},settings)});
 console.log('SHIFT_DIAGNOSTIC '+JSON.stringify({count:shifted.onsets.length,first:shifted.onsets[0],original:analyzed.onsets[0]}));
 check(shifted.onsets.length===16&&Math.abs(shifted.onsets[0].time-analyzed.onsets[0].time-0.337)<0.02,'音轨延后 337ms，实测卡点随之延后，没有按视频均分造拍');
 command('ffmpeg',['-v','error','-i',wav,'-c:a','libmp3lame',path.join(workspace,'external.mp3')]);
 const mp3=await audio.analyze({workspace,args:Object.assign({audioPath:'external.mp3'},settings)});
 check(mp3.onsets.length===16&&Math.abs(mp3.onsets[3].time-analyzed.onsets[3].time)<0.03,'已有 MP3 经真实解码可分析，不依赖合成乐谱');
 command('ffmpeg',['-v','error','-f','lavfi','-i','anullsrc=r=48000:cl=mono','-t','1',path.join(workspace,'silence.wav')]);
 const silent=await audio.analyze({workspace,args:Object.assign({audioPath:'silence.wav'},settings)});
 check(silent.onsets.length===0&&silent.tempoEstimate===null&&silent.energyRises.length===0,'静音不编造节拍、BPM 或增强点');
 await assert.rejects(audio.analyze({workspace,args:Object.assign({audioPath:'external.mp3'},settings,{peakThreshold:0})}),/peakThreshold/);
 check(true,'无效分析参数明确失败');
 fs.writeFileSync(path.join(workspace,'pending.html'),'<script>window.renderAudio=function pending(){return new Promise(function wait(){});};</script>');
 const abort=new AbortController();setTimeout(function stop(){abort.abort();},150);
 await assert.rejects(audio.render({workspace,args:{sourcePath:'pending.html',duration:1,sampleRate:48000,channels:1},signal:abort.signal}),{name:'AbortError'});
 check(BrowserWindow.getAllWindows().length===0,'等待永不结束的音频源稿时可取消并释放页面');
 assert.throws(function clipping(){audio.encodeWav({sampleRate:1,channels:[new Float32Array([1.1])]}, {duration:1,sampleRate:1,channels:1});},/超幅/);
 check(true,'超幅混音报错，不静默改变音量');
 fs.copyFileSync(path.join(workspace,analyzed.script),path.join(workspace,'timeline.js'));
 fs.writeFileSync(path.join(workspace,'scene.html'),scene(),'utf8');
 windows.registerIpc({ipcMain,getWorkspace:function ws(){return workspace;},getOwner:function owner(){return undefined;}});
 const item=await studio.present({workspace,args:{sourcePath:'scene.html',title:'音频主时钟验收',width:320,height:180,fps:30,duration:10.2,audioPath:rendered.audio}});
 const ctx=await windows.open({workspace,manifest:item.manifest,theme:'light'});
 await until(function ready(){return ctx.win.webContents.executeJavaScript('!!document.getElementById("art-title").textContent&&Number.isFinite(document.getElementById("art-audio").duration)');},'音轨与工具栏');
 // 刻意改变音频速度，证明画面跟随媒体时间而不是墙上时钟。
 await ctx.win.webContents.executeJavaScript('document.getElementById("art-audio").playbackRate=1.8;document.getElementById("art-play").click();true');
 await pause(650);
 const clock=await ctx.win.webContents.executeJavaScript('({audio:document.getElementById("art-audio").currentTime,visual:Number(document.getElementById("art-seek").value)})');
 const visual=await ctx.view.webContents.executeJavaScript('window.lastTime');
 check(clock.audio>0.8&&Math.abs(clock.audio-visual)<0.15&&Math.abs(clock.audio-clock.visual)<0.15,'1.8 倍速真实音乐驱动画面，非实时时钟（'+JSON.stringify(clock)+'）');
 await ctx.win.webContents.executeJavaScript('document.getElementById("art-audio").pause();true');
 await pause(200);const stopped=await ctx.view.webContents.executeJavaScript('window.lastTime');
 await pause(250);check(Math.abs((await ctx.view.webContents.executeJavaScript('window.lastTime'))-stopped)<0.005,'音乐暂停/等待时画面不独自前进');
 await ctx.win.webContents.executeJavaScript('document.getElementById("art-play").click();document.getElementById("art-seek").value="6.12";document.getElementById("art-seek").dispatchEvent(new Event("change"));true');
 await pause(150);
 const sought=await ctx.win.webContents.executeJavaScript('({audio:document.getElementById("art-audio").currentTime,paused:document.getElementById("art-audio").paused})');
 check(sought.paused&&Math.abs(sought.audio-6.12)<0.01&&Math.abs((await ctx.view.webContents.executeJavaScript('window.lastTime'))-6.12)<0.01,'拖动后音频与画面精确采到同一秒');
 await ctx.win.webContents.executeJavaScript('document.getElementById("art-audio").playbackRate=1;document.getElementById("art-seek").value="9.5";document.getElementById("art-seek").dispatchEvent(new Event("change"));true');
 await pause(100);await ctx.win.webContents.executeJavaScript('document.getElementById("art-play").click();true');
 await until(function finishedTail(){return ctx.win.webContents.executeJavaScript('document.getElementById("art-play").textContent==="播放"&&Number(document.getElementById("art-seek").value)>=10.19');},'补静音尾段完成');
 check(true,'短音轨结束后补静音尾段到画面结束，预览与导出一致');
 ctx.win.destroy();
 const short=await studio.present({workspace,args:{sourcePath:'scene.html',title:'有声卡点验收',width:320,height:180,fps:30,duration:2,audioPath:rendered.audio}});
 const video=await studio.exportArtifact({workspace,args:{manifest:short.manifest,format:'mp4'}});
 const file=path.join(workspace,video.file);
 const probe=JSON.parse(command('ffprobe',['-v','error','-show_streams','-of','json',file]));
 check(probe.streams.some(function a(s){return s.codec_type==='audio'&&s.codec_name==='aac';})&&probe.streams.some(function v(s){return s.codec_type==='video'&&Number(s.nb_frames)===60;}),'MP4 真实包含 AAC 和目标 60 帧');
 const muxed=await audio.analyze({workspace,args:Object.assign({audioPath:video.file},settings)});
 check(muxed.onsets.length===4&&Math.abs(muxed.onsets[0].time-analyzed.onsets[0].time)<0.02,'从 MP4 解码的实际声音起点与原音轨一致，无起始偏移');
 const firstHit=Math.ceil(analyzed.onsets[0].time*30);
 const raw=command('ffmpeg',['-v','error','-i',file,'-vf','select=eq(n\\,'+firstHit+')','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],true);
 check(raw.length===320*180*3&&raw[(10*320+10)*3]>190,'MP4 对应音频起音的帧实际亮起，误差在一帧内');
 check(unhandled.length===0,'无未处理异步拒绝');
 const report={ok:true,checks,workspace,maxOnsetErrorSeconds:maxError,previewClock:clock,video:video.file};
 fs.writeFileSync(path.join(workspace,'verification.json'),JSON.stringify(report,null,2));
 console.log('RESULT '+JSON.stringify(report));app.exit(0);
}
main().catch(function failed(error){console.error(error.stack);app.exit(1);});
