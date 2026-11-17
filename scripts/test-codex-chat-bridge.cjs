// 自测：通过官方 ChatGPT 客户端的聊天界面走一轮 SpCode 工具往返，验证桥接是否可用。
// 只使用一个确定性的本地工具，不读写项目文件，验证通过后再交给正式任务使用。
const codexChat = require('../electron/lib/codex-chat-direct');

let toolCalls = 0;

// 模拟的 SpCode 工具：返回固定时间戳，便于确认模型确实收到了工具真实结果。
async function jisuanTime() {
  toolCalls += 1;
  return '工具返回：本机时间字符串 2026-11-03T15:40:00+08:00';
}

async function main() {
  const tools = [
    {
      type: 'function',
      function: {
        name: 'jisuan_shijian',
        description: '返回本机当前时间的字符串，不需要任何参数',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      }
    }
  ];
  const args = {
    key: 'selftest-bridge',
    sig: 'selftest-bridge',
    fresh: true,
    firstPrefix: '',
    systemContext: '这是桥接自测会话，除工具协议外不需要遵循其他项目规则。',
    turnText: '请用动作记录调用 jisuan_shijian，拿到结果后用 final 动作把工具返回的时间字符串原样告诉我。',
    userContent: [],
    tools,
    runTool: async function runTool(name, toolArgs) {
      if (name !== 'jisuan_shijian') throw new Error('自测未开放工具：' + name);
      return jisuanTime();
    },
    onEvent: function onEvent(event) {
      console.log('【事件】' + event.type + ' ' + String(event.text || ''));
    },
    signal: null,
    requiredToolNames: ['jisuan_shijian'],
    agiMode: true
  };
  const result = await codexChat.runTurn(args);
  console.log('【最终答复】' + result.content);
  console.log('【工具调用次数】' + toolCalls);
  if (toolCalls < 1) throw new Error('对话结束但没有真正调用工具，桥接未打通');
  console.log('【自测结论】通过');
}

main().catch(function onError(error) {
  console.log('【自测结论】失败：' + (error && error.message ? error.message : String(error)));
  process.exitCode = 1;
});
