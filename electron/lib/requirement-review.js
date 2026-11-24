'use strict';

/**
 * 给用户原文中的句子、列表行编号，供总结逐段对照；一段内并列要求仍须全部核实。
 * @param {string} text 用户原话，含本轮补充，可混有实现要求、答复要求和代码围栏。
 * @returns {string[]} 按原顺序保留的非空段落，数组顺序决定本次验收编号；代码围栏整段保留。
 */
function sections(text) {
  const items = [];
  let fence = '';
  let block = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const marker = line.trimStart().match(/^(`{3,}|~{3,})/);
    if (fence || marker) {
      block.push(line);
      if (!fence) fence = marker[1];
      else if (line.trim().startsWith(fence) && marker && marker[1] === line.trim()) {
        items.push(block.join('\n'));
        block = [];
        fence = '';
      }
      continue;
    }
    // 「修复开关并告诉我原因」包含两份交付，分别保留实现和答复的原文，验收时各自举证。
    for (const clause of line.split(/(?<=[。！？；;])|(?<=[，,])\s*(?=并且|并|还要|同时|另外|以及|告诉我)|(?=(?:并且?|然后|同时|顺便)(?:告诉我|解释一下|说明一下))|(?<=[.!?])\s+(?=[A-Z])/u)) {
      if (clause.trim()) items.push(clause.trim());
    }
  }
  if (block.length) items.push(block.join('\n'));
  return items;
}

/**
 * 生成逐项核对说明，区分实施证据与用户原文中的背景和更正。
 * @param {string[]} items 按到达顺序拆分的需求原文。
 * @returns {string} 验收格式及从 1 开始编号的完整原文，供总结端逐项核对。
 */
function instruction(items) {
  const lines = [
    '按到达顺序核对以下用户原文。方案、待办、已改文件都可能漏项。每段里的并列要求、限制和验证步骤都要检查；后续更正只取代明确冲突的部分。背景、引用示例和被取消的事项不要实施。',
    '通过时每个编号单独一行。仍需实施的功能写「核对 N：具体核实了什么。证据：文件路径:行号「原文」」。功能须查实际实现，已存在的正确行为也可通过；禁止仅凭完成声明或改过文件判通过。',
    '用户要求按主题换界面或按钮风格时，核对每个应交付主题实际绑定的样式或资源。若绑定结果只有调色、背景色或着色参数不同，按风格缺失列为不一致。已有目视回执时一并核对同一元素同一状态的非配色差异。用户明确只改颜色时按配色要求核对。同一核对行可在末尾引用多处源码，格式为「证据：路径:行号「原文」；路径:行号「原文」」。',
    '要求执行命令时可在行末写「命令：成功命令原文」，结合实际执行内容判断。仅要求文字答复时可写「答复：「回复原文」」，引用实际交付的答案；复述需求的部分不能作为完成证据。功能须引用源码。',
    '只说明原文关系时另起一行，格式为「背景 N：理由。依据：需求 N「原文」」「取消 N：理由。依据：需求 M「原文」」或「替代 N：理由。依据：需求 M「原文」」。背景自引仅限用户明确标为背景、现状或示例的原文，其余背景可用核对行提供独立依据。取消或替代须引用较晚的明确更正，说明它如何影响原项。仍然有效的要求和替代后的新功能须分别核实。',
    '发现漏做时写「方案验收：未通过」，每个「不一致：」行列出用户原话、实际缺口、应补的行为和可定位的源码证据。没有实现时查实际入口或调用方，不编造不存在的文件行号。证据不足先用只读工具核实。'
  ];
  for (const [index, item] of items.entries()) lines.push('需求 ' + (index + 1) + '：' + item);
  return lines.join('\n');
}

/**
 * 核实答复引文至少有一次出现在执行者自己交付的正文里。
 * @param {string} reply 执行者实际答复，可能先复述需求再给出答案。
 * @param {string} quote 总结端提供的答复引文。
 * @param {string[]} items 已编号的非空用户原文。
 * @returns {boolean} 至少一处引文完全落在需求复述之外时返回真；复述可保留或省略句末标点。
 */
function hasReplyEvidence(reply, quote, items) {
  if (!quote.trim()) return false;
  // 两种写法都保留：引文从原句的句号开始时仍与复述重叠，省去句号时则按正文的实际长度判断。
  const echoes = new Set(items);
  for (const item of items) {
    const body = item.replace(/[。！？.!?；;…]+$/u, '').trimEnd();
    if (body) echoes.add(body);
  }
  for (let start = reply.indexOf(quote); start >= 0; start = reply.indexOf(quote, start + 1)) {
    let overlaps = false;
    for (const item of echoes) {
      // 只查可能与本次引文相交的复述位置；相同文字在后面的独立答复里仍可举证。
      const earliest = Math.max(0, start - item.length + 1);
      const copiedAt = reply.indexOf(item, earliest);
      if (copiedAt >= 0 && copiedAt < start + quote.length) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) return true;
  }
  return false;
}

/**
 * 根据用户原文判断该项是否明确要求在答复中交付文字或执行命令。
 * @param {string} item 当前编号的原始需求；引号内的示例或待回复文字不参与动作判断。
 * @param {string} label 本行提供的证据类型，取「答复」或「命令」。
 * @returns {boolean} 各个并列动作均明确要求这类交付时返回真；功能或混合项仍须查源码。
 */
function requestsEvidence(item, label) {
  const prose = item.replace(/「[^」]*」|“[^”]*”|`[^`]*`|"[^"]*"/gu, '「」')
    .replace(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)/u, '');
  // 只分开独立的连接词，保留「合并」「并发」等词。无须预先枚举连接词后所有可能的功能动作。
  const clauses = [];
  let clauseStart = 0;
  const words = new Intl.Segmenter('zh', { granularity: 'word' });
  for (const { segment, index } of words.segment(prose)) {
    if (!/^(?:[，,；;]|并|并且|且|以及|再|同时|然后|顺便|另外|还要|and|then)$/iu.test(segment)) continue;
    clauses.push(prose.slice(clauseStart, index));
    clauseStart = index + segment.length;
  }
  clauses.push(prose.slice(clauseStart));
  const replyAction = /^(?:(?:原样|逐字|直接|用文字|用一句话)?(?:回复|答复|回答)(?!时|后|前|中|按钮|功能|模块|组件|接口|框)|告诉我|说明(?!书|文档)|解释(?!器)|描述|列出|总结|为什么|为何|如何|怎么|(?:reply|respond|answer|explain|describe|list|summarize|tell me|why|how|what)\b)/iu;
  const commandAction = /^(?:(?:运行|执行|跑一下|跑)(?!时|中|后|前|按钮|功能|模块|组件|接口|器)|(?:run|execute)\b)/iu;
  const action = label === '答复' ? replyAction : commandAction;
  let found = false;
  for (const raw of clauses) {
    const clause = raw.trim().replace(/^(?:(?:请你?|麻烦你?|帮我|先|再|只需|只要|只|please\b)\s*)+/iu, '');
    if (!clause) continue;
    if (!action.test(clause)) return false;
    found = true;
  }
  return found;
}

/**
 * 列出通过声明中缺少证据或有效排除理由的需求，供总结端重新核对。
 * @param {string} verdict 总结端的逐项结论。
 * @param {string[]} items 按到达顺序编号的需求原文。
 * @param {Function} holds 核对行末源码证据是否与磁盘原文相符。
 * @param {string} reply 执行者实际交付的答复原文。
 * @param {string[]} commands 本轮已成功执行的命令原文。
 * @returns {string[]} 缺少依据的编号及原文；引文与需求的语义对应由只读总结核实。
 */
function unchecked(verdict, items, holds, reply, commands) {
  const checked = new Set();
  for (const raw of verdict.split(/\r?\n/)) {
    const match = raw.trim().match(/^(?:[-*•]\s*)?(核对|背景|取消|替代)\s*(\d+)\s*[:：]\s*(.+)$/u);
    if (!match) continue;
    const kind = match[1];
    const index = Number(match[2]) - 1;
    const row = match[3];
    if (index < 0 || index >= items.length) continue;
    const source = row.match(/依据\s*[:：]\s*需求\s*(\d+)\s*「(.+)」$/u);
    if (source) {
      // 原话只能解释为何无需实施。普通功能核对即使逐字抄对需求，也须另找实施证据。
      if (kind === '核对') continue;
      const cited = Number(source[1]) - 1;
      if (!items[cited]?.includes(source[2]) || !row.slice(0, source.index).trim()) continue;
      if (kind === '背景') {
        if (cited === index && /^(?:【(?:背景|现状|示例)】|(?:背景|现状|示例)\s*[:：])/u.test(items[index])) checked.add(index);
      } else if (cited > index) {
        // 旧要求只能由后到的用户更正取代，引用仍有效的原要求不能免除新功能的验收。
        // 以原句中的更正动词为准，不能从「实现取消按钮」这样的功能名称中摘出「取消」。
        const correction = kind === '取消'
          ? /(?:^|[，,。；;：:])\s*(?:请|先|暂时|现在|please\s+)?\s*(取消|撤销|暂缓|cancel\b|skip\b)|(作废|不用|不必|不要|不再|不做)/giu
          : /(改为|改成|换为|换成|更正为|用[^。；;]+(?:替代|取代|代替)|instead of\b|replace\b)/giu;
        for (const change of items[cited].matchAll(correction)) {
          if (source[2].includes(change[1] || change[2])) {
            checked.add(index);
            break;
          }
        }
      }
      continue;
    }
    if (kind !== '核对') continue;
    const answer = row.match(/答复\s*[:：]\s*「(.+)」$/u);
    const command = row.match(/命令\s*[:：]\s*(.+)$/u);
    const item = items[index];
    // 用户单列命令原文时可直接对应成功记录；自然语言指令则检查它要求的交付类型。
    const ranRequestedCommand = command && commands.includes(command[1]) &&
      (item === command[1] || requestsEvidence(item, '命令'));
    // 证据类型取决于该编号的用户原话；总结端在功能行写「答复」或「命令」不能降低举证要求。
    if (holds(row) || ranRequestedCommand ||
        (answer && requestsEvidence(item, '答复') && hasReplyEvidence(reply, answer[1], items))) checked.add(index);
  }
  const missing = [];
  for (const [index, item] of items.entries()) {
    if (!checked.has(index)) missing.push('需求 ' + (index + 1) + '：' + item);
  }
  return missing;
}

module.exports = { sections, instruction, unchecked };
