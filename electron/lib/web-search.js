const { net } = require('electron');
const diag = require('./diag');

const FETCH_MS = 12000;
const PAGE_MS = 8000;
const MAX_RESULTS = 6;
const MAX_PAGES = 3;

function withTimeout(ms) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

function normalizeSites(list) {
  const raw = Array.isArray(list) ? list : String(list || '').split(/\r?\n/);
  const out = [];
  for (const line of raw) {
    let s = String(line || '').trim();
    if (!s || s.startsWith('#')) continue;
    s = s.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/^www\./i, '').toLowerCase();
    if (/^[a-z0-9.-]+$/.test(s) && s.includes('.')) out.push(s);
  }
  return [...new Set(out)].slice(0, 20);
}

function stripTags(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function queryFromText(userText) {
  let t = String(userText || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/(?:请)?(?:用|改用|换成)\s*(?:中文|英文|英语|日语|韩语)\s*(?:来)?(?:回答|回复)?/g, ' ');
  t = t.replace(/(?:please )?(?:reply|respond|answer)\s+in\s+\w+/gi, ' ');
  t = t.replace(/^(请|帮我|麻烦|帮忙)\s*/g, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t.slice(0, 160);
}

/**
 * 本地改代码/看附件不搜网；时事、文档、明确要查、事实问答才搜。
 */
function needsWebSearch(userText, { contextChars, hasImages } = {}) {
  const t = String(userText || '').trim();
  if (t.length < 2) return false;
  if (/https?:\/\//i.test(t)) return true;
  if (/(搜索|搜一下|上网查|网上查|查一下网上|联网搜|google|bing)/i.test(t)) return true;
  if (/(最新|今天|今日|实时|新闻|天气|股价|汇率|油价|比分|赛况)/.test(t)) return true;
  if (/(官网|官方文档|api\s*文档|changelog|release notes|cve-\d)/i.test(t)) return true;
  const localJob = /(帮我(改|写|修)|改(一下|这个|成)|重构|实现|这段代码|这个文件|工作目录|当前项目)/.test(t);
  if (localJob && ((contextChars || 0) > 80 || hasImages)) return false;
  // 本地代码/项目任务：没有明确查网意图时直接跳过，避免日常词误触发搜索
  const codeJob = /(代码|函数|脚本|模块|项目|文件|编译|构建|报错|bug|重构|接口|数据库)/i.test(t);
  const netAsk = /(搜索|搜一下|上网查|网上查|查一下网上|联网搜|google|bing|官网|官方文档|changelog|release notes|cve-\d|最新|新闻|天气|股价|汇率|油价|比分|赛况|什么是|如何安装|如何配置|下载地址|哪个版本|https?:\/\/)/i.test(t);
  if (codeJob && !netAsk) return false;
  if (/\.(js|ts|tsx|jsx|py|go|java|cs|vue)\b/.test(t) && !/(官网|文档|下载|安装)/.test(t)) return false;
  if (/(什么是|怎么安装|如何安装|如何配置|下载地址|哪个版本)/.test(t)) return true;
  if (/\b(what is|how to install|latest version|official docs)\b/i.test(t)) return true;
  return false;
}

async function fetchHtml(url, ms) {
  const t = withTimeout(ms || FETCH_MS);
  try {
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml'
      },
      signal: t.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    t.done();
  }
}

function unwrapHref(href) {
  const raw = String(href || '').trim();
  if (!raw) return '';
  try {
    const u = new URL(raw, 'https://duckduckgo.com');
    const uddg = u.searchParams.get('uddg') || u.searchParams.get('u');
    if (uddg) return decodeURIComponent(uddg);
    if (/^https?:/i.test(raw)) return raw;
  } catch {
    /* 非法链接丢掉 */
  }
  return raw.startsWith('http') ? raw : '';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return '';
  }
}

function parseBing(html) {
  const out = [];
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    const url = unwrapHref(m[1]);
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3] || '');
    if (url && title) out.push({ url, title, snippet, source: 'bing' });
  }
  return out;
}

