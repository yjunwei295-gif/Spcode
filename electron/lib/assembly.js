const path = require('path');
const store = require('./store');
const localLlm = require('./local-llm');
const modelMeta = require('./model-meta');

const ROLES = [
  { id: 'vision', name: '看图', hint: '主模型看不到图时，先用这个模型识别画面' },
  { id: 'summary', name: '总结', hint: '长文先压缩。实现改完文件后，用它核对代码和需求是否一致、功能是否已经落地' },
  { id: 'code', name: '代码', hint: '写代码、改 bug 时先出一版草案再交给主模型' },
  { id: 'planning', name: '规划', hint: '大脑先理解需求，再把理解交给这里拆步骤' },
  { id: 'imageGen', name: '生图', hint: '画图、出插画时用挂上的本地 GGUF 或接口模型直接出图' },
  { id: 'videoGen', name: '生视频', hint: '做短片时用挂上的接口直接出视频' },
  { id: 'model3d', name: '生3D', hint: '做三维模型时用挂上的接口直接出 3D 文件' },
  { id: 'docGen', name: '生文档', hint: '写说明、手册时先成文再保存到工作目录' }
];

const GEN_ROLE_IDS = ['imageGen', 'videoGen', 'model3d', 'docGen'];
const TEXT_HELPER_IDS = ['summary', 'code', 'planning'];

function assemblyKey(s) {
  const m = (s.models || []).find((x) => x.id === s.currentModelId);
  if (!m || m.type === 'local' || m.id === 'local-gguf') {
    const name = path.basename(String(m?.modelPath || m?.model || ''));
    return name ? `local:${name}` : 'local';
  }
  return `api:${m.id}`;
}

function slotsOf(s, key) {
  const pack = (s.assemblies || {})[key || assemblyKey(s)];
  return Array.isArray(pack?.slots) ? pack.slots : [];
}

function slotFilled(slot) {
  if (!slot || typeof slot !== 'object') return false;
  if (slot.type === 'zbaingModule' && slot.moduleId) return true;
  return !!(slot.apiId || slot.model || slot.modelPath || (slot.type === 'api' && slot.baseUrl));
}

function normalizeCapRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const ref = {
    apiId: String(raw.apiId || '').trim(),
    type: raw.type === 'api' ? 'api' : (raw.apiId ? 'api' : 'local'),
    model: String(raw.model || '').trim(),
    modelPath: String(raw.modelPath || '').trim(),
    mmproj: String(raw.mmproj || '').trim(),
    endpoint: String(raw.endpoint || '').trim(),
    name: String(raw.name || '').trim(),
    baseUrl: String(raw.baseUrl || '').trim(),
    apiKey: String(raw.apiKey || ''),
    protocol: String(raw.protocol || 'openai')
  };
  if (!slotFilled(ref)) return null;
  return ref;
}

function normalizeCapabilityDefaults(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const role of ROLES.map((r) => r.id)) {
    const pack = src[role] && typeof src[role] === 'object' ? src[role] : {};
    const primary = normalizeCapRef(pack.primary);
    const fallbacks = Array.isArray(pack.fallbacks)
      ? pack.fallbacks.map(normalizeCapRef).filter(Boolean)
      : [];
    out[role] = { primary, fallbacks };
  }
  return out;
}

function refToSlot(ref, role) {
  if (!ref) return null;
  return {
    id: `cap-${role}`,
    role,
    apiId: ref.apiId || '',
    type: ref.apiId || ref.type === 'api' ? 'api' : 'local',
    model: ref.model || '',
    modelPath: ref.modelPath || '',
    mmproj: ref.mmproj || '',
    endpoint: ref.endpoint || '',
    name: ref.name || '',
    baseUrl: ref.baseUrl || '',
    apiKey: ref.apiKey || '',
    protocol: ref.protocol || 'openai'
  };
}

