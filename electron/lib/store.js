const { app, nativeTheme } = require('electron');
const fs = require('fs');
const path = require('path');
const wallet = require('./wallet');
const mxapi = require('./mxapi');

const LOCAL_SLOT = {
  id: 'local-gguf',
  name: '本地模型',
  type: 'local',
  model: '',
  modelPath: '',
  vision: false,
  enabled: true
};

const ZBAING_SLOT = {
  id: 'zbaingAi',
  name: 'zbaingAi（在·本地脑）',
  type: 'zbaingAi',
  zbaingRoot: '',
  enabled: true
};

const DEFAULTS = {
  theme: 'system',
  locale: 'zh',
  autoSave: true,
  // 内部采集仅用于源码开发版，发布版默认设置中不提供这两个字段。
  ...(!app.isPackaged ? { trainingDataEnabled: false, trainingDataDir: 'D:\\Shuju' } : {}),
  currentModelId: 'local-gguf',
  visionAgentModel: '',
  visionAgentMmproj: '',
  visionAgentEndpoint: '',
  assemblies: {},
  /** 全局能力默认：组合未挂时使用；组合优先覆盖。每项 { primary, fallbacks[] }，值为槽位形引用 */
  capabilityDefaults: {},
  modelsDir: '',
  /** 本地生图显式参数；空对象沿用模型配方，设置面板与单次工具可覆盖。 */
  localImageGeneration: {},
  proxy: '',
  commandSandbox: { enabled: true, timeoutSec: 60 },
  maxAgentRounds: 16,
  desktopAlive: false,
  // Cursor 模型走直通会话；关掉才回到原来的规划 / 部下流程
  cursorDirect: true,
  providers: [],
  models: [
    { ...LOCAL_SLOT }
  ],
  recents: [],
  sshProfiles: [],
  skillOrder: [],
  enabledSkills: [],
  searchSites: []
};

