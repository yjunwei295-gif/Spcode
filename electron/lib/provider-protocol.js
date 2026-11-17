/**
 * SDK 占位地址决定直通通道：旧配置可能把协议误存为 openai，不能把 codex:// 等交给 HTTP。
 * 仅识别已支持的专用 scheme；真实 HTTP 厂商仍按显式协议解析，不按模型名猜测。
 */
function normalizeProtocol(raw, baseUrl) {
  const scheme = /^\s*(cursor|codex|claudecode|grok|grokcli):\/\//i.exec(String(baseUrl || ''));
  const p = String(scheme ? scheme[1] : (raw || 'openai')).toLowerCase().trim();
  if (p === 'claude' || p === 'anthropic') return 'anthropic';
  if (p === 'google' || p === 'gemini') return 'gemini';
  if (['cursor', 'codex', 'claudecode'].includes(p)) return p;
  if (p === 'grok' || p === 'grokcli') return 'grok';
  return 'openai';
}

module.exports = { normalizeProtocol };
