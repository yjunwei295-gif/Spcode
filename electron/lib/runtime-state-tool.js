/**
 * 将只读状态观察接入普通模型和直通 MCP 共用的 Agent 执行入口。
 * 一轮一个观察器，日志保留完整采样证据；轮次对象释放后快照缓存可被回收。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { createObserver } = require('./runtime-state');
const observers = new WeakMap();

/**
 * 执行一次观察，成功、超时和失败均保留证据位置。
 * 不主动拉起模型、不修改 AGI 开关，也不跨会话借用基线或目标窗口。
 */
async function run(workspace, owner, args, signal, desktop) {
  if (!desktop.isAlive()) throw new Error('运行时观察需要开启 AGI');
  if (!owner || typeof owner !== 'object') throw new Error('缺少当前轮次上下文');
  const epoch = desktop.runtimeEpoch();
  let entry = observers.get(owner);
  /** 关闭后即使再次开启，原等待也不能继续，旧基线不能穿过停止边界。 */
  function active() { return desktop.isAlive() && desktop.runtimeEpoch() === epoch; }
  if (!entry || entry.epoch !== epoch) {
    entry = { epoch, observer: createObserver({ read: desktop.readRuntimeState, active }) };
    observers.set(owner, entry);
  }
  const observer = entry.observer;
  const root = path.join(workspace, 'generated', 'runtime-state');
  fs.mkdirSync(root, { recursive: true });
  const directory = fs.mkdtempSync(path.join(root, 'observation-'));
  const file = path.join(directory, 'events.jsonl');
  const relative = path.relative(workspace, file).split(path.sep).join('/');
  const descriptor = fs.openSync(file, 'wx');
  /** 按顺序追加原始证据；写入失败必须让工具失败，不能伪装成完整记录。 */
  function audit(record) { fs.writeSync(descriptor, JSON.stringify(record) + '\n'); }
  try {
    audit({ type: 'request', at: Date.now(), args });
    const result = await observer.run(args, signal, audit);
    result.evidencePath = relative;
    audit({ type: 'result', ...result });
    return result;
  } catch (error) {
    audit({ type: 'error', at: Date.now(), name: error.name, message: error.message });
    error.message += '；证据：' + relative;
    throw error;
  } finally { fs.closeSync(descriptor); }
}
module.exports = { run };
