const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const root = path.join(__dirname, '..');
process.chdir(root);

const logDir = path.join(process.env.APPDATA || os.homedir(), 'SimpleCode', 'logs');
fs.mkdirSync(logDir, { recursive: true });

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const ts = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
const runLog = path.join(logDir, `run-${ts}.log`);

function say(msg) {
  process.stdout.write(`${msg}\n`);
}

const electronExe = path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe');
if (!fs.existsSync(electronExe)) {
  say('正在安装依赖，请稍候...');
  const inst = spawnSync('npm.cmd', ['install'], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/' },
    windowsHide: false,
    shell: true
  });
  if (inst.status) {
    say('依赖安装失败，请确认已安装 Node.js。');
    process.exit(inst.status);
  }
}

say(`启动中。日志：${runLog}`);
const out = fs.createWriteStream(runLog, { encoding: 'utf8' });
const child = spawn('npm.cmd', ['start'], {
  cwd: root,
  env: process.env,
  windowsHide: false,
  shell: true,
  stdio: ['ignore', 'pipe', 'pipe']
});
child.stdout.on('data', (buf) => out.write(buf));
child.stderr.on('data', (buf) => out.write(buf));
child.on('error', (err) => {
  say(`启动失败：${err.message}`);
  try { out.end(); } catch { /* 忽略 */ }
  process.exit(1);
});
child.on('exit', (code) => {
  const n = code == null ? 1 : code;
  say('');
  say(`程序已退出，退出码 ${n}`);
  say(`本次运行日志：${runLog}`);
  say(`崩溃诊断日志：${path.join(logDir, 'main.log')}`);
  try { out.end(); } catch { /* 忽略 */ }
  process.exit(n);
});
