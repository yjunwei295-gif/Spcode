'use strict';

const { app, BrowserWindow } = require('electron');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');

const run = promisify(execFile);
// 每段均匀采集二十张，时长由本次请求决定。
const FRAME_COUNT = 20;
const DEFAULT_DURATION_SECONDS = 3;
const MAX_EDGE = 1280;
// 启动采集源的额外等待时间，不计入录制片段。
const CAPTURE_START_TIMEOUT_MS = 12000;
// Node 定时器使用有符号 32 位毫秒值。
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

/**
 * 在隔离采集页读取指定窗口的像素，采集期间不切换到其他窗口。
 * @param {object} options 窗口源标识、帧数、录制时长及画面长边上限。
 * @returns {Promise<Array<{timeMs:number,png:string}>>} 按实际采样时序返回 PNG；窗口流中断或超过片段时限时拒绝。
 */
async function sampleWindow({ sourceId, frameCount, durationMs, maxEdge }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId } }
  });
  const track = stream.getVideoTracks()[0];
  const video = document.createElement('video');
  try {
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, maxEdge / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d', { alpha: false });
    const by = durationMs / frameCount;
    const start = performance.now();
    const frames = [];
    for (let index = 0; index < frameCount; index++) {
      const wait = start + index * by - performance.now();
      if (wait > 0) await new Promise(function atSample(resolve) { setTimeout(resolve, wait); });
      const timeMs = Math.round(performance.now() - start);
      if (track.readyState !== 'live') throw new Error('目标窗口的录制流已结束');
      if (timeMs >= durationMs) throw new Error('在本段时限内未采满目标窗口的二十帧');
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push({ timeMs, png: canvas.toDataURL('image/png').split(',')[1] });
    }
    return frames;
  } finally {
    track.stop();
    video.srcObject = null;
  }
}

/**
 * 锁定 Windows 窗口句柄并录制一段 GIF。
 * @param {string} hwnd 来自 runtime_state 窗口快照的十进制句柄。
 * @param {AbortSignal} signal 当前轮次取消信号。
 * @param {number} [requestedSeconds=3] 请求的秒数，可用小数，转换到毫秒后按请求时长采集。
 * @returns {Promise<object>} 含窗口标题、实际录制秒数、GIF 路径、独立 PNG 路径和采样时间；取消、无效时长或采集编码失败时拒绝。
 */
async function record(hwnd, signal, requestedSeconds = DEFAULT_DURATION_SECONDS) {
  if (!Number.isFinite(requestedSeconds) || requestedSeconds < 0.001) throw new Error('录屏时长须为至少一毫秒的秒数');
  const durationMs = Math.round(requestedSeconds * 1000);
  const captureDeadline = CAPTURE_START_TIMEOUT_MS + durationMs;
  if (captureDeadline > MAX_TIMER_DELAY_MS) throw new Error('录屏时长超出定时器可表示的范围');
  const durationSeconds = durationMs / 1000;
  if (process.platform !== 'win32') throw new Error('按窗口句柄录制目前支持 Windows');
  if (typeof hwnd !== 'string' || !/^[1-9][0-9]*$/.test(hwnd)) throw new Error('请填写窗口快照中的十进制 hwnd');
  signal?.throwIfAborted();
  const target = await require('./desktop-hand').windowForCapture(hwnd);
  if (!target) throw new Error('未找到可录制的目标窗口，句柄：' + hwnd);
  if (target.min) throw new Error('目标窗口已最小化：' + target.title);
  // Chromium 的窗口源列表可能漏掉被遮挡的窗口。Windows 确认身份后，按原生句柄直接打开采集源。
  const sourceId = 'window:' + hwnd + ':0';
  signal?.throwIfAborted();

  const capture = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, sandbox: true, contextIsolation: true } });
  const timeout = setTimeout(closeCapture, captureDeadline);
  /** 关闭本次采集页并释放窗口流。 */
  function closeCapture() { if (!capture.isDestroyed()) capture.destroy(); }
  signal?.addEventListener('abort', closeCapture, { once: true });
  let frames;
  try {
    await capture.loadFile(path.join(__dirname, 'window-recording.html'));
    const options = JSON.stringify({ sourceId, frameCount: FRAME_COUNT, durationMs, maxEdge: MAX_EDGE });
    frames = await capture.webContents.executeJavaScript('(' + sampleWindow.toString() + ')(' + options + ')');
  } catch (error) {
    signal?.throwIfAborted();
    if (capture.isDestroyed()) throw new Error('目标窗口采集超时');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', closeCapture);
    closeCapture();
  }

  const base = path.join(app.getPath('userData'), 'ai-sight');
  await fs.mkdir(base, { recursive: true });
  const dir = await fs.mkdtemp(path.join(base, 'recording-'));
  const saved = [];
  for (let index = 0; index < frames.length; index++) {
    const file = path.join(dir, 'frame-' + String(index + 1).padStart(2, '0') + '.png');
    await fs.writeFile(file, Buffer.from(frames[index].png, 'base64'), { signal });
    saved.push({ path: file, timeMs: frames[index].timeMs });
  }
  const gif = path.join(dir, 'recording.gif');
  const sequence = path.join(dir, 'frame-%02d.png');
  await run('ffmpeg', ['-v', 'error', '-framerate', (FRAME_COUNT * 1000) + '/' + durationMs, '-start_number', '1',
    '-i', sequence, '-filter_complex', 'split[a][b];[a]palettegen[p];[b][p]paletteuse',
    '-loop', '0', gif], { signal, windowsHide: true });
  // 逐帧解码成独立 PNG，眼睛读取的画面与最终 GIF 一致。
  await run('ffmpeg', ['-v', 'error', '-i', gif, '-fps_mode', 'passthrough', '-start_number', '1',
    '-y', sequence], { signal, windowsHide: true });
  return { title: target.title, durationSeconds, gif, frames: saved };
}

module.exports = { record };
