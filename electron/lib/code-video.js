/**
 * 将项目里的 HTML/Canvas 动画按固定时间采样，交给 FFmpeg 编成 MP4。
 * 在独立的隐藏 Chromium 页面运行，不占用聊天页面的绘制循环；不调用生成模型。
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { resolveRead } = require('./workspace');

const toolSpec = {
  type: 'function',
  function: {
    name: 'render_code_video',
    description: '用代码做视频：先用 write_file/edit_file 编写 HTML 动画，再调用本工具逐帧渲染为 H.264 MP4，不需要视频生成模型。HTML 必须定义 window.renderFrame(time, frame, info)，time 为秒、frame 从 0 开始、info 含 width/height/fps/duration/totalFrames；可返回 Promise。动画只依赖传入时间，不使用实时计时器、自动播放或随机数。相对素材路径相对于 HTML；图片与字体会等待就绪，动态素材由 renderFrame 自己 await。尺寸/帧率/时长必须明确指定；宽高为正偶数。可选 audioPath 配乐/配音，短音轨补静音、长音轨截到画面结束。需要 PATH 中有 FFmpeg。输出到 generated/ 唯一目录，返回视频、首中尾预览和参数记录；检查预览后再交付。',
    parameters: {
      type: 'object',
      properties: {
        sourcePath: { type: 'string', description: '项目内 HTML 动画文件，相对路径' },
        width: { type: 'integer', description: '视频宽度，像素，正偶数' },
        height: { type: 'integer', description: '视频高度，像素，正偶数' },
        fps: { type: 'number', description: '每秒帧数，正数' },
        duration: { type: 'number', description: '目标时长，秒，正数；不足一帧向上取整' },
        audioPath: { type: 'string', description: '可选，本地配音或音乐文件路径' }
      },
      required: ['sourcePath', 'width', 'height', 'fps', 'duration']
    }
  }
};

/** 检查 MP4 编码要求；无效参数直接报错，不静默更换尺寸、帧率或素材。 */
function validate(args) {
  for (const key of ['width', 'height']) {
    if (!Number.isInteger(args[key]) || args[key] <= 0 || args[key] % 2 !== 0) {
      throw new Error(key + ' 必须是正偶数（H.264 yuv420p 要求）');
    }
  }
  for (const key of ['fps', 'duration']) {
    if (!Number.isFinite(args[key]) || args[key] <= 0) throw new Error(key + ' 必须是正数');
  }
  if (!args.sourcePath || path.extname(args.sourcePath).toLowerCase() !== '.html') {
    throw new Error('sourcePath 必须指向 HTML 动画文件');
  }
}

/** 用户停止时保留 AbortError 类型，由现有 Agent 中断链路处理。 */
function checkAbort(signal) {
  if (signal) signal.throwIfAborted();
}

/**
 * 为页面异步操作接入停止信号。
 * Chromium 销毁页面后，页面内永不结束的 Promise 不一定拒绝；
 * 主进程必须独立结束等待，页面与编码进程仍由 render 的 finally 释放。
 */
function awaitAbort(promise, signal) {
  if (!signal) return promise;
  checkAbort(signal);
  function pending(resolve, reject) {
    /** 停止时结束主进程的等待，保留原始停止原因。 */
    function cancelled() { reject(signal.reason); }
    /** 页面操作完成后移除停止监听，避免每一帧累积监听器。 */
    function completed(value) {
      signal.removeEventListener('abort', cancelled);
      resolve(value);
    }
    /** 原始页面错误继续交给调用方，不转成静默成功。 */
    function failed(error) {
      signal.removeEventListener('abort', cancelled);
      reject(error);
    }
    signal.addEventListener('abort', cancelled, { once: true });
    Promise.resolve(promise).then(completed, failed);
  }
  return new Promise(pending);
}

/**
 * 启动异步编码器；PNG 通过管道输入，不保存全部序列帧。
 * 返回的完成承诺始终携带真实进程结果，由调用方检查；限制诊断日志内存占用。
 */
