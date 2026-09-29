const fs = require('fs');
const path = require('path');
const store = require('./store');
const assembly = require('./assembly');
const downloader = require('./downloader');
const diag = require('./diag');

function isProjectorName(name) {
  const n = String(name || '').toLowerCase();
  if (/\.mmproj$/i.test(n)) return true;
  return /mmproj/.test(n) && /\.gguf$/i.test(n);
}

function isUsableMmproj(file, modelPath) {
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  const abs = path.resolve(file);
  if (modelPath && path.resolve(modelPath) === abs) return false;
  return isProjectorName(path.basename(abs));
}

/**
 * 在模型目录里找投影文件：不能拿主模型 gguf 自己冒充
 * @param {string} dir 模型目录
 * @param {string} modelName 例如 qwen3-vl-4b.gguf
 */
function findLocal(dir, modelName) {
  if (!dir || !fs.existsSync(dir)) return '';
  const base = String(modelName || '').replace(/\.gguf$/i, '');
  const names = fs.readdirSync(dir);
  const hits = names.filter((n) => isProjectorName(n));
  const prefer = [
    `${base}.mmproj`,
    `${base}-mmproj.gguf`,
    `${base}.mmproj.gguf`
  ].map((n) => n.toLowerCase());
  hits.sort((a, b) => {
    const ia = prefer.indexOf(a.toLowerCase());
    const ib = prefer.indexOf(b.toLowerCase());
    if (ia !== ib) return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    const sa = a.toLowerCase().includes(base.toLowerCase()) ? 0 : 1;
    const sb = b.toLowerCase().includes(base.toLowerCase()) ? 0 : 1;
    return sa - sb || a.length - b.length;
  });
  const modelPath = path.join(dir, path.basename(modelName || ''));
  for (const n of hits) {
    const abs = path.join(dir, n);
    if (isUsableMmproj(abs, modelPath)) return abs;
  }
  return '';
}

function persist(mmproj) {
  const s = store.load();
  s.visionAgentMmproj = mmproj;
  const key = assembly.assemblyKey(s);
  if (s.assemblies?.[key]) {
    const slot = (s.assemblies[key].slots || []).find((x) => x.role === 'vision');
    if (slot) slot.mmproj = mmproj;
  }
  store.save(s);
}

function L(zh, en) {
  return store.load().locale === 'en' ? en : zh;
}

