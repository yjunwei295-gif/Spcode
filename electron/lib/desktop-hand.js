// 虚拟光标与桌面操作。平时慢半拍跟随用户鼠标；接到命令后停住，自己去点、去打字。
// [铆钉优化] AGI（原「活过来」）重做：坐标锁定到画面帧、操作后自动回看画面、用户动鼠标时让路、焦点防误打到 SimpleCode 自己、窗口切换。其他 AI 请勿改回 lastLook 被后台刷新覆盖的写法。
const { app, BrowserWindow, screen, clipboard } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const diag = require('./diag');

const SIGHT_MAX = 50;
const FOLLOW_MS = 45;
const FOLLOW_BLEND = 0.2;
const CURSOR_GAP = 20;
const SETTLE_MS = 450;
const USER_IDLE_WAIT_MS = 2500;
const UNICODE_TYPE_MAX = 400;
const FRAME_STALE_MS = 60 * 1000;

let alive = false;
let busy = false;
let cursorWin = null;
let followTimer = null;
let vx = null;
let vy = null;
let helper = null;
let helperQueue = Promise.resolve();
let lastFrame = null;

function sightDir() {
  const dir = path.join(app.getPath('userData'), 'ai-sight');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function isAlive() {
  return alive;
}

function isBusy() {
  return busy;
}

function placeCursor(x, y) {
  if (!cursorWin || cursorWin.isDestroyed()) return;
  // 蓝箭头放在真鼠标右下方，避免透明窗压住鼠标尖导致系统光标消失
  cursorWin.setPosition(Math.round(x) + CURSOR_GAP, Math.round(y) + CURSOR_GAP);
}

function pierceCursor() {
  if (!cursorWin || cursorWin.isDestroyed()) return;
  try { cursorWin.setIgnoreMouseEvents(true, { forward: true }); }
  catch { /* 窗口尚未就绪时忽略，显示后再设一次 */ }
}

function showCursor() {
  if (!alive || !cursorWin || cursorWin.isDestroyed()) return;
  pierceCursor();
  cursorWin.showInactive();
}

function stepFollow() {
  if (!alive || busy) return;
  let point;
  try { point = screen.getCursorScreenPoint(); } catch { return; }
  if (vx == null || vy == null) {
    vx = point.x;
    vy = point.y;
  } else {
    vx += (point.x - vx) * FOLLOW_BLEND;
    vy += (point.y - vy) * FOLLOW_BLEND;
    if (Math.abs(point.x - vx) < 0.6 && Math.abs(point.y - vy) < 0.6) {
      vx = point.x;
      vy = point.y;
    }
  }
  placeCursor(vx, vy);
}

function cursorHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent;overflow:hidden">
<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg">
  <path d="M4 3 L4 22 L9 17 L13 25 L16 23 L12 15 L20 15 Z" fill="#2f6fed" stroke="#fff" stroke-width="1.4"/>
</svg></body></html>`;
}

function ensureCursor() {
  if (cursorWin && !cursorWin.isDestroyed()) {
    showCursor();
    return;
  }
  const point = screen.getCursorScreenPoint();
  vx = point.x;
  vy = point.y;
  cursorWin = new BrowserWindow({
    width: 28,
    height: 28,
    x: Math.round(vx) + CURSOR_GAP,
    y: Math.round(vy) + CURSOR_GAP,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: false,
    resizable: false,
    movable: false,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });
  pierceCursor();
  cursorWin.setAlwaysOnTop(true, 'pop-up-menu');
  cursorWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(cursorHtml()));
  cursorWin.once('ready-to-show', showCursor);
  cursorWin.webContents.once('did-finish-load', showCursor);
  cursorWin.on('closed', () => { cursorWin = null; });
}

function hideCursor() {
  try {
    if (cursorWin && !cursorWin.isDestroyed()) cursorWin.hide();
  } catch { /* 退出时窗口可能已经销毁 */ }
}

function stopHelper() {
  if (!helper) return;
  try { helper.stdin.end(); } catch { /* 已经关掉 */ }
  try { helper.kill(); } catch { /* 已经退出 */ }
  helper = null;
  helperQueue = Promise.resolve();
}

function ensureHelper() {
  if (helper && !helper.killed) return helper;
  // PowerShell 读不了 app.asar 里的文件；打包时 ps1 通过 asarUnpack 解到 app.asar.unpacked
  const script = path.join(__dirname, 'desktop-hand.ps1').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  const proc = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let buf = '';
  const waiters = [];
  const failAll = (message) => {
    while (waiters.length) waiters.shift().resolve({ ok: false, message });
  };
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      const waiter = waiters.shift();
      if (!waiter) continue;
      try { waiter.resolve(JSON.parse(line)); }
      catch (err) { waiter.resolve({ ok: false, message: `助手回包无法解析：${line.slice(0, 120)}` }); }
    }
  });
  proc.stderr.on('data', (chunk) => {
    diag.log('desktop', '操作助手报错', { message: String(chunk).slice(0, 300) });
  });
  proc.on('exit', () => {
    if (helper === proc) helper = null;
    failAll('操作助手已退出');
  });
  proc.request = (payload, timeoutMs = 15000) => new Promise((resolve) => {
    const waiter = { resolve };
    const timer = setTimeout(() => {
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      resolve({ ok: false, message: '操作助手超时' });
    }, timeoutMs);
    waiter.resolve = (v) => { clearTimeout(timer); resolve(v); };
    waiters.push(waiter);
    try { proc.stdin.write(JSON.stringify(payload) + '\n'); }
    catch (err) { waiter.resolve({ ok: false, message: err.message }); }
  });
  helper = proc;
  return proc;
}

function winInput(payload) {
  if (process.platform !== 'win32') return Promise.resolve({ ok: false, message: '桌面操作目前只支持 Windows' });
  const proc = ensureHelper();
  const job = helperQueue.then(() => proc.request(payload));
  helperQueue = job.catch(() => {});
  return job.then((res) => {
    if (!res || res.ok === false) diag.log('desktop', '操作失败', { op: payload.op, message: res && res.message });
    return res || { ok: false, message: '操作失败' };
  });
}

// 帧由 screen-text-map 在把画面交给模型时登记；后台不会再偷偷覆盖
function noteLook(frame) {
  if (!frame) return;
  lastFrame = {
    id: frame.id || '',
    at: frame.at || Date.now(),
    displayId: frame.displayId,
    originX: Number(frame.originX) || 0,
    originY: Number(frame.originY) || 0,
    width: Math.max(1, Number(frame.width) || 1),
    height: Math.max(1, Number(frame.height) || 1)
  };
}

function currentFrame() {
  return lastFrame;
}

function setAlive(on) {
  alive = !!on;
  const screenText = require('./screen-text-map');
  if (!alive) {
    busy = false;
    lastFrame = null;
    if (followTimer) { clearInterval(followTimer); followTimer = null; }
    hideCursor();
    stopHelper();
    screenText.reset();
    return false;
  }
  ensureCursor();
  if (!followTimer) followTimer = setInterval(stepFollow, FOLLOW_MS);
  stepFollow();
  return true;
}

function hold() {
  busy = true;
}

// 一轮结束解除坐标锁：下一轮重新按用户当前所在屏幕观察
function release() {
  busy = false;
  lastFrame = null;
  riskAllowedThisTurn = false;
}

function gate() {
  if (!alive) return '「AGI」没开。打开输入栏旁的开关后才能看屏幕和操作鼠标键盘。';
  return '';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function toPhysical(x, y) {
  try {
    return screen.dipToScreenPoint({ x: Math.round(x), y: Math.round(y) });
  } catch {
    return { x: Math.round(x), y: Math.round(y) };
  }
}

// 还没看过屏幕、或者画面太旧时先看一眼，保证坐标系和模型拿到的一致
async function ensureFrame() {
  if (lastFrame && Date.now() - lastFrame.at < FRAME_STALE_MS) return lastFrame;
  const screenText = require('./screen-text-map');
  await screenText.observe();
  return lastFrame;
}

function toScreen(frame, x, y) {
  const fx = Math.max(0, Math.min(frame.width - 1, Number(x) || 0));
  const fy = Math.max(0, Math.min(frame.height - 1, Number(y) || 0));
  return { x: frame.originX + fx, y: frame.originY + fy };
}

// 用户正在动鼠标时先等一等，不跟人抢；一直在动就放弃这一步
async function waitUserIdle() {
  const start = Date.now();
  let prev = screen.getCursorScreenPoint();
  while (Date.now() - start < USER_IDLE_WAIT_MS) {
    await sleep(120);
    const now = screen.getCursorScreenPoint();
    if (Math.abs(now.x - prev.x) + Math.abs(now.y - prev.y) <= 2) return true;
    prev = now;
  }
  return false;
}

async function listWindows() {
  const res = await winInput({ op: 'windows' });
  if (!res || res.ok === false || !Array.isArray(res.windows)) return null;
  return res.windows
    .filter((w) => w && w.title && Number(w.pid) !== process.pid)
    .map((w) => ({ hwnd: String(w.hwnd), title: String(w.title), proc: String(w.proc || ''), pid: Number(w.pid), fg: !!w.fg, min: !!w.min }));
}

function toDip(x, y) {
  try { return screen.screenToDipPoint({ x, y }); }
  catch { return { x, y }; }
}

// 读目标窗口（最上层、非 SimpleCode 自己）的控件，坐标换成屏幕 DIP
async function scanControls() {
  const res = await winInput({ op: 'uia_scan', selfPid: process.pid, max: 220 });
  if (!res || res.ok === false || !Array.isArray(res.items)) {
    return { ok: false, message: (res && res.message) || '读取控件失败', items: [] };
  }
  const items = [];
  for (const r of res.items) {
    if (!Array.isArray(r) || r.length < 12) continue;
    const [idx, type, name, aid, value, toggle, pats, enabled, px, py, pw, ph] = r;
    const a = toDip(Number(px), Number(py));
    const b = toDip(Number(px) + Number(pw), Number(py) + Number(ph));
    items.push({
      idx: Number(idx), type: String(type || ''), name: String(name || '').replace(/\s+/g, ' ').trim(),
      aid: String(aid || ''), value: String(value || ''), toggle: String(pats || '').includes('t') ? String(toggle || '') : '',
      pats: String(pats || ''), enabled: !!enabled,
      left: a.x, top: a.y, right: b.x, bottom: b.y
    });
  }
  return { ok: true, seq: Number(res.seq), title: String(res.title || ''), proc: String(res.proc || ''), pid: Number(res.pid), items };
}

// ---------- 危险操作确认 ----------
const RISKY_WORDS = /删除|删掉|移除|清空|卸载|格式化|发送|提交|付款|支付|购买|下单|结算|转账|注销|退出登录|覆盖|永久|重置|恢复出厂|抹掉|\b(delete|remove|send|submit|pay|purchase|buy|checkout|uninstall|format|transfer|erase|reset|wipe)\b/i;
const CHAT_APPS = /^(weixin|wechat|qq|tim|telegram|dingtalk|feishu|lark|slack|discord|teams|ms-teams|outlook|thunderbird|foxmail|whatsapp|line|skype)$/i;
let riskAllowedThisTurn = false;

function allowRiskyThisTurn() {
  riskAllowedThisTurn = true;
}

function targetAt(frame, x, y) {
  if (!frame) return '';
  const px = Number(x) || 0;
  const py = Number(y) || 0;
  const hit = (frame.controls || [])
    .filter((c) => px >= c.left && px <= c.right && py >= c.top && py <= c.bottom)
    .sort((a, b) => (a.right - a.left) * (a.bottom - a.top) - (b.right - b.left) * (b.bottom - b.top))[0];
  if (hit && hit.name) return hit.name;
  const line = (frame.lines || [])
    .map((l) => ({ l, d: Math.abs(l.x - px) / Math.max(1, l.w / 2 + 12) + Math.abs(l.y - py) / Math.max(1, l.h / 2 + 8) }))
    .filter((o) => o.d <= 2)
    .sort((a, b) => a.d - b.d)[0];
  return line ? line.l.text : '';
}

function targetProc(frame) {
  return frame && frame.target ? frame.target.proc : '';
}

// 返回需要用户确认的原因；空字符串表示直接做
function assessRisk(tool, args) {
  if (riskAllowedThisTurn) return '';
  const frame = lastObserved();
  const proc = targetProc(frame);
  const chat = CHAT_APPS.test(proc || '');
  if (tool === 'mouse_click' || tool === 'ui_act') {
    let label = '';
    if (tool === 'ui_act') {
      const c = findControl(frame, args.id);
      label = c ? c.name : '';
      if ((args.action || 'click') === 'set_text') return '';
    } else {
      label = targetAt(frame, args.x, args.y);
    }
    if (label && RISKY_WORDS.test(label)) return `要点「${label.slice(0, 40)}」${proc ? `（${proc}）` : ''}，这可能会删除、发送或付款。`;
    return '';
  }
  if (tool === 'keyboard_key') {
    const k = String(args.key || args.combo || '').toLowerCase().replace(/\s+/g, '');
    if (k === 'shift+delete' || k === 'shift+del') return '要按 Shift+Delete，会跳过回收站永久删除。';
    if (chat && /^(enter|return|ctrl\+enter|ctrl\+return|alt\+s)$/.test(k)) return `要在 ${proc} 里按 ${k}，可能会把消息发出去。`;
    return '';
  }
  if (tool === 'keyboard_type') {
    if (chat && /\n/.test(String(args.text || ''))) return `要在 ${proc} 里输入带换行的文字，换行会按回车，可能会把消息发出去。`;
    return '';
  }
  return '';
}

function findControl(frame, id) {
  const key = String(id || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  return (frame?.controls || []).find((c) => c.id === key) || null;
}

async function foregroundIsSelf() {
  const res = await winInput({ op: 'foreground' });
  return !!(res && res.ok && Number(res.pid) === process.pid);
}

// 操作完等界面稳定，再看一眼，把前后差异直接回给模型
async function afterAction(before, summary) {
  await sleep(SETTLE_MS);
  try {
    const screenText = require('./screen-text-map');
    const frame = await screenText.observe({ threshold: 0 });
    return `${summary}\n【操作后】${screenText.diffFrames(before, frame)}`;
  } catch (err) {
    return `${summary}\n【操作后】没能回看画面：${err && err.message ? err.message : err}`;
  }
}

function lastObserved() {
  try { return require('./screen-text-map').lastFrame(); } catch { return null; }
}

async function moveTo(x, y) {
  const denied = gate();
  if (denied) return denied;
  hold();
  const frame = await ensureFrame();
  const p = toScreen(frame, x, y);
  vx = p.x;
  vy = p.y;
  placeCursor(vx, vy);
  return `虚拟光标已移到画面 ${frame.id} 的 (${Math.round(Number(x) || 0)}, ${Math.round(Number(y) || 0)})。`;
}

async function clickAt(x, y, button, times) {
  const denied = gate();
  if (denied) return denied;
  hold();
  const frame = await ensureFrame();
  if (!await waitUserIdle()) return '用户正在使用鼠标，这次点击已放弃。等用户停下后再试。';
  const before = lastObserved();
  const p = toScreen(frame, x, y);
  vx = p.x;
  vy = p.y;
  placeCursor(vx, vy);
  const phys = toPhysical(p.x, p.y);
  const res = await winInput({
    op: 'click',
    x: phys.x,
    y: phys.y,
    button: button === 'right' || button === 'middle' ? button : 'left',
    times: Number(times) === 2 ? 2 : 1
  });
  if (!res || res.ok === false) return `点击失败：${(res && res.message) || '未知原因'}`;
  return afterAction(before, `已在画面 ${frame.id} 的 (${Math.round(Number(x) || 0)}, ${Math.round(Number(y) || 0)}) ${Number(times) === 2 ? '双击' : '点击'}，系统鼠标已放回原处。`);
}

function readPoints(raw) {
  let list = raw;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); }
    catch {
      list = list.split(/[;\n]/).map((part) => {
        const pair = part.split(',');
        return { x: pair[0], y: pair[1] };
      });
    }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (Array.isArray(p) && p.length >= 2) out.push({ x: Number(p[0]), y: Number(p[1]) });
    else if (p && typeof p === 'object') out.push({ x: Number(p.x), y: Number(p.y) });
  }
  return out.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

async function dragStroke(rawPoints, button) {
  const denied = gate();
  if (denied) return denied;
  const points = readPoints(rawPoints);
  if (points.length < 2) return '拖动至少需要两个图内坐标。画圆请先算出一圈采样点再传入。';
  const used = points.slice(0, 800);
  hold();
  const frame = await ensureFrame();
  if (!await waitUserIdle()) return '用户正在使用鼠标，这次拖动已放弃。等用户停下后再试。';
  const before = lastObserved();
  const screenPts = used.map((p) => toScreen(frame, p.x, p.y));
  const physical = screenPts.map((p) => toPhysical(p.x, p.y));
  vx = screenPts[0].x;
  vy = screenPts[0].y;
  placeCursor(vx, vy);
  const res = await winInput({
    op: 'drag',
    button: button === 'right' || button === 'middle' ? button : 'left',
    points: physical
  }, 60000);
  const end = screenPts[screenPts.length - 1];
  vx = end.x;
  vy = end.y;
  placeCursor(vx, vy);
  if (!res || res.ok === false) return `拖动失败：${(res && res.message) || '未知原因'}`;
  const a = used[0];
  const b = used[used.length - 1];
  const extra = points.length > used.length ? ` 只拖了前 ${used.length} 个点，剩下的请再拖一笔。` : '';
  return afterAction(before, `已在画面 ${frame.id} 按住鼠标从 (${Math.round(a.x)}, ${Math.round(a.y)}) 拖到 (${Math.round(b.x)}, ${Math.round(b.y)})，共 ${used.length} 个点，然后松开。${extra}`);
}

async function scrollAt(x, y, delta) {
  const denied = gate();
  if (denied) return denied;
  hold();
  const frame = await ensureFrame();
  if (!await waitUserIdle()) return '用户正在使用鼠标，这次滚动已放弃。';
  const before = lastObserved();
  const p = toScreen(frame, x, y);
  vx = p.x;
  vy = p.y;
  placeCursor(vx, vy);
  const phys = toPhysical(p.x, p.y);
  const wheel = Math.max(-2400, Math.min(2400, Math.round(Number(delta) || -120)));
  const res = await winInput({ op: 'scroll', x: phys.x, y: phys.y, delta: wheel });
  if (!res || res.ok === false) return `滚动失败：${(res && res.message) || '未知原因'}`;
  return afterAction(before, `已在画面 ${frame.id} 的 (${Math.round(Number(x) || 0)}, ${Math.round(Number(y) || 0)}) 滚动 ${wheel}。`);
}

const SELF_FOCUS_MSG = '焦点在 SimpleCode 自己的窗口上，输入会打进聊天框。先用 window_focus 切到目标窗口，或 mouse_click 点一下目标输入框。';

async function typeText(text) {
  const denied = gate();
  if (denied) return denied;
  const value = String(text || '');
  if (!value) return '没有要输入的文字';
  hold();
  if (await foregroundIsSelf()) return SELF_FOCUS_MSG;
  const before = lastObserved();
  let res;
  if (value.length <= UNICODE_TYPE_MAX) {
    // 逐字 Unicode 输入：不碰剪贴板，中文也不经过输入法
    res = await winInput({ op: 'type', text: value }, 30000);
  } else {
    const image = clipboard.readImage();
    const previous = clipboard.readText();
    const hadImage = image && !image.isEmpty();
    clipboard.writeText(value);
    res = await winInput({ op: 'key', keys: ['ctrl', 'v'] });
    // 目标程序读剪贴板有延迟，放回太早会粘贴出旧内容
    await sleep(600);
    try {
      if (hadImage) clipboard.writeImage(image);
      else clipboard.writeText(previous || '');
    } catch { /* 剪贴板被占用时不挡住这次输入 */ }
  }
  if (!res || res.ok === false) return `输入失败：${(res && res.message) || '未知原因'}`;
  return afterAction(before, `已向前台窗口输入 ${value.length} 个字符${value.length > UNICODE_TYPE_MAX ? '（经剪贴板粘贴）' : ''}。`);
}

async function tapKeys(combo) {
  const denied = gate();
  if (denied) return denied;
  const raw = String(combo || '').trim().toLowerCase();
  if (!raw) return '没有要按的键';
  const keys = raw === '+' ? ['plus'] : raw.split('+').map((s) => s.trim()).filter(Boolean);
  hold();
  const hasModifier = keys.some((k) => ['ctrl', 'control', 'alt', 'win', 'meta', 'cmd', 'super'].includes(k));
  if (!hasModifier && await foregroundIsSelf()) return SELF_FOCUS_MSG;
  const before = lastObserved();
  const res = await winInput({ op: 'key', keys });
  if (!res || res.ok === false) return `按键失败：${(res && res.message) || '未知原因'}（支持 enter/tab/esc/f1-f24/方向键/单个字符，组合用 + 连接）`;
  return afterAction(before, `已按下 ${keys.join('+')}。`);
}

async function windowList() {
  const denied = gate();
  if (denied) return denied;
  const list = await listWindows();
  if (!list) return '读取窗口列表失败';
  if (!list.length) return '没有可切换的窗口';
  return list.slice(0, 40).map((w) => `${w.fg ? '★ ' : ''}${w.title}（${w.proc}${w.min ? '，已最小化' : ''}）`).join('\n');
}

// 系统语言是英文时窗口标题也是英文，用中文俗名也要能切过去
const APP_ALIAS = {
  记事本: ['notepad'], 画图: ['mspaint'], 计算器: ['calculatorapp', 'calc'], 资源管理器: ['explorer'],
  文件管理器: ['explorer'], 浏览器: ['msedge', 'chrome', 'firefox'], 谷歌浏览器: ['chrome'], edge: ['msedge'],
  微信: ['weixin', 'wechat'], qq: ['qq'], 钉钉: ['dingtalk'], 飞书: ['feishu', 'lark'], 终端: ['windowsterminal', 'cmd', 'powershell'],
  命令行: ['windowsterminal', 'cmd'], 设置: ['systemsettings'], 任务管理器: ['taskmgr'], 记事: ['notepad'],
  word: ['winword'], excel: ['excel'], ppt: ['powerpnt'], powerpoint: ['powerpnt'], 截图: ['snippingtool']
};

async function windowFocus(title) {
  const denied = gate();
  if (denied) return denied;
  const want = String(title || '').trim().toLowerCase();
  if (!want) return '需要窗口标题或程序名';
  hold();
  const list = await listWindows();
  if (!list) return '读取窗口列表失败';
  const alias = APP_ALIAS[want] || [];
  const hit = list.find((w) => w.title.toLowerCase() === want) ||
    list.find((w) => w.title.toLowerCase().includes(want)) ||
    list.find((w) => w.proc.toLowerCase() === want.replace(/\.exe$/, '')) ||
    list.find((w) => alias.includes(w.proc.toLowerCase()));
  if (!hit) return `没找到标题含「${title}」的窗口。现有窗口：\n${list.slice(0, 20).map((w) => `${w.title}（${w.proc}）`).join('\n')}`;
  const before = lastObserved();
  const res = await winInput({ op: 'focus', hwnd: hit.hwnd });
  if (!res || res.ok === false) return `切换到「${hit.title}」被系统拒绝，可以改用 mouse_click 点一下那个窗口。`;
  return afterAction(before, `已切到窗口「${hit.title}」（${hit.proc}）。`);
}

const TYPE_ZH = {
  Button: '按钮', SplitButton: '按钮', MenuItem: '菜单项', Edit: '输入框', Document: '文档区', CheckBox: '复选框',
  RadioButton: '单选', ComboBox: '下拉框', ListItem: '列表项', TabItem: '标签页', Hyperlink: '链接', TreeItem: '树节点',
  Slider: '滑块', Spinner: '数字框', DataItem: '数据项'
};

function controlLabel(c) {
  return `[${c.id}] ${TYPE_ZH[c.type] || c.type} "${c.name || c.aid || '无名'}"`;
}

// 按控件编号直接操作（UI 自动化），比按坐标点准；控件不支持时退回点它的中心
async function uiAct(id, action, text) {
  const denied = gate();
  if (denied) return denied;
  hold();
  const frame = lastObserved();
  const c = findControl(frame, id);
  if (!c) return `没有控件 ${id}。用最新【屏幕文字】里的 [c编号]，或者先 screen_read 重新读一次。`;
  if (!c.enabled) return `${controlLabel(c)} 现在是灰的（不可用），先完成前面的步骤。`;
  const act = String(action || 'click').toLowerCase();
  if (act === 'double_click') return clickAt(c.x, c.y, 'left', 2);
  if (act === 'right_click') return clickAt(c.x, c.y, 'right', 1);
  const before = frame;
  if (act === 'set_text') {
    const value = String(text || '');
    const res = await winInput({ op: 'uia_act', seq: c.seq, idx: c.idx, action: 'set_text', text: value });
    if (res && res.ok) return afterAction(before, `已把 ${controlLabel(c)} 的内容设为 ${value.length} 个字符。`);
    // 不支持直接写值：点进去、全选、再逐字输入
    if (!await waitUserIdle()) return '用户正在使用鼠标，这一步已放弃。';
    const p = toPhysical(frame.originX + c.x, frame.originY + c.y);
    await winInput({ op: 'click', x: p.x, y: p.y, button: 'left', times: 1 });
    await winInput({ op: 'key', keys: ['ctrl', 'a'] });
    const typed = await winInput({ op: 'type', text: value }, 30000);
    if (!typed || typed.ok === false) return `输入失败：${(typed && typed.message) || '未知原因'}`;
    return afterAction(before, `${controlLabel(c)} 不支持直接写值，已点进去全选后输入 ${value.length} 个字符。`);
  }
  const allowed = ['click', 'toggle', 'select', 'expand', 'collapse', 'focus'];
  if (!allowed.includes(act)) return `不支持的操作 ${act}。可用：click、double_click、right_click、toggle、select、expand、collapse、focus、set_text。`;
  const res = await winInput({ op: 'uia_act', seq: c.seq, idx: c.idx, action: act });
  if (res && res.ok) {
    const verb = { click: '操作', toggle: '切换', select: '选中', expand: '展开', collapse: '收起', focus: '聚焦' }[act];
    return afterAction(before, `已${verb} ${controlLabel(c)}。`);
  }
  if (act !== 'click') return `${controlLabel(c)} 不支持 ${act}（${(res && res.message) || '未知原因'}）。可以改用 click。`;
  const clicked = await clickAt(c.x, c.y, 'left', 1);
  return `${controlLabel(c)} 不支持直接触发，改为点它的中心。\n${clicked}`;
}

function displayForCapture() {
  try { return require('./screen-text-map').pickDisplay(); }
  catch { return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay(); }
}

function pruneSight(dir) {
  const files = fs.readdirSync(dir)
    .filter((name) => name.toLowerCase().endsWith('.png'))
    .map((name) => {
      const abs = path.join(dir, name);
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch { mtime = 0; }
      return { abs, mtime };
    })
    .sort((a, b) => a.mtime - b.mtime);
  while (files.length > SIGHT_MAX) {
    const old = files.shift();
    try { fs.unlinkSync(old.abs); } catch { /* 删不掉就留到下次 */ }
  }
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function captionFromVision(text) {
  const line = String(text || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('【') && !s.startsWith('看图失败') && !s.includes('没有可用的看图模型'));
  const raw = (line || '画面').replace(/[\\/:*?"<>|\r\n]/g, '').replace(/\s+/g, '').slice(0, 16);
  return raw || '画面';
}

function nameSightFile(abs, visionText) {
  const dir = path.dirname(abs);
  const next = path.join(dir, `${stamp()}-${captionFromVision(visionText)}.png`);
  try {
    if (path.resolve(abs) !== path.resolve(next)) fs.renameSync(abs, next);
  } catch {
    return abs;
  }
  pruneSight(dir);
  return next;
}

async function captureScreen() {
  const denied = gate();
  if (denied) return { ok: false, message: denied };
  hold();
  const screenText = require('./screen-text-map');
  let shot;
  try { shot = await screenText.captureDisplay(displayForCapture(), 4096); }
  catch (err) { return { ok: false, message: err && err.message ? err.message : '没有截到屏幕' }; }
  const dir = sightDir();
  const abs = path.join(dir, `${stamp()}-画面.png`);
  fs.writeFileSync(abs, shot.image.toPNG());
  pruneSight(dir);
  // 同一块屏幕顺带做一次文字识别，让看图结果和可点击坐标对得上同一帧
  let frame = null;
  try { frame = await screenText.observe({ force: true }); } catch (err) {
    return { ok: false, message: `本地 OCR 识别失败：${err && err.message ? err.message : err}` };
  }
  return {
    ok: true,
    path: abs,
    width: shot.dipWidth,
    height: shot.dipHeight,
    originX: shot.originX,
    originY: shot.originY,
    frameId: frame ? frame.id : '',
    text: frame ? screenText.formatBlock(frame) : '【屏幕文字】本地 OCR 未能返回识别结果。'
  };
}

function importClipboardImage() {
  const denied = gate();
  if (denied) return { ok: false, message: denied };
  hold();
  const image = clipboard.readImage();
  if (!image || image.isEmpty()) return { ok: false, message: '剪贴板里没有图片' };
  const dir = sightDir();
  const abs = path.join(dir, `${stamp()}-剪贴板.png`);
  fs.writeFileSync(abs, image.toPNG());
  pruneSight(dir);
  return { ok: true, path: abs, width: image.getSize().width, height: image.getSize().height };
}

module.exports = {
  isAlive, isBusy, setAlive, hold, release, noteLook, currentFrame, listWindows, scanControls,
  assessRisk, allowRiskyThisTurn, controlLabel, TYPE_ZH,
  moveTo, clickAt, dragStroke, scrollAt, typeText, tapKeys, windowList, windowFocus, uiAct,
  captureScreen, importClipboardImage, nameSightFile
};
