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

/**
 * 应用从 SinpoCode 改名为 SimpleCode 后，userData 目录会换地方。
 * 新目录还没有 settings.json 时，把旧目录里的设置、会话、快照搬过来，避免用户数据「消失」。
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
    copyIfMissing(path.join(src, name), path.join(dest, name));
  }
  fs.writeFileSync(path.join(dest, '.migrated-from-sinpo'), JSON.stringify({
    from: src,
    at: new Date().toISOString()
  }), 'utf8');
  result.copied = true;
  return result;
}

module.exports = { migrateUserData };
