/**
 * 用真实文件、并发轮次及独立异步回调核对训练归档，不调用外部模型。
 * 发布适配器在无采集模块的环境加载，验证设置无法绕过发布边界。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { AsyncResource } = require('node:async_hooks');
const archive = require('../electron/lib/training-archive');
const root = path.resolve(__dirname, '..');
const output = fs.mkdtempSync(path.join(root, 'generated', 'training-archive-'));
let checks = 0;
/** 只有真实结果满足条件才记通过。 */
function check(value, label) { assert.ok(value, label); checks++; console.log('PASS ' + label); }
/** 读取完整 JSONL，任一行被截断或损坏都会抛错。 */
function rows(trace) { return fs.readFileSync(trace.jsonl, 'utf8').trim().split('\n').map(JSON.parse); }
/** 发布包只允许适配器访问 electron，不允许加载被排除的采集实现。 */
function packaged(name) {
  assert.equal(name, 'electron');
  return { app: { isPackaged: true } };
}
/** 覆盖全文、流片段、异常、中止、会话隔离及发布禁用。 */
async function main() {
  const a = archive.create(output, 'session-A', 'turn-1', { text: '用户原文 中文' });
  const b = archive.create(output, 'session-B', 'turn-2', { text: '另一个用户' });
  await Promise.all([a.flush(), b.flush()]);
  const long = '完整结果中文'.repeat(12000);
  const source = { text: long };
  a.record('immutable', source);
  source.text = '后续被修改';
  const orphan = new AsyncResource('外部MCP');
  async function raw(opts) {
    opts.onReason('接口公开的推理摘要');
    opts.onDelta('回答第一段');
    opts.onThink('执行状态');
    return { role: 'assistant', content: '最终回答', reasoning_content: '返回的公开推理摘要' };
  }
  async function modelTask() {
    return archive.model({ modelCfg: { id: 'fixture', model: 'test', apiKey: '不应存入模型身份' },
      messages: [{ role: 'system', content: '规则原文' }, { role: 'user', content: '用户原文' }],
      stream: true, useTools: true, toolSpec: [{ name: 'read_file' }] }, raw);
  }
  async function originalTool(name, args) {
    check(archive.current() === a, '外部 MCP 回调重新进入正确轮次');
    archive.note('sdk-event', { provider: 'fixture', event: { type: 'reasoning', text: '供应商公开摘要' } });
    return { name, args, text: long };
  }
  async function directTask(args) {
    args.onEvent({ type: 'reason', text: '直通公开摘要' });
    return orphan.runInAsyncScope(args.runTool, null, 'read_file', { path: 'fixture.txt' }, 'sdk-call-1');
  }
  async function direct() {
    return archive.direct({ runTurn: directTask }, { key: 'key', modelCfg: { model: 'direct' },
      firstPrefix: '完整规则', turnText: '执行操作', tools: [{ name: 'read_file' }], runTool: originalTool });
  }
  async function other() { archive.note('event', { text: '只属于B' }); return 'B'; }
  await Promise.all([archive.run(a, modelTask), archive.run(a, direct), archive.run(b, other)]);
  const stop = Object.assign(new Error('用户停止'), { name: 'AbortError', code: 'aborted' });
  async function fail() { throw stop; }
  await assert.rejects(archive.capture(a, 'tool', { name: 'fixture' }, fail), function same(e) { return e === stop; });
  check(true, '归档不吞掉或更换工具原异常');
  /** 模拟原有后台画像模型，它必须在结束标记前完成记录。 */
  async function background() { await new Promise(function delay(resolve) { setTimeout(resolve, 20); }); return '后台返回'; }
  archive.capture(a, 'background', {}, background);
  await Promise.all([a.finish('stopped'), b.finish('success')]);
  const ar = rows(a), br = rows(b);
  check(ar[0].kind === 'turn-start' && ar.at(-1).kind === 'turn-end' && ar.at(-1).data.outcome === 'stopped', '开始与停止状态完整落盘');
  check(ar.some(function full(r) { return r.kind === 'immutable' && r.data.text === long; }), '长正文不截断且捕获后不随对象变化');
  check(ar.filter(function delta(r) { return r.kind === 'model-delta'; }).length === 3, '普通模型的回答、公开推理和执行状态流均保存');
  check(ar.some(function result(r) { return r.kind === 'model-result' && r.data.result.content === '最终回答'; }), '普通模型最终原始返回保存');
  check(ar.some(function bridge(r) { return r.kind === 'bridge-tool-result' && r.data.result.text === long; }), '直通工具参数与完整回包保存');
  check(ar.some(function sdk(r) { return r.kind === 'sdk-event'; }), 'SDK 返回事件保存');
  check(ar.at(-2).kind === 'background-result', '结束标记等待后台模型实际返回');
  check(!JSON.stringify(ar).includes('只属于B') && br.some(function event(r) { return r.data.text === '只属于B'; }), '并发会话隔离');
  check(ar.every(function seq(r, i) { return r.seq === i + 1 && r.schemaVersion === 1 && !!r.at; }), '序号、版本与时间戳连续');
  const readable = fs.readFileSync(a.text, 'utf8');
  check(readable.includes(long) && readable.includes('用户停止') && !readable.includes('\uFFFD'), 'TXT 全文、错误与中文编码完整');
  check(!JSON.stringify(ar).includes('不应存入模型身份'), '模型身份不复制认证配置');
  const again = archive.create(output, 'session-A', 'turn-1', { text: '同编号新实例' });
  await again.finish('success');
  check(path.dirname(again.dir) === path.dirname(a.dir) && again.dir !== a.dir, '重启复用会话目录且不会覆盖旧轮次');
  const blocked = path.join(output, 'not-a-directory');
  fs.writeFileSync(blocked, '文件占用目录');
  const broken = archive.create(blocked, 'session', 'turn', {});
  await assert.rejects(broken.flush(), /训练数据保存失败/);
  check(true, '目录不可写明确报错，不静默改存别处');
  const adapter = { require: packaged, module: { exports: {} } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'electron/lib/training-recorder.js'), 'utf8'), adapter);
  const pub = adapter.module.exports;
  check(pub.current() === null && !pub.create, '发布版无采集上下文及创建接口，未加载采集实现');
  const response = await pub.model({ request: true }, async function passthrough(value) { return value; });
  check(response.request && await pub.capture(null, 'tool', {}, async function value() { return 7; }) === 7, '发布版模型与工具正常执行');
  const pkg = require('../package.json'), dev = require('../build.dev.json');
  check(pkg.build.files.includes('!electron/lib/training-archive.js') && dev.files.includes('!electron/lib/training-archive.js'), '两套 Windows 打包配置均排除采集实现');
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify({ checks, archive: a.dir }, null, 2));
  console.log(JSON.stringify({ checks, output }));
}
/** 失败保留测试产物与原始错误。 */
main().catch(function failed(error) { console.error(error); process.exitCode = 1; });
