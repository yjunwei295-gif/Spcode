/**
 * 本轮内的结构化运行时观察：完整快照、增量对比和可取消条件等待。
 * 原始采样与变化写入调用方提供的证据日志，不调用 OCR、模型或任何写内存接口。
 */
'use strict';
const { randomUUID } = require('crypto');
const { isDeepStrictEqual } = require('util');
const memory = require('./process-memory');

/** 集中限制单次读取、快照数量与等待时长；采样频率由工具调用者明确指定。 */
const LIMITS = Object.freeze({ snapshots: 16, fields: 16, bytes: 4096, timeoutMs: 30000, minIntervalMs: 100, maxIntervalMs: 5000 });
const toolSpec = { type: 'function', function: {
  name: 'runtime_state',
  description: '低开销只读运行时观察，无截图/OCR/模型调用。snapshot 获取窗口或明确控件/内存字段，diff 对比本轮 snapshotId，wait 在本地等待明确条件。窗口 hwnd/PID 来自 windows 快照，内存地址来自 process_memory 等实际结果。基线只在当前轮次保留最近16份。wait 必须给 timeoutMs/intervalMs，返回 matched 或 timeout、真实采样间隔和本地证据路径；采样之间的短暂变化可能漏掉。控件使用精确 name/automationId，可加 type；多个匹配直接失败。不支持的属性不会被当成空值。此工具不创建 screen_read 的 c编号，不执行点击或写内存；视觉内容仍用看图工具。',
  parameters: { type: 'object', properties: {
    action: { type: 'string', enum: ['snapshot', 'diff', 'wait'] },
    source: { type: 'string', enum: ['windows', 'controls', 'memory'] },
    target: { type: 'object', properties: { pid: { type: 'integer' }, hwnd: { type: 'string', description: 'windows 快照中的十进制窗口句柄' } }, required: ['pid'] },
    controls: { type: 'array', maxItems: LIMITS.fields, items: { type: 'object', properties: {
      key: { type: 'string' }, name: { type: 'string' }, automationId: { type: 'string' }, type: { type: 'string' }
    }, required: ['key'] } },
    memory: { type: 'array', maxItems: LIMITS.fields, items: { type: 'object', properties: {
      key: { type: 'string' }, address: { type: 'string' }, length: { type: 'integer' },
      dataType: memory.toolSpec.function.parameters.properties.dataType
    }, required: ['key', 'address', 'length', 'dataType'] } },
    baseline: { type: 'string', description: '同一查询先前返回的 snapshotId；diff 与 changed 条件必填' },
    condition: { type: 'object', properties: {
      key: { type: 'string' }, field: { type: 'string' },
      operator: { type: 'string', enum: ['eq', 'ne', 'exists', 'absent', 'changed'] },
      value: { description: 'eq/ne 的严格类型目标值；内存数值 value 为数组，64位整数为字符串数组' }
    }, required: ['key', 'operator'] },
    timeoutMs: { type: 'integer', description: 'wait 显式指定总等待时间，1至30000毫秒，包含采集耗时' },
    intervalMs: { type: 'integer', description: 'wait 显式指定每次采集结束后的等待，100至5000毫秒' }
  }, required: ['action', 'source'] }
} };

