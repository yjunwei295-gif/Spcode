/**
 * 构建内部模块专用提示词，不接收大脑的人设、用户画像或会话记忆。
 * 任务正文和代码证据由调用方放进 user 消息；这里只组合职责、当前技能与规则。
 */
const ROLE_DUTIES = {
  code: '你是代码实现模块。只按大脑派单实现明确的目标、文件范围与验收要求；复用已给源码，缺少原文时读取相关片段。只回报实际改动、验证结果与具体缺口。',
  summary: '你是总结核对模块。独立核对用户目标、代码变化和运行证据，只输出核实后的验收结论与具体缺口。可以读取代码，不得修改代码；不能把写入或语法检查当成功能已通过。',
  planning: '你是规划模块。只根据大脑提供的目标、范围、约束与材料整理实施步骤、依赖顺序、风险和验收点。不要读写文件或调用工具；材料不足时把具体缺口回报大脑。'
};

/**
 * 为指定内部模块组合本轮提示词。
 * @param {string} role 模块标识，代码、总结、规划分别使用独立职责，其他辅助角色保留调用方的专用指令。
 * @param {object} context 本轮生效的 rules 与 skill；不读取人设、语气、工作记忆或历史摘要字段。
 * @param {string} instructions 调用路径的技术约束与输出协议，不包含大脑系统提示词。
 * @returns {string} 内部模块系统提示词；不修改输入或任何持久化数据。
 */
function buildModulePrompt(role, context, instructions = '') {
  const parts = [ROLE_DUTIES[role] || `你是内部辅助模块（${role}），只处理大脑提供的专项任务。`];
  if (instructions) parts.push(String(instructions));
  if (context && context.rules && context.rules.length) {
    const rules = [];
    for (const rule of context.rules) rules.push(`### ${rule.name}\n${rule.body}`);
    parts.push('## 本轮规则\n' + rules.join('\n\n'));
  }
  if (context && context.skill) {
    parts.push(`## 本轮技能：${context.skill.name}\n${context.skill.body}`);
  }
  // 技能可能同时规定技术要求和大脑沟通方式；保留原文，按模块职责限定其适用范围。
  parts.push('## 内部模块职责边界\n大脑负责理解用户需求、裁定任务范围、派单和面向用户的沟通。本模块以准确完成派单和核对事实为目标，不以沟通效果或文案润色为目标；结果只交给大脑，按调用方要求的格式给出实际产物、证据、验证结果和未解决项，不用面向用户的开场、收尾或比喻。只执行技能与规则中的任务、技术和质量要求。人设、称呼、语气、寒暄、面向用户的解释与确认流程只适用于大脑，本模块不采用。不要模仿上下文中用户或助手的说话风格，不输出角色扮演内容。任务由大脑交付；缺少必要信息时仅回报大脑，不向用户提问，不调用其他模块。遵守派单中的禁止改动范围，只依据实际代码和工具结果报告事实。');
  return parts.join('\n\n');
}

module.exports = { buildModulePrompt };
