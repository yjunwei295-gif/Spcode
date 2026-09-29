const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const store = require('./store');
const downloader = require('./downloader');

const GB = 1024 * 1024 * 1024;

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : String(stdout || ''));
    });
  });
}

/** 显存优先问 nvidia-smi（最准），拿不到再退到系统的显卡信息 */
async function detectGpu() {
  // [铆钉优化] 显卡被占满时 nvidia-smi 可能要好几秒，6 秒超时会误判成没独显、生图掉到 CPU 跑 20 分钟超时。其他 AI 请勿改回短超时
  const smi = await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'], 20000);
  const line = smi.split(/\r?\n/).find((l) => l.trim());
  if (line) {
    const [name, mb] = line.split(',').map((s) => s.trim());
    const vramGB = Number(mb) / 1024;
    if (name && Number.isFinite(vramGB) && vramGB > 0) {
      return { name, vramGB: Math.round(vramGB * 10) / 10, source: 'nvidia-smi' };
    }
  }
  if (process.platform !== 'win32') return { name: '', vramGB: 0, source: '未知' };

  // Win32_VideoController 的 AdapterRAM 超过 4GB 会溢出，所以先读注册表里的 qwMemorySize
  // [铆钉优化] 第一块显卡常是远程桌面/串流的虚拟显卡（Oray、GameViewer 等），要跳过虚拟卡取真显卡。其他 AI 请勿改回 Select-Object -First 1
  const ps = await run('powershell', ['-NoProfile', '-Command',
    "$virt='Idd|Virtual|GameViewer|Oray|Parsec|Remote|Basic Display|Basic Render|Mirror|Citrix|VMware|Hyper-V';"
    + "$c=Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch $virt } | Select-Object -First 1 -ExpandProperty Name;"
    + "$k=Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' -ErrorAction SilentlyContinue |"
    + " Where-Object { $_.'HardwareInformation.qwMemorySize' -and $_.DriverDesc -notmatch $virt } | Sort-Object { [int64]$_.'HardwareInformation.qwMemorySize' } -Descending | Select-Object -First 1 -ExpandProperty 'HardwareInformation.qwMemorySize';"
    + "\"$c|$k\""
  ], 15000);
  const [name = '', qw = ''] = ps.trim().split('|');
  const vramGB = Number(qw) > 0 ? Math.round((Number(qw) / GB) * 10) / 10 : 0;
  return { name: name.trim(), vramGB, source: vramGB ? '系统注册表' : '系统信息' };
}

function diskFreeGB(dir) {
  try {
    const st = fs.statfsSync(dir);
    return Math.round((st.bsize * st.bavail / GB) * 10) / 10;
  } catch {
    return 0;
  }
}

/**
 * 采集本机配置
 * @param {string} modelsDir 模型目录，用来算所在盘剩余空间
 */
async function detect(modelsDir) {
  const cpus = os.cpus() || [];
  const gpu = await detectGpu();
  return {
    cpu: { name: (cpus[0]?.model || '未知 CPU').trim(), cores: cpus.length },
    memTotalGB: Math.round((os.totalmem() / GB) * 10) / 10,
    memFreeGB: Math.round((os.freemem() / GB) * 10) / 10,
    gpu,
    diskFreeGB: diskFreeGB(modelsDir || os.homedir()),
    modelsDir: modelsDir || ''
  };
}

