/**
 * 部分模型（尤其 GLM）不走 OpenAI native tool_calls，
 * 把工具调用写进正文 XML。格式很多种，漏解析就会把 XML 当作成品回复然后停住。
 */

const TOOL_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,64}$/;

function looksLikeXmlTool(text) {
  const s = String(text || '');
  return /<tool_calls?:[\w-]+>|<tool_call>|<arg_key[:\s>]|<arg_value[:\s>]|<function=|<invoke[\s>]/i.test(s);
}

function stripXmlTools(text) {
  let s = String(text || '');
  s = s.replace(/<tool_calls?:[\w-]+>[\s\S]*$/i, '');
  s = s.replace(/<tool_call>[\s\S]*$/i, '');
  s = s.replace(/<function=\w+>[\s\S]*$/i, '');
  s = s.replace(/<invoke[\s>][\s\S]*$/i, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function cleanArgValue(v) {
  let s = String(v || '').trim();
  s = s.replace(/<\/?(?:tool_calls?|arg_key|arg_value|parameter|function)(?::[\w-]+)?\/?>/gi, '').trim();
  const wrapped = s.match(/^<([^<>]+)>$/);
  if (wrapped && (/^[A-Za-z]:[\\/]/.test(wrapped[1]) || wrapped[1].startsWith('/') || wrapped[1].includes('\\') || wrapped[1].includes('/'))) {
    return wrapped[1].trim();
  }
  return s;
}

function nativeHasName(native) {
  return (native || []).some((tc) => tc && tc.function && tc.function.name);
}

function parseHashedBody(id, body) {
  let s = String(body || '').trim();
  if (!s) return null;
  s = s.replace(new RegExp(`^<tool_sep:${id}>\\s*`), '');
  const nameMatch = s.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  s = s.slice(nameMatch[0].length);
  s = s.replace(new RegExp(`^\\s*<tool_sep:${id}>`), '').trim();
  const args = {};

  const closedArg = new RegExp(
    `<arg_key:${id}>([\\s\\S]*?)</arg_key:${id}>\\s*<arg_value:${id}>([\\s\\S]*?)</arg_value:${id}>`,
    'g'
  );
  let a;
  while ((a = closedArg.exec(s))) {
    const key = String(a[1] || '').trim();
    if (key) args[key] = cleanArgValue(a[2]);
  }
  if (!Object.keys(args).length) {
    const openArg = new RegExp(
      `<arg_key:${id}>\\s*([^<\\n]+)\\s*(?:</arg_key:${id}>)?\\s*<arg_value:${id}>\\s*([\\s\\S]*?)(?:</arg_value:${id}>|(?=<arg_key:${id}>)|$)`,
      'g'
    );
    while ((a = openArg.exec(s))) {
      const key = String(a[1] || '').trim();
      if (key) args[key] = cleanArgValue(a[2]);
    }
  }
  if (!Object.keys(args).length) {
    const pairRe = new RegExp(
      `<tool_call:${id}>\\s*([a-zA-Z_][a-zA-Z0-9_]*)\\s*([\\s\\S]*?)(?=<tool_call:${id}>|</tool_call|$)`,
      'g'
    );
    while ((a = pairRe.exec(s))) {
      const key = String(a[1] || '').trim();
      if (key && key !== name) args[key] = cleanArgValue(a[2]);
    }
  }
  if (!Object.keys(args).length) {
    const leftover = cleanArgValue(s.replace(new RegExp(`</?tool_calls?:${id}>`, 'g'), ''));
    if (leftover) args.path = leftover;
  }
  return { name, args };
}

function glmCalls(text) {
  const s = String(text || '');
  const out = [];
  const seen = new Set();

  const take = (id, body) => {
    const parsed = parseHashedBody(id, body);
    if (!parsed || !TOOL_NAME.test(parsed.name)) return;
    const key = `${id}:${parsed.name}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...parsed, id: `xml_${id}_${out.length}` });
  };

  const closedRe = /<tool_call:([\w-]+)>([\s\S]*?)<\/tool_call:\1>/g;
  let m;
  while ((m = closedRe.exec(s))) take(m[1], m[2]);

  const openRe = /<tool_call:([\w-]+)>/g;
  while ((m = openRe.exec(s))) {
    if (seen.has(m[1]) || [...seen].some((k) => k.startsWith(`${m[1]}:`))) continue;
    take(m[1], s.slice(m.index + m[0].length));
  }

  const classicRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  while ((m = classicRe.exec(s))) {
    const body = m[1] || '';
    if (/<function=|^\s*\{/.test(body)) continue;
    const nameMatch = body.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)/);
    if (!nameMatch) continue;
    const name = nameMatch[1];
    const args = {};
    const argRe = /<arg_key>\s*([^<]+?)\s*<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
    let a;
    while ((a = argRe.exec(body))) args[String(a[1]).trim()] = cleanArgValue(a[2]);
    if (!Object.keys(args).length) {
      const loose = /<arg_key>\s*([^<\n]+)\s*(?:<\/arg_key>)?\s*<arg_value>\s*([\s\S]*?)(?:<\/arg_value>|$)/g;
      while ((a = loose.exec(body))) args[String(a[1]).trim()] = cleanArgValue(a[2]);
    }
    out.push({ name, args, id: `xml_glm_${out.length}` });
  }
  return out;
}

function qwenCalls(text) {
  const s = String(text || '');
  const out = [];
  const blockRe = /<tool_call>([\s\S]*?)<\/tool_call>/gi;
  let m;
  while ((m = blockRe.exec(s))) {
    const body = m[1] || '';
    const fn = body.match(/<function=([a-zA-Z0-9_]+)>/);
    const json = body.match(/\{[\s\S]*\}/);
    if (!fn && !json) continue;
    const name = fn ? fn[1] : String(body.match(/^\s*([a-zA-Z0-9_]+)/)?.[1] || '').trim();
    if (!name) continue;
    const args = {};
    const paramRe = /<parameter=([^>]+)>([\s\S]*?)<\/parameter>/g;
    let p;
    while ((p = paramRe.exec(body))) args[p[1].trim()] = cleanArgValue(p[2]);
    if (!Object.keys(args).length && json) {
      try { Object.assign(args, JSON.parse(json[0])); } catch { /* ignore */ }
    }
    out.push({ name, args, id: `xml_qwen_${out.length}` });
  }
  return out;
}

function hermesCalls(text) {
  const s = String(text || '');
  const out = [];
  const re = /<tool_call>\s*(\{[\s\S]*?\})\s*<\/tool_call>/gi;
  let m;
  while ((m = re.exec(s))) {
    try {
      const obj = JSON.parse(m[1]);
      const name = obj.name || obj.function || '';
      if (!name) continue;
      const args = obj.arguments || obj.parameters || obj.params || {};
      out.push({ name, args: typeof args === 'string' ? JSON.parse(args) : args, id: `xml_hermes_${out.length}` });
    } catch { /* ignore */ }
  }
  return out;
}

function invokeCalls(text) {
  const s = String(text || '');
  const out = [];
  const re = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/gi;
  let m;
  while ((m = re.exec(s))) {
    const name = m[1];
    const args = {};
    const paramRe = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let p;
    while ((p = paramRe.exec(m[2] || ''))) args[p[1]] = cleanArgValue(p[2]);
    out.push({ name, args, id: `xml_invoke_${out.length}` });
  }
  return out;
}

function extractJsonObject(s) {
  const raw = String(s || '');
  const start = raw.search(/\{/);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const slice = raw.slice(start, i + 1);
        try { return JSON.parse(slice); } catch { return repairJsonArgs(slice); }
      }
    }
  }
  return null;
}

function jsonBlobCalls(text) {
  const s = String(text || '');
  const out = [];
  const startRe = /\{\s*"(?:name|tool|function)"\s*:\s*"(list_dir|read_file|write_file|edit_file|create_dir|mkdir|delete_file|search_text|semantic_search|map_lookup|goto_definition|run_command|generate_media|ask_user|memory_add|memory_list|memory_forget|working_memory_update|call_worker|screen_read|screen_look|clipboard_look|window_list|window_focus|ui_act|agi_note|mouse_move|mouse_click|mouse_drag|mouse_scroll|keyboard_type|keyboard_key)"/g;
  let m;
  while ((m = startRe.exec(s))) {
    const obj = extractJsonObject(s.slice(m.index));
    if (!obj) continue;
    const name = obj.name || obj.tool || obj.function;
    if (!name) continue;
    let args = obj.arguments || obj.parameters || obj.params || obj.args || {};
    if (typeof args === 'string') args = repairJsonArgs(args);
    if (obj.path && !args.path) args.path = obj.path;
    if (obj.query && !args.query) args.query = obj.query;
    out.push({ name, args, id: `xml_json_${out.length}` });
  }
  return out;
}

function repairJsonArgs(raw) {
  const s = String(raw || '').trim();
  if (!s) return {};
  try { return JSON.parse(s); } catch { /* continue */ }
  let t = s;
  if ((t.match(/"/g) || []).length % 2) t += '"';
  const openArr = (t.match(/\[/g) || []).length - (t.match(/]/g) || []).length;
  const openObj = (t.match(/{/g) || []).length - (t.match(/}/g) || []).length;
  t += ']'.repeat(Math.max(0, openArr));
  t += '}'.repeat(Math.max(0, openObj));
  try { return JSON.parse(t); } catch { return {}; }
}

function looksLikeUnfinishedToolTurn(text) {
  const s = String(text || '').trim();
  if (!s || s.length > 4000) return false;
  if (looksLikeXmlTool(s)) return true;
  if (/"name"\s*:\s*"(list_dir|read_file|search_text|semantic_search|map_lookup|write_file|edit_file|create_dir|mkdir|run_command|generate_media|call_worker|screen_read|screen_look|clipboard_look|window_focus|ui_act|mouse_click|mouse_drag|keyboard_type)"/.test(s)) return true;
  if (/(已完成|结果如下|如下所示|转换完成|已写入|一共有)/.test(s) && s.length > 80) return false;
  return /(调用|使用|准备|接下来|先).{0,24}(list_dir|read_file|search_text|semantic_search|map_lookup|write_file|edit_file|create_dir|mkdir|run_command|工具)|<(tool_call|tool_calls)|先(来)?(看|读|列|搜|打开|建).{0,24}(目录|文件夹|文件|pdf|json)|我(来|先|会).{0,16}(读取|查看|列出|搜索|创建).{0,20}(目录|文件夹|文件|pdf)/i.test(s);
}

function toOpenAI(calls) {
  return (calls || []).filter((c) => c && c.name).map((c, i) => ({
    id: c.id || `xml_call_${i}`,
    type: 'function',
    function: {
      name: c.name,
      arguments: JSON.stringify(c.args && typeof c.args === 'object' ? c.args : {})
    }
  }));
}

function parseXmlToolCalls(text) {
  const s = String(text || '');
  if (!s) return [];
  const merged = [...glmCalls(s), ...qwenCalls(s), ...hermesCalls(s), ...invokeCalls(s), ...jsonBlobCalls(s)];
  const seen = new Set();
  return toOpenAI(merged.filter((c) => {
    const k = `${c.name}:${JSON.stringify(c.args)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }));
}

function hydrateAssistantTools(msg) {
  if (!msg || msg.role !== 'assistant') return msg;
  const native = Array.isArray(msg.tool_calls) ? msg.tool_calls.filter((tc) => tc?.function?.name) : [];
  const xml = [
    ...parseXmlToolCalls(msg.content),
    ...parseXmlToolCalls(msg.reasoning_content)
  ];
  const seen = new Set();
  const mergedXml = xml.filter((tc) => {
    const k = `${tc.function?.name}:${tc.function?.arguments}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  if (mergedXml.length) {
    if (!nativeHasName(native)) msg.tool_calls = mergedXml;
    const cleaned = stripXmlTools(msg.content);
    msg.content = cleaned || null;
  } else if (native.length) {
    msg.tool_calls = native;
  }
  return msg;
}

module.exports = {
  looksLikeXmlTool,
  looksLikeUnfinishedToolTurn,
  stripXmlTools,
  parseXmlToolCalls,
  hydrateAssistantTools,
  repairJsonArgs
};
