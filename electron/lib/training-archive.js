/**
 * 将一轮对话的真实输入、模型输出与工具轨迹追加为本地训练原始数据。
 * JSONL 保留结构，TXT 提供逐事件全文；不裁剪正文，不推测未返回的模型内部思维。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const context = new AsyncLocalStorage();

/** 只保存模型身份，不把模型配置里的 API Key、请求头等认证设置复制到档案。 */
function modelIdentity(cfg) {
  if (!cfg) return null;
  return { id: cfg.id, name: cfg.name, model: cfg.model, protocol: cfg.protocol,
    type: cfg.type, providerId: cfg.providerId, role: cfg._helperRole };
}

/** 将异常转成可序列化证据；工具控制信号携带的提问和补丁也保留。 */
function errorData(error) {
  return { name: error.name, message: error.message, stack: error.stack,
    code: error.code, status: error.status, patch: error.patch, ask: error.ask };
}

/**
 * 为一个会话的一轮创建独立档案；调用者必须在推理前 flush 确认目录可写。
 * root 为设置中的绝对数据目录；相同 sessionId 跨重启归入同一目录，UUID 避免多实例覆盖。
 * 写入失败保存在 error 中并由 flush 明确抛出，不改写旧档、不回退到别的路径。
 */
function create(root, sessionId, turnId, start) {
  const sessionKey = crypto.createHash('sha256').update(String(sessionId)).digest('hex');
  const stamp = new Date().toISOString().replace(/:/g, '-');
  const dir = path.join(root, sessionKey, stamp + '-' + crypto.randomUUID());
  const jsonl = path.join(dir, 'events.jsonl');
  const text = path.join(dir, 'transcript.txt');
  let sequence = 0;
  const pendingCalls = new Set();
  let error = null;
  let tail = fs.promises.mkdir(dir, { recursive: true }).catch(failed);

  /** 异步写失败必须由 flush 交付；暂存异常避免事件回调产生未处理拒绝。 */
  function failed(value) { error = value; }

  /**
   * 在事件到达时立即序列化，避免后续上下文压缩或对象复用改变历史。
   * 每轮共用一条异步写队列，JSONL 与 TXT 的编号和顺序完全一致。
   */
  function record(kind, data) {
    const row = { schemaVersion: 1, seq: ++sequence, at: new Date().toISOString(),
      sessionId, turnId, kind, data };
    const encoded = JSON.stringify(row);
    const frozen = JSON.parse(encoded);
    const readable = '\n[' + frozen.seq + '] ' + frozen.at + ' ' + kind + '\n' +
      JSON.stringify(frozen.data, null, 2) + '\n';
    /** 每条写入都等待前一条结束；任一失败后停止写入并保留原始错误。 */
    async function append() {
      if (error) return;
      await fs.promises.appendFile(jsonl, encoded + '\n', 'utf8');
      await fs.promises.appendFile(text, readable, 'utf8');
    }
    tail = tail.then(append).catch(failed);
  }

  /** 等待排空全部已收到的事件；返回路径只代表两份文件均已写完。 */
  async function flush() {
    await tail;
    if (error) throw new Error('训练数据保存失败：' + dir + '：' + error.message, { cause: error });
    return { dir, jsonl, text };
  }

  /** 后台画像等模型任务也属于本轮，结束前等待其实际返回，避免结束标记跑到结果前面。 */
  function track(promise) {
    pendingCalls.add(promise);
    function settled() { pendingCalls.delete(promise); }
    promise.then(settled, settled);
    return promise;
  }

  /** 等待本轮调用收尾后追加真实结束状态，再确认两种文件全部落盘。 */
  async function finish(outcome) {
    while (pendingCalls.size) await Promise.allSettled([...pendingCalls]);
    record('turn-end', { outcome });
    return flush();
  }

  record('turn-start', start);
  return { dir, jsonl, text, record, flush, finish, track };
}

/** 返回当前轮次档案；没有处于对话执行上下文时不创建档案。 */
function current() { return context.getStore(); }

/** 将模型和工具的异步调用绑定到指定轮次，多个标签同时执行时互不串档。 */
function run(archive, fn) { return context.run(archive, fn); }

/** 为底层 SDK 提供记录入口；只写实际收到的 SDK 事件。 */
function note(kind, data) {
  const archive = current();
  if (archive) archive.record(kind, data);
}

/**
 * 记录一次真实调用的输入、返回或异常，不更改返回值与抛错语义。
 * archive 可由闭包显式传入，解决直通 MCP 在 HTTP 回调中丢失异步上下文的问题。
 */
async function capture(archive, kind, input, execute) {
  if (!archive) return execute();
  const callId = crypto.randomUUID();
  archive.record(kind + '-start', { callId, input });
  async function invoke() {
    try {
      const result = await execute(callId);
      archive.record(kind + '-result', { callId, result });
      return result;
    } catch (error) {
      archive.record(kind + '-error', { callId, error: errorData(error) });
      throw error;
    }
  }
  return archive.track(run(archive, invoke));
}

/**
 * 记录普通模型实际请求与流式输出，包括未展示的模块返回与中途失败的已接收文本。
 * request 明确选择非认证字段；原有回调照常执行，不代替 UI 流程。
 */
async function model(opts, execute) {
  const archive = current();
  if (!archive) return execute(opts);
  const input = { model: modelIdentity(opts.modelCfg), messages: opts.messages, stream: opts.stream,
    useTools: opts.useTools, toolSpec: opts.toolSpec, toolChoice: opts.toolChoice };
  /** 将每个流片段与本次请求关联；只有原回调存在时才继续通知。 */
  async function invoke(callId) {
    function delta(text) {
      archive.record('model-delta', { callId, channel: 'text', text });
      if (opts.onDelta) opts.onDelta(text);
    }
    function reason(text) {
      archive.record('model-delta', { callId, channel: 'reason', text });
      if (opts.onReason) opts.onReason(text);
    }
    function think(text) {
      archive.record('model-delta', { callId, channel: 'think', text });
      if (opts.onThink) opts.onThink(text);
    }
    return execute({ ...opts, onDelta: delta, onReason: reason, onThink: think });
  }
  return capture(archive, 'model', input, invoke);
}

/**
 * 包住直通请求与 MCP 回包，保留门槛拒绝、插话替换及用户确认后的真实返回。
 * runTool 在指定档案上下文执行，不能依赖 SDK/HTTP 回调继承当前 AsyncLocalStorage。
 */
async function direct(provider, args) {
  const archive = current();
  if (!archive) return provider.runTurn(args);
  const input = { model: modelIdentity(args.modelCfg), key: args.key, fresh: args.fresh,
    firstPrefix: args.firstPrefix, systemContext: args.systemContext, turnText: args.turnText,
    userContent: args.userContent, tools: args.tools, requiredToolNames: args.requiredToolNames,
    agiMode: args.agiMode };
  async function tool(name, toolArgs, toolCallId) {
    async function execute() { return args.runTool(name, toolArgs, toolCallId); }
    return capture(archive, 'bridge-tool', { name, args: toolArgs, toolCallId }, execute);
  }
  /** 全量保留模块事件，再交给上游进行展示裁剪或隐藏。 */
  function event(ev) {
    archive.record('direct-event', ev);
    if (args.onEvent) args.onEvent(ev);
  }
  async function execute() { return provider.runTurn({ ...args, runTool: tool, onEvent: event }); }
  return capture(archive, 'direct', input, execute);
}

module.exports = { create, current, run, note, capture, model, direct, modelIdentity, errorData };
