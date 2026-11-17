/**
 * 审美评审的只读参考工具：查询图片来源、读取真实图片、采样成果画面。
 * 图片只放在内存中交给评委，不写缓存、不修改成果，也不开放通用文件或命令工具。
 */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { httpFetch } = require('./http-fetch');
const studio = require('./artifact-studio');

/** 评委仅有这两个只读工具；查看网页、矢量图和视频时由评委明确选择画幅与采样时刻。 */
const toolSpecs = [
  {
    type: 'function',
    function: {
      name: 'search_reference_images',
      description: '按任务主题查询联网参考图，返回参考编号、标题、原图和来源网页。搜索结果只是线索；必须再用 view_review_image 查看真实图片才能比较。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '明确的参考图主题、布局或风格关键词' },
          count: { type: 'integer', minimum: 1, maximum: 6, description: '本次需要的候选图片数' }
        },
        required: ['query', 'count']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'view_review_image',
      description: '查看参考编号、图片 URL 或项目内成果路径的真实画面。HTML/SVG 必须传 width/height；视频必须传 time；代码动画必须同时传 fps/duration/time。一次只看一幅画面，可多次调用比较。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string', description: '搜索返回的参考编号、真实图片 URL、运行页面 URL，或项目内图片/HTML/SVG/视频路径；组件和样式源码须查看其运行页面或截图' },
          page: { type: 'boolean', description: 'source 为运行页面 URL 时明确传 true，并提供 width/height；不传表示图片 URL' },
          subject: { type: 'string', description: '查看成果的运行页面或独立截图时，填写它对应的被审成果相对路径；直接查看成果文件无需填写；参考图禁止标为成果' },
          width: { type: 'integer', minimum: 1, description: 'HTML/SVG 的查看宽度，像素' },
          height: { type: 'integer', minimum: 1, description: 'HTML/SVG 的查看高度，像素' },
          time: { type: 'number', minimum: 0, description: '视频或代码动画的采样秒数；单帧不能证明整段运动质量' },
          fps: { type: 'number', exclusiveMinimum: 0, description: '代码动画源稿实际使用的帧率' },
          duration: { type: 'number', exclusiveMinimum: 0, description: '代码动画源稿实际使用的时长，秒' }
        },
        required: ['source']
      }
    }
  }
];

/** 解码搜索页属性中的 HTML 实体，保持图片 URL 查询参数与中文标题原样。 */
function decodeAttribute(value) {
  return value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/** 从 Bing 图片卡片的真实元数据提取原图和来源；无结果时明确报错，不编造候选。 */
function parseImages(html, count) {
  const results = [];
  const seen = new Set();
  const cards = html.matchAll(/<a\b[^>]*\bclass="[^"]*\biusc\b[^"]*"[^>]*>/gi);
  for (const card of cards) {
    const match = /\bm="([^"]+)"/.exec(card[0]);
    if (!match) continue;
    const item = JSON.parse(decodeAttribute(match[1]));
    if (!item.murl || !item.purl || seen.has(item.murl)) continue;
    seen.add(item.murl);
    results.push({ title: item.t, imageUrl: item.murl, sourceUrl: item.purl });
    if (results.length === count) break;
  }
  if (!results.length) throw new Error('参考图查询未返回可用图片元数据');
  return results;
}

/** 校验联网地址协议；查询与下载使用相同请求通道，并响应本轮停止。 */
async function fetchReference(url, signal) {
  const target = new URL(url);
  if (target.protocol !== 'https:' && target.protocol !== 'http:') throw new Error('参考图地址必须是 HTTP 或 HTTPS');
  const response = await httpFetch(target.href, { signal });
  if (!response.ok) throw new Error('参考图请求失败 HTTP ' + response.status);
  return response;
}

