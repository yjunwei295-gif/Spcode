/**
 * 在同一主进程内替换可重建的业务模块，并通知界面加载新的资源。
 * 无常驻资源的受管业务模块重建依赖闭包；主入口与常驻服务通过 V8 更新既有函数。
 * 原位更新保留窗口、SDK、模型进程和调度器实例；初始化或闭包布局变化会明确报告未应用。
 * 更新等到全部业务调用和聊天轮次空闲后提交；加载失败会明确报告，磁盘文件不会被还原。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const vm = require('vm');
const { spawn } = require('child_process');
const { createHash } = require('crypto');

/** 这些模块不拥有常驻窗口、线程或直通会话；缓存随业务实现更新重新建立。 */
const LIVE_MODULES = [
  'agent.js', 'aesthetic-review.js', 'aesthetic-reference.js', 'assembly.js',
  'module-prompts.js', 'api-protocol.js', 'codex-model.js',
  'claude-model.js', 'grok-model.js', 'skills.js', 'generate.js', 'media.js',
  'prompt-preview.js'
];
/** 合并编辑器一次保存产生的多个事件，避免读取尚未写完的源码。 */
const SAVE_SETTLE_MS = 350;

/**
 * 创建一套热重载生命周期，必须在业务模块首次 require 之前调用。
 * @param {object} options root 为程序源码根；modules 可指定受管模块的相对路径；
 * canApply 检查宿主是否空闲，notify 接收可见状态，afterReload 恢复宿主注入的回调。
 * @returns {object} start/close 管理监听，flush 在空闲边界应用更新，status 返回待处理界面通知。
 */
