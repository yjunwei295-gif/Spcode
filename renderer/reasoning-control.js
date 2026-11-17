// 推理设置按模型单独缓存目录；切换模型不沿用上一模型的档位。
const optionRequests = new Map();
const labels = { none: '关闭', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '超高', max: '最大', ultra: '极强' };

/**
 * 为传入的模型绘制独立推理强度控件，供顶栏快捷入口和模型管理逐项复用。
 * 只展示主进程从厂商目录取得的档位；查询、保存失败直接展示原错误，不自动换档。
 */
export async function renderReasoningControl(root, model, api, save) {
  root.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = '推理强度';
  const hint = document.createElement('small');
  hint.textContent = '正在查询模型能力…';
  root.append(title, hint);
  if (!model || model.type !== 'api') {
    hint.textContent = '当前模型未接入可调推理强度';
    return;
  }
  // 同一模型的菜单重绘复用正在进行的目录查询，避免并发重复请求。
  const key = JSON.stringify([model.id, model.model, model.providerId, model.baseUrl, model.protocol]);
  let options;
  try {
    if (!optionRequests.has(key)) optionRequests.set(key, api.modelReasoningOptions(model.id));
    options = await optionRequests.get(key);
  }
  catch (error) {
    optionRequests.delete(key);
    if (root.isConnected) hint.textContent = '能力查询失败：' + error.message;
    return;
  }
  if (!root.isConnected) return;
  if (!options.length) {
    hint.textContent = '厂商目录未声明可调档位';
    return;
  }
  const select = document.createElement('select');
  select.setAttribute('aria-label', '推理强度');
  select.dataset.reasoningModel = model.id;
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = '模型默认';
  select.append(defaultOption);
  for (const item of options) {
    const option = document.createElement('option');
    option.value = item.value;
    option.textContent = labels[item.value] || item.label;
    option.title = item.description || '';
    select.append(option);
  }
  const saved = model.reasoningEffort || '';
  // 已保存但厂商删除的档位保持可见，要求用户明确重选，不静默降档。
  if (saved && !options.some(function hasOption(option) { return option.value === saved; })) {
    const invalid = document.createElement('option');
    invalid.value = saved;
    invalid.textContent = saved + '（目录已不支持，请重选）';
    invalid.disabled = true;
    select.append(invalid);
  }
  select.value = saved;
  hint.textContent = '按模型保存，下一轮请求生效；Codex 此项用于工作模式';
  root.insertBefore(select, hint);
  select.onclick = function keepMenu(event) { event.stopPropagation(); };
  select.onchange = async function saveReasoning() {
    select.disabled = true;
    try {
      await save(model.id, select.value);
      hint.textContent = '已保存，下一轮请求生效';
    } catch (error) {
      hint.textContent = '保存失败：' + error.message;
    } finally { select.disabled = false; }
  };
}
