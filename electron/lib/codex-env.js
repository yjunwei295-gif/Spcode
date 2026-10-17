// Codex SDK 会另起 CLI 子进程，Electron session.setProxy 不会自动传给它。
const store = require('./store');

function codexEnv() {
  const env = { ...process.env };
  let proxy = String(
    store.load()?.proxy
      || process.env.HTTPS_PROXY
      || process.env.https_proxy
      || process.env.HTTP_PROXY
      || process.env.http_proxy
      || process.env.ALL_PROXY
      || process.env.all_proxy
      || ''
  ).trim();
  if (!proxy) return env;

  try {
    const url = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    proxy = `${url.protocol}//${url.host}`;
  } catch { /* 保留用户配置，Codex CLI 会给出具体连接错误 */ }

  // reqwest/curl 对大小写变量的读取因平台而异，大小写形式都写入。
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
    env[key] = proxy;
  }
  return env;
}

module.exports = codexEnv;
