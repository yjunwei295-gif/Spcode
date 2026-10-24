/**
 * 合并一个窗口对模型或厂商目录的实际编辑，保留其他窗口新增及更新的条目。
 * current 为当前磁盘目录，baseline 为该窗口上次收到的目录，incoming 为本次提交目录。
 * 只删除 baseline 中本次明确移除的条目；同一条目被本窗口改过时，以本次用户编辑为准。
 * 返回新数组，不修改三份输入；仅用于带 id 的模型和厂商配置列表。
 */
function mergeCatalogEdits(current, baseline, incoming) {
  const before = new Map();
  const after = new Map();
  for (const item of baseline) before.set(item.id, item);
  for (const item of incoming) after.set(item.id, item);
  const result = [];
  const seen = new Set();
  for (const item of current) {
    seen.add(item.id);
    if (before.has(item.id) && !after.has(item.id)) continue;
    const edited = after.get(item.id);
    if (edited && JSON.stringify(edited) !== JSON.stringify(before.get(item.id))) {
      result.push(edited);
    } else {
      result.push(item);
    }
  }
  for (const item of incoming) {
    if (seen.has(item.id)) continue;
    // 另一窗口删除过、而本窗口未编辑的旧条目不能复活；真正新增或编辑的条目照常保存。
    if (JSON.stringify(item) !== JSON.stringify(before.get(item.id))) result.push(item);
  }
  return result;
}

module.exports = { mergeCatalogEdits };