function createEncoder(args, output, audio, signal) {
  const flags = ['-hide_banner', '-loglevel', 'error', '-n',
    '-f', 'image2pipe', '-vcodec', 'png', '-framerate', String(args.fps), '-i', 'pipe:0'];
  if (audio) flags.push('-i', audio);
  flags.push('-map', '0:v:0');
  if (audio) flags.push('-map', '1:a:0', '-af', 'apad', '-c:a', 'aac');
  else flags.push('-an');
  flags.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', String(args.totalFrames / args.fps),
    '-movflags', '+faststart', output);
  const child = spawn('ffmpeg', flags, { windowsHide: true, signal });
  const state = { child, error: null, stderr: '', code: null };
  function rememberError(error) { state.error = error; }
  function collect(chunk) { state.stderr = (state.stderr + chunk.toString()).slice(-8192); }
  function finish(code) { state.code = code; state.resolve(); }
  function ready(resolve, reject) {
    function spawned() { resolve(); }
    function failed(error) { reject(error); }
    child.once('spawn', spawned);
    child.once('error', failed);
  }
  function completed(resolve) { state.resolve = resolve; }
  child.on('error', rememberError);
  child.stdin.on('error', rememberError);
  child.stderr.on('data', collect);
  child.once('close', finish);
  state.done = new Promise(completed);
  state.ready = new Promise(ready);
  return state;
}

/** 等待管道消费当前 PNG 后再生成下一帧，编码慢时不累积全部图像到内存。 */
function writeFrame(encoder, png) {
  function write(resolve, reject) {
    function written(error) {
      if (error) reject(error);
      else resolve();
    }
    if (encoder.error) return reject(encoder.error);
    encoder.child.stdin.write(png, written);
  }
  return new Promise(write);
}

/**
 * 渲染单个 HTML 动画并导出 MP4、首中尾预览和参数记录。
 * beforeWrite 在每份交付文件写入前接入 Agent 快照；失败与取消均销毁窗口和编码进程，
 * 保留已写出的产物供诊断，不将不完整视频报告为成功。
 */
