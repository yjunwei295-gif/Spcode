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
  listMemory: () => ipcRenderer.invoke('memory:list'),
  addMemory: (payload) => ipcRenderer.invoke('memory:add', payload),
  deleteMemory: (id) => ipcRenderer.invoke('memory:delete', id),
  clearMemory: (payload) => ipcRenderer.invoke('memory:clear', payload || {}),
  pinMemory: (id, pinned) => ipcRenderer.invoke('memory:pin', { id, pinned }),
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
  contextPreview: (turnId) => ipcRenderer.invoke('chat:contextPreview', turnId),
  zbaingCorrect: (payload) => ipcRenderer.invoke('zbaingAi:correct', payload),
  zbaingRetry: (payload) => ipcRenderer.invoke('zbaingAi:retry', payload),
  listZbaingModules: () => ipcRenderer.invoke('zbaingAi:listModules'),
  onChatEvent: (cb) => {
    const fn = (_e, data) => cb(data);
    ipcRenderer.on('chat:event', fn);
    return () => ipcRenderer.removeListener('chat:event', fn);
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
