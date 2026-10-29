/**
 * 本地生图参数的共同约定：设置界面、工具协议和引擎使用同一份定义。
 * 像素预设只提供可修改的起点，不替换用户的模型，也不保证帧间身份一致。
 */
(function exposeImageOptions(root) {
  'use strict';
  const SAMPLERS = ['euler', 'euler_a', 'heun', 'dpm2', 'dpm++2s_a', 'dpm++2m', 'dpm++2mv2', 'ipndm', 'ipndm_v', 'lcm', 'ddim_trailing', 'tcd', 'res_multistep', 'res_2s', 'er_sde', 'euler_cfg_pp', 'euler_a_cfg_pp', 'euler_ge', 'dpm++2m_sde', 'dpm++2m_sde_bt', 'lms'];
  const FIELDS = {
    width: { label: '宽度（像素，64 的倍数）', flag: '-W', type: 'integer', minimum: 64, multipleOf: 64 },
    height: { label: '高度（像素，64 的倍数）', flag: '-H', type: 'integer', minimum: 64, multipleOf: 64 },
    steps: { label: '采样步数', flag: '--steps', type: 'integer', minimum: 1 },
    seed: { label: '种子（-1 随机；固定值便于复现）', flag: '--seed', type: 'integer', minimum: -1 },
    strength: { label: '重绘强度（0～1，越低越接近参考图）', flag: '--strength', type: 'number', minimum: 0, maximum: 1 },
    cfgScale: { label: 'CFG 提示词引导', flag: '--cfg-scale', type: 'number', minimum: 0 },
    samplingMethod: { label: '采样器', flag: '--sampling-method', type: 'string', enum: SAMPLERS },
    negativePrompt: { label: '反向提示词', flag: '--negative-prompt', type: 'string' }
  };
  const PIXEL = {
    width: 512, height: 512, steps: 28, seed: 42, strength: 0.35, samplingMethod: 'euler',
    negativePrompt: 'blurry, anti-aliasing, smooth gradients, photorealistic, text, watermark'
  };
  const PIXEL_PROMPT = 'pixel art sprite, crisp pixel edges, limited color palette, flat colors, consistent character proportions, single animation frame, plain background';
  const SCHEMA = { preset: { type: 'string', enum: ['custom', 'pixel'], description: '本地生图配置；pixel 为可覆盖参数的像素动画预设' } };
  for (const [key, field] of Object.entries(FIELDS)) {
    const spec = { type: field.type, description: field.label };
    for (const rule of ['minimum', 'maximum', 'multipleOf', 'enum']) {
      if (field[rule] !== undefined) spec[rule] = field[rule];
    }
    SCHEMA[key] = spec;
  }

  /**
   * 读取显式参数并拒绝无效值；不把无效输入静默改成默认值。
   * 空对象保留原引擎行为；设置表单的空输入在调用前省略。
   */
  function normalize(raw = {}) {
    const out = {};
    if (raw.preset !== undefined) {
      if (!SCHEMA.preset.enum.includes(raw.preset)) throw new Error('未知本地生图配置：' + raw.preset);
      out.preset = raw.preset;
    }
    for (const [key, field] of Object.entries(FIELDS)) {
      const value = raw[key];
      if (value === undefined) continue;
      if (field.type === 'string') {
        if (typeof value !== 'string' || (field.enum && !field.enum.includes(value))) throw new Error(field.label + '无效');
      } else {
        if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(field.label + '必须是有效数字');
        if (field.type === 'integer' && !Number.isSafeInteger(value)) throw new Error(field.label + '必须是整数');
        if (field.minimum !== undefined && value < field.minimum) throw new Error(field.label + '不能小于 ' + field.minimum);
        if (field.maximum !== undefined && value > field.maximum) throw new Error(field.label + '不能大于 ' + field.maximum);
        if (field.multipleOf && value % field.multipleOf !== 0) throw new Error(field.label + '必须是 ' + field.multipleOf + ' 的倍数');
      }
      out[key] = value;
    }
    return out;
  }

  /** 合并设置与单次参数；单次明确选择配置时，使用该配置再应用单次覆盖值。 */
  function merge(saved = {}, request = {}) {
    const base = normalize(saved);
    const current = normalize(request);
    if (current.preset !== undefined && current.preset !== base.preset) return current;
    return Object.assign(base, current);
  }

  /** 按模型配方补齐原有默认参数，再应用预设和显式参数；不修改调用方对象。 */
  function resolve(raw, recipe) {
    const explicit = normalize(raw);
    const defaults = { width: 768, height: 768, steps: 20 };
    if (recipe === 'qwen-image') Object.assign(defaults, { steps: 28, cfgScale: 2.5, samplingMethod: 'euler' });
    if (recipe === 'flux' || recipe === 'z-image') defaults.samplingMethod = 'euler';
    return Object.assign(defaults, explicit.preset === 'pixel' ? PIXEL : {}, explicit);
  }

  /** 将已解析的参数逐项转换为独立 CLI 参数；路径、提示词不经过 shell 拼接。 */
  function cliArgs(options) {
    const args = [];
    for (const [key, field] of Object.entries(FIELDS)) {
      if (options[key] !== undefined) args.push(field.flag, String(options[key]));
    }
    return args;
  }

  /** 仅在用户选择像素配置时追加风格描述，保留原始主体与动作要求。 */
  function promptFor(prompt, options) {
    const text = String(prompt || '').trim() || 'a simple illustration';
    return options.preset === 'pixel' ? text + '\n' + PIXEL_PROMPT : text;
  }
  const api = { FIELDS, SCHEMA, PIXEL, normalize, merge, resolve, cliArgs, promptFor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window === 'object') root.SpCodeImageOptions = api;
})(globalThis);
