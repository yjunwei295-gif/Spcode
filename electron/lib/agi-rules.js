'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * 读取当前应用的全局 AGI 规则。源码版与打包版分别沿用各自的全局规则目录。
 * 每次组装请求从磁盘取原文；用户删除规则文件或清空正文表示没有对应规则。
 * 读取过程不创建或修补文件，其他读取错误原样交给调用方。
 */
function read() {
  const { app } = require('electron');
  const root = app?.isPackaged ? path.join(app.getPath('userData'), 'app-root') : path.resolve(__dirname, '../..');
  const file = path.join(root, 'rules', 'agi.md');
  let source;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    source = '';
  }
  return parse(source);
}

/**
 * 按独立标记行解析规则。首个标记前的自由正文始终属于本轮 AGI 主提示。
 * 小节中的 Markdown 标题是普通正文；用户移除某一节后该环节不附加文字。
 */
function parse(source) {
  const sections = new Map();
  let name = '';
  let body = [];
  for (const line of source.replace(/^\uFEFF/u, '').split(/\r?\n/u)) {
    const marker = /^<!-- agi:([^<>]+) -->$/u.exec(line.trim());
    if (!marker) {
      body.push(line);
      continue;
    }
    sections.set(name, body.join('\n').trim());
    name = marker[1];
    body = [];
  }
  sections.set(name, body.join('\n').trim());

  /** 取公共或指定语言的段落；空节和手动移除的小节均保持为空。 */
  function get(title, english) {
    let key = title;
    if (typeof english === 'boolean') key += english ? ' en' : ' zh';
    return sections.get(key) || '';
  }
  return { get };
}

/** 在催办、续接及独立提示入口读取当时的规则，保留刚保存的手动修改。 */
function section(title, english) {
  return read().get(title, english);
}

/**
 * 将发布包随附的静态规则首次复制到可编辑的用户规则目录。
 * 旧安装同样只迁移一次。独占复制保留已有正文（包括空文件），安装标记保留用户此后的删除决定。
 * @param {string} sourceRoot 包内 app-root。
 * @param {string} userRoot 当前用户可写的 app-root。
 */
function install(sourceRoot, userRoot) {
  const marker = path.join(userRoot, '.agi-rule-installed');
  if (fs.existsSync(marker)) return;
  const directory = path.join(userRoot, 'rules');
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.copyFileSync(path.join(sourceRoot, 'rules', 'agi.md'), path.join(directory, 'agi.md'), fs.constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  fs.writeFileSync(marker, '', 'utf8');
}

module.exports = { read, section, install };
