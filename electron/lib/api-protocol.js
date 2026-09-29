/**
 * 多协议 API：openai / anthropic / gemini
 * 对外统一返回 OpenAI 风格 assistant message（含 tool_calls）
 */

const { httpFetch } = require('./http-fetch');
const toolXml = require('./tool-xml');
const wallet = require('./wallet');

const PROTOCOLS = ['openai', 'anthropic', 'gemini'];

function normalizeProtocol(raw) {
  const p = String(raw || 'openai').toLowerCase().trim();
  if (p === 'claude' || p === 'anthropic') return 'anthropic';
  if (p === 'google' || p === 'gemini') return 'gemini';
  return 'openai';
}

function trimSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

function openaiRoot(baseUrl) {
  return trimSlash(baseUrl);
}

function anthropicRoot(baseUrl) {
  const b = trimSlash(baseUrl);
  if (/\/v1$/i.test(b)) return b;
  return `${b}/v1`;
}

function geminiRoot(baseUrl) {
  const b = trimSlash(baseUrl) || 'https://generativelanguage.googleapis.com/v1beta';
  if (/generativelanguage\.googleapis\.com/i.test(b) && !/\/v1beta$/i.test(b) && !/\/v1$/i.test(b)) {
    return `${b}/v1beta`;
  }
  return b;
}

function originOf(baseUrl) {
  try {
    const raw = String(baseUrl || '');
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    return `${u.protocol}//${u.host}`;
  } catch {
    return trimSlash(baseUrl);
  }
}

