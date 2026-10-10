// 常驻置顶悬浮对话栏：独立小窗 + 主 preload 桥，页面只用 float-bar.html，不碰 renderer/ 里的任何文件
const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, screen } = require('electron');
const store = require('./store');
const diag = require('./diag');

const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 280;
const MIN_WIDTH = 320;
const MIN_HEIGHT = 180;
// 最小化（紧凑）态窗口高度：只保留输入框 + 两行消息
const COMPACT_HEIGHT = 182;
// 紧凑态收放的分帧缓动：每帧约 16ms、共 11 帧，整段约 180ms
const COMPACT_ANIM_STEP_MS = 16;
const COMPACT_ANIM_FRAMES = 11;
// 自制抓柄缩放时的最小高度：宽度下限直接复用上面的 MIN_WIDTH（320，已是等价常量，不再新造一个）；
// 高度下限取 200，比建窗兜底的 MIN_HEIGHT（180）略高，保证缩到最小还能放下顶栏 + 输入框 + 两行消息
const MIN_H = 200;
/** 右上角留白：窗口宽 420 + 20，得到派单要求的 x = 工作区右边界 - 440 */
const RIGHT_GAP = 20;
const TOP_GAP = 24;
/** 拖动/缩放后延迟写盘，避免拖一次写几十回 */
const SAVE_DEBOUNCE_MS = 400;
/** 记下来的位置至少要露出这么多像素，免得窗口跑到屏幕外再也点不到 */
const KEEP_VISIBLE_X = 80;
const KEEP_VISIBLE_Y = 40;
/** 每个会话桶只留最近 30 条事件，切会话时整屏回灌 */
const HISTORY_LIMIT = 30;
/** 多开槽位时第 2 个起整体错开这么多像素，免得完全叠在一起 */
const SLOT_OFFSET_STEP = 40;
/** 位置按槽位分开存：userData/floatbar-slots/slot-N.json */
const SLOT_DIR = 'floatbar-slots';
/** moveToPlace 认识的方位名：四角 + 左右居中，opposite = 挪到当前象限的对角 */
const MOVE_PLACES = ['tl', 'tr', 'bl', 'br', 'left', 'right', 'opposite'];

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

function primaryBounds(slotNo) {
  // 多开时第 2 个起整体右下错开，避免完全重叠
  const offset = Math.max(0, (slotNo - 1) * SLOT_OFFSET_STEP);
  // 悬浮栏只能在 app ready 之后创建；这里兜底一下，免得未就绪时直接抛
  if (!app.isReady()) {
    return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT, x: 40 + offset, y: 40 + offset };
  }
  const area = screen.getPrimaryDisplay().workArea;
  return {
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    x: Math.round(area.x + area.width - (DEFAULT_WIDTH + RIGHT_GAP)) + offset,
    y: Math.round(area.y + TOP_GAP) + offset
  };
}

/** 把记下来的位置拉回可见范围：显示器拔掉或改分辨率后还能点到窗口 */
function keepOnScreen(bounds) {
  const area = screen.getDisplayMatching(bounds).workArea;
  const out = {
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y
  };
  const maxX = area.x + area.width - KEEP_VISIBLE_X;
  const minX = area.x - out.width + KEEP_VISIBLE_X;
  const maxY = area.y + area.height - KEEP_VISIBLE_Y;
  const minY = area.y;
  if (out.x > maxX) out.x = maxX;
  if (out.x < minX) out.x = minX;
  if (out.y > maxY) out.y = maxY;
  if (out.y < minY) out.y = minY;
  return out;
}

/**
 * 贴角/贴边的目标坐标：只算 x / y，宽高由调用方原样传。
 * 贴边留白沿用 keepOnScreen 里已有的边距常量 KEEP_VISIBLE_X / KEEP_VISIBLE_Y。
 */