const PROVIDER_PRESETS = [
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1' },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'openai', baseUrl: 'https://api.deepseek.com' },
  { id: 'anthropic', name: 'Anthropic', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com' },
  { id: 'gemini', name: 'Google Gemini', protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' },
  { id: 'bai', name: 'B.AI', protocol: 'openai', baseUrl: 'https://api.b.ai/v1' },
  // SuperAPI 中转站：一个 Key 走 OpenAI 兼容的 /v1/chat/completions，模型目录在同一地址的 /models
  { id: 'superapi', name: 'SuperAPI', protocol: 'openai', baseUrl: 'https://superapi.store/v1' },
  // MXAPI 聚合平台的 OpenAI 兼容入口：生图走 /v1/images/generations，模型名填 nano-banana / nano-banana-pro / gpt-image-2 等
  { id: 'mxapi', name: 'MXAPI 生图', protocol: 'openai', baseUrl: 'https://open.mxapi.org/v1' },
  // MXAPI 原生 Nano 异步端点：提交只收 prompt，先拿到 task_id，再轮询 /task 取图
  { id: 'mxapi-nano', name: 'MXAPI Nano 异步生图', protocol: 'openai', baseUrl: 'https://open.mxapi.org/api/v2/nano' },
  // 原生视频由模型名分派到 video/generate 或 veo/generate，并查询各自任务接口。
  { id: 'mxapi-video', name: 'MXAPI 原生视频（Seedance / Veo）', protocol: 'openai', baseUrl: 'https://open.mxapi.org/api/v2' },
  // Cursor 走 SDK，不需要真实地址；Key 可空，空时测试连接会打开浏览器登录 Cursor
  { id: 'cursor', name: 'Cursor', protocol: 'cursor', baseUrl: 'cursor://sdk' },
  // Codex SDK 复用本机 Codex CLI 登录；也可在 API Key 中填写 OpenAI API Key
  { id: 'codex', name: 'Codex', protocol: 'codex', baseUrl: 'codex://sdk' },
  // Claude Code SDK：Key 空时复用本机 Claude Code 登录；地址可改成兼容接口（如 DeepSeek 的 Anthropic 接口）绕开地区限制
  { id: 'claudecode', name: 'Claude Code', protocol: 'claudecode', baseUrl: 'claudecode://sdk' },
  // Grok CLI 走本机 grok agent stdio（ACP）；Key 可空，空时复用 grok login / XAI_API_KEY
  { id: 'grok', name: 'Grok', protocol: 'grok', baseUrl: 'grok://cli' }
];

function filePath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function bundledModelsDir() {
  if (app.isPackaged) return path.join(process.resourcesPath, 'models');
  return path.join(__dirname, '..', '..', 'models');
}

function defaultModelsDir() {
  // 打包后默认写到 userData，避免安装目录只读
  if (app.isPackaged) return path.join(app.getPath('userData'), 'models');
  return bundledModelsDir();
}

const MIN_AGENT_ROUNDS = 1;
const MAX_AGENT_ROUNDS = 64;

/** 原子写用的临时文件后缀：先写临时文件再改名，读盘方永远看不到半截内容 */
const SAVE_TMP_SUFFIX = '.tmp';

function clampAgentRounds(n) {
  if (n == null || n === '') return DEFAULTS.maxAgentRounds;
  const v = Math.round(Number(n));
  if (!Number.isFinite(v)) return DEFAULTS.maxAgentRounds;
  return Math.max(MIN_AGENT_ROUNDS, Math.min(MAX_AGENT_ROUNDS, v));
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
}

const { normalizeProtocol } = require('./provider-protocol');

function isOllamaEntry(m) {
  if (!m) return false;
  if (m.id === 'ollama-local') return true;
  const url = String(m.baseUrl || '');
  return /11434/.test(url);
}

function normalizeProvider(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const baseUrl = String(raw.baseUrl || '').trim();
  if (!baseUrl) return null;
  const out = {
    id: String(raw.id || newId('prov')),
    name: String(raw.name || 'API').trim() || 'API',
    protocol: normalizeProtocol(raw.protocol, raw.baseUrl),
    baseUrl,
    apiKey: String(raw.apiKey || ''),
    timeout: Math.max(5, Number(raw.timeout) || 120),
    maxRetries: Math.max(0, Number(raw.maxRetries) || 3),
    retryInterval: Math.max(0, Number(raw.retryInterval) || 5)
  };
  const w = wallet.normalizeWallet(raw.wallet);
  if (w) out.wallet = w;
  return out;
}

function defaultZbaingRoot() {
  const guess = path.join('D:', 'Ai', 'zai', 'zbaingAi');
  return fs.existsSync(path.join(guess, 'serve.py')) ? guess : guess;
}

function looksLikeZbaingRoot(dir) {
  if (!dir) return false;
  return fs.existsSync(path.join(dir, 'serve.py')) && fs.existsSync(path.join(dir, 'brain'));
}

function ensureLocalSlot(models) {
  const kept = (models || []).filter((m) => !isOllamaEntry(m));
  if (!kept.some((m) => m.id === 'local-gguf' || m.type === 'local')) {
    kept.unshift({ ...LOCAL_SLOT });
  }
  const local = kept.find((m) => m.id === 'local-gguf') || kept.find((m) => m.type === 'local');
  if (local) {
    local.id = 'local-gguf';
    local.name = local.name || '本地模型';
    local.type = 'local';
    local.enabled = local.enabled !== false;
    delete local.baseUrl;
    delete local.apiKey;
    delete local.protocol;
    delete local.providerId;
    if (!local.model) {
      const prefer = path.join(bundledModelsDir(), 'qwen2.5-7b.gguf');
      if (fs.existsSync(prefer)) {
        local.model = 'qwen2.5-7b.gguf';
        local.modelPath = prefer;
      }
    }
  }
  return kept;
}

const ZABING_GGUF = path.join('D:', 'Ai', 'zabingAI', 'models', 'qwen2.5-coder-7b-instruct-q4_k_m.gguf');
const NEW_ZABING_ROOT = path.join('D:', 'Ai', 'NewZabingAi');

function ensureNewZabingSlot(models) {
  const kept = models || [];
  let row = kept.find((m) => m?.id === 'NewZabingAi' || m?.type === 'NewZabingAi');
  if (!row) {
    row = { id: 'NewZabingAi' };
    kept.push(row);
  }
  row.id = 'NewZabingAi';
  row.type = 'NewZabingAi';
  row.name = 'NewZabingAi';
  row.model = '欲望嘴';
  row.enabled = row.enabled !== false;
  row.newZabingRoot = row.newZabingRoot || NEW_ZABING_ROOT;
  delete row.providerId;
  delete row.baseUrl;
  delete row.apiKey;
  delete row.protocol;
  delete row.modelPath;
  delete row.vision;
  return kept;
}

function ensureZabingAISlot(models) {
  const kept = models || [];
  let row = kept.find((m) => m?.id === 'zabingAI' || m?.type === 'zabingAI');
  if (!row) {
    row = { id: 'zabingAI' };
    kept.push(row);
  }
  row.id = 'zabingAI';
  row.type = 'zabingAI';
  row.name = 'zabingAI';
  row.enabled = row.enabled !== false;
  row.model = row.model || 'qwen2.5-coder-7b-instruct-q4_k_m.gguf';
  row.modelPath = row.modelPath || ZABING_GGUF;
  row.vision = false;
  delete row.providerId;
  delete row.baseUrl;
  delete row.apiKey;
  delete row.protocol;
  return kept;
}

function ensureZbaingSlot(models) {
  const kept = models || [];
  const zb = kept.find((m) => m?.id === 'zbaingAi' || m?.type === 'zbaingAi');
  // 没有配过就不补。默认清单里不带 zbaingAi。
  if (!zb) return kept;
  zb.id = 'zbaingAi';
  zb.type = 'zbaingAi';
  zb.name = zb.name || ZBAING_SLOT.name;
  zb.enabled = zb.enabled !== false;
  if (!zb.zbaingRoot) zb.zbaingRoot = defaultZbaingRoot();
  delete zb.providerId;
  delete zb.model;
  delete zb.baseUrl;
  delete zb.apiKey;
  delete zb.protocol;
  delete zb.modelPath;
  delete zb.vision;
  return kept;
}

/**
 * 旧扁平 API 条目 → providers + models（带 providerId）
 */
function migrateProvidersAndModels(data) {
  let providers = Array.isArray(data.providers)
    ? data.providers.map(normalizeProvider).filter(Boolean)
    : [];
  let models = ensureLocalSlot(data.models && data.models.length ? data.models : DEFAULTS.models);
  models = ensureZbaingSlot(models);
  models = ensureZabingAISlot(models);
  models = ensureNewZabingSlot(models);

  for (const m of models) {
    if (!m || m.type === 'local' || m.id === 'local-gguf') continue;
    if (m.type === 'zbaingAi' || m.id === 'zbaingAi') continue;
    if (m.type === 'zabingAI' || m.id === 'zabingAI') continue;
    if (m.type === 'NewZabingAi' || m.id === 'NewZabingAi') continue;
    m.type = 'api';
    m.enabled = m.enabled !== false;
    if (m.vision == null) m.vision = false;

    if (m.providerId) {
      const ok = providers.some((p) => p.id === m.providerId);
      if (ok) {
        delete m.baseUrl;
        delete m.apiKey;
        delete m.protocol;
        if (!m.model && m.name) m.model = m.name;
        if (!m.name) m.name = m.model || m.id;
        continue;
      }
    }

    if (m.baseUrl) {
      const protocol = normalizeProtocol(m.protocol, m.baseUrl);
      const key = `${protocol}|${String(m.baseUrl).replace(/\/$/, '')}|${m.apiKey || ''}`;
      let prov = providers.find((p) =>
        `${p.protocol}|${String(p.baseUrl).replace(/\/$/, '')}|${p.apiKey || ''}` === key
      );
      if (!prov) {
        prov = normalizeProvider({
          id: newId('prov'),
          name: m.name && m.name !== m.model ? m.name : (m.name || 'API'),
          protocol,
          baseUrl: m.baseUrl,
          apiKey: m.apiKey || ''
        });
        if (prov) providers.push(prov);
      }
      if (prov) {
        m.providerId = prov.id;
        if (!m.model) m.model = m.name || 'model';
        if (!m.name || m.name === prov.name) m.name = m.model;
      }
      delete m.baseUrl;
      delete m.apiKey;
      delete m.protocol;
    }
  }

  models = models.filter((m) => {
    if (!m) return false;
    if (m.type === 'local' || m.id === 'local-gguf') return true;
    if (m.type === 'zbaingAi' || m.id === 'zbaingAi') return true;
    if (m.type === 'zabingAI' || m.id === 'zabingAI') return true;
    if (m.type === 'NewZabingAi' || m.id === 'NewZabingAi') return true;
    return !!(m.providerId && m.model);
  });

  return { providers, models };
}

/** @deprecated 兼容旧调用名 */
function migrateModels(models) {
  return migrateProvidersAndModels({ models, providers: [] }).models;
}

/**
 * 把模型条目展开成 agent / api-protocol 可用的 modelCfg
 */
function resolveModelCfg(modelOrId, settings) {
  const s = settings || load();
  const models = s.models || [];
  const providers = s.providers || [];
  let m = typeof modelOrId === 'string'
    ? models.find((x) => x.id === modelOrId)
    : modelOrId;
  // 视频槽可以直接引用已添加的 MXAPI 厂商；每次调用都重新取当前厂商的密钥。
  if (typeof modelOrId === 'string' && modelOrId.startsWith(mxapi.MODEL_ID_PREFIX)) {
    m = mxapi.resolveModel(modelOrId, providers);
  }
  if (!m) return null;
  if (m.type === 'zbaingAi' || m.id === 'zbaingAi') {
    return {
      id: 'zbaingAi',
      name: m.name || 'zbaingAi',
      type: 'zbaingAi',
      zbaingRoot: m.zbaingRoot || '',
      enabled: m.enabled !== false
    };
  }
  if (m.id === 'NewZabingAi' || m.type === 'NewZabingAi') {
    return {
      id: 'NewZabingAi',
      name: 'NewZabingAi',
      type: 'NewZabingAi',
      newZabingRoot: m.newZabingRoot || NEW_ZABING_ROOT,
      enabled: m.enabled !== false
    };
  }
  if (m.id === 'zabingAI' || m.type === 'zabingAI') {
    return {
      id: 'zabingAI',
      name: 'zabingAI',
      type: 'local',
      model: m.model || 'qwen2.5-coder-7b-instruct-q4_k_m.gguf',
      modelPath: m.modelPath || ZABING_GGUF,
      vision: false,
      enabled: m.enabled !== false
    };
  }
  if (m.type === 'local' || m.id === 'local-gguf' || m.modelPath || /\.gguf$/i.test(m.model || '')) {
    return {
      id: m.id,
      name: m.name || '本地模型',
      type: 'local',
      model: m.model || '',
      modelPath: m.modelPath || '',
      vision: !!m.vision
    };
  }
  if (m.baseUrl && m.model) {
    return {
      id: m.id,
      name: m.name,
      type: 'api',
      model: m.model,
      baseUrl: m.baseUrl,
      apiKey: m.apiKey || '',
      protocol: normalizeProtocol(m.protocol, m.baseUrl),
      // 推理强度属于模型，不能从厂商公共配置读取。
      reasoningEffort: m.reasoningEffort,
      vision: !!m.vision
    };
  }
  const p = providers.find((x) => x.id === m.providerId);
  if (!p) {
    return {
      id: m.id,
      name: m.name,
      type: 'api',
      model: m.model || '',
      baseUrl: '',
      apiKey: '',
      protocol: 'openai',
      vision: !!m.vision,
      providerId: m.providerId || ''
    };
  }
  return {
    id: m.id,
    name: m.name || m.model,
    type: 'api',
    model: m.model,
    baseUrl: p.baseUrl,
    apiKey: p.apiKey || '',
    protocol: normalizeProtocol(p.protocol, p.baseUrl),
    // 辅助模型与大脑都通过此入口取得用户为该模型保存的档位。
    reasoningEffort: m.reasoningEffort,
    vision: !!m.vision,
    providerId: p.id,
    providerName: p.name,
    timeout: p.timeout,
    maxRetries: p.maxRetries,
    retryInterval: p.retryInterval,
    pricing: m.pricing || null
  };
}

function findProvider(id, settings) {
  const s = settings || load();
  return (s.providers || []).find((p) => p.id === id) || null;
}

function findProviderForCfg(modelCfg, settings) {
  const s = settings || load();
  if (modelCfg?.providerId) {
    const hit = (s.providers || []).find((p) => p.id === modelCfg.providerId);
    if (hit) return hit;
  }
  const url = String(modelCfg?.baseUrl || '').replace(/\/+$/, '');
  const key = String(modelCfg?.apiKey || '');
  if (!url) return null;
  return (s.providers || []).find((p) => String(p.baseUrl || '').replace(/\/+$/, '') === url
    && String(p.apiKey || '') === key)
    || (s.providers || []).find((p) => String(p.baseUrl || '').replace(/\/+$/, '') === url)
    || null;
}

function notifyWallet(snap) {
  try {
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('chat:event', { type: 'wallet', ...snap });
    }
  } catch { /* 非窗口环境忽略 */ }
}

function notifyUsage(detail) {
  try {
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send('chat:event', { type: 'usage', ...detail });
    }
  } catch { /* 非窗口环境忽略 */ }
}

