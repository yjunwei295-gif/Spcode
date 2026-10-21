// 部下（代码槽）压力。改了已确认方案之外的文件就加压、记违规；按方案做完就减压。只拼进代码槽提示词，不给用户看
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const MAX = 100;
const PUNISH = 25;
const REWARD = 10;

function filePath() {
  let dir;
  try { dir = app.getPath('userData'); } catch { dir = path.join(process.cwd(), '.simple-userdata'); }
  return path.join(dir, 'worker-pressure.json');
}
function wsKey(workspace) {
  const n = String(workspace || '_none').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return crypto.createHash('sha1').update(n).digest('hex').slice(0, 16);
}
function loadAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}
function read(workspace) {
  const row = loadAll()[wsKey(workspace)] || {};
  return {
    pressure: Math.max(0, Math.min(MAX, Number(row.pressure) || 0)),
    violations: Math.max(0, Number(row.violations) || 0)
  };
}
function write(workspace, row) {
  const all = loadAll();
  all[wsKey(workspace)] = { ...row, updatedAt: Date.now() };
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(all, null, 2), 'utf8');
  return row;
}

// 每改一个方案外文件加一档压力
function punish(workspace, count) {
  const now = read(workspace);
  const n = Math.max(1, Number(count) || 1);
  return write(workspace, {
    pressure: Math.min(MAX, now.pressure + PUNISH * n),
    violations: now.violations + n
  });
}

function reward(workspace) {
  const now = read(workspace);
  return write(workspace, { pressure: Math.max(0, now.pressure - REWARD), violations: now.violations });
}

function promptBlock(workspace) {
  const { pressure, violations } = read(workspace);
  if (pressure <= 0) return '';
  if (pressure >= MAX) {
    return `\n你已被列为重点监管（偏离方案违规 ${violations} 次）。任何方案外改动都会继续加罚并报告给用户，程序不会撤回、也不会替你还原：回滚和撤回只有用户自己能在界面上操作。只做方案写明的每一步，一步都不多做，方案没点名的文件和方法一律不碰。`;
  }
  if (pressure >= 50) {
    return `\n你已多次偏离方案（违规 ${violations} 次），处于严管期。每次 edit_file / write_file 前先核对目标文件和方法都在【已确认方案】里；不在就停手回报大脑，禁止自作主张。`;
  }
  return `\n你有 ${violations} 次偏离方案的违规记录。只按【已确认方案】改，方案没点名的文件、方法一律不碰。`;
}

module.exports = { read, punish, reward, promptBlock };
