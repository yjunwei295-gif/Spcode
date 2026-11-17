// mac 交叉打包脚本（在 Windows 上直接产出可用的 SimpleCode.app 压缩包）
// 为什么不用 electron-builder --mac：它写死了「macOS 包只能在 macOS 上构建」，本机跑会直接退出。
// 这里改成自己组装：拿 Electron 官方的 darwin 包当外壳，按 byte 级搬运条目（保住符号链接与权限位），
// 再把 electron/、renderer/、node_modules、app-root、models 塞进 Contents/Resources。
// 用法：node scripts/build-mac.js --arch=arm64   （x64 传 --arch=x64）
// 产物：dist/SimpleCode-<版本>-mac-<arch>.zip
const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { ZipReader, ZipWriter } = require('./mac-zip');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE_DIR = path.join(DIST, '.mac-cache');
const MIRROR = 'https://npmmirror.com/mirrors/electron/';

// 每种架构的依赖树单独装一份：mac 的 optional 依赖按架构分发，混用会把 x64 的二进制塞进 arm64 包
function depsDirOf(arch) {
  return path.join(DIST, '.mac-deps-' + arch, 'node_modules');
}

// 打进包里的应用资源，target 是 app 包内的相对位置（相对 SimpleCode.app/Contents）
const APP_RESOURCE_DIRS = [
  { from: 'electron', to: 'Resources/app/electron' },
  { from: 'renderer', to: 'Resources/app/renderer' },
  { from: 'skills', to: 'Resources/app-root/skills' },
  { from: 'rules', to: 'Resources/app-root/rules' },
  { from: 'resources/ocr/tessdata', to: 'Resources/app-root/ocr/tessdata' }
];

// models 目录只带元数据，模型权重不随包发（和 package.json 的 filter 一致）
const MODEL_BLOCKED_EXT = ['.gguf', '.safetensors', '.ckpt', '.pt', '.pth', '.bin', '.onnx', '.part'];

// node_modules 里对 mac 无意义、或明显是其他平台的东西，不打进包
const NODE_MODULES_SKIP = [
  'node_modules/electron/',                 // 运行时自带，不需要这份 npm 包
  'node_modules/onnxruntime-node/bin/napi-v3/win32/',
  'node_modules/onnxruntime-node/bin/napi-v3/linux/'
];

/**
 * 解析命令行参数
 * @returns {{arch:string}} arch 为 arm64 或 x64
 */
function parseArgs() {
  let arch = 'arm64';
  for (const arg of process.argv.slice(2)) {
    if (arg.indexOf('--arch=') === 0) arch = arg.slice('--arch='.length);
  }
  if (arch !== 'arm64' && arch !== 'x64') throw new Error('未知架构：' + arch + '（只支持 arm64 / x64）');
  return { arch };
}

// 读项目版本号：产物文件名和 Info.plist 都用它
function readVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return pkg.version;
}

// 读本地安装的 Electron 版本，保证外壳和应用依赖的版本一致
function readElectronVersion() {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'));
  return pkg.version;
}

/**
 * 下载文件（跟随重定向，流式写盘）
 * @param {string} url 下载地址
 * @param {string} dest 保存路径
 * @returns {Promise<void>}
 */
function download(url, dest) {
  return new Promise(function start(resolve, reject) {
    const req = https.get(url, function onResponse(res) {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.indexOf('http') === 0
          ? res.headers.location
          : new URL(res.headers.location, url).toString();
        download(next, dest).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error('下载失败 HTTP ' + res.statusCode + '：' + url));
        return;
      }
      const total = Number(res.headers['content-length'] || 0);
      let got = 0;
      let lastLog = 0;
      const out = fs.createWriteStream(dest);
      res.on('data', function onData(chunk) {
        got += chunk.length;
        const now = Date.now();
        if (now - lastLog > 5000) {
          lastLog = now;
          const pct = total ? Math.round(got / total * 100) : 0;
          console.log('  下载中 ' + pct + '%（' + Math.round(got / 1048576) + 'MB）');
        }
      });
      res.pipe(out);
      out.on('finish', function onFinish() {
        out.close(function onClosed() { resolve(); });
      });
      out.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(60000, function onTimeout() { req.destroy(new Error('下载超时：' + url)); });
  });
}

/**
 * 确保本机缓存里有对应架构的 Electron darwin 包
 * @param {string} arch arm64 / x64
 * @returns {Promise<string>} zip 绝对路径
 */