/** 按本轮 token / 实扣从手动余额里扣费；没有钱包时仍把用量推到界面 */
function applyUsageSpend({ modelCfg, usage, messages }) {
  const parsed = wallet.interpretBilled(wallet.parseTokenUsage(usage) || usage, modelCfg);
  const inn = Number(parsed?.input) || 0;
  const out = Number(parsed?.output) || 0;
  if (messages && inn > 0) {
    try { require('./context-preview').note(messages, inn, modelCfg?.model); } catch { /* 预览没记上不影响计费 */ }
  }
  if (!parsed || (inn <= 0 && out <= 0 && parsed.credits == null && parsed.usd == null && parsed.costRaw == null)) {
    return null;
  }
  const usdEst = wallet.estimateUsd({ ...modelCfg, baseUrl: modelCfg?.baseUrl }, parsed);
  const creditsEst = wallet.costInUnit(usdEst, 'CREDITS');
  const bai = wallet.isBaiHost(modelCfg?.baseUrl);
  notifyUsage({
    input: inn,
    output: out,
    usd: parsed.usd > 0 ? parsed.usd : usdEst,
    credits: parsed.credits > 0 ? parsed.credits : (bai ? creditsEst : null),
    billed: parsed.credits > 0 || parsed.usd > 0
  });
  const s = load();
  const p = findProviderForCfg(modelCfg, s);
  if (!p?.wallet || !(Number(p.wallet.remainingStart) > 0)) return null;
  p.wallet = wallet.normalizeWallet(p.wallet);
  if (!p.wallet) return null;
  const cfg = { ...modelCfg, baseUrl: modelCfg?.baseUrl || p.baseUrl };
  if (!(p.wallet.spent > 0) && (p.wallet.tokensIn > 0 || p.wallet.tokensOut > 0)) {
    p.wallet = wallet.recoverSpend(p.wallet, cfg) || p.wallet;
  }
  p.wallet.tokensIn += inn;
  p.wallet.tokensOut += out;
  const cost = wallet.spendAmount(parsed, cfg, p.wallet.unit);
  if (cost != null && cost > 0) p.wallet.spent += cost;
  save(s);
  const snap = wallet.snapshotFromWallet(p.wallet, p.id);
  if (snap) notifyWallet(snap);
  return snap;
}

