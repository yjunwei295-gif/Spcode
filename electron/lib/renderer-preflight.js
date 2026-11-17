'use strict';

/**
 * 在隔离的 Electron Node 进程中解析界面入口及静态依赖，不执行任何候选脚本。
 * 标准输入接收 {root, paths}；成功退出 0，文件、语法或模块链接错误写入 stderr 并退出 1。
 * HTML 的 script type 决定经典脚本或 ESM；预检不能证明业务运行时逻辑正确。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');
const { pathToFileURL, fileURLToPath } = require('url');

/**
 * 校验实际 HTML 脚本入口、完整静态模块图及本批新增脚本。
 * @param {{root:string,paths:string[]}} request 程序根路径及相对于根的本批变更路径。
 * @returns {Promise<void>} 仅解析与链接；缺文件、缺导出或解析失败直接拒绝，不运行初始化代码。
 */
async function validateRendererGraph(request) {
  const root = path.resolve(request.root);
  const modules = new Map();
  const classicFiles = new Set();
  const roots = [];
  const htmlFiles = [];
  collectHtml(path.join(root, 'renderer'));
  for (const file of htmlFiles) inspectHtml(file);
  for (const entry of roots) {
    if (entry.status === 'unlinked') await entry.link(linkDependency);
  }
  for (const relative of request.paths) {
    const file = path.resolve(root, relative);
    if (path.extname(file).toLowerCase() === '.html') fs.readFileSync(file, 'utf8');
    if (relative === 'electron/preload.js') {
      new vm.Script(Module.wrap(fs.readFileSync(file, 'utf8')), { filename: file });
    } else if (path.extname(file) === '.js' && !classicFiles.has(file) && !modules.has(pathToFileURL(file).href)) {
      // 新增且尚未接入 HTML 的文件没有加载模式；经典语法直接解析，含模块语法时链接其静态图。
      const source = fs.readFileSync(file, 'utf8');
      try { new vm.Script(source, { filename: file }); }
      catch (error) {
        const entry = readModule(pathToFileURL(file).href);
        if (entry.status === 'unlinked') await entry.link(linkDependency);
      }
    }
  }

  /**
   * 收集 renderer 目录中实际 HTML 入口，不读取符号链接指向的外部目录。
   * @param {string} directory 当前递归目录的绝对路径；尚未建立的测试目录没有页面入口。
   * @returns {void} 将普通 HTML 文件加入 htmlFiles；具体删除文件由本批路径读取报告错误。
   */
  function collectHtml(directory) {
    if (!fs.existsSync(directory)) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) collectHtml(file);
      else if (entry.isFile() && path.extname(file).toLowerCase() === '.html') htmlFiles.push(file);
    }
  }

  /**
   * 按 HTML 中真实 script 类型解析外部或内联代码；非 JavaScript 数据脚本不参与执行预检。
   * @param {string} file HTML 的绝对路径；相对 src 按该页面的 file URL 解析。
   * @returns {void} 经典脚本立即解析，模块入口加入待链接集合；不创建窗口或浏览器全局对象。
   */
  function inspectHtml(file) {
    const source = fs.readFileSync(file, 'utf8');
    const tags = /<!--[\s\S]*?-->|<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    let match;
    let inline = 0;
    while ((match = tags.exec(source))) {
      if (match[1] === undefined) continue;
      const attributes = {};
      const names = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
      let attribute;
      while ((attribute = names.exec(match[1]))) {
        let value = '';
        if (attribute[2] !== undefined) value = attribute[2];
        else if (attribute[3] !== undefined) value = attribute[3];
        else if (attribute[4] !== undefined) value = attribute[4];
        attributes[attribute[1].toLowerCase()] = value;
      }
      const type = (attributes.type || '').trim().toLowerCase();
      if (type && type !== 'module' && type !== 'text/javascript' && type !== 'application/javascript') continue;
      const pageUrl = pathToFileURL(file).href;
      const url = attributes.src ? new URL(attributes.src, pageUrl).href : pageUrl + '#inline-' + (++inline);
      const filename = attributes.src ? localFile(url) : file;
      const script = attributes.src ? fs.readFileSync(filename, 'utf8') : match[2];
      if (type === 'module') roots.push(readModule(url, script));
      else {
        new vm.Script(script, { filename: attributes.src ? filename : url });
        if (attributes.src) classicFiles.add(filename);
      }
    }
  }

  /** 只读取本地 file URL，保持浏览器静态链接所用的精确文件名，不补扩展名或寻找替代文件。 */
  function localFile(identifier) {
    const url = new URL(identifier);
    if (url.protocol !== 'file:') throw new Error('界面静态依赖必须可以在本地预检：' + identifier);
    return fileURLToPath(url);
  }

  /** 为每个模块 URL 保留同一个解析实例，支持循环导入；source 仅供 HTML 内联模块使用。 */
  function readModule(identifier, source) {
    if (modules.has(identifier)) return modules.get(identifier);
    const text = source === undefined ? fs.readFileSync(localFile(identifier), 'utf8') : source;
    const entry = new vm.SourceTextModule(text, { identifier });
    modules.set(identifier, entry);
    return entry;
  }

  /** 按浏览器 URL 规则解析静态 import/re-export，V8 link 负责核对具名导出及循环依赖。 */
  function linkDependency(specifier, owner) {
    if (!specifier.startsWith('./') && !specifier.startsWith('../') && !specifier.startsWith('/') && !specifier.startsWith('file:')) {
      throw new Error('界面静态依赖缺少可解析的本地路径：' + specifier + '，入口：' + owner.identifier);
    }
    return readModule(new URL(specifier, owner.identifier).href);
  }
}

module.exports = { validateRendererGraph };

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', collectInput);
  process.stdin.on('end', validateInput);
  /** 收集父进程传入的单次预检请求，不读取用户配置或聊天内容。 */
  function collectInput(chunk) { input += chunk; }
  /** JSON 请求或静态链接失败均保留真实异常，父进程据非零退出码阻止页面重载。 */
  async function validateInput() {
    try { await validateRendererGraph(JSON.parse(input)); }
    catch (error) { process.stderr.write(String(error.stack || error) + '\n'); process.exitCode = 1; }
  }
}
