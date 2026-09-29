window.__APP_BUILD = 'v20260922d'; // 渲染层构建标记：用于诊断页面加载的是否为当前磁盘代码
import { t, setLocale, applyDom, getLocale, isNewChatTitle } from './i18n.js';
import { renderMarkdown } from './markdown.js';

const api = window.simple || window.sinpo;

// 界面层异常统一上报主进程写入诊断日志，闪退后可回溯
window.addEventListener('error', (e) => {
  api.reportError?.('界面脚本报错', {
    message: e.message,
    source: e.filename,
    line: e.lineno,
    stack: e.error && e.error.stack
  });
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  api.reportError?.('界面未处理的 Promise 拒绝', {
    message: r && (r.message || String(r)),
    stack: r && r.stack
  });
});

const state = {
  themePref: 'system',
  theme: 'light',
  autoSave: true,
  recents: [],
  models: [],
  currentModelId: '',
  localFiles: [],
  modelsDir: '',
  searchSites: [],
  providers: [],
  proxy: '',
  commandSandbox: { enabled: true, timeoutSec: 60 },
  maxAgentRounds: 16,
  desktopAlive: false,
  capabilityDefaults: {},
  assemblies: {},
  assemblyKey: '',
  snapshotMax: 20,
  workspace: '',
  skills: [],
  rules: [],
  persona: '',
  snapshots: [],
  sessions: [],
  tabs: [],
  activeTab: null,
  attachments: [],
  contextPaths: [],
  skillId: null,
  skillIds: [],
  sending: false,
  aborting: false,
  queue: [],
  liveAssistant: null,
  refillFromIndex: null,
  refillRevertFiles: false,
  sidebar: false,
  fileTree: true,
  treeCache: {},
  treeOpen: new Set(),
  previewPath: '',
  ctxRel: '',
  ctxJustOpened: false,
  livePaintTimer: null,
  typewriterRaf: null,
  milestones: [],
  memories: [],
  globalMemory: null,
  dl: { taskId: null, purpose: null },
  downloads: [],
  downloadPanelFolded: true,
  downloadThreads: 4
};

function $(id) { return document.getElementById(id); }
function uid() { return `s_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`; }

function clampAgentRounds(n) {
  if (n == null || n === '') return Math.max(1, Math.min(64, Number(state.maxAgentRounds) || 16));
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return Math.max(1, Math.min(64, Number(state.maxAgentRounds) || 16));
  return Math.max(1, Math.min(64, v));
}

function roundsOf(tab) {
  if (tab && tab.maxAgentRounds != null) return clampAgentRounds(tab.maxAgentRounds);
  return clampAgentRounds(state.maxAgentRounds);
}

function syncRoundsInput(tab) {
  const el = $('input-rounds');
  const current = tab || activeSession();
  if (el) el.value = String(roundsOf(current));
  const btn = $('btn-unlimited');
  const on = !!(current && current.unlimitedRounds);
  if (btn) {
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  const wrap = $('rounds-wrap');
  if (wrap) wrap.classList.toggle('off', on);
}

function applyTheme(resolved) {
  state.theme = resolved;
  document.documentElement.setAttribute('data-theme', resolved);
  $('status-theme').textContent = t(resolved === 'dark' ? 'themeDark' : 'themeLight');
}

function currentModel() {
  return state.models.find((m) => m.id === state.currentModelId) || state.models[0];
}

function providerById(id) {
  return (state.providers || []).find((p) => p.id === id) || null;
}

function providerNameOf(m) {
  if (!m) return '';
  if (m.providerId) return providerById(m.providerId)?.name || m.providerId;
  return m.name || m.baseUrl || '';
}

async function persistModels(currentId) {
  if (currentId) state.currentModelId = currentId;
  const r = await api.saveModels(state.models, state.currentModelId, state.providers);
  if (r?.models) state.models = r.models;
  if (r?.providers) state.providers = r.providers;
  if (r?.currentModelId) state.currentModelId = r.currentModelId;
  refreshQuotaBar();
}

const quotaMem = { key: '', at: 0, payload: null, seq: 0 };

function formatQuotaMoney(n, currency) {
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const c = String(currency || '').toUpperCase();
  if (c === 'CREDITS') {
    if (abs >= 1e6) return `${(n / 1e6).toFixed(3)}M`;
    if (abs >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(Math.round(n));
  }
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  const body = n.toFixed(digits);
  if (c === 'CNY' || c === 'RMB') return `¥${body}`;
  return `$${body}`;
}

function currentQuotaKey() {
  const m = currentModel();
  if (!m) return '';
  if (m.type === 'local' || m.id === 'local-gguf') return '';
  if (m.type === 'zbaingAi' || m.id === 'zbaingAi') return '';
  return m.providerId || m.id || '';
}

function quotaCanShow(b) {
  return !!(b && b.available && Number.isFinite(b.used) && Number.isFinite(b.total) && b.total > 0);
}

function walletSnapshotOf(p) {
  const w = p?.wallet;
  if (!w || !(Number(w.remainingStart) > 0)) return null;
  const remaining = Math.max(0, Number(w.remainingStart) - Number(w.spent || 0));
  return {
    available: true,
    source: 'manual',
    providerId: p.id,
    used: Number(w.spent || 0),
    remaining,
    total: Number(w.remainingStart),
    currency: String(w.unit || '').toUpperCase() === 'CREDITS' ? 'CREDITS' : 'USD',
    tokensIn: Number(w.tokensIn) || 0,
    tokensOut: Number(w.tokensOut) || 0
  };
}

function paintQuotaBar(b) {
  const bar = $('quota-bar');
  const name = $('title-app-name');
  const text = $('quota-text');
  if (!bar || !name) return;
  if (!quotaCanShow(b)) {
    bar.hidden = true;
    name.hidden = false;
    return;
  }
  name.hidden = true;
  bar.hidden = false;
  bar.removeAttribute('title');
  if (text) text.textContent = t('quotaRemain', {
    remain: formatQuotaMoney(b.remaining, b.currency)
  });
}

async function refreshQuotaBar(force) {
  const key = currentQuotaKey();
  if (!key) {
    quotaMem.key = '';
    quotaMem.payload = null;
    paintQuotaBar(null);
    return;
  }
  const p = providerById(key);
  const manual = walletSnapshotOf(p);
  if (manual) {
    quotaMem.key = key;
    quotaMem.at = Date.now();
    quotaMem.payload = manual;
    paintQuotaBar(manual);
    return;
  }
  const now = Date.now();
  if (!force && quotaMem.key === key && now - quotaMem.at < 60000) {
    paintQuotaBar(quotaMem.payload);
    return;
  }
  const seq = ++quotaMem.seq;
  try {
    const r = await api.fetchAccountBalance(key);
    if (seq !== quotaMem.seq) return;
    const payload = quotaCanShow(r) ? r : null;
    quotaMem.key = key;
    quotaMem.at = Date.now();
    quotaMem.payload = payload;
    paintQuotaBar(payload);
  } catch {
    if (seq !== quotaMem.seq) return;
    quotaMem.key = key;
    quotaMem.at = Date.now();
    quotaMem.payload = null;
    paintQuotaBar(null);
  }
}

function ingestProviderBalance(providerId, balance) {
  const key = currentQuotaKey();
  if (!providerId || providerId !== key) return;
  if (walletSnapshotOf(providerById(key))) return;
  const payload = quotaCanShow(balance) ? balance : null;
  quotaMem.key = key;
  quotaMem.at = Date.now();
  quotaMem.payload = payload;
  paintQuotaBar(payload);
}

function applyWalletSnapshot(ev) {
  const pid = ev.providerId;
  const p = pid ? providerById(pid) : providerById(currentQuotaKey());
  if (p) {
    p.wallet = {
      ...(p.wallet || {}),
      remainingStart: ev.total,
      spent: ev.used,
      unit: ev.currency === 'CREDITS' ? 'CREDITS' : 'USD',
      tokensIn: Number(ev.tokensIn) || 0,
      tokensOut: Number(ev.tokensOut) || 0
    };
  }
  paintQuotaBar(quotaCanShow(ev) ? ev : walletSnapshotOf(p));
}

function syncAgentBtn() {
  const btn = $('btn-agent');
  if (!btn) return;
  const names = skillStack().map((id) => {
    const s = uniqueSkills().find((x) => x.id === id);
    return s ? `/${s.name}` : `/${id}`;
  });
  btn.textContent = names.length ? `∞ ${names.join(' + ')}` : `∞ ${t('noSkillSelected')}`;
}

function modelNameOf(id) {
  if (!id) return '';
  const m = state.models.find((x) => x.id === id);
  if (!m) return id;
  const name = m.name || m.model || id;
  const sub = m.model && m.model !== name ? m.model : '';
  return sub ? `${name} · ${sub}` : name;
}

function modelLabel() {
  const m = currentModel();
  if (!m) return t('noModel');
  const name = m.name || m.model || m.id || t('model');
  const sub = m.model && m.model !== name ? m.model : '';
  return sub ? `${name} · ${sub}` : name;
}

function setWorkspace(dir) {
  state.workspace = dir || '';
  $('status-ws').textContent = dir || t('noWorkspace');
  $('status-model').textContent = modelLabel();
}

/** 切换语言后刷新动态生成的界面，静态节点走 applyDom */
function applyLocaleUi() {
  applyDom();
  for (const tab of state.tabs) {
    if (isNewChatTitle(tab.title)) tab.title = t('newChat');
  }
  setWorkspace(state.workspace);
  renderRecents();
  renderModelMenu();
  renderSidebar();
  renderTabs();
  renderMessages(true);
  loadFileTree();
  if (state.previewPath) $('preview-path').textContent = state.previewPath;
  syncSendBtn();
  syncAgentBtn();
  renderClipPanel();
  paintQuotaBar(quotaMem.payload);
}

function showWelcome() {
  $('view-welcome').classList.remove('hidden');
  $('view-chat').classList.add('hidden');
}

function showChat() {
  $('view-welcome').classList.add('hidden');
  $('view-chat').classList.remove('hidden');
}

function closeMenus() {
  if (state.ctxJustOpened) return;
  document.querySelectorAll('.menu').forEach((m) => m.classList.remove('open'));
  $('model-menu').classList.remove('show');
  $('slash-menu').classList.add('hidden');
  $('at-menu').classList.add('hidden');
  hideCtxMenu();
}

function hideCtxMenu() {
  const el = $('ctx-menu');
  if (el) el.classList.add('hidden');
}

function showFileCtx(e, rel) {
  const filePath = String(rel || '').replace(/\\/g, '/');
  if (!filePath) return;
  e.preventDefault();
  e.stopPropagation();
  state.ctxRel = filePath;
  state.ctxJustOpened = true;
  const menu = $('ctx-menu');
  menu.classList.remove('hidden');
  const x = Math.min(e.clientX, window.innerWidth - 200);
  const y = Math.min(e.clientY, window.innerHeight - 48);
  menu.style.left = `${x}px`;
  menu.style.top = `${y}px`;
  setTimeout(() => { state.ctxJustOpened = false; }, 400);
}

async function revealInFolder(rel) {
  hideCtxMenu();
  try {
    await api.showInFolder(rel);
  } catch (err) {
    alert(err.message || err);
  }
}

function renderRecents(all = false) {
  const list = all ? state.recents : state.recents.slice(0, 5);
  $('recent-list').innerHTML = list.length
    ? list.map((r) => `<div class="recent-item" data-path="${encodeURIComponent(r.path)}"><span>${escapeHtml(r.name)}</span><span class="path">${escapeHtml(r.path)}</span></div>`).join('')
    : `<div class="hint">${t('noRecents')}</div>`;
  const menu = $('menu-recent');
  menu.innerHTML = state.recents.length
    ? state.recents.map((r) => `<button data-act="open-path" data-path="${encodeURIComponent(r.path)}">${escapeHtml(r.name)}</button>`).join('')
    : `<button disabled>${t('noRecords')}</button>`;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// 焦点还在即将被藏起来的控件上时，Windows 会把键盘一起丢掉。先交回输入框，再让窗口拿回键盘。
function focusInside(root) {
  const ae = document.activeElement;
  if (!root || !ae || ae === document.body || ae === document.documentElement) return false;
  return ae === root || root.contains(ae);
}
function releaseFocus(root) {
  if (!focusInside(root)) return false;
  try { document.activeElement.blur(); } catch { /* 控件已卸下 */ }
  return true;
}
function focusComposer() {
  const input = $('input');
  const chatOpen = $('view-chat') && !$('view-chat').classList.contains('hidden');
  const modal = $('modal');
  const modalOpen = modal && !modal.classList.contains('hidden') && modal.classList.contains('is-open');
  const lb = $('lightbox');
  const lbOpen = lb && !lb.classList.contains('hidden') && lb.classList.contains('is-open');
  if (chatOpen && input && !modalOpen && !lbOpen) {
    try { input.focus({ preventScroll: true }); } catch { try { input.focus(); } catch { /* 输入框尚未挂上 */ } }
  }
  api.focusWindow?.();
}
window.__releaseFocus = releaseFocus;
window.__focusComposer = focusComposer;
// 开关面板的按钮不要抢走输入框焦点
function dontStealFocus(el) {
  el?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
  });
}

function openModal(html) {
  const modal = $('modal');
  const card = $('modal-card');
  // 模型组合弹窗关闭是延迟 200ms 隐藏的，打开新弹窗前先取消这个定时器，
  // 否则旧定时器会把刚打开的新弹窗一起隐藏
  if (modal.__closeTimer) {
    clearTimeout(modal.__closeTimer);
    modal.__closeTimer = null;
  }
  card.classList.remove('wide', 'settings-modal', 'vs-card');
  card.onclick = null;
  card.innerHTML = html;
  modal.classList.remove('hidden');
  modal.classList.remove('is-open');
  void modal.offsetWidth;
  requestAnimationFrame(() => modal.classList.add('is-open'));
}
function closeModal() {
  const modal = $('modal');
  releaseFocus(modal);
  modal.classList.remove('is-open');
  modal.classList.add('hidden');
  focusComposer();
}

async function openProject(dir) {
  await persistSession();
  const ws = dir ? await api.setWorkspace(dir) : await api.openProject();
  if (!ws) return;
  setWorkspace(ws);
  await refreshMeta();
  const existing = state.tabs.find((t) => sameWorkspace(t.workspace, ws));
  if (existing) {
    state.activeTab = existing.id;
    applyTabContext(existing);
  } else {
    await restoreLastSession(ws);
    if (!state.tabs.some((t) => t.id === state.activeTab && sameWorkspace(t.workspace, ws))) {
      newTab();
    }
  }
  showChat();
  renderTabs();
  renderMessages(true);
  renderQueue();
  syncSendBtn();
}

async function refreshMeta() {
  state.skills = await api.listSkills();
  state.rules = await api.listRules();
  state.snapshots = await api.listSnapshots();
  try {
    state.milestones = state.workspace ? (await api.listMilestones()) : [];
  } catch {
    state.milestones = [];
  }
  try {
    state.memories = state.workspace ? (await api.listMemory()) : [];
  } catch {
    state.memories = [];
  }
  try {
    state.globalMemory = await api.getGlobalMemory();
  } catch {
    state.globalMemory = null;
  }
  try {
    state.snapshotMax = await api.getSnapshotMax();
  } catch { /* 未开项目时用默认 */ }
  renderSidebar();
  await loadFileTree();
  syncAgentBtn();
}

function activeSession() {
  return state.tabs.find((t) => t.id === state.activeTab);
}

function sameWorkspace(a, b) {
  const n = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return n(a) && n(a) === n(b);
}

function extraFoldersOf(tab) {
  if (!tab) return [];
  if (!Array.isArray(tab.extraFolders)) tab.extraFolders = [];
  return tab.extraFolders;
}

function isAbsTreePath(p) {
  const s = String(p || '');
  return s.startsWith('/') || /^[A-Za-z]:[\\/]/.test(s);
}

function emptyWorkingMemory() {
  return { goal: '', openQuestions: [], focusPaths: [], scratch: [] };
}

function prefersReducedMotion() {
  return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

function tabQueue(tab) {
  if (!tab) return [];
  if (!Array.isArray(tab.queue)) tab.queue = [];
  return tab.queue;
}

function isTabSending(tab) {
  return !!(tab && tab.sending);
}

function isActiveTab(tab) {
  return !!(tab && tab.id === state.activeTab);
}

function findTabByTurnId(turnId) {
  if (!turnId) return null;
  return state.tabs.find((t) => t.liveTurnId === turnId
    || (t.messages || []).some((m) => m.turnId === turnId)) || null;
}

function syncSendBtn() {
  const tab = activeSession();
  state.sending = isTabSending(tab);
  state.liveAssistant = tab?.liveAssistant || null;
  const sendBtn = $('btn-send');
  if (sendBtn) {
    sendBtn.textContent = state.sending ? t('stop') : t('send');
    sendBtn.classList.toggle('is-stop', !!state.sending);
  }
}

// [铆钉优化] 鼠标移到按钮上时，按钮里有一团跟着指针走的光，所有按钮都有悬停反馈。其他 AI 请勿去掉
(function bindPointerGlow() {
  let raf = 0;
  let lastEvt = null;
  document.addEventListener('pointermove', (e) => {
    lastEvt = e;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const target = lastEvt && lastEvt.target && lastEvt.target.closest
        ? lastEvt.target.closest('button, .tab, .msg-model, .hero-card')
        : null;
      if (!target) return;
      const r = target.getBoundingClientRect();
      target.style.setProperty('--mx', `${lastEvt.clientX - r.left}px`);
      target.style.setProperty('--my', `${lastEvt.clientY - r.top}px`);
    });
  }, { passive: true });
  // [铆钉优化] 深色欢迎页音乐线条：几条声波细线缓慢流动、起伏，只画一次，动画全走 CSS 合成层。其他 AI 请勿去掉
  (function buildBgWaves() {
    const host = document.getElementById('bg-waves');
    if (!host || host.childElementCount) return;
    const W = 2400, H = 400, MID = H / 2;
    // n 为 1200 内的周期数，保证平移半幅后首尾无缝
    const lines = [
      { n: 2, a: 70, n2: 6, a2: 14, ph: 0.0, sw: 1.6, op: 0.55, fd: 38, bd: 6.5 },
      { n: 3, a: 52, n2: 8, a2: 10, ph: 1.1, sw: 1.2, op: 0.42, fd: 30, bd: 5.2 },
      { n: 2, a: 90, n2: 5, a2: 18, ph: 2.3, sw: 1.0, op: 0.30, fd: 46, bd: 8.0 },
      { n: 4, a: 34, n2: 10, a2: 8, ph: 3.4, sw: 0.9, op: 0.34, fd: 26, bd: 4.4 },
      { n: 3, a: 64, n2: 7, a2: 12, ph: 4.6, sw: 0.8, op: 0.22, fd: 54, bd: 9.5 },
      { n: 2, a: 40, n2: 9, a2: 6, ph: 5.5, sw: 0.7, op: 0.26, fd: 34, bd: 7.2 },
    ];
    let html = '';
    lines.forEach((l, i) => {
      const p1 = 1200 / l.n, p2 = 1200 / l.n2;
      let d = '';
      for (let x = 0; x <= W; x += 8) {
        const y = MID + l.a * Math.sin((2 * Math.PI * x) / p1 + l.ph) + l.a2 * Math.sin((2 * Math.PI * x) / p2 + l.ph * 1.7);
        d += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1);
      }
      const gid = `bgw-g${i}`;
      html += `<div class="bg-wave" style="--fd:${l.fd}s;--bd:${l.bd}s;--dl:-${(i * 1.3).toFixed(1)}s">`
        + `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">`
        + `<defs><linearGradient id="${gid}" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="1200" y2="0" spreadMethod="repeat">`
        + `<stop offset="0" class="s1"/><stop offset="0.35" class="s2"/><stop offset="0.7" class="s3"/><stop offset="1" class="s1"/>`
        + `</linearGradient></defs>`
        + `<path d="${d}" stroke="url(#${gid})" stroke-width="${l.sw}" opacity="${l.op}"/></svg></div>`;
    });
    host.innerHTML = html;
  })();
  // [铆钉优化] 电路板背景：按窗口尺寸生成走线、总线、焊盘、过孔和芯片封装，固定种子保证每次一样；
  // 欢迎页有信号脉冲沿走线流动，对话页只留静态走线。颜色全由 CSS 控制。其他 AI 请勿去掉
  (function bindPcbBackground() {
    const host = document.getElementById('bg-pcb');
    if (!host) return;
    const G = 24;
    const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
    function draw() {
      const W = window.innerWidth, H = window.innerHeight;
      const cols = Math.ceil(W / G) + 1, rows = Math.ceil(H / G) + 1;
      let seed = 20260928;
      const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
      const ri = (a, b) => a + Math.floor(rnd() * (b - a + 1));
      const used = new Set();
      const key = (x, y) => x + ',' + y;
      const inside = (x, y) => x >= 1 && y >= 1 && x < cols - 1 && y < rows - 1;
      const px = (v) => v * G;
      const pathOf = (pts) => pts.map((p, i) => (i ? 'L' : 'M') + px(p[0]) + ' ' + px(p[1])).join('');
      let traces = '', pads = '', sigs = '', chips = '';
      const pad = (x, y) => { pads += `<circle class="pcb-pad" cx="${px(x)}" cy="${px(y)}" r="3.2"/>`; };
      const via = (x, y) => { pads += `<circle class="pcb-via" cx="${px(x)}" cy="${px(y)}" r="4.2"/>`; };
      const long = [];

      // 芯片封装：矩形本体 + 两侧引脚，引脚向外拉出短走线
      const chipCount = Math.max(2, Math.round((cols * rows) / 900));
      for (let c = 0; c < chipCount; c++) {
        const w = ri(3, 5), h = ri(2, 3);
        const x0 = ri(2, cols - w - 3), y0 = ri(2, rows - h - 3);
        let clash = false;
        for (let x = x0 - 2; x <= x0 + w + 2 && !clash; x++) for (let y = y0 - 2; y <= y0 + h + 2; y++) if (used.has(key(x, y))) { clash = true; break; }
        if (clash) continue;
        for (let x = x0 - 2; x <= x0 + w + 2; x++) for (let y = y0; y <= y0 + h; y++) used.add(key(x, y));
        chips += `<rect class="pcb-ic" x="${px(x0)}" y="${px(y0)}" width="${px(w)}" height="${px(h)}" rx="3"/>`;
        chips += `<circle class="pcb-ic-dot" cx="${px(x0) + 7}" cy="${px(y0) + 7}" r="2"/>`;
        for (let y = y0 + 0.5; y < y0 + h; y += 0.5) {
          chips += `<path class="pcb-pin" d="M${px(x0) - 7} ${px(y)}H${px(x0)}M${px(x0 + w)} ${px(y)}H${px(x0 + w) + 7}"/>`;
        }
      }

      // 总线：3~5 根平行线，走一段后 45° 倒角转弯
      const busCount = Math.max(3, Math.round((cols * rows) / 450));
      for (let b = 0; b < busCount; b++) {
        const n = ri(3, 5), a = ri(6, 16), down = ri(3, 10);
        const x0 = ri(1, cols - a - n - 2), y0 = ri(1, rows - n - down - 2);
        let ok = true;
        for (let i = 0; i < n && ok; i++) for (let x = x0; x <= x0 + a + n; x++) if (used.has(key(x, y0 + i))) { ok = false; break; }
        if (!ok) continue;
        for (let i = 0; i < n; i++) {
          const yi = y0 + i, xt = x0 + a + (n - 1 - i);
          const pts = [[x0, yi], [xt - 1, yi], [xt, yi + 1], [xt, y0 + n + down]];
          for (let x = x0; x <= xt; x++) used.add(key(x, yi));
          for (let y = yi; y <= y0 + n + down; y++) used.add(key(xt, y));
          traces += `<path class="pcb-tr" d="${pathOf(pts)}"/>`;
          pad(x0, yi); via(xt, y0 + n + down);
          long.push(pts);
        }
      }

      // 散走线：正交为主、45° 拐弯，端点焊盘或过孔
      const traceCount = Math.round((cols * rows) / 20);
      for (let t = 0; t < traceCount; t++) {
        let x = ri(1, cols - 2), y = ri(1, rows - 2);
        if (used.has(key(x, y))) continue;
        let d = ri(0, 3) * 2;
        const pts = [[x, y]];
        let cells = 0;
        used.add(key(x, y));
        const segs = ri(2, 6);
        for (let s = 0; s < segs; s++) {
          const len = ri(1, 5);
          let moved = 0;
          for (let k = 0; k < len; k++) {
            const nx = x + DIRS[d][0], ny = y + DIRS[d][1];
            if (!inside(nx, ny) || used.has(key(nx, ny))) break;
            x = nx; y = ny; used.add(key(x, y)); moved++; cells++;
          }
          if (!moved) break;
          pts.push([x, y]);
          d = d % 2 ? (d + (rnd() < 0.5 ? 1 : 7)) % 8 : (rnd() < 0.55 ? (d + (rnd() < 0.5 ? 1 : 7)) % 8 : d);
        }
        if (cells < 3) continue;
        traces += `<path class="pcb-tr" d="${pathOf(pts)}"/>`;
        pad(pts[0][0], pts[0][1]);
        rnd() < 0.5 ? via(x, y) : pad(x, y);
        if (cells >= 8) long.push(pts);
      }

      // 信号脉冲：挑几条长走线，一小段亮光沿线流动
      // pathLength=100：虚线按每条走线自身长度归一，光点始终在线上跑
      long.sort(() => rnd() - 0.5).slice(0, 14).forEach((pts, i) => {
        sigs += `<path class="pcb-sig" pathLength="100" style="--sd:${(2.6 + (i % 5) * 0.6).toFixed(1)}s;--sl:-${(i * 0.9).toFixed(1)}s" d="${pathOf(pts)}"/>`;
      });

      host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">`
        + `<g class="pcb-traces">${traces}</g><g>${chips}</g><g>${pads}</g><g class="pcb-sigs">${sigs}</g></svg>`;
    }
    let timer = 0;
    window.addEventListener('resize', () => { clearTimeout(timer); timer = setTimeout(draw, 160); });
    draw();
  })();
  // [铆钉优化] 按下任何按钮都有一圈光波扩散。其他 AI 请勿去掉
  document.addEventListener('pointerdown', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('button:not(:disabled), .tab, .msg-model') : null;
    if (!btn) return;
    btn.classList.remove('fx-press');
    void btn.offsetWidth;
    btn.classList.add('fx-press');
  }, { passive: true });
  document.addEventListener('animationend', (e) => {
    if (e.animationName === 'fx-press-wave' && e.target && e.target.classList) e.target.classList.remove('fx-press');
  });
})();

function abortTab(tab) {
  if (!tab) return;
  tab.aborting = true;
  // [铆钉优化] 只停本标签页这一轮；没有本轮编号就不发停止，免得把同窗口其他标签页一起停掉。其他 AI 请勿改回无参 chatAbort()
  if (tab.liveTurnId) api.chatAbort(tab.liveTurnId);
  if (isActiveTab(tab)) scrollMessagesToBottom();
}

// 采集当前输入框的未发送状态（草稿），用于误关界面后恢复
function collectComposer() {
  const input = $('input');
  const text = input ? input.value : '';
  return {
    text: text || '',
    attachments: (state.attachments || []).map((x) => ({ path: x.path, name: x.name })),
    contextPaths: [...(state.contextPaths || [])],
    skillId: skillStack()[0] || null,
    skillIds: skillStack(),
  };
}

// 判断草稿是否非空（决定是否落盘）
function hasComposerContent(c) {
  return !!(c && (c.text || (c.attachments && c.attachments.length)));
}

// 输入/附件/编辑变化时防抖保存草稿（300ms）
let composerTimer = null;
function scheduleComposerSave() {
  if (composerTimer) clearTimeout(composerTimer);
  composerTimer = setTimeout(() => {
    composerTimer = null;
    const tab = activeSession();
    if (tab) persistTab(tab);
  }, 300);
}

// 当前输入框只属于正在看的这个对话。发出去或删空后必须立刻改内存，
// 否则流式保存还会把旧草稿写回磁盘，切回来又填进输入框。
function rememberComposer(tab) {
  if (!tab || tab.id !== state.activeTab) return;
  const composer = collectComposer();
  tab.composer = hasComposerContent(composer) ? composer : null;
}

function clearComposer(tab) {
  if (composerTimer) {
    clearTimeout(composerTimer);
    composerTimer = null;
  }
  if (tab) tab.composer = null;
}

// 草稿正文已经作为最后一条用户消息发出去，并且这一轮已经做完，就不再填回输入框。
// 点了停止的那一轮还要留在输入框里，方便接着改。
function composerAlreadySent(tab, text) {
  const draft = String(text || '').trim();
  if (!draft || !tab?.messages?.length) return false;
  for (let i = tab.messages.length - 1; i >= 0; i--) {
    const msg = tab.messages[i];
    if (msg.role !== 'user') continue;
    const sent = String(msg.draft?.text || msg.text || '').trim();
    if (sent !== draft) return false;
    const next = tab.messages[i + 1];
    if (!next || next.role !== 'assistant' || next.stopped) return false;
    return true;
  }
  return false;
}

