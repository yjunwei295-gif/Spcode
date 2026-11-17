'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

/**
 * 为一组主窗口保存稳定的标签清单身份，避免用每次启动都会变化的窗口编号或进程槽位恢复。
 * @param {object} options 当前宿主提供的路径与进程存活查询。
 * @param {function():string} options.directory 返回用户数据中的窗口登记目录，不绑定安装路径。
 * @param {function(number):boolean} options.ownerAlive 判断登记的宿主进程是否仍在运行，活跃实例的窗口不被另一实例认领。
 * @returns {object} restore、create、close 三个入口；仅保存窗口身份和归属，正文与草稿仍由原会话接口保存。
 */
function createWindowLayouts(options) {
  let group = null;

  /** 无参数；将当前窗口组及更新时间同步写入UTF-8登记文件，写入错误直接报告给宿主。 */
  function write() {
    group.updatedAt = new Date().toISOString();
    const directory = options.directory();
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, group.id + '.json'), JSON.stringify(group), 'utf8');
  }

  /**
   * 认领最近退出的一组窗口并保留其中各窗口的原始身份。
   * 无参数；仍在运行的其他进程不受影响，同一宿主再次激活时复用已认领的组。
   * @returns {string[]} 按原顺序返回待重开的稳定窗口编号；首次启动没有登记时返回空数组。
   * 整组退出保留所有窗口，用户单独关闭的窗口由close移出组，避免下次启动复活。
   */
  function restore() {
    if (group) return [...group.windows];
    const directory = options.directory();
    if (!fs.existsSync(directory)) return [];
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith('.json')) continue;
      const candidate = JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'));
      if (options.ownerAlive(candidate.ownerPid)) continue;
      if (!group || candidate.updatedAt > group.updatedAt) group = candidate;
    }
    if (!group) return [];
    group.ownerPid = process.pid;
    write();
    return [...group.windows];
  }

  /**
   * 为用户新开的主窗分配独立且可跨进程复用的清单身份。
   * 无参数；首次新建时建立当前进程的窗口组，后续新窗追加到同一组。
   * @returns {string} 新窗口的稳定编号；同步登记后才能创建界面，防止其他窗口共享同一清单。
   */
  function create() {
    if (!group) group = { id: randomUUID(), ownerPid: process.pid, windows: [] };
    const id = randomUUID();
    group.windows.push(id);
    write();
    return id;
  }

  /**
   * 更新关闭窗口后的恢复范围。
   * @param {string} id 关闭窗口的稳定编号。
   * @param {boolean} keep 整个应用退出或关闭最后一个主窗时为true，保留其下次重开的身份；单独关窗时为false。
   * @returns {void} 只更新窗口登记，不删除任何会话或标签清单。
   */
  function close(id, keep) {
    if (!keep) {
      const index = group.windows.indexOf(id);
      group.windows.splice(index, 1);
    }
    write();
  }

  return { restore, create, close };
}

module.exports = { createWindowLayouts };
