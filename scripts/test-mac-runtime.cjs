/**
 * 核对真实 mac 依赖文件的 Mach-O、ZIP 权限与训练实现排除。
 * --build 时用缓存的官方 Electron 外壳重建两种架构并逐包核对，不宣称已在 macOS 执行。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const vm = require('vm');
const { createRequire } = require('module');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { appFileMode, collectAppFiles, buildPackage } = require('./build-mac');
const { ZipReader, ZipWriter } = require('./mac-zip');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'mac-runtime-'));
let checks = 0;
/** 真实校验通过才计数。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 读取 ZIP 原生权限，不通过文件名推测权限。 */
function mode(entry) { return entry.extAttr >>> 16; }
/** 在受控进程下执行生产 RPC 代码，覆盖权限错误与 CLI 自身的退出诊断。 */
function rpcFixture(failure) {
  const file = path.join(root, 'electron/lib/codex-model.js');
  const local = createRequire(file);
  function spawn() {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = function kill() { return true; };
    const methods = [];
    function requested(chunk) {
      const request = JSON.parse(chunk.toString());
      methods.push(request.method);
      if (request.id == null) return;
      const result = request.method === 'initialize' ? {} : { data: [{ model: 'fixture' }], methods };
      child.stdout.write(JSON.stringify({ id: request.id, result }) + '\n');
    }
    if (failure === 'success') child.stdin.on('data', requested);
    function respond() {
      if (failure === 'success') return;
      if (failure === 'permission') child.emit('error', Object.assign(new Error('spawn EACCES'), { code: 'EACCES' }));
      else { child.stderr.write('真实CLI诊断'); child.emit('exit', 126, null); }
    }
    process.nextTick(respond);
    return child;
  }
  function dependency(name) {
    if (name === 'child_process') return { spawn };
    if (name === './codex-env') return function env() { return {}; };
    return local(name);
  }
  dependency.resolve = local.resolve;
  const context = { require: dependency, module: { exports: {} }, process, console, Buffer, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(file, 'utf8') + '\nmodule.exports.rpc = readAppServerRpc;', context, { filename: file });
  return context.module.exports.rpc;
}
/** 二进制与脚本权限、应用资源清单和完整包一起核对。 */
async function main() {
  const pkg = require('../package.json');
  const arches = ['arm64', 'x64'];
  const results = [];
  for (const arch of arches) {
    const collected = collectAppFiles(pkg.version, arch);
    const natives = collected.files.filter(function binary(f) { return f.name.includes('@openai/codex-darwin-' + arch + '/') && f.name.endsWith('/bin/codex'); });
    check(natives.length === 1 && appFileMode(natives[0].abs) === 0o100755, arch + '真实 Codex Mach-O 保留执行权限');
    check(!collected.files.some(function privateFile(f) { return f.name.endsWith('/training-archive.js'); }), arch + '发布资源排除训练采集实现');
    const shim = collected.files.find(function script(f) { return f.name.endsWith('/@openai/codex/bin/codex.js'); });
    check(shim && appFileMode(shim.abs) === 0o100755, arch + 'CLI shebang 入口保留执行权限');
    const ordinary = collected.files.find(function config(f) { return f.name.endsWith('/electron/lib/codex-model.js'); });
    check(appFileMode(ordinary.abs) === 0o100644, arch + '普通源码保持只读资源权限');
    const fixture = path.join(output, arch + '-permission.zip');
    const writer = new ZipWriter(fixture);
    writer.addFile('bin/codex', fs.readFileSync(natives[0].abs), { mode: appFileMode(natives[0].abs) });
    writer.finish();
    const reader = new ZipReader(fixture);
    check(mode(reader.entries[0]) === 0o100755 && reader.readContent(reader.entries[0]).length === fs.statSync(natives[0].abs).size, arch + '真实二进制写入ZIP后字节与可执行权限均完整');
    reader.close();
    if (process.argv.includes('--build')) {
      const electronVersion = require('../node_modules/electron/package.json').version;
      const zipPath = path.join(root, 'dist/.mac-cache', 'electron-v' + electronVersion + '-darwin-' + arch + '.zip');
      const outPath = path.join(output, 'SimpleCode-' + pkg.version + '-mac-' + arch + '.zip');
      await buildPackage({ arch, version: pkg.version, zipPath, outPath });
      const built = new ZipReader(outPath);
      const entry = built.entries.find(function codex(f) { return f.name.endsWith('/@openai/codex-darwin-' + arch + '/vendor/' + (arch === 'arm64' ? 'aarch64' : 'x86_64') + '-apple-darwin/bin/codex'); });
      check(entry && mode(entry) === 0o100755, arch + '完整应用包中的Codex实际为0755');
      check(!built.entries.some(function absent(e) { return e.name.endsWith('/training-archive.js'); }), arch + '完整应用包实际不含训练采集实现');
      const bridge = built.entries.find(function adapter(e) { return e.name.endsWith('/training-recorder.js'); });
      check(bridge && built.readContent(bridge).toString('utf8').includes('app.isPackaged'), arch + '发布适配器保持硬性禁用边界');
      const source = new ZipReader(zipPath);
      const links = source.entries.filter(function symlink(e) { return (mode(e) & 0o170000) === 0o120000; });
      const rebuiltLinks = built.entries.filter(function symlink(e) { return (mode(e) & 0o170000) === 0o120000; });
      check(links.length === rebuiltLinks.length && links.length > 0, arch + 'Electron外壳符号链接完整保留');
      source.close(); built.close();
      results.push({ arch, outPath, bytes: fs.statSync(outPath).size });
    }
  }
  const success = await rpcFixture('success')('model/list', { limit: 100 });
  check(success.data[0].model === 'fixture' && success.methods.join(',') === 'initialize,initialized,model/list', 'RPC成功路径按真实握手顺序交付模型目录');
  await assert.rejects(rpcFixture('permission')('model/list', {}), /EACCES/);
  check(true, 'EACCES 不再被改写成登录或版本错误');
  await assert.rejects(rpcFixture('exit')('model/list', {}), /code=126.*\n真实CLI诊断/);
  check(true, '保留CLI退出码和stderr原始诊断');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, results, nativeExecution: '当前为Windows，未在macOS执行' }, null, 2));
  console.log(JSON.stringify({ checks, output, results }));
}
main().catch(function failed(error) { console.error(error); process.exitCode = 1; });
