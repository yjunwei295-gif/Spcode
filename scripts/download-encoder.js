// 脚本用途：脱离 SimpleCode 的生图 UI 流程，在独立的 electron 进程里后台下载
// Qwen-Image 2.1 所需的 Qwen3-VL-8B 文本编码器（GGUF 格式，约 5GB）。
// 支持断点续传：下载器会写 .part 与 .part.meta，失败后可从已下部分继续。
// 本脚本对多个下载源轮询尝试并自动重试，运行日志写入 download-encoder.log。

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const store = require('../electron/lib/store');
const downloader = require('../electron/lib/downloader');

// 模型仓库与文件名
const REPO = 'unsloth/Qwen3-VL-8B-Instruct-GGUF';
const NAME = 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf';

// 候选下载源，逐个尝试
const BASES = ['https://hf-mirror.com', 'https://huggingface.co'];

// 外层轮数：每轮把所有源试一遍
const ROUNDS = 200;
// 一轮全部源失败后的等待时间
const WAIT_MS = 15000;
// 判断是否有别的进程正在写同一个 .part.meta 的时间窗口
const CONFLICT_WINDOW_MS = 90000;
// 日志文件路径
const LOG_FILE = path.join(__dirname, 'download-encoder.log');
// 进度日志输出间隔
const PROGRESS_LOG_INTERVAL_MS = 30000;
const PROGRESS_LOG_PCT_STEP = 5;

// 模块级进度记录
let lastLogAt = 0;
let lastPct = -1;

// 追加一行日志到文件并打印到控制台
function writeLog(message) {
  const line = '[' + new Date().toISOString() + '] ' + message;
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  console.log(line);
}

// 取文件大小，异常时返回 0
function fileSize(p) {
  try {
    return fs.statSync(p).size;
  } catch (e) {
    return 0;
  }
}

// 等待指定毫秒后 resolve
function sleep(ms) {
  return new Promise(makeResolver(ms));
}

function makeResolver(ms) {
  return function (resolve) {
    setTimeout(onSleepTimeout, ms, resolve);
  };
}

function onSleepTimeout(resolve) {
  resolve();
}

// 下载进度回调，p 字段为 { downloaded, total, speed, threads, retrying, attempt }
function onProgressFn(p) {
  if (!p || !p.total || p.total <= 0) return;
  const downloaded = p.downloaded || 0;
  const speed = p.speed || 0;
  const threads = p.threads || 0;
  const totalGb = p.total / 1024 / 1024 / 1024;
  const gotGb = downloaded / 1024 / 1024 / 1024;
  const pct = Math.floor(downloaded / p.total * 100);
  const speedMb = speed / 1024 / 1024;
  const now = Date.now();
  const needByTime = now - lastLogAt >= PROGRESS_LOG_INTERVAL_MS;
  const needByPct = pct - lastPct >= PROGRESS_LOG_PCT_STEP;
  if (needByTime || needByPct) {
    let msg = '已下载 ' + gotGb.toFixed(2) + ' GB / ' + totalGb.toFixed(2) +
      ' GB（' + pct + '%） 速度 ' + speedMb.toFixed(2) + ' MB/s 分片 ' + threads;
    if (p.retrying) {
      const attempt = p.attempt || 0;
      msg += ' 重试中(第 ' + attempt + ' 次)';
    }
    writeLog(msg);
    lastLogAt = now;
    lastPct = pct;
  }
}

// 主流程，返回退出码
async function main() {
  const dir = store.defaultModelsDir();
  const dest = path.join(dir, NAME);

  if (fileSize(dest) > 1024 * 1024) {
    writeLog('目标文件已存在，无需下载：' + dest);
    return 0;
  }

  const metaPath = dest + '.part.meta';
  if (fs.existsSync(metaPath)) {
    let recent = false;
    try {
      recent = Date.now() - fs.statSync(metaPath).mtimeMs < CONFLICT_WINDOW_MS;
    } catch (e) {
      recent = false;
    }
    if (recent) {
      writeLog('检测到 SimpleCode 正在下载同一个文件，本脚本退出以避免互相破坏');
      return 2;
    }
  }

  for (let round = 1; round <= ROUNDS; round += 1) {
    for (const base of BASES) {
      const url = base.replace(/\/$/, '') + '/' + REPO + '/resolve/main/' + NAME;
      writeLog('第 ' + round + ' 轮，源 ' + base + ' 开始下载');
      const r = await downloader.download({
        id: 'encoder-' + Date.now(),
        url: url,
        dir: dir,
        name: NAME,
        threads: 'auto',
        onProgress: onProgressFn
      });
      if (r.ok) {
        writeLog('下载完成：' + (r.path || dest));
        return 0;
      }
      writeLog('源 ' + base + ' 失败：' + (r.message || '未知原因'));
    }
    writeLog('第 ' + round + ' 轮所有源都失败，等 ' + (WAIT_MS / 1000) + ' 秒后重试');
    await sleep(WAIT_MS);
  }

  writeLog('已尝试 ' + ROUNDS + ' 轮仍失败，请检查网络或换源');
  return 1;
}

// 入口：electron 就绪后启动主流程
function onReady() {
  main().then(onDone).catch(onFail);
}

function onDone(code) {
  writeLog('脚本结束，退出码 ' + code);
  app.exit(code);
}

function onFail(err) {
  writeLog('脚本异常：' + (err && err.message ? err.message : String(err)));
  app.exit(1);
}

app.whenReady().then(onReady);
