// 发送前预览（prompt-preview）：按 runTurn 的同一批来源，在本地只读地把本轮要发给模型的 system 文本拼一遍，
// 供预览面板展示与编辑；面板里的改动只用于本次预览，不写回磁盘，也不改变真正发送的内容。
// 全程只读文件，不写盘，不发模型请求。
// system 的文案一律由 agent.js 的 buildSystemPrompt / composePromptTail 生成，本模块不复制任何提示词文案，
// 免得预览看到的内容和实际发出去的提示词悄悄走样。
const fs = require('fs');
const path = require('path');
const agent = require('./agent');
const { buildModulePrompt } = require('./module-prompts');
const skillsLib = require('./skills');
const memoryGlobal = require('./memory-global');
const store = require('./store');
const assembly = require('./assembly');
const apiProtocol = require('./api-protocol');
const replyLang = require('./reply-lang');
const { extraRoots } = require('./workspace');

/**
 * 取 agent.js 导出的两个提示词拼装函数。
 * 预览必须与真正发送共用同一份实现，所以缺任何一个都直接报错，
 * 不在这里另写一份提示词——两份文案一定会走散。
 * @returns {{buildSystemPrompt: Function, composePromptTail: Function}}
 */
function promptBuilders() {
  const buildSystemPrompt = agent.buildSystemPrompt;
  const composePromptTail = agent.composePromptTail;
  if (typeof buildSystemPrompt !== 'function' || typeof composePromptTail !== 'function') {
    throw new Error('发送前预览缺少 agent.buildSystemPrompt / agent.composePromptTail 导出，请先在 agent.js 里导出这两个函数');
  }
  return { buildSystemPrompt, composePromptTail };
}

/**
 * 本会话的方案文件路径。
 * 会话键是「窗口号:会话 id」，窗口号重启会变，所以只按会话 id 命名，与 runTurn 里的 planFileOf 同一口径。
 * 没打开工作区时方案文件在用户数据目录，预览只关心工作区里那份，返回空串。
 * @param {string} [workspace] 当前工作区
 * @param {string} [sessionKey] 会话键
 * @returns {string} 方案文件绝对路径，无工作区时为空串
 */
function planFileOf(workspace, sessionKey) {
  if (!workspace) return '';
  const raw = String(sessionKey || '');
  const tabId = raw.indexOf(':') >= 0 ? raw.slice(raw.indexOf(':') + 1) : raw;
  const id = tabId.replace(/[^\w\-]+/g, '_').slice(0, 80) || 'default';
  return path.join(workspace, '.simple', 'plans', `${id}.md`);
}

/**
 * 这一轮是否已经开工。
 * 与 runTurn 的 startOrderedFor 同义：只认开工按钮带的 action === 'start-work'，
 * 或整条消息就是 /spcode-start（中文输入法常打出全角斜杠和全角空格，先归一成半角再比）。
 * @param {string} text 用户这一轮的正文
 * @param {string} [action] 渲染层上报的动作，开工按钮为 'start-work'
 * @returns {boolean}
 */
function startOrderedFor(text, action) {
  const t = String(text || '').replace(/／/g, '/').replace(/[\u3000\u00a0]/g, ' ').trim();
  return action === 'start-work' || t === '/spcode-start';
}

/**
 * 本地 GGUF 模型判定，口径与 runTurn 内部一致：type 为 local、带 modelPath，或模型名是 .gguf 文件。
 * @param {object} [modelCfg] 模型配置
 * @returns {boolean}
 */
function isLocalGguf(modelCfg) {
  if (!modelCfg) return false;
  if (modelCfg.type === 'local') return true;
  if (modelCfg.modelPath) return true;
  return /\.gguf$/i.test(String(modelCfg.model || ''));
}

/**
 * 两个模型配置是否同一只模型：本地 GGUF 比模型文件，其他比 id。
 * @returns {boolean}
 */
function sameModel(a, b) {
  if (!a || !b) return false;
  if (isLocalGguf(a) && isLocalGguf(b)) {
    return (a.model || a.modelPath) === (b.model || b.modelPath);
  }
  return !!(a.id && a.id === b.id);
}

/**
 * zbaingAI 本地引擎判定，与 runTurn 内部一致：type 或 id 为 zbaingAi。
 * 预览里用它在提示词上加底模段（zbaingBridge）。
 * @param {object} [modelCfg] 模型配置
 * @returns {boolean}
 */
function isZbaingAi(modelCfg) {
  return modelCfg?.type === 'zbaingAi' || modelCfg?.id === 'zbaingAi';
}