/** 只接受有边界的明确查询；不猜进程、字段含义或选择器，返回固定顺序的查询用于基线核对。 */
function queryOf(args) {
  if (!['snapshot', 'diff', 'wait'].includes(args.action)) throw new Error('未知状态操作');
  if (!['windows', 'controls', 'memory'].includes(args.source)) throw new Error('未知状态来源');
  const query = { source: args.source };
  if (args.target !== undefined) {
    if (!Number.isInteger(args.target.pid) || args.target.pid <= 0) throw new Error('必须明确有效 PID');
    query.target = { pid: args.target.pid };
  }
  if (args.source === 'windows') return query;
  if (!query.target) throw new Error('控件或内存查询必须指定 target.pid');
  const fields = args[args.source];
  if (!Array.isArray(fields) || !fields.length || fields.length > LIMITS.fields) throw new Error('明确指定1至16个字段');
  const keys = new Set();
  query[args.source] = [];
  let bytes = 0;
  if (args.source === 'controls') {
    if (typeof args.target.hwnd !== 'string' || !/^[1-9][0-9]*$/.test(args.target.hwnd) || BigInt(args.target.hwnd) > 0x7fffffffffffffffn) throw new Error('必须使用实际窗口十进制句柄');
    query.target.hwnd = args.target.hwnd;
  }
  for (const field of fields) {
    if (typeof field.key !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(field.key) || keys.has(field.key)) throw new Error('字段 key 必须唯一且为1至64位字母、数字、下划线或连字符');
    keys.add(field.key);
    if (args.source === 'controls') {
      if (field.name === undefined && field.automationId === undefined) throw new Error('控件必须提供精确 name 或 automationId');
      const selector = { key: field.key };
      for (const property of ['name', 'automationId', 'type']) {
        if (field[property] === undefined) continue;
        if (typeof field[property] !== 'string' || !field[property].length) throw new Error('选择器属性必须为非空字符串');
        selector[property] = field[property];
      }
      query.controls.push(selector);
    } else {
      memory.validate({ action: 'read', pid: query.target.pid, address: field.address, length: field.length, dataType: field.dataType });
      // 解码前核对数值对齐，避免已经启动采样后才发现请求本身无效。
      if (field.dataType === 'utf16' && field.length % 2) throw new Error('utf16 长度必须为2的整数倍');
      if (!['bytes', 'utf8', 'utf16'].includes(field.dataType)) memory.decode(Buffer.alloc(field.length), field.dataType);
      bytes += field.length;
      query.memory.push({ key: field.key, address: field.address, length: field.length, dataType: field.dataType });
    }
  }
  if (bytes > LIMITS.bytes) throw new Error('单次内存字段总长不能超过4096字节');
  return query;
}

/** 按对象键比较记录；保留新增、移除、字段删除及类型变化，不把重复采样当成事件。 */
function difference(before, after) {
  const changes = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const had = Object.hasOwn(before, key);
    const has = Object.hasOwn(after, key);
    if (!had) changes.push({ key, kind: 'added', after: after[key] });
    else if (!has) changes.push({ key, kind: 'removed', before: before[key] });
    else if (!isDeepStrictEqual(before[key], after[key])) changes.push({ key, kind: 'updated', before: before[key], after: after[key] });
  }
  return changes;
}

/** 精确判断一个对象或字段；缺失对象只能满足 absent，未提供的属性不能冒充空值或“不等于”。 */
function matches(condition, records, baseline) {
  const present = Object.hasOwn(records, condition.key);
  if (condition.operator === 'exists') return present;
  if (condition.operator === 'absent') return !present;
  if (!present) return false;
  if (!Object.hasOwn(records[condition.key], condition.field)) throw new Error('目标未提供属性：' + condition.field);
  const value = records[condition.key][condition.field];
  if (condition.operator === 'changed') {
    if (!Object.hasOwn(baseline, condition.key) || !Object.hasOwn(baseline[condition.key], condition.field)) throw new Error('基线没有要比较的字段');
    return !isDeepStrictEqual(value, baseline[condition.key][condition.field]);
  }
  const equal = isDeepStrictEqual(value, condition.value);
  return condition.operator === 'eq' ? equal : !equal;
}

/** 等待结束或取消即移除定时器和监听；取消不触发下一次采样。 */
function pause(ms, signal) {
  return new Promise(function wait(resolve, reject) {
    if (signal && signal.aborted) { reject(aborted()); return; }
    const timer = setTimeout(done, ms);
    function done() {
      if (signal) signal.removeEventListener('abort', cancel);
      resolve();
    }
    function cancel() {
      clearTimeout(timer);
      signal.removeEventListener('abort', cancel);
      reject(aborted());
    }
    if (signal) signal.addEventListener('abort', cancel, { once: true });
  });
}

/** 为用户停止构造标准中断错误，不把取消包装成成功或超时。 */
function aborted() {
  const error = new Error('运行时观察已停止');
  error.name = 'AbortError';
  return error;
}

/**
 * 创建一轮独享的观察器；read 只读本机，active 检查 AGI 开关，audit 同步落盘。
 * 缓存最多保留16份完整快照；失效或查询不一致的基线必须重新采集，不跨轮次复用。
 */