async function ensureElectronZip(arch) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const version = readElectronVersion();
  const fileName = 'electron-v' + version + '-darwin-' + arch + '.zip';
  const target = path.join(CACHE_DIR, fileName);
  if (fs.existsSync(target) && fs.statSync(target).size > 50 * 1048576) {
    console.log('用缓存外壳 ' + fileName);
    return target;
  }
  const url = MIRROR + version + '/' + fileName;
  console.log('下载外壳 ' + url);
  await download(url, target);
  console.log('外壳已下载 ' + Math.round(fs.statSync(target).size / 1048576) + 'MB');
  return target;
}

/**
 * 从 ico 里的 PNG 图像拼出 mac 的 icns 图标
 * @param {string} icoPath ico 文件路径
 * @returns {Buffer|null} icns 数据；没有可用 png 时返回 null
 */
function buildIcns(icoPath) {
  if (!fs.existsSync(icoPath)) return null;
  const ico = fs.readFileSync(icoPath);
  const count = ico.readUInt16LE(4);
  // ico 尺寸 -> icns 类型；只放 macOS 认可的几种
  const map = {
    16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08',
    512: 'ic09', 1024: 'ic10'
  };
  const blocks = [];
  for (let i = 0; i < count; i++) {
    const off = 6 + i * 16;
    const width = ico[off] === 0 ? 256 : ico[off];
    const size = ico.readUInt32LE(off + 8);
    const dataOff = ico.readUInt32LE(off + 12);
    const type = map[width];
    if (!type) continue;
    const png = ico.slice(dataOff, dataOff + size);
    // ico 里也可能存的是 BMP 位图，那种不能直接塞进 icns
    if (png.readUInt32BE(0) !== 0x89504E47) continue;
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(png.length + 8, 4);
    blocks.push(head, png);
  }
  if (!blocks.length) return null;
  const body = Buffer.concat(blocks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

/**
 * 生成塞进 app 内的 package.json（去掉打包期字段，保留运行必需信息）
 * @param {string} version 应用版本
 * @returns {Buffer} UTF-8 内容
 */
function makeAppPackageJson(version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const slim = {
    name: pkg.name,
    productName: pkg.productName,
    version: version,
    description: pkg.description,
    main: pkg.main,
    author: pkg.author,
    dependencies: pkg.dependencies
  };
  return Buffer.from(JSON.stringify(slim, null, 2) + '\n', 'utf8');
}

// 判断 node_modules 里这条相对路径要不要跳过
function skipNodeModuleFile(rel) {
  const normalized = rel.split(path.sep).join('/');
  for (const prefix of NODE_MODULES_SKIP) {
    if (normalized.indexOf(prefix) === 0) return true;
  }
  if (normalized.indexOf('/.bin/') >= 0 || normalized.endsWith('/.bin')) return true;
  const lower = normalized.toLowerCase();
  if (lower.endsWith('.md') || lower.endsWith('.map')) return true;
  if (lower.indexOf('/test/') >= 0 || lower.indexOf('/tests/') >= 0) return true;
  if (lower.indexOf('/example/') >= 0 || lower.indexOf('/examples/') >= 0) return true;
  return false;
}

/**
 * 递归列目录下的文件（相对路径，用 / 分隔）
 * @param {string} base 起始目录
 * @param {string} rel 当前相对路径
 * @param {string[]} out 收集结果
 * @param {function(string):boolean} [skip] 返回 true 表示跳过
 */
function walkFiles(base, rel, out, skip) {
  const abs = rel ? path.join(base, rel) : base;
  let items;
  try {
    items = fs.readdirSync(abs, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const item of items) {
    const childRel = rel ? rel + '/' + item.name : item.name;
    if (skip && skip(childRel)) continue;
    if (item.isDirectory()) {
      walkFiles(base, childRel, out, skip);
    } else if (item.isFile()) {
      out.push(childRel);
    }
  }
}

/**
 * 从文件头识别 mac 原生程序及脚本入口，交叉打包时恢复执行权限。
 * Windows 的 stat 权限不能反映 mac 可执行位；Mach-O 与 shebang 使用 0755，其余资源使用 0644。
 * @param {string} abs 待打包文件的绝对路径
 * @returns {number} 写入 ZIP 的 Unix 文件类型与权限位
 */
function appFileMode(abs) {
  const fd = fs.openSync(abs, 'r');
  const header = Buffer.alloc(4);
  let count;
  try { count = fs.readSync(fd, header, 0, header.length, 0); }
  finally { fs.closeSync(fd); }
  if (count >= 2 && header[0] === 0x23 && header[1] === 0x21) return 0o100755;
  if (count === 4) {
    const magic = header.readUInt32BE(0);
    // 包含大小端 32/64 位 Mach-O 以及通用架构二进制，不依赖程序文件名。
    const executable = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
      0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca];
    if (executable.includes(magic)) return 0o100755;
  }
  return 0o100644;
}

/**
 * 收集要写进 app 包的所有文件
 * 大文件只记路径不预读，写到 zip 时才逐个读，避免几百 MB 依赖同时压在内存里
 * @param {string} version 应用版本
 * @param {string} arch arm64 / x64，用来选对应的依赖树
 * @returns {{files:Array<{name:string, data?:Buffer, abs?:string, size:number}>, stats:object}}
 */
function collectAppFiles(version, arch) {
  const files = [];
  const stats = { total: 0, bytes: 0 };

  // 已经在内存里的内容（生成的 package.json、图标）
  function pushFile(name, data) {
    files.push({ name: name, data: data, size: data.length });
    stats.total += 1;
    stats.bytes += data.length;
  }

  // 磁盘上的文件：只记绝对路径和大小，稍后再读
  function pushPath(name, abs) {
    let size = 0;
    try {
      size = fs.statSync(abs).size;
    } catch (e) {
      return;
    }
    files.push({ name: name, abs: abs, size: size });
    stats.total += 1;
    stats.bytes += size;
  }

  // 主代码与界面
  for (const dir of APP_RESOURCE_DIRS) {
    const base = path.join(ROOT, dir.from);
    if (!fs.existsSync(base)) continue;
    const list = [];
    walkFiles(base, '', list, null);
    for (const rel of list) {
      // 内部训练采集实现不得进入任何发布安装包。
      if (dir.from === 'electron' && rel === 'lib/training-archive.js') continue;
      const abs = path.join(base, rel);
      const target = 'Resources/' + dir.to.replace(/^Resources\//, '') + '/' + rel;
      pushPath(path.posix.normalize(target), abs);
    }
  }

  // 应用入口 package.json
  pushFile('Resources/app/package.json', makeAppPackageJson(version));

  // 图标：界面里用得到，mac 的 icns 另外单独塞到 Resources 根
  for (const icon of ['icons.png', 'icons.ico']) {
    const abs = path.join(ROOT, icon);
    if (fs.existsSync(abs)) pushFile('Resources/app/' + icon, fs.readFileSync(abs));
  }

  // 运行时依赖
  const depsDir = depsDirOf(arch);
  if (!fs.existsSync(depsDir)) {
    throw new Error('缺少 mac 依赖目录 ' + depsDir + '，先跑 npm ci --omit=dev --os=darwin --cpu=' + arch);
  }
  const depList = [];
  walkFiles(depsDir, '', depList, skipNodeModuleFile);
  for (const rel of depList) {
    const abs = path.join(depsDir, rel.split('/').join(path.sep));
    pushPath('Resources/app/node_modules/' + rel, abs);
  }

  // 模型目录：只带描述文件，权重不随包发
  const modelsDir = path.join(ROOT, 'models');
  if (fs.existsSync(modelsDir)) {
    const modelList = [];
    walkFiles(modelsDir, '', modelList, function skipModel(rel) {
      const ext = path.extname(rel).toLowerCase();
      if (MODEL_BLOCKED_EXT.indexOf(ext) >= 0) return true;
      if (rel.toLowerCase().endsWith('.sc-meta.json')) return true;
      return false;
    });
    for (const rel of modelList) {
      const abs = path.join(modelsDir, rel.split('/').join(path.sep));
      pushPath('Resources/models/' + rel, abs);
    }
  }

  return { files: files, stats: stats };
}

// 把 XML plist 里某个 <key> 后面的 <string> 值换掉
function setPlistString(text, key, value) {
  const pattern = new RegExp('(<key>' + key + '</key>\\s*<string>)([\\s\\S]*?)(</string>)');
  if (!pattern.test(text)) return text;
  return text.replace(pattern, function replace(whole, head, old, tail) {
    return head + value + tail;
  });
}

/**
 * 改写一个 plist 的内容：主包和 helper 包改的键不一样
 * @param {string} name 包内路径（已改名后的）
 * @param {string} text plist 原文
 * @param {string} version 应用版本
 * @returns {string} 改写后的原文
 */
function patchPlist(name, text, version) {
  let out = text;
  const isMain = name === 'Contents/Info.plist';
  if (isMain) {
    out = setPlistString(out, 'CFBundleExecutable', 'SimpleCode');
    out = setPlistString(out, 'CFBundleName', 'SimpleCode');
    out = setPlistString(out, 'CFBundleDisplayName', 'SimpleCode');
    out = setPlistString(out, 'CFBundleIdentifier', 'com.simplecode.app');
    out = setPlistString(out, 'CFBundleShortVersionString', version);
    out = setPlistString(out, 'CFBundleVersion', version);
    out = setPlistString(out, 'CFBundleIconFile', 'simplecode.icns');
    return out;
  }
  // helper 进程：Electron Helper -> SimpleCode Helper，bundle id 跟着换
  out = out.split('Electron Helper').join('SimpleCode Helper');
  out = setPlistString(out, 'CFBundleIdentifier', 'com.simplecode.app.helper');
  return out;
}

// 把原包里的 Electron.app 路径改造成 SimpleCode.app 的路径
function mapEntryName(name) {
  if (name === 'Electron.app/' || name.indexOf('Electron.app/') === 0) {
    let rest = name.slice('Electron.app/'.length);
    rest = rest.split('Electron Helper').join('SimpleCode Helper');
    if (rest === 'Contents/MacOS/Electron') rest = 'Contents/MacOS/SimpleCode';
    return 'SimpleCode.app/' + rest;
  }
  return name;
}

/**
 * 真正组装：读外壳 zip，改名、改 plist，再追加应用资源
 * @param {object} opts {arch, version, zipPath, outPath}
 * @returns {Promise<void>}
 */
async function buildPackage(opts) {
  const reader = new ZipReader(opts.zipPath);
  const writer = new ZipWriter(opts.outPath);
  const icns = buildIcns(path.join(DIST, '.icon-ico', 'icon.ico'));
  let copied = 0;
  let patched = 0;

  for (const entry of reader.entries) {
    const newName = mapEntryName(entry.name);
    if (!newName.startsWith('SimpleCode.app/')) {
      // 原包只有 Electron.app 一棵树，出现别的路径也原样带走
      const raw = reader.readRaw(entry);
      writer.copyEntry(entry, raw, newName);
      copied += 1;
      continue;
    }
    const inner = newName.slice('SimpleCode.app/'.length);
    const needPatch = inner.endsWith('/Info.plist') && !inner.startsWith('Contents/Frameworks/Electron Framework.framework');
    if (needPatch) {
      const text = reader.readContent(entry).toString('utf8');
      const patchedText = patchPlist(inner, text, opts.version);
      if (patchedText !== text) patched += 1;
      writer.addFile(newName, Buffer.from(patchedText, 'utf8'), { mode: 0o100644 });
      continue;
    }
    const raw = reader.readRaw(entry);
    writer.copyEntry(entry, raw, newName);
    copied += 1;
  }
  reader.close();
  console.log('外壳条目搬运完成：' + copied + ' 条，改写 plist ' + patched + ' 份');

  if (icns) {
    writer.addFile('SimpleCode.app/Contents/Resources/simplecode.icns', icns, { mode: 0o100644 });
    console.log('图标 icns 已生成 ' + icns.length + ' 字节');
  }

  const collected = collectAppFiles(opts.version, opts.arch);
  const dirs = new Set();
  for (const file of collected.files) {
    const parts = file.name.split('/');
    let acc = 'SimpleCode.app/Contents';
    for (let i = 0; i < parts.length - 1; i++) {
      acc += '/' + parts[i];
      dirs.add(acc);
    }
  }
  const sortedDirs = Array.from(dirs).sort();
  for (const dir of sortedDirs) {
    writer.addFile(dir + '/', Buffer.alloc(0), { mode: 0o40755 });
  }
  for (const file of collected.files) {
    // 大文件在这里才读，写完即释放，内存里同时只留一个
    const content = file.data || fs.readFileSync(file.abs);
    const mode = file.abs ? appFileMode(file.abs) : 0o100644;
    writer.addFile('SimpleCode.app/Contents/' + file.name, content, { mode });
  }
  console.log('应用资源写入：' + collected.stats.total + ' 个文件，' +
    Math.round(collected.stats.bytes / 1048576) + 'MB（未压缩）');

  writer.finish();
  const size = fs.statSync(opts.outPath).size;
  console.log('产物 ' + opts.outPath + '  ' + (size / 1048576).toFixed(1) + ' MB');
}

async function main() {
  const args = parseArgs();
  const version = readVersion();
  const zipPath = await ensureElectronZip(args.arch);
  const outPath = path.join(DIST, 'SimpleCode-' + version + '-mac-' + args.arch + '.zip');
  await buildPackage({ arch: args.arch, version: version, zipPath: zipPath, outPath: outPath });
}

// 被验收脚本加载时只暴露打包函数，不自动开始构建。
if (require.main === module) {
  main().catch(function onError(err) {
    console.error('打包失败：' + (err && err.stack ? err.stack : err));
    process.exit(1);
  });
}
module.exports = { appFileMode, collectAppFiles, buildPackage };