function firstFinite(...vals) {
  for (const v of vals) {
    if (v == null || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return null;
}

function fmtPriceNum(n) {
  if (!Number.isFinite(n)) return '';
  if (n >= 100) return n.toFixed(0);
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.01) return n.toFixed(3);
  return n.toPrecision(2);
}

/** 从厂商 /models 条目里抠输入/输出价。OpenRouter 的 pricing 是「每 token 美元」。 */
function extractPrice(m) {
  if (!m || typeof m !== 'object') return null;
  const p = m.pricing || m.price || m.cost || {};
  const input = firstFinite(
    p.prompt, p.input, p.input_tokens, p.inputPrice, p.promptPrice,
    m.input_price, m.prompt_price, m.inputPrice, m.promptPrice
  );
  const output = firstFinite(
    p.completion, p.output, p.output_tokens, p.outputPrice, p.completionPrice,
    m.output_price, m.completion_price, m.outputPrice, m.completionPrice
  );
  if (input == null && output == null) return null;
  const perToken = (input != null && input > 0 && input < 1e-4)
    || (output != null && output > 0 && output < 1e-4);
  const inShow = input == null ? null : (perToken ? input * 1e6 : input);
  const outShow = output == null ? null : (perToken ? output * 1e6 : output);
  const unit = perToken ? '/百万tokens' : '';
  const bits = [];
  if (inShow != null) bits.push(`输入 ${fmtPriceNum(inShow)}${unit}`);
  if (outShow != null) bits.push(`输出 ${fmtPriceNum(outShow)}${unit}`);
  return {
    input: inShow,
    output: outShow,
    perToken: !!perToken,
    text: bits.join(' · ')
  };
}

function catalogEntry(id, raw) {
  const price = extractPrice(raw);
  return {
    id,
    priceText: price ? price.text : '',
    input: price ? price.input : null,
    output: price ? price.output : null
  };
}

function attachQuota(out, used, total) {
  if (Number.isFinite(used)) out.used = used;
  if (Number.isFinite(total) && total > 0) out.total = total;
  return out;
}

function parseBalancePayload(data) {
  if (!data || typeof data !== 'object') return null;
  const d = (data.data && typeof data.data === 'object') ? data.data : data;
  const infos = data.balance_infos || d.balance_infos;
  if (Array.isArray(infos) && infos[0] && infos[0].total_balance != null) {
    const c = String(infos[0].currency || 'CNY').toUpperCase();
    const n = infos[0].total_balance;
    const sign = c === 'CNY' || c === 'RMB' ? '¥' : '$';
    return { available: true, text: `${sign}${n}`, remaining: Number(n), currency: c };
  }
  if (d.total_credits != null || d.total_usage != null) {
    const total = Number(d.total_credits || 0);
    const used = Number(d.total_usage || 0);
    const rem = total - used;
    if (Number.isFinite(rem) && Number.isFinite(used)) {
      return attachQuota(
        { available: true, text: `$${rem.toFixed(2)}`, remaining: rem, currency: 'USD' },
        used,
        total
      );
    }
  }
  if (d.limit_remaining != null && Number.isFinite(Number(d.limit_remaining))) {
    const rem = Number(d.limit_remaining);
    const used = d.usage != null ? Number(d.usage) : NaN;
    const totalFromLimit = d.limit != null ? Number(d.limit) : NaN;
    const total = Number.isFinite(totalFromLimit) && totalFromLimit > 0
      ? totalFromLimit
      : (Number.isFinite(used) ? used + rem : NaN);
    const usedOut = Number.isFinite(used) ? used : (Number.isFinite(total) ? total - rem : NaN);
    return attachQuota(
      { available: true, text: `$${rem.toFixed(2)}`, remaining: rem, currency: 'USD' },
      usedOut,
      total
    );
  }
  if (d.totalBalance != null || d.chargeBalance != null || d.balance != null) {
    const n = d.totalBalance != null ? d.totalBalance : (d.chargeBalance != null ? d.chargeBalance : d.balance);
    return { available: true, text: `¥${n}`, remaining: Number(n), currency: 'CNY' };
  }
  if (d.quota != null && Number.isFinite(Number(d.quota))) {
    const totalQ = Number(d.quota);
    const usedQ = Number(d.used_quota || 0);
    const remQ = totalQ - usedQ;
    if (totalQ > 10000) {
      return attachQuota(
        { available: true, text: `约 $${(remQ / 500000).toFixed(2)}`, remaining: remQ / 500000, currency: 'USD' },
        usedQ / 500000,
        totalQ / 500000
      );
    }
    return attachQuota(
      { available: true, text: String(remQ), remaining: remQ },
      usedQ,
      totalQ
    );
  }
  if (typeof data.balance === 'string' || typeof data.balance === 'number') {
    return { available: true, text: String(data.balance), remaining: Number(data.balance) };
  }
  return null;
}

function quotaPairScore(p) {
  if (!p || !p.available) return 0;
  if (Number.isFinite(p.used) && Number.isFinite(p.total) && p.total > 0) return 2;
  if (Number.isFinite(p.remaining)) return 1;
  return 0;
}

function balanceCandidateUrls(baseUrl) {
  const origin = originOf(baseUrl);
  const root = openaiRoot(baseUrl);
  const urls = [
    `${origin}/user/balance`,
    `${root}/user/info`,
    `${origin}/v1/user/info`,
    `${root}/credits`,
    `${root}/key`,
    `${origin}/api/user/self`,
    `${root}/dashboard/billing/credit_grants`
  ];
  return [...new Set(urls.filter(Boolean))];
}

async function fetchJsonQuiet(url, headers, ms) {
  const res = await httpFetch(url, { headers, signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

/** 余额问不到就返回 available:false，不抛错，避免挡住模型列表 */
async function fetchAccountBalance(modelCfg) {
  const protocol = normalizeProtocol(modelCfg?.protocol);
  const host = String(modelCfg?.baseUrl || '');
  if (protocol === 'anthropic' || protocol === 'gemini') {
    return { available: false };
  }
  if (/api\.openai\.com|generativelanguage\.googleapis\.com|api\.anthropic\.com/i.test(host)) {
    return { available: false };
  }
  const headers = authHeaders(protocol, modelCfg?.apiKey);
  const urls = balanceCandidateUrls(modelCfg?.baseUrl);
  const settled = await Promise.allSettled(
    urls.map((url) => fetchJsonQuiet(url, headers, 5000))
  );
  let best = { available: false };
  let bestScore = 0;
  for (const item of settled) {
    if (item.status !== 'fulfilled') continue;
    const parsed = parseBalancePayload(item.value);
    const score = quotaPairScore(parsed);
    if (score > bestScore) {
      best = parsed;
      bestScore = score;
    }
  }
  return best;
}

function asText(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((p) => p?.text || p?.content || '').join('');
  return String(value);
}

function messageText(m) {
  return asText(m?.content);
}

function openaiToolsFrom(toolsSpec) {
  return toolsSpec || null;
}

function anthropicToolsFrom(toolsSpec) {
  return (toolsSpec || []).map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      input_schema: fn.parameters || { type: 'object', properties: {} }
    };
  });
}

function geminiToolsFrom(toolsSpec) {
  const decls = (toolsSpec || []).map((t) => {
    const fn = t.function || t;
    return {
      name: fn.name,
      description: fn.description || '',
      parameters: fn.parameters || { type: 'object', properties: {} }
    };
  });
  return decls.length ? [{ functionDeclarations: decls }] : null;
}

/** OpenAI 风格 messages → Anthropic */
function toAnthropicPayload(messages, { model, stream, tools, maxTokens = 8192 }) {
  let system = '';
  const out = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      system += (system ? '\n\n' : '') + messageText(m);
      continue;
    }
    if (m.role === 'tool') {
      const prev = out[out.length - 1];
      const block = {
        type: 'tool_result',
        tool_use_id: m.tool_call_id || m.id || '',
        content: messageText(m)
      };
      if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
        prev.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }
    if (m.role === 'assistant') {
      const content = [];
      const text = messageText(m);
      if (text) content.push({ type: 'text', text });
      for (const tc of m.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch { input = {}; }
        content.push({
          type: 'tool_use',
          id: tc.id || `tool_${content.length}`,
          name: tc.function?.name || '',
          input
        });
      }
      out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] });
      continue;
    }
    // user / other
    if (Array.isArray(m.content)) {
      const parts = m.content.map((p) => {
        if (typeof p === 'string') return { type: 'text', text: p };
        if (p?.type === 'text') return { type: 'text', text: p.text || '' };
        if (p?.type === 'image_url') {
          const url = p.image_url?.url || p.url || '';
          const m64 = String(url).match(/^data:([^;]+);base64,(.+)$/i);
          if (m64) {
            return {
              type: 'image',
              source: { type: 'base64', media_type: m64[1], data: m64[2] }
            };
          }
          return { type: 'text', text: '[图片]' };
        }
        return { type: 'text', text: String(p?.text || '') };
      }).filter((p) => p.text !== undefined || p.type === 'image');
      out.push({ role: 'user', content: parts.length ? parts : [{ type: 'text', text: '' }] });
    } else {
      out.push({ role: 'user', content: messageText(m) });
    }
  }
  const body = {
    model,
    max_tokens: maxTokens,
    messages: out,
    stream: !!stream
  };
  if (system) body.system = system;
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = { type: 'auto' };
  }
  return body;
}

