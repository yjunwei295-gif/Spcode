'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isInside, resolveAllowed } = require('./workspace');

const name = 'run_agi_parallel';
const finishName = 'finish_agi_task';

/**
 * 核对现有目标或新文件最近的现有父目录，识别跨项目的符号链接和目录联接。
 * @param {string} rootReal 已解析真实位置的项目根目录。
 * @param {string} absolute 已核对字面路径位于项目内的目标。
 * @returns {boolean} 实际访问仍在当前项目范围内。
 */
function isRealProjectPath(rootReal, absolute) {
  let parent = absolute;
  while (!fs.lstatSync(parent, { throwIfNoEntry: false })) parent = path.dirname(parent);
  return isInside(rootReal, fs.realpathSync(parent));
}

/**
 * 校验子代理的文件路径与命令启动目录。附加目录不纳入此轮子代理的项目范围。
 * @param {string} workspace 启动子代理时主会话所在的项目。
 * @param {string} toolName 实际调用的工具名。
 * @param {object} args 本次工具参数。
 * @returns {string} 未通过时的具体原因；空串表示可交给原工具。
 */
function projectDenial(workspace, toolName, args) {
  const fields = ['path', 'module', 'sourcePath', 'audioPath', 'imagePath', 'manifest', 'outPath'];
  if (toolName === 'sheet_to_wps' && String(args.mode || '').trim().toLowerCase() !== 'paste' && !String(args.outPath || '').trim()) {
    return '子代理只在当前项目保存文件，请提供项目内的 outPath。';
  }
  const targets = [];
  for (const field of fields) {
    if (typeof args[field] === 'string' && args[field].trim()) targets.push(args[field]);
  }
  // 调用前与命令执行器一样清理 cwd，确保核对和实际启动的是同一目录。
  if (toolName === 'run_command' && args.cwd) targets.push(String(args.cwd).trim() || '.');
  if (!targets.length) return '';
  if (!workspace) return '子代理需要先绑定项目，才能访问项目路径。';
  const rootReal = fs.realpathSync(workspace);
  for (const target of targets) {
    const absolute = toolName === 'run_command' ? path.resolve(workspace, target) : resolveAllowed(workspace, [], target);
    if (!isInside(workspace, absolute) || !isRealProjectPath(rootReal, absolute)) {
      return '子代理只能访问发起任务的项目，当前路径超出范围。';
    }
  }
  return '';
}

/** 提供给本轮 AGI 主会话的入口。每个目标引用用户原话，桌面目标共享同一个前台。 */
const tool = {
  type: 'function',
  function: {
    name,
    description: '同一轮只启动一次并发批次，执行用户明确要求的多个独立目标。一次提交全部互不依赖的目标，逐项引用用户原文。桌面任务依次执行，项目任务可与桌面一起推进。工具若先返回运行中，由宿主等结果并自动续接；结束本次生成，不要重复调用。收到实际结果后逐项核对。',
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: {
              goal: { type: 'string', description: '完整引用这一项目标在当前用户原话中的连续文本。' },
              resource: { type: 'string', enum: ['desktop', 'project'], description: '需要操作或观察前台用 desktop，文件、代码和后台项目命令用 project。各桌面子代理依次独占前台，接手后先核对目标窗口和焦点。' }
            },
            required: ['goal', 'resource']
          }
        }
      },
      required: ['tasks']
    }
  }
};

/** 子会话提交该项目标的结果，供主会话逐项核对。 */
const finishTool = {
  type: 'function',
  function: {
    name: finishName,
    description: '提交当前独立任务的最终结果。完成时写出实际达成的结果和验证证据，受阻时写出原因及已有成果。完成后结束此会话。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'blocked'] },
        result: { type: 'string', description: '简短交代实际结果、验收证据或剩余阻塞。' }
      },
      required: ['status', 'result']
    }
  }
};

