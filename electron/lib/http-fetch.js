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

// 判断错误是否由代理不可用导致（代理服务器连不上、代理拒绝连接、代理返回错误）
function isProxyFailure(err) {
  if (!err) return false;
  const msg = String(err.message || err.code || err);
  return /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_AUTH_UNSUPPORTED|proxy/i.test(msg);
}

// 判断是否为 ReadableStream 被锁定的原生错误
function isStreamLockedError(err) {
  if (!err) return false;
  const msg = String(err.message || err.code || err);
  return /ReadableStream is locked|stream is locked|body has already been consumed|body stream already read/i.test(msg);
}

/**
 * 对响应体已锁定及 fetch 抛出的原生锁定异常执行有界重试。
 * fetcher 接收 url/init；返回可交给调用方消费的响应，耗尽 retries 后抛出 stream_locked。
 * 已锁定的流由原 reader 持有，不能通过 body.cancel() 释放；取消及其他错误直接向上传递。
 */
async function fetchWithLockedGuard(fetcher, url, init, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    let res;
    try {
      res = await fetcher(url, init);
    } catch (err) {
      if (init?.signal?.aborted || !isStreamLockedError(err)) throw err;
      continue;
    }
    if (!res.body || !res.body.locked) return res;
  }
  throw Object.assign(new Error('响应流已被锁定'), { code: 'stream_locked', retryable: true });
}

// 直连优先：先不走代理直接请求，网络层走不通（连不上/被墙/探测超时）再回退到带代理的默认会话。
// 若系统代理本身不可用，默认会话同样会失败，此时再回退一次直连，避免因为代理配置错误就完全不可用。
async function httpFetch(url, init) {
  const net = resolveElectronNet();
  if (!net) return fetchWithLockedGuard(fetch, url, init);
  const direct = await ensureDirectSession();
  const originalSignal = init && init.signal;
  // 调用方已主动取消：直接走默认会话（带代理），不再探测
  if (originalSignal && originalSignal.aborted) return fetchWithLockedGuard(net.fetch.bind(net), url, init);
  const probe = new AbortController();
  const probeTimer = setTimeout(() => probe.abort(), DIRECT_PROBE_TIMEOUT_MS);
  // 探测超时只管响应头；组合信号让调用方的取消在后续流读取期间继续有效。
  const requestSignal = originalSignal ? AbortSignal.any([originalSignal, probe.signal]) : probe.signal;
  try {
    // 第一次先直连：国内厂商可直连，秒通，不碰代理
    const res = await fetchWithLockedGuard(direct.fetch.bind(direct), url, { ...(init || {}), signal: requestSignal });
    return res;
  } catch (err) {
    // 调用方主动取消就直接抛，否则回退到带代理的默认会话重试
    if (originalSignal && originalSignal.aborted) throw err;
    try {
      return await fetchWithLockedGuard(net.fetch.bind(net), url, init);
    } catch (proxyErr) {
      // 代理不可用（ERR_PROXY_CONNECTION_FAILED 等）：再回退一次直连，当作最终保底
      if (isProxyFailure(proxyErr)) {
        return fetchWithLockedGuard(direct.fetch.bind(direct), url, init);
      }
      throw proxyErr;
    }
  } finally {
    clearTimeout(probeTimer);
    // 不拆除调用方的取消传播：响应体尚未读完，仍需响应停止和超时。
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
