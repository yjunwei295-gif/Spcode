const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const retrieve = require('./memory-retrieve');

function globalDir() {
  return path.join(app.getPath('userData'), 'memory');
}

function globalPath() {
  return path.join(globalDir(), 'global.json');
}

function vectorsPath() {
  return path.join(globalDir(), 'vectors.json');
}

function blocklistPath() {
  return path.join(globalDir(), 'deleted-blocklist.json');
}

const BLOCKLIST_MAX = 200;

function loadBlocklist() {
  const p = blocklistPath();
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(data?.items) ? data.items : [];
  } catch {
    return [];
  }
}

function similarSummary(a, b) {
  const x = String(a || '').replace(/\s+/g, '').toLowerCase();
  const y = String(b || '').replace(/\s+/g, '').toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.includes(y) || y.includes(x)) return true;
  return false;
}

function pushBlocklist(entry) {
  if (!entry) return;
  const items = loadBlocklist();
  items.push({
    summary: String(entry.summary || '').slice(0, 400),
    deletedAt: nowIso(),
    id: String(entry.id || '')
  });
  fs.mkdirSync(globalDir(), { recursive: true });
  fs.writeFileSync(blocklistPath(), JSON.stringify({ version: 1, items: items.slice(-BLOCKLIST_MAX) }, null, 2), 'utf8');
}

function isPrefBlocked(summary) {
  const s = String(summary || '').trim();
  if (!s) return false;
  return loadBlocklist().some((x) => similarSummary(x.summary, s));
}

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `g-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function emptyProfile() {
  return {
    tone: '',
    language: '',
    confirmBeforeEdit: null,
    avoid: [],
    skillLevel: '',
    notes: []
  };
}

function emptyStore() {
  return {
    version: 1,
    profile: emptyProfile(),
    prefs: [],
    updatedAt: nowIso()
  };
}

function normalizePref(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const summary = String(raw.summary || '').trim();
  if (!summary) return null;
  return {
    id: String(raw.id || newId()),
    summary: summary.slice(0, 400),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String).filter(Boolean) : [],
    paths: Array.isArray(raw.paths) ? raw.paths.map(String).filter(Boolean) : [],
    pinned: !!raw.pinned,
    source: raw.source === 'user' ? 'user' : 'auto',
    createdAt: String(raw.createdAt || nowIso()),
    updatedAt: String(raw.updatedAt || nowIso())
  };
}

function load() {
  const p = globalPath();
  if (!fs.existsSync(p)) return emptyStore();
  try {
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      version: 1,
      profile: { ...emptyProfile(), ...(data.profile || {}) },
      prefs: Array.isArray(data.prefs) ? data.prefs.map(normalizePref).filter(Boolean) : [],
      updatedAt: data.updatedAt || nowIso()
    };
  } catch {
    return emptyStore();
  }
}

function save(store) {
  fs.mkdirSync(globalDir(), { recursive: true });
  const out = {
    version: 1,
    profile: { ...emptyProfile(), ...(store.profile || {}) },
    prefs: (store.prefs || []).map(normalizePref).filter(Boolean),
    updatedAt: nowIso()
  };
  fs.writeFileSync(globalPath(), JSON.stringify(out, null, 2), 'utf8');
  return out;
}

function listPrefs() {
  return load().prefs;
}

function getProfile() {
  return load().profile;
}

function saveProfile(profile) {
  const store = load();
  store.profile = { ...emptyProfile(), ...(profile || {}) };
  return save(store).profile;
}

function mergeProfilePatch(patch) {
  const store = load();
  const p = store.profile || emptyProfile();
  if (!patch || typeof patch !== 'object') return p;
  if (patch.tone) p.tone = String(patch.tone).slice(0, 120);
  if (patch.language) p.language = String(patch.language).slice(0, 40);
  if (typeof patch.confirmBeforeEdit === 'boolean') p.confirmBeforeEdit = patch.confirmBeforeEdit;
  if (patch.skillLevel) p.skillLevel = String(patch.skillLevel).slice(0, 40);
  if (Array.isArray(patch.avoid)) {
    p.avoid = [...new Set([...(p.avoid || []), ...patch.avoid.map(String)].filter(Boolean))].slice(0, 20);
  }
  if (Array.isArray(patch.notes)) {
    p.notes = [...new Set([...(p.notes || []), ...patch.notes.map(String)].filter(Boolean))].slice(0, 30);
  }
  if (typeof patch.note === 'string' && patch.note.trim()) {
    p.notes = [...new Set([...(p.notes || []), patch.note.trim()])].slice(0, 30);
  }
  store.profile = p;
  save(store);
  return p;
}

async function addPref({ summary, tags, paths, pinned, source } = {}) {
  const store = load();
  const pref = normalizePref({
    summary,
    tags,
    paths,
    pinned: pinned !== false,
    source: source || 'user',
    id: newId(),
    createdAt: nowIso(),
    updatedAt: nowIso()
  });
  if (!pref) throw new Error('请填写偏好内容');
  if (source === 'auto' && isPrefBlocked(pref.summary)) return null;
  const hit = store.prefs.find((x) => x.summary === pref.summary);
  if (hit) {
    hit.updatedAt = nowIso();
    hit.pinned = hit.pinned || pref.pinned;
    hit.tags = [...new Set([...hit.tags, ...pref.tags])];
    await retrieve.upsertVector(vectorsPath(), hit.id, retrieve.docText(hit));
    save(store);
    return hit;
  }
  store.prefs.push(pref);
  save(store);
  await retrieve.upsertVector(vectorsPath(), pref.id, retrieve.docText(pref));
  return pref;
}

function removePref(id) {
  const store = load();
  const target = store.prefs.find((x) => x.id === id);
  if (target) pushBlocklist(target);
  store.prefs = store.prefs.filter((x) => x.id !== id);
  save(store);
  retrieve.removeVector(vectorsPath(), id);
  return true;
}

function setPrefPinned(id, pinned) {
  const store = load();
  const e = store.prefs.find((x) => x.id === id);
  if (!e) throw new Error('偏好不存在');
  e.pinned = !!pinned;
  e.updatedAt = nowIso();
  save(store);
  return e;
}

function formatProfile(profile, { english = false } = {}) {
  const p = profile || emptyProfile();
  const lines = [];
  if (english) {
    if (p.tone) lines.push(`Tone: ${p.tone}`);
    if (p.language) lines.push(`Preferred language: ${p.language}`);
    if (p.confirmBeforeEdit === true) lines.push('Confirm before editing code.');
    if (p.confirmBeforeEdit === false) lines.push('May edit without extra confirm.');
    if (p.skillLevel) lines.push(`Skill level: ${p.skillLevel}`);
    if (p.avoid?.length) lines.push(`Avoid: ${p.avoid.join('; ')}`);
    if (p.notes?.length) lines.push(`Notes: ${p.notes.slice(0, 8).join('; ')}`);
    if (!lines.length) return '';
    return `## User profile\n${lines.join('\n')}`;
  }
  if (p.tone) lines.push(`语气：${p.tone}`);
  if (p.language) lines.push(`偏好语言：${p.language}`);
  if (p.confirmBeforeEdit === true) lines.push('改代码前需先确认。');
  if (p.confirmBeforeEdit === false) lines.push('可不额外确认直接改代码。');
  if (p.skillLevel) lines.push(`技术水平：${p.skillLevel}`);
  if (p.avoid?.length) lines.push(`避免：${p.avoid.join('；')}`);
  if (p.notes?.length) lines.push(`备注：${p.notes.slice(0, 8).join('；')}`);
  if (!lines.length) return '';
  return `## 用户画像\n${lines.join('\n')}`;
}