function load() {
  try {
    const primary = readDiskSettings();
    const data = primary || readDiskSettings(filePath() + '.last-good');
    if (!data) throw new Error('Settings are unavailable');
    const merged = { ...DEFAULTS, ...data };
    const migrated = migrateProvidersAndModels(data);
    merged.providers = migrated.providers;
    merged.models = migrated.models;
    const legacy = path.join(app.getPath('userData'), 'models');
    const preferred = defaultModelsDir();
    if (!merged.modelsDir || (!app.isPackaged && merged.modelsDir === legacy) || looksLikeZbaingRoot(merged.modelsDir)) {
      merged.modelsDir = preferred;
    }
    if (!merged.models.some((m) => m.id === merged.currentModelId)) {
      const enabled = merged.models.find((m) => m.enabled !== false) || merged.models[0];
      merged.currentModelId = enabled?.id || 'local-gguf';
    }
    merged.locale = merged.locale === 'en' ? 'en' : 'zh';
    if (!Array.isArray(merged.searchSites)) merged.searchSites = [];
    if (typeof merged.proxy !== 'string') merged.proxy = '';
    if (!merged.commandSandbox || typeof merged.commandSandbox !== 'object') {
      merged.commandSandbox = { enabled: true, timeoutSec: 60 };
    } else {
      merged.commandSandbox = {
        enabled: merged.commandSandbox.enabled !== false,
        timeoutSec: Math.max(3, Number(merged.commandSandbox.timeoutSec) || 60)
      };
    }
    merged.maxAgentRounds = clampAgentRounds(merged.maxAgentRounds);
    merged.desktopAlive = merged.desktopAlive === true;
    merged.cursorDirect = merged.cursorDirect !== false;
    if (!merged.capabilityDefaults || typeof merged.capabilityDefaults !== 'object') {
      merged.capabilityDefaults = {};
    }
    const before = JSON.stringify(merged.assemblies || {});
    const out = require('./assembly').migrateAssemblies(merged);
    if (!primary || JSON.stringify(out.assemblies || {}) !== before
      || !Array.isArray(data.providers)
      || data.providers.some(p => p && normalizeProtocol(p.protocol, p.baseUrl) !== p.protocol)
      || (data.models || []).some((m) => m && m.baseUrl && m.type !== 'local')) {
      try { save(out); } catch { /* 迁移写入失败不影响本次运行 */ }
    }
    let repaired = false;
    for (const p of out.providers || []) {
      if (!p.wallet) continue;
      const beforeSpend = Number(p.wallet.spent) || 0;
      const current = (out.models || []).find((m) => m.id === out.currentModelId && m.providerId === p.id);
      const pm = current || (out.models || []).find((m) => m.providerId === p.id && m.type !== 'local');
      const recovered = wallet.recoverSpend(p.wallet, {
        baseUrl: p.baseUrl,
        model: pm?.model || '',
        pricing: pm?.pricing || null
      });
      if (recovered && Number(recovered.spent) > beforeSpend) {
        p.wallet = recovered;
        repaired = true;
      }
    }
    if (repaired) {
      try { save(out); } catch { /* 补算花费写入失败不影响运行 */ }
    }
    return out;
  } catch {
    const fresh = structuredClone(DEFAULTS);
    fresh.modelsDir = defaultModelsDir();
    return fresh;
  }
}

