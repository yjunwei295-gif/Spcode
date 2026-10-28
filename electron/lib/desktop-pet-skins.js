// 皮肤包只提供图集与声明数据；统一检查动作和包内相对资源。
'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const JSZip = require('jszip');
const config = require('./desktop-pet-config.json');

/** 检查清单与实际图集尺寸；不完整皮肤拒绝导入并返回具体原因。 */
function validate(manifest, readAsset) {
  if (manifest.version !== 1) throw new Error('皮肤协议版本必须为 1');
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(manifest.id)) throw new Error('皮肤编号只允许小写字母、数字、横线和下划线');
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) throw new Error('缺少皮肤名称');
  if (typeof manifest.author !== 'string') throw new Error('缺少皮肤作者');
  if (!manifest.atlas || path.isAbsolute(manifest.atlas) || manifest.atlas.includes('..') || manifest.atlas.includes('\\') || !manifest.atlas.endsWith('.png')) throw new Error('图集必须使用包内相对 PNG 路径');
  const png = readAsset(manifest.atlas);
  if (png.length < 24 || png.toString('hex', 0, 8) !== '89504e470d0a1a0a') throw new Error('图集不是有效 PNG');
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (!Number.isInteger(manifest.cellSize) || manifest.cellSize < 32 || manifest.cellSize > 512) throw new Error('帧尺寸必须为 32 至 512 的整数');
  if (!Number.isInteger(manifest.columns) || manifest.columns < 1) throw new Error('图集列数无效');
  if (!Number.isFinite(manifest.fps) || manifest.fps < 1 || manifest.fps > 60) throw new Error('动作帧率必须为 1 至 60');
  if (!Array.isArray(manifest.anchor) || manifest.anchor.length !== 2 || manifest.anchor[0] !== manifest.cellSize / 2 || manifest.anchor[1] !== manifest.cellSize) throw new Error('脚底锚点必须为帧底边中心');
  for (const state of config.states) {
    if (!manifest.animations[state]) throw new Error('缺少动作：' + state);
  }
  // 逐项核对实际声明的动画行，菜单中可选择的动作都必须位于图集内。
  for (const state of Object.keys(manifest.animations)) {
    const clip = manifest.animations[state];
    if (!Number.isInteger(clip.row) || clip.row < 0 || !Number.isInteger(clip.frames) || clip.frames < 1 || clip.frames > manifest.columns) throw new Error('动作帧范围无效：' + state);
    if (typeof clip.loop !== 'boolean') throw new Error('动作必须声明是否循环：' + state);
    if ((clip.row + 1) * manifest.cellSize > height || clip.frames * manifest.cellSize > width) throw new Error('动作超出图集范围：' + state);
  }
  return manifest;
}

/** 创建本机皮肤目录，内置资源来自应用目录，用户皮肤存放于 userData。 */
function createLibrary(userDir) {
  const builtin = path.join(__dirname, 'desktop-pet-skins');
  const imported = path.join(userDir, 'desktop-pet-skins');
  fs.mkdirSync(imported, { recursive: true });
  /** 读取一套完整皮肤并附加渲染用资源地址。 */
  function read(dir) {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8'));
    function asset(name) { return fs.readFileSync(path.join(dir, name)); }
    validate(manifest, asset);
    return Object.assign({}, manifest, { atlasUrl: pathToFileURL(path.join(dir, manifest.atlas)).href });
  }
  /** 枚举目录，损坏的皮肤单独显示错误，不替换为其他角色。 */
  function list() {
    const result = [];
    for (const base of [builtin, imported]) {
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(base, entry.name);
        try { result.push(read(dir)); }
        catch (error) { result.push({ id: entry.name, name: entry.name, error: error.message }); }
      }
    }
    return result;
  }
  /** 导入 ZIP，先完整检查资源，再落盘；同名包拒绝覆盖。 */
  async function importZip(file) {
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    const json = zip.file('skin.json');
    if (!json) throw new Error('皮肤包根目录缺少 skin.json');
    const manifest = JSON.parse(await json.async('string'));
    if (typeof manifest.atlas !== 'string') throw new Error('缺少图集路径');
    const entry = zip.file(manifest.atlas);
    if (!entry) throw new Error('皮肤包缺少图集：' + manifest.atlas);
    const png = await entry.async('nodebuffer');
    function asset() { return png; }
    validate(manifest, asset);
    const dir = path.join(imported, manifest.id);
    if (fs.existsSync(dir) || fs.existsSync(path.join(builtin, manifest.id))) throw new Error('已有同名皮肤，请修改皮肤编号后导入');
    fs.mkdirSync(path.dirname(path.join(dir, manifest.atlas)), { recursive: true });
    fs.writeFileSync(path.join(dir, manifest.atlas), png);
    fs.writeFileSync(path.join(dir, 'skin.json'), JSON.stringify(manifest, null, 2), 'utf8');
    return read(dir);
  }
  return { list, importZip };
}
module.exports = { validate, createLibrary };