function parseDdg(html) {
  const out = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)> )?/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 10) {
    const url = unwrapHref(m[1]);
    const title = stripTags(m[2]);
    const snippet = stripTags(m[3] || '');
    if (url && title && !/duckduckgo\.com/i.test(url)) out.push({ url, title, snippet, source: 'ddg' });
  }
  return out;
}

async function searchOnce(q) {
  const encoded = encodeURIComponent(q);
  const tries = [
    { url: `https://www.bing.com/search?q=${encoded}`, parse: parseBing },
    { url: `https://html.duckduckgo.com/html/?q=${encoded}`, parse: parseDdg }
  ];
  let lastErr = null;
  for (const one of tries) {
    try {
      const html = await fetchHtml(one.url, FETCH_MS);
      const rows = one.parse(html);
      if (rows.length) return rows;
    } catch (e) {
      lastErr = e;
      diag.log('web-search', '搜索源失败', { url: one.url, message: e && e.message });
    }
  }
  if (lastErr) throw lastErr;
  return [];
}

function scoreHit(hit, query, siteIndex, siteCount) {
  const q = query.toLowerCase();
  const terms = q.split(/[\s,，。?？!！]+/).filter((w) => w.length > 1);
  const blob = `${hit.title} ${hit.snippet}`.toLowerCase();
  let n = 0;
  for (const w of terms) if (blob.includes(w)) n += 12;
  if (siteIndex >= 0) n += (siteCount - siteIndex) * 40;
  hit.score = n;
  hit.siteIndex = siteIndex;
  return hit;
}

async function fillPages(hits, signal) {
  const take = hits.slice(0, MAX_PAGES);
  for (const hit of take) {
    if (signal?.aborted) break;
    try {
      const html = await fetchHtml(hit.url, PAGE_MS);
      hit.body = stripTags(html).slice(0, 1800);
    } catch {
      hit.body = '';
    }
  }
}

/**
 * 自站点优先，再普通网页搜索；整轮只应调用一次。
 */
async function search({ query, sites, signal }) {
  const q = queryFromText(query);
  if (!q) return { query: '', hits: [] };
  const preferred = normalizeSites(sites);
  const ranked = [];
  const seen = new Set();

  const push = (rows, siteIndex) => {
    for (const row of rows) {
      const key = row.url.replace(/[?#].*$/, '');
      if (seen.has(key)) continue;
      seen.add(key);
      ranked.push(scoreHit({ ...row }, q, siteIndex, preferred.length));
    }
  };

  for (let i = 0; i < preferred.length; i += 1) {
    if (signal?.aborted) break;
    const host = preferred[i];
    try {
      const rows = await searchOnce(`site:${host} ${q}`);
      push(rows.filter((r) => hostOf(r.url).endsWith(host) || hostOf(r.url).includes(host)), i);
    } catch (e) {
      diag.log('web-search', '自站点搜索失败', { host, message: e && e.message });
    }
    if (ranked.length >= MAX_RESULTS) break;
  }

  if (ranked.length < 3 && !signal?.aborted) {
    try {
      push(await searchOnce(q), -1);
    } catch (e) {
      diag.log('web-search', '网页搜索失败', { message: e && e.message });
      if (!ranked.length) throw e;
    }
  }

  ranked.sort((a, b) => (b.score || 0) - (a.score || 0));
  const hits = ranked.slice(0, MAX_RESULTS);
  await fillPages(hits, signal);
  return { query: q, hits };
}

function formatBlock(result, lang) {
  if (!result?.hits?.length) return '';
  const en = lang && lang.code === 'en';
  const lines = [en
    ? '—— Web search results (reference only, not workspace files) ——'
    : '—— 联网搜索结果（仅供参考，不是工作目录文件） ——'];
  result.hits.forEach((h, i) => {
    lines.push(`[${i + 1}] ${h.title}`);
    lines.push(h.url);
    if (h.snippet) lines.push(h.snippet);
    if (h.body) lines.push(h.body);
    lines.push('');
  });
  return lines.join('\n').trim().slice(0, 8000);
}

module.exports = {
  normalizeSites, needsWebSearch, queryFromText, search, formatBlock
};
