/**
 * 在独立 Electron 里执行真实 Agent 工具分发和 Chromium→FFmpeg 导出。
 * 所有样片与测试数据写入 generated/ 独立目录，不调用模型、不改用户设置。
 */
const { app, BrowserWindow, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { spawnSync } = require('node:child_process');
const { render } = require('../electron/lib/code-video');
const root = path.resolve(__dirname, '..');
let workspace;
let checks = 0;
const unhandled = [];

/** 专项窗口关闭后仍继续执行，由最终验收结果退出。 */
function keepAlive(event) { event.preventDefault(); }
/** 捕获异步错误，避免进程退出码掩盖管道或取消后的悬空拒绝。 */
function remember(error) { unhandled.push(String(error.stack || error)); }
app.on('window-all-closed', keepAlive);
process.on('unhandledRejection', remember);
process.on('uncaughtException', remember);

/** 每个断言都打印证据，失败时立即中止后续步骤。 */
function check(value, label) {
  assert.ok(value, label);
  checks++;
  console.log('PASS ' + label);
}

/** 本地工具探测/媒体检查命令必须真实成功。 */
function command(program, args, binary) {
  const result = spawnSync(program, args, {
    encoding: binary ? null : 'utf8', windowsHide: true,
    timeout: 15000, maxBuffer: 16 * 1024 * 1024
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, String(result.stderr));
  return result.stdout;
}

/** 在内存导出真实内部函数，保持源码与依赖原样，不建立模型会话。 */
function loadAgent() {
  const file = path.join(root, 'electron/lib/agent.js');
  const loaded = new Module(file, module);
  loaded.filename = file;
  loaded.paths = Module._nodeModulePaths(path.dirname(file));
  loaded._compile(fs.readFileSync(file, 'utf8') +
    '\nmodule.exports.videoTest = { execTool, toolsFor, HAND_OFF_TOOLS, MUTATE_FILE_TOOLS };', file);
  return loaded.exports;
}

/** 返回一个可复现三秒样片，背景颜色与位置由帧号和秒数决定。 */
function demoHtml() {
  return '<!doctype html><meta charset="utf-8"><title>SpCode 代码视频样片</title>' +
    '<style>html,body{margin:0;overflow:hidden}canvas{display:block}</style><canvas id="scene"></canvas>' +
    '<script>' +
    'window.renderFrame = async function renderFrame(time, frame, info) {' +
    'const canvas = document.getElementById("scene"); canvas.width=info.width; canvas.height=info.height;' +
    'const ctx=canvas.getContext("2d"); const w=info.width; const h=info.height;' +
    'ctx.fillStyle="rgb("+(12+frame*2)+",20,36)"; ctx.fillRect(0,0,w,h);' +
    'ctx.fillStyle="#e7f5ff"; ctx.font="bold 32px sans-serif"; ctx.fillText("SpCode · 代码成为画面",32,62);' +
    'ctx.font="18px sans-serif"; ctx.fillText("分镜 → 编写动画 → 逐帧渲染 → MP4",32,98);' +
    'for(let i=0;i<3;i++){const start=i*0.65; const p=Math.max(0,Math.min(1,(time-start)/0.6));' +
    'ctx.fillStyle=["#42d5bc","#5c9eff","#c693ff"][i];ctx.fillRect(40+i*190,240-p*110,150,p*110);' +
    'ctx.fillStyle="#e7f5ff";ctx.font="18px sans-serif";ctx.fillText(["写代码","画每帧","导出视频"][i],64+i*190,270);}' +
    'ctx.fillStyle="#42d5bc";ctx.fillRect(32,h-32,(w-64)*time/info.duration,8);' +
    'ctx.fillStyle="#fff";ctx.font="14px monospace";ctx.fillText("FRAME "+frame+" / "+info.totalFrames,w-180,h-48);' +
    '};</script>';
}

/** 通过真实视频解码取某帧左上像素，证明 MP4 内容确实跟随帧号变化。 */
function decodedRed(video, frame) {
  const raw = command('ffmpeg', ['-v','error','-i',video,'-vf','select=eq(n\\,' + frame + ')',
    '-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'], true);
  check(raw.length === 640 * 360 * 3, 'MP4 第 ' + frame + ' 帧可完整解码');
  return raw[(10 * 640 + 10) * 3];
}

/** 校验错误与取消均不会伪报完成，也不留下隐藏窗口。 */
async function testFailures(args) {
  await assert.rejects(render({ workspace, args: Object.assign({}, args, { width: 639 }) }), /正偶数/);
  check(true, '不合法编码尺寸明确失败');
  const missing = new AbortController();
  missing.abort();
  await assert.rejects(render({ workspace, args, signal: missing.signal }), { name: 'AbortError' });
  check(true, '执行前取消不启动渲染');

  await fs.promises.writeFile(path.join(workspace, 'missing.html'), '<!doctype html><p>缺少动画入口</p>', 'utf8');
  await assert.rejects(render({ workspace, args: Object.assign({}, args, { sourcePath: 'missing.html' }) }), /renderFrame/);
  check(BrowserWindow.getAllWindows().length === 0, '缺少动画入口报错并释放窗口');

  await fs.promises.writeFile(path.join(workspace, 'broken.html'),
    '<script>window.renderFrame=function broken(){throw new Error("FRAME_FAILURE_SENTINEL")};</script>', 'utf8');
  await assert.rejects(render({ workspace, args: Object.assign({}, args, { sourcePath: 'broken.html' }) }), /FRAME_FAILURE_SENTINEL/);
  check(BrowserWindow.getAllWindows().length === 0, '帧代码异常原样传播并释放窗口');

  const controller = new AbortController();
  /** 已输出两帧时模拟用户按停止，验证在途任务的中断。 */
  function stop(progress) { if (progress.frame === 2) controller.abort(); }
  await assert.rejects(render({ workspace, args, signal: controller.signal, onProgress: stop }), { name: 'AbortError' });
  check(BrowserWindow.getAllWindows().length === 0, '在途停止保留中断语义并销毁渲染窗口');

  await fs.promises.writeFile(path.join(workspace, 'waiting.html'),
    '<script>window.renderFrame=async function waiting(time,frame){if(frame===1) await new Promise(function pending(){});};</script>', 'utf8');
  const waiting = new AbortController();
  /** 第一帧提交后，在第二帧等待期间模拟停止按钮。 */
  function stopWaiting(progress) {
    if (progress.frame === 1) setTimeout(function stopPendingFrame() { waiting.abort(); }, 100);
  }
  await assert.rejects(render({ workspace, args: Object.assign({}, args, { sourcePath: 'waiting.html' }),
    signal: waiting.signal, onProgress: stopWaiting }), { name: 'AbortError' });
  check(BrowserWindow.getAllWindows().length === 0, '等待异步动画帧时也能停止，不留下悬挂任务');

  const oldPath = process.env.PATH;
  try {
    process.env.PATH = '';
    await assert.rejects(render({ workspace, args }), /ENOENT/);
    check(BrowserWindow.getAllWindows().length === 0, '缺失 FFmpeg 返回实际错误，没有回退到生成模型');
  } finally {
    process.env.PATH = oldPath;
  }
}

/** 主验收运行真实 Agent 分发、视频解码、音轨长度与错误路径。 */
async function main() {
  await app.whenReady();
  const timeout = setTimeout(function exceeded() { console.error('FAIL 视频验收超时'); app.exit(1); }, 55000);
  await fs.promises.mkdir(path.join(root, 'generated'), { recursive: true });
  workspace = await fs.promises.mkdtemp(path.join(root, 'generated', 'code-video-test-'));
  await fs.promises.writeFile(path.join(workspace, 'scene.html'), demoHtml(), 'utf8');
  const args = { sourcePath: 'scene.html', width: 640, height: 360, fps: 24, duration: 3 };
  const agent = loadAgent();
  const api = agent.videoTest;
  check(agent.toolsSpec().some(function hasTool(tool) { return tool.function.name === 'render_code_video'; }), 'Agent 注册代码视频工具');
  check(api.toolsFor('worker').some(function hasTool(tool) { return tool.function.name === 'render_code_video'; }), '实现端可使用同一渲染工具');
  check(api.HAND_OFF_TOOLS.has('render_code_video') && api.MUTATE_FILE_TOOLS.has('render_code_video'),
    '工具纳入授权与只读限制');
  const xml = require('../electron/lib/tool-xml');
  const call = '{"name":"render_code_video","arguments":{"sourcePath":"scene.html"}}';
  check(xml.parseXmlToolCalls(call)[0].function.name === 'render_code_video', '文本工具调用可解析新工具');

  const events = [];
  /** 收集真实工具事件，核对进度次数和最终路径。 */
  function onEvent(event) { events.push(event); }
  const snap = {};
  const reply = await api.execTool(workspace, snap, 'render_code_video', args, onEvent, [], undefined, 'zh');
  check(reply.startsWith('【代码视频已完成】'), '真实 Agent 工具分发导出成功');
  const result = JSON.parse(reply.slice(reply.indexOf('{'), reply.lastIndexOf('}') + 1));
  const video = path.join(workspace, result.video);
  const data = JSON.parse(command('ffprobe', ['-v','error','-count_frames','-show_streams','-show_format','-of','json',video]));
  const stream = data.streams.find(function isVideo(s) { return s.codec_type === 'video'; });
  check(stream.codec_name === 'h264' && stream.width === 640 && stream.height === 360, 'MP4 是目标尺寸 H.264');
  check(Number(stream.nb_read_frames) === 72 && Math.abs(Number(data.format.duration) - 3) < 0.05, '实际视频 72 帧、三秒');
  check(result.previews.length === 3 && result.bytes > 1000, '返回首中尾预览和真实文件大小');
  const red0 = decodedRed(video, 0);
  const red71 = decodedRed(video, 71);
  check(Math.abs(red0 - 12) < 8 && Math.abs(red71 - 154) < 8, '解码画面逐帧变化，首尾颜色符合代码时间（' + red0 + ' / ' + red71 + '）');
  const first = nativeImage.createFromPath(path.join(workspace, result.previews[0]));
  check(first.getSize().width === 640 && first.getSize().height === 360, '预览尺寸与输出一致');
  const expectedReds = [12, 84, 154];
  for (let index = 0; index < result.previews.length; index++) {
    const bitmap = nativeImage.createFromPath(path.join(workspace, result.previews[index])).toBitmap();
    check(bitmap[(10 * 640 + 10) * 4 + 2] === expectedReds[index],
      '无损预览第 ' + index + ' 张精确对应目标帧，未采到前帧');
  }
  check(snap.createdFiles.has(result.video) && snap.createdFiles.has(result.manifest) && snap.wroteFiles === 5,
    '视频、三张预览和参数记录均登记当前轮文件追踪');
  const progress = events.filter(function running(e) { return e.status === 'running'; });
  check(progress.length <= 101 && events[events.length - 1].status === 'done', '进度有界且完成事件带导出结果');
  check(BrowserWindow.getAllWindows().length === 0, '成功后释放隐藏页面');

  command('ffmpeg', ['-v','error','-f','lavfi','-i','sine=frequency=440:duration=1','-n',path.join(workspace,'tone.wav')]);
  const audioResult = await render({ workspace, args: Object.assign({}, args, { duration: 1.5, fps: 12, audioPath: 'tone.wav' }) });
  const audioData = JSON.parse(command('ffprobe', ['-v','error','-show_streams','-of','json',path.join(workspace,audioResult.video)]));
  const audioStream = audioData.streams.find(function isAudio(s) { return s.codec_type === 'audio'; });
  check(audioStream && audioStream.codec_name === 'aac' && Math.abs(Number(audioStream.duration) - 1.5) < 0.08,
    '短音轨合入 AAC 并补到画面结束');

  await testFailures(args);
  check(unhandled.length === 0, '异步错误、取消和管道关闭没有悬空异常');
  const report = { ok: true, checks, demo: path.relative(root, video).replace(/\\/g, '/'), result, workspace };
  await fs.promises.writeFile(path.join(workspace, 'verification.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('RESULT ' + JSON.stringify(report));
  clearTimeout(timeout);
  app.exit(0);
}

/** 验收失败保留产物和堆栈，以非零状态退出。 */
function failed(error) { console.error(error.stack || error); app.exit(1); }
main().catch(failed);