function localImageGenSlots(s) {
  const dir = s.modelsDir || store.defaultModelsDir();
  return localLlm.listGguf(dir)
    .map((f) => modelMeta.enrichFile(dir, f, { writeBack: false }))
    .filter((f) => (f.purposes || []).includes('imageGen') || !!f.recipe)
    .map((f) => ({
      slot: {
        id: `auto-${f.name}`,
        role: 'imageGen',
        type: 'local',
        model: f.name
      },
      source: 'local-auto'
    }));
}

/**
 * 解析某能力要用的槽位候选：组合 → 本地自动发现（生图）→ 全局 primary → fallbacks → 旧视觉字段
 * @returns {{ slot: object, source: string }[]}
 */
function roleCandidates(s, role) {
  const out = [];
  const combo = slotByRole(s, role);
  if (combo) out.push({ slot: combo, source: 'assembly' });

  if (role === 'imageGen') {
    const seen = new Set(out.map((c) => c.slot?.model).filter(Boolean));
    for (const auto of localImageGenSlots(s)) {
      if (seen.has(auto.slot.model)) continue;
      out.push(auto);
      seen.add(auto.slot.model);
    }
  }

  const localImageOnly = role === 'imageGen' && out.some((c) => isLocalGenSlot(c.slot));
  const caps = normalizeCapabilityDefaults(s.capabilityDefaults || {});
  const pack = caps[role] || { primary: null, fallbacks: [] };
  if (!localImageOnly && pack.primary) {
    const slot = refToSlot(pack.primary, role);
    if (slotFilled(slot)) out.push({ slot, source: 'capability' });
  }
  if (!localImageOnly) {
    for (const fb of pack.fallbacks || []) {
      const slot = refToSlot(fb, role);
      if (slotFilled(slot)) out.push({ slot, source: 'fallback' });
    }
  }

  if (role === 'vision' && !out.length && s.visionAgentModel) {
    out.push({
      slot: {
        id: 'legacy-vision',
        role: 'vision',
        type: 'local',
        model: s.visionAgentModel,
        mmproj: s.visionAgentMmproj || '',
        endpoint: s.visionAgentEndpoint || ''
      },
      source: 'legacy'
    });
  }
  return out;
}

/** 取第一个可用候选 */
function resolveRole(s, role) {
  return roleCandidates(s, role)[0] || null;
}

function isLocalGenSlot(slot) {
  if (!slot || typeof slot !== 'object') return false;
  if (slot.type === 'zbaingModule') return false;
  if (slot.apiId || slot.type === 'api') return false;
  return !!(slot.model || slot.modelPath);
}

function collectGenSlots(s, role) {
  const hits = [];
  for (const pack of Object.values(s.assemblies || {})) {
    for (const slot of pack.slots || []) {
      if (slot.role === role && slotFilled(slot)) hits.push(slot);
    }
  }
  return hits;
}

function slotByRole(s, role) {
  if (role === 'imageGen') {
    const all = collectGenSlots(s, role);
    const local = all.find(isLocalGenSlot);
    if (local) return local;
  }
  const cur = slotsOf(s).find((x) => x.role === role && slotFilled(x));
  if (cur) return cur;
  if (!GEN_ROLE_IDS.includes(role)) return null;
  const all = collectGenSlots(s, role);
  return all[0] || null;
}

function looksLikeModelNotProjector(file, modelName) {
  const leaf = path.basename(String(file || ''));
  if (!leaf) return false;
  if (/mmproj/i.test(leaf) || /\.mmproj$/i.test(leaf)) return false;
  const modelLeaf = path.basename(String(modelName || ''));
  return leaf.toLowerCase() === modelLeaf.toLowerCase() || (/\.gguf$/i.test(leaf) && !/mmproj/i.test(leaf));
}

function scrubBadMmproj(s) {
  const wipe = (model, mm) => (looksLikeModelNotProjector(mm, model) ? '' : mm);
  s.visionAgentMmproj = wipe(s.visionAgentModel, s.visionAgentMmproj);
  for (const pack of Object.values(s.assemblies || {})) {
    for (const slot of pack.slots || []) {
      if (slot.role === 'vision') slot.mmproj = wipe(slot.model, slot.mmproj);
    }
  }
}

