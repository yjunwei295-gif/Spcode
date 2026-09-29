const fs = require('fs');
const path = require('path');
const hardware = require('./hardware');

const META_SUFFIX = '.sc-meta.json';

const PURPOSE_NAME = {
  code: '写代码',
  chat: '对话写作',
  image: '看图',
  video: '看视频',
  imageGen: '生图',
  videoGen: '生视频',
  sfxGen: '生音效',
  musicGen: '生音乐',
  docGen: '生文档'
};

function metaPathFor(filePath) {
  return `${filePath}${META_SUFFIX}`;
}

function inferRecipe(fileName, purposes = []) {
  const name = path.basename(String(fileName || '')).toLowerCase();
  if (/qwen[-_.]?image/i.test(name)) return 'qwen-image';
  if (/z[-_.]?image/i.test(name)) return 'z-image';
  if (/flux/i.test(name)) return 'flux';
  if (/stable-diffusion|sdxl|sd1|sd2|sd[-_]/i.test(name)) return 'sd';
  if (/wan.*t2v|wan.*i2v|wan2/i.test(name)) return 'wan-video';
  if (/musicgen|music[-_]?gen/i.test(name)) return 'musicgen';
  if (purposes.includes('imageGen')) return 'single';
  return '';
}

function inferFromCatalog(repo) {
  if (!repo) return null;
  const repoKey = String(repo).toLowerCase();
  const hit = hardware.CATALOG.find((c) => String(c.repo || '').toLowerCase() === repoKey);
  if (!hit) return null;
  return {
    purpose: hit.purposes[0] || '',
    purposes: hit.purposes || [],
    catalogId: hit.id || '',
    recipe: inferRecipe('', hit.purposes || [])
  };
}

function inferFromFilename(fileName) {
  const name = path.basename(String(fileName || '')).toLowerCase();
  const purposes = [];
  let purpose = '';

  if (/qwen[-_.]?image|z[-_.]?image|flux|stable-diffusion|sdxl|sd1|sd2|sd[-_]/i.test(name)) {
    purposes.push('imageGen');
    purpose = 'imageGen';
  } else if (/wan.*t2v|wan.*i2v|wan2/i.test(name)) {
    purposes.push('videoGen');
    purpose = 'videoGen';
  } else if (/musicgen|music[-_]?gen|music_generation/i.test(name)) {
    purposes.push('musicGen', 'sfxGen');
    purpose = 'musicGen';
  } else if (/mmproj/i.test(name)) {
    purposes.push('image', 'video');
    purpose = 'image';
  } else if (/vl|vision|llava|minicpm[-_]?v/i.test(name)) {
    purposes.push('image', 'video');
    purpose = 'image';
  } else if (/coder|code/i.test(name)) {
    purposes.push('code');
    purpose = 'code';
  } else if (/instruct|chat|qwen2\.5(?!.*vl)|llama|gemma|mistral|deepseek/i.test(name)) {
    purposes.push('chat', 'docGen');
    purpose = 'chat';
  }

  return {
    purpose,
    purposes: [...new Set(purposes)],
    recipe: inferRecipe(name, purposes)
  };
}

function uniqPurposes(...lists) {
  const out = [];
  for (const list of lists) {
    for (const p of list || []) {
      if (p && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

function buildMeta(filePath, input = {}) {
  const fileName = path.basename(filePath);
  const fromCatalog = inferFromCatalog(input.repo) || {};
  const fromName = inferFromFilename(fileName);
  const purposes = uniqPurposes(input.purposes, fromCatalog.purposes, fromName.purposes, input.purpose, fromCatalog.purpose, fromName.purpose);
  const purpose = input.purpose || fromCatalog.purpose || fromName.purpose || purposes[0] || '';
  const recipe = input.recipe || fromCatalog.recipe || fromName.recipe || inferRecipe(fileName, purposes);
  return {
    version: 1,
    fileName,
    purpose,
    purposes,
    recipe,
    repo: input.repo || '',
    quant: input.quant || '',
    catalogId: input.catalogId || fromCatalog.catalogId || '',
    url: input.url || '',
    source: input.source || 'download-ui',
    downloadedAt: input.downloadedAt || new Date().toISOString()
  };
}

function writeMeta(_modelsDir, filePath, input = {}) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const meta = buildMeta(filePath, input);
  fs.writeFileSync(metaPathFor(filePath), JSON.stringify(meta, null, 2), 'utf8');
  return meta;
}

function readMeta(filePath) {
  const p = metaPathFor(filePath);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function resolveMeta(modelsDir, filePath, opts = {}) {
  const saved = readMeta(filePath);
  if (saved) return { ...saved, inferred: false };
  const built = buildMeta(filePath, { source: 'inferred' });
  if (opts.writeBack && built.purpose) writeMeta(modelsDir, filePath, built);
  return { ...built, inferred: true };
}

function enrichFile(modelsDir, file, opts = {}) {
  const meta = resolveMeta(modelsDir, file.path, opts);
  return {
    ...file,
    meta,
    purpose: meta.purpose || '',
    purposes: meta.purposes || [],
    recipe: meta.recipe || '',
    purposeLabel: PURPOSE_NAME[meta.purpose] || meta.purpose || ''
  };
}

function purposeText(purpose) {
  return PURPOSE_NAME[purpose] || purpose || '';
}

module.exports = {
  writeMeta,
  readMeta,
  resolveMeta,
  enrichFile,
  inferRecipe,
  inferFromFilename,
  inferFromCatalog,
  purposeText,
  META_SUFFIX
};
