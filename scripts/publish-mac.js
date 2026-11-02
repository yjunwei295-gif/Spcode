// 把 mac 包传到 GitHub Release（v1.0.3）
// 用法：node scripts/publish-mac.js
// 凭据：从本机 git 凭据管理器取 token，只在内存里用，不落盘
// 网络：api.github.com 走直连；若要用本机代理，先设 HTTPS_PROXY
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const REPO = 'yjunwei295-gif/Spcode';
const TAG = 'v' + JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

// 要上传的产物：按架构分开，名字带版本号，方便用户认
function listAssets(version) {
  return [
    { name: 'SimpleCode-' + version + '-mac-arm64.zip', file: path.join(DIST, 'SimpleCode-' + version + '-mac-arm64.zip') },
    { name: 'SimpleCode-' + version + '-mac-x64.zip', file: path.join(DIST, 'SimpleCode-' + version + '-mac-x64.zip') }
  ];
}

// 调 curl：结果先落文件，再按 UTF-8 读回，避免控制台代码页把中文弄成乱码
function curl(args, outFile) {
  const base = ['-sS', '--connect-timeout', '30'];
  if (process.env.HTTPS_PROXY) {
    base.push('-x', process.env.HTTPS_PROXY);
  }
  execFileSync('curl.exe', base.concat(args, ['-o', outFile]), { stdio: ['ignore', 'inherit', 'inherit'] });
  return fs.readFileSync(outFile, 'utf8');
}

// 从 git 凭据管理器取 token
function gitToken() {
  const out = execFileSync('git', ['credential', 'fill'], { input: 'url=https://github.com\n\n', encoding: 'utf8' });
  const line = out.split(/\r?\n/).find(function findPassword(row) { return row.indexOf('password=') === 0; });
  if (!line || line.length < 20) throw new Error('没能从 git 凭据里取到 GitHub token');
  return line.slice('password='.length);
}

async function main() {
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  const assets = listAssets(version);
  for (const asset of assets) {
    if (!fs.existsSync(asset.file)) throw new Error('缺产物：' + asset.file);
  }
  const token = gitToken();
  const auth = 'Authorization: token ' + token;
  const api = 'https://api.github.com/repos/' + REPO;
  const tmp = path.join(DIST, 'gh-resp.json');

  const relText = curl(['-H', auth, api + '/releases/tags/' + TAG], tmp);
  const rel = JSON.parse(relText);
  if (!rel.id) throw new Error('找不到版本 ' + TAG + '：' + (rel.message || ''));
  console.log('版本 ' + rel.tag_name + ' id=' + rel.id);

  for (const asset of assets) {
    const size = fs.statSync(asset.file).size;
    console.log('--- ' + asset.name + '  ' + (size / 1048576).toFixed(1) + 'MB');
    // 同名旧附件先删，保证下载到的就是刚打出来的这份
    for (const old of (rel.assets || [])) {
      if (old.name !== asset.name) continue;
      console.log('  删除同名旧附件 id=' + old.id);
      curl(['-X', 'DELETE', '-H', auth, api + '/releases/assets/' + old.id], tmp);
    }
    const uploadUrl = 'https://uploads.github.com/repos/' + REPO + '/releases/' + rel.id +
      '/assets?name=' + encodeURIComponent(asset.name);
    const startAt = Date.now();
    console.log('  开始上传…');
    const text = curl(['-X', 'POST', '-H', auth, '-H', 'Content-Type: application/octet-stream',
      '-T', asset.file, '-m', '7200', uploadUrl], tmp);
    const got = JSON.parse(text);
    const seconds = Math.round((Date.now() - startAt) / 1000);
    if (got.id && got.size === size) {
      console.log('  成功 ' + (got.size / 1048576).toFixed(1) + 'MB，用时 ' + seconds + 's');
      console.log('  ' + got.browser_download_url);
    } else {
      console.log('  上传结果异常：' + (got.message || JSON.stringify(got).slice(0, 300)));
    }
  }
  console.log('全部完成');
}

main().catch(function onError(err) {
  console.error('上传失败：' + (err && err.message ? err.message : err));
  process.exit(1);
});