async function render({ workspace, extra, args, signal, onProgress, beforeWrite }) {
  validate(args);
  if (!workspace) throw new Error('请先打开项目');
  checkAbort(signal);
  const source = resolveRead(workspace, extra || [], args.sourcePath);
  const audio = args.audioPath ? resolveRead(workspace, extra || [], args.audioPath) : null;
  const info = {
    width: args.width, height: args.height, fps: args.fps, duration: args.duration,
    totalFrames: Math.ceil(args.duration * args.fps)
  };
  const { BrowserWindow, app } = require('electron');
  await app.whenReady();
  checkAbort(signal);
  const base = path.join(workspace, 'generated');
  await fs.promises.mkdir(base, { recursive: true });
  const dir = await fs.promises.mkdtemp(path.join(base, 'code-video-'));
  const video = path.join(dir, 'video.mp4');
  const manifest = path.join(dir, 'render.json');
  const previews = [];
  let win;
  let encoder;
  let completed = false;

  /** 写前登记相对路径，沿用当前轮的文件追踪，不覆盖已有产物。 */
  function record(file) {
    if (beforeWrite) beforeWrite(path.relative(workspace, file).replace(/\\/g, '/'));
  }

  /** 停止按钮同时中止页面和编码，避免留下后台视频任务。 */
  function abort() {
    if (win && !win.isDestroyed()) win.destroy();
    if (encoder && encoder.child.exitCode === null) encoder.child.kill();
  }

  if (signal) signal.addEventListener('abort', abort, { once: true });
  try {
    record(video);
    encoder = createEncoder(info, video, audio, signal);
    await encoder.ready;
    win = new BrowserWindow({
      width: info.width, height: info.height, useContentSize: true, show: false,
      webPreferences: {
        nodeIntegration: false, contextIsolation: true, sandbox: true,
        backgroundThrottling: false, offscreen: true
      }
    });
    /** 动画源文件只在隐藏页面绘制，不创建额外桌面窗口。 */
    function denyWindow() { return { action: 'deny' }; }
    win.webContents.setWindowOpenHandler(denyWindow);
    await awaitAbort(win.loadFile(source), signal);
    await awaitAbort(win.webContents.executeJavaScript(
      '(async function prepareCodeVideo() {' +
      'if (typeof window.renderFrame !== "function") throw new Error("HTML 必须定义 window.renderFrame(time, frame, info)");' +
      'await document.fonts.ready;' +
      'for (const image of document.images) { await image.decode(); }' +
      '})()'
    ), signal);
    const indices = new Set([0, Math.floor(info.totalFrames / 2), info.totalFrames - 1]);
    let reported = -1;
    for (let frame = 0; frame < info.totalFrames; frame++) {
      checkAbort(signal);
      await awaitAbort(win.webContents.executeJavaScript(
        '(async function paintCodeVideo() {' +
        'await window.renderFrame(' + JSON.stringify(frame / info.fps) + ',' + frame + ',' + JSON.stringify(info) + ');' +
        // 第一帧回调发生在绘制前，再等下一帧，确保截图采到本次修改提交后的画面。
        'await new Promise(function waitForPaint(resolve) { requestAnimationFrame(function nextPaint() { requestAnimationFrame(resolve); }); });' +
        '})()'
      ), signal);
      checkAbort(signal);
      const captured = await awaitAbort(win.webContents.capturePage(), signal);
      // 截图受桌面 DPI 影响，统一换算为用户指定的输出像素尺寸。
      const png = captured.resize({ width: info.width, height: info.height, quality: 'best' }).toPNG();
      if (indices.has(frame)) {
        const preview = path.join(dir, 'frame-' + String(frame).padStart(6, '0') + '.png');
        record(preview);
        await fs.promises.writeFile(preview, png);
        previews.push(path.relative(workspace, preview).replace(/\\/g, '/'));
      }
      await writeFrame(encoder, png);
      const percent = Math.floor((frame + 1) * 100 / info.totalFrames);
      if (percent !== reported && onProgress) {
        reported = percent;
        onProgress({ frame: frame + 1, totalFrames: info.totalFrames, percent });
      }
    }
    encoder.child.stdin.end();
    await encoder.done;
    checkAbort(signal);
    if (encoder.error || encoder.code !== 0) {
      throw new Error('FFmpeg 编码失败：' + (encoder.stderr || String(encoder.error || encoder.code)));
    }
    const result = {
      video: path.relative(workspace, video).replace(/\\/g, '/'),
      source: path.relative(workspace, source).replace(/\\/g, '/'),
      width: info.width, height: info.height, fps: info.fps,
      requestedDuration: info.duration, duration: info.totalFrames / info.fps,
      totalFrames: info.totalFrames, previews,
      bytes: (await fs.promises.stat(video)).size
    };
    if (audio) result.audio = path.relative(workspace, audio).replace(/\\/g, '/');
    record(manifest);
    await fs.promises.writeFile(manifest, JSON.stringify(result, null, 2) + '\n', 'utf8');
    completed = true;
    return Object.assign({ manifest: path.relative(workspace, manifest).replace(/\\/g, '/') }, result);
  } catch (error) {
    checkAbort(signal);
    if (encoder && encoder.stderr) throw new Error(error.message + '\n' + encoder.stderr);
    throw error;
  } finally {
    if (signal) signal.removeEventListener('abort', abort);
    if (win && !win.isDestroyed()) win.destroy();
    if (encoder && !completed) {
      encoder.child.stdin.destroy();
      if (encoder.child.exitCode === null) encoder.child.kill();
      await encoder.done;
    }
  }
}

module.exports = { toolSpec, render };