// [铆钉优化] 存盘只留每条消息最近的思考步骤，并截短单步文字，避免对话文件涨到几十 MB 拖卡界面。其他 AI 请勿去掉
const SAVE_THINK_STEPS = 60;
const SAVE_THINK_CHARS = 2000;
function slimMessagesForSave(messages) {
  return (messages || []).map((m) => {
    if (!m || !Array.isArray(m.thinking) || !m.thinking.length) return m;
    const steps = m.thinking.slice(-SAVE_THINK_STEPS).map((s) => {
      const text = String(s?.text || '');
      return text.length > SAVE_THINK_CHARS ? { ...s, text: text.slice(0, SAVE_THINK_CHARS) + '…' } : s;
    });
    return { ...m, thinking: steps };
  });
}

function persistTab(tab) {
  if (!state.autoSave || !tab) return Promise.resolve();
  rememberComposer(tab);
  if (!tab.messages?.length && !tab.composer) return Promise.resolve();
  return api.saveSession({
    id: tab.id,
    title: tab.title,
    workspace: tab.workspace || state.workspace,
    extraFolders: extraFoldersOf(tab),
    messages: slimMessagesForSave(tab.messages),
    undone: tab.undone || [],
    context: tab.context || emptyContext(),
    workingMemory: tab.workingMemory || emptyWorkingMemory(),
    contextSummary: tab.contextSummary || '',
    modelId: tab.modelId || state.currentModelId,
    maxAgentRounds: tab.maxAgentRounds != null ? clampAgentRounds(tab.maxAgentRounds) : null,
    unlimitedRounds: !!tab.unlimitedRounds,
    composer: tab.composer || null,
    updatedAt: new Date().toISOString()
  });
}

// [铆钉优化] 从磁盘恢复的会话里不可能还有正在跑的轮次：残留的「进行中」一律收成「已停止」，
// 否则关掉界面再进来会一直显示「正在调用」。其他 AI 请勿删除
function settleDeadTurns(messages) {
  for (const m of messages || []) {
    if (!m || m.role !== 'assistant') continue;
    if (!m.thinkingOpen && !m.askPending) continue;
    m.thinkingOpen = false;
    m.askPending = false;
    m.ask = null;
    m.stopped = true;
    m.status = t('stopped');
    m.activeRole = null;
    m.thinkExpanded = false;
    m.typewriterDone = true;
    m.revealLen = String(m.text || '').length;
  }
  return messages || [];
}

function hydrateTab(data, fallbackWs) {
  return {
    id: data.id,
    title: data.title || t('unnamed'),
    messages: settleDeadTurns(data.messages),
    workspace: data.workspace || fallbackWs || state.workspace,
    extraFolders: Array.isArray(data.extraFolders) ? [...data.extraFolders] : [],
    undone: data.undone || [],
    // 旧会话文件可能残留图片附件，恢复时一律清空，避免图片复活（tab.context.attachments 约定为空）
    context: data.context
      ? { skillId: data.context.skillId || null, skillIds: normalizeSkillIds(data.context), contextPaths: [...(data.context.contextPaths || [])], attachments: [] }
      : emptyContext(),
    workingMemory: data.workingMemory || emptyWorkingMemory(),
    contextSummary: data.contextSummary || '',
composer: data.composer || null,
    sending: false,
    aborting: false,
    queue: [],
    liveAssistant: null,
    liveTurnId: null,
    scrollPos: null,
    refillFromIndex: null,
    refillRevertFiles: false,
    modelId: data.modelId || null,
    maxAgentRounds: data.maxAgentRounds != null ? clampAgentRounds(data.maxAgentRounds) : null,
    unlimitedRounds: !!data.unlimitedRounds
  };
}

function newTab() {
  const tab = hydrateTab({
    id: uid(),
    title: t('newChat'),
    messages: [],
    workspace: state.workspace,
    undone: [],
    context: emptyContext()
  }, state.workspace);
  tab.title = t('newChat');
  tab.modelId = state.currentModelId;
  state.tabs.push(tab);
  state.activeTab = tab.id;
  applyTabContext(tab);
}

function emptyContext() {
  return { skillId: null, skillIds: [], contextPaths: [], attachments: [] };
}

function applyTabContext(tab) {
  const ctx = tab?.context || emptyContext();
  // 这个对话还没勾过时默认 zabingsk。已经勾过的组合原样留着，不从旧会话草稿里捞
  if (tab && !Array.isArray(tab.pickedSkillIds)) tab.pickedSkillIds = ['zabingsk'];
  setSkillStack(tab?.pickedSkillIds || []);
  state.contextPaths = Array.isArray(ctx.contextPaths) ? [...ctx.contextPaths] : [];
  state.attachments = Array.isArray(ctx.attachments)
    ? ctx.attachments.filter((a) => a && a.path).map((a) => ({ path: a.path, name: a.name || String(a.path).split(/[\\/]/).pop() }))
    : [];
  // 恢复未发送草稿。已经发过的需求、以及空草稿，都不要再填回输入框
  const c = tab && tab.composer;
  const inputEl = $('input');
  if (inputEl) {
    const sameAsBox = inputEl.value.trim() && c && inputEl.value.trim() === String(c.text || '').trim();
    const stale = c && !sameAsBox && composerAlreadySent(tab, c.text);
    if (stale) tab.composer = null;
    const live = stale ? null : c;
    if (live && Array.isArray(live.attachments) && live.attachments.length) {
      state.attachments = live.attachments.filter((x) => x && x.path).map((x) => ({ path: x.path, name: x.name || String(x.path).split(/[\\/]/).pop() }));
    }
    inputEl.value = (live && live.text) || '';
    if (stale) persistTab(tab);
  }
  // 编辑态 per-tab：从 tab 自身字段恢复，避免跨消息互相覆盖
  state.refillFromIndex = (tab && tab.refillFromIndex != null) ? tab.refillFromIndex : null;
  state.refillRevertFiles = !!(tab && tab.refillRevertFiles);
  // 模型选择 per-tab：切到该 tab 时同步顶栏当前模型，确保各对话独立记住模型
  if (tab && !tab.modelId) tab.modelId = state.currentModelId;
  if (tab && tab.modelId) state.currentModelId = tab.modelId;
  renderModelMenu();
  syncRoundsInput(tab);
  renderChips();
}

async function applyTabWorkspace(tab) {
  const ws = tab?.workspace || '';
  if (!ws || sameWorkspace(ws, state.workspace)) return;
  closeCodePreview();
  const next = await api.setWorkspace(ws);
  setWorkspace(next || ws);
  await refreshMeta();
}

async function switchToTab(id) {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  const prevTab = state.tabs.find((t) => t.id === state.activeTab);
  if (prevTab && prevTab.id !== id) {
    prevTab.scrollPos = $('messages').scrollTop;
    prevTab.refillFromIndex = state.refillFromIndex != null ? state.refillFromIndex : null;
    prevTab.refillRevertFiles = !!state.refillRevertFiles;
  }
  if (state.activeTab !== id) await persistSession();
  else rememberComposer(tab);
  stopTypewriter();
  flushLivePaint();
  state.activeTab = id;
  applyTabContext(tab);
  await applyTabWorkspace(tab);
  await loadFileTree();
  renderTabs();
  renderMessages(true);
  renderQueue();
  syncSendBtn();
  if (isTabSending(tab) && tab.liveAssistant && !tab.liveAssistant.typewriterDone) ensureTypewriter();
}

async function restoreLastSession(ws) {
  const items = await api.loadSessions();
  const mine = items.filter((s) => sameWorkspace(s.workspace, ws));
  const last = mine.find((s) => (s.messageCount || 0) > 0 || s.hasComposer) || mine[0];
  if (!last) {
    if (!state.tabs.some((t) => sameWorkspace(t.workspace, ws))) newTab();
    else {
      const hit = state.tabs.find((t) => sameWorkspace(t.workspace, ws));
      if (hit) {
        state.activeTab = hit.id;
        applyTabContext(hit);
      }
    }
    return;
  }
  const existing = state.tabs.find((t) => t.id === last.id);
  if (existing) {
    state.activeTab = last.id;
    applyTabContext(existing);
    return;
  }
  try {
    const data = await api.loadSession(last.id);
    if (!data.messages?.length && !data.composer) {
      if (!state.tabs.some((t) => sameWorkspace(t.workspace, ws))) newTab();
      return;
    }
    const tab = hydrateTab(data, ws);
    state.tabs.push(tab);
    state.activeTab = data.id;
    applyTabContext(tab);
  } catch {
    if (!state.tabs.some((t) => sameWorkspace(t.workspace, ws))) newTab();
  }
}

async function refreshAfterRestore() {
  await loadFileTree();
  if (state.previewPath) {
    try { await openCodePreview(state.previewPath); } catch { /* 文件可能已删 */ }
  }
  state.snapshots = await api.listSnapshots();
  renderSidebar();
}

/**
 * 还原前的确认弹窗，把影响范围说清楚，避免误点一下就回滚
 * @param {{label?: string, createdAt?: string, changes?: Array}} snap 快照信息
 * @returns {Promise<boolean>} 用户是否确认还原
 */
function confirmRestore(snap) {
  const changes = snap?.changes || [];
  return new Promise((resolve) => {
    const list = changes.map((c) => {
      const tag = c.existed === false ? t('willDelete') : t('overwrite');
      return `<div class="file-row"><span>${escapeHtml(c.path)}</span><span class="desc">${tag}</span></div>`;
    }).join('') || `<div class="hint">${t('noSnapFiles')}</div>`;
    const time = snap?.createdAt ? ` · ${new Date(snap.createdAt).toLocaleString()}` : '';
    openModal(`<h3>${t('restoreTitle')}</h3>
      <p class="hint">${escapeHtml(snap?.label || t('autoSnap'))}${time} · ${t('filesCount', { n: changes.length })}</p>
      <div class="restore-warn">${t('restoreWarn')}</div>
      <div class="restore-files">${list}</div>
      <div class="modal-actions">
        <button id="m-cancel">${t('cancel')}</button>
        <button class="danger" id="m-confirm">${t('restoreOk')}</button>
      </div>`);
    const done = (ok) => { closeModal(); resolve(ok); };
    $('m-cancel').onclick = () => done(false);
    $('m-confirm').onclick = () => done(true);
    // 焦点落在取消上，回车不会误触发还原
    $('m-cancel').focus();
  });
}

function renderTabs() {
  $('tabs').innerHTML = state.tabs.map((tab) => `
    <button class="tab ${tab.id === state.activeTab ? 'active' : ''}${isTabSending(tab) ? ' busy' : ''}" data-id="${tab.id}" title="${t('renameTabHint')}">
      ${escapeHtml(tab.title)} <span class="x" data-close="${tab.id}">×</span>
    </button>`).join('');
}

function isImageName(name) {
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(name || '');
}

const lightbox = { scale: 1, x: 0, y: 0, dragging: false, sx: 0, sy: 0, ox: 0, oy: 0 };

function applyLightbox() {
  const img = $('lightbox-img');
  if (!img) return;
  img.style.transform = `translate(${lightbox.x}px, ${lightbox.y}px) scale(${lightbox.scale})`;
}

function openLightbox(src) {
  if (!src) return;
  lightbox.scale = 1;
  lightbox.x = 0;
  lightbox.y = 0;
  $('lightbox-img').src = src;
  const lb = $('lightbox');
  lb.classList.remove('hidden');
  lb.classList.remove('is-open');
  void lb.offsetWidth;
  requestAnimationFrame(() => lb.classList.add('is-open'));
  applyLightbox();
}

function closeLightbox() {
  const lb = $('lightbox');
  releaseFocus(lb);
  lb.classList.remove('is-open');
  lb.classList.add('hidden');
  $('lightbox-img').removeAttribute('src');
  focusComposer();
}

function renderChips() {
  const bits = [];
  for (const id of skillStack()) {
    const s = state.skills.find((x) => x.id === id);
    bits.push(`<span class="chip">/${escapeHtml(s?.name || id)} <button data-rm="skill" data-id="${escapeHtml(id)}">×</button></span>`);
  }
  for (const p of state.contextPaths) {
    bits.push(`<span class="chip">@${escapeHtml(p)} <button data-rm="ctx" data-p="${encodeURIComponent(p)}">×</button></span>`);
  }
  for (const a of state.attachments) {
    if (a.preview) {
      bits.push(`<span class="chip chip-img"><img src="${a.preview}" alt="${escapeHtml(a.name)}" data-zoom-src="${a.preview}"><button data-rm="att" data-p="${encodeURIComponent(a.path)}">×</button></span>`);
    } else {
      bits.push(`<span class="chip">${escapeHtml(a.name)} <button data-rm="att" data-p="${encodeURIComponent(a.path)}">×</button></span>`);
    }
  }
  $('chips').innerHTML = bits.join('');
  syncAgentBtn();
}

function renderQueue() {
  const el = $('queue');
  if (!el) return;
  const q = tabQueue(activeSession());
  if (!q.length) {
    el.classList.add('hidden');
    el.innerHTML = '';
    return;
  }
  el.classList.remove('hidden');
  el.innerHTML = q.map((item, i) => {
    const text = typeof item === 'string' ? item : (item?.text || '');
    const mid = typeof item === 'object' ? (item.modelId || '') : '';
    const model = modelNameOf(mid) || modelLabel();
    return `<span class="queue-item"><span class="q-no">${i + 1}</span><span class="q-model">${escapeHtml(model)}</span>${escapeHtml(clipText(text || t('attachment'), 50))}<button data-edit-queue='${i}' title='${t("edit")}'>${t("edit")}</button><button data-rm-queue="${i}" title="${t('remove')}">×</button></span>`;
  }).join('');
}

async function addAttachments(list) {
  for (const a of list || []) {
    if (!a?.path) continue;
    if (state.attachments.some((x) => x.path === a.path)) continue;
    const item = {
      path: a.path,
      name: a.name || a.path.split(/[\\/]/).pop()
    };
    if (isImageName(item.name)) {
      try {
        item.preview = await api.filePreview(item.path);
      } catch {
        /* 没有缩略图就显示文件名 */
      }
    }
    state.attachments.push(item);
  }
  scheduleComposerSave();
  renderChips();
}

/* ===== 剪贴板常驻面板：文本点击填入输入框，图片/文件点击加入引用 ===== */
let clipHistory = [];
const clipImgPreviews = new Map();

function renderClipPanel() {
  const list = $('clip-list');
  if (!list) return;
  if (!clipHistory.length) {
    list.innerHTML = '<div class="clip-empty">' + t('clipEmpty') + '</div>';
    return;
  }
  list.innerHTML = clipHistory.map((it) => {
    const thumb = it.kind === 'image'
      ? '<span class="clip-thumb" data-thumb="' + it.id + '"></span>'
      : '<span class="clip-ico">' + (it.kind === 'files' ? '📄' : '📝') + '</span>';
    const label = it.kind === 'text' ? clipText(it.text, 120) : (it.name || '');
    return '<button type="button" class="clip-item" data-clip-id="' + it.id + '" title="' + escapeHtml(label) + '">' + thumb + '<span class="clip-text">' + escapeHtml(label) + '</span></button>';
  }).join('');
  for (const it of clipHistory) {
    if (it.kind !== 'image') continue;
    const slot = list.querySelector('[data-thumb="' + it.id + '"]');
    if (slot) loadClipThumb(it, slot);
  }
}

async function loadClipThumb(item, slot) {
  let src = clipImgPreviews.get(item.path);
  if (src === undefined) {
    try { src = await api.filePreview(item.path); } catch { src = ''; }
    clipImgPreviews.set(item.path, src);
  }
  if (!src) { slot.textContent = '🖼'; return; }
  const img = document.createElement('img');
  img.src = src;
  img.alt = '';
  slot.textContent = '';
  slot.appendChild(img);
}

function bindClipPanel() {
  $('clip-list').addEventListener('click', async (e) => {
    const btn = e.target.closest('.clip-item');
    if (!btn) return;
    const item = clipHistory.find((x) => x.id === btn.dataset.clipId);
    if (!item) return;
    try {
      if (item.kind === 'text') {
        // 文本：追加填充到输入框并聚焦，不打断已输入内容
        const input = $('input');
        input.value = input.value ? input.value + '\n' + item.text : item.text;
        input.focus();
        input.selectionStart = input.selectionEnd = input.value.length;
      } else if (item.kind === 'image') {
        await addAttachments([{ path: item.path, name: item.name }]);
      } else if (item.kind === 'files') {
        await addAttachments((item.paths || []).map((p) => ({ path: p, name: String(p).split(/[\\/]/).pop() })));
      }
    } catch (err) {
      alert(err.message || err);
    }
  });
  $('btn-clip-clear').addEventListener('click', () => {
    api.clearClipboardHistory().catch(() => {});
  });
}

function initClipboardPanel() {
  // 旧版主进程没有这些桥时静默跳过，避免拖垮整体初始化
  if (!api.getClipboardHistory || !$('clip-list')) return;
  bindClipPanel();
  renderClipPanel();
  api.getClipboardHistory().then((r) => {
    clipHistory = (r && r.history) || [];
    renderClipPanel();
  }).catch(() => {});
  if (api.onClipboardUpdate) {
    api.onClipboardUpdate((data) => {
      clipHistory = (data && data.history) || [];
      renderClipPanel();
    });
  }
}

