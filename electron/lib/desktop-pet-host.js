// 桌宠保持独立角色窗口；聊天与输入使用同实例的独立置顶窗口。
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const config = require('./desktop-pet-config.json');
const { createLibrary } = require('./desktop-pet-skins');
/** IPC 按实际发送页查找实例，不接受页面自行指定其他窗口编号。 */
const endpoints = new Map();
ipcMain.handle('desktop-pet:invoke', function (event, data) {
  const methods = endpoints.get(event.sender.id);
  if (!methods || !methods.has(data.method)) throw new Error('桌宠接口或实例不存在');
  return methods.get(data.method)(data.payload);
});

/** 管理独立角色窗与对话窗；角色脚底定位、皮肤和透明命中只作用于角色窗。 */
function attach(win, slotNo, initialBounds, onDialogueReady) {
  const file = path.join(app.getPath('userData'), 'desktop-pets', 'slot-' + slotNo + '.json');
  const library = createLibrary(app.getPath('userData'));
  let settings = { skin: config.defaultSkin, scale: config.defaultScale, speed: 1, reducedMotion: false, glasses: config.glasses.defaultEnabled, glassesOffsetX: config.glasses.horizontalOffset, glassesOffsetY: config.glasses.verticalOffset, footX: initialBounds.x + initialBounds.width - config.layout.petWidth * config.defaultScale / 2, footY: initialBounds.y + initialBounds.height };
  // 旧版偏好补齐眼镜开关与两轴偏移，保留已保存的皮肤、位置和用户调整。
  if (fs.existsSync(file)) settings = Object.assign({ glasses: config.glasses.defaultEnabled, glassesOffsetX: config.glasses.horizontalOffset, glassesOffsetY: config.glasses.verticalOffset }, JSON.parse(fs.readFileSync(file, 'utf8')));
  let expanded = false;
  // 草稿随独立页面保留，收起只隐藏窗口，不销毁或重建输入节点。
  let dialogue = null;
  let dialogueReady = false;
  let pendingMenu = false;
  let focusOnShow = true;
  // 外观菜单在独立页，动作预览仍由角色页实际播放。
  let preview = '';
  let dragging = null;
  let ignoring = false;
  let placement = null;
  const methods = new Map();
  endpoints.set(win.webContents.id, methods);
  /** 同一窗口的方法只登记在它的专属表内。 */
  function register(channel, fn) { methods.set(channel, fn); }
  /** 角色随设置缩放；hudHeight 为信息区留高，hudMinWidth 保证余额在小比例下仍可读。 */
  function petSize() {
    return {
      width: Math.max(config.layout.hudMinWidth, Math.round(config.layout.petWidth * settings.scale)),
      height: Math.max(Math.round(config.layout.petHeight * settings.scale), Math.ceil(config.layout.petSize * settings.scale + config.layout.hudHeight))
    };
  }
  /** 获取当前形态的尺寸；HUD 留白与面板尺寸统一来自配置文件。 */
  function size() {
    const pet = petSize();
    return { width: expanded ? config.layout.panelWidth : pet.width, height: expanded ? config.layout.panelHeight + pet.height : pet.height };
  }
  /** 将整个角色拉回所在显示器工作区，展开时按可用空间放置。 */
  function layout() {
    const area = screen.getDisplayNearestPoint({ x: Math.round(settings.footX), y: Math.round(settings.footY) }).workArea;
    const pet = petSize();
    const pw = pet.width;
    const ph = pet.height;
    settings.footX = Math.max(area.x + pw / 2, Math.min(settings.footX, area.x + area.width - pw / 2));
    settings.footY = Math.max(area.y + ph, Math.min(settings.footY, area.y + area.height));
    const petX = Math.round(settings.footX - pw / 2);
    const petY = Math.round(settings.footY - ph);
    let x = petX, y = petY, width = pw, height = ph;
    placement = { petLeft: 0, petTop: 0, petWidth: pw, petHeight: ph, panelLeft: 0, panelTop: 0, panelWidth: 0, panelHeight: 0 };
    // 输入面板不再扩大角色窗口，透明命中和脚底坐标始终以宠物自身计算。
    win.setBounds({ x, y, width, height });
  }
  /**
   * 输入窗首次在鼠标所在屏幕居中，与角色坐标无关。
   * 显示器变化时按输入窗自身位置限制在工作区内，保留用户拖动后的独立位置。
   */
  function dialogueBounds() {
    const bounds = dialogue ? dialogue.getBounds() : null;
    const point = bounds ? { x: bounds.x + Math.round(bounds.width / 2), y: bounds.y + Math.round(bounds.height / 2) } : screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(point).workArea;
    const width = Math.min(config.layout.panelWidth, area.width);
    const height = Math.min(config.layout.panelHeight, area.height);
    const x = bounds ? bounds.x : area.x + (area.width - width) / 2;
    const y = bounds ? bounds.y : area.y + (area.height - height) / 2;
    return {
      x: Math.round(Math.max(area.x, Math.min(x, area.x + area.width - width))),
      y: Math.round(Math.max(area.y, Math.min(y, area.y + area.height - height))),
      width, height
    };
  }
  /** 仅向已加载的对话页转发事件；首次加载由宿主回灌当前绑定会话。 */
  function send(channel, data) {
    if (dialogueReady) dialogue.webContents.send(channel, data);
  }
  /** 两个窗口共享外观及展开状态，菜单请求只发给独立对话页。 */
  function notifyView() {
    const data = { expanded, settings, placement, preview };
    win.webContents.send('desktop-pet:view', data);
    send('desktop-pet:view', Object.assign({}, data, { menu: pendingMenu }));
    if (dialogueReady) pendingMenu = false;
  }
  /** 创建同实例的置顶输入窗；首次就绪后回灌历史，再将键盘焦点交给输入框。 */
  function ensureDialogue() {
    if (dialogue) return;
    dialogue = new BrowserWindow(Object.assign(dialogueBounds(), {
      title: 'SpCode 独立输入框', frame: false, transparent: true,
      alwaysOnTop: true, skipTaskbar: true, show: false, resizable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false }
    }));
    dialogue.setAlwaysOnTop(true, 'screen-saver');
    dialogue.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const dialogueId = dialogue.webContents.id;
    endpoints.set(dialogueId, methods);
    dialogue.on('close', function (event) { event.preventDefault(); setExpanded(false); });
    dialogue.on('closed', function () {
      endpoints.delete(dialogueId);
      dialogue = null;
      dialogueReady = false;
    });
    dialogue.webContents.on('did-finish-load', function () {
      dialogueReady = true;
      onDialogueReady();
      notifyView();
      if (expanded) {
        if (focusOnShow) { dialogue.show(); dialogue.focus(); send('desktop-pet:focus'); }
        else dialogue.showInactive();
      }
    });
    dialogue.loadFile(path.join(__dirname, 'float-bar.html'), { query: { dialogue: '1' } });
  }
  /** 保存角色脚底、皮肤和显示偏好；不改动会话或用户输入。 */
  function save() {
    const b = win.getBounds();
    settings.footX = b.x + placement.petLeft + placement.petWidth / 2;
    settings.footY = b.y + placement.petTop + placement.petHeight;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(settings, null, 2), 'utf8');
  }
  /** 返回同一份界面状态，初始化及热换肤共用。 */
  function payload() { return { config, settings, expanded, placement, preview, skins: library.list() }; }
  /**
   * 展开独立对话窗并捕获后续键盘输入；收起保留页面与草稿。
   * focusInput 为 false 用于程序确认卡片，避免工作中抢走用户原软件的输入焦点。
   */
  function setExpanded(on, focusInput = true) {
    expanded = on === true;
    focusOnShow = focusInput;
    if (expanded) {
      ensureDialogue();
      if (dialogueReady) {
        if (focusInput) { dialogue.show(); dialogue.focus(); send('desktop-pet:focus'); }
        else dialogue.showInactive();
      }
    } else if (dialogue) dialogue.hide();
    notifyView();
  }
  /**
   * 只切换角色窗自身的鼠标穿透，不注册 Windows 全局鼠标钩子。
   * Electron 的 forward 会让系统鼠标事件等待主线程；繁忙时可能拖慢整机输入。
   * 穿透期间由角色页限频采样鼠标位置，仍按当前画面的透明像素恢复命中。
   */
  function setIgnoring(on) {
    if (on === ignoring) return;
    ignoring = on;
    win.setIgnoreMouseEvents(on, { forward: false });
  }
  /**
   * 返回可见角色窗内的鼠标坐标，供页面做像素命中；隐藏或拖动期间返回 null。
   * 屏幕和窗口位置使用 DIP，再除以页面缩放比例得到 CSS 坐标；只读坐标，不接管系统输入。
   */
  function cursorPosition() {
    if (!win.isVisible() || dragging) return null;
    const point = screen.getCursorScreenPoint();
    const bounds = win.getContentBounds();
    const zoom = win.webContents.getZoomFactor();
    return { clientX: (point.x - bounds.x) / zoom, clientY: (point.y - bounds.y) / zoom };
  }
  register('desktop-pet:cursor', cursorPosition);
  /** 形态与资源加载后页面主动请求，避免 did-finish-load 首帧竞态。 */
  register('desktop-pet:init', payload);
  register('desktop-pet:expand', function (data) { setExpanded(data === true); return expanded; });
  /** 角色右键请求在独立对话窗显示设置，不把菜单挤进角色尺寸。 */
  register('desktop-pet:menu', function () { pendingMenu = true; setExpanded(true); return expanded; });
  /** 菜单预览同步到角色页，仅改变演出，不改真实任务状态。 */
  register('desktop-pet:preview', function (state) { preview = state; notifyView(); });
  register('desktop-pet:hit', function (data) { setIgnoring(dragging ? false : data !== true); return !ignoring; });
  register('desktop-pet:drag', function (data) {
    if (data.phase === 'start') {
      const p = screen.getCursorScreenPoint();
      dragging = { x: p.x, y: p.y, bounds: win.getBounds() };
      setIgnoring(false);
    } else if (data.phase === 'move' && dragging) {
      const p = screen.getCursorScreenPoint();
      win.setPosition(dragging.bounds.x + p.x - dragging.x, dragging.bounds.y + p.y - dragging.y);
    } else if (data.phase === 'end') {
      dragging = null;
      const b = win.getBounds();
      settings.footX = b.x + placement.petLeft + placement.petWidth / 2;
      settings.footY = b.y + placement.petTop + placement.petHeight;
      layout();
      save();
    }
    return win.getBounds();
  });
  register('desktop-pet:settings', function (data) {
    if ('skin' in data) {
      const skin = library.list().find(function (one) { return one.id === data.skin && !one.error; });
      if (!skin) throw new Error('所选皮肤不存在或资源不完整');
      settings.skin = data.skin;
    }
    if ('scale' in data) {
      if (!Number.isFinite(data.scale) || data.scale < config.layout.minScale || data.scale > config.layout.maxScale) throw new Error('显示大小超出允许范围');
      settings.scale = data.scale;
    }
    if ('speed' in data) {
      if (!Number.isFinite(data.speed) || data.speed < 0.5 || data.speed > 2) throw new Error('动作速度必须为 0.5 至 2');
      settings.speed = data.speed;
    }
    if ('reducedMotion' in data) settings.reducedMotion = data.reducedMotion === true;
    // 配饰开关随当前桌宠实例保存，不改变皮肤或工作状态。
    if ('glasses' in data) settings.glasses = data.glasses === true;
    // 两轴偏移使用图集像素并独立保存；X 负数左移、正数右移，与页面共用配置范围。
    if ('glassesOffsetX' in data) {
      if (!Number.isFinite(data.glassesOffsetX) || data.glassesOffsetX < config.glasses.position.min || data.glassesOffsetX > config.glasses.position.max) throw new Error('眼镜左右位置超出允许范围');
      settings.glassesOffsetX = data.glassesOffsetX;
    }
    // Y 负数上移、正数下移，调整 X 时保留已保存的 Y 值。
    if ('glassesOffsetY' in data) {
      if (!Number.isFinite(data.glassesOffsetY) || data.glassesOffsetY < config.glasses.position.min || data.glassesOffsetY > config.glasses.position.max) throw new Error('眼镜上下位置超出允许范围');
      settings.glassesOffsetY = data.glassesOffsetY;
    }
    layout();
    save();
    notifyView();
    return payload();
  });
  register('desktop-pet:import', async function () {
    const selection = await dialog.showOpenDialog(win, { title: '导入桌宠皮肤', filters: [{ name: '桌宠皮肤包', extensions: ['zip'] }], properties: ['openFile'] });
    if (selection.canceled) return { cancelled: true };
    await library.importZip(selection.filePaths[0]);
    return payload();
  });
  win.setMinimumSize(1, 1);
  layout();
  /** 显示器热插拔或缩放变化时，分别按角色和输入窗自身位置保持可见。 */
  function displayChanged() {
    layout();
    if (dialogue) dialogue.setBounds(dialogueBounds());
    notifyView();
    save();
  }
  screen.on('display-removed', displayChanged);
  screen.on('display-metrics-changed', displayChanged);
  const pageId = win.webContents.id;
  win.on('closed', function () {
    if (dialogue) dialogue.destroy();
    endpoints.delete(pageId);
    screen.removeListener('display-removed', displayChanged);
    screen.removeListener('display-metrics-changed', displayChanged);
  });
  return { save, setExpanded, payload, send,
    ownsDialogue: function (target) { return dialogue === target; },
    isExpanded: function () { return expanded; }
  };
}
module.exports = { attach };
