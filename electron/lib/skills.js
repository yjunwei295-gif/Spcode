const fs = require('fs');
const path = require('path');

// 解析 SKILL.md 开头的 YAML 头：取出 description，避免第一行是 --- 时列表描述空白
function parseSkillMeta(body) {
  const text = String(body || '');
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return {};
  const out = {};
  const lines = m[1].split(/\r?\n/);
  let key = '';
  let acc = [];
  const flush = () => {
    if (!key) return;
    out[key] = acc.join('\n').replace(/\s+/g, ' ').trim();
    key = '';
    acc = [];
  };
  for (const line of lines) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      flush();
      key = kv[1].toLowerCase();
      const rest = String(kv[2] || '').trim();
      if (rest === '>' || rest === '>-' || rest === '|' || rest === '|-') acc = [];
      else acc = [rest.replace(/^["']|["']$/g, '')];
    } else if (key) {
      acc.push(line.replace(/^\s+/, ''));
    }
  }
  flush();
  return out;
}

/**
 * 按本轮模式展开技能正文或目录简介中成对的普通模式专用标记。
 * @param {string} text 原始技能文字，区块可跨行或嵌在一句简介中。
 * @param {boolean} agi AGI 隐去区块，普通模式展示区块正文。
 * @param {boolean} keepLines 按源码行读取或查找时保留隐藏区块的换行，行号仍对应磁盘文件。
 * @returns {string} 供模型阅读的文字，技能编辑器和磁盘保留原文。
 */
function skillTextForMode(text, agi, keepLines = false) {
  function visibleBlock(block, body) {
    if (!agi) return body;
    return keepLines ? body.replace(/[^\r\n]/g, '') : '';
  }
  return String(text || '').replace(/<!--normal-only-->([\s\S]*?)<!--\/normal-only-->/g, visibleBlock);
}

/**
 * 从已展开的技能正文提取目录简介。
 * @param {string} body 当前模式可见的正文。优先使用 YAML 简介，其次使用首行标题。
 * @param {string} name 技能名，正文没有可用描述时作为目录名展示。
 * @returns {string} 供目录使用的单条描述。
 */
function describeSkill(body, name) {
  const meta = parseSkillMeta(body);
  const first = body.split(/\r?\n/).find(function descriptionLine(line) {
    const s = line.trim();
    return s && s !== '---' && !/^[A-Za-z_][\w-]*\s*:/.test(s) && s !== '>' && s !== '>-';
  }) || '';
  return (meta.description || meta.desc || '').trim() || first.replace(/^#\s*/, '').trim() || name;
}

// AGI 版本的文件名：与普通版 SKILL.md 放在同一技能目录，正文独立维护
const AGI_SKILL_FILE = 'SKILL.agi.md';

/**
 * 由普通版技能文件路径推导配对 AGI 版本文件路径。
 * @param {string} normalFile 普通版技能文件绝对路径：目录式 <id>/SKILL.md 或扁平 <id>.md。
 * @returns {string} AGI 文件绝对路径。目录式为 <id>/SKILL.agi.md；扁平 xxx.md 配对到 xxx/SKILL.agi.md，避免在技能根目录多出假技能；入参为空返回空串。
 */
function agiSkillFileFor(normalFile) {
  const file = String(normalFile || '').trim();
  if (!file) return '';
  const base = path.basename(file);
  if (base.toLowerCase() === 'skill.md') return path.join(path.dirname(file), AGI_SKILL_FILE);
  const id = base.replace(/\.md$/i, '');
  return path.join(path.dirname(file), id, AGI_SKILL_FILE);
}

/**
 * 取技能在某模式下的正文。
 * @param {object} skill 技能条目，body 为普通版原文，agiBody 为 AGI 版原文。
 * @param {boolean} agi 为真取 AGI 版；否则取普通版。
 * @returns {string} 供模型阅读的正文。AGI 版没有独立文件时返回空串，绝不回退普通版文案；普通版沿用 normal-only 标记约定，展示普通专用段。
 */
function skillBodyForMode(skill, agi = false) {
  const item = skill || {};
  if (agi) return String(item.agiBody ?? '');
  return skillTextForMode(item.body, false);
}

/**
 * 取技能在某模式下对应的磁盘文件绝对路径。
 * @param {object|string} skillOrFile 技能条目（用其 file 字段）或普通版技能文件绝对路径。
 * @param {boolean} agi 为真返回配对 AGI 文件路径；否则返回普通版文件路径。
 * @returns {string} 文件绝对路径；入参为空返回空串。路径只做推导，不保证文件已存在，也不创建文件。
 */
function skillFileForMode(skillOrFile, agi = false) {
  const file = typeof skillOrFile === 'string'
    ? String(skillOrFile || '').trim()
    : String((skillOrFile && skillOrFile.file) || '').trim();
  if (!file) return '';
  if (!agi) return file;
  return agiSkillFileFor(file);
}

/**
 * 按用户的勾选顺序合并当前模式已填写的技能，供发送和预览共同使用。
 * 未配置或已清空的版本不参与名称、正文和分隔符拼接。
 */
function combineSkillsForMode(selected, agi) {
  const ids = [];
  const names = [];
  const bodies = [];
  for (const skill of selected) {
    const body = skillBodyForMode(skill, agi);
    if (!body.trim()) continue;
    ids.push(skill.id);
    names.push(skill.name);
    bodies.push(body);
  }
  if (!bodies.length) return null;
  const text = bodies.join('\n\n---\n\n');
  return { id: ids.join('+'), name: names.join(' + '), body: agi ? '' : text, agiBody: agi ? text : '' };
}

/** 只读列出全局或项目目录内的技能，每种模式的正文与简介来自各自的文件。 */
function readSkillDir(dir, scope) {
  if (!dir || !fs.existsSync(dir)) return [];
  const items = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    // 兼容扁平普通版；其同名目录仅承载 AGI 文件时由扁平条目负责，两版共用一个技能 ID。
    const md = ent.isDirectory()
      ? path.join(dir, ent.name, 'SKILL.md')
      : (ent.name.toLowerCase().endsWith('.md') ? path.join(dir, ent.name) : null);
    if (!md) continue;
    const hasNormal = fs.existsSync(md);
    const name = ent.isDirectory() ? ent.name : ent.name.slice(0, -3);
    const agiPath = agiSkillFileFor(path.join(dir, name, 'SKILL.md'));
    const hasAgi = fs.existsSync(agiPath);
    if (!hasNormal && (!hasAgi || fs.existsSync(path.join(dir, name + '.md')))) continue;
    const body = hasNormal ? fs.readFileSync(md, 'utf8') : '';
    // 普通模式简介用普通版原文；normal-only 标记的展开只在取正文时按模式做
    const desc = body.trim() ? describeSkill(skillTextForMode(body, false), name) : '';
    // AGI 版本只认独立 AGI 文件，没有该文件时正文与简介都留空，绝不从普通文案派生
    const agiBody = hasAgi ? fs.readFileSync(agiPath, 'utf8') : '';
    const agiDesc = agiBody.trim() ? describeSkill(agiBody, name) : '';
    // 列举阶段只读不写：没有 AGI 文件时也不会顺手创建目录或模板
    items.push({
      id: name, name, desc, agiDesc, agiBody, body,
      file: md, agiFile: hasAgi ? agiPath : '', scope
    });
  }
  return items;
}

function appSkillsDir(appRoot) {
  return path.join(appRoot, 'skills');
}

const META_DIR = '.simple';
const LEGACY_META = '.sinpo';

function pickMetaPath(workspace, sub) {
  if (!workspace) return null;
  const neu = path.join(workspace, META_DIR, sub);
  const old = path.join(workspace, LEGACY_META, sub);
  if (fs.existsSync(neu)) return neu;
  if (fs.existsSync(old)) return old;
  return neu;
}

function workspaceSkillsDir(workspace) {
  return pickMetaPath(workspace, 'skills');
}

function skillKey(s) {
  return `${s.scope || 'app'}:${s.id}`;
}

// 固定置顶的技能 id：zabingsk 永远排在技能列表第一位（即默认技能）。
// 列表里没有 zabingsk 时，其余技能保持原有优先度顺位不变。
const TOP_SKILL_ID = 'zabingsk';

function applyOrder(skills, order) {
  const rank = new Map((order || []).map((o, i) => [`${o.scope || 'app'}:${o.id}`, i]));
  return [...skills].sort((a, b) => {
    // 置顶判断：zabingsk 恒排最前；两个都不是或都是 zabingsk 时，继续走下面的 rank 比较（保持原顺序，sort 稳定）
    const ta = a.id === TOP_SKILL_ID;
    const tb = b.id === TOP_SKILL_ID;
    if (ta !== tb) return ta ? -1 : 1;
    const ra = rank.has(skillKey(a)) ? rank.get(skillKey(a)) : 10000 + skills.indexOf(a);
    const rb = rank.has(skillKey(b)) ? rank.get(skillKey(b)) : 10000 + skills.indexOf(b);
    return ra - rb;
  });
}

function listDetailed(appDir, workspace, order) {
  const all = applyOrder([
    ...readSkillDir(appDir, 'app'),
    ...readSkillDir(workspaceSkillsDir(workspace), 'workspace')
  ], order);
  const seen = new Set();
  return all.map((s, i) => {
    const active = !seen.has(s.id);
    if (active) seen.add(s.id);
    return { ...s, priority: i + 1, active };
  });
}

function loadAll(appDir, workspace, order) {
  return listDetailed(appDir, workspace, order).filter((s) => s.active);
}

function sanitizeId(id) {
  const s = String(id || '').trim();
  if (!s) throw new Error('请填写技能名称');
  if (/[\\/:*?"<>|]/.test(s) || s.includes('..')) throw new Error('技能名称不能包含 \\ / : * ? " < > |');
  return s;
}

function resolveDir(appRoot, workspace, scope) {
  if (scope === 'workspace') {
    if (!workspace) throw new Error('请先打开项目，才能保存项目技能');
    return workspaceSkillsDir(workspace);
  }
  return appSkillsDir(appRoot);
}

/**
 * 删除目录式技能目录；扁平 md 路径则直接删文件。
 * @param {string} dir 技能目录或扁平 md 文件路径。
 * @returns {void} 路径不存在时什么都不做。
 */
function removeSkillFolder(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  const md = path.join(dir, 'SKILL.md');
  if (fs.existsSync(md)) {
    fs.rmSync(dir, { recursive: true, force: true });
    return;
  }
  if (dir.toLowerCase().endsWith('.md') && fs.existsSync(dir)) fs.unlinkSync(dir);
}

/** 目录存在且已空时删除，避免改名或删除后残留空技能目录。 */
function removeEmptyDir(dir) {
  if (!dir || !fs.existsSync(dir)) return;
  if (fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
}

/**
 * 把技能的两个版本连同目录内附件从旧名搬到新名。
 * @param {string} dirRoot 技能根目录（全局或项目）。
 * @param {string} oldId 改名前技能名。
 * @param {string} newId 改名后技能名。
 * @returns {void}
 * @throws {Error} 新名称已存在技能目录或扁平文件时抛出，禁止覆盖另一个技能。
 */
function renameSkillFiles(dirRoot, oldId, newId) {
  const oldFolder = path.join(dirRoot, oldId);
  const newFolder = path.join(dirRoot, newId);
  const oldFlat = path.join(dirRoot, `${oldId}.md`);
  const newFlat = path.join(dirRoot, `${newId}.md`);
  // 目标名已被别的技能占用时直接拒绝，避免把两个技能合成一个或丢附件
  if (fs.existsSync(newFolder) || fs.existsSync(newFlat)) {
    throw new Error('已存在同名技能，不能覆盖');
  }
  // 整目录搬移：SKILL.md、SKILL.agi.md 和用户自己放的附件一起走，不用删除重建
  if (fs.existsSync(oldFolder)) fs.renameSync(oldFolder, newFolder);
  // 扁平普通版改名后仍是扁平文件；它的 AGI 版本在上一步随同名目录搬移
  if (fs.existsSync(oldFlat)) fs.renameSync(oldFlat, newFlat);
}

/**
 * 决定当前模式要写入的技能文件路径，尽量保持技能原有目录式或扁平式布局。
 * @param {string} dirRoot 技能根目录。
 * @param {string} name 技能名。
 * @param {boolean} agi 是否写 AGI 版本。
 * @returns {string} 要写入的文件绝对路径；扁平普通版继续写原扁平文件，避免同一技能出现两份普通正文。
 */
function skillWriteTarget(dirRoot, name, agi) {
  const folder = path.join(dirRoot, name);
  const md = path.join(folder, 'SKILL.md');
  const flat = path.join(dirRoot, `${name}.md`);
  if (agi) {
    // AGI 版本统一放同名技能目录；扁平技能也配对到同名目录，不在根目录新增假技能文件
    return path.join(folder, AGI_SKILL_FILE);
  }
  if (fs.existsSync(md)) return md;
  if (fs.existsSync(flat)) return flat;
  return md;
}

/**
 * 保存技能，只写调用方显式指定的那个版本。
 * @param {string} appRoot 程序根目录，用于定位全局技能目录。
 * @param {string} workspace 当前项目根目录，可为空。
 * @param {object} payload 保存参数。
 * @param {string} payload.id 新技能名。
 * @param {string} [payload.body] 当前版本正文。
 * @param {string} [payload.scope] 作用域 app（全局，默认）或 workspace（项目）。
 * @param {string} [payload.oldId] 改名前的技能名，用于搬移现有文件与附件。
 * @param {string} [payload.mode] normal（普通版，默认）或 agi（AGI 版）。
 * @returns {void}
 * @throws {Error} 技能名非法、项目未打开、改名目标已存在时抛出。
 */
function saveSkill(appRoot, workspace, payload) {
  const { id, body, scope, oldId, mode } = payload || {};
  const name = sanitizeId(id);
  const agi = String(mode || 'normal').trim().toLowerCase() === 'agi';
  const dirRoot = resolveDir(appRoot, workspace, scope || 'app');
  fs.mkdirSync(dirRoot, { recursive: true });
  const oldName = oldId ? sanitizeId(oldId) : '';
  // 改名先搬移全部版本，再写当前版本，避免旧技能残留或两版内容走散
  if (oldName && oldName !== name) renameSkillFiles(dirRoot, oldName, name);
  const target = skillWriteTarget(dirRoot, name, agi);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  // 管理器明确指定版本时保留手写内容（含空串）；旧调用未指定版本时沿用普通模板。
  let text = String(body ?? '');
  if (!mode && !text.trim()) text = `# ${name}\n\n什么时候用：\n\n要怎么做：\n`;
  fs.writeFileSync(target, text, 'utf8');
}

/**
 * 删除技能的两个版本：目录式技能整目录移除，扁平技能同时清掉配对目录里的 AGI 文件。
 * @param {string} appRoot 程序根目录，用于定位全局技能目录。
 * @param {string} workspace 当前项目根目录，可为空。
 * @param {object} payload 删除参数。
 * @param {string} payload.id 技能名。
 * @param {string} [payload.scope] 作用域 app（全局，默认）或 workspace（项目）。
 * @returns {void}
 * @throws {Error} 普通版与 AGI 版都不存在时抛出技能不存在。
 */
function deleteSkill(appRoot, workspace, { id, scope }) {
  const name = sanitizeId(id);
  const dirRoot = resolveDir(appRoot, workspace, scope || 'app');
  const folder = path.join(dirRoot, name);
  const flat = path.join(dirRoot, `${name}.md`);
  const folderAgi = path.join(folder, AGI_SKILL_FILE);
  if (fs.existsSync(path.join(folder, 'SKILL.md'))) {
    removeSkillFolder(folder);
    return;
  }
  if (!fs.existsSync(flat) && !fs.existsSync(folderAgi)) throw new Error('技能不存在');
  if (fs.existsSync(flat)) fs.unlinkSync(flat);
  if (fs.existsSync(folderAgi)) fs.unlinkSync(folderAgi);
  removeEmptyDir(folder);
}

/** 列出规则目录；只有管理界面可将专用 AGI 规则作为可编辑条目返回。 */
function readRuleDir(dir, scope, forManagement = false) {
  if (!dir || !fs.existsSync(dir)) return [];
  const items = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith('.md')) continue;
    if (ent.name.toLowerCase() === 'persona.md') continue; // 人设单独管理，不算普通规则
    if (!forManagement && scope === 'app' && ent.name.toLowerCase() === 'agi.md') continue;
    const file = path.join(dir, ent.name);
    const body = fs.readFileSync(file, 'utf8');
    const name = path.basename(ent.name, '.md');
    const first = body.split(/\r?\n/).find((l) => l.trim()) || name;
    items.push({ id: name, name, desc: first.replace(/^#\s*/, '').trim(), body, file, scope });
  }
  return items;
}

/** 合并全局和项目规则；全局 AGI 规则在模型请求中使用专门的读取入口。 */
function loadRules(appRulesDir, workspace, forManagement = false) {
  const neu = workspace ? path.join(workspace, META_DIR, 'rules') : null;
  const old = workspace ? path.join(workspace, LEGACY_META, 'rules') : null;
  const all = [
    ...readRuleDir(appRulesDir, 'app', forManagement),
    ...readRuleDir(neu, 'workspace'),
    ...readRuleDir(old, 'workspace')
  ];
  const seen = new Set();
  return all.filter((r) => {
    const k = `${r.scope}:${r.id}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function resolveRuleDir(appRoot, workspace, scope) {
  if (scope === 'workspace') {
    if (!workspace) throw new Error('请先打开项目，才能保存项目规则');
    return path.join(workspace, META_DIR, 'rules');
  }
  return path.join(appRoot, 'rules');
}

function sanitizeRuleId(id) {
  const s = String(id || '').trim();
  if (!s) throw new Error('请填写规则名称');
  if (/[\\/:*?"<>|]/.test(s) || s.includes('..')) throw new Error('规则名称不能包含 \\ / : * ? " < > |');
  return s;
}

function saveRule(appRoot, workspace, { id, body, scope, oldId }) {
  const name = sanitizeRuleId(id);
  const dir = resolveRuleDir(appRoot, workspace, scope || 'app');
  fs.mkdirSync(dir, { recursive: true });
  // AGI 正文由用户维护，清空后必须保持空白。
  const manualAgi = (scope || 'app') === 'app' && name.toLowerCase() === 'agi';
  const text = manualAgi || String(body ?? '').trim() ? String(body ?? '') : `# ${name}\n\n（规则内容）\n`;
  fs.writeFileSync(path.join(dir, `${name}.md`), text, 'utf8');
  if (oldId && oldId !== name) {
    const old = path.join(dir, `${oldId}.md`);
    if (fs.existsSync(old)) fs.unlinkSync(old);
  }
}

function deleteRule(appRoot, workspace, { id, scope }) {
  const name = sanitizeRuleId(id);
  const dir = resolveRuleDir(appRoot, workspace, scope || 'app');
  const file = path.join(dir, `${name}.md`);
  if (fs.existsSync(file)) fs.unlinkSync(file);
  else throw new Error('规则不存在');
}

function personaFile(appRoot) {
  return path.join(appRoot, 'rules', 'persona.md');
}

function loadPersona(appRoot) {
  const file = personaFile(appRoot);
  if (!fs.existsSync(file)) return { body: '' };
  return { body: fs.readFileSync(file, 'utf8') };
}

function savePersona(appRoot, body) {
  const file = personaFile(appRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(body ?? ''), 'utf8');
}

module.exports = {
  loadAll, listDetailed, saveSkill, deleteSkill, parseSkillMeta, skillTextForMode,
  skillBodyForMode, combineSkillsForMode, skillFileForMode, agiSkillFileFor,
  loadRules, saveRule, deleteRule, loadPersona, savePersona
};
