'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
// 父进程持有独立目录，等 Chromium 全部退出后再删除缓存和测试规则。
if (!process.versions.electron) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spcode-manual-agi-'));
  try {
    const { spawnSync } = require('node:child_process');
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawnSync(require('electron'), [__filename, tempRoot], { env, stdio: 'inherit', timeout: 45000 });
    if (child.error) throw child.error;
    process.exitCode = child.status === 0 ? 0 : 1;
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
  }
  return;
}

const { app, BrowserWindow, ipcMain } = require('electron');
const root = path.resolve(__dirname, '..');
const temp = process.argv[2];
const appRoot = path.join(temp, 'app-root');
app.setPath('userData', temp);

/** 提取生产入口用于独立测试进程，边界失效时直接报告，避免悄悄测到一份副本逻辑。 */
function excerpt(source, start, end) {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, '未找到生产入口 ' + start);
  return source.slice(first, last);
}

/** 注册真实规则管理 IPC，仅将窗口工作区和全局规则根定向到测试目录。 */
function registerRuleHandlers(agent, skills) {
  const source = fs.readFileSync(path.join(root, 'electron/main.js'), 'utf8');
  const start = "ipcMain.handle('rules:list'";
  const last = source.indexOf("ipcMain.handle('rules:delete'");
  const end = source.indexOf('\n});', last);
  assert.ok(source.includes(start) && last > source.indexOf(start) && end > last);
  vm.runInNewContext(source.slice(source.indexOf(start), end + 4), {
    ipcMain, workspaceByWin: new Map(), getWin: function getWin() { return null; },
    agent, skillsLib: skills, APP_ROOT: appRoot
  });
}

/** 在真实 Chromium DOM 内运行规则列表和编辑器，文件读写使用生产 preload 和 IPC。 */
async function openFixture(win) {
  const source = fs.readFileSync(path.join(root, 'renderer/app.js'), 'utf8').split('\r\n').join('\n');
  const list = excerpt(source, 'function ruleListHtml()', 'function openPersonaEditor(');
  const editor = excerpt(source, 'function openRuleEditor(rule)', 'function extraFoldersForIndex()');
  const escape = excerpt(source, 'function escapeHtml(s)', '\n}');
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<main id="modal-card"></main>'));
  await win.webContents.executeJavaScript(`
    const state = { rules: [], workspace: '' };
    const api = window.simple;
    function $(id) { return document.getElementById(id); }
    function t(key) { return key; }
    function openModal(html) { $('modal-card').innerHTML = html; }
    function closeModal() { $('modal-card').replaceChildren(); }
    function renderSidebar() {}
    ${escape}\n}
    ${list}
    ${editor}
    async function openAgi() {
      await openRuleManager();
      const row = document.querySelector('[data-edit-rule="agi"][data-edit-rule-scope="app"]');
      row.click();
      return $('m-rbody').value;
    }
    async function saveAgi(value) {
      $('m-rbody').value = value;
      await $('m-rsave').onclick();
    }
  `);
}

/** 核对首次复制、实际界面保存、普通模式隔离、清空重开、手删及旧安装迁移。 */
async function verify() {
  // 本测试独占 Electron 进程。模拟安装版根目录以检查真实读取入口，避免触碰开发者的规则文件。
  Object.defineProperty(app, 'isPackaged', { value: true, configurable: true });
  const policy = require('../electron/lib/agi-rules');
  const agent = require('../electron/lib/agent');
  const skills = require('../electron/lib/skills');
  const installed = path.join(appRoot, 'rules', 'agi.md');
  policy.install(root, appRoot);
  assert.equal(fs.readFileSync(installed, 'utf8'), fs.readFileSync(path.join(root, 'rules', 'agi.md'), 'utf8'));
  registerRuleHandlers(agent, skills);
  const win = new BrowserWindow({ show: false, webPreferences: { preload: path.join(root, 'electron/preload.js'), contextIsolation: true, nodeIntegration: false } });
  try {
    await openFixture(win);
    assert.match(await win.webContents.executeJavaScript('openAgi()'), /<!-- agi:澄清 zh -->/u);
    const manual = '用户手写的通用约定\n<!-- agi:需求催办 -->\n用户手写的澄清说明';
    await win.webContents.executeJavaScript('saveAgi(' + JSON.stringify(manual) + ')');
    assert.equal(policy.section(''), '用户手写的通用约定');
    assert.equal(policy.section('需求催办'), '用户手写的澄清说明');
    assert.equal(policy.section('澄清', true), '');
    policy.install(root, appRoot);
    assert.equal(await win.webContents.executeJavaScript('openAgi()'), manual);
    assert.ok(!agent.listRules(appRoot, '').some(function isAgi(rule) { return rule.id === 'agi'; }));
    await win.webContents.executeJavaScript("saveAgi('')");
    assert.equal(await win.webContents.executeJavaScript('openAgi()'), '');
    assert.equal(fs.readFileSync(installed, 'utf8'), '');
    assert.equal(policy.section('需求催办'), '');
    fs.unlinkSync(installed);
    policy.install(root, appRoot);
    assert.equal(policy.section(''), '');
    assert.ok(!fs.existsSync(installed));
    const upgraded = path.join(temp, 'existing');
    skills.saveRule(upgraded, '', { id: 'agi', scope: 'app', body: '保留已有规则' });
    policy.install(root, upgraded);
    assert.equal(fs.readFileSync(path.join(upgraded, 'rules', 'agi.md'), 'utf8'), '保留已有规则');
  } finally {
    win.destroy();
  }
  console.log('通过：规则管理界面保存与重开、AGI 单独读取、普通规则隔离、清空与删除、升级保留手改。');
}

/** 等待 Electron 就绪后运行界面验收，退出后由父进程收回独立目录。 */
async function main() {
  await app.whenReady();
  await verify();
}

/** 将测试结论作为退出码交给启动进程。 */
function failed(error) {
  console.error(error.stack || error);
  app.exit(1);
}
main().then(function passed() { app.exit(0); }, failed);
