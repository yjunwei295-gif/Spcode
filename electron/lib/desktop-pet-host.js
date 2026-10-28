// 在现有小窗上切换桌宠与聊天形态，不创建第二个应用或 BrowserWindow。
'use strict';
const fs = require('fs');
const path = require('path');
const { app, ipcMain, screen, dialog } = require('electron');
const config = require('./desktop-pet-config.json');
const { createLibrary } = require('./desktop-pet-skins');
/** IPC 按实际发送页查找实例，不接受页面自行指定其他窗口编号。 */
const endpoints = new Map();
ipcMain.handle('desktop-pet:invoke', function (event, data) {
  const methods = endpoints.get(event.sender.id);
  if (!methods || !methods.has(data.method)) throw new Error('桌宠接口或实例不存在');
  return methods.get(data.method)(data.payload);
});

/** 把同一窗口的尺寸变化固定在角色脚底，并管理皮肤选择和指针穿透。 */
function attach(win, slotNo, initialBounds) {
  const file = path.join(app.getPath('userData'), 'desktop-pets', 'slot-' + slotNo + '.json');
  const library = createLibrary(app.getPath('userData'));
  let settings = { skin: config.defaultSkin, scale: config.defaultScale, speed: 1, reducedMotion: false, footX: initialBounds.x + initialBounds.width - config.layout.petWidth * config.defaultScale / 2, footY: initialBounds.y + initialBounds.height };
  if (fs.existsSync(file)) settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  let expanded = false;
  let dragging = null;
  let ignoring = false;
  let placement = null;
  const methods = new Map();
  endpoints.set(win.webContents.id, methods);
  /** 同一窗口的方法只登记在它的专属表内。 */
  function register(channel, fn) { methods.set(channel, fn); }
  /** 获取当前形态的尺寸，所有可调尺寸来自配置文件。 */
  function size() {
    const petHeight = Math.round(config.layout.petHeight * settings.scale);
    return { width: expanded ? config.layout.panelWidth : Math.round(config.layout.petWidth * settings.scale), height: expanded ? config.layout.panelHeight + petHeight : petHeight };
  }
  /** 将整个角色拉回所在显示器工作区，展开时按可用空间放置。 */
  function layout() {
    const area = screen.getDisplayNearestPoint({ x: Math.round(settings.footX), y: Math.round(settings.footY) }).workArea;
    const pw = Math.round(config.layout.petWidth * settings.scale);
    const ph = Math.round(config.layout.petHeight * settings.scale);
    settings.footX = Math.max(area.x + pw / 2, Math.min(settings.footX, area.x + area.width - pw / 2));
    settings.footY = Math.max(area.y + ph, Math.min(settings.footY, area.y + area.height));
    const petX = Math.round(settings.footX - pw / 2);
    const petY = Math.round(settings.footY - ph);
    let x = petX, y = petY, width = pw, height = ph;
    placement = { petLeft: 0, petTop: 0, petWidth: pw, petHeight: ph, panelLeft: 0, panelTop: 0, panelWidth: 0, panelHeight: 0 };
    if (expanded) {
      const panelWidth = Math.min(config.layout.panelWidth, area.width);
      const above = petY - area.y;
      const below = area.y + area.height - settings.footY;
      const upwards = above >= config.layout.panelHeight || above >= below;
      const panelHeight = Math.min(config.layout.panelHeight, upwards ? above : below);
      const panelX = Math.round(Math.max(area.x, Math.min(settings.footX - panelWidth / 2, area.x + area.width - panelWidth)));
      const panelY = Math.round(upwards ? petY - panelHeight : settings.footY);
      x = Math.min(petX, panelX); y = Math.min(petY, panelY);
      width = Math.max(petX + pw, panelX + panelWidth) - x;
      height = Math.max(petY + ph, panelY + panelHeight) - y;
      placement = { petLeft: petX - x, petTop: petY - y, petWidth: pw, petHeight: ph, panelLeft: panelX - x, panelTop: panelY - y, panelWidth, panelHeight };
    }
    win.setBounds({ x, y, width, height });
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
  function payload() { return { config, settings, expanded, placement, skins: library.list() }; }
  /** 通知页面形态变化，使用 showInactive 保持原软件键盘焦点。 */
  function setExpanded(on) {
    const next = on === true;
    if (next === expanded) return;
    expanded = next;
    setIgnoring(false);
    layout();
    win.webContents.send('desktop-pet:view', { expanded, settings, placement });
    save();
  }
  /** 只有命中实际画面才拦截鼠标，透明区域将事件交给下面的软件。 */
  function setIgnoring(on) {
    if (on === ignoring) return;
    ignoring = on;
    win.setIgnoreMouseEvents(on, { forward: true });
  }
  /** 形态与资源加载后页面主动请求，避免 did-finish-load 首帧竞态。 */
  register('desktop-pet:init', payload);
  register('desktop-pet:expand', function (data) { setExpanded(data === true); return expanded; });
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
    layout();
    save();
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
  /** 显示器热插拔或缩放变化时保持角色可见，并重新计算面板方向。 */
  function displayChanged() {
    layout();
    win.webContents.send('desktop-pet:view', { expanded, settings, placement });
    save();
  }
  screen.on('display-removed', displayChanged);
  screen.on('display-metrics-changed', displayChanged);
  const pageId = win.webContents.id;
  win.on('closed', function () {
    endpoints.delete(pageId);
    screen.removeListener('display-removed', displayChanged);
    screen.removeListener('display-metrics-changed', displayChanged);
  });
  return { save, setExpanded, payload, isExpanded: function () { return expanded; } };
}
module.exports = { attach };
