const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const { isDocumentExt, isImageExt } = require('./media-core');

// 文档/图片/视频解析统一放到 worker 线程里跑，避免同步解析（xlsx、spawnSync 等）
// 阻塞主进程导致整个界面卡死。这里只做校验、大小上限、超时与取消。

const MAX_PARSE_BYTES = 64 * 1024 * 1024; // 超过 64MB 的文件直接跳过内容解析
const WORKER_TIMEOUT_MS = 120 * 1000; // worker 兜底超时，正常不会触发（内部各解析器各有更短超时）
const WORKER_PATH = path.join(__dirname, 'media-worker.js');

function skipResult(name, text) {
  return { kind: 'file', name, text };
}

/**
 * 解析附件/文档，与旧版 media.parseAttachment 同签名、同返回结构。
 * @param {string} abs 文件绝对路径
 * @param {{ signal?: AbortSignal }} [opts]
 */
function parseAttachment(abs, opts = {}) {
  const signal = opts.signal || null;
  const name = path.basename(abs);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在：${name}`);

  let size = 0;
  try { size = fs.statSync(abs).size; } catch { /* 忽略 stat 失败 */ }
  if (size > MAX_PARSE_BYTES) {
    const mb = (size / 1024 / 1024).toFixed(1);
    return Promise.resolve(skipResult(name, `文件过大（${mb} MB），已跳过内容解析，仅显示文件名与大小。`));
  }

  return new Promise((resolve, reject) => {
    let worker = null;
    let settled = false;

    function cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      if (worker) { try { worker.terminate(); } catch { /* 忽略 */ } }
    }

    function finish(fn, val) {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    }

    const timer = setTimeout(() => {
      finish(resolve, skipResult(name, `解析超时（超过 ${WORKER_TIMEOUT_MS / 1000} 秒），已中止读取。文件可能过大或损坏。`));
    }, WORKER_TIMEOUT_MS);

    const onAbort = () => finish(resolve, skipResult(name, '已停止读取文件。'));

    try {
      worker = new Worker(WORKER_PATH);
    } catch (e) {
      finish(reject, e);
      return;
    }

    worker.once('message', (msg) => {
      if (msg && msg.ok) finish(resolve, msg.result);
      else finish(reject, new Error((msg && msg.error) || '解析失败'));
    });
    worker.once('error', (e) => finish(reject, e));
    worker.once('exit', (code) => {
      if (!settled) finish(reject, new Error(`解析进程异常退出（code ${code}）`));
    });

    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    worker.postMessage({ abs });
  });
}

module.exports = { parseAttachment, isDocumentExt, isImageExt };