/**
 * 模型组合里某个角色挂的模型配置。
 * @param {object} vs 设置快照（store.load() 的结果）
 * @param {string} roleId assembly.ROLES 里的角色 id，如 'code'、'planning'
 * @returns {object|null} 没挂该角色、或挂的模型解析不出来时返回 null
 */
function workerOf(vs, roleId) {
  const hit = assembly.resolveRole(vs, roleId);
  if (!hit) return null;
  return assembly.slotToModelCfg(hit.slot, vs) || null;
}

/**
 * 规划槽模型，与 runTurn 的 planningWorkerOf 同口径：
 * 规划槽和大脑是同一只模型时视为没配规划，避免自己把活派给自己。
 * @returns {object|null}
 */
function planningWorkerOf(vs, modelCfg) {
  const cfg = workerOf(vs, 'planning');
  if (!cfg || sameModel(cfg, modelCfg)) return null;
  return cfg;
}

/**
 * AGI（桌面操作）是否在当前这一轮开着，与 runTurn 的 desktopOn 同源。
 * 桌面手按需加载：预览本身不操作桌面，加载它只是为了读开关状态。
 * @returns {boolean}
 */
function desktopOn() {
  try { return require('./desktop-hand').isAlive(); } catch { return false; }
}

/**
 * 全局偏好列表：钉住的排在前面，其余保持磁盘顺序。
 * runTurn 走 recallPrefs 做向量召回，那条路会写向量缓存文件；预览要求不写盘，
 * 所以这里只读磁盘上的偏好列表，不走向量召回。
 * @returns {Array<object>} memory-global 的偏好条目
 */
function readPrefs() {
  const all = memoryGlobal.listPrefs();
  return [...all.filter((p) => p.pinned), ...all.filter((p) => !p.pinned)];
}

/**
 * 按 runTurn 的同一批来源拼出本轮 system 预览。
 * 副作用：只读文件；不写盘，不发模型请求。
 *
 * @param {object} ctx
 *   appRoot         SpCode 安装目录，技能、规则、人设都从这里读
 *   workspace       当前工作区，可为空
 *   modelCfg        本轮大脑模型配置，决定直通段与提示词分支（必填）
 *   skillIds        本轮勾中的技能 id 列表，未上报时按 chat:send 的默认 zabingsk
 *   history         当前会话历史（user / assistant 消息）
 *   userText        用户这一轮输入的正文
 *   action          渲染层上报的动作，开工按钮为 'start-work'
 *   maxAgentRounds  轮数上限设置，缺省用设置里的 maxAgentRounds
 *   unlimitedRounds 是否「全解放」（不限轮数）
 *   contextSummary  较早对话的摘要
 *   extraFolders    用户额外加进工作区的目录
 *   sessionKey      可选，会话键；方案文件按它的会话 id 命名，缺省按 default 会话算
 * @returns {{
 *   system: string,
 *   modules: { code: string, summary: string, planning: string },
 *   editable: { persona: string, rules: Array<{ name: string, body: string }>, skill: object|null, summary: string },
 *   notes: string[]
 * }}
 *   system 是本次会发给模型的完整 system 文本；editable 是面板可以先改的几项（只用于预览）；
 *   notes 标出哪些内容要等发送时才现场生成。
 */