function placeCoords(place, bounds, area) {
  const gapX = KEEP_VISIBLE_X;
  const gapY = KEEP_VISIBLE_Y;
  const left = Math.round(area.x + gapX);
  const right = Math.round(area.x + area.width - gapX - bounds.width);
  const top = Math.round(area.y + gapY);
  const bottom = Math.round(area.y + area.height - gapY - bounds.height);
  const middleY = Math.round(area.y + (area.height - bounds.height) / 2);
  if (place === 'tl') return { x: left, y: top };
  if (place === 'tr') return { x: right, y: top };
  if (place === 'bl') return { x: left, y: bottom };
  if (place === 'br') return { x: right, y: bottom };
  if (place === 'left') return { x: left, y: middleY };
  if (place === 'right') return { x: right, y: middleY };
  // 方位名没被识别，原坐标返回，绝不乱动
  return { x: bounds.x, y: bounds.y };
}

/**
 * 对角方位：以窗口中心相对工作区中心的 x / y 偏向判当前所处象限，再取对角。
 * 偏右上→左下，偏左上→右下，偏右下→左上，偏左下→右上。
 */
function oppositePlace(bounds, area) {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const onRight = cx >= area.x + area.width / 2;
  const onBottom = cy >= area.y + area.height / 2;
  if (onRight && !onBottom) return 'bl';
  if (!onRight && !onBottom) return 'br';
  if (onRight && onBottom) return 'tl';
  return 'tr';
}

/** 位置按槽位分开存：userData/floatbar-slots/slot-N.json */
function slotFilePath(slotNo) {
  return path.join(app.getPath('userData'), SLOT_DIR, 'slot-' + slotNo + '.json');
}

/** 把裸数据校验成可用位置，再拉回可见范围 */
function parseBounds(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return keepOnScreen({
    width: clampInt(raw.width, MIN_WIDTH, 1600, DEFAULT_WIDTH),
    height: clampInt(raw.height, MIN_HEIGHT, 1200, DEFAULT_HEIGHT),
    x: clampInt(x, -20000, 20000, 0),
    y: clampInt(y, -20000, 20000, 0)
  });
}

/** 读槽位位置；文件不存在/读坏时，只有 slot1 回退老键 store.floatBarBounds 当初值 */
function readSlotBounds(slotNo) {
  const file = slotFilePath(slotNo);
  try {
    const fromFile = parseBounds(JSON.parse(fs.readFileSync(file, 'utf8')));
    if (fromFile) return fromFile;
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      diag.log('floatbar', '读取悬浮栏位置失败', { slot: slotNo, message: e && e.message });
    }
  }
  // slotIndex !== 1 不用老键回退，避免多个槽位都堆到同一个老位置上
  if (slotNo !== 1) return null;
  try {
    return parseBounds(store.load().floatBarBounds);
  } catch (e) {
    diag.log('floatbar', '读取悬浮栏位置失败', { slot: slotNo, message: e && e.message });
  }
  return null;
}

/** 写槽位位置：目录不存在就递归建 */
function writeSlotBounds(slotNo, bounds) {
  const file = slotFilePath(slotNo);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(bounds), 'utf8');
  } catch (e) {
    diag.log('floatbar', '记住悬浮栏位置失败', { slot: slotNo, message: e && e.message });
  }
}

/**
 * 建常驻悬浮栏。
 * options = { slotIndex = 1, canHide = true, onSend(key, text, attachments), onAnswer(key, value), onAbort(key), onStart(key, value, note), onBind(key), onHide() }
 * onStart 的 value 原样透传不转换：空串 = 单颗「开始」，字符串数组 = 多选「一起开工」勾中的 value 清单；
 * note 是用户填的补充说明（可为空），同样原样透传不解析
 * 返回 { show(), hide(), toggle(), isVisible(), pushEvent(sessionKey, payload), setBoundKey(key), pushAsk(payload), isReady(), destroy(), moveToPlace(place) }
 * 事件按会话分桶：切绑定时把该会话最近 30 条一次性回灌给页面，整屏换内容
 */