/** 发出一次真实图片查询。count 是调用者选择的候选数，不自动换搜索源。 */
async function searchImages(query, count, signal) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('参考图查询词不能为空');
  if (!Number.isInteger(count) || count < 1 || count > 6) throw new Error('参考图候选数必须是 1～6');
  const response = await fetchReference('https://www.bing.com/images/search?q=' + encodeURIComponent(query.trim()), signal);
  return parseImages(await response.text(), count);
}

/** 用 FFmpeg 从实际视频提取指定时刻的 PNG；进程失败或时刻没有帧时直接报告。 */
function videoFrame(file, time, signal) {
  if (!Number.isFinite(time) || time < 0) throw new Error('查看视频必须指定非负采样秒数 time');
  function extract(resolve, reject) {
    function finished(error, stdout, stderr) {
      if (error) {
        error.message = '审美视频采样失败：' + (stderr || error.message);
        reject(error);
      } else resolve(stdout);
    }
    execFile('ffmpeg', ['-v', 'error', '-ss', String(time), '-i', file, '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      { encoding: 'buffer', windowsHide: true, signal, maxBuffer: 32 * 1024 * 1024 }, finished);
  }
  return new Promise(extract);
}

/**
 * 对运行中的网页截取实际画面，隔离 Node 与预加载脚本，不启动或修改项目。
 * @param {string} url 已运行页面的 HTTP 或 HTTPS 地址，由调用方核实协议
 * @param {number} width 内容视口宽度，单位为像素，调用方须提供正整数
 * @param {number} height 内容视口高度，单位为像素，调用方须提供正整数
 * @param {AbortSignal} [signal] 本轮取消信号；取消时销毁截图窗口并中断等待
 * @returns {Promise<Buffer>} 等待页面及素材绘制完成后的 PNG 字节；加载、绘制、截图失败或取消时拒绝，始终释放窗口
 */
async function captureWebPage(url, width, height, signal) {
  const { app, BrowserWindow } = require('electron');
  const video = require('./code-video');
  await app.whenReady();
  if (signal) signal.throwIfAborted();
  const win = new BrowserWindow({ width, height, useContentSize: true, show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: true, backgroundThrottling: false } });
  /**
   * 拒绝截图页面打开新窗口，使评审只查看指定页面。
   * @returns {{action:string}} Electron 窗口打开处理结果，action 固定为 deny
   */
  function denyWindow() { return { action: 'deny' }; }
  /**
   * 在本轮取消时销毁当前截图窗口，终止页面加载与后续截图。
   * @returns {void} 已销毁的窗口不再重复销毁，不产生截图结果
   */
  function cancelled() { if (!win.isDestroyed()) win.destroy(); }
  win.webContents.setWindowOpenHandler(denyWindow);
  if (signal) signal.addEventListener('abort', cancelled, { once: true });
  try {
    await video.awaitAbort(win.loadURL(url), signal);
    await video.awaitAbort(win.webContents.executeJavaScript(studio.paintScript({ width, height })), signal);
    const shot = await video.awaitAbort(win.webContents.capturePage(), signal);
    return shot.toPNG();
  } finally {
    if (signal) signal.removeEventListener('abort', cancelled);
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 用 Chromium 解码图片并转成 PNG，支持参考站常见的 GIF/WebP，而不依赖只支持部分格式的 NativeImage。
 * 数据只在隔离页面和内存中存在；动图只取当前静态画面，解码失败明确抛出，完成后释放窗口。
 */
async function decodeImage(bytes, mime, signal) {
  const { app, BrowserWindow } = require('electron');
  const video = require('./code-video');
  await app.whenReady();
  if (signal) signal.throwIfAborted();
  const win = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  function cancelled() { if (!win.isDestroyed()) win.destroy(); }
  if (signal) signal.addEventListener('abort', cancelled, { once: true });
  const dataUrl = 'data:' + mime + ';base64,' + bytes.toString('base64');
  const script = '(async function decodeReviewImage(){const image=new Image();image.src=' + JSON.stringify(dataUrl) + ';await image.decode();const canvas=document.createElement("canvas");canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;canvas.getContext("2d").drawImage(image,0,0);return {dataUrl:canvas.toDataURL("image/png"),width:canvas.width,height:canvas.height};})()';
  try {
    await video.awaitAbort(win.loadURL('about:blank'), signal);
    return await video.awaitAbort(win.webContents.executeJavaScript(script), signal);
  } finally {
    if (signal) signal.removeEventListener('abort', cancelled);
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * 读取或渲染一幅真实画面，返回内存中的 PNG 和可追溯标签。
 * 联网来源不替换成缩略图；项目文件沿用作品模块的路径约束，渲染参数必须明确给出。
 */
async function viewImage(workspace, args, references, signal) {
  if (signal) signal.throwIfAborted();
  const source = args.source;
  if (typeof source !== 'string' || !source.trim()) throw new Error('查看画面必须指定 source');
  const reference = references.get(source);
  let bytes;
  let mime = 'image/png'; // 网页、矢量稿与视频采样器均返回 PNG；原始图片在各自读取分支设置实际类型。
  let label = source;
  if (args.page === true) {
    const url = new URL(source);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('运行页面必须是 HTTP 或 HTTPS 地址');
    if (!Number.isInteger(args.width) || args.width <= 0 || !Number.isInteger(args.height) || args.height <= 0) {
      throw new Error('查看运行页面必须指定正整数 width 和 height');
    }
    bytes = await captureWebPage(url.href, args.width, args.height, signal);
    label += '｜运行页面画幅 ' + args.width + '×' + args.height;
  } else if (reference || /^https?:\/\//i.test(source)) {
    const url = reference ? reference.imageUrl : source;
    const response = await fetchReference(url, signal);
    bytes = Buffer.from(await response.arrayBuffer());
    mime = response.headers.get('content-type');
    label = reference ? source + '｜' + reference.title + '｜来源：' + reference.sourceUrl : source;
  } else {
    const file = studio.sourceFile(workspace, source);
    const ext = path.extname(file).toLowerCase();
    if (ext === '.html' || ext === '.htm' || ext === '.svg') {
      if (!Number.isInteger(args.width) || args.width <= 0 || !Number.isInteger(args.height) || args.height <= 0) {
        throw new Error('查看 HTML/SVG 必须指定正整数 width 和 height');
      }
      const item = { sourcePath: source, width: args.width, height: args.height };
      if (args.fps !== undefined || args.duration !== undefined || args.time !== undefined) {
        if (!(args.fps > 0) || !(args.duration > 0) || !Number.isFinite(args.time) || args.time < 0 || args.time > args.duration) {
          throw new Error('代码动画必须给出正数 fps/duration 及范围内的 time');
        }
        item.fps = args.fps;
        item.duration = args.duration;
      }
      bytes = await studio.capture({ workspace, item, time: args.time, signal });
      label += '｜画幅 ' + args.width + '×' + args.height;
      if (args.time !== undefined) label += '｜采样 ' + args.time + ' 秒';
    } else if (['.mp4', '.webm', '.mov', '.mkv'].includes(ext)) {
      bytes = await videoFrame(file, args.time, signal);
      label += '｜采样 ' + args.time + ' 秒';
    } else {
      if (['.css', '.scss', '.less', '.vue', '.svelte', '.jsx', '.tsx', '.js', '.mjs'].includes(ext)) {
        throw new Error('源码不是画面，请查看制作说明中的运行页面 URL（page=true）或真实截图：' + source);
      }
      const imageTypes = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.avif': 'image/avif' };
      mime = imageTypes[ext];
      if (!mime) throw new Error('不支持的审美图片格式：' + source);
      bytes = await fs.promises.readFile(file);
    }
  }
  if (signal) signal.throwIfAborted();
  const image = await decodeImage(bytes, mime, signal);
  if (mime === 'image/gif') label += '｜动图静态采样，不代表完整运动';
  return { label, dataUrl: image.dataUrl, width: image.width, height: image.height, reference };
}

module.exports = { toolSpecs, parseImages, searchImages, viewImage };