/** 把旧的三个视觉字段迁进当前主模型的组合，只迁一次 */
function migrateAssemblies(s) {
  if (!s.assemblies || typeof s.assemblies !== 'object') s.assemblies = {};
  scrubBadMmproj(s);
  const hasVision = Object.values(s.assemblies).some((a) =>
    (a?.slots || []).some((x) => x.role === 'vision' && (x.model || x.apiId))
  );
  if (hasVision || !s.visionAgentModel) return s;
  const key = assemblyKey(s);
  if (!s.assemblies[key]) s.assemblies[key] = { slots: [] };
  if (!s.assemblies[key].slots.some((x) => x.role === 'vision')) {
    s.assemblies[key].slots.push({
      id: 'slot-vision-migrated',
      role: 'vision',
      type: 'local',
      model: s.visionAgentModel,
      mmproj: s.visionAgentMmproj || '',
      endpoint: s.visionAgentEndpoint || ''
    });
  }
  return s;
}

function visionFrom(s) {
  const hit = resolveRole(s, 'vision');
  if (hit?.slot) {
    const slot = hit.slot;
    // API 看图槽：用已保存模型名；本地仍用 gguf 文件名
    let model = slot.model || '';
    if (slot.apiId && !model) {
      const m = (s.models || []).find((x) => x.id === slot.apiId);
      model = m?.model || m?.name || '';
    }
    // 从槽位解析出端点（API 看图槽需要鉴权）、密钥与协议
    let endpoint = slot.endpoint || '';
    let apiKey = '';
    let protocol = 'openai';
    try {
      const cfg = slotToModelCfg(slot, s);
      if (!endpoint && (cfg?.baseUrl || cfg?.endpoint)) endpoint = cfg.baseUrl || cfg.endpoint;
      if (cfg?.apiKey) apiKey = cfg.apiKey;
      if (cfg?.protocol) protocol = cfg.protocol;
    } catch { /* ignore */ }
    if (slot.apiKey) apiKey = slot.apiKey;
    return {
      model,
      mmproj: slot.mmproj || '',
      endpoint,
      apiKey,
      protocol,
      source: hit.source
    };
  }
  return {
    model: s.visionAgentModel || '',
    mmproj: s.visionAgentMmproj || '',
    endpoint: s.visionAgentEndpoint || '',
    source: s.visionAgentModel ? 'legacy' : ''
  };
}

function syncVisionFields(s, slots) {
  const vision = (slots || []).find((x) => x.role === 'vision');
  if (!vision) return;
  s.visionAgentModel = vision.model || '';
  s.visionAgentMmproj = vision.mmproj || '';
  s.visionAgentEndpoint = vision.endpoint || '';
}

function slotToModelCfg(slot, s) {
  if (!slot) return null;
  if (slot.type === 'zbaingModule' && slot.moduleId) {
    const zb = (s.models || []).find((m) => m.type === 'zbaingAi' || m.id === 'zbaingAi');
    return {
      type: 'zbaingModule',
      moduleId: slot.moduleId,
      name: slot.name || slot.moduleId,
      zbaingRoot: zb?.zbaingRoot || ''
    };
  }
  const ggufName = String(slot.model || slot.modelPath || '');
  if (/\.gguf$/i.test(ggufName)) {
    return {
      type: 'local',
      name: slot.model || path.basename(slot.modelPath || ''),
      model: slot.model || path.basename(slot.modelPath || ''),
      modelPath: slot.modelPath || ''
    };
  }
  if (slot.apiId) {
    const m = (s.models || []).find((x) => x.id === slot.apiId);
    if (m) return require('./store').resolveModelCfg(m, s);
  }
  if (slot.type === 'api' && slot.baseUrl) {
    return {
      type: 'api',
      name: slot.name || slot.model,
      baseUrl: slot.baseUrl,
      apiKey: slot.apiKey || '',
      model: slot.model,
      protocol: slot.protocol || 'openai'
    };
  }
  return {
    type: 'local',
    name: slot.model || '本地辅助模型',
    model: slot.model || '',
    modelPath: slot.modelPath || ''
  };
}