function bufToB64(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

async function fileToAttachment(file) {
  if (file.path) return { path: file.path, name: file.name || file.path.split(/[\\/]/).pop() };
  const buf = await file.arrayBuffer();
  if (buf.byteLength > 40 * 1024 * 1024) throw new Error(`文件过大：${file.name}`);
  return api.savePasteFile({
    name: file.name || 'clipboard.png',
    mime: file.type || '',
    base64: bufToB64(buf)
  });
}

async function attachmentsFromPasteEvent(e) {
  const out = [];
  const seen = new Set();
  let files = [...(e.clipboardData?.files || [])];
  if (!files.length) {
    for (const item of e.clipboardData?.items || []) {
      if (item.kind !== 'file') continue;
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  for (const file of files) {
    const key = file.path || `${file.name}:${file.size}:${file.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(await fileToAttachment(file));
  }
  return out;
}

function clipText(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function cleanErrorMessage(e) {
  let m = String(e?.message || e || '').trim();
  m = m.replace(/^Error invoking remote method '[^']+':\s*/i, '');
  m = m.replace(/^Error:\s*/i, '');
  return m || t('unknown');
}

function markTurnFailed(assistant, raw) {
  if (!assistant) return;
  const msg = cleanErrorMessage(raw);
  const note = t('errorPrefix', { msg });
  const hint = t('errorContinueHint');
  const body = assistant.text || '';
  if (!assistant.errorShown && !body.includes(note) && !body.includes(msg)) {
    assistant.text = [body, note, hint].filter(Boolean).join('\n\n');
  }
  assistant.errorShown = true;
  assistant.status = '';
  assistant.thinkingOpen = false;
  assistant.thinkExpanded = !!(assistant.thinking && assistant.thinking.length);
}

function thinkSummary(m) {
  if (m.stopped) return (m.thinking || []).length ? t('stoppedThink') : t('stopped');
  if (m.thinkingOpen) {
    if (m.status) return m.status;
    const tools = (m.thinking || []).filter((s) => s.type === 'tool');
    const lastTool = tools[tools.length - 1];
    if (lastTool) return `${t('running')} · ${clipText(lastTool.text, 28)}`;
    const last = (m.thinking || [])[m.thinking.length - 1];
    if (last?.type === 'reason') return t('reasoning');
    return m.text ? t('generating') : t('thinking');
  }
  const tools = (m.thinking || []).filter((s) => s.type === 'tool');
  return tools.length ? t('thinkSteps', { n: tools.length }) : t('think');
}

function thinkSummaryHtml(m) {
  const text = thinkSummary(m);
  const label = m.thinkingOpen && m.activeRole ? roleLabel(m.activeRole) : '';
  if (!label) return escapeHtml(text);
  const mark = `<span class="step-now">${escapeHtml(label)}</span>`;
  const at = text.indexOf(label);
  if (at < 0) return mark + escapeHtml(text);
  return escapeHtml(text.slice(0, at)) + mark + escapeHtml(text.slice(at + label.length));
}

function thinkStepsHtml(m) {
  let list = (m.thinking || []).filter((s) => s.type === 'tool' || s.type === 'reason');
  if (m.thinkingOpen && list.length > 8) list = list.slice(-8);
  const html = list.map((s) => {
    const cls = s.type === 'reason' ? 'reason' : 'step';
    const text = s.type === 'reason' ? clipText(s.text, 280) : s.text;
    return `<div class="${cls}">${escapeHtml(text)}</div>`;
  }).join('');
  if (html) return html;
  if (m.thinkingOpen && m.status) return '';
  return `<div class="step">${t('noSteps')}</div>`;
}

function renderThink(m, idx) {
  const hasStatus = !!(m.thinkingOpen && m.status);
  if (!m.thinking?.length && !hasStatus && !m.stopped) return '';
  const live = m.thinkingOpen && !m.stopped ? 'live' : '';
  const stopped = m.stopped ? ' stopped' : '';
  const steps = m.thinkExpanded ? `<div class="think-steps">${thinkStepsHtml(m)}</div>` : '';
  return `<details class="think-block ${live}${stopped}" data-msg-i="${idx}" ${m.thinkExpanded ? 'open' : ''}>
    <summary>${thinkSummaryHtml(m)}</summary>
    ${steps}
  </details>`;
}

function renderZbChrome(m, i) {
  if (!m?.zbaing) return '';
  const src = String(m.zbaing.source || 'guess');
  const key = {
    exact: 'zbExact',
    guess: 'zbGuess',
    transformer: 'zbTransformer',
    llm: 'zbLlm',
    zlm: 'zbZlm',
    retrieve: 'zbRetrieve'
  }[src] || 'zbGuess';
  return `<div class="zb-row">
    <span class="zb-badge ${escapeHtml(src)}">${escapeHtml(t(key))}</span>
    <button type="button" class="msg-zb-retry" data-zb-retry="${i}" title="${t('zbDislikeHint')}">${t('zbDislike')}</button>
  </div>`;
}

// [铆钉优化] 大脑复述完方案等「开始」时给一个确定按钮，点了必定按「开始」开工，不再依赖关键词猜测；其他 AI 请勿删除或改成猜测式
const START_ASK_RE = /确认无误后回复|回复[「"“]?开始|reply\s*["“]?start/i;
function renderStartGo(m, i, lastIdx, tab) {
  if (i !== lastIdx || m.stopped || m.askPending || isTabSending(tab)) return '';
  if (!START_ASK_RE.test(String(m.text || ''))) return '';
  const en = getLocale() === 'en';
  return `<div class="start-go-row"><button type="button" class="start-go" data-start-go="1">${en ? 'Start' : '开始'}</button><span class="start-go-hint">${en ? 'Hand off to the code worker' : '确认方案，派给代码模块改'}</span></div>`;
}

function renderAskCard(m) {
  const ask = m.ask;
  if (!ask || !m.askPending) return '';
  const opts = (ask.options || []).map((o, i) =>
    `<button type="button" class="ask-opt" data-ask-opt="${i}">${escapeHtml(String(o))}</button>`
  ).join('');
  // [铆钉优化] 回答框可以贴截图（Ctrl+V、选图、拖进来），AI 找用户要编辑器里的样子时才能给。其他 AI 请勿删
  const imgs = (m.askImages || []).map((src, i) =>
    `<span class="chip chip-img"><img src="${src}" alt="" data-zoom-src="${src}"><button type="button" data-ask-img-rm="${i}">×</button></span>`
  ).join('');
  const imgRow = `<div class="ask-imgs">${imgs}<button type="button" class="ask-img-add">${t('askAddImage')}</button><span class="ask-img-hint">${t('askImageHint')}</span><input type="file" class="ask-img-file" accept="image/*" multiple hidden></div>`;
  const free = ask.allowFreeText !== false
    ? `<textarea class="ask-input" rows="2" placeholder="${t('askPlaceholder')}">${escapeHtml(m.askDraft || '')}</textarea>`
    : '';
  const submit = (ask.allowFreeText !== false || (m.askImages || []).length)
    ? `<button type="button" class="primary ask-submit">${t('askSubmit')}</button>`
    : '';
  return `<div class="ask-card" data-ask-card="1">
    <div class="ask-title">${t('askTitle')}</div>
    <div class="ask-q">${escapeHtml(ask.question || '')}</div>
    ${opts ? `<div class="ask-opts">${opts}</div>` : ''}
    ${free}
    ${imgRow}
    ${submit}
  </div>`;
}

// 当前标签页正在等用户回答的那条助手消息
function pendingAskMsg() {
  const last = activeSession()?.liveAssistant;
  return last?.askPending ? last : null;
}

// 把附件（路径）转成图片数据放进提问卡片
async function addAskImages(list) {
  const m = pendingAskMsg();
  if (!m) return false;
  m.askImages = m.askImages || [];
  for (const a of list || []) {
    if (!a?.path || !isImageName(a.name || a.path)) continue;
    if (m.askImages.length >= 6) break;
    try {
      const url = await api.filePreview(a.path);
      if (url && /^data:image\//.test(url)) m.askImages.push(url);
    } catch { /* 读不出的图跳过 */ }
  }
  renderMessages();
  return true;
}

function memoryListHtml() {
  if (!state.workspace) return `<div class="hint">${t('openProjectFirst')}</div>`;
  const items = state.memories || [];
  if (!items.length) return `<div class="hint">${t('noMemory')}</div>`;
  return items.map((m) => {
    const pin = m.pinned ? ` · ${t('memoryPinned')}` : '';
    const paths = (m.paths || []).length ? `<br><span class="desc">${escapeHtml(clipText((m.paths || []).join(', '), 40))}</span>` : '';
    return `<div class="side-item memory-item" data-mem-id="${escapeHtml(m.id)}">
      <b>${escapeHtml(clipText(m.summary, 48))}</b>${pin}${paths}
      <div class="mem-actions">
        <button type="button" class="link" data-mem-pin="${escapeHtml(m.id)}" data-pinned="${m.pinned ? '1' : '0'}">${m.pinned ? t('memoryUnpin') : t('memoryPin')}</button>
        <button type="button" class="link danger" data-mem-del="${escapeHtml(m.id)}">${t('delete')}</button>
      </div>
    </div>`;
  }).join('');
}

function globalPrefListHtml() {
  const prefs = state.globalMemory?.prefs || [];
  if (!prefs.length) return `<div class="hint">${t('noGlobalPrefs')}</div>`;
  return prefs.map((m) => {
    const pin = m.pinned ? ` · ${t('memoryPinned')}` : '';
    return `<div class="side-item memory-item">
      <b>${escapeHtml(clipText(m.summary, 48))}</b>${pin}
      <div class="mem-actions">
        <button type="button" class="link" data-gpref-pin="${escapeHtml(m.id)}" data-pinned="${m.pinned ? '1' : '0'}">${m.pinned ? t('memoryUnpin') : t('memoryPin')}</button>
        <button type="button" class="link danger" data-gpref-del="${escapeHtml(m.id)}">${t('delete')}</button>
      </div>
    </div>`;
  }).join('');
}

function milestoneListHtml() {
  if (!state.workspace) return `<div class="hint">${t('openProjectFirst')}</div>`;
  const items = state.milestones || [];
  if (!items.length) return `<div class="hint">${t('noMilestones')}</div>`;
  return items.map((m) => {
    const paths = (m.paths || []).length ? `<br><span class="desc">${escapeHtml(clipText((m.paths || []).join(', '), 40))}</span>` : '';
    return `<div class="side-item memory-item" data-ms-id="${escapeHtml(m.id)}">
      <b>${escapeHtml(m.name)}</b>${paths}
      <div class="mem-actions">
        <button type="button" class="link" data-ms-rename="${escapeHtml(m.id)}">${t('milestoneRename')}</button>
        <button type="button" class="link danger" data-ms-del="${escapeHtml(m.id)}">${t('delete')}</button>
      </div>
    </div>`;
  }).join('');
}

function openMilestoneNameDialog({ title, defaultName = '', onSave }) {
  openModal(`<div class="modal-card-inner">
    <h3>${escapeHtml(title)}</h3>
    <p class="hint">${t('milestoneHint')}</p>
    <label>${t('milestoneName')}</label>
    <input id="m-ms-name" type="text" maxlength="80" placeholder="${t('milestoneNamePh')}" value="${escapeHtml(defaultName)}" />
    <div class="modal-actions">
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-save">${t('save')}</button>
    </div>
  </div>`);
  const input = $('m-ms-name');
  input.focus();
  input.select();
  $('m-cancel').onclick = closeModal;
  const save = async () => {
    const name = input.value.trim();
    if (!name) {
      alert(t('milestoneNeedName'));
      input.focus();
      return;
    }
    await onSave(name);
    closeModal();
  };
  $('m-save').onclick = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      save();
    }
  };
}

function openProfileEditor() {
  const p = state.globalMemory?.profile || {};
  openModal(`<div class="modal-card-inner">
    <h3>${t('userProfile')}</h3>
    <p class="hint">${t('profileHint')}</p>
    <label>${t('profileTone')}</label>
    <input id="m-pf-tone" value="${escapeHtml(p.tone || '')}" />
    <label>${t('profileLang')}</label>
    <input id="m-pf-lang" value="${escapeHtml(p.language || '')}" />
    <label>${t('profileSkill')}</label>
    <input id="m-pf-skill" value="${escapeHtml(p.skillLevel || '')}" />
    <label>${t('profileAvoid')}</label>
    <input id="m-pf-avoid" value="${escapeHtml((p.avoid || []).join(', '))}" />
    <label>${t('profileNotes')}</label>
    <textarea id="m-pf-notes" rows="5">${escapeHtml((p.notes || []).join('\n'))}</textarea>
    <div class="modal-actions">
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-save">${t('save')}</button>
    </div>
  </div>`);
  $('modal-card').classList.add('wide');
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-save').onclick = async () => {
    const profile = {
      ...p,
      tone: $('m-pf-tone').value.trim(),
      language: $('m-pf-lang').value.trim(),
      skillLevel: $('m-pf-skill').value.trim(),
      avoid: $('m-pf-avoid').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean),
      notes: $('m-pf-notes').value.split(/\n/).map((s) => s.trim()).filter(Boolean)
    };
    await api.saveGlobalProfile(profile);
    state.globalMemory = await api.getGlobalMemory();
    $('modal-card').classList.remove('wide');
    closeModal();
    renderSidebar();
  };
}

function openMemoryEditor() {
  if (!state.workspace) {
    openModal(`<h3>${t('memory')}</h3><p class="hint">${t('openProjectFirst')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
    $('m-ok').onclick = closeModal;
    return;
  }
  openModal(`<div class="modal-card-inner">
    <h3>${t('memoryNew')}</h3>
    <p class="hint">${t('memoryHint')}</p>
    <textarea id="m-mem-summary" rows="4" placeholder="${t('memorySummaryPh')}"></textarea>
    <input id="m-mem-paths" type="text" placeholder="${t('memoryPathsPh')}" style="width:100%;margin-top:8px" />
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <input type="checkbox" id="m-mem-pin" checked /> ${t('memoryPinned')}
    </label>
    <div class="modal-actions">
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-save">${t('save')}</button>
    </div>
  </div>`);
  $('m-cancel').onclick = closeModal;
  $('m-save').onclick = async () => {
    const summary = $('m-mem-summary').value.trim();
    if (!summary) return;
    const paths = $('m-mem-paths').value.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    const pinned = $('m-mem-pin').checked;
    state.memories = await api.addMemory({ summary, paths, pinned, kind: pinned ? 'pin' : 'invariant' });
    closeModal();
    renderSidebar();
  };
}

function openMemoryClearDialog() {
  if (!state.workspace) {
    openModal(`<h3>${t('memory')}</h3><p class="hint">${t('openProjectFirst')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
    $('m-ok').onclick = closeModal;
    return;
  }
  const items = state.memories || [];
  const pinnedCount = items.filter((m) => m.pinned).length;
  openModal(`<div class="modal-card-inner">
    <h3>${t('memoryClearTitle')}</h3>
    <p class="hint">${t('memoryClearHint', { total: items.length, pinned: pinnedCount })}</p>
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <input type="checkbox" id="m-mem-keep-pin" checked /> ${t('memoryKeepPinned')}
    </label>
    <div class="modal-actions">
      <button id="m-cancel">${t('cancel')}</button>
      <button class="danger" id="m-clear">${t('delete')}</button>
    </div>
  </div>`);
  $('m-cancel').onclick = closeModal;
  $('m-clear').onclick = async () => {
    const keepPinned = $('m-mem-keep-pin').checked;
    const toDelete = items.filter((m) => !keepPinned || !m.pinned).length;
    if (!toDelete) {
      alert(t('memoryClearEmpty'));
      return;
    }
    if (!confirm(t('memoryClearConfirm', { n: toDelete }))) return;
    try {
      state.memories = await api.clearMemory({ keepPinned });
      closeModal();
      renderSidebar();
      alert(t('memoryClearedOk', { n: toDelete }));
    } catch (err) {
      alert(err?.message || t('memoryClearFail'));
    }
  };
}

function openGlobalPrefEditor() {
  openModal(`<div class="modal-card-inner">
    <h3>${t('addGlobalPref')}</h3>
    <textarea id="m-gpref-summary" rows="4" placeholder="${t('memorySummaryPh')}"></textarea>
    <label style="display:flex;align-items:center;gap:8px;margin-top:10px">
      <input type="checkbox" id="m-gpref-pin" checked /> ${t('memoryPinned')}
    </label>
    <div class="modal-actions">
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-save">${t('save')}</button>
    </div>
  </div>`);
  $('m-cancel').onclick = closeModal;
  $('m-save').onclick = async () => {
    const summary = $('m-gpref-summary').value.trim();
    if (!summary) return;
    state.globalMemory = await api.addGlobalPref({ summary, pinned: $('m-gpref-pin').checked });
    closeModal();
    renderSidebar();
  };
}

function localMilestoneHits(changePaths) {
  const paths = (changePaths || []).map((c) => (typeof c === 'string' ? c : c.path)).filter(Boolean);
  if (!paths.length || !(state.milestones || []).length) return [];
  const norm = (p) => String(p || '').replace(/\\/g, '/').toLowerCase();
  const out = [];
  for (const m of state.milestones) {
    const hitPaths = paths.filter((p) => (m.paths || []).some((mp) => {
      const a = norm(mp);
      const b = norm(p);
      return a && b && (a === b || b.endsWith('/' + a) || a.endsWith('/' + b) || b.includes(a) || a.includes(b));
    }));
    if (hitPaths.length) out.push({ id: m.id, name: m.name, hitPaths });
  }
  return out;
}

// [铆钉优化] 出字丝滑：整段到达的回答也逐字流出，回合结束后把剩下的平滑打完，不再一大块跳出来。其他 AI 请勿改回直接显示全文
const revealingMsgs = new WeakSet();

function typeStep(behind) {
  return Math.max(1, Math.min(80, Math.ceil(behind / 30)));
}

function isAssistantTyping(m) {
  if (!m || m.role !== 'assistant' || prefersReducedMotion()) return false;
  if (revealingMsgs.has(m)) return true;
  const tab = activeSession();
  return !!(tab && m === tab.liveAssistant && !m.typewriterDone);
}

function stopTypewriter() {
  if (state.typewriterRaf) {
    cancelAnimationFrame(state.typewriterRaf);
    state.typewriterRaf = null;
  }
}

function finishTypewriter(msg) {
  if (!msg) return;
  if (revealingMsgs.has(msg)) return;
  msg.revealLen = (msg.text || '').length;
  msg.typewriterDone = true;
  stopTypewriter();
}

function cancelReveal(msg) {
  if (!msg) return;
  revealingMsgs.delete(msg);
  if (msg._revealRaf) cancelAnimationFrame(msg._revealRaf);
  msg._revealRaf = null;
}

function paintRevealBubble(msg, done) {
  const tab = activeSession();
  const idx = tab ? tab.messages.indexOf(msg) : -1;
  if (idx < 0) return;
  const el = document.querySelector(`.msg.assistant[data-msg-i="${idx}"] .bubble`);
  if (!el) return;
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 96;
  if (done) {
    el.classList.remove('typewriter', 'typing');
    el.classList.add('md', 'md-reveal');
    el.innerHTML = renderMarkdown(msg.text || '');
  } else {
    el.classList.remove('md');
    el.classList.add('typewriter', 'typing');
    el.textContent = (msg.text || '').slice(0, msg.revealLen || 0);
  }
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

/** 回合结束：没打完的部分继续平滑打完，再换成 Markdown 排版 */
function revealRest(msg) {
  if (!msg) return;
  const full = (msg.text || '').length;
  if (prefersReducedMotion() || (msg.revealLen || 0) >= full) {
    cancelReveal(msg);
    msg.revealLen = full;
    msg.typewriterDone = true;
    return;
  }
  if (revealingMsgs.has(msg)) return;
  revealingMsgs.add(msg);
  msg.typewriterDone = false;
  const step = () => {
    if (!revealingMsgs.has(msg)) return;
    const len = (msg.text || '').length;
    const behind = len - (msg.revealLen || 0);
    if (behind <= 0) {
      cancelReveal(msg);
      msg.revealLen = len;
      msg.typewriterDone = true;
      paintRevealBubble(msg, true);
      return;
    }
    msg.revealLen = (msg.revealLen || 0) + typeStep(behind);
    paintRevealBubble(msg, false);
    msg._revealRaf = requestAnimationFrame(step);
  };
  msg._revealRaf = requestAnimationFrame(step);
}

function ensureTypewriter() {
  const tab = activeSession();
  const last = tab?.liveAssistant;
  if (prefersReducedMotion()) {
    if (last) last.revealLen = (last.text || '').length;
    paintLiveAssistant();
    return;
  }
  if (state.typewriterRaf) return;
  const tick = () => {
    const cur = activeSession()?.liveAssistant;
    if (!cur || cur.typewriterDone || revealingMsgs.has(cur)) {
      state.typewriterRaf = null;
      return;
    }
    const fullLen = (cur.text || '').length;
    let revealed = cur.revealLen || 0;
    const behind = fullLen - revealed;
    if (behind > 0) {
      cur.revealLen = Math.min(fullLen, revealed + typeStep(behind));
      paintLiveAssistant();
    }
    if ((cur.revealLen || 0) < fullLen || (isTabSending(activeSession()) && cur === activeSession()?.liveAssistant && !cur.typewriterDone)) {
      state.typewriterRaf = requestAnimationFrame(tick);
    } else {
      state.typewriterRaf = null;
    }
  };
  state.typewriterRaf = requestAnimationFrame(tick);
}

function renderMessages(switching = false) {
  const box = $('messages');
  const keep = box.scrollTop;
  const wasNearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 96;
  const tab = activeSession();
  const msgs = tab?.messages || [];
  box.classList.toggle('empty-center', msgs.length === 0);
  if (!msgs.length) {
    box.innerHTML = '';
    updateUndoRedo();
    return;
  }
  let lastIdx = msgs.length - 1;
  while (lastIdx >= 0 && msgs[lastIdx].role === 'tool-note') lastIdx--;
  box.innerHTML = msgs.map((m, i) => {
    if (m.role === 'tool-note') return '';
    let extra = '';
    if (m.changes?.length) {
      const hits = m.milestoneHits || localMilestoneHits(m.changes);
      const hitHtml = hits.length
        ? `<div class="milestone-hits">${t('milestoneHits')}：${hits.map((h) =>
          `<span class="ms-hit" title="${escapeHtml((h.hitPaths || []).join(', '))}">${escapeHtml(h.name)}</span>`
        ).join('')}</div>`
        : '';
      const msBtn = m.milestoneId
        ? `<span class="ms-done">${escapeHtml(m.milestoneName || t('milestones'))}</span>`
        : `<button type="button" data-set-milestone="${i}">${t('setMilestone')}</button>`;
      extra = `<div class="file-card">
        <div class="file-card-head">
          <button type="button" class="file-card-toggle" data-expand-files>${t('changedFiles', { n: m.changes.length })}</button>
          ${m.snapshotId ? `<button type="button" data-restore="${m.snapshotId}">${t('restoreThis')}</button>` : ''}
          ${msBtn}
        </div>
        <div class="file-card-files">
          ${m.changes.map((c) => {
            const p = String(c.path || '').replace(/\\/g, '/');
            const cut = p.lastIndexOf('/') + 1;
            return `<div class="file-row">
            <span class="file-link" data-preview-file="${encodeURIComponent(c.path)}" title="${escapeHtml(p)} · ${t('previewHint')}"><span class="file-base">${escapeHtml(p.slice(cut))}</span><span class="file-dir">${escapeHtml(p.slice(0, cut))}</span></span>
            <button type="button" class="file-reveal" data-reveal="${encodeURIComponent(c.path)}" title="${t('showInFolder')}"><svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M1.5 3.5h4l1.5 1.5h7.5v8h-13z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>${t('openLocation')}</button>
          </div>`;
          }).join('')}
        </div>
        ${hitHtml}
      </div>`;
    }
    const thumbs = (m.images || []).map((src) => `<img class="msg-thumb" src="${src}" alt="" data-zoom-src="${src}">`).join('');
    const typing = isAssistantTyping(m);
    let body = '';
    if (m.text) {
      if (m.role === 'assistant') {
        body = typing
          ? escapeHtml((m.text || '').slice(0, m.revealLen || 0))
          : renderMarkdown(m.text);
      } else {
        body = escapeHtml(m.text);
      }
    }
    const inner = `${thumbs}${body}`;
    const bubbleCls = [
      'bubble',
      m.role === 'assistant' && !typing ? 'md' : '',
      typing ? 'typewriter' : '',
      typing && isTabSending(tab) ? 'typing' : ''
    ].filter(Boolean).join(' ');
    const bubble = inner ? `<div class="${bubbleCls}">${inner}</div>` : '';
    const liveAttr = tab && m === tab.liveAssistant ? ' data-live="1"' : '';
    if (!m._entered) m._entered = true;
    const enterCls = m._enterAnim ? ' msg-enter' : '';
    if (m._enterAnim) m._enterAnim = false;
    const zb = m.role === 'assistant' ? renderZbChrome(m, i) : '';
    return `<div class="msg ${m.role}${enterCls}" data-msg-i="${i}"${liveAttr}>
      <div class="role">${m.role === 'user' ? t('you') : t('assistantName')}${m.role === 'assistant' ? rosterHtml(m) : ''}
        <span>
          ${m.role === 'user' ? `<button class="msg-refill" data-refill="${i}" title="${t('refillTitle')}">${t('refill')}</button>` : ''}
          <button class="msg-fork" data-fork="${i}" title="${t('forkTitle')}">${t('fork')}</button>
        </span>
      </div>
      ${m.role === 'assistant' ? renderThink(m, i) : ''}${bubble}${renderUsageLine(m)}${zb}${m.role === 'assistant' ? renderAskCard(m) : ''}${m.role === 'assistant' ? renderStartGo(m, i, lastIdx, tab) : ''}${m.stopped ? `<div class="stopped-note">${escapeHtml(t('stoppedHint'))}</div>` : ''}${extra}
    </div>`;
  }).join('');
  // [铆钉优化] 进入/切换对话一律滚到最新；同一标签页重绘时原来贴底就继续贴底，否则保持原位。其他 AI 请勿改回恢复 scrollPos 旧位置
  if (switching) {
    tab.scrollPos = null;
    scrollMessagesToBottom();
  } else if (wasNearBottom) {
    box.scrollTop = box.scrollHeight;
  } else {
    box.scrollTop = keep;
  }
  updateUndoRedo();
}

// [铆钉优化] 消息用了 content-visibility:auto（屏外按 240px 估高），滚到底后真实高度才出来，一次设置 scrollTop 会停在半中间。
// 这里连续几帧贴底直到高度稳定；用户自己滚动（滚轮/触摸/按键/拖滚动条）就立刻停。其他 AI 请勿改回只设一次 scrollTop
let stickRaf = 0;
let stickCancelBound = false;
function cancelStickBottom() {
  if (stickRaf) cancelAnimationFrame(stickRaf);
  stickRaf = 0;
}
function scrollMessagesToBottom() {
  const box = $('messages');
  if (!box) return;
  if (!stickCancelBound) {
    stickCancelBound = true;
    box.addEventListener('wheel', cancelStickBottom, { passive: true });
    box.addEventListener('touchstart', cancelStickBottom, { passive: true });
    box.addEventListener('mousedown', cancelStickBottom);
    box.addEventListener('keydown', cancelStickBottom);
  }
  cancelStickBottom();
  box.scrollTop = box.scrollHeight;
  let lastH = -1;
  let stable = 0;
  let frames = 0;
  const step = () => {
    box.scrollTop = box.scrollHeight;
    if (box.scrollHeight === lastH) stable++;
    else stable = 0;
    lastH = box.scrollHeight;
    stickRaf = (stable < 8 && ++frames < 120) ? requestAnimationFrame(step) : 0;
  };
  stickRaf = requestAnimationFrame(step);
}

function flushLivePaint() {
  if (state.livePaintTimer) {
    clearTimeout(state.livePaintTimer);
    state.livePaintTimer = null;
  }
}

function scheduleLivePaint() {
  if (state.livePaintTimer) return;
  state.livePaintTimer = setTimeout(() => {
    state.livePaintTimer = null;
    paintLiveAssistant();
  }, 100);
}

function paintLiveAssistant() {
  const tab = activeSession();
  const last = tab?.liveAssistant;
  if (!last) return;
  const idx = tab.messages.indexOf(last);
  if (idx < 0) return;
  let el = document.querySelector(`.msg.assistant[data-live="1"][data-msg-i="${idx}"]`)
    || document.querySelector('.msg.assistant[data-live="1"]');
  if (!el || Number(el.getAttribute('data-msg-i')) !== idx) {
    renderMessages();
    return;
  }
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 96;
  el.setAttribute('data-msg-i', String(idx));
  let think = el.querySelector('.think-block');
  if (!think && (last.thinking?.length || (last.thinkingOpen && last.status) || last.stopped)) {
    const wrap = document.createElement('div');
    wrap.innerHTML = renderThink(last, idx);
    think = wrap.firstElementChild;
    if (think) {
      const bubble = el.querySelector('.bubble');
      el.insertBefore(think, bubble || null);
    }
  }
  refreshMsgRoster(el.querySelector('.role'), last);
  if (think) {
    think.classList.toggle('live', !!last.thinkingOpen && !last.stopped);
    think.classList.toggle('stopped', !!last.stopped);
    think.setAttribute('data-msg-i', String(idx));
    // 打字机每帧都会调到这里，思考内容通常一秒才变几次：
    // 缓存上次生成的 HTML，内容没变就跳过 innerHTML 重写，避免每帧重建 DOM
    const sum = think.querySelector('summary');
    if (sum) {
      const sumHtml = thinkSummaryHtml(last);
      if (sum.__lastHtml !== sumHtml) {
        sum.__lastHtml = sumHtml;
        sum.innerHTML = sumHtml;
      }
    }
    if (last.thinkExpanded) {
      let steps = think.querySelector('.think-steps');
      if (!steps) {
        steps = document.createElement('div');
        steps.className = 'think-steps';
        think.appendChild(steps);
      }
      const stepsHtml = thinkStepsHtml(last);
      if (steps.__lastHtml !== stepsHtml) {
        steps.__lastHtml = stepsHtml;
        steps.innerHTML = stepsHtml;
      }
    }
  }
  if (last.text) {
    let bubble = el.querySelector('.bubble');
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'bubble';
      el.appendChild(bubble);
    }
    const typing = isAssistantTyping(last);
    bubble.classList.toggle('md', !typing);
    bubble.classList.toggle('typewriter', typing);
    bubble.classList.toggle('typing', typing && isTabSending(tab));
    if (typing) bubble.textContent = (last.text || '').slice(0, last.revealLen || 0);
    else bubble.innerHTML = renderMarkdown(last.text);
  }
  const usageHtml = usageLineHtml(last);
  let usageEl = el.querySelector('.msg-usage');
  if (usageHtml) {
    if (!usageEl) {
      usageEl = document.createElement('div');
      usageEl.className = 'msg-usage';
      const bubbleNow = el.querySelector('.bubble');
      if (bubbleNow) bubbleNow.insertAdjacentElement('afterend', usageEl);
      else el.appendChild(usageEl);
    }
    if (usageEl.innerHTML !== usageHtml) usageEl.innerHTML = usageHtml;
  } else if (usageEl) usageEl.remove();
  if (nearBottom) box.scrollTop = box.scrollHeight;
}

function uniqueSkills() {
  const map = new Map();
  for (const s of state.skills) {
    if (!map.has(s.id)) map.set(s.id, s);
  }
  return [...map.values()];
}

// 本条消息叠加的技能栈；兼容旧数据里的单个 skillId
function normalizeSkillIds(src) {
  if (!src) return [];
  const ids = Array.isArray(src.skillIds) ? src.skillIds
    : (src.skillId ? [src.skillId] : (Array.isArray(src) ? src : []));
  const uniq = [];
  for (const id of ids) {
    const s = String(id || '').trim();
    if (s && !uniq.includes(s)) uniq.push(s);
  }
  return uniq;
}
function skillStack() {
  return normalizeSkillIds({ skillId: state.skillId, skillIds: state.skillIds });
}
function setSkillStack(ids) {
  const uniq = normalizeSkillIds(ids);
  state.skillIds = uniq;
  state.skillId = uniq[0] || null;
  const tab = activeSession();
  if (tab) tab.pickedSkillIds = uniq;
}
function addSkillToStack(id) {
  if (!id) return;
  setSkillStack([...skillStack(), id]);
}

function skillListHtml(skills) {
  if (!skills.length) return `<div class="hint">${t('noSkills')}</div>`;
  return skills.map((s, i) => {
    const scope = s.scope === 'workspace' ? t('scopeProject') : t('scopeGlobal');
    const pri = s.priority || i + 1;
    const covered = s.active === false;
    const key = `${s.scope || 'app'}:${s.id}`;
    const rawName = String(s.name || s.id || '').trim();
    const label = clipText(rawName || '未命名', 40);
    return `<div class="skill-li${covered ? ' covered' : ''}" draggable="true" data-id="${escapeHtml(s.id)}" data-scope="${s.scope || 'app'}">
      <span class="drag-handle" title="${t('dragPri')}">⋮⋮</span>
      <input type="checkbox" class="skill-enable" data-enable-skill="${escapeHtml(key)}"${s.enabled ? ' checked' : ''} />
      <span class="pri">${pri}</span>
      <button type="button" class="skill-li-name" data-skill="${s.id}" title="/${escapeHtml(rawName)}">/${escapeHtml(label)}</button>
      <span class="scope-tag">${scope}</span>
      <span class="desc">${escapeHtml(clipText(String(s.desc || ''), 80))}</span>
      ${covered ? `<span class="covered-tag">${t('covered')}</span>` : ''}
      <button type="button" class="skill-edit" data-edit-skill="${s.id}" data-edit-scope="${s.scope || 'app'}" data-open-skill="${s.id}" data-open-scope="${s.scope || 'app'}">${t('edit')}</button>
    </div>`;
  }).join('');
}

// 切换某个技能的启用状态（勾中的技能才会注入系统提示），并把结果落盘
async function toggleSkillEnabled(key, on) {
  const keys = new Set(state.skills.filter((s) => s.enabled).map((s) => `${s.scope || 'app'}:${s.id}`));
  if (on) keys.add(key);
  else keys.delete(key);
  state.skills = await api.setSkillsEnabled([...keys]);
  renderSidebar();
  renderChips();
  const modalList = $('m-skill-list');
  if (modalList) {
    modalList.innerHTML = skillListHtml(state.skills);
    bindSkillDrag(modalList);
  }
  syncAgentBtn();
}

function bindSkillDrag(container) {
  let dragEl = null;
  container.ondragstart = (e) => {
    dragEl = e.target.closest('.skill-li');
    if (!dragEl) return;
    dragEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  };
  container.ondragend = () => {
    if (dragEl) dragEl.classList.remove('dragging');
    dragEl = null;
  };
  container.ondragover = (e) => {
    e.preventDefault();
    const over = e.target.closest('.skill-li');
    if (!over || !dragEl || over === dragEl) return;
    const rect = over.getBoundingClientRect();
    const before = e.clientY < rect.top + rect.height / 2;
    container.insertBefore(dragEl, before ? over : over.nextSibling);
  };
  container.ondrop = async (e) => {
    e.preventDefault();
    const order = [...container.querySelectorAll('.skill-li')].map((el) => ({
      id: el.getAttribute('data-id'),
      scope: el.getAttribute('data-scope')
    }));
    state.skills = await api.reorderSkills(order);
    renderSidebar();
    const modalList = $('m-skill-list');
    if (modalList) {
      modalList.innerHTML = skillListHtml(state.skills);
      bindSkillDrag(modalList);
    }
  };
}

function renderSidebar() {
  const snapMaxEl = $('snap-max');
  if (snapMaxEl && document.activeElement !== snapMaxEl) {
    snapMaxEl.value = String(state.snapshotMax || 20);
    snapMaxEl.disabled = !state.workspace;
  }
  $('snap-list').innerHTML = state.snapshots.length
    ? state.snapshots.map((s) => `<button class="side-item" data-restore="${s.id}">${escapeHtml(s.label)}<br><span class="desc">${new Date(s.createdAt).toLocaleString()} · ${t('filesCount', { n: s.changes?.length || 0 })}</span></button>`).join('')
    : `<div class="hint">${t('noSnaps')}</div>`;
  $('skill-list').innerHTML = skillListHtml(state.skills);
  bindSkillDrag($('skill-list'));
  if ($('milestone-list')) $('milestone-list').innerHTML = milestoneListHtml();
  if ($('global-pref-list')) $('global-pref-list').innerHTML = globalPrefListHtml();
  if ($('memory-list')) $('memory-list').innerHTML = memoryListHtml();
  $('persona-list').innerHTML = personaListHtml();
  $('rule-list').innerHTML = ruleListHtml();
}

async function loadFileTree() {
  const extra = extraFoldersOf(activeSession());
  if (!state.workspace && !extra.length) {
    $('tree-root-name').textContent = t('noProject');
    $('tree-body').innerHTML = `<div class="hint" style="padding:8px">${t('openProjectFirst')}</div>`;
    return;
  }
  $('tree-root-name').textContent = state.workspace
    ? (state.workspace.split(/[\\/]/).pop() || t('project')).toUpperCase()
    : t('project');
  const keys = new Set(state.workspace ? ['.'] : []);
  for (const rel of state.treeOpen) keys.add(rel);
  for (const folder of extra) keys.add(String(folder).replace(/\\/g, '/'));
  const next = {};
  for (const key of keys) {
    try {
      if (isAbsTreePath(key) && !sameWorkspace(key, state.workspace)) {
        next[key] = await api.listChildren('', key, true);
      } else if (state.workspace) {
        const rel = key === '.' ? '' : key;
        next[key] = await api.listChildren(rel);
      } else {
        next[key] = [];
      }
    } catch {
      next[key] = [];
    }
  }
  state.treeCache = next;
  renderFileTree();
}

async function refreshUiKeepChat() {
  await refreshMeta();
  if (state.previewPath) {
    try { await openCodePreview(state.previewPath); } catch { closeCodePreview(); }
  }
}

function renderFileTree() {
  const extra = extraFoldersOf(activeSession());
  const main = state.workspace
    ? (renderTreeNodes('', 0) || `<div class="hint" style="padding:8px">${t('emptyDir')}</div>`)
    : '';
  const extras = extra.map((folder) => {
    const abs = String(folder).replace(/\\/g, '/');
    const name = abs.split('/').filter(Boolean).pop() || abs;
    const open = state.treeOpen.has(abs);
    const kids = open ? renderTreeNodes(abs, 1) : '';
    return `<div class="tree-extra">
      <button class="tree-row tree-extra-root" style="padding-left:8px" data-tree-dir="${encodeURIComponent(abs)}" title="${escapeHtml(abs)}">
        <span class="tree-arrow">${open ? '▾' : '▸'}</span>
        <span class="tree-name">${escapeHtml(name)}</span>
        <span class="tree-extra-x" data-rm-folder="${encodeURIComponent(abs)}" title="${t('removeFolder')}">×</span>
      </button>
      ${kids}
    </div>`;
  }).join('');
  const empty = !main && !extras
    ? `<div class="hint" style="padding:8px">${t('openProjectFirst')}</div>`
    : '';
  $('tree-body').innerHTML = `${main}${extras}${empty}`;
}

async function addExtraFolder() {
  const tab = activeSession() || (newTab(), activeSession());
  const dir = await api.pickFolder();
  if (!dir) return;
  const ws = tab.workspace || state.workspace;
  if (ws && sameWorkspace(dir, ws)) {
    alert(t('folderAlreadyInProject'));
    return;
  }
  const list = extraFoldersOf(tab);
  if (list.some((p) => sameWorkspace(p, dir))) {
    alert(t('folderAlreadyAdded'));
    return;
  }
  list.push(dir);
  persistTab(tab);
  await loadFileTree();
}

function removeExtraFolder(dir) {
  const tab = activeSession();
  if (!tab) return;
  tab.extraFolders = extraFoldersOf(tab).filter((p) => !sameWorkspace(p, dir));
  persistTab(tab);
  loadFileTree();
}

function renderTreeNodes(rel, depth) {
  const key = rel || '.';
  const items = state.treeCache[key] || [];
  return items.map((it) => {
    const pad = 8 + depth * 12;
    if (it.dir) {
      const open = state.treeOpen.has(it.path);
      const kids = open ? renderTreeNodes(it.path, depth + 1) : '';
      return `<div>
        <button class="tree-row" style="padding-left:${pad}px" data-tree-dir="${encodeURIComponent(it.path)}">
          <span class="tree-arrow">${open ? '▾' : '▸'}</span>
          <span class="tree-name">${escapeHtml(it.name)}</span>
        </button>
        ${kids}
      </div>`;
    }
    return `<button class="tree-row ${state.previewPath === it.path ? 'on' : ''}" style="padding-left:${pad}px" data-tree-file="${encodeURIComponent(it.path)}">
      <span class="tree-arrow"> </span>
      <span class="tree-name">${escapeHtml(it.name)}</span>
    </button>`;
  }).join('');
}

async function testConnection(cfg) {
  try {
    const r = await api.testModel(cfg);
    if (r.models?.length) {
      const names = r.models.map((m) => (typeof m === 'string' ? m : m.id)).filter(Boolean);
      alert(t('modelsAvailable', { list: names.slice(0, 12).join(', ') }));
    }
    else if (r.name) alert(t('modelOk', { name: r.name }));
    else alert(t('connOk'));
  } catch (e) {
    alert(e.message || e);
  }
}

async function refreshLocalFiles() {
  const r = await api.listLocalModels();
  state.modelsDir = r.dir || state.modelsDir;
  state.localFiles = r.files || [];
  return r;
}

async function selectLocalGguf(name) {
  const file = (state.localFiles || []).find((f) => f.name === name);
  let local = state.models.find((m) => m.id === 'local-gguf') || state.models.find((m) => m.type === 'local');
  if (!local) {
    local = { id: 'local-gguf', name: t('localModel'), type: 'local', model: name, modelPath: file?.path || '', vision: false };
    state.models.unshift(local);
  } else {
    local.id = 'local-gguf';
    local.name = local.name || t('localModel');
    local.type = 'local';
    local.model = name;
    local.modelPath = file?.path || '';
    delete local.baseUrl;
    delete local.apiKey;
  }
  const _t = activeSession(); if (_t) _t.modelId = local.id;
  state.currentModelId = local.id;
  await api.saveModels(state.models, local.id, state.providers);
  renderModelMenu();
  refreshQuotaBar();
}

function roleLabel(roleId) {
  const roleKeys = {
    brain: 'roleBrain',
    vision: 'roleVision',
    summary: 'roleSummary',
    code: 'roleCode',
    planning: 'rolePlanning',
    imageGen: 'roleImageGen',
    videoGen: 'roleVideoGen',
    model3d: 'roleModel3d',
    docGen: 'roleDocGen'
  };
  return t(roleKeys[roleId] || 'roleBrain');
}

const ROSTER_ROLES = ['vision', 'summary', 'code', 'planning', 'imageGen', 'videoGen', 'model3d', 'docGen'];

function slotDisplayName(slot) {
  if (!slot) return '';
  const model = String(slot.model || '').trim();
  if (model) return model;
  const named = String(slot.name || '').trim();
  if (named) return named;
  if (slot.apiId) {
    const m = (state.models || []).find((x) => x.id === slot.apiId);
    if (m) return m.model || m.name || '';
  }
  const file = String(slot.modelPath || '').split(/[\\/]/).pop();
  return file || '';
}

function capRefSlot(ref, role) {
  if (!ref || typeof ref !== 'object') return null;
  const slot = {
    role,
    model: String(ref.model || '').trim(),
    name: String(ref.name || '').trim(),
    apiId: String(ref.apiId || '').trim(),
    modelPath: String(ref.modelPath || '').trim()
  };
  return slotDisplayName(slot) ? slot : null;
}

function idleRoster() {
  const cur = currentModel();
  const name = cur?.model || cur?.name || t('model');
  const list = [{ name, role: 'brain' }];
  const pack = state.assemblies && state.assemblies[state.assemblyKey];
  const slots = Array.isArray(pack?.slots) ? pack.slots : [];
  const caps = state.capabilityDefaults || {};
  for (const role of ROSTER_ROLES) {
    let slot = slots.find((s) => s && s.role === role && slotDisplayName(s));
    if (!slot) {
      const row = caps[role] || {};
      slot = capRefSlot(row.primary, role);
      if (!slot) {
        const backs = Array.isArray(row.fallbacks) ? row.fallbacks : [];
        slot = backs.map((r) => capRefSlot(r, role)).find(Boolean) || null;
      }
    }
    const n = slotDisplayName(slot);
    if (!n) continue;
    list.push({ name: n, role });
  }
  return list;
}

function rosterForButton() {
  const tab = activeSession();
  const live = tab && tab.liveAssistant && tab.liveAssistant.roster;
  if (live && live.length) return live;
  return idleRoster();
}

function rosterChipOn(m, x) {
  if (m.activeRole && x.role === m.activeRole) return true;
  return !!(m.activeModel && x.name === m.activeModel && !m.activeRole);
}

function rosterHtml(m) {
  const models = (m.roster && m.roster.length)
    ? m.roster
    : (m.modelId ? [{ name: modelNameOf(m.modelId), role: 'brain' }] : []);
  return models.map((x) => {
    const on = rosterChipOn(m, x);
    return `<span class="msg-model${on ? ' on' : ''}" data-roster-name="${escapeHtml(x.name)}" data-roster-role="${escapeHtml(x.role)}">${escapeHtml(x.name)}<span class="model-role-tag">${escapeHtml(roleLabel(x.role))}</span></span>`;
  }).join('');
}

function refreshMsgRoster(roleEl, m) {
  if (!roleEl || !m) return;
  roleEl.querySelectorAll('.msg-model').forEach((n) => n.remove());
  const html = rosterHtml(m);
  const actions = roleEl.querySelector(':scope > span');
  if (actions) actions.insertAdjacentHTML('beforebegin', html);
  else roleEl.insertAdjacentHTML('beforeend', html);
}

function paintModelButton(activeName, activeRole) {
  const btn = $('btn-model');
  if (!btn) return;
  btn.replaceChildren();
  for (const m of rosterForButton()) {
    const chip = document.createElement('span');
    const on = !!(activeRole ? m.role === activeRole : (activeName && m.name === activeName));
    chip.className = on ? 'model-roster-chip on' : 'model-roster-chip';
    const label = document.createElement('span');
    label.textContent = m.name;
    const tag = document.createElement('span');
    tag.className = 'model-role-tag';
    tag.textContent = roleLabel(m.role);
    chip.append(label, tag);
    btn.append(chip);
  }
}

function renderModelMenu() {
  paintModelButton();
  const locals = (state.localFiles || []).map((f) => {
    const on = currentModel()?.type === 'local' && (currentModel()?.model === f.name || currentModel()?.modelPath === f.path);
    const tag = f.purposeLabel || (f.meta?.purpose ? purposeLabel(f.meta.purpose) : '');
    const tagHtml = tag ? `<span class="model-purpose-tag">${escapeHtml(tag)}</span>` : '';
    return `<div class="model-row ${on ? 'on' : ''}">
      <button class="pick" data-gguf="${encodeURIComponent(f.name)}">${on ? '✓ ' : ''}${t('local')} · ${escapeHtml(f.name)}${tagHtml}</button>
      <button class="mtest" data-test-gguf="${encodeURIComponent(f.path)}" title="${t('test')}">${t('test')}</button>
    </div>`;
  }).join('');
  const apis = state.models.filter((m) => m.type !== 'local').map((m) => {
    const on = m.id === state.currentModelId;
    return `<div class="model-row ${on ? 'on' : ''}">
      <button class="pick" data-model="${m.id}">${on ? '✓ ' : ''}${escapeHtml(m.name)} · ${escapeHtml(m.model)}</button>
      <button class="mtest" data-test-model="${m.id}" title="${t('testConn')}">${t('test')}</button>
    </div>`;
  }).join('');
  const listBody = (locals || `<button disabled>${t('noLocalGguf')}</button>`)
    + (apis ? `<div class="sep"></div>${apis}` : '');
  $('model-menu').innerHTML = `<div class="model-menu-scroll">${listBody}</div>`
    + `<div class="model-menu-foot"><div class="sep"></div><button data-act="settings">${t('manageModels')}</button></div>`;
  $('status-model').textContent = modelLabel();
}

function persistSession() {
  return persistTab(activeSession());
}

function closeCodePreview() {
  const preview = $('code-preview');
  releaseFocus(preview);
  state.previewPath = '';
  preview.classList.add('hidden');
  $('preview-path').textContent = t('noFile');
  $('preview-body').innerHTML = '';
  renderFileTree();
  focusComposer();
}

async function openCodePreview(rel) {
  const filePath = String(rel || '').replace(/\\/g, '/');
  if (!filePath) return;
  state.previewPath = filePath;
  $('code-preview').classList.remove('hidden');
  $('preview-path').textContent = filePath;
  $('preview-path').title = filePath;
  $('preview-body').innerHTML = `<div class="hint" style="padding:12px">${t('loading')}</div>`;
  renderFileTree();
  try {
    const data = await api.readWorkspaceFile(filePath);
    if (data.kind === 'image') {
      $('preview-body').innerHTML = `<img src="${data.content}" alt="${escapeHtml(data.name)}" data-zoom-src="${data.content}">`;
      return;
    }
    if (data.kind === 'document') {
      const imgs = (data.images || []).map((img) =>
        `<img class="preview-doc-img" src="${img.dataUrl}" alt="${escapeHtml(img.name || '')}" data-zoom-src="${img.dataUrl}">`
      ).join('');
      const lines = String(data.content || '').split('\n');
      $('preview-body').innerHTML = `${imgs}<ol class="code-ol">${lines.map((line) => `<li>${escapeHtml(line) || ' '}</li>`).join('')}</ol>`;
      return;
    }
    if (data.kind === 'binary') {
      $('preview-body').innerHTML = `<div class="hint" style="padding:12px">${t('binaryNoPreview')}</div>`;
      return;
    }
    const lines = String(data.content || '').split('\n');
    $('preview-body').innerHTML = `<ol class="code-ol">${lines.map((line) => `<li>${escapeHtml(line) || ' '}</li>`).join('')}</ol>`;
  } catch (e) {
    $('preview-body').innerHTML = `<div class="hint" style="padding:12px">${escapeHtml(e.message || e)}</div>`;
  }
}

function addContextPath(rel) {
  const filePath = String(rel || '').replace(/\\/g, '/');
  if (!filePath || state.contextPaths.includes(filePath)) return;
  state.contextPaths.push(filePath);
  renderChips();
}

async function applyRename(id, title) {
  const name = String(title || '').trim().slice(0, 80) || t('unnamed');
  const tab = state.tabs.find((t) => t.id === id);
  if (tab) {
    tab.title = name;
    renderTabs();
    await persistTab(tab);
  } else {
    await api.renameSession(id, name);
  }
}

function promptRename(id, current, onDone) {
  openModal(`<h3>${t('renameTab')}</h3>
    <label>${t('titleLabel')}</label>
    <input id="m-title" value="${escapeHtml(current || '')}" maxlength="80">
    <div class="modal-actions">
      <button type="button" id="m-cancel">${t('cancel')}</button>
      <button type="button" class="primary" id="m-ok">${t('save')}</button>
    </div>`);
  const input = $('m-title');
  input.focus();
  input.select();
  const save = async () => {
    await applyRename(id, input.value);
    if (onDone) onDone();
    else closeModal();
  };
  $('m-cancel').onclick = () => { if (onDone) onDone(); else closeModal(); };
  $('m-ok').onclick = save;
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    if (e.key === 'Escape') { e.preventDefault(); if (onDone) onDone(); else closeModal(); }
  };
}

async function openHistorySession(id) {
  await persistSession();
  const existing = state.tabs.find((t) => t.id === id);
  if (existing) {
    closeModal();
    showChat();
    await switchToTab(id);
    return;
  }
  const data = await api.loadSession(id);
  if (data.workspace && data.workspace !== state.workspace) {
    const ws = await api.setWorkspace(data.workspace);
    setWorkspace(ws || data.workspace);
    await refreshMeta();
  }
  const tab = hydrateTab(data, data.workspace || state.workspace);
  state.tabs.push(tab);
  state.activeTab = data.id;
  applyTabContext(tab);
  closeModal();
  showChat();
  renderTabs();
  renderMessages();
  renderQueue();
  syncSendBtn();
  await loadFileTree();
}

async function deleteConversation(id, title) {
  const name = title || state.tabs.find((tab) => tab.id === id)?.title || t('unnamed');
  if (!confirm(t('deleteChatConfirm', { name }))) return false;
  await api.deleteSession(id);
  const closing = state.tabs.find((t) => t.id === id);
  if (isTabSending(closing)) abortTab(closing);
  state.tabs = state.tabs.filter((t) => t.id !== id);
  if (state.activeTab === id) state.activeTab = state.tabs[0]?.id || null;
  if (!state.tabs.length) newTab();
  renderTabs();
  renderMessages();
  return true;
}

async function openHistory() {
  const items = await api.loadSessions();
  const list = items.length
    ? `<div class="hist-ul">${items.map((s) => {
      const when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
      const wsName = s.workspace ? String(s.workspace).split(/[\\/]/).pop() : '';
      return `<div class="hist-li">
        <button type="button" class="hist-open" data-sid="${s.id}">
          ${escapeHtml(s.title || t('unnamed'))}
          <span class="desc">${escapeHtml([when, wsName].filter(Boolean).join(' · '))}</span>
        </button>
        <button type="button" class="hist-rename" data-rename="${s.id}">${t('rename')}</button>
        <button type="button" class="hist-del" data-del="${s.id}">${t('delete')}</button>
      </div>`;
    }).join('')}</div>`
    : `<p class="hint">${t('noHistory')}</p>`;
  openModal(`<h3>${t('historyTitle')}</h3>${list}<div class="modal-actions"><button type="button" class="primary" id="m-ok">${t('close')}</button></div>`);
  $('modal-card').classList.add('wide');
  $('m-ok').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('modal-card').onclick = async (e) => {
    const delId = e.target.closest('[data-del]')?.getAttribute('data-del');
    if (delId) {
      const cur = items.find((x) => x.id === delId);
      try {
        const ok = await deleteConversation(delId, cur?.title || '');
        if (ok) openHistory();
      } catch (err) {
        alert(err.message || err);
      }
      return;
    }
    const renameId = e.target.closest('[data-rename]')?.getAttribute('data-rename');
    if (renameId) {
      const cur = items.find((x) => x.id === renameId);
      promptRename(renameId, cur?.title || '', () => openHistory());
      return;
    }
    const sid = e.target.closest('[data-sid]')?.getAttribute('data-sid');
    if (!sid) return;
    try {
      await openHistorySession(sid);
    } catch (err) {
      alert(err.message || err);
    }
  };
}

function updateUndoRedo() {
  const tab = activeSession();
  const sending = isTabSending(tab);
  const canUndo = !!(tab && tab.messages.some((m) => m.role === 'user'));
  const canRedo = !!(tab && tab.undone && tab.undone.length);
  if ($('btn-undo')) $('btn-undo').disabled = !canUndo || sending;
  if ($('btn-redo')) $('btn-redo').disabled = !canRedo || sending;
}

async function undoTurn() {
  const tab = activeSession();
  if (isTabSending(tab)) return;
  if (!tab?.messages?.length) return;
  let i = tab.messages.length - 1;
  while (i >= 0 && tab.messages[i].role !== 'user') i--;
  if (i < 0) return;
  const removed = tab.messages.splice(i);
  const snapId = [...removed].reverse().find((m) => m.snapshotId)?.snapshotId || null;
  if (snapId) {
    try {
      await api.undoSnapshot(snapId);
    } catch (e) {
      alert(e.message || e);
    }
  }
  tab.undone = tab.undone || [];
  tab.undone.push({ messages: removed, snapshotId: snapId });
  renderMessages();
  persistSession();
  await refreshAfterRestore();
}

async function redoTurn() {
  const tab = activeSession();
  if (isTabSending(tab)) return;
  if (!tab?.undone?.length) return;
  const item = tab.undone.pop();
  if (item.snapshotId) {
    try {
      await api.redoSnapshot(item.snapshotId);
    } catch (e) {
      alert(e.message || e);
    }
  }
  tab.messages.push(...(item.messages || []));
  renderMessages();
  persistSession();
  await refreshAfterRestore();
}

function forkAt(index) {
  const tab = activeSession();
  if (!tab) return;
  const slice = tab.messages.slice(0, index + 1).map((m) => JSON.parse(JSON.stringify(m)));
  const forked = hydrateTab({
    id: uid(),
    title: `${(tab.title || t('chat')).replace(/ 分叉$/, '').replace(/ fork$/i, '')}${t('forkSuffix')}`,
    messages: slice,
    workspace: tab.workspace || state.workspace,
    extraFolders: extraFoldersOf(tab),
    undone: [],
    // 分叉不继承图片附件（附件只留在消息体 draft 里），避免图片复活
    context: { skillId: tab.context?.skillId || null, skillIds: normalizeSkillIds(tab.context || {}), contextPaths: [...(tab.context?.contextPaths || [])], attachments: [] },
    workingMemory: tab.workingMemory || emptyWorkingMemory(),
    contextSummary: tab.contextSummary || ''
  }, tab.workspace || state.workspace);
  state.tabs.push(forked);
  state.activeTab = forked.id;
  renderTabs();
  renderMessages();
  persistSession();
}

function isStopError(e, tab) {
  const m = String(e?.message || e || '');
  const aborting = tab ? tab.aborting : state.aborting;
  return aborting || e?.name === 'AbortError' || /已停止|aborted/i.test(m);
}

function clearStallWatch(tab) {
  if (!tab) {
    for (const item of state.tabs) clearStallWatch(item);
    return;
  }
  if (tab.stallTimer) {
    clearTimeout(tab.stallTimer);
    tab.stallTimer = null;
  }
}

function armStallWatch(tab) {
  if (!tab) return;
  clearStallWatch(tab);
  if (!tab.sending) return;
  tab.stallTimer = setTimeout(() => {
    if (!tab.sending || !tab.liveAssistant) return;
    const last = tab.liveAssistant;
    last.thinkingOpen = true;
    last.status = t('modelStall');
    if (isActiveTab(tab)) scheduleLivePaint();
    armStallWatch(tab);
  }, 10 * 60 * 1000);
}

/** 停止后把原文、图片附件、引用和技能写回输入框，并撤掉未完成的这一轮 */
function refillDraft(draft) {
  if (!draft) return;
  $('input').value = draft.text || '';
  setSkillStack(normalizeSkillIds(draft));
  state.contextPaths = Array.isArray(draft.contextPaths) ? [...draft.contextPaths] : [];
  state.attachments = Array.isArray(draft.attachments)
    ? draft.attachments.filter((a) => a && a.path).map((a) => ({ path: a.path, name: a.name || String(a.path).split(/[\\/]/).pop() }))
    : [];
  renderChips();
  $('input').focus();
}

function refillQueueItem(item) {
  if (item == null) return;
  const text = typeof item === 'string' ? item : (item.text || '');
  const draft = typeof item === 'string'
    ? { text, skillId: null, contextPaths: [], attachments: [] }
    : item;
  $('input').value = text;
  setSkillStack(normalizeSkillIds(draft));
  state.contextPaths = Array.isArray(draft.contextPaths) ? [...draft.contextPaths] : [];
  state.attachments = Array.isArray(draft.attachments)
    ? draft.attachments.filter((a) => a && a.path).map((a) => ({ path: a.path, name: a.name || String(a.path).split(/[\\/]/).pop() }))
    : [];
  renderChips();
  $('input').focus();
}

function refillHasTail() {
  const tab = activeSession();
  const from = state.refillFromIndex;
  if (from == null || from < 0 || !tab) return false;
  return (tab.messages?.length || 0) > from;
}

function confirmSubmitFromPrevious() {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      $('modal').onclick = null;
      closeModal();
      resolve(v);
    };
    openModal(`<h3>${t('refillSubmitTitle')}</h3>
      <p class="hint">${t('refillSubmitHint')}</p>
      <div class="modal-actions">
        <button type="button" id="m-cancel">${t('cancel')}</button>
        <button type="button" id="m-keep-files">${t('refillDontRevert')}</button>
        <button type="button" id="m-new">${t('refillAsNew')}</button>
        <button type="button" class="primary" id="m-revert">${t('refillRevert')}</button>
      </div>`);
    $('m-cancel').onclick = () => done('cancel');
    $('m-keep-files').onclick = () => done('keep');
    $('m-new').onclick = () => done('new');
    $('m-revert').onclick = () => done('revert');
    $('modal').onclick = (e) => {
      if (e.target === $('modal')) done('cancel');
    };
    $('m-cancel').focus();
  });
}

async function beginRefillResend(tab) {
  const from = state.refillFromIndex;
  if (from == null || from < 0 || !tab) return;
  const tail = tab.messages.slice(from);
  const revert = !!state.refillRevertFiles;
  state.refillRevertFiles = false;
  state.refillFromIndex = null;
  if (tab) { tab.refillFromIndex = null; tab.refillRevertFiles = false; }
  if (revert) {
    const ids = [];
    for (let i = tail.length - 1; i >= 0; i--) {
      const id = tail[i]?.snapshotId;
      if (id && !ids.includes(id)) ids.push(id);
    }
    for (const id of ids) {
      try { await api.restoreSnapshot(id); } catch { /* 快照可能已过期 */ }
    }
    try { await refreshAfterRestore(); } catch { /* 忽略刷新失败 */ }
  }
  tab.messages = tab.messages.slice(0, from);
}

function finalizeStoppedTurn(assistant) {
  if (!assistant) return;
  cancelReveal(assistant);
  assistant.stopped = true;
  assistant.askPending = false;
  assistant.ask = null;
  assistant.status = t('stopped');
  assistant.thinkingOpen = false;
  assistant.thinkExpanded = !!(assistant.thinking && assistant.thinking.length);
  if (!String(assistant.text || '').trim()) {
    const bits = (assistant.thinking || []).map((s) => String(s.text || '').trim()).filter(Boolean).slice(-8);
    if (bits.length) {
      assistant.text = bits.join('\n\n');
      assistant.revealLen = assistant.text.length;
      assistant.typewriterDone = true;
    }
  }
  finishTypewriter(assistant);
}

// 停止后把这条需求放回输入框。对话里的原文留着，输入框已有新内容时不覆盖
function restoreStoppedDraft(tab, assistant) {
  if (!tab || !assistant || !isActiveTab(tab)) return;
  const input = $('input');
  if (!input || input.value.trim()) return;
  const idx = tab.messages.indexOf(assistant);
  let user = null;
  for (let i = (idx < 0 ? tab.messages.length : idx) - 1; i >= 0; i--) {
    if (tab.messages[i].role === 'user') { user = tab.messages[i]; break; }
  }
  if (!user) return;
  if (user.draft) refillDraft(user.draft);
  else if (user.text) {
    input.value = user.text;
    input.focus();
  }
}

async function sendOne(tab, text, draft) {
  if (!tab) return true;
  tab.undone = [];
  await beginRefillResend(tab);
  draft = draft || {
    text,
    skillId: skillStack()[0] || null,
    skillIds: skillStack(),
    contextPaths: [...state.contextPaths],
    attachments: state.attachments.map((a) => ({ ...a }))
  };
  const atts = draft.attachments || [];
  const imageAtts = atts.filter((a) => a.preview);
  const otherAtts = atts.filter((a) => !a.preview);
  tab.messages.push({
    role: 'user',
    text: [text, ...(draft.contextPaths || []).map((p) => `@${p}`), ...otherAtts.map((a) => a.name)].filter(Boolean).join('\n'),
    images: imageAtts.map((a) => a.preview),
    _enterAnim: !prefersReducedMotion(),
    draft: {
      text,
      skillId: normalizeSkillIds(draft)[0] || null,
      skillIds: normalizeSkillIds(draft),
      contextPaths: [...(draft.contextPaths || [])],
      attachments: atts.map((a) => ({ path: a.path, name: a.name }))
    }
  });
  if (isNewChatTitle(tab.title) && text) tab.title = text.slice(0, 18);
  const history = tab.messages.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => ({ role: m.role, content: m.text || '' }));
  history.pop();
  const turnId = uid();
  const modelId = draft.modelId || tab.modelId || state.currentModelId;
  const skillIds = normalizeSkillIds(draft);
  const assistant = {
    role: 'assistant',
    text: '',
    changes: [],
    snapshotId: null,
    thinking: [],
    status: t('preparing'),
    thinkingOpen: true,
    thinkExpanded: true,
    turnId,
    modelId,
    revealLen: 0,
    typewriterDone: false,
    _enterAnim: !prefersReducedMotion()
  };
  tab.messages.push(assistant);
  const payload = {
    text,
    history,
    skillId: skillIds[0] || null,
    skillIds,
    contextPaths: [...(draft.contextPaths || [])],
    attachments: [...atts],
    modelId,
    workingMemory: tab.workingMemory || emptyWorkingMemory(),
    contextSummary: tab.contextSummary || '',
    workspace: tab.workspace || state.workspace,
    extraFolders: [...extraFoldersOf(tab)],
    turnId,
    maxAgentRounds: roundsOf(tab),
    unlimitedRounds: !!tab.unlimitedRounds
  };
  tab.context = {
    skillId: skillIds[0] || null,
    skillIds,
    contextPaths: [...(draft.contextPaths || [])],
    attachments: []
  };
  if (isActiveTab(tab)) {
    state.contextPaths = [];
    state.attachments = [];
    renderChips();
    renderTabs();
    renderMessages();
    scrollMessagesToBottom();
  } else {
    renderTabs();
  }
  tab.aborting = false;
  tab.liveTurnId = turnId;
  tab.liveAssistant = assistant;
  tab.sending = true;
  if (isActiveTab(tab)) syncSendBtn();
  armStallWatch(tab);
  let aborted = false;
  try {
    const result = await api.chatSend(payload);
    if (isStopError(null, tab)) {
      if (isActiveTab(tab)) {
        flushLivePaint();
        stopTypewriter();
      }
      finalizeStoppedTurn(assistant);
      restoreStoppedDraft(tab, assistant);
      aborted = true;
    } else {
      assistant.text = result.text || assistant.text;
      if (result.zbaingMeta) assistant.zbaing = result.zbaingMeta;
      assistant.changes = result.changes || [];
      assistant.snapshotId = result.snapshotId;
      assistant.milestoneHits = localMilestoneHits(assistant.changes);
      assistant.status = '';
      assistant.thinkingOpen = false;
      assistant.askPending = false;
      assistant.ask = null;
      revealRest(assistant);
      if (result.workingMemory) tab.workingMemory = result.workingMemory;
      if (result.contextSummary != null) tab.contextSummary = result.contextSummary;
    }
  } catch (e) {
    if (isStopError(e, tab)) {
      if (isActiveTab(tab)) {
        flushLivePaint();
        stopTypewriter();
      }
      finalizeStoppedTurn(assistant);
      restoreStoppedDraft(tab, assistant);
      aborted = true;
    } else {
      markTurnFailed(assistant, e);
      finishTypewriter(assistant);
    }
  } finally {
    clearStallWatch(tab);
    if (isActiveTab(tab)) {
      flushLivePaint();
      stopTypewriter();
    }
    if (!aborted) finishTypewriter(assistant);
    tab.sending = false;
    tab.aborting = false;
    tab.liveAssistant = null;
    tab.liveTurnId = null;
    renderTabs();
    if (isActiveTab(tab)) {
      syncSendBtn();
      renderMessages();
      // [铆钉优化] 一轮结束（改完/出错/停止）直接滚到最新，不用手动往下拉。其他 AI 请勿删除
      tab.scrollPos = null;
      scrollMessagesToBottom();
      try {
        state.snapshots = await api.listSnapshots();
      } catch { /* 忽略 */ }
      try {
        state.milestones = state.workspace ? (await api.listMilestones()) : [];
      } catch { /* 忽略 */ }
      renderSidebar();
    }
    persistTab(tab);
  }
  return aborted;
}

async function processQueue(tab) {
  if (!tab || tab.draining) return;
  tab.draining = true;
  try {
    while (tabQueue(tab).length) {
      const item = tab.queue.shift();
      if (isActiveTab(tab)) renderQueue();
      const text = typeof item === 'string' ? item : (item?.text || '');
      // 旧格式字符串项没有快照，按空附件处理；新队列项自带入队时的快照
      const draft = typeof item === 'string'
        ? { text, skillId: null, skillIds: [], contextPaths: [], attachments: [] }
        : item;
      const aborted = await sendOne(tab, text, draft);
      if (aborted) break;
    }
  } finally {
    tab.draining = false;
    if (isActiveTab(tab)) {
      renderQueue();
      syncSendBtn();
    }
  }
}

async function send() {
  const tab = activeSession() || (newTab(), activeSession());
  if (!tab.workspace && state.workspace) tab.workspace = state.workspace;
  const input = $('input');
  const text = input.value.trim();
  if (!text && !state.attachments.length && !tabQueue(tab).length) return;
  if (!tab.workspace) {
    openModal(`<h3>${t('pickWorkspace')}</h3><p class="hint">${t('pickWorkspaceHint')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
    $('m-ok').onclick = closeModal;
    return;
  }
  if (!currentModel()) {
    openSettings();
    return;
  }
  if (refillHasTail()) {
    const choice = await confirmSubmitFromPrevious();
    if (choice === 'cancel') return;
    if (choice === 'new') {
      // 放弃编辑、保留旧消息：清空编辑锚点，后续按普通发送把当前输入作为全新消息追加
      state.refillFromIndex = null;
      state.refillRevertFiles = false;
      const rt = activeSession();
      if (rt) { rt.refillFromIndex = null; rt.refillRevertFiles = false; }
    } else {
      state.refillRevertFiles = choice === 'revert';
    }
  }
  // 每条消息入队时各自拍快照（文本/技能/引用/附件），队列里互不继承上一轮的内容
  const snapItem = () => {
    const ids = skillStack();
    return {
      text,
      skillId: ids[0] || null,
      skillIds: ids,
      modelId: tab.modelId || state.currentModelId,
      contextPaths: [...state.contextPaths],
      attachments: state.attachments.map((a) => ({ ...a }))
    };
  };
  if (tab.sending || tab.draining) {
    if (text || state.attachments.length) {
      tabQueue(tab).push(snapItem());
      input.value = '';
      clearComposer(tab);
      scheduleComposerSave();
      // 发送即消费输入区：附件/引用/技能已随队列项快照，清空避免下一条重复带上
      state.attachments = [];
      state.contextPaths = [];
      renderChips();
    }
    renderQueue();
    return;
  }
  if (text || state.attachments.length) {
    tabQueue(tab).push(snapItem());
    input.value = '';
    clearComposer(tab);
    scheduleComposerSave();
    // 发送即消费附件和引用。当前对话勾着的技能留着，直到自己取消
    state.attachments = [];
    state.contextPaths = [];
    renderChips();
  }
  renderQueue();
  await processQueue(tab);
}

function pushThink(last, type, text) {
  if (!text) return;
  last.thinking = last.thinking || [];
  const prev = last.thinking[last.thinking.length - 1];
  if (type === 'reason' && prev?.type === 'reason') {
    prev.text += text;
    return;
  }
  if (prev?.text === text) return;
  last.thinking.push({ type, text });
}

function mergeMsgUsage(msg, ev) {
  if (!msg) return;
  if (!msg.usage) msg.usage = { input: 0, output: 0, usd: 0, credits: 0 };
  msg.usage.input = (Number(msg.usage.input) || 0) + (Number(ev.input) || 0);
  msg.usage.output = (Number(msg.usage.output) || 0) + (Number(ev.output) || 0);
  // [铆钉优化] 上下文 = 这一轮里单次调用发给模型的最大输入量（输入是多次调用累加的，不能代表上下文）。其他 AI 请勿改成累加
  msg.usage.context = Math.max(Number(msg.usage.context) || 0, Number(ev.input) || 0);
  if (ev.usd != null && Number.isFinite(Number(ev.usd))) {
    msg.usage.usd = (Number(msg.usage.usd) || 0) + Number(ev.usd);
  }
  if (ev.credits != null && Number.isFinite(Number(ev.credits))) {
    msg.usage.credits = (Number(msg.usage.credits) || 0) + Number(ev.credits);
  }
  if (ev.billed) msg.usage.billed = true;
}

// [铆钉优化] token 数超过 1000 按 K 显示，超过 100 万按 M。其他 AI 请勿改回原始长数字
function fmtTokens(n) {
  const v = Math.round(Number(n) || 0);
  const trim = (x) => x.toFixed(1).replace(/\.0$/, '');
  if (v >= 1000000) return `${trim(v / 1000000)}M`;
  if (v >= 1000) return `${trim(v / 1000)}K`;
  return String(v);
}

function usageLineText(u) {
  if (!u || (!(u.input || u.output) && !u.credits && !u.usd)) return '';
  const bits = [];
  if (u.context) bits.push(t('msgContext', { ctx: fmtTokens(u.context) }));
  bits.push(t('msgTokens', { in: fmtTokens(u.input), out: fmtTokens(u.output) }));
  if (u.credits) bits.push(`${formatQuotaMoney(u.credits, 'CREDITS')} Credits`);
  else if (u.usd) bits.push(formatQuotaMoney(u.usd, 'USD'));
  return bits.join(' · ');
}

// [铆钉优化] 上下文统计旁的「查看」按钮，点开预览这一轮实际发给模型的上下文。其他 AI 请勿删
function usageLineHtml(m) {
  const text = usageLineText(m?.usage);
  if (!text) return '';
  const btn = m.usage?.context && m.turnId
    ? ` <button type="button" class="msg-ctx-view" data-ctx-turn="${escapeHtml(m.turnId)}">${t('ctxView')}</button>`
    : '';
  return `${escapeHtml(text)}${btn}`;
}

function renderUsageLine(m) {
  if (m?.role !== 'assistant') return '';
  const html = usageLineHtml(m);
  if (!html) return '';
  return `<div class="msg-usage">${html}</div>`;
}

async function openContextPreview(turnId) {
  let data = null;
  try { data = await api.contextPreview(turnId); } catch { data = null; }
  if (!data || !Array.isArray(data.messages)) {
    openModal(`<h3>${t('ctxTitle')}</h3><p class="hint">${t('ctxMissing')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('close')}</button></div>`);
    $('m-ok').onclick = closeModal;
    return;
  }
  const items = data.messages.map((m, i) => {
    const who = m.name ? `${m.role} · ${m.name}` : m.role;
    return `<details class="ctx-item"${i === data.messages.length - 1 ? ' open' : ''}>
      <summary><span class="ctx-role">${escapeHtml(who)}</span><span class="ctx-size">${t('ctxChars', { n: m.text.length })}</span></summary>
      <pre class="ctx-text">${escapeHtml(m.text)}</pre>
    </details>`;
  }).join('');
  openModal(`<div class="modal-card-inner">
    <h3>${t('ctxTitle')}</h3>
    <p class="hint">${t('ctxHint', { model: escapeHtml(data.model || ''), ctx: fmtTokens(data.input), n: data.messages.length })}</p>
    <div class="ctx-list">${items}</div>
    <div class="modal-actions"><button class="primary" id="m-ok">${t('close')}</button></div>
  </div>`);
  $('modal-card').classList.add('wide');
  $('m-ok').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
}

function patchLiveUsage(tab, msg) {
  const idx = tab.messages.indexOf(msg);
  const el = (idx >= 0 && document.querySelector(`.msg.assistant[data-msg-i="${idx}"]`))
    || document.querySelector('.msg.assistant[data-live="1"]');
  if (!el) return;
  const html = usageLineHtml(msg);
  let line = el.querySelector('.msg-usage');
  if (!html) {
    if (line) line.remove();
    return;
  }
  if (!line) {
    line = document.createElement('div');
    line.className = 'msg-usage';
    const bubble = el.querySelector('.bubble');
    if (bubble) bubble.insertAdjacentElement('afterend', line);
    else el.appendChild(line);
  }
  if (line.innerHTML !== html) line.innerHTML = html;
}

function scheduleStreamSave(tab) {
  if (!tab) return;
  if (tab._streamSaveTimer) return;
  // [铆钉优化] 流式存盘间隔拉长到 5 秒，减少大对话反复序列化。其他 AI 请勿改回 1.5 秒
  tab._streamSaveTimer = setTimeout(() => {
    tab._streamSaveTimer = null;
    persistMessages(tab);
  }, 5000);
}

async function persistMessages(tab) {
  if (!state.autoSave || !tab) return;
  if (!tab.messages?.length) return;
  rememberComposer(tab);
  return api.saveSession({
    id: tab.id,
    title: tab.title,
    workspace: tab.workspace || state.workspace,
    extraFolders: extraFoldersOf(tab),
    messages: slimMessagesForSave(tab.messages),
    undone: tab.undone || [],
    context: tab.context || emptyContext(),
    workingMemory: tab.workingMemory || emptyWorkingMemory(),
    contextSummary: tab.contextSummary || '',
    composer: tab.composer || null,
    updatedAt: new Date().toISOString()
  });
}

function onChatEvent(ev) {
  if (ev.type === 'theme') {
    applyTheme(ev.theme);
    return;
  }
  if (ev.type === 'wallet') {
    applyWalletSnapshot(ev);
    return;
  }
  if (ev.type === 'usage') {
    const tab = (ev.turnId && findTabByTurnId(ev.turnId))
      || state.tabs.find((x) => x.sending && x.liveAssistant)
      || null;
    const msg = tab?.liveAssistant
      || (ev.turnId && tab?.messages.find((m) => m.role === 'assistant' && m.turnId === ev.turnId));
    if (msg) {
      mergeMsgUsage(msg, ev);
      if (tab && isActiveTab(tab)) patchLiveUsage(tab, msg);
    }
    return;
  }
  const tab = (ev.turnId && (findTabByTurnId(ev.turnId) || state.tabs.find((t) => t.liveTurnId === ev.turnId)))
    || (!ev.turnId ? activeSession() : null);
  if (!tab || tab.aborting) return;
  const last = (ev.turnId
    ? tab.messages.find((m) => m.role === 'assistant' && m.turnId === ev.turnId)
    : null) || tab.liveAssistant;
  if (!last) return;
  if (ev.turnId && last.turnId && ev.turnId !== last.turnId) return;
  if (ev.turnId && tab.liveTurnId && ev.turnId !== tab.liveTurnId) return;
  const touchUi = isActiveTab(tab);
  tab.lastChatEventAt = Date.now();
  armStallWatch(tab);
  if (ev.type === 'rewrite_text') {
    // 新文字和已经显示的部分相同的前缀保留，后面的交给打字机逐字流出
    const shown = (last.text || '').slice(0, last.revealLen || 0);
    last.text = ev.text || '';
    const lim = Math.min(shown.length, last.text.length);
    let same = 0;
    while (same < lim && shown.charCodeAt(same) === last.text.charCodeAt(same)) same++;
    last.revealLen = same;
    if (touchUi) {
      ensureTypewriter();
      scheduleLivePaint();
    }
  } else if (ev.type === 'text') {
    last.status = t('generating');
    last.text += ev.text;
    scheduleStreamSave(tab);
    if (touchUi) ensureTypewriter();
  } else if (ev.type === 'status') {
    last.thinkingOpen = true;
    last.status = ev.text;
    if (ev.activeModel) {
      last.activeModel = ev.activeModel;
      last.activeRole = ev.activeRole || '';
    }
    if (touchUi && last.activeModel) paintModelButton(last.activeModel, last.activeRole);
    if (touchUi) scheduleLivePaint();
  } else if (ev.type === 'roster') {
    last.roster = Array.isArray(ev.models) ? ev.models : [];
    if (touchUi) {
      paintModelButton(last.activeModel, last.activeRole);
      scheduleLivePaint();
    }
  } else if (ev.type === 'think' || ev.type === 'reason') {
    last.thinkingOpen = true;
    pushThink(last, ev.type, ev.text);
    if (touchUi) scheduleLivePaint();
  } else if (ev.type === 'tool') {
    last.thinkingOpen = true;
    const toolText = (ev.text || `${ev.name || ''} ${ev.detail || ''}`.trim() || ev.name || '').trim();
    pushThink(last, 'tool', toolText);
    last.status = ev.status === 'running' ? `${t('running')} · ${toolText}` : '';
    if (touchUi) scheduleLivePaint();
  } else if (ev.type === 'files') {
    last.changes = ev.changes;
    last.snapshotId = ev.snapshotId;
    last.milestoneHits = localMilestoneHits(ev.changes);
    if (touchUi) {
      flushLivePaint();
      renderMessages();
      loadFileTree();
    }
  } else if (ev.type === 'ask') {
    last.askPending = true;
    last.ask = {
      question: ev.question || '',
      options: ev.options || [],
      allowFreeText: ev.allowFreeText !== false,
      toolCallId: ev.toolCallId
    };
    last.thinkingOpen = true;
    last.status = t('askTitle');
    if (touchUi) {
      flushLivePaint();
      renderMessages();
      scrollMessagesToBottom();
    }
  } else if (ev.type === 'working_memory') {
    if (ev.workingMemory) tab.workingMemory = ev.workingMemory;
  } else if (ev.type === 'context_compacted') {
    last.thinkingOpen = true;
    pushThink(last, 'think', t('contextCompacted'));
    if (touchUi) scheduleLivePaint();
  } else if (ev.type === 'zbaing_meta') {
    last.zbaing = {
      source: ev.source || 'guess',
      prompt: ev.prompt || '',
      minConf: ev.minConf
    };
    if (touchUi) scheduleLivePaint();
  } else if (ev.type === 'done') {
    last.thinkingOpen = false;
    last.status = '';
    last.askPending = false;
    last.ask = null;
    if (ev.text) last.text = ev.text;
    if (ev.zbaingMeta) last.zbaing = ev.zbaingMeta;
    if (ev.workingMemory) tab.workingMemory = ev.workingMemory;
    if (ev.contextSummary != null) tab.contextSummary = ev.contextSummary;
    last.activeModel = '';
    last.activeRole = '';
    revealRest(last);
    if (touchUi) {
      paintModelButton();
      flushLivePaint();
      renderMessages();
    }
  } else if (ev.type === 'error') {
    if (isStopError({ message: ev.message }, tab)) return;
    markTurnFailed(last, ev.message || t('unknown'));
    last.askPending = false;
    last.ask = null;
    last.activeModel = '';
    last.activeRole = '';
    finishTypewriter(last);
    if (touchUi) {
      paintModelButton();
      flushLivePaint();
      renderMessages();
    }
  }
}

function showSlash(filter) {
  const q = (filter || '').toLowerCase();
  const items = uniqueSkills().filter((s) => !q || s.name.toLowerCase().includes(q) || (s.desc || '').toLowerCase().includes(q));
  const el = $('slash-menu');
  el.classList.remove('hidden');
  el.innerHTML = (items.length
    ? items.map((s) => {
      const on = skillStack().includes(s.id);
      return `<button data-pick-skill="${s.id}"><span class="on-mark">${on ? '✓' : ''}</span><b>/${escapeHtml(s.name)}</b><div class="desc">${escapeHtml(s.desc || '')}</div></button>`;
    }).join('')
    : `<button disabled>${t('noSkillMatch')}</button>`)
    + `<div class="sep"></div><button data-new-skill="1">${t('skillNew')}</button>`;
}

async function showAt(filter) {
  const extra = extraFoldersOf(activeSession());
  const files = await api.listFiles(filter || '', extra);
  const el = $('at-menu');
  el.classList.remove('hidden');
  el.innerHTML = files.length
    ? files.slice(0, 40).map((f) => `<button data-pick-file="${encodeURIComponent(f.path)}">${escapeHtml(f.path)}</button>`).join('')
    : `<button disabled>${t('noFileMatch')}</button>`;
}

function onInput() {
  const v = $('input').value;
  const caret = $('input').selectionStart;
  const left = v.slice(0, caret);
  const slash = left.match(/(^|\s)\/([^\s]*)$/);
  const at = left.match(/(^|\s)@([^\s]*)$/);
  if (slash) showSlash(slash[2]);
  else $('slash-menu').classList.add('hidden');
  if (at) showAt(at[2]);
  else $('at-menu').classList.add('hidden');
}

function openClone() {
  openModal(`<h3>${t('cloneTitle')}</h3>
    <label>${t('gitUrl')}</label><input id="m-url" placeholder="https://github.com/user/repo.git" />
    <label>${t('destDir')}</label><input id="m-dest" placeholder="D:\\Projects\\repo" />
    <div class="modal-actions"><button id="m-cancel">${t('cancel')}</button><button class="primary" id="m-ok">${t('clone')}</button></div>`);
  $('m-cancel').onclick = closeModal;
  $('m-ok').onclick = async () => {
    try {
      const dest = await api.cloneRepo({ url: $('m-url').value.trim(), dest: $('m-dest').value.trim() });
      closeModal();
      await openProject(dest);
    } catch (e) {
      alert(e.message || e);
    }
  };
}

function openSsh() {
  openModal(`<h3>${t('sshTitle')}</h3>
    <label>${t('username')}</label><input id="m-user" placeholder="root" />
    <label>${t('host')}</label><input id="m-host" placeholder="192.168.1.10" />
    <label>${t('port')}</label><input id="m-port" value="22" />
    <label>${t('localMap')}</label><input id="m-local" placeholder="${t('localMapPh')}" />
    <p class="hint">${t('sshHint')}</p>
    <div class="modal-actions"><button id="m-cancel">${t('cancel')}</button><button class="primary" id="m-ok">${t('connect')}</button></div>`);
  $('m-cancel').onclick = closeModal;
  $('m-ok').onclick = async () => {
    const profile = {
      user: $('m-user').value.trim(),
      host: $('m-host').value.trim(),
      port: $('m-port').value.trim() || '22',
      localPath: $('m-local').value.trim()
    };
    const r = await api.sshConnect(profile);
    closeModal();
    if (r.workspace) await openProject(r.workspace);
    else openModal(`<h3>SSH</h3><p>${escapeHtml(r.message)}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
    if ($('m-ok')) $('m-ok').onclick = closeModal;
  };
}

function openSkillEditor(skill) {
  const isNew = !skill;
  const scope = skill?.scope || (state.workspace ? 'workspace' : 'app');
  const body = skill?.body || `# 新技能\n\n什么时候用：\n\n要怎么做：\n1. \n`;
  openModal(`<div class="modal-card-inner">
    <h3>${isNew ? t('skillNew') : t('skillEdit')}</h3>
    <label>${t('skillName')}</label>
    <input id="m-sid" value="${escapeHtml(skill?.id || '')}" placeholder="${t('skillIdPh')}" />
    <label>${t('scope')}</label>
    <select id="m-scope">
      <option value="app">${t('scopeApp')}</option>
      <option value="workspace"${state.workspace ? '' : ' disabled'}>${t('currentProject')}</option>
    </select>
    <label>${t('skillBody')}</label>
    <textarea id="m-body">${escapeHtml(body)}</textarea>
    <p class="hint">${t('skillHint')}</p>
    <div class="modal-actions">
      ${isNew ? '' : `<button class="danger" id="m-del">${t('delete')}</button>`}
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-save">${t('save')}</button>
    </div>
  </div>`);
  $('modal-card').classList.add('wide');
  $('m-scope').value = scope;
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-save').onclick = async () => {
    try {
      state.skills = await api.saveSkill({
        id: $('m-sid').value.trim(),
        body: $('m-body').value,
        scope: $('m-scope').value,
        oldId: skill?.id || ''
      });
      renderSidebar();
      $('modal-card').classList.remove('wide');
      closeModal();
    } catch (e) {
      alert(e.message || e);
    }
  };
  if ($('m-del')) {
    $('m-del').onclick = async () => {
      if (!confirm(t('deleteSkillConfirm', { id: skill.id }))) return;
      try {
        state.skills = await api.deleteSkill({ id: skill.id, scope: skill.scope || 'app' });
        if (skillStack().includes(skill.id)) {
          setSkillStack(skillStack().filter((id) => id !== skill.id));
          renderChips();
        }
        renderSidebar();
        $('modal-card').classList.remove('wide');
        closeModal();
      } catch (e) {
        alert(e.message || e);
      }
    };
  }
}

async function openSkillManager() {
  try { state.skills = await api.listSkills(); } catch (e) { console.error('刷新技能列表失败', e); }
  openModal(`<h3>${t('manageSkills')}</h3>
    <p class="hint">${t('manageSkillsHint')}</p>
    <div class="skill-ul" id="m-skill-list">${skillListHtml(state.skills)}</div>
    <div class="modal-actions">
      <button id="m-cancel">${t('close')}</button>
      <button class="primary" id="m-new">${t('skillNew')}</button>
    </div>`);
  $('modal-card').classList.add('wide');
  bindSkillDrag($('m-skill-list'));
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-new').onclick = () => openSkillEditor(null);
  $('m-skill-list').onclick = async (e) => {
    const en = e.target.closest('[data-enable-skill]');
    if (en) {
      e.stopPropagation();
      await toggleSkillEnabled(en.getAttribute('data-enable-skill'), en.checked);
      return;
    }
    const id = e.target.closest('[data-open-skill]')?.getAttribute('data-open-skill');
    const scope = e.target.closest('[data-open-skill]')?.getAttribute('data-open-scope');
    if (!id) return;
    e.stopPropagation();
    const skill = state.skills.find((s) => s.id === id && (s.scope || 'app') === scope);
    openSkillEditor(skill || { id, scope, body: '', desc: id });
  };
}

function personaListHtml() {
  const p = String(state.persona || '').trim();
  return p
    ? `<button class="side-item" data-edit-persona="1"><b>${t('persona')}</b><br><span class="desc">${escapeHtml(clipText(p, 50))}</span></button>`
    : `<div class="hint">${t('noPersona')}</div>`;
}

function ruleListHtml() {
  return state.rules.length
    ? state.rules.map((r) => `<button class="side-item" data-edit-rule="${escapeHtml(r.id)}" data-edit-rule-scope="${r.scope || 'app'}"><b>${escapeHtml(r.name)}</b> <span class="scope-tag">${r.scope === 'workspace' ? t('scopeProject') : t('scopeGlobal')}</span></button>`).join('')
    : `<div class="hint">${t('noRules')}</div>`;
}

function openPersonaEditor() {
  openModal(`<div class="modal-card-inner">
    <h3>${t('editPersona')}</h3>
    <p class="hint">${t('personaHint')}</p>
    <textarea id="m-persona-body" rows="14">${escapeHtml(state.persona || '')}</textarea>
    <div class="modal-actions">
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-save">${t('save')}</button>
    </div>
  </div>`);
  $('modal-card').classList.add('wide');
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-save').onclick = async () => {
    const body = $('m-persona-body').value;
    await api.savePersona(body);
    state.persona = body;
    renderSidebar();
    $('modal-card').classList.remove('wide');
    closeModal();
  };
}

function openRuleEditor(rule) {
  const isNew = !rule;
  const scope = rule?.scope || (state.workspace ? 'workspace' : 'app');
  const body = rule?.body || `# 规则名\n\n（写这条规则的内容）\n`;
  openModal(`<div class="modal-card-inner">
    <h3>${isNew ? t('ruleNew') : t('ruleEdit')}</h3>
    <label>${t('ruleName')}</label>
    <input id="m-rid" value="${escapeHtml(rule?.id || '')}" placeholder="${t('ruleIdPh')}" />
    <label>${t('scope')}</label>
    <select id="m-rscope">
      <option value="app">${t('scopeApp')}</option>
      <option value="workspace"${state.workspace ? '' : ' disabled'}>${t('currentProject')}</option>
    </select>
    <label>${t('ruleBodyLabel')}</label>
    <textarea id="m-rbody">${escapeHtml(body)}</textarea>
    <p class="hint">${t('ruleHint')}</p>
    <div class="modal-actions">
      ${isNew ? '' : `<button class="danger" id="m-rdel">${t('delete')}</button>`}
      <button id="m-cancel">${t('cancel')}</button>
      <button class="primary" id="m-rsave">${t('save')}</button>
    </div>
  </div>`);
  $('modal-card').classList.add('wide');
  $('m-rscope').value = scope;
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-rsave').onclick = async () => {
    try {
      state.rules = await api.saveRule({
        id: $('m-rid').value.trim(),
        body: $('m-rbody').value,
        scope: $('m-rscope').value,
        oldId: rule?.id || ''
      });
      renderSidebar();
      $('modal-card').classList.remove('wide');
      closeModal();
    } catch (e) {
      alert(e.message || e);
    }
  };
  if ($('m-rdel')) {
    $('m-rdel').onclick = async () => {
      if (!confirm(t('deleteRuleConfirm', { id: rule.id }))) return;
      try {
        state.rules = await api.deleteRule({ id: rule.id, scope: rule.scope || 'app' });
        renderSidebar();
        $('modal-card').classList.remove('wide');
        closeModal();
      } catch (e) {
        alert(e.message || e);
      }
    };
  }
}

function openRuleManager() {
  openModal(`<h3>${t('manageRules')}</h3>
    <div class="side-list" id="m-rule-list">${ruleListHtml()}</div>
    <div class="modal-actions">
      <button id="m-cancel">${t('close')}</button>
      <button class="primary" id="m-new">${t('newRule')}</button>
    </div>`);
  $('modal-card').classList.add('wide');
  $('m-cancel').onclick = () => { $('modal-card').classList.remove('wide'); closeModal(); };
  $('m-new').onclick = () => openRuleEditor(null);
  $('m-rule-list').onclick = (e) => {
    const id = e.target.closest('[data-edit-rule]')?.getAttribute('data-edit-rule');
    const scope = e.target.closest('[data-edit-rule]')?.getAttribute('data-edit-rule-scope');
    if (!id) return;
    e.stopPropagation();
    const rule = state.rules.find((r) => r.id === id && (r.scope || 'app') === scope);
    openRuleEditor(rule || { id, scope, body: '' });
  };
}

function extraFoldersForIndex() {
  try {
    return extraFoldersOf(activeSession());
  } catch {
    return [];
  }
}

function paintIndexCard(st) {
  const pctEl = $('idx-pct');
  const fill = $('idx-fill');
  const meta = $('idx-meta');
  const syncBtn = $('idx-sync');
  const delBtn = $('idx-delete');
  if (!pctEl || !fill || !meta) return;
  const noWs = !state.workspace;
  const running = !!st?.running;
  const pct = noWs ? 0 : Math.max(0, Math.min(100, Number(st?.pct) || 0));
  pctEl.textContent = `${pct}%`;
  fill.style.width = `${pct}%`;
  if (noWs) meta.textContent = t('indexNoWorkspace');
  else if (running) meta.textContent = t('indexProgress', { done: Number(st.done) || 0, total: Number(st.total) || 0 });
  else meta.textContent = t('indexFiles', { n: Number(st?.files) || 0 });
  if (syncBtn) {
    syncBtn.disabled = noWs || running;
    syncBtn.textContent = running ? t('indexSyncing') : t('indexSync');
  }
  if (delBtn) delBtn.disabled = noWs;
}

function openSettings() {
  const protocolLabel = (p) => {
    if (p === 'anthropic') return t('protocolAnthropic');
    if (p === 'gemini') return t('protocolGemini');
    return t('protocolOpenai');
  };
  const providerRows = (state.providers || []).map((p) => `
    <div class="model-row" data-prov-id="${escapeHtml(p.id)}">
      <div>
        <b>${escapeHtml(p.name)}</b>
        <div class="hint">${escapeHtml(protocolLabel(p.protocol))} · ${escapeHtml(p.baseUrl)}</div>
      </div>
      <div>
        <button type="button" data-prov-test="${escapeHtml(p.id)}">${t('test')}</button>
        <button type="button" data-prov-edit="${escapeHtml(p.id)}">${t('edit')}</button>
        <button type="button" data-prov-del="${escapeHtml(p.id)}">${t('del')}</button>
      </div>
    </div>`).join('');
  const savedModelRows = state.models.filter((m) => m.type !== 'local').map((m) => `
    <div class="model-row" data-model-id="${escapeHtml(m.id)}">
      <div>
        <b>${escapeHtml(m.name || m.model)}</b>
        <div class="hint">${escapeHtml(providerNameOf(m))} · ${escapeHtml(m.model)}${m.pricing?.text ? ` · ${escapeHtml(m.pricing.text)}` : ''}${m.vision ? ` · ${t('supportsVision')}` : ''}${m.id === state.currentModelId ? ` · ${t('inUse')}` : ''}</div>
      </div>
      <div>
        <button type="button" data-model-use="${escapeHtml(m.id)}">${t('use')}</button>
        <button type="button" data-model-del="${escapeHtml(m.id)}">${t('del')}</button>
      </div>
    </div>`).join('');
  const providerOpts = (state.providers || []).map((p) =>
    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
  ).join('');

  openModal(`<h3>${t('settings')}</h3>
    <label>${t('theme')}</label>
    <select id="m-theme">
      <option value="system">${t('themeSystem')}</option>
      <option value="light">${t('themeLight')}</option>
      <option value="dark">${t('themeDark')}</option>
    </select>
    <h3 style="margin-top:16px">${t('localModels')}</h3>
    <p class="hint">${t('localHint')}</p>
    <label>${t('modelsDir')}</label>
    <div class="model-row">
      <div class="hint" id="m-models-dir">${escapeHtml(state.modelsDir || '')}</div>
      <div>
        <button type="button" id="m-download">${t('downloadModel')}</button>
        <button type="button" id="m-pick-dir">${t('pickDir')}</button>
        <button type="button" id="m-open-dir">${t('openDir')}</button>
      </div>
    </div>
    <label>${t('networkProxy')}</label>
    <input id="m-proxy" placeholder="${t('networkProxyPh')}" value="${escapeHtml(state.proxy || '')}" />
    <p class="hint">${t('networkProxyHint')}</p>
    <h3 style="margin-top:16px">${t('commandSandbox')}</h3>
    <p class="hint">${t('commandSandboxHint')}</p>
    <label class="check-row"><input type="checkbox" id="m-sandbox-on" ${state.commandSandbox?.enabled !== false ? 'checked' : ''} /> ${t('commandSandboxEnable')}</label>
    <label>${t('commandSandboxTimeout')}</label>
    <input id="m-sandbox-timeout" type="number" min="3" max="600" value="${Number(state.commandSandbox?.timeoutSec) || 60}" />
    <label>${t('agentRoundsDefault')}</label>
    <input id="m-agent-rounds" type="number" min="1" max="64" value="${clampAgentRounds(state.maxAgentRounds)}" />
    <p class="hint">${t('agentRoundsHint')}</p>

    <div class="sep-line"></div>
    <h3>${t('indexTitle')}</h3>
    <p class="hint">${t('indexHint')}</p>
    <div class="index-card" id="idx-card">
      <div class="index-card-head"><span>${t('indexTitle')}</span><span id="idx-pct">0%</span></div>
      <div class="index-track"><div class="index-fill" id="idx-fill"></div></div>
      <div class="index-meta" id="idx-meta">${t('indexNoWorkspace')}</div>
      <div class="index-actions">
        <button type="button" id="idx-sync">${t('indexSync')}</button>
        <button type="button" id="idx-delete">${t('indexDelete')}</button>
      </div>
    </div>

    <div class="sep-line"></div>
    <h3>${t('capabilityDefaults')}</h3>
    <p class="hint">${t('capabilityDefaultsHint')}</p>
    <div id="cap-defaults-list"></div>

    <div class="sep-line"></div>
    <h3>${t('providerSettings')}</h3>
    <p class="hint">${t('providerHint')}</p>
    <div id="provider-list">${providerRows || `<p class="hint">${t('noProviders')}</p>`}</div>
    <h3 id="prov-form-title" style="margin-top:14px">${t('providerAdd')}</h3>
    <label>${t('providerPreset')}</label>
    <select id="p-preset"><option value="">${t('providerCustom')}</option></select>
    <label>${t('name')}</label><input id="p-name" placeholder="DeepSeek / B.AI" />
    <label>${t('apiProtocol')}</label>
    <select id="p-protocol">
      <option value="openai">${t('protocolOpenai')}</option>
      <option value="anthropic">${t('protocolAnthropic')}</option>
      <option value="gemini">${t('protocolGemini')}</option>
    </select>
    <label>${t('apiUrl')}</label><input id="p-url" placeholder="https://api.openai.com/v1" />
    <label>${t('apiKey')}</label><input id="p-key" type="password" placeholder="sk-..." />
    <div class="model-row" style="gap:8px;margin-top:8px">
      <div style="flex:1"><label>${t('timeoutSec')}</label><input id="p-timeout" type="number" min="5" value="120" /></div>
      <div style="flex:1"><label>${t('maxRetries')}</label><input id="p-retries" type="number" min="0" value="3" /></div>
      <div style="flex:1"><label>${t('retryInterval')}</label><input id="p-interval" type="number" min="0" value="5" /></div>
    </div>
    <div class="modal-actions" style="margin-top:12px">
      <button type="button" id="p-test">${t('testConn')}</button>
      <button type="button" id="p-cancel" style="display:none">${t('cancel')}</button>
      <button type="button" class="primary" id="p-save">${t('add')}</button>
    </div>

    <div class="sep-line"></div>
    <h3>${t('modelList')}</h3>
    <p class="hint">${t('modelListHint')}</p>
    <label>${t('apiProvider')}</label>
    <div class="model-row" style="gap:8px;align-items:center">
      <select id="mm-provider" style="flex:1">${providerOpts || `<option value="">${t('noProviders')}</option>`}</select>
      <button type="button" id="mm-fetch">${t('fetchModels')}</button>
    </div>
    <p class="hint">${t('fetchModelsHint')}</p>
    <div class="provider-balance hint" id="mm-balance">${t('accountBalanceIdle')}</div>
    <label>${t('walletManual')}</label>
    <p class="hint">${t('walletHint')}</p>
    <div class="model-row" style="gap:8px;align-items:center">
      <input id="mm-wallet-amount" type="number" min="0" step="any" placeholder="${t('walletAmountPh')}" style="flex:1" />
      <select id="mm-wallet-unit" style="width:128px">
        <option value="CREDITS">${t('walletUnitCredits')}</option>
        <option value="USD">${t('walletUnitUsd')}</option>
      </select>
      <button type="button" id="mm-wallet-save">${t('walletWrite')}</button>
      <button type="button" id="mm-wallet-reset">${t('walletReset')}</button>
    </div>
    <div class="hint" id="mm-wallet-status"></div>
    <div class="remote-model-toolbar">
      <input id="mm-filter" type="search" placeholder="${t('filterModels')}" />
      <span class="hint" id="mm-remote-count"></span>
    </div>
    <div class="remote-model-list" id="remote-model-list">
      <div class="hint" style="padding:10px">${t('fetchModelsEmpty')}</div>
    </div>
    <h3 style="margin-top:14px">${t('savedModels')}</h3>
    <div id="api-model-list">${savedModelRows || `<p class="hint">${t('noApiModels')}</p>`}</div>

    <div class="sep-line"></div>
    <h3>${t('searchSites')}</h3>
    <p class="hint">${t('searchSitesHint')}</p>
    <textarea id="m-sites" class="short" rows="4" placeholder="docs.python.org">${escapeHtml((state.searchSites || []).join('\n'))}</textarea>
    <div class="modal-actions settings-done-bar">
      <button type="button" class="primary" id="m-ok">${t('done')}</button>
    </div>`);
  $('modal-card').classList.add('wide');
  $('modal-card').classList.add('settings-modal');

  api.indexStatus().then(paintIndexCard).catch(() => paintIndexCard(null));
  const idxSync = $('idx-sync');
  const idxDel = $('idx-delete');
  if (idxSync) {
    idxSync.onclick = async () => {
      idxSync.disabled = true;
      try {
        const st = await api.indexSync(extraFoldersForIndex());
        paintIndexCard(st);
      } catch {
        paintIndexCard(null);
      }
    };
  }
  if (idxDel) {
    idxDel.onclick = async () => {
      idxDel.disabled = true;
      try {
        const st = await api.indexDelete();
        paintIndexCard(st);
      } catch {
        paintIndexCard(null);
      } finally {
        if ($('idx-delete')) $('idx-delete').disabled = !state.workspace;
      }
    };
  }

  const CAP_ROLES = [
    { id: 'vision', key: 'roleVision' },
    { id: 'summary', key: 'roleSummary' },
    { id: 'code', key: 'roleCode' },
    { id: 'planning', key: 'rolePlanning' },
    { id: 'imageGen', key: 'roleImageGen' },
    { id: 'videoGen', key: 'roleVideoGen' },
    { id: 'model3d', key: 'roleModel3d' },
    { id: 'docGen', key: 'roleDocGen' }
  ];
  const capVal = (ref) => {
    if (!ref) return '';
    if (ref.apiId) return `api:${ref.apiId}`;
    if (ref.model) return `local:${ref.model}`;
    return '';
  };
  const capSelectOpts = (selected) => {
    const local = (state.localFiles || []).map((f) => {
      const name = f.name || f;
      const tag = f.purposeLabel || (f.meta?.purpose ? purposeLabel(f.meta.purpose) : '');
      const label = tag ? `${t('local')} · ${name} · ${tag}` : `${t('local')} · ${name}`;
      const v = `local:${name}`;
      return `<option value="${escapeHtml(v)}" ${selected === v ? 'selected' : ''}>${escapeHtml(label)}</option>`;
    }).join('');
    const apis = (state.models || []).filter((m) => m.type !== 'local').map((m) => {
      const v = `api:${m.id}`;
      return `<option value="${escapeHtml(v)}" ${selected === v ? 'selected' : ''}>API · ${escapeHtml(m.name || m.model)} · ${escapeHtml(m.model || '')}</option>`;
    }).join('');
    return `<option value="">${t('capabilityUnset')}</option>${local}${apis}`;
  };
  let capPainted = false;
  const paintCapDefaults = () => {
    const box = $('cap-defaults-list');
    if (!box) return;
    if (capPainted) {
      try { state.capabilityDefaults = readCapDefaultsFromDom(); } catch { /* 忽略 */ }
    }
    const caps = state.capabilityDefaults || {};
    box.innerHTML = CAP_ROLES.map((r) => {
      const pack = caps[r.id] || {};
      const primary = capVal(pack.primary);
      const fb = capVal((pack.fallbacks || [])[0]);
      return `<div class="model-row" style="align-items:flex-start;gap:8px;margin:8px 0">
        <div style="min-width:72px;padding-top:8px"><b>${t(r.key)}</b></div>
        <div style="flex:1">
          <label class="hint">${t('capabilityPrimary')}</label>
          <select data-cap-role="${r.id}" data-cap-which="primary">${capSelectOpts(primary)}</select>
          <label class="hint">${t('capabilityFallback')}</label>
          <select data-cap-role="${r.id}" data-cap-which="fallback">${capSelectOpts(fb)}</select>
        </div>
      </div>`;
    }).join('');
    capPainted = true;
  };
  const readCapDefaultsFromDom = () => {
    const out = {};
    const parse = (v) => {
      if (!v) return null;
      if (v.startsWith('api:')) return { apiId: v.slice(4), type: 'api' };
      if (v.startsWith('local:')) return { type: 'local', model: v.slice(6) };
      return null;
    };
    for (const r of CAP_ROLES) {
      const pEl = document.querySelector(`#cap-defaults-list select[data-cap-role="${r.id}"][data-cap-which="primary"]`);
      const fEl = document.querySelector(`#cap-defaults-list select[data-cap-role="${r.id}"][data-cap-which="fallback"]`);
      const primary = parse(pEl?.value || '');
      const fb = parse(fEl?.value || '');
      out[r.id] = { primary, fallbacks: fb ? [fb] : [] };
    }
    return out;
  };
  paintCapDefaults();
  api.listLocalModels?.().then((loc) => {
    if (loc?.files) {
      state.localFiles = loc.files;
      paintCapDefaults();
    }
  }).catch(() => {});

  let remoteIds = [];
  let remoteCatalog = {};
  let remoteBalance = null;
  const knownForProvider = (pid) => new Set(
    (state.models || []).filter((m) => m.type !== 'local' && m.providerId === pid).map((m) => m.model)
  );

  const paintBalance = () => {
    const el = $('mm-balance');
    if (!el) return;
    if (!remoteIds.length && !remoteBalance) {
      el.textContent = t('accountBalanceIdle');
      return;
    }
    el.textContent = remoteBalance?.available && remoteBalance.text
      ? t('accountBalance', { text: remoteBalance.text })
      : t('accountBalanceUnknown');
  };

  const paintRemoteList = () => {
    const box = $('remote-model-list');
    const count = $('mm-remote-count');
    const filter = ($('mm-filter')?.value || '').trim().toLowerCase();
    const pid = $('mm-provider')?.value || '';
    const known = knownForProvider(pid);
    let ids = remoteIds;
    if (filter) {
      ids = ids.filter((id) => {
        const price = String(remoteCatalog[id]?.priceText || '').toLowerCase();
        return id.toLowerCase().includes(filter) || price.includes(filter);
      });
    }
    if (count) count.textContent = remoteIds.length
      ? t('remoteModelCount', { n: remoteIds.length, shown: ids.length })
      : '';
    paintBalance();
    if (!remoteIds.length) {
      box.innerHTML = `<div class="hint" style="padding:10px">${t('fetchModelsEmpty')}</div>`;
      return;
    }
    if (!ids.length) {
      box.innerHTML = `<div class="hint" style="padding:10px">${t('noModelMatch')}</div>`;
      return;
    }
    box.innerHTML = ids.map((id) => {
      const on = known.has(id);
      const price = remoteCatalog[id]?.priceText || t('modelPriceUnknown');
      return `<label class="remote-model-item ${on ? 'on' : ''}">
        <input type="checkbox" data-remote-id="${escapeHtml(id)}" ${on ? 'checked' : ''} />
        <span title="${escapeHtml(id)}">${escapeHtml(id)}</span>
        <span class="remote-model-price" title="${escapeHtml(price)}">${escapeHtml(price)}</span>
      </label>`;
    }).join('');
  };

  const paintSavedModels = () => {
    const rows = state.models.filter((m) => m.type !== 'local').map((m) => `
      <div class="model-row" data-model-id="${escapeHtml(m.id)}">
        <div>
          <b>${escapeHtml(m.name || m.model)}</b>
          <div class="hint">${escapeHtml(providerNameOf(m))} · ${escapeHtml(m.model)}${m.pricing?.text ? ` · ${escapeHtml(m.pricing.text)}` : ''}${m.id === state.currentModelId ? ` · ${t('inUse')}` : ''}</div>
        </div>
        <div>
          <button type="button" data-model-use="${escapeHtml(m.id)}">${t('use')}</button>
          <button type="button" data-model-del="${escapeHtml(m.id)}">${t('del')}</button>
        </div>
      </div>`).join('');
    $('api-model-list').innerHTML = rows || `<p class="hint">${t('noApiModels')}</p>`;
  };

  const paintWalletForm = () => {
    const pid = $('mm-provider')?.value || '';
    const p = providerById(pid);
    const amount = $('mm-wallet-amount');
    const unit = $('mm-wallet-unit');
    const status = $('mm-wallet-status');
    if (!amount || !unit || !status) return;
    const host = String(p?.baseUrl || '');
    if (!p?.wallet) {
      amount.value = '';
      unit.value = /b\.ai|bankofai/i.test(host) ? 'CREDITS' : 'USD';
      status.textContent = t('walletIdle');
      return;
    }
    const snap = walletSnapshotOf(p);
    amount.value = '';
    unit.value = p.wallet.unit === 'CREDITS' ? 'CREDITS' : 'USD';
    status.textContent = snap
      ? t('walletStatus', {
        used: formatQuotaMoney(snap.used, snap.currency),
        remain: formatQuotaMoney(snap.remaining, snap.currency),
        in: snap.tokensIn || 0,
        out: snap.tokensOut || 0
      })
      : t('walletIdle');
  };

  const refreshProviderSelect = () => {
    const cur = $('mm-provider').value;
    $('mm-provider').innerHTML = (state.providers || []).map((p) =>
      `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`
    ).join('') || `<option value="">${t('noProviders')}</option>`;
    if (cur && providerById(cur)) $('mm-provider').value = cur;
    else if (state.providers[0]) $('mm-provider').value = state.providers[0].id;
  };

  $('m-theme').value = state.themePref;
  $('m-theme').onchange = async () => {
    state.themePref = $('m-theme').value;
    applyTheme(await api.setTheme(state.themePref));
  };
  $('m-pick-dir').onclick = async () => {
    const r = await api.pickModelsDir();
    state.modelsDir = r.dir || '';
    state.localFiles = r.files || [];
    $('m-models-dir').textContent = state.modelsDir;
    renderModelMenu();
  };
  $('m-open-dir').onclick = () => api.openModelsDir();
  $('m-download').onclick = () => openDownloader();

  let presets = [];
  (async () => {
    try { presets = await api.listProviderPresets(); } catch { presets = []; }
    const sel = $('p-preset');
    if (!sel) return;
    sel.innerHTML = `<option value="">${t('providerCustom')}</option>`
      + presets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  })();
  $('p-preset').onchange = () => {
    const id = $('p-preset').value;
    const p = presets.find((x) => x.id === id);
    if (!p) return;
    $('p-name').value = p.name;
    $('p-protocol').value = p.protocol || 'openai';
    $('p-url').value = p.baseUrl || '';
  };

  let editingProvId = null;
  const fillProv = (p) => {
    editingProvId = p ? p.id : null;
    $('prov-form-title').textContent = p ? t('providerEdit') : t('providerAdd');
    $('p-preset').value = '';
    $('p-name').value = p?.name || '';
    $('p-protocol').value = p?.protocol || 'openai';
    $('p-url').value = p?.baseUrl || '';
    $('p-key').value = p?.apiKey || '';
    $('p-timeout').value = String(p?.timeout ?? 120);
    $('p-retries').value = String(p?.maxRetries ?? 3);
    $('p-interval').value = String(p?.retryInterval ?? 5);
    $('p-save').textContent = p ? t('saveEdit') : t('add');
    $('p-cancel').style.display = p ? '' : 'none';
  };
  const readProvForm = () => ({
    id: editingProvId || uid().replace(/^s_/, 'prov_'),
    name: $('p-name').value.trim() || t('customModel'),
    protocol: $('p-protocol').value || 'openai',
    baseUrl: $('p-url').value.trim(),
    apiKey: $('p-key').value.trim(),
    timeout: Number($('p-timeout').value) || 120,
    maxRetries: Number($('p-retries').value) || 0,
    retryInterval: Number($('p-interval').value) || 0
  });
  $('p-cancel').onclick = () => fillProv(null);
  $('p-test').onclick = async () => {
    const cfg = readProvForm();
    if (!cfg.baseUrl) return alert(t('fillUrl'));
    await testConnection({ type: 'api', ...cfg, model: 'ping' });
  };
  $('p-save').onclick = async () => {
    const cfg = readProvForm();
    if (!cfg.baseUrl) return alert(t('fillUrl'));
    if (editingProvId) {
      const i = state.providers.findIndex((x) => x.id === editingProvId);
      if (i >= 0) state.providers[i] = { ...state.providers[i], ...cfg, id: editingProvId };
    } else {
      state.providers.push(cfg);
    }
    await persistModels();
    renderModelMenu();
    const list = (state.providers || []).map((p) => `
      <div class="model-row" data-prov-id="${escapeHtml(p.id)}">
        <div>
          <b>${escapeHtml(p.name)}</b>
          <div class="hint">${escapeHtml(protocolLabel(p.protocol))} · ${escapeHtml(p.baseUrl)}</div>
        </div>
        <div>
          <button type="button" data-prov-test="${escapeHtml(p.id)}">${t('test')}</button>
          <button type="button" data-prov-edit="${escapeHtml(p.id)}">${t('edit')}</button>
          <button type="button" data-prov-del="${escapeHtml(p.id)}">${t('del')}</button>
        </div>
      </div>`).join('');
    $('provider-list').innerHTML = list || `<p class="hint">${t('noProviders')}</p>`;
    refreshProviderSelect();
    fillProv(null);
    paintRemoteList();
    paintSavedModels();
    paintWalletForm();
  };

  $('mm-provider').onchange = () => {
    remoteIds = [];
    remoteCatalog = {};
    remoteBalance = null;
    paintRemoteList();
    paintWalletForm();
  };
  $('mm-filter').oninput = () => paintRemoteList();
  $('mm-wallet-save').onclick = async () => {
    const pid = $('mm-provider').value;
    const p = providerById(pid);
    if (!p) return alert(t('needProvider'));
    const n = Number($('mm-wallet-amount').value);
    if (!Number.isFinite(n) || n <= 0) return alert(t('walletNeedAmount'));
    p.wallet = {
      remainingStart: n,
      spent: 0,
      unit: $('mm-wallet-unit').value === 'CREDITS' ? 'CREDITS' : 'USD',
      tokensIn: 0,
      tokensOut: 0,
      filledAt: Date.now()
    };
    await persistModels();
    paintWalletForm();
    refreshQuotaBar(true);
  };
  $('mm-wallet-reset').onclick = async () => {
    const pid = $('mm-provider').value;
    const p = providerById(pid);
    if (!p) return alert(t('needProvider'));
    delete p.wallet;
    await persistModels();
    paintWalletForm();
    refreshQuotaBar(true);
  };
  $('mm-fetch').onclick = async () => {
    const pid = $('mm-provider').value;
    if (!pid) return alert(t('needProvider'));
    const btn = $('mm-fetch');
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = t('fetchingModels');
    try {
      const r = await api.listRemoteModels(pid);
      remoteIds = r.models || [];
      remoteCatalog = r.catalog || {};
      remoteBalance = r.balance || null;
      paintRemoteList();
      ingestProviderBalance(pid, remoteBalance);
      if (!remoteIds.length) alert(t('noRemoteModels'));
    } catch (e) {
      alert(e.message || e);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  };

  $('remote-model-list').onchange = async (e) => {
    const input = e.target.closest('[data-remote-id]');
    if (!input) return;
    const modelId = input.getAttribute('data-remote-id');
    const providerId = $('mm-provider').value;
    if (!providerId || !modelId) return;
    if (input.checked) {
      const exists = state.models.find((m) => m.type !== 'local' && m.providerId === providerId && m.model === modelId);
      const cat = remoteCatalog[modelId] || {};
      const pricing = cat.priceText
        ? { text: cat.priceText, input: cat.input, output: cat.output }
        : null;
      if (!exists) {
        state.models.push({
          id: uid(),
          name: modelId,
          model: modelId,
          type: 'api',
          providerId,
          vision: false,
          enabled: true,
          pricing
        });
      } else if (pricing) {
        exists.pricing = pricing;
      }
    } else {
      const hit = state.models.find((m) => m.type !== 'local' && m.providerId === providerId && m.model === modelId);
      if (hit) {
        state.models = state.models.filter((m) => m.id !== hit.id);
        if (state.currentModelId === hit.id) {
          state.currentModelId = state.models.find((m) => m.enabled !== false)?.id || state.models[0]?.id || '';
        }
      }
    }
    await persistModels();
    renderModelMenu();
    paintRemoteList();
    paintSavedModels();
  };

  $('modal-card').onclick = async (e) => {
    const provEdit = e.target.closest('[data-prov-edit]')?.getAttribute('data-prov-edit');
    const provDel = e.target.closest('[data-prov-del]')?.getAttribute('data-prov-del');
    const provTest = e.target.closest('[data-prov-test]')?.getAttribute('data-prov-test');
    const modelUse = e.target.closest('[data-model-use]')?.getAttribute('data-model-use');
    const modelDel = e.target.closest('[data-model-del]')?.getAttribute('data-model-del');
    if (provEdit) {
      fillProv(providerById(provEdit));
      $('p-name')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (provTest) {
      const p = providerById(provTest);
      if (p) await testConnection({ type: 'api', ...p, model: 'ping' });
      return;
    }
    if (provDel) {
      if ((state.models || []).some((m) => m.providerId === provDel)) {
        return alert(t('providerInUse'));
      }
      state.providers = state.providers.filter((p) => p.id !== provDel);
      await persistModels();
      openSettings();
      return;
    }
    if (modelUse) {
      const _t = activeSession(); if (_t) _t.modelId = modelUse;
      state.currentModelId = modelUse;
      await persistModels(modelUse);
      renderModelMenu();
      paintSavedModels();
      return;
    }
    if (modelDel) {
      if (modelDel === 'local-gguf') return;
      state.models = state.models.filter((m) => m.id !== modelDel);
      if (state.currentModelId === modelDel) {
        const _t = activeSession(); if (_t) _t.modelId = null;
        state.currentModelId = state.models.find((m) => m.enabled !== false)?.id || state.models[0]?.id || '';
      }
      await persistModels();
      renderModelMenu();
      paintRemoteList();
      paintSavedModels();
    }
  };

  $('m-ok').onclick = async () => {
    const btn = $('m-ok');
    if (btn) {
      btn.disabled = true;
      btn.textContent = t('saving');
    }
    try {
      const lines = ($('m-sites')?.value || '').split(/\r?\n/);
      state.searchSites = await api.saveSearchSites(lines);
      state.proxy = ($('m-proxy')?.value || '').trim();
      await api.saveProxy(state.proxy);
      state.commandSandbox = await api.saveCommandSandbox({
        enabled: !!$('m-sandbox-on')?.checked,
        timeoutSec: Number($('m-sandbox-timeout')?.value) || 60
      });
      state.maxAgentRounds = await api.saveMaxAgentRounds($('m-agent-rounds')?.value);
      syncRoundsInput(activeSession());
      const caps = readCapDefaultsFromDom();
      state.capabilityDefaults = await api.saveCapabilityDefaults(caps);
      await persistModels();
      if ($('m-theme')) {
        state.themePref = $('m-theme').value;
        applyTheme(await api.setTheme(state.themePref));
      }
      $('modal-card').classList.remove('wide', 'settings-modal');
      closeModal();
    } catch (err) {
      alert(err && err.message ? err.message : t('saveFail'));
      if (btn) {
        btn.disabled = false;
        btn.textContent = t('done');
      }
    }
  };
  if (currentQuotaKey() && providerById(currentQuotaKey()) && $('mm-provider')) {
    $('mm-provider').value = currentQuotaKey();
  }
  paintWalletForm();
}

/* ===== 下载模型：用途 → 本机配置 → 建议 → 下载 ===== */

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n <= 0) return t('unknownSize');
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

function fmtSpeed(bytesPerSec) {
  const n = Number(bytesPerSec) || 0;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB/s`;
  return `${Math.max(0, Math.round(n / 1024))} KB/s`;
}

const PURPOSES = [
  { id: 'code', nameKey: 'purposeCode', descKey: 'purposeCodeDesc' },
  { id: 'chat', nameKey: 'purposeChat', descKey: 'purposeChatDesc' },
  { id: 'image', nameKey: 'purposeImage', descKey: 'purposeImageDesc' },
  { id: 'video', nameKey: 'purposeVideo', descKey: 'purposeVideoDesc' },
  { id: 'imageGen', nameKey: 'purposeImageGen', descKey: 'purposeImageGenDesc' },
  { id: 'sfxGen', nameKey: 'purposeSfxGen', descKey: 'purposeSfxGenDesc' },
  { id: 'videoGen', nameKey: 'purposeVideoGen', descKey: 'purposeVideoGenDesc' },
  { id: 'docGen', nameKey: 'purposeDocGen', descKey: 'purposeDocGenDesc' },
  { id: 'musicGen', nameKey: 'purposeMusicGen', descKey: 'purposeMusicGenDesc' },
  { id: 'manual', nameKey: 'purposeManual', descKey: 'purposeManualDesc' }
];

function openDownloader() {
  state.dl = { taskId: null, purpose: null, sourceBase: null, sources: [], advice: null, scrollObs: null, step: 'purpose', manualFrom: null };
  openModal(`<h3 class="dl-title-row">
      <button type="button" id="dl-title-back" class="dl-title-back hidden">${t('backPrev')}</button>
      <span class="dl-title-text">${t('dlTitle')}</span>
    </h3>
    <div class="dl-src">
      <span class="dl-src-label">${t('dlSource')}</span>
      <div class="dl-src-chips" id="dl-src-list"><span class="hint">${t('dlDetecting')}</span></div>
      <label class="dl-threads">${t('threads')}
        <select id="dl-threads">
          <option value="1">1</option>
          <option value="2">2</option>
          <option value="4" selected>4</option>
          <option value="8">8</option>
        </select>
      </label>
      <button type="button" id="dl-src-recheck" class="dl-src-recheck">${t('recheck')}</button>
    </div>
    <div id="dl-body"></div>
    <p class="hint hidden" id="dl-queue-tip"></p>
    <div class="modal-actions">
      <button type="button" id="dl-back">${t('backSettings')}</button>
      <button type="button" class="primary" id="dl-close">${t('close')}</button>
    </div>`);
  $('modal-card').classList.add('wide');
  $('dl-back').onclick = () => dlGoBack();
  $('dl-title-back').onclick = () => dlGoBack();
  $('dl-close').onclick = closeModal;
  $('dl-src-recheck').onclick = () => refreshDownloadSource(true);
  renderPurposeStep();
  refreshDownloadSource(false);
}

async function refreshDownloadSource(force) {
  const el = $('dl-src-list');
  if (!el) return;
  el.innerHTML = `<span class="hint">${t('dlDetecting')}</span>`;
  try {
    const data = await api.downloadSource({ force });
    if (!$('dl-src-list')) return;
    const sources = data.sources || (data.base ? [data] : []);
    state.dl.sources = sources;
    const ok = sources.find((s) => !s.unreachable);
    if (!state.dl.sourceBase || !sources.some((s) => s.base === state.dl.sourceBase)) {
      state.dl.sourceBase = ok?.base || sources[0]?.base || null;
    }
    $('dl-src-list').innerHTML = sources.length
      ? sources.map((s) => `<button type="button" class="dl-src-chip${s.unreachable ? ' unreachable' : ''}${s.base === state.dl.sourceBase ? ' active' : ''}" data-base="${escapeHtml(s.base)}">${escapeHtml(s.name)}</button>`).join('')
      : `<span class="hint">${t('dlUnreachable')}</span>`;
    bindDlSourceChips();
  } catch (e) {
    if ($('dl-src-list')) $('dl-src-list').innerHTML = `<span class="hint">${t('detectFail', { msg: e.message || e })}</span>`;
  }
}

function dlSourceOpts() {
  return state.dl?.sourceBase ? { base: state.dl.sourceBase } : {};
}

function bindDlSourceChips() {
  const list = $('dl-src-list');
  if (!list) return;
  list.onclick = async (e) => {
    const chip = e.target.closest('[data-base]');
    if (!chip || chip.classList.contains('unreachable')) return;
    const base = chip.getAttribute('data-base');
    if (base === state.dl.sourceBase) return;
    state.dl.sourceBase = base;
    list.querySelectorAll('.dl-src-chip').forEach((c) => c.classList.toggle('active', c === chip));
    if (state.dl.purpose && state.dl.purpose !== 'manual') {
      await pickPurpose(state.dl.purpose);
    }
  };
}

function teardownAdviceScroll() {
  state.dl?.scrollObs?.disconnect();
  if (state.dl) state.dl.scrollObs = null;
}

function updateDlBackButton() {
  const step = state.dl?.step || 'purpose';
  const onSub = step !== 'purpose';
  const btn = $('dl-back');
  const headBtn = $('dl-title-back');
  if (btn) btn.textContent = onSub ? t('backPrev') : t('backSettings');
  headBtn?.classList.toggle('hidden', !onSub);
}

function dlGoBack() {
  const step = state.dl?.step || 'purpose';
  if (step === 'manual') {
    if (state.dl.manualFrom === 'advice' && state.dl.advice) {
      teardownAdviceScroll();
      state.dl.step = 'advice';
      state.dl.searchQuery = state.dl.advice.searchQuery || '';
      renderAdviceStep(state.dl.advice);
      setupAdviceInfiniteScroll();
      updateDlBackButton();
      return;
    }
    teardownAdviceScroll();
    renderPurposeStep();
    return;
  }
  if (step === 'advice') {
    teardownAdviceScroll();
    renderPurposeStep();
    return;
  }
  openSettings();
}

function renderPurposeStep() {
  state.dl.purpose = null;
  state.dl.step = 'purpose';
  state.dl.manualFrom = null;
  state.dl.searchQuery = '';
  $('dl-body').innerHTML = `<p class="hint">${t('dlPurposeHint')}</p>
    <div class="dl-purpose">
      ${PURPOSES.map((p) => `<button type="button" data-purpose="${p.id}"><b>${t(p.nameKey)}</b><span>${t(p.descKey)}</span></button>`).join('')}
    </div>`;
  $('dl-body').onclick = (e) => {
    const purpose = e.target.closest('[data-purpose]')?.getAttribute('data-purpose');
    if (purpose) pickPurpose(purpose);
  };
  updateDlBackButton();
}

async function pickPurpose(purpose) {
  teardownAdviceScroll();
  state.dl.purpose = purpose;
  state.dl.searchQuery = '';
  if (purpose === 'manual') return renderManualStep();
  $('dl-body').innerHTML = `<p class="hint">${t('detectingHw')}</p>`;
  let advice;
  try {
    advice = await api.modelAdvice(purpose, { offset: 0, limit: 10, forceRefresh: true, ...dlSourceOpts() });
  } catch (e) {
    $('dl-body').innerHTML = `<p class="hint">${t('detectFail', { msg: escapeHtml(String(e.message || e)) })}</p>`;
    return;
  }
  state.dl.advice = { ...advice, loading: false };
  state.dl.step = 'advice';
  renderAdviceStep(advice);
  setupAdviceInfiniteScroll();
  updateDlBackButton();
}

function hardwareHtml(hw) {
  const gpu = hw.gpu?.name
    ? `${escapeHtml(hw.gpu.name)}${hw.gpu.vramGB ? ` · ${t('vram', { n: hw.gpu.vramGB })}` : ` · ${t('vramUnknown')}`}`
    : t('gpuUnknown');
  return `<div class="dl-hw">
    <div><span class="k">${t('cpu')}</span>${t('cpuThreads', { name: escapeHtml(hw.cpu.name), n: hw.cpu.cores })}</div>
    <div><span class="k">${t('mem')}</span>${t('memLine', { total: hw.memTotalGB, free: hw.memFreeGB })}</div>
    <div><span class="k">${t('gpu')}</span>${gpu}</div>
    <div><span class="k">${t('disk')}</span>${t('diskLine', { n: hw.diskFreeGB })}</div>
  </div>`;
}

/** 适合度 0~100：背景从红过渡到绿 */
function dlFitStyle(score) {
  const t = Math.max(0, Math.min(100, Number(score) || 0)) / 100;
  const r = Math.round(168 * (1 - t) + 36 * t);
  const g = Math.round(52 * (1 - t) + 132 * t);
  const b = Math.round(56 * (1 - t) + 58 * t);
  const a = 0.14 + Math.abs(t - 0.5) * 0.18;
  const borderA = 0.28 + Math.abs(t - 0.5) * 0.32;
  return `background:rgba(${r},${g},${b},${a});border-color:rgba(${r},${g},${b},${borderA});`;
}

function purposeLabel(id) {
  const hit = PURPOSES.find((p) => p.id === id);
  return hit ? t(hit.nameKey) : id;
}

function dlAdviceRowHtml(m) {
  const tierText = m.tier === '推荐' ? t('tierBest')
    : m.tier === '跑不动' ? t('tierNo')
      : m.tier === '勉强能跑' ? t('tierTight')
        : t('tierOk');
  const fitStyle = dlFitStyle(m.fitScore);
  const searchKey = escapeHtml(`${m.name} ${m.repo} ${m.desc}`.toLowerCase());
  return `<div class="dl-item" data-search="${searchKey}" style="${fitStyle}">
    <div class="dl-item-main">
      <b>${escapeHtml(m.name)}</b><span class="tag">${tierText}</span>
      <div class="hint">${escapeHtml(m.desc)}</div>
      <div class="hint">${t('aboutSizeLine', { n: m.sizeGB, note: escapeHtml(m.note) })}</div>
    </div>
    <button type="button" data-get-repo="${escapeHtml(m.repo)}" data-quant="${escapeHtml(m.quant)}" data-catalog-id="${escapeHtml(m.id || '')}">${t('download')}</button>
  </div>`;
}

function filterAdviceList() {
  const q = ($('dl-advice-q')?.value || '').trim().toLowerCase();
  const rows = $('dl-list')?.querySelectorAll('.dl-item');
  if (!rows) return;
  let visible = 0;
  rows.forEach((row) => {
    const hit = !q || (row.getAttribute('data-search') || '').includes(q);
    row.classList.toggle('hidden', !hit);
    if (hit) visible += 1;
  });
  const empty = $('dl-filter-empty');
  if (empty) empty.classList.toggle('hidden', visible > 0 || !q);
}

async function runAdviceSearch(query) {
  const q = String(query ?? $('dl-advice-q')?.value ?? '').trim();
  state.dl.searchQuery = q;
  teardownAdviceScroll();
  if (!q) {
    await pickPurpose(state.dl.purpose);
    return;
  }
  const list = $('dl-list');
  if (list) list.innerHTML = `<p class="hint">${t('searching')}</p>`;
  $('dl-load-err') && ($('dl-load-err').textContent = '');
  try {
    const advice = await api.modelAdvice(state.dl.purpose, {
      offset: 0,
      limit: 10,
      query: q,
      hardware: state.dl.advice?.hardware,
      forceRefresh: true,
      ...dlSourceOpts()
    });
    state.dl.advice = { ...advice, loading: false, searchQuery: q };
    if (list) {
      list.innerHTML = (advice.items || []).map(dlAdviceRowHtml).join('')
        || `<p class="hint">${t('noRepos')}</p>`;
    }
    const meta = $('dl-advice-meta');
    if (meta) {
      meta.textContent = `${t('aboutSize')} · ${t('dlSearchResult', { q })}${advice.total ? ` · ${t('dlTotalN', { n: advice.total })}` : ''}`;
    }
    filterAdviceList();
    setupAdviceInfiniteScroll();
  } catch (e) {
    if (list) list.innerHTML = `<p class="hint">${t('searchFail', { msg: escapeHtml(String(e.message || e)) })}</p>`;
  }
}

function bindAdviceSearch() {
  $('dl-advice-search-btn')?.addEventListener('click', () => runAdviceSearch());
  $('dl-advice-clear')?.addEventListener('click', () => {
    const input = $('dl-advice-q');
    if (input) input.value = '';
    runAdviceSearch('');
  });
  $('dl-advice-q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runAdviceSearch();
  });
  $('dl-advice-q')?.addEventListener('input', () => filterAdviceList());
}

function appendAdviceRows(items) {
  const list = $('dl-list');
  if (!list || !items?.length) return;
  list.insertAdjacentHTML('beforeend', items.map(dlAdviceRowHtml).join(''));
  filterAdviceList();
}

async function loadMoreAdviceItems() {
  const a = state.dl?.advice;
  if (!a || a.loading || !a.hasMore) return;
  a.loading = true;
  $('dl-loading-more')?.classList.remove('hidden');
  $('dl-load-err') && ($('dl-load-err').textContent = '');
  try {
    const more = await api.modelAdvice(state.dl.purpose, {
      offset: a.nextOffset,
      limit: 10,
      hardware: a.hardware,
      query: a.searchQuery || undefined,
      ...dlSourceOpts()
    });
    appendAdviceRows(more.items || []);
    a.hasMore = !!more.hasMore;
    a.nextOffset = more.nextOffset ?? a.nextOffset;
    if (!a.hasMore) teardownAdviceScroll();
  } catch (e) {
    if ($('dl-load-err')) $('dl-load-err').textContent = t('loadMoreFail', { msg: e.message || e });
  } finally {
    a.loading = false;
    $('dl-loading-more')?.classList.add('hidden');
  }
}

function setupAdviceInfiniteScroll() {
  teardownAdviceScroll();
  const root = $('dl-body');
  const sentinel = $('dl-load-sentinel');
  if (!root || !sentinel || !state.dl?.advice?.hasMore) return;
  const obs = new IntersectionObserver((entries) => {
    if (entries[0]?.isIntersecting) loadMoreAdviceItems();
  }, { root, rootMargin: '100px', threshold: 0 });
  obs.observe(sentinel);
  state.dl.scrollObs = obs;
}

function renderAdviceStep(advice) {
  const back = `<div class="dl-nav"><button type="button" id="dl-repick">${t('changePurpose')}</button><button type="button" id="dl-goto-manual">${t('searchOrPaste')}</button></div>`;
  const purpose = state.dl?.purpose;
  const purposeNote = advice.purposeNote
    ? `<p class="hint">${escapeHtml(advice.purposeNote)}</p>`
    : (purpose === 'image' ? `<p class="hint">${t('dlVisionNote')}</p>`
      : purpose === 'video' ? `<p class="hint">${t('dlVideoNote')}</p>` : '');
  const totalHint = advice.total ? ` · ${t('dlTotalN', { n: advice.total })}` : '';
  const searchQ = state.dl?.searchQuery || advice.searchQuery || '';
  const searchBar = `<div class="dl-search dl-advice-search">
    <input id="dl-advice-q" placeholder="${t('dlAdviceSearchPh')}" value="${escapeHtml(searchQ)}" />
    <button type="button" id="dl-advice-search-btn">${t('search')}</button>
    <button type="button" id="dl-advice-clear">${t('clearSearch')}</button>
  </div>`;
  if (!advice.supported) {
    $('dl-body').innerHTML = `${hardwareHtml(advice.hardware)}
      <div class="restore-warn">${escapeHtml(advice.reason || t('noRepos'))}</div>
      <p class="hint">${t('engineNo')}</p>
      ${back}`;
  } else {
    const rows = (advice.items || []).map(dlAdviceRowHtml).join('');
    $('dl-body').innerHTML = `${hardwareHtml(advice.hardware)}
      ${purposeNote}
      ${searchBar}
      <p class="hint" id="dl-advice-meta">${t('aboutSize')}${totalHint}${searchQ ? ` · ${t('dlSearchResult', { q: searchQ })}` : ''}</p>
      <div id="dl-list">${rows}</div>
      <p class="hint hidden" id="dl-filter-empty">${t('noFilterMatch')}</p>
      <div id="dl-load-sentinel" class="dl-load-sentinel"></div>
      <p class="hint hidden" id="dl-loading-more">${t('loadingMore')}</p>
      <p class="hint" id="dl-load-err"></p>
      ${back}`;
  }
  bindAdviceSearch();
  filterAdviceList();
  $('dl-body').onclick = async (e) => {
    if (e.target.closest('#dl-repick')) {
      teardownAdviceScroll();
      return renderPurposeStep();
    }
    if (e.target.closest('#dl-goto-manual')) return renderManualStep(true);
    const btn = e.target.closest('[data-get-repo]');
    if (!btn) return;
    await downloadFromRepo(
      btn.getAttribute('data-get-repo'),
      btn.getAttribute('data-quant'),
      btn.getAttribute('data-catalog-id')
    );
  };
}

function renderManualStep(fromAdvice = false) {
  teardownAdviceScroll();
  state.dl.step = 'manual';
  state.dl.manualFrom = fromAdvice ? 'advice' : 'purpose';
  if (fromAdvice) state.dl.purpose = state.dl.purpose || null;
  $('dl-body').innerHTML = `<p class="hint">${t('dlManualHint')}</p>
    <div class="dl-search">
      <input id="dl-q" placeholder="${t('searchPh')}" />
      <button type="button" id="dl-search-btn">${t('search')}</button>
    </div>
    <div id="dl-results"></div>
    <label>${t('pasteUrl')}</label>
    <div class="dl-search">
      <input id="dl-url" placeholder="https://.../xxx.gguf" />
      <button type="button" id="dl-url-btn">${t('download')}</button>
    </div>
    <div class="dl-nav"><button type="button" id="dl-repick">${t('backPurpose')}</button></div>`;
  $('dl-search-btn').onclick = () => searchRepos();
  $('dl-q').onkeydown = (e) => { if (e.key === 'Enter') searchRepos(); };
  $('dl-url-btn').onclick = () => {
    const url = $('dl-url').value.trim();
    if (!/^https?:\/\/.+\.gguf(\?.*)?$/i.test(url)) return alert(t('needGgufUrl'));
    runDownload({ url, name: decodeURIComponent(url.split('?')[0].split('/').pop()) });
  };
  $('dl-body').addEventListener('click', async (e) => {
    if (e.target.closest('#dl-repick')) return renderPurposeStep();
    const repo = e.target.closest('[data-open-repo]')?.getAttribute('data-open-repo');
    if (repo) return openRepoFiles(repo);
    const url = e.target.closest('[data-get-url]')?.getAttribute('data-get-url');
    if (url) {
      const name = e.target.closest('[data-get-url]').getAttribute('data-name');
      await runDownload({ url: decodeURIComponent(url), name });
    }
  });
  updateDlBackButton();
}

async function searchRepos() {
  const q = $('dl-q').value.trim();
  if (!q) return;
  $('dl-results').innerHTML = `<p class="hint">${t('searching')}</p>`;
  try {
    const { repos } = await api.searchRepos(q, dlSourceOpts());
    if (!$('dl-results')) return;
    $('dl-results').innerHTML = repos.length
      ? repos.map((r) => `<div class="dl-item">
          <div class="dl-item-main"><b>${escapeHtml(r.repo)}</b><div class="hint">${t('downloadsN', { n: r.downloads })}</div></div>
          <button type="button" data-open-repo="${escapeHtml(r.repo)}">${t('viewFiles')}</button>
        </div>`).join('')
      : `<p class="hint">${t('noRepos')}</p>`;
  } catch (e) {
    if ($('dl-results')) $('dl-results').innerHTML = `<p class="hint">${t('searchFail', { msg: escapeHtml(String(e.message || e)) })}</p>`;
  }
}

async function openRepoFiles(repo) {
  $('dl-results').innerHTML = `<p class="hint">${t('readingRepo')}</p>`;
  try {
    const { files } = await api.listRepoFiles(repo);
    if (!$('dl-results')) return;
    $('dl-results').innerHTML = `<div class="hint">${escapeHtml(repo)}</div>` + (files.length
      ? files.map((f) => `<div class="dl-item">
          <div class="dl-item-main"><b>${escapeHtml(f.name)}</b><div class="hint">${fmtSize(f.size)}</div></div>
          <button type="button" data-get-url="${encodeURIComponent(f.url)}" data-name="${escapeHtml(f.name)}">${t('download')}</button>
        </div>`).join('')
      : `<p class="hint">${t('noGgufFile')}</p>`);
  } catch (e) {
    if ($('dl-results')) $('dl-results').innerHTML = `<p class="hint">${t('readFail', { msg: escapeHtml(String(e.message || e)) })}</p>`;
  }
}

async function downloadFromRepo(repo, quant, catalogId) {
  try {
    const info = await api.resolveDownload({ repo, quant, base: state.dl?.sourceBase });
    enqueueDownload({
      url: info.url,
      name: info.name,
      size: info.size,
      source: repo,
      purpose: state.dl?.purpose || '',
      quant: quant || '',
      catalogId: catalogId || ''
    });
    flashDlQueued(info.name);
  } catch (e) {
    alert(t('getFileFail', { msg: e.message || e }));
  }
}

function getDownloadThreads() {
  const fromModal = Number($('dl-threads')?.value);
  if (Number.isFinite(fromModal) && fromModal > 0) return Math.min(8, fromModal);
  return state.downloadThreads || 4;
}

const MAX_CONCURRENT_DOWNLOADS = 2;
let dlRenderRaf = null;

function downloadStatusText(item) {
  if (item.status === 'pending') return t('dlStatusPending');
  if (item.status === 'downloading') return t('dlStatusDownloading');
  if (item.status === 'done') return item.skipped ? t('dlStatusSkipped') : t('dlStatusDone');
  if (item.status === 'canceled') return t('dlStatusCanceled');
  if (item.status === 'error') return t('dlStatusError');
  return '';
}

function activeDownloadCount() {
  return state.downloads.filter((d) => d.status === 'pending' || d.status === 'downloading').length;
}

function renderDownloadPanel(light) {
  if (light) {
    if (dlRenderRaf) return;
    dlRenderRaf = requestAnimationFrame(() => {
      dlRenderRaf = null;
      renderDownloadPanel(false);
    });
    return;
  }
  const panel = $('download-panel');
  const list = $('download-list');
  const countEl = $('download-count');
  const statusBtn = $('status-downloads');
  const statusN = $('status-dl-n');
  const clearBtn = $('download-clear-done');
  if (!list) return;

  const items = state.downloads;
  const active = activeDownloadCount();
  const hasDone = items.some((d) => d.status === 'done' || d.status === 'canceled' || d.status === 'error');

  const folding = items.length > 0 && state.downloadPanelFolded && panel?.classList.contains('open');
  const hidingPanel = items.length === 0 && panel && !panel.classList.contains('hidden');
  const sheet = panel?.querySelector('.download-drawer-sheet');
  if (hidingPanel) releaseFocus(panel);
  else if (folding) releaseFocus(sheet);
  panel?.classList.toggle('hidden', items.length === 0);
  panel?.classList.toggle('open', items.length > 0 && !state.downloadPanelFolded);
  if (hidingPanel || folding) focusComposer();
  countEl?.classList.toggle('hidden', active === 0);
  if (countEl) countEl.textContent = String(active);
  statusBtn?.classList.toggle('hidden', items.length === 0);
  if (statusN) statusN.textContent = String(active);
  if (statusBtn) statusBtn.title = t('downloadList');
  clearBtn?.classList.toggle('hidden', !hasDone);

  list.innerHTML = items.length ? items.map((item) => {
    const p = item.progress || {};
    const pct = p.total > 0 ? Math.min(100, (p.downloaded / p.total) * 100) : 0;
    const showBar = item.status === 'downloading' || (item.status === 'done' && pct >= 100);
    const progText = item.status === 'downloading'
      ? `${fmtSize(p.downloaded)} / ${p.total > 0 ? fmtSize(p.total) : t('unknown')} · ${pct.toFixed(1)}% · ${fmtSpeed(p.speed)}${p.retrying ? ` · ${t('retrying')}` : ''}`
      : (item.error ? escapeHtml(item.error) : (item.source ? escapeHtml(item.source) : ''));
    const canCancel = item.status === 'pending' || item.status === 'downloading';
    return `<div class="download-row" data-dl-id="${escapeHtml(item.id)}">
      <div class="download-row-main">
        <div class="download-row-head">
          <b>${escapeHtml(item.name)}</b>
          <span class="download-row-status">${downloadStatusText(item)}</span>
        </div>
        ${showBar ? `<div class="dl-bar download-row-bar"><i style="width:${pct.toFixed(1)}%"></i></div>` : ''}
        <div class="hint download-row-hint">${progText}</div>
      </div>
      ${canCancel ? `<button type="button" class="download-row-cancel" data-dl-cancel="${escapeHtml(item.id)}">${t('cancel')}</button>` : ''}
    </div>`;
  }).join('') : `<p class="hint download-empty">${t('downloadList')}</p>`;
}

function openDownloadPanel() {
  state.downloadPanelFolded = false;
  renderDownloadPanel();
}

function flashDlQueued(name) {
  const tip = $('dl-queue-tip');
  if (tip) {
    tip.textContent = `${t('dlQueued', { name })} · ${t('dlQueuedHint')}`;
    tip.classList.remove('hidden');
  }
}

function enqueueDownload({ url, name, size, threads, source, purpose, quant, catalogId }) {
  const item = {
    id: uid(),
    url,
    name,
    size: size || 0,
    threads: threads || getDownloadThreads(),
    source: source || '',
    purpose: purpose || state.dl?.purpose || '',
    quant: quant || '',
    catalogId: catalogId || '',
    status: 'pending',
    progress: { downloaded: 0, total: size || 0, speed: 0 },
    error: '',
    skipped: false
  };
  state.downloads.push(item);
  renderDownloadPanel();
  pumpDownloadQueue();
  return item.id;
}

function pumpDownloadQueue() {
  const running = state.downloads.filter((d) => d.status === 'downloading').length;
  if (running >= MAX_CONCURRENT_DOWNLOADS) return;
  const next = state.downloads.find((d) => d.status === 'pending');
  if (!next) return;
  startDownloadItem(next);
  if (running + 1 < MAX_CONCURRENT_DOWNLOADS) pumpDownloadQueue();
}

async function startDownloadItem(item) {
  item.status = 'downloading';
  renderDownloadPanel();
  try {
    const res = await api.startDownload({
      id: item.id,
      url: item.url,
      name: item.name,
      threads: item.threads,
      meta: {
        purpose: item.purpose,
        repo: item.source,
        quant: item.quant,
        catalogId: item.catalogId,
        url: item.url,
        source: 'download-ui'
      }
    });
    if (res.ok) {
      item.status = 'done';
      item.skipped = !!res.skipped;
      item.progress = { downloaded: res.bytes || item.progress.total, total: res.bytes || item.progress.total, speed: 0 };
      state.localFiles = res.files || state.localFiles;
      state.modelsDir = res.dir || state.modelsDir;
      renderModelMenu();
    } else {
      item.status = res.canceled ? 'canceled' : 'error';
      item.error = res.message || t('dlFail', { msg: '' });
    }
  } catch (e) {
    item.status = 'error';
    item.error = e.message || String(e);
  }
  renderDownloadPanel();
  pumpDownloadQueue();
}

function cancelDownloadItem(id) {
  const item = state.downloads.find((d) => d.id === id);
  if (!item) return;
  if (item.status === 'pending') {
    item.status = 'canceled';
    renderDownloadPanel();
    pumpDownloadQueue();
    return;
  }
  if (item.status === 'downloading') {
    api.cancelDownload(id);
  }
}

function clearDoneDownloads() {
  state.downloads = state.downloads.filter((d) => d.status === 'pending' || d.status === 'downloading');
  renderDownloadPanel();
}

function bindDownloadPanel() {
  dontStealFocus($('download-drawer-tab'));
  dontStealFocus($('download-panel-fold'));
  $('download-drawer-tab')?.addEventListener('click', () => {
    state.downloadPanelFolded = !state.downloadPanelFolded;
    renderDownloadPanel();
  });
  $('download-panel-fold')?.addEventListener('click', () => {
    state.downloadPanelFolded = true;
    renderDownloadPanel();
  });
  $('status-downloads')?.addEventListener('click', () => {
    state.downloadPanelFolded = false;
    renderDownloadPanel();
  });
  $('download-clear-done')?.addEventListener('click', () => clearDoneDownloads());
  $('download-list')?.addEventListener('click', (e) => {
    const id = e.target.closest('[data-dl-cancel]')?.getAttribute('data-dl-cancel');
    if (id) cancelDownloadItem(id);
  });
}

async function runDownload({ url, name, size, source, purpose, quant, catalogId }) {
  enqueueDownload({
    url,
    name,
    size,
    source,
    purpose: purpose || state.dl?.purpose || '',
    quant,
    catalogId
  });
  flashDlQueued(name);
}

function onDownloadProgress(p) {
  const item = state.downloads.find((d) => d.id === p.id);
  if (!item) return;
  item.progress = {
    downloaded: p.downloaded,
    total: p.total,
    speed: p.speed,
    retrying: p.retrying
  };
  if (p.done && p.total > 0) item.progress.downloaded = p.total;
  renderDownloadPanel(true);
}

function bind() {
  bindDownloadPanel();
  document.querySelectorAll('.menu-btn').forEach((btn) => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const menu = btn.parentElement;
      const open = menu.classList.contains('open');
      closeMenus();
      if (!open) menu.classList.add('open');
    };
  });
  document.body.addEventListener('click', (e) => {
    if (e.target.closest('#ctx-menu')) return;
    closeMenus();
  });

  document.body.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.getAttribute('data-act');
    const path = e.target.closest('[data-path]')?.getAttribute('data-path');
    if (act === 'new-window') api.newWindow();
    if (act === 'open-project') openProject();
    if (act === 'toggle-autosave') {
      state.autoSave = await api.setAutoSave(!state.autoSave);
      $('btn-autosave').querySelector('.check').classList.toggle('on', state.autoSave);
    }
    if (act === 'settings') openSettings();
    if (act === 'manage-skills') openSkillManager();
    if (act === 'edit-persona') openPersonaEditor();
    if (act === 'manage-rules') openRuleManager();
    if (act === 'exit') api.close();
    if (act === 'theme-light' || act === 'theme-dark' || act === 'theme-system') {
      state.themePref = act.replace('theme-', '');
      applyTheme(await api.setTheme(state.themePref));
    }
    if (act === 'about') {
      openModal(`<h3>${t('about')}</h3><p>${t('aboutBody')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
      $('m-ok').onclick = closeModal;
    }
    if (act === 'open-path' && path) openProject(decodeURIComponent(path));
    if (e.target.closest('.recent-item') && path) openProject(decodeURIComponent(path));
  });

  $('btn-min').onclick = () => api.minimize();
  $('btn-max').onclick = () => api.maximize();
  $('btn-close').onclick = () => api.close();
  $('lang-switch').onclick = async (e) => {
    const loc = e.target.closest('[data-locale]')?.getAttribute('data-locale');
    if (!loc || loc === getLocale()) return;
    const saved = await api.setLocale(loc);
    setLocale(saved);
    applyLocaleUi();
  };
  document.querySelector('.titlebar').addEventListener('dblclick', (e) => {
    if (e.target.closest('button, .menu-drop, .menubar, .lang-switch')) return;
    api.maximize();
  });
  $('btn-open').onclick = () => openProject();
  $('btn-clone').onclick = openClone;
  $('btn-ssh').onclick = openSsh;
  $('btn-view-all').onclick = () => renderRecents(true);

  $('btn-new-tab').onclick = () => {
    newTab();
    renderTabs();
    renderMessages();
    renderQueue();
    syncSendBtn();
    loadFileTree();
  };
  $('btn-add-folder')?.addEventListener('click', () => addExtraFolder());
  dontStealFocus($('btn-files'));
  $('btn-files').onclick = () => {
    state.fileTree = !state.fileTree;
    const tree = $('file-tree');
    if (!state.fileTree) releaseFocus(tree);
    tree.classList.toggle('hidden', !state.fileTree);
    if (!state.fileTree) focusComposer();
  };
  dontStealFocus($('btn-sidebar'));
  $('btn-sidebar').onclick = () => {
    state.sidebar = !state.sidebar;
    const side = $('sidebar');
    if (!state.sidebar) releaseFocus(side);
    side.classList.toggle('hidden', !state.sidebar);
    if (!state.sidebar) focusComposer();
  };
  $('tree-body').onclick = async (e) => {
    const rm = e.target.closest('[data-rm-folder]');
    if (rm) {
      e.preventDefault();
      e.stopPropagation();
      removeExtraFolder(decodeURIComponent(rm.getAttribute('data-rm-folder')));
      return;
    }
    const dir = e.target.closest('[data-tree-dir]')?.getAttribute('data-tree-dir');
    const file = e.target.closest('[data-tree-file]')?.getAttribute('data-tree-file');
    if (dir) {
      const rel = decodeURIComponent(dir);
      if (state.treeOpen.has(rel)) state.treeOpen.delete(rel);
      else {
        state.treeOpen.add(rel);
        try {
          if (isAbsTreePath(rel) && !sameWorkspace(rel, state.workspace)) {
            state.treeCache[rel] = await api.listChildren('', rel, true);
          } else {
            state.treeCache[rel] = await api.listChildren(rel);
          }
        } catch {
          state.treeCache[rel] = [];
        }
      }
      renderFileTree();
      return;
    }
    if (file) {
      const rel = decodeURIComponent(file);
      if (e.ctrlKey) addContextPath(rel);
      else await openCodePreview(rel);
    }
  };
  $('tree-body').oncontextmenu = (e) => {
    const dir = e.target.closest('[data-tree-dir]')?.getAttribute('data-tree-dir');
    const file = e.target.closest('[data-tree-file]')?.getAttribute('data-tree-file');
    const raw = dir || file;
    if (!raw) return;
    showFileCtx(e, decodeURIComponent(raw));
  };
  $('btn-history').onclick = () => openHistory();
  $('btn-more').onclick = openSettings;

  $('tabs').onclick = async (e) => {
    const close = e.target.getAttribute('data-close');
    const id = e.target.closest('.tab')?.getAttribute('data-id');
    if (close) {
      const closing = state.tabs.find((t) => t.id === close);
      if (isTabSending(closing)) abortTab(closing);
      if (state.activeTab === close) await persistSession();
      const wasActive = state.activeTab === close;
      state.tabs = state.tabs.filter((t) => t.id !== close);
      if (!state.tabs.length) newTab();
      if (wasActive) await switchToTab(state.tabs[0].id);
      else {
        renderTabs();
        renderMessages();
      }
      return;
    }
    if (id) await switchToTab(id);
  };
  $('tabs').ondblclick = (e) => {
    if (e.target.closest('[data-close]')) return;
    const id = e.target.closest('.tab')?.getAttribute('data-id');
    if (!id) return;
    const tab = state.tabs.find((t) => t.id === id);
    promptRename(id, tab?.title || '');
  };

  $('btn-attach').onclick = async () => {
    await addAttachments(await api.pickFiles());
  };
  $('btn-send').onclick = () => {
    const tab = activeSession();
    if (isTabSending(tab)) abortTab(tab);
    else send();
  };
  $('btn-enqueue').onclick = () => {
    const tab = activeSession() || (newTab(), activeSession());
    const text = $('input').value.trim();
    if (!text) return;
    // 排队同样走快照：当前输入区的附件/引用/技能随本条入队，不继承也不留给下一条
    tabQueue(tab).push({
      text,
      skillId: skillStack()[0] || null,
      skillIds: skillStack(),
      modelId: tab.modelId || state.currentModelId,
      contextPaths: [...state.contextPaths],
      attachments: state.attachments.map((a) => ({ ...a }))
    });
    $('input').value = '';
    clearComposer(tab);
    scheduleComposerSave();
    state.attachments = [];
    state.contextPaths = [];
    renderChips();
    $('input').focus();
    renderQueue();
  };
  $('queue').onclick = (e) => {
    const eqi = e.target.getAttribute('data-edit-queue');
    if (eqi != null) {
      const qi = Number(eqi);
      const qtab = activeSession();
      const qlist = tabQueue(qtab);
      const qitem = qlist[qi];
      if (qitem != null) {
        qlist.splice(qi, 1);
        refillQueueItem(qitem);
        renderQueue();
      }
      return;
    }
    const idx = e.target.getAttribute('data-rm-queue');
    if (idx == null) return;
    tabQueue(activeSession()).splice(Number(idx), 1);
    renderQueue();
  };
  $('btn-model').onclick = async (e) => {
    e.stopPropagation();
    await refreshLocalFiles();
    renderModelMenu();
    $('model-menu').classList.toggle('show');
  };
  $('model-menu').onclick = async (e) => {
    const testGguf = e.target.closest('[data-test-gguf]')?.getAttribute('data-test-gguf');
    if (testGguf != null) {
      e.stopPropagation();
      await testConnection({ type: 'local', modelPath: decodeURIComponent(testGguf) });
      return;
    }
    const testId = e.target.closest('[data-test-model]')?.getAttribute('data-test-model');
    if (testId != null) {
      e.stopPropagation();
      const m = state.models.find((x) => x.id === testId);
      if (m) await testConnection(m);
      return;
    }
    const ggufName = e.target.closest('[data-gguf]')?.getAttribute('data-gguf');
    const id = e.target.closest('[data-model]')?.getAttribute('data-model');
    if (ggufName) {
      await selectLocalGguf(decodeURIComponent(ggufName));
      return;
    }
    if (id) {
      const _t = activeSession(); if (_t) _t.modelId = id;
      await persistModels(id);
      renderModelMenu();
    }
  };
  $('chips').onclick = (e) => {
    const img = e.target.closest('.chip-img img');
    if (img && !e.target.closest('button')) {
      openLightbox(img.src);
      return;
    }
    const rm = e.target.getAttribute('data-rm');
    if (rm === 'skill') setSkillStack(skillStack().filter((id) => id !== e.target.getAttribute('data-id')));
    if (rm === 'ctx') state.contextPaths = state.contextPaths.filter((p) => p !== decodeURIComponent(e.target.getAttribute('data-p')));
    if (rm === 'att') state.attachments = state.attachments.filter((a) => a.path !== decodeURIComponent(e.target.getAttribute('data-p')));
    renderChips();
  };
  $('slash-menu').onclick = (e) => {
    e.stopPropagation();
    if (e.target.closest('[data-new-skill]')) {
      $('slash-menu').classList.add('hidden');
      openSkillEditor(null);
      return;
    }
    const id = e.target.closest('[data-pick-skill]')?.getAttribute('data-pick-skill');
    if (!id) return;
    const cur = skillStack();
    if (cur.includes(id)) setSkillStack(cur.filter((x) => x !== id));
    else addSkillToStack(id);
    $('input').value = $('input').value.replace(/(^|\s)\/[^\s]*$/, '$1').trimStart();
    renderChips();
    showSlash('');
  };
  $('at-menu').onclick = (e) => {
    const p = e.target.getAttribute('data-pick-file');
    if (!p) return;
    const path = decodeURIComponent(p);
    if (!state.contextPaths.includes(path)) state.contextPaths.push(path);
    $('input').value = $('input').value.replace(/(^|\s)@[^\s]*$/, '$1').trimStart();
    $('at-menu').classList.add('hidden');
    renderChips();
  };
  $('sidebar').onclick = async (e) => {
    const en = e.target.closest('[data-enable-skill]');
    if (en) {
      await toggleSkillEnabled(en.getAttribute('data-enable-skill'), en.checked);
      return;
    }
    const editId = e.target.closest('[data-edit-skill]')?.getAttribute('data-edit-skill');
    const editScope = e.target.closest('[data-edit-skill]')?.getAttribute('data-edit-scope');
    if (editId) {
      const skill = state.skills.find((s) => s.id === editId && (s.scope || 'app') === editScope);
      openSkillEditor(skill || { id: editId, scope: editScope, body: '' });
      return;
    }
    const skill = e.target.closest('[data-skill]')?.getAttribute('data-skill');
    const restore = e.target.closest('[data-restore]')?.getAttribute('data-restore');
    if (skill) { addSkillToStack(skill); renderChips(); }
    if (restore) {
      const snap = state.snapshots.find((s) => s.id === restore);
      if (!await confirmRestore(snap)) return;
      await api.restoreSnapshot(restore);
      await refreshAfterRestore();
      openModal(`<h3>${t('restored')}</h3><p class="hint">${t('restoredHint')}</p><div class="modal-actions"><button class="primary" id="m-ok">${t('ok')}</button></div>`);
      $('m-ok').onclick = closeModal;
    }
  };
  $('btn-new-skill').onclick = () => openSkillEditor(null);
  $('btn-new-memory')?.addEventListener('click', () => openMemoryEditor());
  $('btn-clear-memory')?.addEventListener('click', () => openMemoryClearDialog());
  $('btn-edit-profile')?.addEventListener('click', () => openProfileEditor());
  $('btn-new-global-pref')?.addEventListener('click', () => openGlobalPrefEditor());
  $('btn-edit-persona').onclick = () => openPersonaEditor();
  $('btn-new-rule').onclick = () => openRuleEditor(null);
  $('btn-agent')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('slash-menu');
    if (!menu.classList.contains('hidden')) menu.classList.add('hidden');
    else showSlash('');
  });
  const commitRounds = () => {
    const n = clampAgentRounds($('input-rounds')?.value);
    state.maxAgentRounds = n;
    const tab = activeSession();
    if (tab) {
      tab.maxAgentRounds = n;
      persistTab(tab);
    }
    syncRoundsInput(tab);
    api.saveMaxAgentRounds(n).catch(() => {});
  };
  $('btn-unlimited')?.addEventListener('click', () => {
    const tab = activeSession();
    if (!tab) return;
    tab.unlimitedRounds = !tab.unlimitedRounds;
    syncRoundsInput(tab);
    persistTab(tab);
  });
  $('btn-alive')?.addEventListener('click', async () => {
    const next = !state.desktopAlive;
    try {
      state.desktopAlive = await api.setDesktopAlive(next);
    } catch {
      state.desktopAlive = false;
    }
    const btn = $('btn-alive');
    if (btn) {
      btn.classList.toggle('on', !!state.desktopAlive);
      btn.setAttribute('aria-pressed', state.desktopAlive ? 'true' : 'false');
    }
  });
  $('input-rounds')?.addEventListener('change', commitRounds);
  $('input-rounds')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitRounds();
    }
  });
  $('snap-max')?.addEventListener('change', async () => {
    const n = Number($('snap-max').value);
    if (!state.workspace || !n) return;
    try {
      const r = await api.setSnapshotMax(n);
      state.snapshotMax = r.max;
      if (r.list) state.snapshots = r.list;
      renderSidebar();
    } catch (err) {
      alert(err.message || err);
    }
  });
  $('milestone-list')?.addEventListener('click', async (e) => {
    const renameId = e.target.closest('[data-ms-rename]')?.getAttribute('data-ms-rename');
    if (renameId) {
      e.stopPropagation();
      const cur = (state.milestones || []).find((x) => x.id === renameId);
      openMilestoneNameDialog({
        title: t('milestoneRename'),
        defaultName: cur?.name || '',
        onSave: async (name) => {
          state.milestones = await api.renameMilestone(renameId, name);
          renderSidebar();
          renderMessages();
        }
      });
      return;
    }
    const delId = e.target.closest('[data-ms-del]')?.getAttribute('data-ms-del');
    if (delId) {
      e.stopPropagation();
      if (!confirm(t('milestoneDeleteConfirm'))) return;
      state.milestones = await api.deleteMilestone(delId);
      renderSidebar();
      renderMessages();
    }
  });
  $('memory-list')?.addEventListener('click', async (e) => {
    const pinId = e.target.closest('[data-mem-pin]')?.getAttribute('data-mem-pin');
    if (pinId) {
      e.stopPropagation();
      try {
        const pinned = e.target.closest('[data-mem-pin]').getAttribute('data-pinned') !== '1';
        state.memories = await api.pinMemory(pinId, pinned);
        renderSidebar();
      } catch (err) {
        alert(err?.message || t('saveFail'));
      }
      return;
    }
    const delId = e.target.closest('[data-mem-del]')?.getAttribute('data-mem-del');
    if (delId) {
      e.stopPropagation();
      if (!confirm(t('memoryDeleteConfirm'))) return;
      try {
        await api.deleteMemory(delId);
        state.memories = state.workspace ? (await api.listMemory()) : [];
        renderSidebar();
        if ((state.memories || []).some((m) => m.id === delId)) {
          alert(t('memoryDeleteFail'));
        } else {
          alert(t('memoryDeletedOk'));
        }
      } catch (err) {
        alert(err?.message || t('memoryDeleteFail'));
      }
    }
  });
  $('global-pref-list')?.addEventListener('click', async (e) => {
    const pinId = e.target.closest('[data-gpref-pin]')?.getAttribute('data-gpref-pin');
    if (pinId) {
      e.stopPropagation();
      try {
        const pinned = e.target.closest('[data-gpref-pin]').getAttribute('data-pinned') !== '1';
        state.globalMemory = await api.pinGlobalPref(pinId, pinned);
        renderSidebar();
      } catch (err) {
        alert(err?.message || t('saveFail'));
      }
      return;
    }
    const delId = e.target.closest('[data-gpref-del]')?.getAttribute('data-gpref-del');
    if (delId) {
      e.stopPropagation();
      if (!confirm(t('memoryDeleteConfirm'))) return;
      try {
        await api.deleteGlobalPref(delId);
        state.globalMemory = await api.getGlobalMemory();
        renderSidebar();
        if ((state.globalMemory?.prefs || []).some((m) => m.id === delId)) {
          alert(t('memoryDeleteFail'));
        } else {
          alert(t('memoryDeletedOk'));
        }
      } catch (err) {
        alert(err?.message || t('memoryDeleteFail'));
      }
    }
  });
  $('persona-list').onclick = (e) => {
    if (e.target.closest('[data-edit-persona]')) openPersonaEditor();
  };
  $('rule-list').onclick = (e) => {
    const id = e.target.closest('[data-edit-rule]')?.getAttribute('data-edit-rule');
    const scope = e.target.closest('[data-edit-rule]')?.getAttribute('data-edit-rule-scope');
    if (!id) return;
    const rule = state.rules.find((r) => r.id === id && (r.scope || 'app') === scope);
    openRuleEditor(rule || { id, scope, body: '' });
  };
  $('messages').addEventListener('toggle', (e) => {
    const el = e.target;
    if (!el.classList?.contains('think-block')) return;
    const tab = activeSession();
    const i = Number(el.getAttribute('data-msg-i'));
    if (!tab?.messages[i]) return;
    tab.messages[i].thinkExpanded = el.open;
    if (el.open) {
      let steps = el.querySelector('.think-steps');
      if (!steps) {
        steps = document.createElement('div');
        steps.className = 'think-steps';
        el.appendChild(steps);
      }
      steps.innerHTML = thinkStepsHtml(tab.messages[i]);
    }
  }, true);
  $('messages').onclick = async (e) => {
    const ctxBtn = e.target.closest('[data-ctx-turn]');
    if (ctxBtn) {
      e.stopPropagation();
      openContextPreview(ctxBtn.getAttribute('data-ctx-turn'));
      return;
    }
    const askCard = e.target.closest('[data-ask-card]');
    if (askCard) {
      const tab = activeSession();
      const last = tab?.liveAssistant;
      if (!last?.askPending) return;
      const submitAnswer = async (answer) => {
        const text = String(answer || '').trim();
        const images = (last.askImages || []).slice();
        if (!text && !images.length) return;
        last.askPending = false;
        last.ask = null;
        last.askImages = [];
        last.askDraft = '';
        last.status = t('running');
        pushThink(last, 'tool', `${t('askTitle')}: ${clipText(text, 80)}${images.length ? ` [${images.length} ${t('askImageCount')}]` : ''}`);
        renderMessages();
        try {
          await api.chatAnswer(images.length ? { text, images } : text, last.turnId);
        } catch (err) {
          markTurnFailed(last, err);
          renderMessages();
        }
      };
      const opt = e.target.closest('[data-ask-opt]');
      if (opt) {
        e.stopPropagation();
        await submitAnswer(opt.textContent);
        return;
      }
      if (e.target.closest('.ask-submit')) {
        e.stopPropagation();
        const box = askCard.querySelector('.ask-input');
        await submitAnswer(box?.value || '');
        return;
      }
      const rm = e.target.closest('[data-ask-img-rm]');
      if (rm) {
        e.stopPropagation();
        (last.askImages || []).splice(Number(rm.getAttribute('data-ask-img-rm')), 1);
        renderMessages();
        return;
      }
      if (e.target.closest('.ask-img-add')) {
        e.stopPropagation();
        askCard.querySelector('.ask-img-file')?.click();
        return;
      }
      const zoom = e.target.closest('img[data-zoom-src]');
      if (zoom) openLightbox(zoom.src);
      return;
    }
    const zoomImg = e.target.closest('img.msg-thumb, img[data-zoom-src]');
    if (zoomImg) {
      openLightbox(zoomImg.src);
      return;
    }
    const zbRetry = e.target.closest('[data-zb-retry]');
    if (zbRetry) {
      e.stopPropagation();
      const idx = Number(zbRetry.getAttribute('data-zb-retry'));
      const tab = activeSession();
      const m = tab?.messages?.[idx];
      if (!m) return;
      let ui = idx - 1;
      while (ui >= 0 && tab.messages[ui].role !== 'user') ui--;
      if (ui < 0) {
        alert(t('zbRetryNoCtx'));
        return;
      }
      const user = tab.messages[ui];
      zbRetry.disabled = true;
      zbRetry.textContent = t('zbRetrying');
      try {
        const hist = tab.messages.slice(0, idx)
          .filter((x) => x.role === 'user' || x.role === 'assistant')
          .map((x) => ({ role: x.role, content: x.text || '' }));
        const r = await api.zbaingRetry({
          messages: hist,
          badReply: m.text || '',
          badPrompt: m.zbaing?.prompt || user.text || ''
        });
        m.text = r.content || r.text || m.text;
        if (r.zbaingMeta) m.zbaing = r.zbaingMeta;
        persistSession();
        renderMessages();
      } catch (err) {
        alert(err.message || t('zbRetryFail'));
        zbRetry.disabled = false;
        zbRetry.textContent = t('zbDislike');
      }
      return;
    }
    if (e.target.closest('[data-start-go]')) {
      const input = $('input');
      const draft = input.value;
      input.value = '开始';
      const sending = send();
      if (draft && !input.value) input.value = draft;
      await sending;
      return;
    }
    const refill = e.target.getAttribute('data-refill');
    if (refill != null) {
      const idx = Number(refill);
      const tab = activeSession();
      const m = tab?.messages?.[idx];
      if (!m) return;
      // 已有未完成的重新编辑：切换目标前先确认，避免两条消息的编辑态互相覆盖
      if (state.refillFromIndex != null && state.refillFromIndex !== idx) {
        if (!confirm(t('refillSwitchConfirm'))) return;
        state.refillFromIndex = null;
        state.refillRevertFiles = false;
        tab.refillFromIndex = null;
        tab.refillRevertFiles = false;
        $('input').value = '';
        renderChips();
      }
      tab.refillFromIndex = idx;
      state.refillFromIndex = idx;
      if (m.draft) {
        refillDraft(m.draft);
      } else {
        $('input').value = m.text || '';
        setSkillStack([]);
        state.contextPaths = [];
        state.attachments = [];
        renderChips();
        $('input').focus();
      }
      renderMessages();
      return;
    }
    const fork = e.target.getAttribute('data-fork');
    if (fork != null) {
      forkAt(Number(fork));
      return;
    }
    if (e.target.closest('[data-expand-files]') || (e.target.closest('.file-card-head') && !e.target.closest('[data-restore],[data-set-milestone]'))) {
      e.target.closest('.file-card')?.classList.toggle('open');
      return;
    }
    const setMs = e.target.closest('[data-set-milestone]')?.getAttribute('data-set-milestone');
    if (setMs != null) {
      e.stopPropagation();
      const tab = activeSession();
      const m = tab?.messages?.[Number(setMs)];
      if (!m?.changes?.length) return;
      openMilestoneNameDialog({
        title: t('setMilestone'),
        defaultName: '',
        onSave: async (name) => {
          const r = await api.createMilestone({
            name,
            paths: m.changes.map((c) => c.path),
            snapshotId: m.snapshotId
          });
          state.milestones = r.list || r;
          m.milestoneId = r.entry?.id || r.id;
          m.milestoneName = r.entry?.name || name;
          persistSession();
          renderSidebar();
          renderMessages();
        }
      });
      return;
    }
    const previewFile = e.target.closest('[data-preview-file]')?.getAttribute('data-preview-file');
    if (previewFile) {
      const rel = decodeURIComponent(previewFile);
      await openCodePreview(rel);
      return;
    }
    const reveal = e.target.closest('[data-reveal]')?.getAttribute('data-reveal');
    if (reveal) {
      await revealInFolder(decodeURIComponent(reveal));
      return;
    }
    const id = e.target.closest('[data-restore]')?.getAttribute('data-restore');
    if (!id) return;
    const btn = e.target.closest('[data-restore]');
    const snap = state.snapshots.find((s) => s.id === id) || {
      label: t('thisChange'),
      changes: [...(btn?.closest('.file-card')?.querySelectorAll('[data-preview-file]') || [])]
        .map((el) => ({ path: decodeURIComponent(el.getAttribute('data-preview-file')) }))
    };
    if (!await confirmRestore(snap)) return;
    await api.restoreSnapshot(id);
    if (btn) btn.textContent = t('restored');
    await refreshAfterRestore();
  };
  $('messages').addEventListener('contextmenu', (e) => {
    const previewFile = e.target.closest('[data-preview-file]')?.getAttribute('data-preview-file')
      || e.target.closest('[data-reveal]')?.getAttribute('data-reveal');
    if (!previewFile) return;
    showFileCtx(e, decodeURIComponent(previewFile));
  }, true);
  $('preview-path').oncontextmenu = (e) => {
    if (state.previewPath) showFileCtx(e, state.previewPath);
  };
  document.querySelector('.preview-head').oncontextmenu = (e) => {
    if (e.target.closest('button')) return;
    if (state.previewPath) showFileCtx(e, state.previewPath);
  };
  $('ctx-menu').onclick = (e) => {
    e.stopPropagation();
    if (e.target.closest('[data-ctx="reveal"]') && state.ctxRel) revealInFolder(state.ctxRel);
  };
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented || e.target.closest('#ctx-menu')) return;
    hideCtxMenu();
  });
  dontStealFocus($('btn-preview-close'));
  $('btn-preview-close').onclick = () => closeCodePreview();
  $('btn-preview-at').onclick = () => {
    if (state.previewPath) addContextPath(state.previewPath);
  };
  $('preview-body').onclick = (e) => {
    const img = e.target.closest('img');
    if (img && img.src) openLightbox(img.src);
  };
  const lb = $('lightbox');
  if (lb) {
    lb.onclick = (e) => { if (e.target === lb) closeLightbox(); };
    $('lightbox-img').onclick = (e) => e.stopPropagation();
    lb.addEventListener('wheel', (e) => {
      if (lb.classList.contains('hidden')) return;
      e.preventDefault();
      const next = e.deltaY < 0 ? lightbox.scale * 1.12 : lightbox.scale / 1.12;
      lightbox.scale = Math.min(8, Math.max(0.2, next));
      applyLightbox();
    }, { passive: false });
    $('lightbox-img').onmousedown = (e) => {
      lightbox.dragging = true;
      lightbox.sx = e.clientX;
      lightbox.sy = e.clientY;
      lightbox.ox = lightbox.x;
      lightbox.oy = lightbox.y;
      e.preventDefault();
    };
    window.addEventListener('mousemove', (e) => {
      if (!lightbox.dragging) return;
      lightbox.x = lightbox.ox + (e.clientX - lightbox.sx);
      lightbox.y = lightbox.oy + (e.clientY - lightbox.sy);
      applyLightbox();
    });
    window.addEventListener('mouseup', () => { lightbox.dragging = false; });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('lightbox').classList.contains('hidden')) {
      e.preventDefault();
      closeLightbox();
      return;
    }
    if (!$('modal').classList.contains('hidden')) {
      e.preventDefault();
      const cancel = $('m-cancel');
      if (cancel) cancel.click();
      else closeModal();
    }
  });
  $('input').addEventListener('input', onInput);
  $('input').addEventListener('input', scheduleComposerSave);
  $('input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (state.refillFromIndex != null) {
        const et = activeSession();
        if (et) { et.refillFromIndex = null; et.refillRevertFiles = false; }
        state.refillFromIndex = null;
        state.refillRevertFiles = false;
        renderMessages();
      }
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  document.addEventListener('paste', async (e) => {
    if ($('view-chat').classList.contains('hidden')) return;
    if (e.target.closest('.modal')) return;
    const native = api.clipboardPasteSync() || { kind: 'none', files: [] };
    const items = [...(e.clipboardData?.items || [])];
    const hasEventFile = (e.clipboardData?.files && e.clipboardData.files.length)
      || items.some((it) => it.kind === 'file' || String(it.type || '').startsWith('image/'));
    const text = (e.clipboardData?.getData('text/plain') || '').trim();
    const useNativeFiles = native.kind === 'files' && native.files?.length;
    const useNativeImage = !hasEventFile && !text && native.kind === 'image' && native.files?.length;
    if (!hasEventFile && !useNativeFiles && !useNativeImage) return;
    e.preventDefault();
    try {
      const fromEvent = hasEventFile ? await attachmentsFromPasteEvent(e) : [];
      const fromNative = (useNativeFiles || useNativeImage) ? (native.files || []) : [];
      const all = [...fromEvent, ...fromNative];
      // AI 正在等回答时，粘贴的截图进提问卡片，其他文件照旧进输入框附件
      const isImg = (a) => isImageName(a?.name || a?.path || '');
      if (pendingAskMsg() && all.some(isImg)) {
        await addAskImages(all.filter(isImg));
        const rest = all.filter((a) => !isImg(a));
        if (rest.length) await addAttachments(rest);
      } else {
        await addAttachments(all);
      }
    } catch (err) {
      alert(err.message || err);
    }
  });
  const msgBox = $('messages');
  msgBox.addEventListener('input', (e) => {
    if (!e.target.classList?.contains('ask-input')) return;
    const m = pendingAskMsg();
    if (m) m.askDraft = e.target.value;
  });
  msgBox.addEventListener('change', async (e) => {
    if (!e.target.classList?.contains('ask-img-file')) return;
    const files = [...(e.target.files || [])];
    e.target.value = '';
    try {
      const list = [];
      for (const f of files) list.push(await fileToAttachment(f));
      await addAskImages(list);
    } catch (err) {
      alert(err.message || err);
    }
  });
  msgBox.addEventListener('dragover', (e) => {
    if (e.target.closest?.('[data-ask-card]')) e.preventDefault();
  });
  msgBox.addEventListener('drop', async (e) => {
    if (!e.target.closest?.('[data-ask-card]')) return;
    e.preventDefault();
    e.stopPropagation();
    try {
      const list = [];
      for (const f of [...(e.dataTransfer?.files || [])]) list.push(await fileToAttachment(f));
      await addAskImages(list);
    } catch (err) {
      alert(err.message || err);
    }
  });
  const composer = $('composer');
  composer.addEventListener('pointerdown', () => { api.focusWindow?.(); });
  composer.addEventListener('dragover', (e) => {
    e.preventDefault();
    composer.classList.add('drop-on');
  });
  composer.addEventListener('dragleave', () => composer.classList.remove('drop-on'));
  composer.addEventListener('drop', async (e) => {
    e.preventDefault();
    composer.classList.remove('drop-on');
    const files = [...(e.dataTransfer?.files || [])];
    if (!files.length) return;
    try {
      const list = [];
      for (const f of files) list.push(await fileToAttachment(f));
      await addAttachments(list);
    } catch (err) {
      alert(err.message || err);
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'F5') {
      e.preventDefault();
      refreshUiKeepChat();
      return;
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'o') { e.preventDefault(); openProject(); }
    const inInput = e.target && (e.target.id === 'input' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT');
    if (e.ctrlKey && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      if (inInput && e.target.value) return;
      e.preventDefault();
      undoTurn();
    }
    if ((e.ctrlKey && e.key.toLowerCase() === 'y') || (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'z')) {
      if (inInput && e.target.id === 'input' && e.target.value && e.key.toLowerCase() === 'y') return;
      e.preventDefault();
      redoTurn();
    }
  });
  const persistAllTabs = () => {
    for (const t of state.tabs) persistMessages(t);
  };
  window.addEventListener('pagehide', persistAllTabs);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') persistAllTabs(); });
}