function createHotReload(options) {
  const root = path.resolve(options.root);
  const files = options.modules || LIVE_MODULES.map(modulePath);
  const managed = new Set();
  for (const file of files) managed.add(path.resolve(root, file));
  const records = new Map();
  const pending = new Set();
  // 常驻服务保持原实例，通过 V8 更新既有函数；与可重建业务模块共用空闲边界。
  const pendingLive = new Set();
  const liveEditor = require('./live-edit').createLiveEditor(root);
  let liveApplying = false;
  const watchers = [];
  const validators = new Set();
  const fingerprints = new Map();
  const validating = new Map();
  let idleQueued = false;
  const originalLoad = Module._load;
  let timer = null;
  let active = 0;
  let staging = null;
  let rebuilding = null;
  let closed = false;
  let revision = 0;
  let lastStatus = null;
  let rendererStatus = null;
  const rendererPaths = new Set();
  const rendererPending = new Set();
  const rendererInvalid = new Set();
  let rendererTimer = null;
  let rendererSettled = false;
  let rendererFailure = null;
  /** 未成功重新提交的业务路径及所在失败批次；修复只重验原批次，其他业务成功不解除错误。 */
  const businessInvalid = new Map();
  /** 最近一次业务更新失败通知；全部失败路径修复前，状态查询持续返回错误。 */
  let businessFailure = null;
  /** 业务错误撤销了已预检的界面版本；修复业务后重验保留的资源路径，绝不复活旧 revision。 */
  let rendererNeedsRecheck = false;

  /** 默认业务目录相对于程序根，安装位置变化不会改变模块归属。 */
  function modulePath(file) { return path.join('electron', 'lib', file); }

  /** 将内部绝对路径转为界面和日志使用的相对路径。 */
  function relative(file) { return path.relative(root, file).split(path.sep).join('/'); }

  /**
   * 发布真实更新结果；错误撤销旧 ready，业务修复成功后重新预检被撤销的界面资源。
   * @param {string} kind runtime/data/renderer/validating/error，决定状态和待加载版本的处理。
   * @param {string[]} paths 相对于程序根的变更路径，仅描述本次结果；不写入源码文件。
   * @param {string} message 交给界面与诊断的实际结果文案。
   * @returns {object} 带递增 revision 的本次通知；业务修复可随后产生新的 validating 通知。
   * 普通业务成功保留有效 ready；全部失败业务路径修复后才重验候选，只能产生新 revision，不能重放旧确认。
   */
  function publish(kind, paths, message) {
    const payload = { kind, paths, message, revision: ++revision };
    lastStatus = payload;
    if (kind === 'error') {
      if (rendererStatus) {
        for (const file of rendererStatus.paths) rendererPending.add(file);
      }
      // 错误可能早于预检完成；尚未 ready 的候选同样必须等待业务修复后重新校验。
      rendererNeedsRecheck = businessInvalid.size > 0 && rendererPending.size > 0;
      rendererStatus = null;
    }
    if (kind === 'renderer') {
      for (const file of paths) rendererPaths.add(file);
      payload.paths = Array.from(rendererPaths);
      rendererStatus = payload;
    }
    options.notify(payload);
    if (kind === 'runtime' && !businessInvalid.size && rendererNeedsRecheck) {
      rendererNeedsRecheck = false;
      const pathsToRecheck = Array.from(rendererPending);
      publish('validating', pathsToRecheck, '业务修复已应用，正在重新预检此前排队的界面资源。');
      validateRenderer(pathsToRecheck[0]);
    }
    return payload;
  }

  /** 代理读取当前版本；重建期间新模块之间读取同一批次的新导出。 */
  function current(record) {
    if (staging && staging.has(record.file)) return staging.get(record.file);
    return record.value;
  }

  /** 导出调用结束后再次检查待更新项，不建立空闲轮询定时器。 */
  function releaseCall() {
    active--;
    if (pending.size || pendingLive.size) schedule();
    if (active === 0 && rendererStatus && !idleQueued && !closed) {
      idleQueued = true;
      queueMicrotask(notifyRendererIdle);
    }
  }

  /** 受管异步任务收尾时唤醒等待中的页面；合并同一调用栈内的重复空闲事件。 */
  function notifyRendererIdle() {
    idleQueued = false;
    if (!closed && active === 0 && rendererStatus && options.canApply()) options.notify(rendererStatus);
  }

  /**
   * 为具名导出保留稳定入口，避免主进程解构导入后永远调用旧函数。
   * 异步导出保持占用直到 Promise 完成，因此更新不会发生在模型请求或解析任务中途。
   */
  function method(record, key) {
    function invoke() {
      const owner = current(record);
      const fn = owner[key];
      if (typeof fn !== 'function') throw new TypeError(relative(record.file) + ' 的导出已不再是函数：' + String(key));
      active++;
      let result;
      try {
        result = Reflect.apply(fn, this === record.facade ? owner : this, arguments);
      } catch (error) {
        releaseCall();
        throw error;
      }
      if (result && typeof result.then === 'function') return Promise.resolve(result).then(resolved, rejected);
      releaseCall();
      return result;
    }
    /** 保持原异步结果与异常；这里只登记调用生命周期。 */
    function resolved(value) { releaseCall(); return value; }
    function rejected(error) { releaseCall(); throw error; }
    return invoke;
  }

  /** 可热换模块使用普通对象导出；常驻资源实例不进入该代理层。 */
  function assertExports(file, value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError(relative(file) + ' 需要使用普通对象导出才能热重载');
    }
  }

  /**
   * 在提交候选前核对已暴露的导出，避免旧解构引用在下一次调用时才发现接口失效。
   * @param {string} file 受管模块绝对路径。
   * @param {object} value 已完成装载的候选导出；新增导出允许，既有导出不得删除或改变类型。
   * @returns {void} 接口不兼容即抛错；不执行 getter，不改磁盘或当前有效导出。
   */
  function assertCompatibleExports(file, value) {
    assertExports(file, value);
    const record = records.get(file);
    if (!record) return;
    for (const key of Reflect.ownKeys(record.value)) {
      const before = Object.getOwnPropertyDescriptor(record.value, key);
      const after = Object.getOwnPropertyDescriptor(value, key);
      if (!after) throw new TypeError(relative(file) + ' 的既有导出被删除：' + String(key));
      if (Object.hasOwn(before, 'value') !== Object.hasOwn(after, 'value') || typeof before.value !== typeof after.value || typeof before.get !== typeof after.get || typeof before.set !== typeof after.set) {
        throw new TypeError(relative(file) + ' 的既有导出类型发生变化：' + String(key));
      }
    }
  }

  /** 创建稳定的模块外壳，属性读取和具名函数都指向最新提交的实现。 */
  function recordFor(file, value) {
    let record = records.get(file);
    if (record) return record;
    assertExports(file, value);
    record = { file, value, methods: new Map(), facade: null };
    const handler = {
      get: function get(_target, key) {
        const value = current(record)[key];
        if (typeof value !== 'function') return value;
        if (!record.methods.has(key)) record.methods.set(key, method(record, key));
        return record.methods.get(key);
      },
      // 保留 CommonJS 导出对象原有的赋值语义，调用方注入实现时同样经稳定入口读取。
      set: function set(_target, key, value) { return Reflect.set(current(record), key, value); },
      has: function has(_target, key) { return key in current(record); },
      ownKeys: function ownKeys() { return Reflect.ownKeys(current(record)); },
      getOwnPropertyDescriptor: function descriptor(_target, key) {
        const descriptor = Object.getOwnPropertyDescriptor(current(record), key);
        if (!descriptor) return undefined;
        return { configurable: true, enumerable: descriptor.enumerable, writable: false, value: record.facade[key] };
      }
    };
    record.facade = new Proxy({}, handler);
    records.set(file, record);
    return record;
  }

  /** 只拦截登记的本地模块；Electron、第三方 SDK 和有状态服务沿用 Node 原始加载器。 */
  function load(request, parent, isMain) {
    const file = Module._resolveFilename(request, parent, isMain);
    const value = Reflect.apply(originalLoad, Module, arguments);
    if (!managed.has(file)) return value;
    if (staging && rebuilding.has(file)) staging.set(file, value);
    return recordFor(file, value).facade;
  }
  Module._load = load;

  /** 延迟到保存稳定后处理；忙时由调用收尾或宿主轮次收尾再次触发。 */
  function schedule() {
    if (closed || (!pending.size && !pendingLive.size)) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(onSettled, SAVE_SETTLE_MS);
    timer.unref();
  }
  function onSettled() { timer = null; flush(); }

  /** 找出受变更影响的业务调用方，重建其闭包里捕获的常量和配置。 */
  function affectedBy(changed) {
    const affected = new Set(changed);
    let grew = true;
    while (grew) {
      grew = false;
      for (const file of managed) {
        if (affected.has(file)) continue;
        const cached = require.cache[file];
        if (!cached) continue;
        for (const child of cached.children) {
          if (!affected.has(child.filename)) continue;
          affected.add(file);
          grew = true;
          break;
        }
      }
    }
    return affected;
  }

  /** 从父模块移除过期缓存节点，避免多次保存让 parent.children 无限增长。 */
  function detach(modules) {
    for (const cached of Object.values(require.cache)) {
      for (let index = cached.children.length - 1; index >= 0; index--) {
        if (modules.has(cached.children[index])) cached.children.splice(index, 1);
      }
    }
  }

  /**
   * 在空闲边界原子切换一批业务模块。
   * 先验证整批语法，再重建受管调用方；任何加载错误都不发布成功，旧内存版本保持可诊断状态。
   * @returns {boolean} 已提交业务批次或已发起常驻更新时为 true；忙碌、无更新或业务失败时为 false。
   * 失败路径持续阻止界面重载，只有这些路径在后续批次实际重建成功才能解除。
   */
  function flush() {
    if (closed || staging || active || liveApplying || (!pending.size && !pendingLive.size) || !options.canApply()) return false;
    if (pendingLive.size) {
      applyLiveUpdates();
      return true;
    }
    if (timer) { clearTimeout(timer); timer = null; }
    const changed = Array.from(pending);
    pending.clear();
    const affected = affectedBy(changed);
    const previous = new Map();
    const oldNodes = new Set();
    const recordKeys = new Set(records.keys());
    try {
      for (const file of affected) {
        const source = fs.readFileSync(file, 'utf8');
        new vm.Script(Module.wrap(source), { filename: file });
        previous.set(file, require.cache[file]);
        if (require.cache[file]) oldNodes.add(require.cache[file]);
      }
      staging = new Map();
      rebuilding = affected;
      for (const file of affected) delete require.cache[file];
      for (const file of affected) {
        const value = originalLoad(file, module, false);
        assertCompatibleExports(file, value);
        staging.set(file, value);
        recordFor(file, value);
      }
      // 宿主接线同样在提交前完成；接线失败时不能留下半批新旧混用的导出。
      options.afterReload(Array.from(affected));
      for (const [file, value] of staging) records.get(file).value = value;
      staging = null;
      rebuilding = null;
      detach(oldNodes);
      // 只解除本批实际重建成功的路径；其他失败业务仍阻止页面重载。
      for (const file of affected) businessInvalid.delete(file);
      if (!businessInvalid.size) businessFailure = null;
      publish('runtime', changed.map(relative), '业务代码已热更新，后续调用使用新实现。');
      return true;
    } catch (error) {
      // 只恢复 Node 的内存缓存，不改动任何磁盘源码；失败必须在界面和日志里可见。
      if (staging) {
        const failedNodes = new Set();
        for (const file of affected) {
          if (require.cache[file]) failedNodes.add(require.cache[file]);
          const cached = previous.get(file);
          if (cached) require.cache[file] = cached;
          else delete require.cache[file];
        }
        detach(failedNodes);
        for (const file of Array.from(records.keys())) if (!recordKeys.has(file)) records.delete(file);
      }
      staging = null;
      rebuilding = null;
      const failedBatch = new Set(changed);
      for (const file of changed) businessInvalid.set(file, failedBatch);
      businessFailure = publish('error', changed.map(relative), '业务热更新失败，尚未应用本次更新：' + error.message);
      return false;
    }
  }

  /**
   * 原位更新主入口与常驻服务，不重新创建窗口、调度器或 SDK 会话。
   * 先读取整批正文，再由 V8 通道核对初始化和闭包布局；异步提交期间阻止其他重载。
   * @returns {Promise<void>} 完成后发布实际结果；失败列出已提交路径，不把部分更新报成全部成功。
   */
  async function applyLiveUpdates() {
    liveApplying = true;
    const changedFiles = Array.from(pendingLive);
    pendingLive.clear();
    try {
      const updates = [];
      for (const file of changedFiles) {
        const source = fs.readFileSync(file, 'utf8');
        new vm.Script(Module.wrap(source), { filename: file });
        updates.push({ file, source });
      }
      const applied = await liveEditor.apply(updates);
      if (closed) return;
      const paths = changedFiles.map(relative);
      for (const file of changedFiles) businessInvalid.delete(file);
      if (!businessInvalid.size) businessFailure = null;
      publish('runtime', paths, applied.length
        ? '主入口或常驻服务的方法已原位更新，窗口和服务实例保持运行。'
        : '更新文件尚未加载，首次调用将读取磁盘上的新实现。');
    } catch (error) {
      if (closed) return;
      const applied = (error.applied || []).map(relative);
      const detail = applied.length ? ' 已提交：' + applied.join('、') + '；其余尚未应用。' : '';
      const failedBatch = new Set(changedFiles);
      for (const file of changedFiles) businessInvalid.set(file, failedBatch);
      businessFailure = publish('error', changedFiles.map(relative), '主进程原位更新未完整应用：' + error.message + detail);
    } finally {
      liveApplying = false;
      if (pending.size || pendingLive.size) schedule();
      if (rendererStatus) notifyRendererIdle();
    }
  }

  /**
   * 接收真实保存事件，按业务、常驻脚本或界面资源进入对应更新流程。
   * @param {string} file 保存或删除的源码路径，统一解析为绝对路径后分类。
   * @returns {void} 登记待更新集合并安排异步处理；不写文件，不重启窗口或模型会话。
   * 每次界面保存立即撤销旧 ready；全部静态依赖预检通过且保存稳定后才发布新版本。
   */
  function changed(file) {
    if (closed) return;
    const absolute = path.resolve(file);
    const rel = relative(absolute);
    if (managed.has(absolute)) {
      pending.add(absolute);
      // 失败批次原子提交过零个模块；修复其中一项时必须连同其余失败候选重验，不能永久卡住有效同批文件。
      if (businessInvalid.has(absolute)) {
        for (const file of businessInvalid.get(absolute)) pending.add(file);
      }
      schedule();
      return;
    }
    if (rel.startsWith('renderer/') || rel === 'electron/preload.js') {
      rendererPending.add(rel);
      // 新保存即撤销旧 ready；最终重载必须对应最新完成整图预检的批次。
      rendererStatus = null;
      rendererFailure = null;
      rendererNeedsRecheck = businessInvalid.size > 0;
      publish('validating', [rel], '界面更新正在预检，旧版本重载已取消。');
      rendererSettled = false;
      if (rendererTimer) clearTimeout(rendererTimer);
      rendererTimer = setTimeout(rendererSaveSettled, SAVE_SETTLE_MS);
      rendererTimer.unref();
      validateRenderer(rel);
      return;
    }
    if (rel.startsWith('skills/') || rel.startsWith('rules/')) {
      publish('data', [rel], '技能或规则已更新，下次请求读取新内容。');
      return;
    }
    if (rel.startsWith('electron/') && (path.extname(absolute) === '.js' || path.extname(absolute) === '.cjs')) {
      pendingLive.add(absolute);
      // 常驻更新失败可能只提交了部分文件；修复失败路径后整批重新提交并核对实际结果。
      if (businessInvalid.has(absolute)) {
        for (const file of businessInvalid.get(absolute)) pendingLive.add(file);
      }
      schedule();
      return;
    }
    if (rel.startsWith('electron/')) {
      publish('data', [rel], '程序资料已更新，下次读取使用磁盘上的新内容。');
      return;
    }
    if (rel === 'package.json') {
      publish('error', [rel], '包清单已保存；已运行的 Electron 版本、原生依赖和进程启动参数无法原位替换，本次未应用这些变化。');
    }
  }

  /** 保存事件安静下来后才允许发布，防止 CSS 的事件抢在同批 JS 校验之前触发重载。 */
  function rendererSaveSettled() {
    rendererTimer = null;
    rendererSettled = true;
    publishRendererReady();
  }

  /**
   * 整批界面预检通过且已暴露的业务错误全部修复后，才允许发布可重载版本。
   * @returns {void} 发布时消费待加载资源并生成新 revision；业务错误期间保留候选，不发 ready。
   * 预检完成和后续界面保存均不能解除业务错误，避免旧页面被未修复的候选替换。
   */
  function publishRendererReady() {
    if (closed || businessInvalid.size || !rendererSettled || validating.size || rendererInvalid.size || !rendererPending.size) return;
    const paths = Array.from(rendererPending);
    rendererPending.clear();
    publish('renderer', paths, '界面资源有更新，空闲后自动重新加载。');
  }

  /**
   * 静态解析或链接错误阻止整批重载；磁盘候选保留，修正保存后重新预检。
   * @param {string} key 本程序根路径，标记整图校验失败；不按单个文件绕开错误。
   * @param {string} rel 本次变更的相对路径，用于错误通知定位。
   * @param {string} message 校验器实际失败详情。
   * @returns {void} 撤销旧 ready 并发布错误，不触碰运行中的旧页面。
   */
  function rendererRejected(key, rel, message) {
    rendererStatus = null;
    rendererInvalid.add(key);
    rendererFailure = publish('error', [rel], message);
  }

  /**
   * 用隔离的 Electron Node 预检 HTML 入口、静态模块图及 preload，不执行候选脚本。
   * @param {string} rel 相对于程序根的保存路径，用于界面错误提示。
   * @returns {void} 异步进程退出后发布实际结果；新保存使旧校验失效并终止旧进程。
   * ESM 只 link 不 evaluate，经典脚本按 HTML type 解析；业务运行时错误不属于静态预检。
   */
  function validateRenderer(rel) {
    const token = {};
    // 整图只保留最新保存的校验；旧进程的结束事件不能清掉新 token 或发布旧 ready。
    validating.clear();
    validating.set(root, token);
    for (const validator of validators) validator.kill();
    let child;
    try {
      child = spawn(process.execPath, ['--experimental-vm-modules', path.join(__dirname, 'renderer-preflight.js')], {
        env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }),
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'pipe']
      });
      validators.add(child);
      let stderr = '';
      child.stderr.on('data', readError);
      child.on('error', failed);
      child.stdin.on('error', failed);
      child.on('close', checked);
      child.stdin.end(JSON.stringify({ root, paths: Array.from(rendererPending) }));
      /**
       * 收集隔离进程的实际解析或链接诊断，保留文件与位置供失败通知展示。
       * @param {Buffer|string} chunk stderr 的一段原始输出。
       * @returns {void} 只追加本次进程的错误正文，不改变校验状态。
       */
      function readError(chunk) { stderr += String(chunk); }
      /**
       * 校验器启动或请求输入失败时拒绝本批加载，失败不得冒充静态图已通过。
       * @param {Error} error 子进程或 stdin 提供的实际异常。
       * @returns {void} 当前 token 才能发布错误；关闭或已被新保存取代的回执不改变状态。
       */
      function failed(error) {
        if (closed || validating.get(root) !== token) return;
        validating.delete(root);
        rendererRejected(root, rel, '界面语法校验失败，尚未重新加载：' + error.message);
      }
      /**
       * 处理最新整图预检进程退出结果，过期进程不得清除新 token 或发布旧 ready。
       * @param {number|null} code 实际进程退出码，只有 0 表示解析与链接全部通过。
       * @returns {void} 回收进程登记；通过时解除整图错误并等待保存稳定，失败时保留旧页面。
       */
      function checked(code) {
        validators.delete(child);
        if (closed || validating.get(root) !== token) return;
        validating.delete(root);
        if (code === 0) {
          rendererInvalid.clear();
          if (!rendererInvalid.size) rendererFailure = null;
          publishRendererReady();
        } else {
          rendererRejected(root, rel, '界面热更新失败，尚未重新加载：' + stderr.trim());
        }
      }
    } catch (error) {
      validating.delete(root);
      rendererRejected(root, rel, '界面语法校验失败，尚未重新加载：' + error.message);
    }
  }

  /** 记录被监听程序文件的内容，过滤 Windows 复制读取和相同内容写入产生的重复事件。 */
  function rememberFiles(file) {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        rememberFiles(path.join(file, entry.name));
      }
      return;
    }
    if (stat.isFile()) fingerprints.set(file, createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  }

  /** 只对内容确实改变的文件触发更新；删除同样作为真实变更交给原有错误报告。 */
  function fileContentChanged(file) {
    if (!fs.existsSync(file)) {
      const existed = fingerprints.has(file);
      fingerprints.delete(file);
      return existed;
    }
    if (!fs.statSync(file).isFile()) return false;
    const fingerprint = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    if (fingerprints.get(file) === fingerprint) return false;
    fingerprints.set(file, fingerprint);
    return true;
  }

  /** 监听指定程序目录；不递归监听项目产物、模型权重和 node_modules。 */
  function start(directories) {
    for (const directory of directories) {
      const absolute = path.resolve(typeof directory === 'string' ? directory : directory.path);
      const kind = typeof directory === 'string' ? '' : directory.kind;
      if (!fs.existsSync(absolute)) continue;
      const isDirectory = fs.statSync(absolute).isDirectory();
      try {
        rememberFiles(absolute);
        const watcher = fs.watch(absolute, { recursive: isDirectory }, onChange);
        watcher.on('error', watchError);
        watchers.push(watcher);
      } catch (error) {
        watchError(error);
      }
      /** fs.watch 给出的文件名相对于当前被监听目录；外置技能目录也使用同一通知通道。 */
      function onChange(_event, filename) {
        if (!filename) return;
        const file = isDirectory ? path.join(absolute, String(filename)) : absolute;
        try {
          if (!fileContentChanged(file)) return;
          if (kind === 'data') publish('data', [relative(file)], '技能或规则已更新，下次请求读取新内容。');
          else changed(file);
        } catch (error) {
          watchError(error);
        }
      }
      /** 监听器失效必须报告，不以轮询或静默成功替代。 */
      function watchError(error) {
        publish('error', [relative(absolute)], '热更新监听失败：' + error.message);
      }
    }
  }

  /** 退出时解除监听和加载钩子，不终止聊天、不重启进程。 */
  function close() {
    closed = true;
    liveEditor.close();
    if (timer) clearTimeout(timer);
    if (rendererTimer) clearTimeout(rendererTimer);
    for (const watcher of watchers) watcher.close();
    for (const child of validators) child.kill();
    validators.clear();
    validating.clear();
    if (Module._load === load) Module._load = originalLoad;
  }

  /**
   * 查询仍有效的更新状态，业务错误未修复时优先报告错误。
   * @returns {object|null} 已暴露的错误、尚未加载的界面版本或最近通知；不消费候选。
   */
  function status() { return businessFailure || rendererFailure || rendererStatus || lastStatus; }
  /**
   * 检查受管调用、待更新批次与未修复错误是否仍阻止页面重载。
   * @returns {boolean} 有受管业务待校验、常驻脚本待更新、在途调用、界面候选或未修复错误时为 true。
   * 只读生命周期状态；保存后的合并延迟期间，pending 中尚未校验的业务也必须阻止旧界面重载。
   */
  function isBusy() {
    return active > 0 || staging !== null || liveApplying || pending.size > 0 || pendingLive.size > 0 || businessInvalid.size > 0 || rendererPending.size > 0 || validating.size > 0 || rendererInvalid.size > 0;
  }
  return { start, close, flush, changed, status, isBusy };
}

module.exports = { createHotReload, LIVE_MODULES };
