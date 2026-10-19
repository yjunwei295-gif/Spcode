// 摘要缓存只复用完全相同的输入；文件时间戳不参与身份判断。
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const VERSION = 1;
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');

function dependencyHash(map, node) {
  const byId = new Map((map.nodes || []).map((n) => [n.id, n]));
  const links = new Map();
  for (const n of map.nodes || []) links.set(n.id, new Set(n.deps || []));
  for (const edge of map.edges || []) {
    if (!links.has(edge.from)) links.set(edge.from, new Set());
    links.get(edge.from).add(edge.to);
  }
  const seen = new Set([node.id]), todo = [...(links.get(node.id) || [])], parts = [];
  while (todo.length) {
    const id = todo.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const dep = byId.get(id);
    // 无法读取依赖时不生成可复用的缓存，避免把未知状态当成内容一致。
    if (!dep || !dep.abs) throw new Error('地图依赖不可读取：' + id);
    parts.push([id, hash(fs.readFileSync(dep.abs))]);
    todo.push(...(links.get(id) || []));
  }
  return hash(JSON.stringify(parts.sort(([a], [b]) => a.localeCompare(b))));
}

function inputKey(node, text, deps, cfg) {
  return hash(JSON.stringify({
    version: VERSION, path: node.path, ext: node.ext, source: hash(text), deps,
    symbols: node.symbols,
    model: [cfg.type, cfg.protocol, cfg.baseUrl, cfg.model, cfg.modelPath, cfg.id]
  }));
}

function open(directory, id, key) {
  const file = path.join(directory, hash(id) + '.json');
  let data;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次生成 */ }
  if (!data || data.key !== key || data.version !== VERSION || !data.batches || typeof data.batches !== 'object' || Array.isArray(data.batches)) data = { version: VERSION, key, batches: {} };
  return {
    get(names) { return data.batches[hash(JSON.stringify(names))]; },
    put(names, methods) {
      data.batches[hash(JSON.stringify(names))] = methods;
      fs.mkdirSync(directory, { recursive: true });
      // 每个文件只保留当前版本；中断后可复用已经完成的批次。
      const temp = file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(data), 'utf8');
      fs.renameSync(temp, file);
    }
  };
}

module.exports = { hash, dependencyHash, inputKey, open };