/**
 * 在直通工具的短等待窗口内尝试返回完整批次回执。
 * @param {Promise<string>} result 仍由宿主运行的并发批次回执。
 * @param {number} waitMs 工具初次等待的毫秒数，默认 15 秒，留足直通传输的超时余量。
 * @returns {Promise<string|null>} 已完成时返回回执，仍在工作时返回 null，宿主继续等待原批次。
 */
async function initialResult(result, waitMs = 15_000) {
  let timer;
  const waiting = new Promise(function begin(resolve) {
    timer = setTimeout(function releaseToolCall() { resolve(null); }, waitMs);
  });
  try {
    return await Promise.race([result, waiting]);
  } finally {
    clearTimeout(timer);
  }
}

/** 按当前回答语言说明何时启动独立任务。存在先后依赖或共用交付物时，主会话按顺序处理。 */
function instruction(english) {
  return english
    ? '\n[AGI PARALLEL TASKS] When one request asks you to execute several independent goals, call run_agi_parallel once with all of them before doing any one of them. Quote each goal from the current user messages. Wait for every result and verify each goal individually. If the tool returns a running status, end this model response so SpCode can deliver the finished batch. Never launch another batch in the same turn or start subagents from a branch. Continue any feasible unfinished work and report any remaining blocker. Keep dependent steps and work on the same deliverable together. A discussion or example does not authorize execution.\n'
    : '\n【AGI 并发任务】用户同一轮要求执行多个独立交付目标时，先用 run_agi_parallel 一次提交所有独立目标，再逐项核对返回结果。工具若返回运行中，结束本次生成，由宿主等结果后自动续接。本轮只启动这一批，子代理不能再启动子代理。能继续解决的缺口继续处理，受阻的目标如实标明。每项目标引用当前用户原话。存在先后依赖或操作同一交付物的步骤放在一起。讨论、举例和单项任务不启动并发。\n';
}

/** 校验整批目标后才允许开始执行。排除重复、包含另一个目标或来源不在当前授权正文中的输入。 */
function tasksFrom(args, orders) {
  if (!Array.isArray(args.tasks) || args.tasks.length < 2) throw new Error('并发执行至少需要两个独立目标。');
  const tasks = [];
  for (const item of args.tasks) {
    const goal = typeof item?.goal === 'string' ? item.goal.trim() : '';
    if (!goal || !orders.some(function contains(order) { return order.includes(goal); })) {
      throw new Error('每项目标必须引用当前用户原话中的连续文本。');
    }
    if (item.resource !== 'desktop' && item.resource !== 'project') throw new Error('每项都要指定使用桌面或项目资源。');
    if (tasks.some(function overlaps(task) { return task.goal.includes(goal) || goal.includes(task.goal); })) {
      throw new Error('并发目标有重复，请提交相互独立的目标。');
    }
    tasks.push({ goal, resource: item.resource });
  }
  return tasks;
}

/** 等待已接收的异步操作依次完成。一次失败只影响当前操作，后续仍使用同一资源队列。 */
function serialQueue() {
  let tail = Promise.resolve();
  return function enqueue(execute) {
    const next = tail.then(execute);
    tail = next.then(settled, settled);
    return next;
  };
}

/** 队列只等待前一项结束，结果仍交给实际提交者。 */
function settled() {}

/** 全部会话共用一条前台队列，桌面子代理持有前台直到工具收尾。 */
const desktop = serialQueue();
let desktopRequests = 0;

/**
 * 请求使用桌面前台。已接收的任务按登记顺序运行，失败后释放前台。
 * @param {Function} execute 真正进入前台时调用的异步工作。
 * @returns {Promise<unknown>} 本次桌面工作的结果。
 */
function useDesktop(execute) {
  desktopRequests++;
  return desktop(execute).finally(releaseDesktop);
}

/** 当前桌面已有工作运行或排队，普通工具须重新观察后再提交动作。 */
function desktopBusy() { return desktopRequests > 0; }

/** 结清已进入队列的桌面工作，使新请求能再次取得前台。 */
function releaseDesktop() { desktopRequests--; }

