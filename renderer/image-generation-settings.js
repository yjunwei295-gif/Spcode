import '../electron/lib/image-gen-options.js';

const options = window.SpCodeImageOptions;

/** 转义设置值，避免提示词内容被当作表单标记。 */
function escapeValue(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * 绘制本地生图参数区；空项表示沿用模型配方，预设必须由用户主动选择。
 * 参考图属于单次任务，通过对话附件或路径指定，不持久化成所有任务的输入图。
 */
export function imageSettingsHtml(saved = {}) {
  const raw = options.normalize(saved);
  let html = '<div class="sep-line"></div><section id="local-image-settings"><h3>本地生图 / 图生图</h3>' +
    '<p class="hint">附上参考图并说明动作，或在对话中指定图片路径，即可图生图；下一帧可引用上一帧输出。以下参数仅影响本地生图，单次对话指定值优先，留空沿用模型配方。</p>' +
    '<label for="image-preset">生成配置</label><select id="image-preset"><option value="custom">自定义 / 模型配方</option><option value="pixel">像素动画</option></select>' +
    '<p class="hint">像素动画预设：512×512、28 步、固定种子 42、重绘强度 0.35、Euler；追加像素风提示词并以最近邻缩放参考图。参数都可继续修改；低重绘强度更贴近原图，固定种子不保证角色完全一致。</p>';
  for (const [key, field] of Object.entries(options.FIELDS)) {
    const value = raw[key] === undefined ? '' : escapeValue(raw[key]);
    html += '<label for="image-' + key + '">' + field.label + '</label>';
    if (field.enum) {
      html += '<select id="image-' + key + '"><option value="">模型配方</option>';
      for (const choice of field.enum) html += '<option value="' + choice + '"' + (raw[key] === choice ? ' selected' : '') + '>' + choice + '</option>';
      html += '</select>';
    } else if (field.type === 'string') {
      html += '<textarea id="image-' + key + '" class="short" rows="2">' + value + '</textarea>';
    } else {
      html += '<input id="image-' + key + '" type="number" value="' + value + '" step="' + (field.multipleOf || (field.type === 'integer' ? 1 : 'any')) + '"' +
        (field.minimum === undefined ? '' : ' min="' + field.minimum + '"') +
        (field.maximum === undefined ? '' : ' max="' + field.maximum + '"') + ' placeholder="模型配方" />';
    }
  }
  return html + '</section>';
}

/** 选择像素配置时填入可编辑的参数；切回自定义保留用户当前数值，只移除风格约定。 */
export function bindImageSettings(container, saved = {}) {
  const preset = container.querySelector('#image-preset');
  preset.value = saved.preset || 'custom';
  preset.onchange = function applyPixelPreset() {
    if (preset.value !== 'pixel') return;
    for (const [key, value] of Object.entries(options.PIXEL)) container.querySelector('#image-' + key).value = String(value);
  };
}

/** 先读取并校验整个参数区，只有合法表单才能交给设置保存流程。 */
export function readImageSettings(container) {
  const raw = { preset: container.querySelector('#image-preset').value };
  for (const [key, field] of Object.entries(options.FIELDS)) {
    const input = container.querySelector('#image-' + key);
    if (!input.checkValidity()) throw new Error(field.label + '无效，请检查数值范围');
    if (input.value === '' && (field.type !== 'string' || field.enum)) continue;
    raw[key] = field.type === 'string' ? input.value : Number(input.value);
  }
  return options.normalize(raw);
}
