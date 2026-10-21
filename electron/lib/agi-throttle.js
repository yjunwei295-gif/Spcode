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

// 低配 / 中配 / 高配 / 顶配：OCR 线程数、截图长边上限、两次看屏幕的最短间隔。
// 档位越高看得越勤、截得越清楚：多核大内存的机器给到顶配档，屏幕感知才接近实时，
// 低配档仍然守 2.5 秒间隔，避免看屏幕把整机拖住。
const TIERS = {
  low: { name: '低配', ocrWorkers: 1, captureEdge: 1280, minGapMs: 2500 },
  mid: { name: '中配', ocrWorkers: 2, captureEdge: 1600, minGapMs: 1500 },
  high: { name: '高配', ocrWorkers: 4, captureEdge: 1920, minGapMs: 700 },
  ultra: { name: '顶配', ocrWorkers: 6, captureEdge: 2560, minGapMs: 300 }
};

let cachedProfile = null;
let lastObservedAt = 0;
let notify = null;

/**
 * 主屏长边（DIP 像素）：定档要看真实屏幕，高分屏在小档位下会被缩得看不清字。
 * Electron 还没 ready 时拿不到屏幕信息，返回 0，由调用方退回档位上限。
 * @returns {number} 屏幕长边，取不到时 0
 */
function primaryScreenEdge() {
  try {
    const { screen } = require('electron');
    const display = screen.getPrimaryDisplay();
    if (!display || !display.size) return 0;
    const w = Math.round(Number(display.size.width) || 0);
    const h = Math.round(Number(display.size.height) || 0);
    return Math.max(w, h);
  } catch {
    return 0;
  }
}

/**
 * 按当前电脑的核数、内存和屏幕尺寸定档。
 * 屏幕长边参与计算：高分屏在小档位下会被缩得看不清字，档位要跟着屏幕一起抬。
 * @returns {object} 档位名、核数、内存、OCR 线程数、截图长边上限、两次看屏幕的最短间隔
 */
function profile() {
  if (cachedProfile) return cachedProfile;
  const cores = (os.cpus() || []).length || 2;
  const totalGB = os.totalmem() / GB;
  const edge = primaryScreenEdge();
  let key = 'high';
  if (cores <= 4 || totalGB <= 8) key = 'low';
  else if (cores <= 8 || totalGB <= 16) key = 'mid';
  else if (cores > 16 && totalGB >= 24) key = 'ultra';
  const tier = TIERS[key];
  // 截图长边取「档位上限」和「屏幕真实长边」的较小值：小屏不放大，避免白花 OCR 时间；
  // 取不到屏幕尺寸时（Electron 还没 ready）先用档位上限。
  const captureEdge = edge ? Math.min(tier.captureEdge, edge) : tier.captureEdge;
  cachedProfile = { key, cores, totalGB: Math.round(totalGB * 10) / 10, ...tier, captureEdge, screenEdge: edge };
  diag.log('desktop', 'AGI 资源档位', {
    档位: cachedProfile.name,
    核数: cores,
    内存GB: cachedProfile.totalGB,
    屏幕长边: edge,
    截图长边: captureEdge,
    最短间隔ms: tier.minGapMs
  });
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