/**
 * 并发运行任务会话，按输入顺序返回所有回执。桌面会话串行占用前台，项目操作串行占用共享工作区，
 * 项目会话的模型请求和桌面任务可重叠。插话后停发旧工具，已开始的调用仍等到完整回执。
 * @param {Array<object>} tasks 已校验的用户目标及资源类型。
 * @param {object} options 宿主提供的会话执行、工具调用、工具清单、事件与中断判定；终态事件附实际回执。
 * @returns {Promise<Array<object>>} 每个目标的状态、结果和实际已返回的工具名称。
 */
async function run(tasks, { runBranch, runTool, toolsFor, interrupted, onProgress }) {
  const projectTools = serialQueue();
  const jobs = [];

  // 先登记整批任务，第一条状态到达时即可显示所有子代理。
  for (const task of tasks) onProgress(task, 'queued');

  /** 运行一个目标并合并已发出的工具回执，分支错误与其他目标隔离。 */
  async function execute(task) {
    const tools = toolsFor(task.resource);
    const allowed = new Set();
    for (const entry of tools) allowed.add(entry.function.name);
    const receipts = [];
    const active = new Set();
    const desktopTools = serialQueue();
    let submitted;
    let failure;
    let closed = false;

    /** 进入声明的资源队列后重查状态，确保结束或插话后排队的动作不会再启动。 */
    function dispatch(toolName, args) {
      async function invoke() {
        if (interrupted()) return '用户已补充或停止，旧任务未启动此工具。';
        if (closed || submitted) return '该任务已结束。';
        if (toolName === finishName) {
          if (!['completed', 'blocked'].includes(args.status) || typeof args.result !== 'string' || !args.result.trim()) {
            return '请提交有效状态与实际结果。';
          }
          if (args.status === 'completed' && !receipts.length) return '请先使用实际工具核对该任务，完成声明不能替代工具回执。';
          submitted = { status: args.status, result: args.result.trim() };
          return '本项结果已登记。';
        }
        if (!allowed.has(toolName)) return '该工具超出当前任务使用的资源范围。';
        const output = await runTool(task, toolName, args);
        receipts.push(toolName);
        return output;
      }
      const queue = task.resource === 'desktop' ? desktopTools : projectTools;
      const pending = queue(invoke);
      active.add(pending);
      /** 真实工具结束后移除它；中断时仍须等待已启动的工具归还结果。 */
      function release() { active.delete(pending); }
      pending.then(release, release);
      return pending;
    }

    if (interrupted()) {
      const result = '用户已补充或停止。';
      onProgress(task, 'interrupted', result);
      return { goal: task.goal, status: 'interrupted', result, tools: receipts };
    }
    onProgress(task, 'running');
    try {
      await runBranch(task, [...tools, finishTool], dispatch);
    } catch (error) {
      failure = error.message;
    }
    closed = true;
    await Promise.allSettled(active);
    let result = submitted;
    if (!result && interrupted()) result = { status: 'interrupted', result: '用户已补充或停止，已执行的操作以工具记录为准。' };
    if (!result) result = { status: 'blocked', result: failure || '分支结束时没有提交实际结果。' };
    onProgress(task, result.status, result.result);
    return { goal: task.goal, ...result, tools: receipts };
  }

  for (const task of tasks) {
    /** 绑定当前目标，桌面任务此前一项完全结束后才接手前台。 */
    function start() { return execute(task); }
    jobs.push(task.resource === 'desktop' ? useDesktop(start) : start());
  }
  const settledJobs = await Promise.allSettled(jobs);
  const results = [];
  for (let index = 0; index < tasks.length; index++) {
    const item = settledJobs[index];
    if (item.status === 'fulfilled') {
      results.push(item.value);
      continue;
    }
    // 调度本身失败也走同一终态事件，移除界面上已经不会执行的卡片。
    const task = tasks[index];
    const result = String(item.reason?.message || item.reason);
    onProgress(task, 'blocked', result);
    results.push({ goal: task.goal, status: 'blocked', result, tools: [] });
  }
  return results;
}

module.exports = { name, finishName, tool, initialResult, instruction, tasksFrom, run, useDesktop, desktopBusy, projectDenial };