function build(ctx) {
  const opts = ctx || {};
  const {
    appRoot, workspace, modelCfg, skillIds, history, userText, action,
    maxAgentRounds, unlimitedRounds, contextSummary, extraFolders, sessionKey
  } = opts;
  // 没选模型时返回说明文本，避免未捕获异常打断界面；真发送同样会被 runTurn 拦下
  if (!modelCfg) {
    return {
      system: '（未选择模型，无法生成完整提示词：请在顶部模型栏勾选至少一个模型。）',
      editable: { persona: '', rules: [], skill: null, summary: '' },
      notes: ['未选择模型时，提示词预览不可用。']
    };
  }
  const { buildSystemPrompt, composePromptTail } = promptBuilders();
  const vs = store.load();
  const order = vs.skillOrder || [];

  // 技能：与 chat:send 一致——勾中的按顺序组合成一份；没上报勾选时默认 zabingsk。
  // 同名 id 去重，勾选顺序保持用户点选的顺序。
  const source = Array.isArray(skillIds) ? skillIds : ['zabingsk'];
  const ids = [];
  for (const id of source) {
    const s = String(id || '').trim();
    if (s && !ids.includes(s)) ids.push(s);
  }
  const allSkills = agent.listSkills(appRoot, workspace, order);
  const chosen = ids.map((id) => allSkills.find((x) => x.id === id)).filter(Boolean);
  const skill = chosen.length
    ? {
      id: chosen.map((x) => x.id).join('+'),
      name: chosen.map((x) => x.name).join(' + '),
      body: chosen.map((x) => x.body).join('\n\n---\n\n')
    }
    : null;

  // 规则、人设：与 runTurn 同一来源（安装目录 + 工作区 .simple 下的 rules），不在这里另算优先级
  const rules = agent.listRules(appRoot, workspace);
  const persona = skillsLib.loadPersona(appRoot).body || '';

  // 大脑的用户画像与偏好仍读磁盘；会话工作记忆不再注入提示词。
  const globalPrefs = readPrefs();
  const profile = memoryGlobal.getProfile();

  // 对话索引已从 system 移除；历史仍用于下方的回复语言判断，不额外生成标题列表。

  // 直通、代码槽、规划槽：决定提示词里的直通段、开工门槛段和派单相关措辞
  const directProtocol = apiProtocol.normalizeProtocol(modelCfg?.protocol);
  const cursorDirectOn = directProtocol === 'cursor';
  const codexDirectOn = directProtocol === 'codex';
  const claudeDirectOn = directProtocol === 'claudecode';
  const directOn = cursorDirectOn || codexDirectOn || claudeDirectOn;
  // 代码槽即使和大脑是同一只模型也算配了：runTurn 里派工只看槽位是否存在
  const codeWorker = workerOf(vs, 'code');
  const planningWorker = planningWorkerOf(vs, modelCfg);
  const agiNow = desktopOn();
  const turnStart = startOrderedFor(userText, action);
  const roundLimit = store.clampAgentRounds(maxAgentRounds != null ? maxAgentRounds : vs.maxAgentRounds);
  const planFile = planFileOf(workspace, sessionKey);
  const planExists = !!planFile && fs.existsSync(planFile);
  // 回复语言与 runTurn 同一算法：对话里指定的语言优先于界面语言，影响中文/英文两套文案
  const lang = replyLang.resolve({ locale: vs.locale, userText, history });

  const system = buildSystemPrompt({
    workspace,
    rules,
    skill,
    extra: extraRoots(appRoot, workspace, extraFolders),
    allSkills,
    persona,
    // 预览里没有附件：看图识别的结果要等发送时才由视觉模型现场生成，这里按「本轮没有图片」拼
    visionMode: '',
    visionBridge: null,
    lang,
    globalPrefs,
    profile,
    zbaingBridge: isZbaingAi(modelCfg),
    // 挂了代码槽且 AGI 没开时，改文件交给代码手，大脑自己不动手
    brainHandsOff: !!codeWorker && !agiNow,
    hasPlanning: !!planningWorker,
    userOrder: userText,
    // 全解放与 AGI 都不给轮次上限，与 runTurn 一致；否则写进提示词的思考上限就是设置里的轮数
    thinkBudget: (agiNow || !!unlimitedRounds) ? null : roundLimit,
    planFile,
    startOrdered: turnStart
  }) + composePromptTail({
    modelCfg,
    turnStart,
    userText,
    directOn,
    cursorDirectOn,
    codexDirectOn,
    claudeDirectOn,
    codeWorker,
    planningWorker,
    agiNow,
    unlimitedRounds: !!unlimitedRounds,
    roundLimit,
    planFile,
    lang
  });

  return {
    system,
    // 内部模块预览复用实际构建器；派单、差异和路径相关技术约束在调用时追加。
    modules: {
      code: buildModulePrompt('code', { rules, skill }),
      summary: buildModulePrompt('summary', { rules, skill }),
      planning: buildModulePrompt('planning', { rules, skill })
    },
    editable: {
      persona,
      rules: rules.map((r) => ({ name: r.name, body: r.body })),
      skill: skill ? { id: skill.id, name: skill.name, body: skill.body } : null,
      summary: String(contextSummary || '')
    },
    // 这些内容发送时才现场产生，预览里看不到，面板会按这些说明标注
    notes: [
      '内部模块展示各自基础提示词；具体派单、验收材料和当前调用的技术约束在实际调用时追加，不继承大脑人设或工作记忆。',
      '联网检索结果：发送时才现场检索，预览里没有这部分内容。',
      '看图识别结果：发送时才按本轮图片现场识别，预览里没有这部分内容。',
      '工具返回：read_file / search_text / run_command 等工具要到发送后才执行，预览里没有它们的返回。',
      planExists
        ? `方案文件正文：发送时才现场读取 ${planFile} 并附进提示词，预览里不含正文。`
        : '方案文件正文：这会话还没写入方案文件，发送时若已锁定才读正文。'
    ]
  };
}

module.exports = { build };