function createObserver({ read, active }) {
  const snapshots = new Map();
  async function run(args, signal, audit) {
    const query = queryOf(args);
    const signature = JSON.stringify(query);
    const started = Date.now();
    let baseline;
    if (args.baseline !== undefined) {
      baseline = snapshots.get(args.baseline);
      if (!baseline) throw new Error('基线不存在或已过期，请重新 snapshot');
      if (baseline.signature !== signature) throw new Error('基线与当前查询不一致');
    }
    if (args.action === 'diff' && !baseline) throw new Error('diff 必须提供 baseline');
    if (args.action === 'wait') validateWait(args, query, baseline);
    let previous = baseline;
    let first;
    let current;
    let polls = 0;
    let maxGapMs = 0;
    let status = 'observed';
    const deadline = started + args.timeoutMs;
    while (true) {
      checkActive(signal, active);
      current = await read(query);
      checkActive(signal, active);
      if (!current.ok) throw new Error('状态采集失败');
      if (current.source !== query.source || !current.records || !current.identity) throw new Error('状态来源或身份无效');
      if (previous && previous.identity !== current.identity) throw new Error('目标进程或窗口身份已改变');
      if (query.source === 'memory') {
        // 原始字节只留在本地证据与有界缓存，模型默认只接收类型值。
        const rawMemory = current.records;
        const records = Object.create(null);
        for (const field of query.memory) {
          const bytes = Buffer.from(current.records[field.key].base64, 'base64');
          if (bytes.length !== field.length) throw new Error('内存返回长度不完整');
          const value = memory.decode(bytes, field.dataType);
          if (Array.isArray(value)) {
            for (const number of value) {
              if (typeof number === 'number' && !Number.isFinite(number)) throw new Error('内存包含非有限数值，不能无损序列化为 JSON');
            }
          }
          records[field.key] = { address: field.address, dataType: field.dataType, value };
        }
        current.records = records;
        current.rawMemory = rawMemory;
      }
      polls++;
      if (previous && polls > 1) maxGapMs = Math.max(maxGapMs, current.observedAt - previous.observedAt);
      const changes = previous ? difference(previous.records, current.records) : [];
      if (!first) first = current;
      // 首次与每次变化保留原始记录，未变化只累计次数；包含终态的汇总由调用方追加。
      if (polls === 1 || changes.length) audit({ type: 'sample', poll: polls, ...current, changes });
      if (args.action !== 'wait') break;
      if (Date.now() > deadline) { status = 'timeout'; break; }
      if (matches(args.condition, current.records, baseline && baseline.records)) { status = 'matched'; break; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { status = 'timeout'; break; }
      previous = current;
      await pause(Math.min(args.intervalMs, remaining), signal);
      if (Date.now() >= deadline) { status = 'timeout'; break; }
    }
    const snapshotId = randomUUID();
    snapshots.set(snapshotId, { ...current, signature });
    if (snapshots.size > LIMITS.snapshots) snapshots.delete(snapshots.keys().next().value);
    const result = { status, snapshotId, source: query.source, identity: current.identity,
      startedAt: current.startedAt, observedAt: current.observedAt, polls,
      elapsedMs: Date.now() - started, maxGapMs, sampling: true };
    if (args.action === 'snapshot') result.records = current.records;
    else result.changes = difference((baseline || first).records, current.records);
    if (args.action === 'wait') {
      result.intervalMs = args.intervalMs;
      result.condition = args.condition;
      if (Object.hasOwn(current.records, args.condition.key)) result.record = current.records[args.condition.key];
    }
    return result;
  }
  return { run };
}

/** 等待只接受明确的条件、总时长和间隔，不以缺失字段、任意表达式或模型猜测决定成功。 */
function validateWait(args, query, baseline) {
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 1 || args.timeoutMs > LIMITS.timeoutMs) throw new Error('timeoutMs 必须为1至30000');
  if (!Number.isInteger(args.intervalMs) || args.intervalMs < LIMITS.minIntervalMs || args.intervalMs > LIMITS.maxIntervalMs) throw new Error('intervalMs 必须为100至5000');
  const c = args.condition;
  if (!c || typeof c.key !== 'string' || !['eq', 'ne', 'exists', 'absent', 'changed'].includes(c.operator)) throw new Error('必须提供明确的等待条件');
  if (query.source !== 'windows') {
    let known = false;
    for (const field of query[query.source]) if (field.key === c.key) known = true;
    if (!known) throw new Error('条件 key 不在查询字段中');
  }
  if (!['exists', 'absent'].includes(c.operator) && (typeof c.field !== 'string' || !c.field.length)) throw new Error('比较条件必须指定 field');
  if (['eq', 'ne'].includes(c.operator) && !Object.hasOwn(c, 'value')) throw new Error('eq/ne 必须提供 value');
  if (c.operator === 'changed' && !baseline) throw new Error('changed 必须提供 baseline');
}

/** 采样前后均核对用户停止和 AGI 状态；关闭期间收到的旧回包不进入结果缓存。 */
function checkActive(signal, active) {
  if (signal && signal.aborted) throw aborted();
  if (!active()) throw aborted();
}
module.exports = { toolSpec, LIMITS, createObserver, queryOf, difference, matches };
