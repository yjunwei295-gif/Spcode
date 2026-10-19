const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getState: () => ipcRenderer.invoke('app:state'),
  setTheme: (theme) => ipcRenderer.invoke('app:theme', theme),
  setLocale: (locale) => ipcRenderer.invoke('app:locale', locale),
  setAutoSave: (v) => ipcRenderer.invoke('app:autoSave', v),
  saveSearchSites: (sites) => ipcRenderer.invoke('app:searchSites', sites),
  saveProxy: (proxy) => ipcRenderer.invoke('app:proxy', proxy),
  saveCommandSandbox: (cfg) => ipcRenderer.invoke('app:commandSandbox', cfg),
  saveMaxAgentRounds: (n) => ipcRenderer.invoke('app:maxAgentRounds', n),
  setDesktopAlive: (on) => ipcRenderer.invoke('desktop:setAlive', !!on),
  setCursorDirect: (on) => ipcRenderer.invoke('app:cursorDirect', !!on),
  planWrite: (payload) => ipcRenderer.invoke('plan:write', payload),
  planTree: (payload) => ipcRenderer.invoke('plan:tree', payload),
  // 删除方案条目：转发到主进程 plan:remove
  planRemoveItem: (payload) => ipcRenderer.invoke('plan:remove', payload),
  dialogIndex: (payload) => ipcRenderer.invoke('dialog:index', payload),
  newWindow: () => ipcRenderer.invoke('window:new'),
  focusWindow: () => ipcRenderer.invoke('window:focus'),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  maximize: () => ipcRenderer.invoke('window:maximize'),
  close: () => ipcRenderer.invoke('window:close'),

  openProject: () => ipcRenderer.invoke('workspace:open'),
  setWorkspace: (dir) => ipcRenderer.invoke('workspace:set', dir),
  listFiles: (query, extraFolders) => ipcRenderer.invoke('workspace:files', { query, extraFolders }),
  listChildren: (rel, root, absolute) => ipcRenderer.invoke('workspace:children', { rel, root, absolute }),
  readWorkspaceFile: (rel) => ipcRenderer.invoke('workspace:read', rel),
  showInFolder: (rel) => ipcRenderer.invoke('shell:showInFolder', rel),
  filePreview: (abs) => ipcRenderer.invoke('file:preview', abs),
  cloneRepo: (payload) => ipcRenderer.invoke('git:clone', payload),
  sshConnect: (profile) => ipcRenderer.invoke('ssh:connect', profile),

  saveModels: (models, currentModelId, providers) => ipcRenderer.invoke('models:save', { models, currentModelId, providers }),
  listProviderPresets: () => ipcRenderer.invoke('providers:presets'),
  saveVisionAgent: (payload) => ipcRenderer.invoke('models:saveVision', payload),
  saveAssembly: (payload) => ipcRenderer.invoke('models:saveAssembly', payload),
  saveCapabilityDefaults: (payload) => ipcRenderer.invoke('models:saveCapabilityDefaults', payload),
  startVisionAgent: () => ipcRenderer.invoke('models:visionStart'),
  findMmproj: (modelName) => ipcRenderer.invoke('models:findMmproj', modelName),
  visionAgentStatus: () => ipcRenderer.invoke('models:visionStatus'),
  testModel: (model) => ipcRenderer.invoke('models:test', model),
  listRemoteModels: (model) => ipcRenderer.invoke('models:listRemote', model),
  fetchAccountBalance: (model) => ipcRenderer.invoke('models:accountBalance', model),
  listLocalModels: () => ipcRenderer.invoke('models:listLocal'),
  pickModelsDir: () => ipcRenderer.invoke('models:pickDir'),
  openModelsDir: () => ipcRenderer.invoke('models:openDir'),

  listSkills: () => ipcRenderer.invoke('skills:list'),
  saveSkill: (payload) => ipcRenderer.invoke('skills:save', payload),
  deleteSkill: (payload) => ipcRenderer.invoke('skills:delete', payload),
  reorderSkills: (order) => ipcRenderer.invoke('skills:reorder', order),
  setSkillsEnabled: (keys) => ipcRenderer.invoke('skills:setEnabled', keys),
  listRules: () => ipcRenderer.invoke('rules:list'),
  saveRule: (payload) => ipcRenderer.invoke('rules:save', payload),
  deleteRule: (payload) => ipcRenderer.invoke('rules:delete', payload),
  loadPersona: () => ipcRenderer.invoke('persona:load'),
  savePersona: (body) => ipcRenderer.invoke('persona:save', body),
  getGlobalMemory: () => ipcRenderer.invoke('globalMemory:get'),
  saveGlobalProfile: (profile) => ipcRenderer.invoke('globalMemory:saveProfile', profile),
  addGlobalPref: (payload) => ipcRenderer.invoke('globalMemory:addPref', payload),
  deleteGlobalPref: (id) => ipcRenderer.invoke('globalMemory:deletePref', id),
  pinGlobalPref: (id, pinned) => ipcRenderer.invoke('globalMemory:pinPref', { id, pinned }),
  chatAnswer: (answer, turnId) => ipcRenderer.invoke('chat:answer', { answer, turnId }),
  listMilestones: () => ipcRenderer.invoke('milestone:list'),
  createMilestone: (payload) => ipcRenderer.invoke('milestone:create', payload),
  renameMilestone: (id, name) => ipcRenderer.invoke('milestone:rename', { id, name }),
  deleteMilestone: (id) => ipcRenderer.invoke('milestone:delete', id),
  matchMilestones: (paths) => ipcRenderer.invoke('milestone:match', paths),
  listSnapshots: () => ipcRenderer.invoke('snapshot:list'),
  getSnapshotMax: () => ipcRenderer.invoke('snapshot:getMax'),
  setSnapshotMax: (max) => ipcRenderer.invoke('snapshot:setMax', max),
  restoreSnapshot: (id) => ipcRenderer.invoke('snapshot:restore', id),
  undoSnapshot: (id) => ipcRenderer.invoke('snapshot:undo', id),
  redoSnapshot: (id) => ipcRenderer.invoke('snapshot:redo', id),
  listHunks: (payload) => ipcRenderer.invoke('snapshot:hunks', payload),
  rejectHunk: (payload) => ipcRenderer.invoke('snapshot:rejectHunk', payload),

  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  clipboardPasteSync: () => ipcRenderer.sendSync('clipboard:paste-sync'),
  getClipboardHistory: () => ipcRenderer.invoke('clipboard:get'),
  clearClipboardHistory: () => ipcRenderer.invoke('clipboard:clear'),
  onClipboardUpdate: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('clipboard:update', fn);
    return () => ipcRenderer.removeListener('clipboard:update', fn);
  },
  savePasteFile: (payload) => ipcRenderer.invoke('paste:save', payload),
  loadSessions: () => ipcRenderer.invoke('sessions:list'),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  saveSession: (session) => ipcRenderer.invoke('sessions:save', session),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', { id, title }),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),

  chatSend: (payload) => ipcRenderer.invoke('chat:send', payload),
  chatAbort: (turnId) => ipcRenderer.invoke('chat:abort', turnId),
  // 主窗运行中把这条消息插话给当前轮，下一个 round 边界生效
  chatInterject: (payload) => ipcRenderer.invoke('chat:interject', payload),
  contextPreview: (turnId) => ipcRenderer.invoke('chat:contextPreview', turnId),
  zbaingCorrect: (payload) => ipcRenderer.invoke('zbaingAi:correct', payload),
  zbaingRetry: (payload) => ipcRenderer.invoke('zbaingAi:retry', payload),
  listZbaingModules: () => ipcRenderer.invoke('zbaingAi:listModules'),
  onChatEvent: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('chat:event', fn);
    return () => ipcRenderer.removeListener('chat:event', fn);
  },
  // 常驻悬浮栏空闲时发来的消息，交给渲染层复用现有的发送流程
  onFloatUserMessage: (cb) => {
    const fn = (_e, text) => cb(text);
    ipcRenderer.on('chat:float-user-message', fn);
    return () => ipcRenderer.removeListener('chat:float-user-message', fn);
  },
  // 把当前标签页注册到悬浮窗：tabId 用于回传，title 用于小窗标题
  // 主窗上报当前标签；active=true 表示主窗真的开工（发了消息），此时小窗才把绑定切过来
  floatBind: (tabId, title, active) => ipcRenderer.send('floatbar:bind-from-window', { tabId, title, active: active === true }),
  // 上报当前标签页是否可被浮窗接管（key 留空，主进程按 senderWindow 补全真实 key）
  // options 是这段复述里拆出来的开工方案：[{ value: 'a', label: 'A 开始' }]，没方案就是空数组。
  // 判定只有 renderer/app.js 一份，这里只做透传，不在 preload 里再判一次。
  floatCanStart: (canStart, options) => ipcRenderer.send('floatbar:can-start', {
    key: '',
    canStart: !!canStart,
    options: Array.isArray(options) ? options : []
  }),
  // 用户在小窗里点了「切回该标签」：主进程推来目标 tabId，交给渲染层切换标签
  onFloatActivate: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('floatbar:activate-tab', fn);
    return () => ipcRenderer.removeListener('floatbar:activate-tab', fn);
  },
  // 用户在小窗里点了「开始」：主进程通知渲染层真正启动这一轮对话。
  // payload.value 是用户点的那颗方案按钮的字母（空串表示「点默认那颗开始」，旧行为），
  // 多选「一起开工」时是勾中的 value 字符串数组（长度 = 勾选数量）。
  // 原样透传给回调：数组保持数组、字符串保持字符串，禁止 String()/join()，
  // 否则数组会被压成 "[object Object]" 或 "a,b"；只有 undefined/null 才兜底成空串。
  // payload.note 是「开工选项」下面那栏补充说明，作为回调第二参数传出，没填就是空串
  onFloatStart: (cb) => {
    const fn = (_e, payload) => cb(payload && payload.value != null ? payload.value : '', payload && payload.note != null ? payload.note : '');
    ipcRenderer.on('floatbar:do-start', fn);
    return () => ipcRenderer.removeListener('floatbar:do-start', fn);
  },
  // 小窗开关：主窗切换常驻悬浮栏显示/隐藏，返回切换后的可见状态
  floatBarToggle: () => ipcRenderer.invoke('floatbar:toggle'),
  // 主窗查询常驻悬浮栏当前是否可见
  floatBarVisible: () => ipcRenderer.invoke('floatbar:visible'),
  // 小窗右下角自制抓柄请求改尺寸：payload = { w, h }（目标宽高，DIP），
  // 主进程按发起方小窗实例落到 float-bar 的 resizeBy，返回 { ok:true, w, h } 或 { ok:false, error }。
  // 主窗与小窗共用这一个 preload，两条分支都能拿到这一条
  floatBarResize: (payload) => ipcRenderer.invoke('floatbar:resize', payload),
  // 主进程下发悬浮栏可见状态变化，主窗据此同步按钮态
  onFloatBarVisibility: (cb) => {
    const fn = (_e, visible) => cb(visible);
    ipcRenderer.on('floatbar:visibility', fn);
    return () => ipcRenderer.removeListener('floatbar:visibility', fn);
  },
  onWorkspaceChanged: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('workspace:changed', fn);
    return () => ipcRenderer.removeListener('workspace:changed', fn);
  },
  onUiRefresh: (cb) => {
    const fn = () => cb();
    ipcRenderer.on('ui:refresh', fn);
    return () => ipcRenderer.removeListener('ui:refresh', fn);
  },

  reportError: (message, detail) => ipcRenderer.send('log:client', { message, detail }),
  logSummaryTrace: (metadata) => ipcRenderer.send('log:summary-trace', metadata),

  detectHardware: () => ipcRenderer.invoke('hw:detect'),
  modelAdvice: (purpose, opts) => ipcRenderer.invoke('hw:advice', purpose, opts || {}),
  downloadSource: (opts) => ipcRenderer.invoke('download:source', opts),
  searchRepos: (query, opts) => ipcRenderer.invoke('download:search', query, opts || {}),
  listRepoFiles: (repo, opts) => ipcRenderer.invoke('download:repoFiles', repo, opts || {}),
  resolveDownload: (payload) => ipcRenderer.invoke('download:resolve', payload),
  startDownload: (payload) => ipcRenderer.invoke('download:start', payload),
  cancelDownload: (id) => ipcRenderer.invoke('download:cancel', id),
  onDownloadProgress: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('download:progress', fn);
    return () => ipcRenderer.removeListener('download:progress', fn);
  },
  onVisionStatus: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('vision:status', fn);
    return () => ipcRenderer.removeListener('vision:status', fn);
  },

  indexStatus: () => ipcRenderer.invoke('index:status'),
  indexSync: (extraFolders, opts) => ipcRenderer.invoke('index:sync', extraFolders, opts),
  indexGetMap: () => ipcRenderer.invoke('index:getMap'),
  indexSourceItem: (request) => ipcRenderer.invoke('index:sourceItem', request),
  indexGetExcludes: () => ipcRenderer.invoke('index:getExcludes'),
  indexSetExcludes: (ids) => ipcRenderer.invoke('index:setExcludes', ids),
  indexGetInclude: () => ipcRenderer.invoke('index:getInclude'),
  indexSetInclude: (obj) => ipcRenderer.invoke('index:setInclude', obj),
  indexSummarize: () => ipcRenderer.invoke('index:summarize'),
  indexSummarizeOne: (id) => ipcRenderer.invoke('index:summarizeOne', id),
  indexDelete: () => ipcRenderer.invoke('index:delete'),
  onIndexProgress: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('index:progress', fn);
    return () => ipcRenderer.removeListener('index:progress', fn);
  }
};

