'use strict';

/**
 * 原位更新已加载主入口与常驻服务的方法，保留窗口、会话和已注册回调。
 * 顶层初始化和闭包结构变化不能安全重放，必须明确拒绝，不能把 V8 的 Ok 当成完整生效。
 */
const inspector = require('inspector');
const path = require('path');
const { fileURLToPath } = require('url');
const acorn = require('acorn');

/** 返回 AST 的语义结构；位置和原始字面量格式不影响已执行的初始化。 */
function semantic(node) {
  if (typeof node === 'bigint') return { bigint: String(node) };
  if (node === null || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(semantic);
  if (isFunction(node)) return functionShape(node);
  const result = {};
  for (const key of Object.keys(node)) {
    if (key === 'start' || key === 'end' || key === 'loc' || key === 'raw') continue;
    result[key] = semantic(node[key]);
  }
  return result;
}

/** 只识别 JavaScript 的三类函数节点，方法的键和属性由外层 AST 保留。 */
function isFunction(node) {
  return node && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression');
}

/** 判断标识符是否只作为属性名或标签，避免把非词法名字误当成闭包依赖。 */
function isPropertyName(parent, key) {
  if (!parent) return false;
  if ((parent.type === 'MemberExpression' || parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && !parent.computed && (key === 'property' || key === 'key')) return true;
  return (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') && key === 'label';
}

/**
 * 提取函数内部的词法声明、嵌套函数和标识符集合。
 * 保持这些结构不变，防止新增捕获变量时 V8 虽返回 Ok、旧闭包却继续执行旧实现。
 */
function bodyShape(body) {
  const bindings = visit(body, null, '');
  return { bindings };

  /** 按原声明顺序收集作用域结构；没有声明的代码块不产生额外结构。 */
  function visit(node, parent, key) {
    if (node === null || typeof node !== 'object') return [];
    if (Array.isArray(node)) {
      const entries = [];
      for (const child of node) entries.push(...visit(child, parent, key));
      return entries;
    }
    if (isFunction(node)) return [functionShape(node)];
    // 非严格模式的条件/标签函数声明带有 Annex B 隐式作用域，不能按普通函数声明迁移。
    if ((node.type === 'IfStatement' && (node.consequent.type === 'FunctionDeclaration' || (node.alternate && node.alternate.type === 'FunctionDeclaration'))) || (node.type === 'LabeledStatement' && node.body.type === 'FunctionDeclaration')) {
      throw new Error('脚本含条件或标签内的隐式函数作用域，尚未应用原位更新。');
    }
    if (node.type === 'WithStatement' || (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'eval')) {
      throw new Error('脚本含动态词法作用域，无法确认闭包布局，尚未应用原位更新。');
    }
    // 引用保留在各自作用域内并逐次登记，不能用全函数的 Set 合并：
    // 内层同名变量不能掩盖外层新增捕获，引用跨作用域移动也必须拒绝。
    if (node.type === 'Identifier' && !isPropertyName(parent, key)) return [{ reference: node.name }];
    // 箭头函数也会捕获 this/super/new.target；这些隐式绑定同样不能增减。
    if (node.type === 'ThisExpression' || node.type === 'Super' || node.type === 'MetaProperty') return [{ reference: '@' + node.type }];
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') return [semantic(node)];
    const children = [];
    if (node.type === 'VariableDeclaration') {
      const declarations = [];
      for (const declaration of node.declarations) declarations.push(semantic(declaration.id));
      children.push({ declaration: node.kind, names: declarations });
    }
    if (node.type === 'CatchClause') children.push({ catch: semantic(node.param) });
    for (const childKey of Object.keys(node)) {
      if (childKey === 'start' || childKey === 'end' || childKey === 'loc' || childKey === 'raw') continue;
      children.push(...visit(node[childKey], node, childKey));
    }
    if ((node.type === 'BlockStatement' || node.type === 'SwitchStatement' || node.type === 'CatchClause' || node.type === 'ForStatement' || node.type === 'ForOfStatement' || node.type === 'ForInStatement') && children.length) return [{ scope: node.type, children }];
    return children;
  }
}

/** 保留函数签名和词法布局，允许在该布局内修改方法或回调的执行逻辑。 */
function functionShape(node) {
  const directives = [];
  if (node.body.type === 'BlockStatement') {
    for (const statement of node.body.body) {
      if (!statement.directive) break;
      directives.push(statement.directive);
    }
  }
  return { function: node.type, name: semantic(node.id), async: node.async, generator: node.generator,
    params: semantic(node.params), directives, body: bodyShape(node.body) };
}

/**
 * 校验一次原位更新是否只改变既有函数实现。
 * @param {string} before 已加载的完整脚本正文。
 * @param {string} after 磁盘上的完整新正文。
 * @returns {void} 布局或初始化不同即抛错；不会修改文件或运行时状态。
 */
function assertLiveEditCompatible(before, after) {
  const options = { ecmaVersion: 'latest', sourceType: 'script', allowReturnOutsideFunction: true, allowHashBang: true };
  const original = semantic(acorn.parse(before, options));
  const updated = semantic(acorn.parse(after, options));
  if (JSON.stringify(original) !== JSON.stringify(updated)) {
    throw new Error('更新包含顶层初始化、函数签名或闭包依赖变化，尚未应用；原位热更新仅接受现有方法和回调内的逻辑变化。');
  }
}

/**
 * 建立本地 V8 编辑通道；不打开调试端口，不创建另一份常驻服务。
 * @param {string} root 程序源码根，用于匹配已加载的 electron 脚本。
 * @returns {{apply:function(Array):Promise<Array>,close:function():void}} apply 全批预检后更新，
 * 返回真正提交的路径；失败抛出带 applied 路径的异常，close 释放本进程调试会话。
 */
function createLiveEditor(root) {
  const session = new inspector.Session();
  const scripts = new Map();
  let closed = false;
  session.connect();
  session.on('Debugger.scriptParsed', parsed);
  const enabled = post('Debugger.enable', {});

  /** 使用 file URL 或绝对路径识别脚本；仅收录程序 electron 目录内的脚本。 */
  function parsed(event) {
    const details = event.params;
    if (!details.url) return;
    const file = details.url.startsWith('file:') ? fileURLToPath(details.url) : details.url;
    if (!path.isAbsolute(file)) return;
    const relative = path.relative(path.join(root, 'electron'), file);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return;
    scripts.set(path.resolve(file), details.scriptId);
  }

  /** 把本地 inspector 回执变为 Promise；协议错误原样交给更新状态通道。 */
  function post(method, parameters) {
    return new Promise(send);
    function send(resolve, reject) {
      session.post(method, parameters, completed);
      function completed(error, result) {
        if (error) reject(error);
        else resolve(result);
      }
    }
  }

  /** 只有协议明确返回 Ok 才接受；编译异常和活动栈阻挡都保持可见。 */
  function assertApplied(result, file) {
    if (result.exceptionDetails || (result.status && result.status !== 'Ok')) {
      const detail = result.exceptionDetails ? result.exceptionDetails.text : result.status;
      throw new Error(path.relative(root, file) + ' 原位更新未应用：' + detail);
    }
  }

  /**
   * 在宿主已确认空闲后更新给定脚本。
   * @param {Array<{file:string,source:string}>} updates 完整路径和已读取的新正文。
   * @returns {Promise<string[]>} 实际更新的已加载脚本；尚未加载的模块留待首次 require 读取磁盘。
   */
  async function apply(updates) {
    await enabled;
    if (closed) throw new Error('原位热更新通道已经关闭');
    const prepared = [];
    const applied = [];
    try {
      for (const update of updates) {
        const scriptId = scripts.get(path.resolve(update.file));
        if (!scriptId) {
          if (require.cache[update.file]) throw new Error('未找到已加载脚本的 V8 编号：' + path.relative(root, update.file));
          continue;
        }
        const previous = await post('Debugger.getScriptSource', { scriptId });
        assertLiveEditCompatible(previous.scriptSource, update.source);
        const parameters = { scriptId, scriptSource: update.source, dryRun: true };
        assertApplied(await post('Debugger.setScriptSource', parameters), update.file);
        prepared.push({ file: update.file, scriptId, source: update.source });
      }
      for (const update of prepared) {
        const result = await post('Debugger.setScriptSource', { scriptId: update.scriptId, scriptSource: update.source });
        assertApplied(result, update.file);
        applied.push(update.file);
      }
      return applied;
    } catch (error) {
      error.applied = applied;
      throw error;
    }
  }

  /** 退出时解除调试监听；不结束窗口、SDK 连接或计时器。 */
  function close() {
    closed = true;
    session.removeListener('Debugger.scriptParsed', parsed);
    session.disconnect();
  }

  return { apply, close };
}

module.exports = { createLiveEditor, assertLiveEditCompatible };
