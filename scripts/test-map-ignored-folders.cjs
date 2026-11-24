'use strict';

/** 用独立的 Electron 窗口和临时项目验证忽略目录，从设置按钮一直核对到实际磁盘访问。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, dialog } = require('electron');

const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-map-folders-'));
const workspace = path.join(fixture, '项目');
const ignored = path.join(workspace, '素材');
const sibling = path.join(workspace, '素材库');
const extra = path.join(fixture, '附加目录');
const ignoredFile = path.join(ignored, '内部', 'hidden.js');
const keepFile = path.join(sibling, 'keep.js');
const profile = path.join(fixture, 'user-data');
for (const dir of [path.dirname(ignoredFile), sibling, extra, profile]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(ignoredFile, 'function hiddenFunction() { return 1; }');
fs.writeFileSync(keepFile, 'require("../素材/内部/hidden");');
fs.writeFileSync(path.join(extra, 'extra.js'), 'const extra = 1;');
app.setName('SpCodeMapIgnoreTest');
app.setPath('userData', profile);
app.setPath('sessionData', profile);
fs.writeFileSync(path.join(profile, 'settings.json'), JSON.stringify({
  onboardingCompleted: true, autoSave: false, desktopAlive: false, trainingDataEnabled: false, locale: 'zh'
}));

const index = require('../electron/lib/code-index');
const embed = require('../electron/lib/code-embed');
const retrieve = require('../electron/lib/memory-retrieve');
const protocol = require('../electron/lib/api-protocol');
let chosen = workspace;
let win;

/** 只替代系统选目录对话框和模型计算，使真实的界面、IPC、扫描、缓存与磁盘写入均在本机运行。 */
dialog.showOpenDialog = async function pickDirectory() {
  return { canceled: !chosen, filePaths: chosen ? [chosen] : [] };
};
retrieve.embedText = async function constantVector() { return [1]; };

/** 等待实际页面或索引满足断言，超时报告正在等待的动作。 */
async function until(check, description) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error('超时：' + description);
}

/** 在生产页面执行 DOM 操作，通过 preload 调用原有的项目接口。 */
function page(expression) { return win.webContents.executeJavaScript(expression); }

/** 在记录期间只观察给定目录及其后代；访问仍由原文件系统执行，避免吞错误造成假通过。 */
function recordAccess(folders) {
  const hits = [];
  const originals = new Map();
  for (const name of ['readdirSync', 'existsSync', 'statSync', 'readFileSync']) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = function observe(file, ...args) {
      if (typeof file === 'string') {
        for (const folder of folders) {
          const rel = path.relative(folder, file);
          if (rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))) {
            hits.push(name + ' ' + file);
          }
        }
      }
      return original.call(this, file, ...args);
    };
  }
  /** 停止本次记录后返回完整的命中列表，正常对照和忽略断言共用。 */
  return function stop() {
    for (const [name, method] of originals) fs[name] = method;
    return hits;
  };
}

/** 点击忽略或取消按钮后等待列表变动，再核对主进程实际保存的选择。 */
async function toggleFolder(add) {
  chosen = ignored;
  await page(add ? "document.querySelector('#idx-ignore-add').click()" : "document.querySelector('#idx-ignore-list button').click()");
  await until(async function settled() {
    return await page("document.querySelectorAll('#idx-ignore-list button').length") === Number(add);
  }, '更新忽略目录列表');
  assert.deepEqual(await page('simple.indexGetIgnoredFolders()'), add ? [ignored] : []);
}

