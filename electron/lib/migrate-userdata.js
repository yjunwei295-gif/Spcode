const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const LEGACY_NAME = 'SinpoCode';
const COPY_NAMES = ['settings.json', 'sessions', 'snapshots', 'logs'];

function copyIfMissing(src, dest) {
  if (!fs.existsSync(src)) return;
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      copyIfMissing(path.join(src, name), path.join(dest, name));
    }
    return;
  }
  if (fs.existsSync(dest)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function stripApiKeys(node) {
  if (Array.isArray(node)) {
    // 逐项清理数组内容，避免密钥藏在设置数组的对象中。
    for (let index = 0; index < node.length; index += 1) {
      node[index] = stripApiKeys(node[index]);
    }
    return node;
  }
  if (node !== null && typeof node === 'object') {
    // 保留密钥字段但清空值，让设置页仍能识别并显示空输入框。
    const keys = Object.keys(node);
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index];
      const normalizedKey = String(key).toLowerCase();
      if (normalizedKey === 'apikey' || normalizedKey === 'api_key') {
        node[key] = '';
      } else {
        node[key] = stripApiKeys(node[key]);
      }
    }
    return node;
  }
  return node;
}

function copySettingsWithoutKeys(src, dest) {
  if (fs.existsSync(dest)) return;
  const text = fs.readFileSync(src, 'utf8');
  let settings;
  try {
    settings = JSON.parse(text);
  } catch (error) {
    // 保留损坏配置以便后续修复，并提醒用户检查其中可能残留的密钥。
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    console.warn('旧配置解析失败，已按原样复制，请到设置页确认 API Key 是否需要清除');
    return;
  }
  const sanitizedSettings = stripApiKeys(settings);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(sanitizedSettings, null, 2), 'utf8');
}

/**
 * 应用从 SinpoCode 改名为 SimpleCode 后，userData 目录会换地方。
 * 迁移时保留设置、会话、快照、日志，但主动清空 settings.json 里的 apiKey，避免旧机器密钥被带过来。
 */
function migrateUserData() {
  const dest = app.getPath('userData');
  const src = path.join(path.dirname(dest), LEGACY_NAME);
  const result = { from: src, to: dest, copied: false };
  if (!src || src === dest) return result;
  if (!fs.existsSync(path.join(src, 'settings.json'))) return result;
  if (fs.existsSync(path.join(dest, 'settings.json'))) return result;
  fs.mkdirSync(dest, { recursive: true });
  for (const name of COPY_NAMES) {
    const source = path.join(src, name);
    const target = path.join(dest, name);
    if (name === 'settings.json') {
      copySettingsWithoutKeys(source, target);
    } else {
      copyIfMissing(source, target);
    }
  }
  fs.writeFileSync(path.join(dest, '.migrated-from-sinpo'), JSON.stringify({
    from: src,
    at: new Date().toISOString(),
    keysStripped: true
  }), 'utf8');
  result.copied = true;
  return result;
}

module.exports = { migrateUserData };
