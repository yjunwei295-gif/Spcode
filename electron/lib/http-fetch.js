/**
 * 统一 HTTP：优先 Electron net.fetch（走 Chromium 网络栈 / 系统代理）
 */
function resolveElectronNet() {
  try {
    // eslint-disable-next-line global-require
    const { net } = require('electron');
    if (net && typeof net.fetch === 'function') return net;
  } catch {
    /* 非 Electron 环境 */
  }
  return null;
}

function httpFetch(url, init) {
  const net = resolveElectronNet();
  if (net) return net.fetch(url, init);
  return fetch(url, init);
}

/**
 * 从环境变量或显式 proxy 字符串解析并写入 Electron session
 * 例：HTTPS_PROXY=http://127.0.0.1:19828
 */
async function applyProxy(session, explicitProxy) {
  if (!session?.setProxy) return { applied: false, proxy: '' };
  const raw = String(explicitProxy || '').trim()
    || process.env.HTTPS_PROXY
    || process.env.https_proxy
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || process.env.ALL_PROXY
    || process.env.all_proxy
    || '';
  const proxy = String(raw).trim();
  if (!proxy) return { applied: false, proxy: '' };
  let rules = proxy;
  try {
    const u = new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
    rules = `${u.protocol}//${u.host}`;
  } catch {
    rules = proxy;
  }
  await session.setProxy({ proxyRules: rules, proxyBypassRules: '<local>' });
  return { applied: true, proxy: rules };
}

async function applyEnvProxy(session) {
  return applyProxy(session);
}

module.exports = { httpFetch, applyEnvProxy, applyProxy, resolveElectronNet };