// 候选模型清单。体积是 Q4_K_M 的大致值，真实体积在打开仓库时会用接口返回的数据覆盖
const CATALOG = [
  { id: 'coder-1.5b', name: 'Qwen2.5-Coder 1.5B', repo: 'bartowski/Qwen2.5-Coder-1.5B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 1.1, purposes: ['code'], desc: '最小的代码模型，低配也能跑，适合补全和小改动' },
  { id: 'coder-7b', name: 'Qwen2.5-Coder 7B', repo: 'bartowski/Qwen2.5-Coder-7B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 4.7, purposes: ['code'], desc: '写代码的主力档，质量和资源占用比较平衡' },
  { id: 'coder-14b', name: 'Qwen2.5-Coder 14B', repo: 'bartowski/Qwen2.5-Coder-14B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 9.0, purposes: ['code'], desc: '代码能力更强，需要较大内存或显存' },
  { id: 'coder-32b', name: 'Qwen2.5-Coder 32B', repo: 'bartowski/Qwen2.5-Coder-32B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 19.9, purposes: ['code'], desc: '本地代码模型的高配档，对硬件要求高' },
  { id: 'chat-1.5b', name: 'Qwen2.5 1.5B', repo: 'bartowski/Qwen2.5-1.5B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 1.1, purposes: ['chat'], desc: '轻量对话模型，速度快，适合低配机器' },
  { id: 'chat-3b', name: 'Qwen2.5 3B', repo: 'bartowski/Qwen2.5-3B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 2.0, purposes: ['chat'], desc: '日常问答和短文写作够用' },
  { id: 'chat-7b', name: 'Qwen2.5 7B', repo: 'bartowski/Qwen2.5-7B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 4.7, purposes: ['chat', 'docGen'], desc: '通用对话和写作的主力档' },
  { id: 'chat-14b', name: 'Qwen2.5 14B', repo: 'bartowski/Qwen2.5-14B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 9.0, purposes: ['chat', 'docGen'], desc: '长文和复杂推理更稳，需要较大内存' },
  { id: 'vision-3b', name: 'Qwen2.5-VL 3B', repo: 'lmstudio-community/Qwen2.5-VL-3B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 2.2, purposes: ['image', 'video'], desc: '轻量视觉模型，识图、截图问答；本地视频会先抽帧再理解' },
  { id: 'vision-4b', name: 'Qwen3-VL 4B', repo: 'bartowski/Qwen3-VL-4B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 2.8, purposes: ['image', 'video'], desc: '视觉主力档，识图较稳；mmproj 可在模型组合里自动下载' },
  { id: 'vision-7b', name: 'Qwen2.5-VL 7B', repo: 'bartowski/Qwen2.5-VL-7B-Instruct-GGUF', quant: 'Q4_K_M', sizeGB: 4.9, purposes: ['image', 'video'], desc: '视觉高配，需要更大显存或内存' },
  { id: 'gen-z-image', name: 'Z-Image GGUF', repo: 'unsloth/Z-Image-GGUF', quant: 'Q4_K_M', sizeGB: 5.0, purposes: ['imageGen'], desc: '千问系轻量文生图（约 6B），8GB 显存友好' },
  { id: 'gen-z-image-turbo', name: 'Z-Image Turbo GGUF', repo: 'unsloth/Z-Image-Turbo-GGUF', quant: 'Q4_K_M', sizeGB: 5.0, purposes: ['imageGen'], desc: 'Z-Image 加速版，出图更快' },
  { id: 'gen-qwen-image', name: 'Qwen-Image GGUF', repo: 'city96/Qwen-Image-gguf', quant: 'Q4_K_S', sizeGB: 12.1, purposes: ['imageGen'], desc: '千问文生图主力；8GB 显存建议 Q4 及以下量化' },
  { id: 'gen-qwen-image-2512', name: 'Qwen-Image 2512 GGUF', repo: 'unsloth/Qwen-Image-2512-GGUF', quant: 'Q4_K_S', sizeGB: 11.9, purposes: ['imageGen'], desc: '千问文生图较新版本，体积偏大' },
  { id: 'gen-flux-schnell', name: 'FLUX.1 Schnell GGUF', repo: 'city96/FLUX.1-schnell-gguf', quant: 'Q4_K_S', sizeGB: 5.5, purposes: ['imageGen'], desc: '本地文生图常用档，下载到模型目录即可部署' },
  { id: 'gen-flux-dev', name: 'FLUX.1 Dev GGUF', repo: 'city96/FLUX.1-dev-gguf', quant: 'Q4_K_S', sizeGB: 12.0, purposes: ['imageGen'], desc: '画质更好，体积更大，显存需求高' },
  { id: 'gen-sdxl', name: 'SDXL Base GGUF', repo: 'city96/stable-diffusion-xl-base-1.0-gguf', quant: 'Q4_K_S', sizeGB: 4.9, purposes: ['imageGen'], desc: 'Stable Diffusion XL 文生图' },
  { id: 'gen-sd15', name: 'SD 1.5 GGUF', repo: 'city96/stable-diffusion-v1-5-gguf', quant: 'Q4_K_S', sizeGB: 2.0, purposes: ['imageGen'], desc: '轻量文生图，低配也能跑' },
  { id: 'gen-wan-t2v', name: 'Wan2.1 文生视频 14B', repo: 'city96/Wan2.1-T2V-14B-gguf', quant: 'Q4_K_S', sizeGB: 10.4, purposes: ['videoGen'], desc: '本地文生视频 GGUF；显存不够可选更低量化，或自己搜索 1.3B 轻量版' },
  { id: 'gen-wan-i2v', name: 'Wan2.1 图生视频 720P', repo: 'city96/Wan2.1-I2V-14B-720P-gguf', quant: 'Q4_K_S', sizeGB: 10.4, purposes: ['videoGen'], desc: '本地图生视频 GGUF，体积较大' },
  { id: 'gen-wan-t2v-13b', name: 'Wan2.1 文生视频 1.3B', repo: 'city96/Wan2.1-T2V-1.3B-gguf', quant: 'Q4_K_S', sizeGB: 1.2, purposes: ['videoGen'], desc: '轻量文生视频，8GB 显存友好' },
  { id: 'gen-music-turbo', name: 'MusicGen Turbo', repo: 'CreativeHub008/MusicGen', quant: 'Q8_0', sizeGB: 2.6, purposes: ['musicGen'], desc: '本地音乐生成，下载到模型目录；同仓库可能还有 vae 等配套文件' },
  { id: 'gen-music-4b', name: 'MusicGen 4B', repo: 'CreativeHub008/MusicGen', quant: 'Q8_0', sizeGB: 4.5, purposes: ['musicGen'], desc: '音质更好，体积更大' },
  { id: 'gen-sfx-turbo', name: 'MusicGen Turbo', repo: 'CreativeHub008/MusicGen', quant: 'Q8_0', sizeGB: 2.6, purposes: ['sfxGen'], desc: '本地短音效与环境音，下载到模型目录部署' },
  { id: 'gen-sfx-model', name: 'Music Generation', repo: 'mradermacher/music_generation_model-GGUF', quant: 'Q4_K_S', sizeGB: 4.2, purposes: ['sfxGen'], desc: '轻量音效/氛围生成 GGUF' }
];

function L(zh, en) {
  return store.load().locale === 'en' ? en : zh;
}

function purposeNoteText(key) {
  const map = {
    image: L(
      '下载后在「文件 → 模型组合」挂到「看图」槽位；mmproj 留空时会自动搜索下载，不会把原图发给文本模型。',
      'After download, attach to Vision in File → Model combo; mmproj auto-downloads if empty.'
    ),
    video: L(
      '本地视频会先抽关键帧，再用看图模型理解；请下载视觉 GGUF，并在模型组合挂上 mmproj（可自动下载）。',
      'Local video uses frame extract + vision GGUF; download mmproj or leave empty for auto-fetch.'
    ),
    imageGen: L(
      '下载到模型目录后本地部署，用于文生图/改图。复杂模型可能还需配套 VAE，可用「自己搜索」补下。',
      'Download to the models folder for local image gen; some models need extra VAE files via manual search.'
    ),
    videoGen: L(
      '下载到模型目录后本地部署。视频 GGUF 体积大，可能还需 VAE/文本编码器，可用「自己搜索或粘贴链接」补全。',
      'Download to the models folder for local video gen; you may need VAE/text encoder files too.'
    ),
    sfxGen: L(
      '下载到模型目录后本地部署，用于短音效与环境音。',
      'Download to the models folder for local sound effects.'
    ),
    docGen: L(
      '下载到模型目录后本地部署，用于长文、Markdown、文档草稿生成。',
      'Download to the models folder for local long-form and document drafts.'
    ),
    musicGen: L(
      '下载到模型目录后本地部署；同仓库可能还有 vae 等配套文件，需要时一并下载。',
      'Download to the models folder; grab companion vae files from the same repo if needed.'
    )
  };
  return map[key] || '';
}

// 各用途优先展示的 HF 仓库（不受搜索标签/filter 影响）
const PURPOSE_CURATED = {
  imageGen: [
    'unsloth/Z-Image-GGUF',
    'unsloth/Z-Image-Turbo-GGUF',
    'city96/Qwen-Image-gguf',
    'unsloth/Qwen-Image-2512-GGUF',
    'QuantStack/Qwen-Image-Edit-2509-GGUF'
  ],
  videoGen: ['city96/Wan2.1-T2V-1.3B-gguf', 'city96/Wan2.1-T2V-14B-gguf'],
  musicGen: ['CreativeHub008/MusicGen'],
  sfxGen: ['CreativeHub008/MusicGen', 'mradermacher/music_generation_model-GGUF']
};

// 各用途在 HuggingFace 上的搜索词；与内置 catalog 合并，去重后全部展示
const PURPOSE_SEARCH = {
  code: ['coder instruct gguf', 'code llm gguf'],
  chat: ['instruct gguf 7b', 'chat instruct gguf'],
  image: ['vision vl gguf', 'multimodal gguf'],
  video: ['vision vl gguf', 'video llm gguf'],
  imageGen: [
    'qwen image gguf',
    'qwen-image gguf',
    'z-image gguf',
    'flux gguf',
    'stable diffusion gguf',
    'sdxl gguf'
  ],
  videoGen: ['wan gguf video', 'text to video gguf', 'image to video gguf'],
  musicGen: ['musicgen gguf', 'music generation gguf'],
  sfxGen: ['audio generation gguf', 'sound generation gguf'],
  docGen: ['instruct gguf 7b', 'instruct gguf 14b', 'writing instruct gguf']
};

async function mapPool(list, fn, concurrency = 6) {
  const out = [];
  for (let i = 0; i < list.length; i += concurrency) {
    const batch = await Promise.all(list.slice(i, i + concurrency).map(fn));
    out.push(...batch.filter(Boolean));
  }
  return out;
}

/** 把 HF 仓库解析成 catalog 条目（含真实 gguf 体积） */
async function repoEntry(repo, purpose, sourceOpts = {}) {
  try {
    const { files } = await downloader.listRepoFiles(repo, sourceOpts);
    const picked = downloader.pickFile(files, 'Q4_K_S')
      || downloader.pickFile(files, 'Q4_K_M')
      || files.find((f) => /\.gguf$/i.test(f.name) && !/mmproj/i.test(f.name));
    if (!picked) return null;
    const quantMatch = picked.name.match(/Q\d[_\w]+/i);
    const sizeGB = picked.size > 0
      ? Math.round((picked.size / GB) * 10) / 10
      : 4;
    const short = (repo.split('/').pop() || repo).replace(/-/g, ' ');
    return {
      id: `hf-${repo.replace(/[^\w-]/g, '_')}`,
      name: short,
      repo,
      quant: quantMatch ? quantMatch[0] : 'Q4_K_M',
      sizeGB: sizeGB || 4,
      purposes: [purpose],
      desc: L(`HuggingFace · ${repo}`, `HuggingFace · ${repo}`)
    };
  } catch {
    return null;
  }
}

function looksLikeGgufRepo(repo) {
  return /gguf/i.test(String(repo || ''));
}

const REMOTE_REPO_MAX = 120;
const purposeRepoCache = new Map();

/** 收集用途对应的 HF 仓库 ID（只搜 ID，不拉体积） */
async function collectPurposeRepoIds(purpose, sourceOpts = {}) {
  const queries = PURPOSE_SEARCH[purpose] || [];
  const curated = PURPOSE_CURATED[purpose] || [];
  if (!queries.length && !curated.length) return [];

  const seen = new Set();
  const repos = [];

  for (const repo of curated) {
    const key = String(repo || '').trim();
    if (!key || seen.has(key.toLowerCase())) continue;
    seen.add(key.toLowerCase());
    repos.push(key);
  }

  for (const q of queries) {
    try {
      const { repos: list } = await downloader.searchRepos(q, 25, { ...sourceOpts, ggufFilter: false });
      for (const r of list) {
        const repo = String(r.repo || '').trim();
        if (!repo || seen.has(repo.toLowerCase())) continue;
        if (!looksLikeGgufRepo(repo)) continue;
        seen.add(repo.toLowerCase());
        repos.push(repo);
      }
    } catch { /* 单条搜索失败不影响其它 */ }
  }

  return repos.slice(0, REMOTE_REPO_MAX);
}

function getPurposeRepoIds(purpose, sourceOpts = {}) {
  const key = `${purpose}|${sourceOpts.base || ''}`;
  if (!purposeRepoCache.has(key)) {
    purposeRepoCache.set(key, collectPurposeRepoIds(purpose, sourceOpts));
  }
  return purposeRepoCache.get(key);
}

function clearPurposeRepoCache() {
  purposeRepoCache.clear();
}

/** 0=很不适合，100=很适合；供列表背景绿→红渐变 */
function computeFitScore(m, hw) {
  const vram = hw?.gpu?.vramGB || 0;
  const ramTotal = hw?.memTotalGB || 0;
  const usableRam = Math.max(ramTotal - 4, 2);
  const needGpu = m.sizeGB + 1.0;
  const needRam = m.sizeGB + 1.5;
  const needTight = m.sizeGB + 0.5;
  const CPU_PRACTICAL_GB = 5;
  let score;

  if (needGpu <= vram && vram > 0) {
    const headroom = Math.max(0, vram - needGpu);
    const span = Math.max(vram * 0.45, 1.5);
    score = 72 + Math.min(28, (headroom / span) * 28);
    if (headroom >= span * 0.6) score = Math.max(score, 92);
  } else if (needRam <= usableRam) {
    if (m.sizeGB <= CPU_PRACTICAL_GB) {
      score = 48 + (1 - m.sizeGB / CPU_PRACTICAL_GB) * 22;
    } else {
      const slack = Math.max(0, usableRam - needRam);
      score = 28 + Math.min(18, (slack / Math.max(usableRam, 1)) * 18);
    }
  } else if (needTight <= ramTotal - 2) {
    const slack = Math.max(0, (ramTotal - 2) - needTight);
    score = 12 + Math.min(14, slack * 4);
  } else {
    const deficit = needRam - usableRam;
    score = Math.max(0, 10 - deficit * 4);
  }

  if (!m.diskEnough) score = Math.min(score, 4);
  return Math.round(Math.min(100, Math.max(0, score)));
}

function tierFromItem(m) {
  if (m.fitScore >= 90) return '推荐';
  if (m.fit === 'no' || m.fitScore < 8) return '跑不动';
  if (m.fit === 'tight' || m.fitScore < 22) return '勉强能跑';
  return '可选';
}

function analyzeItems(rawItems, hw) {
  const vram = hw?.gpu?.vramGB || 0;
  const ramTotal = hw?.memTotalGB || 0;
  const usableRam = Math.max(ramTotal - 4, 2);
  const disk = hw?.diskFreeGB || 0;
  const CPU_PRACTICAL_GB = 5;

  const items = rawItems.map((m) => {
    let fit = 'no';
    if (m.sizeGB + 1.0 <= vram) fit = 'gpu';
    else if (m.sizeGB + 1.5 <= usableRam) fit = 'ram';
    else if (m.sizeGB + 0.5 <= ramTotal - 2) fit = 'tight';
    return { ...m, fit, diskEnough: disk === 0 || disk > m.sizeGB + 1 };
  });

  for (const m of items) {
    if (m.fit === 'gpu') {
      m.note = '能整个放进显存，速度快';
    } else if (m.fit === 'ram' && m.sizeGB <= CPU_PRACTICAL_GB) {
      m.note = vram > 0 ? '显存放不下，用 CPU 跑，速度中等' : '用内存跑，速度中等';
    } else if (m.fit === 'ram') {
      m.note = '内存装得下，但显存放不下，只能用 CPU 跑，会明显偏慢';
    } else if (m.fit === 'tight') {
      m.note = '内存刚够，生成很慢，长对话可能撑不住';
    } else {
      m.note = `需要约 ${(m.sizeGB + 1.5).toFixed(1)}GB 可用内存，本机不够`;
    }
    if (!m.diskEnough) m.note += `；模型目录所在盘只剩 ${disk}GB，空间不足`;
    m.fitScore = computeFitScore(m, hw);
    m.tier = tierFromItem(m);
  }
  return items;
}

const DEFAULT_PAGE_SIZE = 10;

/**
 * 按用途和本机配置给出模型建议（分页：catalog 首屏 + 远程仓库瀑布加载）
 * @param {string} purpose 用途
 * @param {object} hw detect() 的结果
 * @param {{offset?: number, limit?: number, base?: string}} [opts]
 */
async function suggest(purpose, hw, opts = {}) {
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || DEFAULT_PAGE_SIZE));
  const sourceOpts = opts.base ? { base: opts.base } : {};
  const note = purposeNoteText(purpose);

  const catalogItems = CATALOG.filter((m) => m.purposes.includes(purpose));
  const catalogRepos = new Set(catalogItems.map((m) => m.repo.toLowerCase()));
  const remoteIds = (await getPurposeRepoIds(purpose, sourceOpts))
    .filter((id) => !catalogRepos.has(id.toLowerCase()));

  if (offset === 0) {
    const firstRemote = await mapPool(
      remoteIds.slice(0, limit),
      (repo) => repoEntry(repo, purpose, sourceOpts),
      4
    );
    const merged = [...catalogItems, ...firstRemote.filter(Boolean)];
    const items = analyzeItems(merged, hw);
    items.sort((a, b) => b.fitScore - a.fitScore || a.sizeGB - b.sizeGB);
    const loadedRemote = Math.min(limit, remoteIds.length);
    return {
      supported: items.length > 0 || remoteIds.length > 0,
      purposeNote: note,
      items,
      hasMore: loadedRemote < remoteIds.length,
      nextOffset: loadedRemote,
      total: catalogItems.length + remoteIds.length
    };
  }

  const batch = remoteIds.slice(offset, offset + limit);
  const remote = await mapPool(batch, (repo) => repoEntry(repo, purpose, sourceOpts), 4);
  const items = analyzeItems(remote.filter(Boolean), hw);
  items.sort((a, b) => b.fitScore - a.fitScore || a.sizeGB - b.sizeGB);
  const nextOffset = offset + batch.length;
  return {
    items,
    hasMore: nextOffset < remoteIds.length,
    nextOffset,
    total: catalogItems.length + remoteIds.length
  };
}

/** 按关键词搜索 HF 仓库并分页返回（带硬件适合度） */
async function suggestQuery(purpose, hw, query, opts = {}) {
  const offset = Math.max(0, Number(opts.offset) || 0);
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || DEFAULT_PAGE_SIZE));
  const sourceOpts = opts.base ? { base: opts.base } : {};
  const q = String(query || '').trim();
  if (!q) return suggest(purpose, hw, opts);

  const cacheKey = `search:${purpose}|${sourceOpts.base || ''}|${q.toLowerCase()}`;
  if (!purposeRepoCache.has(cacheKey)) {
    purposeRepoCache.set(cacheKey, (async () => {
      const seen = new Set();
      const repos = [];
      try {
        const { repos: list } = await downloader.searchRepos(q, 30, { ...sourceOpts, ggufFilter: false });
        for (const r of list) {
          const repo = String(r.repo || '').trim();
          if (!repo || seen.has(repo.toLowerCase())) continue;
          if (!looksLikeGgufRepo(repo)) continue;
          seen.add(repo.toLowerCase());
          repos.push(repo);
        }
      } catch { /* 搜索失败返回空 */ }
      return repos.slice(0, REMOTE_REPO_MAX);
    })());
  }

  const repoIds = await purposeRepoCache.get(cacheKey);
  const batch = repoIds.slice(offset, offset + limit);
  const remote = await mapPool(batch, (repo) => repoEntry(repo, purpose, sourceOpts), 4);
  const items = analyzeItems(remote.filter(Boolean), hw);
  items.sort((a, b) => b.fitScore - a.fitScore || a.sizeGB - b.sizeGB);
  const nextOffset = offset + batch.length;
  return {
    supported: items.length > 0 || repoIds.length > 0,
    purposeNote: purposeNoteText(purpose),
    items,
    hasMore: nextOffset < repoIds.length,
    nextOffset,
    total: repoIds.length,
    searchQuery: q
  };
}

module.exports = { detect, suggest, suggestQuery, clearPurposeRepoCache, CATALOG };
