const fs = require('fs');
const path = require('path');
const { app } = require('electron');

// 单个日志文件上限；超过就滚动成 main.prev.log，避免长期运行把磁盘写满
const MAX_BYTES = 2 * 1024 * 1024;

function logDir() {
  const dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function logFile() {
  return path.join(logDir(), 'main.log');
}

function rotateIfNeeded(file) {
  try {
    if (fs.statSync(file).size <= MAX_BYTES) return;
    fs.rmSync(path.join(logDir(), 'main.prev.log'), { force: true });
    fs.renameSync(file, path.join(logDir(), 'main.prev.log'));
  } catch {
    /* 文件不存在或被占用时忽略，不能因为记日志反过来影响主流程 */
  }
}

function stamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * 追加一条诊断日志
 * @param {string} tag 事件标签，例如 app、crash、tool
 * @param {string} message 中文描述
 * @param {object} [extra] 附加数据，会序列化成 JSON 跟在后面
 */
function log(tag, message, extra) {
  let line = `[${stamp()}] [${tag}] ${message}`;
  if (extra !== undefined) {
    try {
      line += ` ${JSON.stringify(extra)}`;
    } catch {
      line += ' [附加数据无法序列化]';
    }
  }
  try {
    const file = logFile();
    rotateIfNeeded(file);
    fs.appendFileSync(file, `${line}\n`, 'utf8');
  } catch {
    /* 写日志失败不影响应用运行 */
  }
  console.log(line);
}

module.exports = { log, logDir, logFile };