/** 是否为可直接按键合并的普通对象（数组、null、标量都不算） */
function isPlainSettingsObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * 读取盘上现有的 settings.json。
 * 保存前用它看一眼别的实例写了什么；文件不存在、被别的实例写到一半、
 * JSON 解析失败等任何异常都只表示「这次没有可合并的盘上内容」，
 * 一律返回 null，不抛错也不写日志。
 */
function readDiskSettings(file = filePath()) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isPlainSettingsObject(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 合并「盘上设置」与「内存设置」，返回要落盘的结果。
 * 规则：对象按键合并，数组以内存为准。
 * 理由：多个实例共享同一份 settings.json，盘上可能有别的实例刚写入、
 * 本实例内存里还没有的键（新加的供应商、技能、搜索站点等），
 * 不补回来就会被整片覆盖掉；而数组（供应商列表、模型列表、最近记录等）
 * 在设置页里是整份编辑的，用户删掉某项后内存里已经没有它，
 * 若按元素/下标合并会让删掉的项复活，所以数组一律整份保留内存的值。
 */
function mergeDiskWithMemory(disk, mem) {
  if (!isPlainSettingsObject(disk) || !isPlainSettingsObject(mem)) return mem;
  const out = {};
  // 先以内存为底：内存里有的键保持内存的值（内存是最新一次用户操作的结果）
  for (const key in mem) {
    if (!Object.prototype.hasOwnProperty.call(mem, key)) continue;
    out[key] = mem[key];
  }
  // 再逐键遍历盘上对象：内存没有的键补进结果，两边都是普通对象则递归合并
  for (const key in disk) {
    if (!Object.prototype.hasOwnProperty.call(disk, key)) continue;
    if (!Object.prototype.hasOwnProperty.call(mem, key)) {
      out[key] = disk[key];
      continue;
    }
    if (isPlainSettingsObject(disk[key]) && isPlainSettingsObject(mem[key])) {
      out[key] = mergeDiskWithMemory(disk[key], mem[key]);
      continue;
    }
    // 其余情况（含数组、标量、两边类型不一致）都以内存为准，out 里已是内存的值，不动
  }
  return out;
}

/** 先刷盘再原子替换。失败时保留旧设置文件。 */
function writeSettingsFile(file, text) {
  const tmp = file + '.' + process.pid + SAVE_TMP_SUFFIX;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flush: true, mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch { /* 没有临时文件可清理 */ }
    throw error;
  }
}