api.onChatEvent(onChatEvent);
api.onWorkspaceChanged(() => {
  loadFileTree();
  if (state.previewPath) {
    openCodePreview(state.previewPath).catch(() => closeCodePreview());
  }
});
api.onUiRefresh(() => { refreshUiKeepChat(); });
api.onDownloadProgress(onDownloadProgress);
api.onIndexProgress(paintIndexCard);

(async function init() {
  bind();
  const s = await api.getState();
  setLocale(s.locale || 'zh');
  applyDom();
  state.themePref = s.theme;
  state.autoSave = s.autoSave;
  state.recents = s.recents || [];
  state.models = s.models || [];
  state.currentModelId = s.currentModelId;
  state.modelsDir = s.modelsDir || '';
  state.searchSites = s.searchSites || [];
  state.providers = s.providers || [];
  state.proxy = s.proxy || '';
  state.commandSandbox = s.commandSandbox || { enabled: true, timeoutSec: 60 };
  state.maxAgentRounds = clampAgentRounds(s.maxAgentRounds);
  state.desktopAlive = s.desktopAlive === true;
  const aliveBtn = $('btn-alive');
  if (aliveBtn) {
    aliveBtn.classList.toggle('on', state.desktopAlive);
    aliveBtn.setAttribute('aria-pressed', state.desktopAlive ? 'true' : 'false');
  }
  state.capabilityDefaults = s.capabilityDefaults || {};
  state.assemblies = s.assemblies || {};
  state.assemblyKey = s.assemblyKey || '';
  state.localFiles = s.localFiles || [];
  $('btn-autosave').querySelector('.check').classList.toggle('on', state.autoSave);
  applyTheme(s.resolvedTheme);
  setWorkspace(s.workspace);
  renderRecents();
  renderModelMenu();
  state.skills = await api.listSkills();
  state.persona = (await api.loadPersona()) || '';
  try {
    state.globalMemory = await api.getGlobalMemory();
  } catch {
    state.globalMemory = null;
  }
  if (s.workspace) {
    await refreshMeta();
    await restoreLastSession(s.workspace);
    showChat();
    renderTabs();
    renderMessages(true);
    renderQueue();
    syncSendBtn();
    syncAgentBtn();
  } else {
    showWelcome();
    syncAgentBtn();
  }
  syncRoundsInput(activeSession());
  initClipboardPanel();
  refreshQuotaBar();
})();
