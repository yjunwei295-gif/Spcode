// AGI 资源节流：按电脑配置分档，干活前看 CPU / 内存，忙就等、就降级，不把用户电脑吃满。
// 用户允许 AGI 变慢，但不允许卡死整机。
const os = require('os');
const diag = require('./diag');

const GB = 1024 * 1024 * 1024;
const CPU_BUSY_PCT = 85;
const MEM_FREE_MIN_BYTES = 1.5 * GB;
const MEM_FREE_MIN_RATIO = 0.15;
const BUSY_WAIT_MAX_MS = 10000;
const BUSY_POLL_MS = 1000;
const CPU_SAMPLE_MS = 300;

// 低配 / 中配 / 高配：OCR 线程数、截图长边、两次看屏幕的最短间隔
const TIERS = {
  low: { name: '低配', ocrWorkers: 1, captureEdge: 1280, minGapMs: 3000 },
  mid: { name: '中配', ocrWorkers: 2, captureEdge: 1600, minGapMs: 2000 },
  high: { name: '高配', ocrWorkers: 3, captureEdge: 1920, minGapMs: 1000 }
};

let cachedProfile = null;
let lastObservedAt = 0;
let notify = null;

function profile() {
  if (cachedProfile) return cachedProfile;
  const cores = (os.cpus() || []).length || 2;
  const totalGB = os.totalmem() / GB;
  let key = 'high';
  if (cores <= 4 || totalGB <= 8) key = 'low';
  else if (cores <= 8 || totalGB <= 16) key = 'mid';
  cachedProfile = { key, cores, totalGB: Math.round(totalGB * 10) / 10, ...TIERS[key] };
  diag.log('desktop', 'AGI 资源档位', { 档位: cachedProfile.name, 核数: cores, 内存GB: cachedProfile.totalGB });
  return cachedProfile;
}

function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus() || []) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

// Windows 上 os.loadavg() 恒为 0，只能两次采样 CPU 时间算占用率
async function cpuPercent() {
  const a = cpuTimes();
  await new Promise((r) => setTimeout(r, CPU_SAMPLE_MS));
  const b = cpuTimes();
  const total = b.total - a.total;
  if (total <= 0) return 0;
  return Math.round((1 - (b.idle - a.idle) / total) * 100);
}

function memLow() {
  const free = os.freemem();
  return free < MEM_FREE_MIN_BYTES || free / os.totalmem() < MEM_FREE_MIN_RATIO;
}

async function pressure() {
  const cpu = await cpuPercent();
  return {
    cpu,
    cpuBusy: cpu >= CPU_BUSY_PCT,
    memLow: memLow(),
    freeMB: Math.round(os.freemem() / 1048576)
  };
}

function setNotify(fn) {
  notify = typeof fn === 'function' ? fn : null;
}

function say(text) {
  if (!notify) return;
  try { notify(text); } catch { /* 通知失败不挡操作 */ }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// 看屏幕之前调用：守最短间隔，电脑忙就等（最多 10 秒），仍忙则返回 degraded 让调用方降级
async function beforeObserve() {
  const p = profile();
  const gap = Date.now() - lastObservedAt;
  if (lastObservedAt && gap < p.minGapMs) await sleep(p.minGapMs - gap);
  let st = await pressure();
  if (!st.cpuBusy && !st.memLow) return { degraded: false, ...st };
  say(`电脑繁忙（CPU ${st.cpu}%，剩余内存 ${st.freeMB}MB），AGI 降速中…`);
  diag.log('desktop', 'AGI 降速等待', { cpu: st.cpu, 剩余内存MB: st.freeMB });
  const start = Date.now();
  while (Date.now() - start < BUSY_WAIT_MAX_MS) {
    await sleep(BUSY_POLL_MS);
    st = await pressure();
    if (!st.cpuBusy && !st.memLow) return { degraded: false, ...st };
  }
  say('电脑仍然繁忙，本次只做轻量识别（单线程 OCR、跳过控件扫描）');
  return { degraded: true, ...st };
}

function markObserved() {
  lastObservedAt = Date.now();
}

function reset() {
  lastObservedAt = 0;
  notify = null;
}

module.exports = { profile, pressure, beforeObserve, markObserved, setNotify, reset };
