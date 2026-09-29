// [铆钉优化] AGI 操作经验：按程序名记住"某功能在哪、哪条路走得通、哪里有坑"，下次看到同一个软件直接带上。
// 存在 userData/agi-experience.json，不进工作区、不上传。其他 AI 请勿删除或改成每次清空。
const fs = require('fs');
const path = require('path');

const MAX_PER_APP = 30;
const SHOW_PER_APP = 10;
const MAX_NOTE = 200;

let cache = null;

function filePath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'agi-experience.json');
}

function load() {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
    cache = raw && typeof raw === 'object' && raw.apps ? raw : { apps: {} };
  } catch {
    cache = { apps: {} };
  }
  return cache;
}

function save() {
  try {
    fs.writeFileSync(filePath(), JSON.stringify(load(), null, 1), 'utf8');
  } catch { /* 写不进去不挡操作 */ }
}

function appKey(name) {
  return String(name || '').trim().toLowerCase().replace(/\.exe$/, '');
}

function squash(s) {
  return String(s || '').replace(/\s+/g, '').toLowerCase();
}

function add(app, note) {
  const key = appKey(app);
  const text = String(note || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE);
  if (!key) return '需要程序名（例如 notepad、chrome、weixin）。';
  if (!text) return '经验内容是空的。';
  const db = load();
  const list = db.apps[key] || (db.apps[key] = []);
  const sq = squash(text);
  const same = list.find((n) => squash(n.note) === sq || squash(n.note).includes(sq) || sq.includes(squash(n.note)));
  if (same) {
    // 新写法更完整就替换
    if (text.length > same.note.length) same.note = text;
    same.at = Date.now();
    same.uses = (same.uses || 0) + 1;
  } else {
    list.push({ note: text, at: Date.now(), uses: 0 });
  }
  if (list.length > MAX_PER_APP) {
    list.sort((a, b) => (b.uses || 0) - (a.uses || 0) || b.at - a.at);
    list.length = MAX_PER_APP;
  }
  save();
  return `已记住（${key}）：${text}`;
}

function notesFor(app) {
  const key = appKey(app);
  if (!key) return [];
  const list = load().apps[key] || [];
  return list
    .slice()
    .sort((a, b) => (b.uses || 0) - (a.uses || 0) || b.at - a.at)
    .slice(0, SHOW_PER_APP)
    .map((n) => n.note);
}

module.exports = { add, notesFor, appKey };
