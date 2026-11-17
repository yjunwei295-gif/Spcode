/**
 * 训练采集的开发/发布边界。
 * 发布版仅转发原调用，采集实现由打包配置排除，不能通过修改设置启用。
 */
'use strict';
const { app } = require('electron');

if (!app.isPackaged) {
  module.exports = require('./training-archive');
} else {
  /** 发布版没有档案上下文。 */
  function current() { return null; }
  /** 发布版不安装异步上下文，直接执行原逻辑。 */
  function run(_archive, execute) { return execute(); }
  /** 发布版忽略采集通知，不创建目录或文件。 */
  function note() {}
  /** 发布版工具仍返回原结果或原异常。 */
  function capture(_archive, _kind, _input, execute) { return execute(); }
  /** 发布版模型传输直接走原实现。 */
  function model(opts, execute) { return execute(opts); }
  /** 发布版直通不包装事件和工具。 */
  function direct(provider, args) { return provider.runTurn(args); }
  module.exports = { current, run, note, capture, model, direct };
}
