// 自测：用真实 SpCode 工具（读文件）走一轮官方客户端聊天桥，验证「思考在 Codex、执行在 SpCode」。
// 只读取一个固定文件的前三行，不修改任何项目内容；失败时直接以非零码退出，便于命令行判断。
const fs = require('fs');
const path = require('path');
const codexChat = require('../electron/lib/codex-chat-direct');

// 自测只允许读这一个文件，避免验证脚本越权访问其他项目内容。
const MUBAIO_WENJIAN = 'electron/lib/reply-lang.js';
// 记录聊天模型实际请求过的工具，用来确认工具不是被模型口头描述掉的。
const diaoYongJilu = [];

/**
 * 真实执行器：把聊天模型请求的工具调用落到本机文件系统。
 * @param {string} name 聊天模型请求的工具名，只有 read_file 被开放。
 * @param {object} args 工具参数，必须带 path。
 * @returns {Promise<string>} 目标文件前三行原文。
 */
async function runTool(name, args) {
  diaoYongJilu.push(name);
  if (name !== 'read_file') throw new Error('自测未开放工具：' + name);
  const rel = String(args && args.path ? args.path : '');
  if (rel !== MUBAIO_WENJIAN) throw new Error('自测只允许读取 ' + MUBAIO_WENJIAN);
  const abs = path.join(__dirname, '..', rel);
  const hang = fs.readFileSync(abs, 'utf8').split(/\r?\n/).slice(0, 3);
  return '文件前三行：\n' + hang.join('\n');
}

/** 组装工具定义：只声明一个读取工具，参数形态与 SpCode 的 read_file 一致。 */
function gongJuDingYi() {
  return [
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: '读取项目内一个文本文件的内容',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string', description: '相对项目根的文件路径' } },
          required: ['path'],
          additionalProperties: false
        }
      }
    }
  ];
}

async function main() {
  const jieguo = await codexChat.runTurn({
    key: 'selftest-real-tool',
    sig: 'selftest-real-tool',
    fresh: true,
    firstPrefix: '',
    systemContext: '这是桥接自测会话，除工具协议外不需要遵循其他项目规则。',
    turnText: '请用 tool 动作调用 read_file 读取 ' + MUBAIO_WENJIAN +
      ' 的前三行，拿到真实结果后用 final 动作把这三行原样告诉我。',
    userContent: [],
    tools: gongJuDingYi(),
    runTool,
    onEvent: function onEvent(event) {
      console.log('【事件】' + event.type + ' ' + String(event.text || ''));
    },
    signal: null,
    requiredToolNames: ['read_file'],
    agiMode: true
  });
  console.log('【最终答复】' + jieguo.content);
  console.log('【实际执行工具】' + diaoYongJilu.join(','));
  if (!diaoYongJilu.includes('read_file')) throw new Error('聊天模型没有真正触发 SpCode 工具');
  if (!/require|reply|lang/i.test(String(jieguo.content || ''))) throw new Error('最终答复里看不到真实文件内容');
  console.log('【自测结论】通过：真实工具已由 SpCode 执行并回传给聊天模型');
}

main().catch(function onFail(err) {
  console.error('【自测失败】' + (err && err.message ? err.message : err));
  process.exit(1);
});