function guessQuery(modelName) {
  return String(modelName || '')
    .replace(/\.gguf$/i, '')
    .replace(/[-_.]?(q[2-8]_?k(_[sml])?|q[2-8]_0|f16|fp16|iq\d).*$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim();
}

function pickProjector(files) {
  const list = (files || []).filter((f) => isProjectorName(f.name));
  if (!list.length) return null;
  const f16 = list.find((f) => /f16|fp16/i.test(f.name));
  return f16 || list.sort((a, b) => (a.size || 0) - (b.size || 0))[0];
}

function reportProgress(onStatus, p, name) {
  const pct = p.total > 0 ? Math.round((p.downloaded / p.total) * 100) : 0;
  const extra = { pct, downloaded: p.downloaded || 0, total: p.total || 0 };
  if (p.retrying) {
    onStatus?.(L(`下载中断：${p.message || ''}，准备换源`, `Download interrupted: ${p.message || ''}`), extra);
    return;
  }
  if (p.total > 0) {
    onStatus?.(L(`正在下载 ${name}  ${pct}%`, `Downloading ${name}  ${pct}%`), extra);
    return;
  }
  onStatus?.(L(`正在连接下载源…`, `Connecting to download source…`), extra);
}

/**
 * 网上找配套投影文件并下到模型目录
 * @returns {Promise<string>} 本地路径
 */
async function downloadFor(modelName, dir, onStatus) {
  const extras = [];
  if (/qwen3-vl-4b/i.test(modelName)) {
    extras.push('bartowski/Qwen3-VL-4B-Instruct-GGUF', 'ggml-org/Qwen3-VL-4B-Instruct-GGUF', 'Qwen/Qwen3-VL-4B-Instruct-GGUF');
  }
  if (/qwen2\.5-vl-7b/i.test(modelName)) extras.push('bartowski/Qwen2.5-VL-7B-Instruct-GGUF');
  if (/qwen2\.5-vl-3b/i.test(modelName)) extras.push('lmstudio-community/Qwen2.5-VL-3B-Instruct-GGUF');

  let source = await downloader.resolveSource();
  let repos = [];
  try {
    const q = `${guessQuery(modelName)} mmproj`;
    onStatus?.(L(`未找到本地投影文件，正在搜索 ${q}…`, `No local projector. Searching ${q}…`));
    const found = await downloader.searchRepos(q);
    if (found.source) source = found.source;
    repos = found.repos || [];
  } catch (e) {
    diag.log('vision', '搜索投影仓库失败，改用已知仓库', { message: e && e.message });
    onStatus?.(L('搜索接口不可用，改从已知仓库下载投影文件…', 'Search API unavailable, trying known repos…'));
  }

  const repoIds = [...extras, ...repos.map((r) => r.repo)].filter(Boolean);
  const seen = new Set();
  let lastFail = '';

  async function pull(repo, name) {
    const bases = downloader.candidateBases(source.base);
    for (const base of bases) {
      const url = downloader.fileUrl(base, repo, name);
      onStatus?.(L(`正在从 ${base} 下载 ${name}…`, `Downloading ${name} from ${base}…`));
      const result = await downloader.download({
        id: `mmproj-${Date.now()}`,
        url,
        dir,
        name,
        threads: 4,
        onProgress: (p) => reportProgress(onStatus, p, name)
      });
      if (result.ok && result.path) {
        diag.log('vision', '已自动下载投影文件', { repo, file: result.path, base });
        return result.path;
      }
      lastFail = result.message || '';
      onStatus?.(L(`这个源失败：${lastFail}`, `This source failed: ${lastFail}`));
    }
    return '';
  }

  const directNames = [];
  if (/qwen3-vl-4b/i.test(modelName)) {
    directNames.push({
      repo: 'bartowski/Qwen3-VL-4B-Instruct-GGUF',
      name: 'mmproj-Qwen3-VL-4B-Instruct-f16.gguf'
    });
  }
  for (const item of directNames) {
    const got = await pull(item.repo, item.name);
    if (got) return got;
  }

  for (const repo of repoIds) {
    if (seen.has(repo)) continue;
    seen.add(repo);
    if (seen.size > 8) break;
    let files;
    try {
      const listed = await downloader.listRepoFiles(repo);
      files = listed.files || [];
      if (listed.source) source = listed.source;
    } catch {
      continue;
    }
    const picked = pickProjector(files);
    if (!picked) continue;
    const got = await pull(repo, path.basename(picked.name));
    if (got) return got;
  }
  throw new Error(lastFail
    ? L(
      `没有下到「${modelName}」的投影文件：${lastFail}。可把 mmproj 放到模型目录，或检查网络/镜像。`,
      `Could not download projector for ${modelName}: ${lastFail}. Put mmproj in the models folder, or check network/mirror.`
    )
    : L(
      `没有找到「${modelName}」配套的投影文件（mmproj）。请把 mmproj 放到模型目录后再试。`,
      `No projector (mmproj) found for ${modelName}. Put it in the models folder and retry.`
    ));
}

/**
 * 保证有一份能用的投影文件：校验 → 本地搜 → 网上下载 → 写回配置
 * @returns {Promise<string>}
 */
async function ensure(modelPath, mmproj, onStatus) {
  const dir = path.dirname(modelPath);
  const modelName = path.basename(modelPath);
  if (isUsableMmproj(mmproj, modelPath)) return path.resolve(mmproj);
  const local = findLocal(dir, modelName);
  if (local) {
    persist(local);
    onStatus?.(L(`已自动选用投影文件 ${path.basename(local)}`, `Using projector ${path.basename(local)}`));
    return local;
  }
  const downloaded = await downloadFor(modelName, dir, onStatus);
  persist(downloaded);
  return downloaded;
}

module.exports = { isProjectorName, isUsableMmproj, findLocal, ensure, persist };