function createFloatBar({ slotIndex = 1, canHide = true, ...opts } = {}) {
  const slotNo = clampInt(slotIndex, 1, 99, 1);
  let win = null;
  let pageReady = false;
  let autoShown = false;
  let userHidden = false;
  let quitting = false;
  let pendingEvent = null;
  let pendingAsk = null;
  let saveTimer = null;
  // 紧凑收放缓和动画的定时器 id：每进一次 setCompact 先清掉上一段，中途再点就从当前位置接着走
  let compactAnimTimer = null;
  // 紧凑（最小化）态标记：初值 false；一个模块里的小窗实例各持一份，多开槽位互不干扰
  let compactOn = false;
  // 进紧凑态前的正常窗口高度：退出紧凑时按它还原，落盘时也按它写，避免重启后小窗永远是矮的
  let savedHeight = 0;
  // 进紧凑态前小窗的底边 y（= b.y + b.height）：紧凑态钉住底边只压顶棚，退出时按它把顶边升回去
  let savedBottomY = 0;
  /** sessionKey → 最近 30 条事件 */
  const buckets = new Map();
  /** 页面当前绑定的会话键：只有它的事件才即时投递 */
  let boundKey = '';

  function keyOf(value) {
    if (value == null) return '';
    return typeof value === 'string' ? value : String(value);
  }

  /** 从页面 IPC 载荷里取显式传的 key，没传返回空串 */
  function keyFromPayload(raw) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.key != null) return keyOf(raw.key);
    return '';
  }

  app.on('before-quit', function () {
    quitting = true;
  });

  function resolveBounds() {
    return readSlotBounds(slotNo) || primaryBounds(slotNo);
  }

  function saveBoundsNow() {
    if (!win || win.isDestroyed()) return;
    try {
      const b = win.getBounds();
      // 紧凑态落盘要还原成正常高度：只加这一处判断，写盘路径与格式不动
      const height = compactOn ? (savedHeight > 0 ? savedHeight : DEFAULT_HEIGHT) : b.height;
      // 紧凑态落盘的顶边也要按「底边 - 正常高度」换算：直接写被压下去的顶边，
      // 下次启动小窗就会整体往上漂，底边口径才对得上现在的位置
      const y = compactOn ? (b.y + b.height) - height : b.y;
      writeSlotBounds(slotNo, { x: b.x, y: y, width: b.width, height: height });
    } catch (e) {
      diag.log('floatbar', '记住悬浮栏位置失败', { slot: slotNo, message: e && e.message });
    }
  }

  function scheduleSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveBoundsNow();
    }, SAVE_DEBOUNCE_MS);
  }

  function flushPending() {
    if (!pageReady || !win || win.isDestroyed()) return;
    if (pendingEvent) {
      const ev = pendingEvent;
      pendingEvent = null;
      // 补发前再核一遍：只有全局广播或当前绑定会话才给页面
      if (ev.kind === 'sessions' || keyOf(ev.sessionKey) === boundKey) {
        win.webContents.send('floatbar:event', ev);
      }
    }
    if (pendingAsk) {
      const ask = pendingAsk;
      pendingAsk = null;
      win.webContents.send('floatbar:ask', ask);
    }
  }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    pageReady = false;
    const b = resolveBounds();
    win = new BrowserWindow({
      width: b.width,
      height: b.height,
      x: b.x,
      y: b.y,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      frame: false,
      // 窗口图标与主窗（electron/main.js 的 createWindow）同一份：仓库根目录的 icons.png，
      // 本文件在 electron/lib/ 下，所以往上两级就是仓库根
      icon: path.join(__dirname, '..', '..', 'icons.png'),
      transparent: true,
      resizable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      hasShadow: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    });
    win.setAlwaysOnTop(true, 'pop-up-menu');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // 系统级缩放建窗后立刻关掉（false）：Windows 会给无边框窗口留一圈约 8px 的隐形缩放边框，
    // 它比肉眼看到的窗口更粗且外偏，抓哪里都像抓到顶棚 —— 这是小窗位置跳变的根因。
    // 缩放改由页面右下角那根自制抓柄负责：它算好目标宽高走 floatbar:resize，最后落到本文件的 resizeBy。
    // 关掉系统缩放不影响 setBounds（紧凑态就是先关缩放再 setBounds 压高度），钉底边那套照旧
    setWinResizable(false);
    // 用户点关闭只收起，不做退出；真正退出由主进程 destroy
    win.on('close', function (event) {
      if (quitting) return;
      event.preventDefault();
      hide();
    });
    win.on('closed', function () {
      win = null;
      pageReady = false;
      // 窗口没了，紧凑标记与记下的正常高度、底边一起作废：下次重建窗口又是一条干净的开始
      compactOn = false;
      savedHeight = 0;
      savedBottomY = 0;
    });
    // 'moved' 在有些平台上不触发，所以连 'move' 一起听；写盘有 400ms 防抖，拖动时不会写爆
    win.on('move', scheduleSave);
    win.on('moved', scheduleSave);
    win.on('resize', scheduleSave);
    win.on('resized', scheduleSave);
    win.webContents.on('render-process-gone', function (_e, details) {
      diag.log('floatbar', '悬浮栏渲染进程退出', details);
    });
    win.webContents.on('did-finish-load', function () {
      pageReady = true;
      flushPending();
      if (!autoShown) {
        autoShown = true;
        // 首次加载完就露面（常驻），用了 showInactive 免得抢走主窗焦点
        if (!userHidden && win && !win.isDestroyed()) win.showInactive();
      }
    });
    win.loadFile(path.join(__dirname, 'float-bar.html'));
    return win;
  }

  function show() {
    userHidden = false;
    const w = ensureWindow();
    if (w.isMinimized()) w.restore();
    w.show();
    w.setAlwaysOnTop(true, 'pop-up-menu');
  }

  function hide() {
    if (!canHide) {
      // 锁死不能隐藏：不收起窗口，改推一条顶栏提示，只能从主界面退出
      pushEvent(boundKey, { kind: 'pinned-locked', text: '全局快捷键被占用，请从主界面退出' });
      return;
    }
    userHidden = true;
    if (win && !win.isDestroyed()) win.hide();
  }

  function isVisible() {
    return !!(win && !win.isDestroyed() && win.isVisible());
  }

  function toggle() {
    if (isVisible()) hide();
    else show();
  }

  function isReady() {
    return !!(win && !win.isDestroyed() && pageReady);
  }

  /**
   * 切系统级缩放：现在只有一个合法取值 false（自制抓柄接管缩放，理由见建窗处的注释）。
   * 形参保留，是为了不动 setCompact 进 / 出紧凑态那两处调用点的形状；
   * 窗口对象没有该方法时静默跳过，绝不抛错。
   */
  function setWinResizable(flag) {
    if (!win || win.isDestroyed() || typeof win.setResizable !== 'function') return;
    // 现在只允许 false：自制抓柄接管缩放，调用点传别的值也一律按 false 关掉，不会重新打开系统缩放
    if (flag !== false) {
      diag.log('floatbar', '忽略小窗系统缩放开关，统一关掉（自制抓柄接管）', { slot: slotNo });
    }
    try {
      win.setResizable(false);
    } catch (e) {
      diag.log('floatbar', '切换小窗缩放开关失败', { slot: slotNo, message: e && e.message });
    }
  }

  /** 紧凑状态变化后同步给页面：沿用本文件已有的 webContents.send 直发风格；页面没监听也不影响主流程 */
  function syncCompactState() {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send('floatbar:state', { compact: compactOn });
    } catch (e) {
      diag.log('floatbar', '同步小窗紧凑状态失败', { slot: slotNo, message: e && e.message });
    }
  }

  /**
   * 改完窗口 bounds 之后强制整窗重绘（进 / 出紧凑态这两条 setBounds 链路共用这一份，不再复制第二份）。
   * 背景：setBounds 改的是窗口尺寸/位置，无边框透明小窗（frame:false + transparent）在尺寸变化后
   * 不一定会触发整窗重绘，于是旧文字残留在原位形成叠字/残影，消息区还可能被裁、把底部输入区挤出窗口。
   * 两件事缺一不可：
   *   1) 主进程侧让 webContents 整窗失效重绘；窗口正在关闭时静默忽略，绝不抛错；
   *   2) 沿用本文件已有的 floatbar:event 这条通道推一条 { kind: 'repaint' }，让渲染层强制回流。
   */
  function repaintAfterBounds() {
    if (!win || win.isDestroyed()) return;
    try {
      if (win.webContents && !win.webContents.isDestroyed()) win.webContents.invalidate();
    } catch (e) {
      // 忽略：窗口可能正在关闭
    }
    try {
      // 与 flushPending / pushEvent 同一条通道、同一个 channel 名；页面没监听也不影响主流程
      if (win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('floatbar:event', { kind: 'repaint' });
      }
    } catch (e) {
      diag.log('floatbar', '通知小窗强制重绘失败', { slot: slotNo, message: e && e.message });
    }
  }

  /**
   * 紧凑态收 / 放的逐帧缓动：把原来「一次 setBounds 直接跳到位」换成多帧过渡。
   * 起点取调用时的实时 bounds（win.getBounds()，不是记下来的旧值），所以动画没走完再点一次，
   * 也是从窗口当前位置接着走，不会跳回去；每次进入本函数先清掉上一段没走完的定时器。
   * 全程钉住底边、x 与宽度不变：每帧用「底边 - 该帧高度」反推该帧 y。
   * 每帧 setBounds 之后都调 repaintAfterBounds() 整窗重绘；最后一帧落到精确目标高度后停表，
   * 并且只有最后一帧才调 onDone（= syncCompactState），动画中途一律不调。
   * ease-out 曲线 1 - (1 - t)^3，11 帧 × 16ms ≈ 180ms。
   */
  function animateCompact(targetHeight, onDone) {
    if (compactAnimTimer) {
      clearTimeout(compactAnimTimer);
      compactAnimTimer = null;
    }
    const w = win;
    if (!w || w.isDestroyed()) return;
    const from = w.getBounds();
    const bottom = from.y + from.height;
    let frame = 0;
    function step() {
      compactAnimTimer = null;
      if (!win || win.isDestroyed()) return;
      frame += 1;
      const last = frame >= COMPACT_ANIM_FRAMES;
      const t = last ? 1 : frame / COMPACT_ANIM_FRAMES;
      const eased = 1 - Math.pow(1 - t, 3);
      const height = last ? targetHeight : Math.round(from.height + (targetHeight - from.height) * eased);
      win.setBounds({ x: from.x, y: bottom - height, width: from.width, height: height });
      repaintAfterBounds();
      if (last) {
        // 落定到精确目标高度之后才同步紧凑状态给页面：动画中途不通知
        if (typeof onDone === 'function') onDone();
        return;
      }
      compactAnimTimer = setTimeout(step, COMPACT_ANIM_STEP_MS);
    }
    step();
  }

  /**
   * 最小化（紧凑）态切换：on=true 收起，on=false 还原。
   * 位置口径：钉住底边、只压顶棚 —— 底边屏幕坐标全程不动，只把顶边往下压（高度改小）；
   * 展开时再把顶边升回去，底边仍在原位，所以展开后位置跟进紧凑前完全一致，用户不用手动校准。
   * 进紧凑前先把正常高度记到 savedHeight、把底边记到 savedBottomY（此时 compactOn 必为 false）。
   * 紧凑期间与正常态一样关着系统缩放（自制抓柄接管，见 setWinResizable）；进出紧凑态这两处都传 false。
   * 收 / 放两条路径都走 animateCompact 逐帧缓动（约 180ms），画面不再瞬移，底边全程不动。
   * 状态没真变就直接 return，重复调同一个值不动窗口。
   */
  function setCompact(on) {
    const next = on === true;
    if (next === compactOn) return;
    const w = ensureWindow();
    if (!w || w.isDestroyed()) return;
    const b = w.getBounds();
    if (next) {
      // 进紧凑：先存正常高度和底边，再把顶边压到「底边 - 紧凑高度」，x / width 原样不动
      if (!compactOn) savedHeight = b.height;
      savedBottomY = b.y + b.height;
      compactOn = true;
      setWinResizable(false);
      // 逐帧缓动收到紧凑高度：每帧自己重绘，最后一帧落定后才 syncCompactState 通知页面收成两条消息
      animateCompact(COMPACT_HEIGHT, syncCompactState);
    } else {
      // 退出紧凑：底边取动画起点时的实时 bounds（用户紧凑期间拖动过小窗也不会错位，与 savedBottomY 同值），
      // 用还原高度把顶边升回去，底边原地不动；缓动同样最后一帧才同步状态
      compactOn = false;
      const restore = savedHeight > 0 ? savedHeight : DEFAULT_HEIGHT;
      animateCompact(restore, syncCompactState);
      // 退出紧凑态同样保持「系统缩放关着」：所有 setResizable 调用点统一 false，正常态也不放开
      setWinResizable(false);
      savedHeight = 0;
      savedBottomY = 0;
    }
  }

  /**
   * 按方位挪动小窗（供主进程调用）：只改 x / y，宽高完全取当前值原样传，不动缩放与紧凑逻辑。
   * 方位取值：'tl' 左上、'tr' 右上、'bl' 左下、'br' 右下（贴角，留出与工作区边缘的间距），
   * 'left' 贴左侧垂直居中，'right' 贴右侧垂直居中，
   * 'opposite' 挪到与当前所处象限的对角（按窗口中心相对工作区中心的 x / y 偏向判定）。
   * 传入其它值时返回 { ok:false, error:'bad-place' }，且不移动窗口。
   * 挪完复用 writeSlotBounds 落盘，保证下次开机还在新位置。
   */
  function moveToPlace(place) {
    const name = typeof place === 'string' ? place : '';
    if (MOVE_PLACES.indexOf(name) < 0) return { ok: false, error: 'bad-place' };
    const w = ensureWindow();
    if (!w || w.isDestroyed()) return { ok: false, error: 'no-window' };
    const b = w.getBounds();
    // 所在显示器工作区：取法与 keepOnScreen 保持一致
    const area = screen.getDisplayMatching(b).workArea;
    // opposite 先按当前象限换算成具体的贴角方位
    const target = name === 'opposite' ? oppositePlace(b, area) : name;
    const spot = placeCoords(target, b, area);
    w.setBounds({ x: spot.x, y: spot.y, width: b.width, height: b.height });
    // 落盘沿用 saveBoundsNow 的同一条规则：紧凑态写回进紧凑前的正常高度，免得重启后小窗永远是矮的
    const saveHeight = compactOn ? (savedHeight > 0 ? savedHeight : DEFAULT_HEIGHT) : b.height;
    // 顶边同样按「底边 - 正常高度」换算：紧凑态直接写被压下去的顶边，下次启动位置会往上漂
    const saveY = compactOn ? (spot.y + b.height) - saveHeight : spot.y;
    writeSlotBounds(slotNo, { x: spot.x, y: saveY, width: b.width, height: saveHeight });
    // 紧凑态挪完窗，钉住的底边跟着新位置走，展开时按这里记的底边把顶边升回去
    if (compactOn) savedBottomY = spot.y + b.height;
    return { ok: true, place: target, x: spot.x, y: spot.y, width: b.width, height: b.height };
  }

  /**
   * 右下角自制抓柄改尺寸（供主进程调用，通道 floatbar:resize）：入参是页面按拖动位移换算好的「目标宽高」{ w, h }。
   * 口径：只改宽高，左上角（x / y）一律原样传、一个像素不动；宽高各自 clamp 到
   * [MIN_WIDTH(320), 所在显示器工作区宽] 与 [MIN_H(200), 所在显示器工作区高]，拖过头就停在边界值上。
   * 紧凑态直接拒绝（{ ok:false, error:'compact' }）且一点都不碰窗口：紧凑态钉底边那套只归 setCompact 管，
   * 不能被这里带偏；同理顺手让拖到一半进紧凑的拖动立刻收手。
   * 入参不是有限数字时回 { ok:false, error:'bad-size' }，同样不动窗口。
   * 改完调 saveBoundsNow() 落盘：落盘口径与其它入口共用同一份（含紧凑态换算那条），这里自己不算高度。
   */
  function resizeBy(payload) {
    const w = ensureWindow();
    if (!w || w.isDestroyed()) return { ok: false, error: 'no-window' };
    if (compactOn) return { ok: false, error: 'compact' };
    const raw = payload && typeof payload === 'object' ? payload : {};
    const wantW = Math.round(Number(raw.w));
    const wantH = Math.round(Number(raw.h));
    if (!Number.isFinite(wantW) || !Number.isFinite(wantH)) return { ok: false, error: 'bad-size' };
    const b = w.getBounds();
    // 所在显示器工作区：取法与 moveToPlace / 贴边逻辑保持一致
    const area = screen.getDisplayMatching(b).workArea;
    const width = Math.min(Math.max(wantW, MIN_WIDTH), area.width);
    const height = Math.min(Math.max(wantH, MIN_H), area.height);
    // 钉住左上角：x / y 取自当前 bounds 原样回填，只换宽高
    w.setBounds({ x: b.x, y: b.y, width: width, height: height });
    saveBoundsNow();
    return { ok: true, w: width, h: height };
  }

  /** 主进程按窗口找实例时用：判定传入窗口是不是本实例的小窗（认不出就走主进程自己的兜底判定） */
  function ownsWindow(target) {
    return !!(win && !win.isDestroyed() && target === win);
  }

  /**
   * 事件入口，两种写法都认：
   * pushEvent(sessionKey, payload) —— 正常用法
   * pushEvent(payload)            —— 老写法，等价于 pushEvent('', payload)
   */
  function pushEvent(sessionKey, payload) {
    let key;
    let raw;
    if (arguments.length <= 1) {
      key = '';
      raw = sessionKey;
    } else {
      key = keyOf(sessionKey);
      raw = payload;
    }
    if (!raw || typeof raw !== 'object') return;
    const ev = Object.assign({}, raw);
    // 整份载荷原样透传：kind === 'start-ready' 带的 options（开始方案数组）也一并给页面，这里不删字段
    // 强制补 sessionKey：payload 自己带了的以它为准
    ev.sessionKey = (ev.sessionKey == null || ev.sessionKey === '') ? key : keyOf(ev.sessionKey);

    let bucket = buckets.get(ev.sessionKey);
    if (!bucket) {
      bucket = [];
      buckets.set(ev.sessionKey, bucket);
    }
    bucket.push(ev);
    // 超出上限从头部丢
    while (bucket.length > HISTORY_LIMIT) bucket.shift();

    // kind === 'sessions' 是全局广播（刷新会话列表），跟绑没绑定无关，始终发
    const isGlobal = ev.kind === 'sessions';
    const w = ensureWindow();
    if (pageReady && w && !w.isDestroyed()) {
      if (isGlobal || ev.sessionKey === boundKey) w.webContents.send('floatbar:event', ev);
      return;
    }
    // 页面没加载完先留最后一条，did-finish-load 后补发
    if (isGlobal || ev.sessionKey === boundKey) pendingEvent = ev;
  }

  /**
   * 绑定键统一入口：页面上报（floatbar:bind）与主进程推来的键都走这里，避免多处赋值不一致。
   * 切换绑定会话时把该桶已有消息一次性回灌给页面（切桶整屏换内容，每桶 30 条上限不变）。
   * 空键不覆盖已有的非空绑定：偶发空值只当「请求校准」，别把顶栏打回「未绑定会话」。
   */
  function setBoundKey(key) {
    const next = keyOf(key);
    // 空值不清掉已经绑好的会话键；真要解绑时主进程会推一个非空键过来
    if (!next && boundKey) return;
    boundKey = next;
    const bucket = buckets.get(boundKey);
    const items = bucket ? bucket.slice() : [];
    const ev = { kind: 'history', sessionKey: boundKey, items };
    const w = ensureWindow();
    if (pageReady && w && !w.isDestroyed()) {
      w.webContents.send('floatbar:event', ev);
      return;
    }
    pendingEvent = ev;
  }

  function pushAsk(payload) {
    if (!payload) return;
    const w = ensureWindow();
    if (pageReady && w && !w.isDestroyed()) {
      w.webContents.send('floatbar:ask', payload);
      return;
    }
    pendingAsk = payload;
  }

  function destroy() {
    // destroy 不触发 close 事件，所以不用动 quitting；quitting 只跟 app 的 before-quit 走
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    saveBoundsNow();
    if (win && !win.isDestroyed()) win.destroy();
    win = null;
    pageReady = false;
  }

  // 悬浮栏通道在这里统一绑一次，避免主进程别处再绑一份造成重复发送
  // 回调一律把会话键放第一位：页面带 key 就用页面的，没带就用当前绑定兜底
  ipcMain.on('floatbar:send', function (_e, raw) {
    const key = keyFromPayload(raw) || boundKey;
    const text = (raw && typeof raw === 'object') ? raw.text : raw;
    // 附件清单（图片粘贴后落盘得到的 { path, name } 数组）原样透传给主进程，
    // 这里不筛选不校验：老的两参调用没带 attachments，统一兜底成空数组，主进程按数组处理
    const attachments = (raw && typeof raw === 'object' && Array.isArray(raw.attachments))
      ? raw.attachments
      : [];
    if (typeof opts.onSend === 'function') opts.onSend(key, String(text == null ? '' : text), attachments);
  });
  ipcMain.on('floatbar:answer', function (_e, raw) {
    const key = keyFromPayload(raw) || boundKey;
    const value = (raw && typeof raw === 'object' && 'value' in raw) ? raw.value : raw;
    // 整对象透传：同一个窗口可能有多个标签页在等回答，turnId 必须一起带到主进程，主进程不允许猜
    const turnId = String(raw && raw.turnId != null ? raw.turnId : '');
    if (typeof opts.onAnswer === 'function') opts.onAnswer({ key: key, value: value, turnId: turnId });
  });
  ipcMain.on('floatbar:abort', function (_e, raw) {
    const key = keyFromPayload(raw) || boundKey;
    const turnId = String(raw && raw.turnId != null ? raw.turnId : '');
    if (typeof opts.onAbort === 'function') opts.onAbort({ key: key, turnId: turnId });
  });
  // 小窗点「开始」：页面按契约发 { sessionKey, value }，两个键名都认
  // key 定位哪个会话，value 是用户点的那颗方案按钮的值（顶栏按钮给的）：空串 = 点默认那颗，
  // 数组 = 多选「一起开工」勾中的 value 清单（长度就是勾选数量）
  // value 一律原样透传（数组保持数组），只有 undefined/null 才用空串兜底；
  // 这里禁止 String()/join()/JSON 拼串，一转就会把数组压成 "[object Object]" 或 "a,b"
  // 这里只透传，不解析 value 的含义，也不判断能不能开工（判定只有 renderer/app.js 一份）
  // 补充说明 note（用户填的补充说明，字符串，可为空）同样原样透传到主进程：
  // 这一环纯转发，不解析、不拼串、不做 String() 字符串化，没传时兜底成空串
  ipcMain.on('floatbar:start', function (_e, raw) {
    const key = keyFromPayload(raw) || (raw && typeof raw === 'object' ? keyOf(raw.sessionKey) : '') || boundKey;
    const value = (raw && typeof raw === 'object' && raw.value != null) ? raw.value : '';
    const note = (raw && typeof raw === 'object' && raw.note != null) ? raw.note : '';
    if (typeof opts.onStart === 'function') opts.onStart(key, value, note);
  });
  /**
   * 页面上报绑定键的统一入口（floatbar:bind → 主进程），绑定键的赋值只在这里发生，避免多处赋值不一致。
   * 非空键：页面自己认领的会话，直接切桶回灌；
   * 空键（空串／undefined）：不覆盖已有的非空绑定（本地的非空 boundKey 不被空值清掉），
   * 但照常把这次上报转给主进程 —— 沿用文件里已有的这条上报通道 opts.onBind，不新造通道名 ——
   * 由主进程回一次该会话的 history 回灌来校准，免得页面首发时机不巧时一条事件都收不到、顶栏一直「未绑定会话」
   */
  function reportBoundKeyFromPage(raw) {
    const key = keyFromPayload(raw) || (typeof raw === 'string' ? keyOf(raw) : '');
    if (key) setBoundKey(key);
    if (typeof opts.onBind === 'function') opts.onBind(key || boundKey);
  }
  ipcMain.on('floatbar:bind', function (_e, raw) {
    reportBoundKeyFromPage(raw);
  });
  ipcMain.on('floatbar:hide', function () {
    hide();
    if (typeof opts.onHide === 'function') opts.onHide();
  });
  // 小窗最小化/还原（主进程转发过来的指令）：跟本文件其他小窗通道同一 IP 风格注册，实例初始化时绑一次。
  // 只有消息来自本实例的小窗才处理，认不出归属直接忽略，绝不误动别的小窗；重复调用由 setCompact 自行去重
  ipcMain.on('floatbar:compact', function (event, on) {
    let senderWin = null;
    try {
      senderWin = BrowserWindow.fromWebContents(event.sender);
    } catch (e) {
      senderWin = null;
    }
    if (!senderWin || !ownsWindow(senderWin)) return;
    setCompact(on === true);
  });

  ensureWindow();

  return { show, hide, toggle, isVisible, pushEvent, setBoundKey, pushAsk, isReady, destroy, setCompact, ownsWindow, moveToPlace, resizeBy };
}

module.exports = { createFloatBar };