/** 通过设置页绘图，用两处代码索引的真实产物核对初次扫描、缓存清理、增量、恢复与进行中归纳。 */
async function verify() {
  require('../electron/main');
  await until(async function ready() {
    win = BrowserWindow.getAllWindows().find(function mainWindow(w) {
      return w.webContents.getURL().endsWith('/renderer/index.html');
    });
    return win && !win.webContents.isLoading() && await page("typeof document.querySelector('#btn-open')?.onclick === 'function'");
  }, '生产主窗口');
  await page("document.querySelector('#btn-open').click()");
  await until(function opened() {
    return page("document.querySelector('#status-ws').textContent === " + JSON.stringify(workspace));
  }, '打开临时项目');
  await page("document.querySelector('#btn-more').click()");
  await until(function enabled() { return page("document.querySelector('#idx-ignore-add')?.disabled === false"); }, '设置卡片');
  chosen = null;
  await page("document.querySelector('#idx-ignore-add').click()");
  await until(function cancelled() { return page("!document.querySelector('#idx-ignore-add').disabled"); }, '取消目录选择');
  assert.deepEqual(index.getIgnoredFolders(workspace), []);

  const baseline = recordAccess([ignored]);
  await page("document.querySelector('#idx-sync').click()");
  await until(function drawn() { return index.getStatus(workspace).files === 2; }, '首次从设置绘图');
  await embed.ensureIndex(workspace, []);
  const before = baseline();
  assert.ok(before.some(function entered(s) { return s === 'readdirSync ' + ignored; }));
  assert.ok(before.some(function readHidden(s) { return s.startsWith('readFileSync ') && path.normalize(s.slice(13)) === ignoredFile; }));
  const originalMap = index.getMap(workspace);
  assert.ok(originalMap.edges.length > 0);
  assert.equal((await embed.searchHits(workspace, [], { query: '检索' })).length, 2);

  // 保留未完成的归纳，模拟用户在它等待结果时添加忽略规则。
  let finishSummary;
  protocol.complete = function delayedSummary() {
    return new Promise(function hold(resolve) { finishSummary = resolve; });
  };
  const pending = index.summarizeOne(workspace, '素材/内部/hidden.js', { type: 'api', protocol: 'openai', model: 'fixture' });
  await until(function waiting() { return !!finishSummary; }, '归纳进入等待');
  const stop = recordAccess([ignored, extra]);
  await toggleFolder(true);
  finishSummary(JSON.stringify([{ name: 'hiddenFunction', desc: '返回数字', keyValues: '' }]));
  assert.equal((await pending).reason, 'stale');

  const pruned = await page('simple.indexGetMap()');
  assert.deepEqual(pruned.nodes.map(function id(n) { return n.id; }), ['素材库/keep.js']);
  assert.deepEqual(pruned.edges, []);
  assert.deepEqual(pruned.dirs, ['素材库']);
  assert.deepEqual(pruned.nodes[0].deps, []);
  assert.equal((await embed.searchHits(workspace, [], { query: '检索' })).length, 1);
  // 独立附加根和指向忽略子目录的附加根都不能让遍历重新进入。
  index.changeIgnoredFolder(workspace, extra, true, [extra]);
  const roots = [extra, path.dirname(ignoredFile)];
  const map = await index.ensureIndex(workspace, roots);
  const vectors = await embed.ensureIndex(workspace, roots);
  assert.equal(map.nodes.length, 1);
  assert.equal(vectors.files, 1);
  index.noteDiskChange(workspace, path.relative(workspace, ignoredFile));
  assert.equal(index.getMap(workspace).nodes.length, 1);
  assert.equal(index.upsertFile(workspace, ignoredFile, roots), false);
  await embed.upsertFile(workspace, ignoredFile, roots);
  assert.deepEqual(stop(), [], '忽略后不能枚举目录、探测文件或读取内容');
  assert.deepEqual(index.getIgnoredFolders(extra), []);
  await index.deleteIndex(workspace);
  assert.deepEqual(index.getIgnoredFolders(workspace), [ignored, extra]);
  index.changeIgnoredFolder(workspace, extra, false, []);
  await toggleFolder(false);
  await page("document.querySelector('#idx-sync').click()");
  await until(function restored() { return index.getStatus(workspace).files === 2; }, '取消忽略后重新绘图');
  assert.equal((await embed.ensureIndex(workspace, [])).files, 2);
  assert.equal(index.getMap(workspace).edges.length, originalMap.edges.length);
  console.log('PASS 设置添加/取消、旧地图清理、同名前缀、附加根、后台归纳、增量更新、双索引重绘；忽略目录访问次数为 0');
}

/** 退出隔离的测试实例，断言错误以非零退出码传给调用方。 */
verify().then(function passed() { app.exit(0); }, function failed(error) { console.error(error); app.exit(1); });