function save(data) {
  const file = filePath();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  // 先读盘合并再写：多实例共享同一份 settings.json，直接拿内存整份覆盖会把
  // 别的实例刚写入、本实例内存里没有的设置项抹掉。
  const disk = readDiskSettings(file) || readDiskSettings(file + '.last-good');
  const out = (disk && typeof disk === 'object') ? mergeDiskWithMemory(disk, data) : data;
  // 即使旧窗口再次提交错误协议，也在持久化边界修复直通占位地址。
  if (Array.isArray(out.providers)) out.providers = out.providers.map(p =>
    p && typeof p === 'object' ? { ...p, protocol: normalizeProtocol(p.protocol, p.baseUrl) } : p);
  const text = JSON.stringify(out, null, 2);
  writeSettingsFile(file, text);
  // 主设置损坏时仍有一份独立的完整配置。
  try { writeSettingsFile(file + '.last-good', text); } catch { /* 保留上一份备用配置 */ }
}

/** 解析保存的主题；独立主题原样返回，仅跟随系统时按系统明暗解析。 */
function resolveTheme(theme) {
  if (theme === 'light' || theme === 'dark' || theme === 'cel') return theme;
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

module.exports = {
  load,
  save,
  resolveTheme,
  DEFAULTS,
  clampAgentRounds,
  MIN_AGENT_ROUNDS,
  MAX_AGENT_ROUNDS,
  defaultModelsDir,
  migrateModels,
  migrateProvidersAndModels,
  normalizeProvider,
  normalizeProtocol,
  resolveModelCfg,
  findProvider,
  applyUsageSpend,
  PROVIDER_PRESETS,
  newId,
  LOCAL_SLOT,
  ZBAING_SLOT,
  ensureZbaingSlot,
  defaultZbaingRoot
};
