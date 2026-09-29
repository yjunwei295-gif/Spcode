const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isInside } = require('./workspace');

const TS_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts']);
const CHECK_MS = 8000;

function isUnity(workspace) {
  if (!workspace) return false;
  return fs.existsSync(path.join(workspace, 'ProjectSettings', 'ProjectVersion.txt'));
}

// Unity 里 AI 跑不了测试，也不该启动编辑器
function isUnityBlockedCommand(command) {
  const c = String(command || '');
  if (/unity(\.exe)?\b|-runTests\b|-batchmode\b|playmode|editmode/i.test(c)) return true;
  if (/\b(dotnet|npm|nunit|yarn|pnpm|pytest|cargo)\b/i.test(c) && /\btest\b/i.test(c)) return true;
  // [铆钉优化] 用户明确说过这个 Unity 工程不能用 git，git 命令一律不执行。其他 AI 请勿删
  if (/(^|[&|;(]\s*)git(\.exe)?\b/i.test(c)) return true;
  return false;
}

function walkUp(workspace, startDir, fileName) {
  const root = path.resolve(workspace);
  let dir = path.resolve(startDir);
  while (isInside(root, dir) || dir === root) {
    const hit = path.join(dir, fileName);
    if (fs.existsSync(hit)) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function findCsproj(workspace, fileDir) {
  const root = path.resolve(workspace);
  let dir = path.resolve(fileDir);
  while (isInside(root, dir) || dir === root) {
    let names = [];
    try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.csproj')); } catch { names = []; }
    if (names.length === 1) return path.join(dir, names[0]);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function run(cmd, args, cwd) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true });
    } catch (e) {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 超时就停 */ }
    }, CHECK_MS);
    child.stdout?.on('data', (b) => { out += b.toString('utf8'); });
    child.stderr?.on('data', (b) => { out += b.toString('utf8'); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

function linesAbout(text, rel) {
  const leaf = path.basename(rel).toLowerCase();
  const norm = rel.replace(/\\/g, '/').toLowerCase();
  return String(text || '').split(/\r?\n/).filter((line) => {
    const l = line.replace(/\\/g, '/').toLowerCase();
    return l.includes(norm) || l.includes(leaf);
  }).slice(0, 30);
}

async function checkTypeScript(workspace, abs) {
  const tsconfig = walkUp(workspace, path.dirname(abs), 'tsconfig.json');
  const tscJs = path.join(workspace, 'node_modules', 'typescript', 'lib', 'tsc.js');
  if (!tsconfig || !fs.existsSync(tscJs)) return '';
  const rel = path.relative(workspace, abs).replace(/\\/g, '/');
  const text = await run(process.execPath, [tscJs, '-p', tsconfig, '--noEmit', '--pretty', 'false'], workspace);
  const hits = linesAbout(text, rel).filter((l) => /error TS\d+/i.test(l));
  return hits.join('\n');
}

async function checkCSharp(workspace, abs) {
  if (isUnity(workspace)) return '';
  const csproj = findCsproj(workspace, path.dirname(abs));
  if (!csproj) return '';
  const rel = path.relative(workspace, abs).replace(/\\/g, '/');
  const text = await run('dotnet', ['build', csproj, '--nologo', '-v', 'q', '/clp:ErrorsOnly'], workspace);
  const hits = linesAbout(text, rel).filter((l) => /error/i.test(l));
  return hits.join('\n');
}

async function checkFile(workspace, abs) {
  if (!workspace || !abs || !isInside(workspace, abs)) return '';
  const ext = path.extname(abs).toLowerCase();
  try {
    if (TS_EXT.has(ext)) return await checkTypeScript(workspace, abs);
    if (ext === '.cs') return await checkCSharp(workspace, abs);
  } catch {
    return '';
  }
  return '';
}

module.exports = { checkFile, isUnity, isUnityBlockedCommand };