function formatPrefs(prefs, { english = false } = {}) {
  if (!prefs?.length) return '';
  const lines = prefs.map((e, i) => `${i + 1}. ${e.pinned ? (english ? '[pinned] ' : '[钉] ') : ''}${e.summary}`);
  return english
    ? `## Global preferences\n${lines.join('\n')}`
    : `## 全局偏好\n${lines.join('\n')}`;
}

async function recallPrefs(query, paths) {
  const store = load();
  const pinned = store.prefs.filter((p) => p.pinned);
  const rest = await retrieve.hybridRecall(store.prefs, {
    query,
    paths,
    limit: retrieve.TOP_OUT,
    vectorsPath: vectorsPath()
  });
  const seen = new Set();
  const out = [];
  for (const e of [...pinned, ...rest]) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

function profileExtractPrompt(userText, assistantText) {
  return `从对话中提取可写入「用户画像」的稳定偏好。只输出 JSON 对象，无则 {}。
字段可选：tone, language, confirmBeforeEdit(boolean), skillLevel, avoid(string[]), note(string)。
不要编造。

用户：
${String(userText || '').slice(0, 3000)}

助手：
${String(assistantText || '').slice(0, 2000)}`;
}

function parseProfilePatch(text) {
  const s = String(text || '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const obj = JSON.parse(s.slice(start, end + 1));
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

module.exports = {
  load,
  save,
  listPrefs,
  getProfile,
  saveProfile,
  mergeProfilePatch,
  addPref,
  removePref,
  setPrefPinned,
  formatProfile,
  formatPrefs,
  recallPrefs,
  profileExtractPrompt,
  parseProfilePatch,
  vectorsPath,
  globalPath,
  emptyProfile
};
