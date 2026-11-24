'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createServer } = require('node:http');
const { once } = require('node:events');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { app, BrowserWindow, desktopCapturer, nativeImage } = require('electron');
const { record } = require('../electron/lib/window-recording');

const exec = promisify(execFile);
const title = 'SpCode 窗口录屏验收';

/**
 * 打开一个由真实 Chromium 绘制的测试窗口，保留用户当前的键盘焦点。
 * @param {string} name 标题，用于区分目标和遮挡窗口。
 * @param {string} html 页面颜色和动画夹具。
 * @param {boolean} alwaysOnTop 遮挡窗口保持置顶。
 * @returns {Promise<BrowserWindow>} 页面已加载后返回可见窗口。
 */
async function open(name, html, alwaysOnTop) {
  const win = new BrowserWindow({ show: false, minimizable: false, skipTaskbar: false, x: 120, y: 120, width: 520, height: 360, title: name,
    alwaysOnTop, webPreferences: { backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.showInactive();
  return win;
}

/**
 * 读取 PNG 中心的像素用来判断窗口来源及帧间变化。
 * @param {string} file 实际录制产出的 PNG。
 * @returns {string} 颜色通道顺序为 RGB。
 */
function pixel(file) {
  return centerRgb(nativeImage.createFromPath(file));
}

/**
 * 读取窗口中心的颜色，既可处理磁盘 PNG 也可处理实际发送到眼睛的图片。
 * @param {Electron.NativeImage} image Electron 解码的像素。
 * @returns {string} 红、绿、蓝通道的十进制值。
 */
function centerRgb(image) {
  const { width, height } = image.getSize();
  const offset = 4 * (Math.floor(height / 2) * width + Math.floor(width / 2));
  const bgra = image.toBitmap();
  return [bgra[offset + 2], bgra[offset + 1], bgra[offset]].join(',');
}

/**
 * 核对完整窗口帧排除了亮紫色遮挡和窗外标记。
 * @param {string} file 要检查的 GIF 解码帧。
 * @returns {void} 任一像素命中夹具的紫色阈值就抛出断言错误。
 */
function assertNoCover(file) {
  const bitmap = nativeImage.createFromPath(file).toBitmap();
  for (let offset = 0; offset < bitmap.length; offset += 4) {
    const purple = bitmap[offset] >= 235 && bitmap[offset + 1] <= 20 && bitmap[offset + 2] >= 235;
    if (purple) assert.fail('目标窗口帧混入紫色遮挡或窗外内容：' + file);
  }
}

/**
 * 用本机视觉端点核对截图、分段录像以及两个项目的独立回执。
 * @param {string} hwnd 红绿变化的窗口句柄。
 * @param {string} coverHwnd 紫色遮挡窗口的句柄。
 * @returns {Promise<object>} 返回通过工具生成的录像和截图路径，断言失败则拒绝。
 */
async function testEyes(hwnd, coverHwnd) {
  const file = path.resolve(__dirname, '../electron/lib/agent.js');
  const localRequire = createRequire(file);
  const context = {
    require: localRequire, module: { exports: {} }, __dirname: path.dirname(file),
    process, console, Buffer, URL, AbortController, AbortSignal, setTimeout, clearTimeout, setInterval, clearInterval
  };
  vm.runInNewContext(await fs.readFile(file, 'utf8') +
    '\nmodule.exports.fixture = { execTool, implementationStateKey };', context, { filename: file });
  const { execTool, implementationStateKey } = context.module.exports.fixture;
  const desktop = localRequire('./desktop-hand');
  const assembly = localRequire('./assembly');
  const selfTest = localRequire('./agi-self-test');
  const scope = localRequire('./agi-task-scope');
  const requests = [];
  const server = createServer(async function respond(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    requests.push(body.messages[0].content);
    res.setHeader('Content-Type', 'application/json');
    const content = body.messages[0].content;
    const findings = [];
    for (let index = 1; index < content.length; index += 2) {
      const label = content[index].text.trim();
      if (!label.startsWith('第 ')) continue;
      const img = nativeImage.createFromDataURL(content[index + 1].image_url.url);
      const [red, green, blue] = centerRgb(img).split(',').map(Number);
      let color = '绿';
      if (red > green) color = '红';
      if (red >= 235 && green <= 20 && blue >= 235) color = '紫';
      findings.push(label + '中心为' + color);
    }
    res.end(JSON.stringify({ choices: [{ message: { content: findings.join('、') || '可见红绿窗口像素，记录实际画面。' } }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  const originalVision = assembly.visionFrom;
  const codexModel = localRequire('./codex-model');
  const originalCodexComplete = codexModel.complete;
  const goal = '测试指定窗口的实际画面';
  const snap = { taskScope: scope.create(goal, [], false) };
  const lang = localRequire('./reply-lang').fromLocale('zh');
  /** 此测试从实际回执断言结果，无需渲染进度事件。 */
  function progress() {}
  const signal = new AbortController().signal;
  const workspace = path.resolve(__dirname, '..');

  try {
    desktop.setAlive(true);
    assert.ok(context.module.exports.toolsSpec().some(function named(tool) { return tool.function.name === 'screen_record'; }));
    assert.ok(selfTest.requiresVisual(goal, [], false));
    assert.ok(!selfTest.requiresVisual('修复数值解析并运行测试', [{ path: 'parser.js' }], false));
    const ocr = selfTest.begin(workspace, snap, [], 'screen_read', {}, implementationStateKey);
    selfTest.record(snap, ocr, true, '屏幕文字');
    assert.equal(selfTest.status(workspace, [], snap, implementationStateKey, true).ready, false);
    assert.equal(selfTest.status(workspace, [], snap, implementationStateKey, false).ready, true);
    assembly.visionFrom = function missing() { return {}; };
    await assert.rejects(execTool(workspace, snap, 'screen_look', {}, progress, [], signal, lang), /没有可用的看图模型/);
    assert.equal(selfTest.status(workspace, [], snap, implementationStateKey, true).ready, false);

    assembly.visionFrom = function visual() {
      return { model: 'spcode-pixel-fixture', endpoint: 'http://127.0.0.1:' + server.address().port };
    };
    const secondWorkspace = await fs.mkdtemp(path.join(app.getPath('userData'), 'project-'));
    const firstSnap = { taskScope: scope.create(goal, [], false) };
    const otherGoal = '检查另一个项目的紫色窗口';
    const otherSnap = { taskScope: scope.create(otherGoal, [], false) };
    const otherSignal = new AbortController().signal;
    /** 第一项目运行真实屏幕录制工具，回执写入自己的会话。 */
    function recordTarget() {
      return execTool(workspace, firstSnap, 'screen_record', { hwnd, durations: [3], question: goal }, progress, [], signal, lang);
    }
    /** 第二项目同时发起独立工具调用，使用自己的目标句柄和取消信号。 */
    function recordCover() {
      return execTool(secondWorkspace, otherSnap, 'screen_record', { hwnd: coverHwnd, durations: [3], question: otherGoal }, progress, [], otherSignal, lang);
    }
    const concurrent = await testConcurrentWindows(recordTarget, recordCover);
    const first = selfTest.status(workspace, [], firstSnap, implementationStateKey, true);
    const second = selfTest.status(secondWorkspace, [], otherSnap, implementationStateKey, true);
    assert.ok(first.ready && first.evidence.includes(concurrent.target) && !first.evidence.includes(concurrent.cover));
    assert.ok(second.ready && second.evidence.includes(concurrent.cover) && !second.evidence.includes(concurrent.target));
    const targetSamples = selfTest.recordedFrames(workspace, firstSnap, [], implementationStateKey);
    const coverSamples = selfTest.recordedFrames(secondWorkspace, otherSnap, [], implementationStateKey);
    assert.equal(targetSamples.length, 1);
    assert.equal(coverSamples.length, 1);
    assert.equal(path.dirname(targetSamples[0].path), path.dirname(concurrent.target));
    assert.equal(path.dirname(coverSamples[0].path), path.dirname(concurrent.cover));
    assert.equal(requests.length, 10);
    requests.length = 0;
    const shot = await execTool(workspace, snap, 'screen_look', { question: goal }, progress, [], signal, lang);
    const shotPath = shot.split('\n').find(function pathLine(line) { return line.startsWith('截图已保存：'); }).slice('截图已保存：'.length);
    assert.match(shot, /眼睛观察.*\n可见红绿窗口像素/);
    assert.equal(requests.length, 1);
    assert.equal(requests[0][2].image_url.url, 'data:image/png;base64,' + (await fs.readFile(shotPath)).toString('base64'));
    assert.equal(selfTest.status(workspace, [], snap, implementationStateKey, true).ready, true);
    snap.desktopStep = 1;
    assert.equal(selfTest.status(workspace, [], snap, implementationStateKey, true).ready, false);

    const start = requests.length;
    const result = await execTool(workspace, snap, 'screen_record', { hwnd, durations: [13, 1.6], question: goal }, progress, [], signal, lang);
    assert.equal(requests.length - start, 10);
    assert.match(result, /第 1 段（13 秒）/);
    assert.match(result, /第 2 段（1.6 秒）/);
    const lines = result.split('\n');
    const clips = lines.filter(function gif(line) { return line.startsWith('GIF：'); })
      .map(function gifPath(line) { return line.slice('GIF：'.length); });
    assert.equal(clips.length, 2);
    const lengths = [];
    for (const gif of clips) {
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
        'stream=nb_read_frames:format=duration', '-of', 'json', gif], { windowsHide: true });
      const probe = JSON.parse(stdout);
      assert.equal(Number(probe.streams[0].nb_read_frames), 20);
      lengths.push(Number(probe.format.duration));
    }
    assert.deepEqual(lengths, [13, 1.6]);
    let frameNo = 0;
    for (const request of requests.slice(start)) {
      assert.match(request[0].text, /测试指定窗口的实际画面/);
      assert.equal(request.length, 9);
      for (let item = 1; item < request.length; item += 2) {
        frameNo++;
        const label = request[item].text.trim();
        assert.ok(label.startsWith('第 ' + frameNo + ' 帧（第 ' + (frameNo <= 20 ? 1 : 2) + ' 段，'));
        const line = lines.find(function frameLine(value) { return value.startsWith('第 ' + frameNo + ' 帧 ') && value.includes('ms：'); });
        const framePath = line.slice(line.indexOf('ms：') + 'ms：'.length);
        assert.equal(request[item + 1].image_url.url, 'data:image/png;base64,' + (await fs.readFile(framePath)).toString('base64'));
        assertNoCover(framePath);
        const [r, g, b] = pixel(framePath).split(',').map(Number);
        assert.ok((r >= 250 && g <= 5 && b <= 5) || (g >= 250 && r <= 5 && b <= 5));
        assert.ok(result.includes(label + '中心为' + (r > g ? '红' : '绿')));
      }
    }
    assert.equal(frameNo, 40);
    const verified = selfTest.status(workspace, [], snap, implementationStateKey, true);
    assert.ok(verified.ready && verified.evidence.includes(clips[0]) && verified.evidence.includes(clips[1]));
    const samples = selfTest.recordedFrames(workspace, snap, [], implementationStateKey);
    assert.deepEqual(samples.map(function clipDir(frame) { return path.dirname(frame.path); }), clips.map(path.dirname));
    const switched = { ...snap, desktopStep: snap.desktopStep + 1 };
    assert.deepEqual(selfTest.recordedFrames(workspace, switched, [], implementationStateKey), samples);
    const edited = { ...snap, current: { manifest: { changes: [{ path: 'package.json' }] } } };
    assert.deepEqual(selfTest.recordedFrames(workspace, edited, [], implementationStateKey), []);
    let codexRequest;
    assembly.visionFrom = function codexSlot() {
      return { model: 'codex-vision-fixture', protocol: 'codex', reasoningEffort: 'high' };
    };
    /** 记录眼睛交给生产只读 SDK 传输的内容，返回该测试的识别结果。 */
    async function codexComplete(args) {
      codexRequest = args;
      return { content: 'Codex 已查看当前画面' };
    }
    codexModel.complete = codexComplete;
    const codexShot = await execTool(workspace, snap, 'screen_look', { question: goal }, progress, [], signal, lang);
    assert.match(codexShot, /Codex 已查看当前画面/);
    assert.equal(codexRequest.modelCfg.reasoningEffort, 'high');
    assert.equal(codexRequest.signal, signal);
    const codexContent = codexRequest.messages[0].content;
    assert.match(codexContent[0].text, /测试指定窗口的实际画面/);
    const codexPath = codexShot.split('\n').find(function pathLine(line) { return line.startsWith('截图已保存：'); }).slice('截图已保存：'.length);
    assert.equal(codexContent[2].image_url.url, 'data:image/png;base64,' + (await fs.readFile(codexPath)).toString('base64'));
    assert.equal(requests.length, 11);
    return { shotPath, clips, requestedSeconds: [13, 1.6], actualSeconds: lengths, reviewedFrames: frameNo, visualInputs: requests.length, codexScreenshot: codexPath, concurrent };
  } finally {
    codexModel.complete = originalCodexComplete;
    assembly.visionFrom = originalVision;
    desktop.setAlive(false);
    await new Promise(function close(resolve) { server.close(resolve); });
  }
}

/**
 * 验证两个项目的录屏工具请求同时采集，各自收到对应窗口的 GIF 和独立 PNG。
 * @param {Function} runTarget 录制红绿后台窗口的项目工具调用。
 * @param {Function} runCover 录制紫色遮挡窗口的另一项目工具调用。
 * @returns {Promise<object>} 两段录像的产物路径，采集页未重叠或画面串窗时拒绝。
 */
async function testConcurrentWindows(runTarget, runCover) {
  const captures = [];
  let overlapping = false;
  /** 在第二个采集页建立时确认第一个采集页仍在工作。 */
  function captureCreated(event, capture) {
    if (captures.length === 1 && !captures[0].isDestroyed()) overlapping = true;
    captures.push(capture);
  }

  /**
   * 从录屏工具回执读取它实际返回的 GIF 和逐帧路径。
   * @param {string} response 本项目的完整工具输出。
   * @returns {object} 录像路径和按回执顺序排列的单帧路径。
   */
  function output(response) {
    const lines = response.split('\n');
    const frames = [];
    let gif = '';
    for (const line of lines) {
      if (line.startsWith('GIF：')) gif = line.slice('GIF：'.length);
      if (line.startsWith('第 ') && line.includes('ms：')) frames.push({ path: line.slice(line.indexOf('ms：') + 'ms：'.length) });
    }
    assert.ok(gif);
    return { gif, frames };
  }

  app.on('browser-window-created', captureCreated);
  try {
    const [targetResponse, coverResponse] = await Promise.all([runTarget(), runCover()]);
    const target = output(targetResponse);
    const cover = output(coverResponse);
    assert.match(targetResponse, /中心为[红绿]/);
    assert.doesNotMatch(targetResponse, /中心为紫/);
    assert.match(coverResponse, /中心为紫/);
    assert.doesNotMatch(coverResponse, /中心为[红绿]/);
    assert.equal(captures.length, 2);
    assert.ok(overlapping, '两个窗口的录制应同时进行');
    assert.ok(captures.every(function closed(capture) { return capture.isDestroyed(); }));
    assert.notEqual(path.dirname(target.gif), path.dirname(cover.gif));
    assert.equal(target.frames.length, 20);
    assert.equal(cover.frames.length, 20);
    for (const frame of target.frames) assertNoCover(frame.path);
    for (const frame of cover.frames) {
      const [red, green, blue] = pixel(frame.path).split(',').map(Number);
      assert.ok(red >= 235 && green <= 20 && blue >= 235, '遮挡窗口的中心应始终为紫色');
    }
    return { target: target.gif, cover: cover.gif, overlapping };
  } finally {
    app.off('browser-window-created', captureCreated);
  }
}

/**
 * 用两个重叠窗口验证指定窗口采集、实际像素变化和 GIF 编码时长。
 * @returns {Promise<void>} 全部检查通过后输出实际产物路径和观测值，失败则拒绝。
 */
async function main() {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), 'spcode-recording-'));
  app.setPath('userData', data);
  await app.whenReady();
  const target = await open(title, '<body style="background:#ff0000"><script>let red=true;setInterval(function animate(){red=!red;document.body.style.background=red?"#ff0000":"#00ff00"},350)</script>', false);
  const cover = await open('录屏遮挡夹具', '<body style="background:#ff00ff">', true);
  // 让覆盖窗同时伸出目标边界，遮挡和窗外区域均用同一个独特像素标记。
  cover.setSize(640, 440);
  try {
    const hwnd = target.getNativeWindowHandle().readBigUInt64LE().toString();
    const enumerate = desktopCapturer.getSources;
    // 模拟 Chromium 源列表漏掉窗口，真实采集仍须读取被遮挡目标。
    async function omitWindows(options) {
      if (options.types.includes('window')) return [];
      return enumerate(options);
    }
    desktopCapturer.getSources = omitWindows;
    let result;
    try { result = await record(hwnd); }
    finally { desktopCapturer.getSources = enumerate; }
    assert.match(result.title, /SpCode/);
    assert.equal(result.frames.length, 20);
    assert.ok(result.frames.every(function timed(frame, index) {
      return frame.timeMs < 3000 && (!index || frame.timeMs > result.frames[index - 1].timeMs);
    }));
    const pixels = result.frames.map(function color(frame) { return pixel(frame.path); });
    // Windows 录制流的色彩转换可能使低通道相差一个色阶。
    const colors = pixels.map(function classify(pixel) {
      const [r, g, b] = pixel.split(',').map(Number);
      if (r >= 250 && g <= 5 && b <= 5) return '红';
      if (g >= 250 && r <= 5 && b <= 5) return '绿';
      return pixel;
    });
    assert.deepEqual(new Set(colors), new Set(['红', '绿']));
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries',
      'stream=nb_read_frames:format=duration', '-of', 'json', result.gif], { windowsHide: true });
    const probe = JSON.parse(stdout);
    assert.equal(Number(probe.streams[0].nb_read_frames), 20);
    assert.equal(Number(probe.format.duration), 3);
    const coverHwnd = cover.getNativeWindowHandle().readBigUInt64LE().toString();
    const eyes = await testEyes(hwnd, coverHwnd);
    assert.notEqual(eyes.clips[0], eyes.clips[1]);
    const stopped = new AbortController();
    stopped.abort();
    await assert.rejects(record(hwnd, stopped.signal), { name: 'AbortError' });
    await assert.rejects(record('1'), /未找到可录制的目标窗口/);
    console.log(JSON.stringify({ gif: result.gif, frames: result.frames.length, duration: probe.format.duration, pixels: Array.from(new Set(pixels)), first: result.frames[0], last: result.frames.at(-1), eyes }));
  } finally {
    cover.destroy();
    target.destroy();
  }
}

/** 保留真实失败栈并结束隔离的 Electron 测试进程。 */
function fail(error) { console.error(error); app.exit(1); }

main().then(function pass() { app.exit(0); }, fail);