function anthropicMessageToOpenAI(data) {
  const contentBlocks = Array.isArray(data?.content) ? data.content : [];
  let content = '';
  let reason = '';
  const toolCalls = [];
  for (const b of contentBlocks) {
    if (b.type === 'text') content += b.text || '';
    if (b.type === 'thinking') reason += b.thinking || b.text || '';
    if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.id || `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: b.name || '',
          arguments: JSON.stringify(b.input || {})
        }
      });
    }
  }
  const msg = { role: 'assistant', content: content || (toolCalls.length ? null : '') };
  if (reason) msg.reasoning_content = reason;
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const usage = wallet.parseTokenUsage(data);
  if (usage) msg.usage = usage;
  return msg;
}

/** OpenAI 风格 → Gemini contents */
function toGeminiPayload(messages, { model, tools, stream }) {
  let systemInstruction = null;
  const contents = [];
  for (const m of messages || []) {
    if (m.role === 'system') {
      const t = messageText(m);
      if (!t) continue;
      if (!systemInstruction) systemInstruction = { parts: [{ text: t }] };
      else systemInstruction.parts.push({ text: t });
      continue;
    }
    if (m.role === 'tool') {
      const part = {
        functionResponse: {
          name: m.name || m.tool_name || 'tool',
          response: { result: messageText(m) }
        }
      };
      // 尽量挂上 name：从最近 assistant tool_calls 找
      const prevAsst = [...(messages || [])].reverse().find((x) => x.role === 'assistant' && x.tool_calls?.length);
      const hit = (prevAsst?.tool_calls || []).find((tc) => tc.id === m.tool_call_id);
      if (hit?.function?.name) part.functionResponse.name = hit.function.name;
      const last = contents[contents.length - 1];
      if (last && last.role === 'user') last.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }
    if (m.role === 'assistant') {
      const parts = [];
      const text = messageText(m);
      if (text) parts.push({ text });
      for (const tc of m.tool_calls || []) {
        let args = {};
        try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { args = {}; }
        parts.push({
          functionCall: {
            name: tc.function?.name || '',
            args
          }
        });
      }
      contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '' }] });
      continue;
    }
    // user
    if (Array.isArray(m.content)) {
      const parts = m.content.map((p) => {
        if (typeof p === 'string') return { text: p };
        if (p?.type === 'text') return { text: p.text || '' };
        if (p?.type === 'image_url') {
          const url = p.image_url?.url || '';
          const m64 = String(url).match(/^data:([^;]+);base64,(.+)$/i);
          if (m64) {
            return { inlineData: { mimeType: m64[1], data: m64[2] } };
          }
          return { text: '[图片]' };
        }
        return { text: String(p?.text || '') };
      });
      contents.push({ role: 'user', parts });
    } else {
      contents.push({ role: 'user', parts: [{ text: messageText(m) }] });
    }
  }
  const body = { contents };
  if (systemInstruction) body.systemInstruction = systemInstruction;
  if (tools?.length) body.tools = tools;
  return { body, model, stream: !!stream };
}

function geminiResponseToOpenAI(data) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  let content = '';
  const toolCalls = [];
  for (const p of parts) {
    if (p.text) content += p.text;
    if (p.functionCall) {
      toolCalls.push({
        id: `call_${toolCalls.length}_${p.functionCall.name || 'fn'}`,
        type: 'function',
        function: {
          name: p.functionCall.name || '',
          arguments: JSON.stringify(p.functionCall.args || {})
        }
      });
    }
  }
  const msg = { role: 'assistant', content: content || (toolCalls.length ? null : '') };
  if (toolCalls.length) msg.tool_calls = toolCalls;
  const usage = wallet.parseTokenUsage(data);
  if (usage) msg.usage = usage;
  return msg;
}

function authHeaders(protocol, apiKey) {
  const headers = { 'Content-Type': 'application/json' };
  const key = String(apiKey || '').trim();
  if (!key) return headers;
  if (protocol === 'anthropic') {
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
  } else if (protocol === 'gemini') {
    headers['x-goog-api-key'] = key;
  } else {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

async function listModels(modelCfg) {
  const protocol = normalizeProtocol(modelCfg?.protocol);
  const baseUrl = modelCfg?.baseUrl;
  const apiKey = modelCfg?.apiKey;
  if (!baseUrl) throw new Error('请填写接口地址');
  const headers = authHeaders(protocol, apiKey);
  let url;
  if (protocol === 'anthropic') {
    url = `${anthropicRoot(baseUrl)}/models?limit=100`;
  } else if (protocol === 'gemini') {
    url = `${geminiRoot(baseUrl)}/models?pageSize=100`;
  } else {
    url = `${openaiRoot(baseUrl)}/models`;
  }
  const modelsPromise = (async () => {
    let res;
    try {
      res = await httpFetch(url, { headers, signal: AbortSignal.timeout(30000) });
    } catch {
      throw new Error('连接超时，请检查接口地址和网络是否可达');
    }
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`拉取模型失败 ${res.status}：${t.slice(0, 300)}`);
    }
    return res.json().catch(() => ({}));
  })();
  const [data, balance] = await Promise.all([
    modelsPromise,
    fetchAccountBalance(modelCfg).catch(() => ({ available: false }))
  ]);
  const rows = protocol === 'anthropic'
    ? (data.data || data.models || [])
    : protocol === 'gemini'
      ? (data.models || [])
      : (data.data || data.models || []);
  const ids = [];
  const catalog = {};
  for (const raw of rows) {
    let id = '';
    if (typeof raw === 'string') id = raw;
    else if (protocol === 'gemini') id = String(raw?.name || raw?.id || '').replace(/^models\//, '');
    else id = String(raw?.id || raw?.name || '');
    if (!id) continue;
    if (!catalog[id]) {
      ids.push(id);
      catalog[id] = catalogEntry(id, raw);
    }
  }
  return {
    ok: true,
    protocol,
    models: ids.slice(0, 1000),
    catalog,
    balance: balance && balance.available ? balance : { available: false }
  };
}

async function testConnection(modelCfg) {
  if (modelCfg?.type === 'local') throw new Error('本地模型请用本地探测');
  const listed = await listModels(modelCfg);
  if (modelCfg?.model) {
    const hit = listed.models.find((id) => id === modelCfg.model || id.endsWith(`/${modelCfg.model}`));
    if (hit) return { ok: true, models: listed.models, name: hit, catalog: listed.catalog, balance: listed.balance };
  }
  return listed;
}

function extractReason(obj) {
  return asText(obj?.reasoning_content || obj?.reasoning || obj?.thinking || '');
}

function toolCallName(tc) {
  return tc?.function?.name || tc?.name || '';
}
function toolCallArgs(tc) {
  const raw = tc?.function?.arguments ?? tc?.function?.parameters ?? tc?.arguments ?? tc?.parameters ?? '';
  return typeof raw === 'string' ? raw : JSON.stringify(raw || {});
}
function applyToolDelta(toolCalls, deltaCalls) {
  for (const tc of deltaCalls || []) {
    const idx = tc.index ?? toolCalls.length;
    if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (tc.id) toolCalls[idx].id = tc.id;
    const name = toolCallName(tc);
    if (name) toolCalls[idx].function.name += name;
    const args = toolCallArgs(tc);
    if (args && args !== '{}') toolCalls[idx].function.arguments += args;
  }
}

function consumeOpenAIChunk(json, acc, onDelta, onReason) {
  const choice = json.choices?.[0] || {};
  const delta = choice.delta || {};
  const piece = asText(delta.content);
  if (piece) {
    acc.content += piece;
    onDelta(piece);
  }
  const reason = extractReason(delta);
  if (reason) {
    acc.reason += reason;
    onReason(reason);
  }
  const streamedTools = delta.tool_calls || choice.message?.tool_calls || choice.tool_calls;
  if (streamedTools) applyToolDelta(acc.toolCalls, streamedTools);
  if (choice.finish_reason) acc.finishReason = choice.finish_reason;
  const usage = wallet.parseTokenUsage(json);
  if (usage) acc.usage = usage;
  const fullMsg = (!choice.delta && (choice.message || json.message)) || null;
  if (fullMsg) {
    const full = asText(fullMsg.content);
    if (full.length > acc.content.length) {
      const extra = full.slice(acc.content.length);
      acc.content = full;
      if (extra) onDelta(extra);
    }
    const reason = extractReason(fullMsg);
    if (reason && !acc.reason.includes(reason)) {
      acc.reason += reason;
      onReason(reason);
    }
    if (fullMsg.tool_calls && !acc.toolCalls.some((t) => t?.function?.name)) {
      applyToolDelta(acc.toolCalls, fullMsg.tool_calls);
    }
  }
}

function finishMessage(acc) {
  const msg = { role: 'assistant', content: acc.content || '' };
  if (acc.reason) msg.reasoning_content = acc.reason;
  const toolCalls = (acc.toolCalls || []).filter((t) => t && t.function && t.function.name);
  if (toolCalls.length) {
    msg.tool_calls = toolCalls;
    msg.tool_calls.forEach((t, i) => {
      if (!t.id) t.id = `call_${i}`;
      t.type = t.type || 'function';
      if (t.function?.arguments) {
        const obj = toolXml.repairJsonArgs(t.function.arguments);
        if (Object.keys(obj).length) t.function.arguments = JSON.stringify(obj);
      }
    });
    if (!msg.content) msg.content = null;
  }
  const reason = String(acc.finishReason || '').toLowerCase();
  if (reason === 'length' || reason === 'max_tokens' || reason === 'max_output_tokens') {
    msg.truncated = true;
  }
  if (acc.usage) msg.usage = acc.usage;
  return msg;
}

function emitSseLine(s, event, onEvent) {
  s = String(s || '').trim();
  if (!s) return event;
  if (s.startsWith('event:')) return s.slice(6).trim();
  if (s.startsWith('data:')) s = s.slice(5).trim();
  if (s === '[DONE]') return event;
  if (!s.startsWith('{')) return event;
  let json;
  try { json = JSON.parse(s); } catch { return event; }
  onEvent(json, event);
  return event;
}

async function readSseStream(res, { onEvent, signal, onFirst, onChunk }) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buf = '';
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('已停止'), { name: 'AbortError' });
    const { done, value } = await reader.read();
    if (done) {
      buf += decoder.decode();
      if (buf.trim()) {
        let event = '';
        for (const line of buf.split('\n')) event = emitSseLine(line, event, onEvent);
      }
      break;
    }
    onFirst?.();
    onChunk?.();
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    let event = '';
    for (const line of lines) event = emitSseLine(line, event, onEvent);
  }
}

async function completeOpenAI({ modelCfg, messages, stream, tools, toolChoice, onDelta, onReason, signal, onWait, ctl }) {
  const url = `${openaiRoot(modelCfg.baseUrl)}/chat/completions`;
  const makeBody = (withUsage, parallelTools) => {
    const body = {
      model: modelCfg.model,
      messages,
      stream: !!stream
    };
    if (tools?.length) {
      body.tools = tools;
      if (parallelTools) body.parallel_tool_calls = true;
      if (toolChoice) body.tool_choice = toolChoice;
    }
    if (stream && withUsage) body.stream_options = { include_usage: true };
    return body;
  };
  let withUsage = true;
  let parallelTools = !!(tools && tools.length);
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await httpFetch(url, {
      method: 'POST',
      headers: authHeaders('openai', modelCfg.apiKey),
      body: JSON.stringify(makeBody(withUsage, parallelTools)),
      signal: ctl.signal
    });
    if (res.ok) break;
    const t = await res.text().catch(() => '');
    if (res.status === 400) {
      const lower = String(t || '').toLowerCase();
      if (stream && withUsage && /stream_options|include_usage/.test(lower)) {
        withUsage = false;
        continue;
      }
      if (parallelTools && /parallel_tool_calls/.test(lower)) {
        parallelTools = false;
        continue;
      }
      if (toolChoice && /tool_choice/.test(lower)) {
        toolChoice = null;
        continue;
      }
      if (stream && withUsage) {
        withUsage = false;
        continue;
      }
      if (parallelTools) {
        parallelTools = false;
        continue;
      }
    }
    const err = new Error(`模型请求失败 ${res.status}：${t.slice(0, 500)}`);
    err.status = res.status;
    err.body = t;
    const ra = Number(res.headers?.get?.('retry-after'));
    if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
    throw err;
  }
  if (!stream) {
    const data = await res.json();
    const message = data.choices?.[0]?.message || { role: 'assistant', content: '' };
    const reason = extractReason(message);
    if (reason) onReason(reason);
    if (message.content) onDelta(asText(message.content));
    const usage = wallet.parseTokenUsage(data);
    if (usage) message.usage = usage;
    return message;
  }
  const acc = { content: '', reason: '', toolCalls: [] };
  let gotFirst = false;
  await readSseStream(res, {
    signal,
    onFirst: () => { gotFirst = true; },
    onChunk: () => {},
    onEvent: (json) => consumeOpenAIChunk(json, acc, onDelta, onReason)
  });
  void gotFirst;
  void onWait;
  return finishMessage(acc);
}

async function completeAnthropic({ modelCfg, messages, stream, tools, onDelta, onReason, signal, ctl }) {
  const url = `${anthropicRoot(modelCfg.baseUrl)}/messages`;
  const body = toAnthropicPayload(messages, {
    model: modelCfg.model,
    stream,
    tools: tools?.length ? anthropicToolsFrom(tools) : null
  });
  const headers = authHeaders('anthropic', modelCfg.apiKey);
  const res = await httpFetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: ctl.signal
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`模型请求失败 ${res.status}：${t.slice(0, 500)}`);
    err.status = res.status;
    err.body = t;
    const ra = Number(res.headers?.get?.('retry-after'));
    if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
    throw err;
  }
  if (!stream) {
    const data = await res.json();
    const message = anthropicMessageToOpenAI(data);
    if (message.reasoning_content) onReason(message.reasoning_content);
    if (message.content) onDelta(asText(message.content));
    return message;
  }
  const acc = { content: '', reason: '', toolCalls: [], _toolIndex: {} };
  await readSseStream(res, {
    signal,
    onEvent: (json, event) => {
      const type = json.type || event;
      const usage = wallet.parseTokenUsage(json);
      if (usage) acc.usage = usage;
      if (type === 'content_block_delta') {
        const d = json.delta || {};
        if (d.type === 'text_delta' && d.text) {
          acc.content += d.text;
          onDelta(d.text);
        }
        if (d.type === 'thinking_delta' && (d.thinking || d.text)) {
          const piece = d.thinking || d.text;
          acc.reason += piece;
          onReason(piece);
        }
        if (d.type === 'input_json_delta' && d.partial_json != null) {
          const idx = json.index ?? 0;
          if (!acc.toolCalls[idx]) acc.toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
          acc.toolCalls[idx].function.arguments += d.partial_json;
        }
      }
      if (type === 'message_delta' && (json.delta?.stop_reason || json.delta?.stopReason)) {
        acc.finishReason = json.delta.stop_reason || json.delta.stopReason;
      }
      if (type === 'content_block_start') {
        const b = json.content_block || {};
        const idx = json.index ?? 0;
        if (b.type === 'tool_use') {
          acc.toolCalls[idx] = {
            id: b.id || `call_${idx}`,
            type: 'function',
            function: { name: b.name || '', arguments: '' }
          };
        }
      }
    }
  });
  return finishMessage(acc);
}

async function completeGemini({ modelCfg, messages, stream, tools, onDelta, onReason, signal, ctl }) {
  const root = geminiRoot(modelCfg.baseUrl);
  const modelId = String(modelCfg.model || '').replace(/^models\//, '');
  const { body } = toGeminiPayload(messages, {
    model: modelId,
    tools: tools?.length ? geminiToolsFrom(tools) : null,
    stream
  });
  const headers = authHeaders('gemini', modelCfg.apiKey);
  const path = stream
    ? `${root}/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse`
    : `${root}/models/${encodeURIComponent(modelId)}:generateContent`;
  const res = await httpFetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: ctl.signal
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    const err = new Error(`模型请求失败 ${res.status}：${t.slice(0, 500)}`);
    err.status = res.status;
    err.body = t;
    const ra = Number(res.headers?.get?.('retry-after'));
    if (Number.isFinite(ra) && ra > 0) err.retryAfter = ra;
    throw err;
  }
  if (!stream) {
    const data = await res.json();
    const message = geminiResponseToOpenAI(data);
    if (message.content) onDelta(asText(message.content));
    return message;
  }
  const acc = { content: '', reason: '', toolCalls: [] };
  await readSseStream(res, {
    signal,
    onEvent: (json) => {
      const usage = wallet.parseTokenUsage(json);
      if (usage) acc.usage = usage;
      const fr = json?.candidates?.[0]?.finishReason;
      if (fr) acc.finishReason = fr;
      const parts = json?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (p.text) {
          acc.content += p.text;
          onDelta(p.text);
        }
        if (p.functionCall) {
          acc.toolCalls.push({
            id: `call_${acc.toolCalls.length}_${p.functionCall.name || 'fn'}`,
            type: 'function',
            function: {
              name: p.functionCall.name || '',
              arguments: JSON.stringify(p.functionCall.args || {})
            }
          });
        }
      }
    }
  });
  void onReason;
  return finishMessage(acc);
}

/**
 * 统一补全入口（非本地）
 */
async function complete({
  modelCfg,
  messages,
  stream = true,
  tools = null,
  toolChoice = null,
  onDelta,
  onReason,
  signal,
  onWait
}) {
  onDelta = onDelta || (() => {});
  onReason = onReason || (() => {});
  onWait = onWait || (() => {});
  const protocol = normalizeProtocol(modelCfg?.protocol);
  if (!modelCfg?.baseUrl || !modelCfg?.model) {
    throw new Error('请填写接口地址和模型 ID');
  }

  const ctl = new AbortController();
  const onAbort = () => ctl.abort();
  if (signal) {
    if (signal.aborted) ctl.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  // [铆钉优化] 模型不回话不能无限等：流式 3 分钟没有任何输出（含思考）、或中途 5 分钟没有新内容就中断，
  // 报 no_response 交给上层重试一次；非流式最长 10 分钟。以前开口前只有 2 小时兜底，卡住只能用户手动停。其他 AI 请勿调回小时级
  const FIRST_RESPONSE_MS = 3 * 60 * 1000;
  const IDLE_CHUNK_MS = 5 * 60 * 1000;
  const XML_TOOL_IDLE_MS = 5 * 60 * 1000;
  const OVERALL_MS = stream ? 2 * 60 * 60 * 1000 : 10 * 60 * 1000;
  let noResponse = '';
  const overallTimer = setTimeout(() => {
    if (!stream) noResponse = `超过 ${Math.round(OVERALL_MS / 60000)} 分钟没有返回`;
    ctl.abort();
  }, OVERALL_MS);
  const startAt = Date.now();
  let gotFirst = false;
  let idleTimer = null;
  const firstTimer = stream
    ? setTimeout(() => {
      if (gotFirst) return;
      noResponse = `超过 ${Math.round(FIRST_RESPONSE_MS / 1000)} 秒没有任何响应`;
      ctl.abort();
    }, FIRST_RESPONSE_MS)
    : null;
  let lastChunkAt = 0;
  let streamed = '';
  const heartbeat = setInterval(() => {
    const now = Date.now();
    if (!gotFirst) onWait(Math.floor((now - startAt) / 1000));
    else if (lastChunkAt && now - lastChunkAt > 60000) {
      onWait(`模型已 ${Math.floor((now - lastChunkAt) / 1000)} 秒没有新输出…`);
    }
  }, 10000);

  const wrapCtl = {
    get signal() { return ctl.signal; }
  };

  const idleMsOf = () => (toolXml.looksLikeXmlTool(streamed) ? XML_TOOL_IDLE_MS : IDLE_CHUNK_MS);

  const markActivity = () => {
    if (!gotFirst) gotFirst = true;
    lastChunkAt = Date.now();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      noResponse = `输出到一半超过 ${Math.round(idleMsOf() / 60000)} 分钟没有新内容`;
      ctl.abort();
    }, idleMsOf());
  };

  const wrappedDelta = (t) => {
    streamed += t || '';
    markActivity();
    onDelta(t);
  };
  const wrappedReason = (t) => {
    markActivity();
    onReason(t);
  };

  try {
    let msg;
    if (protocol === 'anthropic') {
      msg = await completeAnthropic({
        modelCfg, messages, stream, tools,
        onDelta: wrappedDelta, onReason: wrappedReason, signal, ctl: wrapCtl
      });
    } else if (protocol === 'gemini') {
      msg = await completeGemini({
        modelCfg, messages, stream, tools,
        onDelta: wrappedDelta, onReason: wrappedReason, signal, ctl: wrapCtl
      });
    } else {
      msg = await completeOpenAI({
        modelCfg, messages, stream, tools, toolChoice,
        onDelta: wrappedDelta, onReason: wrappedReason, signal, onWait, ctl: wrapCtl
      });
    }
    if (msg?.usage) {
      try {
        require('./store').applyUsageSpend({ modelCfg, usage: msg.usage, messages });
      } catch { /* 本地记账失败不影响对话 */ }
    }
    return msg;
  } catch (e) {
    if (noResponse && !(signal && signal.aborted)) {
      if (toolXml.parseXmlToolCalls(streamed).length) {
        return toolXml.hydrateAssistantTools({ role: 'assistant', content: streamed });
      }
      const err = new Error(`模型「${modelCfg.model}」${noResponse}，已中断。`);
      err.code = 'no_response';
      throw err;
    }
    if (e.name === 'AbortError') {
      const stopped = !!(signal && signal.aborted);
      if (!stopped && toolXml.parseXmlToolCalls(streamed).length) {
        return toolXml.hydrateAssistantTools({ role: 'assistant', content: streamed });
      }
      const err = new Error(stopped ? '已停止' : '模型响应超时，长时间没有输出。请检查模型是否卡住。');
      err.name = 'AbortError';
      err.code = stopped ? 'aborted' : 'timeout';
      throw err;
    }
    if (e.status === 404) {
      e.message = `接口没有这个模型「${modelCfg.model}」。请换一个模型 ID，或检查接口地址。`;
    }
    if (e.status === 400 && /image_url|image/i.test(e.body || e.message || '')) {
      const err2 = new Error('当前模型不支持看图，请换视觉模型，或只发文字/文档。');
      err2.status = 400;
      err2.code = 'no_vision';
      throw err2;
    }
    throw e;
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(idleTimer);
    clearTimeout(firstTimer);
    clearInterval(heartbeat);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

module.exports = {
  PROTOCOLS,
  normalizeProtocol,
  listModels,
  testConnection,
  complete,
  authHeaders,
  openaiRoot,
  anthropicRoot,
  geminiRoot,
  fetchAccountBalance,
  parseBalancePayload
};
