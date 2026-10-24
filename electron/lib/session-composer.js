/**
 * 将输入草稿单独存为小文件，避免每次停顿都复制、序列化整份对话。
 * 同一会话按调用顺序写入；完整会话保存也更新草稿，保证发送清空与并发写入顺序一致。
 */
const fs = require('node:fs');
const path = require('node:path');

/** 创建指定会话目录的草稿存储；目录由主进程传入，不绑定安装路径。 */
function createComposerStore(sessionDir) {
  const pending = new Map();

  /** 草稿放在独立子目录，不混入原有会话 JSON 列表。 */
  function fileOf(id) { return path.join(sessionDir(), 'drafts', String(id) + '.json'); }

  /** 串行执行同一会话的写入或删除；错误传给调用方，后续明确写入仍可执行。 */
  function enqueue(id, operation) {
    const previous = pending.get(id);
    const next = previous ? previous.then(operation, operation) : operation();
    pending.set(id, next);
    function settled() { if (pending.get(id) === next) pending.delete(id); }
    next.then(settled, settled);
    return next;
  }

  /** 保存草稿和恢复新对话所需的少量元数据；不接收历史消息。 */
  function save(data) {
    const draft = { id: data.id, title: data.title, workspace: data.workspace,
      composer: data.composer, updatedAt: data.updatedAt };
    async function write() {
      const file = fileOf(data.id);
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file + '.tmp', JSON.stringify(draft), 'utf8');
      await fs.promises.rename(file + '.tmp', file);
    }
    return enqueue(data.id, write);
  }

  /** 读取已保存草稿；旧会话尚无草稿文件是正常状态，其他读取错误照常报告。 */
  async function load(id) {
    const job = pending.get(id);
    if (job) await job;
    try {
      return JSON.parse(await fs.promises.readFile(fileOf(id), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /** 列出草稿，包括从未发送过消息的新对话，供项目恢复和历史列表合并。 */
  async function list() {
    let names;
    try {
      names = await fs.promises.readdir(path.join(sessionDir(), 'drafts'));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
    const drafts = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const draft = await load(name.slice(0, -5));
      if (draft) drafts.push(draft);
    }
    return drafts;
  }

  /** 用户明确删除会话时同步删除草稿；排在已提交写入之后，避免旧草稿复活。 */
  function remove(id) {
    async function unlink() {
      try { await fs.promises.unlink(fileOf(id)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return enqueue(id, unlink);
  }

  return { save, load, list, remove };
}

module.exports = { createComposerStore };