contextBridge.exposeInMainWorld('simple', api);
contextBridge.exposeInMainWorld('sinpo', api);

// 常驻置顶悬浮对话栏专用桥：只给 float-bar.html 用，页面里不出现 ipcRenderer
contextBridge.exposeInMainWorld('floatBar', {
  // 小窗点「开始」：key 标明是哪个会话，value 是用户选的方案字母（不传/空串 = 原来的无参调用，点默认那颗），
  // 多选「一起开工」时 value 是勾中的 value 数组（长度 = 勾选数量）。
  // value 原样透传，只去掉会破坏数组类型的转换：数组保持数组、字符串保持字符串，
  // 禁止 String()/join()/拼串；只有 undefined/null 才兜底成空串。通道名与字段名一律不变
  // 第三位 note 是「开工选项」下面那栏补充说明的文字，原样透传、可为空（没填就是空串）
  // key 与 sessionKey 两个键名都带上、值相同：主进程侧按 key 取，新约定的载荷用 sessionKey，不会歧义
  start: (key, value, note) => ipcRenderer.send('floatbar:start', {
    key: String(key == null ? '' : key),
    sessionKey: String(key == null ? '' : key),
    value: value == null ? '' : value,
    note: note == null ? '' : String(note)
  }),
  // 小窗与某个标签页重新建立绑定（key 由主进程下发）
  bind: (key) => ipcRenderer.send('floatbar:bind', { key }),
  // 小窗发消息：带 key 标明消息属于哪个标签页的对话
  // 第三个参数 attachments 是附件清单（图片粘贴后落盘得到的 { path, name } 等），不传就是纯文本消息，
  // 通道名与前面两个字段保持不变，只把附件组原样带上，老的两参调用照旧能用
  send: (key, text, attachments) => ipcRenderer.send('floatbar:send', {
    key,
    text: String(text == null ? '' : text),
    attachments: Array.isArray(attachments) ? attachments : []
  }),
  // 小窗粘贴图片落盘：把页面里读到的 base64 图交给主进程写进临时目录，拿到真实文件路径后
  // 再随 send 的第三参作为附件发出去。
  // 参数：name=建议文件名（可空，主进程会按 mime 补扩展名）；mime=图片类型，如 'image/png'；
  //       base64=纯 base64 串（不含 data:xxx;base64, 前缀）。
  // 返回：Promise<{ path, name }>，path 是落盘后的绝对路径，name 是最终文件名；
  //       主进程返回结构异常时统一收敛成 { path: '', name: '' }，调用方按空 path 判失败即可。
  savePaste: async (name, mime, base64) => {
    const res = await ipcRenderer.invoke('paste:save', {
      name: name == null ? '' : String(name),
      mime: mime == null ? '' : String(mime),
      base64: base64 == null ? '' : String(base64)
    });
    // 主进程就是 writePasteBuffer 的 { path, name }，这里再兜一层，保证调用方拿到的形状固定
    return {
      path: res && res.path ? String(res.path) : '',
      name: res && res.name ? String(res.name) : ''
    };
  },
  // 小窗回答提问：key 定位窗口（哪个标签页），turnId 定位该窗口里具体哪一轮在等回答
  // （一个窗口多个标签页同时等回答时，只带 key 会串到别的轮次，必须带 turnId）
  answer: (key, turnId, value) => ipcRenderer.send('floatbar:answer', { key, turnId, value }),
  // 小窗中止当前轮：key 定位窗口（哪个标签页），turnId 定位该窗口里具体哪一轮在等
  // turnId 可为空字符串，为空表示停该窗口当前在等的轮次
  abort: (key, turnId) => ipcRenderer.send('floatbar:abort', { key, turnId }),
  hide: () => ipcRenderer.send('floatbar:hide'),
  // 小窗最小化/还原：on=true 压成紧凑窗，on=false 还原
  compact: (on) => ipcRenderer.send('floatbar:compact', on === true),
  // 小窗右下角自制抓柄改尺寸：payload = { w, h } 是渲染端按拖动位移换算好的目标宽高，
  // 主进程按 event.sender 找到本实例后调 resizeBy，原样回 { ok:true, w, h } 或 { ok:false, error }
  floatBarResize: (payload) => ipcRenderer.invoke('floatbar:resize', payload),
  onEvent: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('floatbar:event', fn);
    return () => ipcRenderer.removeListener('floatbar:event', fn);
  },
  onAsk: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('floatbar:ask', fn);
    return () => ipcRenderer.removeListener('floatbar:ask', fn);
  },
  // 小窗的「开始状态」通道：本会话此刻能不能新起一轮，以及开始按钮有哪些方案可选。
  // 主进程用现有 floatbar:event 通道以 kind: 'start-ready' 广播，这里只挑这一类事件原样透传
  // { sessionKey, canStart, options } 给浮栏页面，不在 preload 里改判定
  onStartReady: (cb) => {
    const fn = (_e, data) => {
      if (!data || typeof data !== 'object') return;
      // 兼容两种到达方式：带 kind 的通用事件，或直接就是一份开始状态载荷
      if (data.kind !== 'start-ready' && data.canStart === undefined) return;
      cb({
        sessionKey: data.sessionKey == null ? '' : String(data.sessionKey),
        canStart: data.canStart === true,
        options: Array.isArray(data.options) ? data.options : []
      });
    };
    ipcRenderer.on('floatbar:event', fn);
    return () => ipcRenderer.removeListener('floatbar:event', fn);
  }
});
