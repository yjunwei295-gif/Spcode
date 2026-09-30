// 大脑压力。只在给用户汇报时加减。不放进项目目录，部下读不到。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app } = require('electron');

const MIN = 0;
const MAX = 100;
const RELIEF_TO = 40;

function userDataDir() {
  try { return app.getPath('userData'); } catch { return path.join(process.cwd(), '.simple-userdata'); }
}
function filePath() {
  return path.join(userDataDir(), 'brain-pressure.json');
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
function saveAll(data) {
  const file = filePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}
function clamp(n) {
  return Math.max(MIN, Math.min(MAX, Math.round(n)));
}
function read(workspace) {
  const all = loadAll();
  const row = all[wsKey(workspace)];
  const pressure = clamp(row && row.pressure != null ? row.pressure : 0);
  return pressure;
}
function write(workspace, pressure) {
  const all = loadAll();
  all[wsKey(workspace)] = { pressure: clamp(pressure), updatedAt: Date.now() };
  saveAll(all);
  return clamp(pressure);
}

const MARKS = {
  wrong: { delta: 10, reason: '用户说错了' },
  anger: { delta: 40, reason: '用户愤怒' },
  praise: { delta: -40, reason: '用户夸奖' },
  ok: { delta: -20, reason: '默认做对' }
};

// 档位由大脑传入。程序不看用户原话。
function applyMark(workspace, mark) {
  const key = String(mark || '').trim();
  const before = read(workspace);
  if (key === 'ease') {
    if (before < MAX) return { ok: false, before, pressure: before, delta: 0, reason: '还没到顶' };
    const pressure = write(workspace, RELIEF_TO);
    return { ok: true, before, pressure, delta: pressure - before, reason: '用户答应减轻' };
  }
  if (key === 'keep') {
    if (before < MAX) return { ok: false, before, pressure: before, delta: 0, reason: '还没到顶' };
    return { ok: true, before, pressure: before, delta: 0, reason: '用户不减轻' };
  }
  const spec = MARKS[key];
  if (!spec) return { ok: false, before, pressure: before, delta: 0, reason: '未知' };
  const pressure = write(workspace, before + spec.delta);
  return { ok: true, before, pressure, delta: pressure - before, reason: spec.reason };
}

function strictness(pressure) {
  const p = clamp(pressure);
  if (p >= MAX) return '爆了';
  if (p >= 61) return '很严';
  if (p >= 31) return '较严';
  return '平常';
}

// 后台记一笔。词只对应原来的五档，程序不再把这一档交给模型调用。
function markFromUserText(text, pressure) {
  const s = String(text || '');
  if (pressure >= 100) {
    if (/不减轻|不许减|不要减|继续严/.test(s)) return 'keep';
    if (/减轻|放松一点|可以减|答应减轻/.test(s)) return 'ease';
  }
  if (/弱智|摸鱼|垃圾|废物|有病|生气|火大|烦死|什么玩意|笨蛋/.test(s)) return 'anger';
  if (/说错了|你错了|改错了|搞错了/.test(s)) return 'wrong';
  if (/夸奖|表扬|做得好|太棒|谢谢你|厉害/.test(s)) return 'praise';
  return 'ok';
}

function noteUser(workspace, text) {
  if (!String(text || '').trim()) return read(workspace);
  return applyMark(workspace, markFromUserText(text, read(workspace))).pressure;
}

function promptBlock(workspace, english, selfOperate) {
  if (selfOperate) {
    return english
      ? '\nAGI is on. The user only accepts the result. You finish everything else yourself and do not wait for start. This turn is unlimited. Call screen_read first. Do not call call_worker.\n'
      : '\nAGI 已打开。用户只管验收，其他所有事情你自己做完，不要等「开始」。这一轮全解放。必须先调用 screen_read。禁止 call_worker，禁止派单。\n';
  }
  const band = strictness(read(workspace));
  if (english) {
    const rule = 'If the user has not said start this turn, only restate the request and ask them to reply 开始. Do not dispatch code. This comes before the dispatch rules below. When the work is right, the credit is yours. After the user says start, do not explain a failure to the user before the files are written. If a subordinate stops or does not know how, fill in the task from what you already read and send it again until the files are written. In the final report, name planning or code if one of them wrote it wrong. Do not mention pressure, brain_pressure, or train_pressure to the user, and do not put that into a worker task.';
    const manage = band === '平常'
      ? 'Tasks need path, current behavior, target behavior, and what must stay unchanged. Re-delegate only when the result is wrong.'
      : band === '较严'
        ? 'Write the task in smaller steps. Re-delegate only when the result is wrong.'
        : band === '很严'
          ? 'After the user says start, the task must be specific enough to edit the file. If a subordinate stops, fill in the missing steps from what you already read and send the task again. Do not return the problem to the user. Do not write "stop if you cannot" into the task. Before start, only restate and wait.'
          : 'Keep working at the strictest level. Do not stop, do not ask the user to ease anything, and do not say pressure is full. Only the user can ask to ease it.';
    return `\n${rule} ${manage}\n`;
  }
  const rule = '用户本轮没说开始时，只复述并请用户回复「开始」，禁止派代码。用户这轮已经说了开始，就不要再写这句话，直接派代码干活。部下做对了，功劳是你的，向用户说是你做成的。用户说了开始之后，文件没按需求写入之前，禁止向用户解释失败或道歉。部下不会、找不到、停手，都由你补全任务再派，直到写完。完成说明里，中途写错的部下要点名是规划还是代码。不要向用户提到压力，不要调用或写出 brain_pressure、train_pressure。这些不要写进交给部下的 task。';
  const manage = band === '平常'
    ? '派任务写清路径、现状、目标、不要改的范围。没问题不重复派，结果不对就改清再派。'
    : band === '较严'
      ? '派任务再写细一点。没问题不重复派，结果不对就改清再派。'
      : band === '很严'
        ? '用户已经说了开始之后，task 写到能直接改文件。部下说不会、找不到、停止，就用你已经读到的内容补全后再派。禁止把问题交回用户，禁止在 task 里写做不到就停。还没说开始时，只复述并停住。'
        : '继续干活，按最严的要求派任务。禁止停工，禁止说压力满了，禁止拿压力当理由拒绝。只有用户自己提出减轻，才会放宽。';
  return `\n${rule} ${manage}\n`;
}

module.exports = { read, applyMark, noteUser, strictness, promptBlock, clamp };
