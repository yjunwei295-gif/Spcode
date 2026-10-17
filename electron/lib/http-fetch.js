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

// 直连探测超时（毫秒）：外网被墙时直连会一直挂起，这里给一个短超时，超时就回退到代理
const DIRECT_PROBE_TIMEOUT_MS = 10000;

let directSessionPromise = null;
function ensureDirectSession() {
  if (directSessionPromise) return directSessionPromise;
  directSessionPromise = (async () => {
    const { session } = require('electron');
    const ses = session.fromPartition('spcode-direct');
    // 直连会话：不走任何代理，专门给「先直连、失败再回退代理」做首次探测
    await ses.setProxy({ mode: 'direct' });
    return ses;
  })();
  return directSessionPromise;
}

// 直连优先：先不走代理直接请求，网络层走不通（连不上/被墙/探测超时）再回退到带代理的默认会话
async function httpFetch(url, init) {
  const net = resolveElectronNet();
  if (!net) return fetch(url, init);
  const direct = await ensureDirectSession();
  const originalSignal = init && init.signal;
  // 调用方已主动取消：直接走默认会话（带代理），不再探测
  if (originalSignal && originalSignal.aborted) return net.fetch(url, init);
  const probe = new AbortController();
  const probeTimer = setTimeout(() => probe.abort(), DIRECT_PROBE_TIMEOUT_MS);
  const onOuterAbort = () => probe.abort();
  if (originalSignal) originalSignal.addEventListener('abort', onOuterAbort, { once: true });
  try {
    // 第一次先直连：国内厂商可直连，秒通，不碰代理
    const res = await direct.fetch(url, { ...(init || {}), signal: probe.signal });
    return res;
  } catch (err) {
    // 直连走不通：调用方主动取消就直接抛，否则回退到带代理的默认会话重试
    if (originalSignal && originalSignal.aborted) throw err;
    return net.fetch(url, init);
  } finally {
    clearTimeout(probeTimer);
    if (originalSignal) originalSignal.removeEventListener('abort', onOuterAbort);
  }
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