function detectRoles(userText, { hasImages, contextChars }) {
  const t = String(userText || '');
  const roles = [];
  if (hasImages) roles.push('vision');
  if (/生成视频|生视频|做个视频|做一段视频|text to video|generate (a |an )?video|视频生成/i.test(t)) {
    roles.push('videoGen');
  }
  if (/生成\s*3D|3D\s*模型|三维模型|生3D|generate (a |an )?3d|text to 3d/i.test(t)) {
    roles.push('model3d');
  }
  if (/生成文档|写一份文档|写文档|生文档|生成一份(说明|文档|手册)|write (a |an )?document/i.test(t)) {
    roles.push('docGen');
  }
  // 在画布上用鼠标、画笔、PS 画，不是文生图。这种话交给对话模型自己去点。
  const handsOnDraw = /画布|画笔|鼠标|手绘|photoshop|\bps\b|ps里|不要调用模型|别调用模型|不要生图|别生图|使用鼠标/i.test(t);
  if (
    !handsOnDraw
    && /生图|生(?:一|几|两|[0-9]+)?张?(?:图片|图|插画|海报|壁纸)|画(?:一|几|两|[0-9]+)?张?(?:图片|图|插画|海报|壁纸)|画个(?:图|插画|海报|壁纸)?|帮我画|给我(?:生|画|出)|随便.*(?:生|画|出).*(?:图|插画|海报|壁纸)|出(?:一|几)?张?(?:图片|图|插画|海报|壁纸)|来(?:一|几)?张?(?:图片|图|插画|海报|壁纸)|生成(?:一|几|两|[0-9]+)?张?(?:图片|图|插画|海报|壁纸)|text to image|generate (an |a )?image/i.test(t)
    && !roles.includes('videoGen')
    && !roles.includes('model3d')
  ) {
    roles.push('imageGen');
  }
  if (/总结|摘要|概括|精简|summar/i.test(t) || (contextChars || 0) > 8000) roles.push('summary');
  if (/写代码|改代码|重构|实现|修 bug|修bug|函数|组件|补全/i.test(t)) roles.push('code');
  if (/规划|计划|拆解|分步|方案|怎么做/i.test(t)) roles.push('planning');
  return roles;
}

function helperPrompt(role, lang) {
  const replyLang = require('./reply-lang');
  const langLine = replyLang.helperLangLine(lang || replyLang.fromLocale('zh'));
  if (role === 'summary') {
    return `You are a summarization helper. Compress the user's material into key points. Keep paths, API names, and numbers. Do not call tools. Do not invent facts. ${langLine}`;
  }
  if (role === 'code') {
    return `You are a coding helper. Give a concrete patch or draft and which files to touch. Do not call tools. ${langLine}`;
  }
  if (role === 'planning') {
    return `You are the planning module. You do not receive the user directly. Plan only from the brain's brief: steps, order, and risks. Do not call tools. ${langLine}`;
  }
  if (role === 'docGen') {
    return `You write a complete markdown document from the user's request. Output markdown only, no chatter. Start with a title. Do not call tools. ${langLine}`;
  }
  return `Answer briefly. Do not call tools. ${langLine}`;
}

module.exports = {
  ROLES, GEN_ROLE_IDS, TEXT_HELPER_IDS, assemblyKey, slotsOf, slotByRole, migrateAssemblies,
  visionFrom, syncVisionFields, slotToModelCfg, detectRoles, helperPrompt,
  normalizeCapabilityDefaults, normalizeCapRef, roleCandidates, resolveRole, slotFilled, refToSlot
};
