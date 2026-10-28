// 用纯代码高清绘制水晶猫娘各表情头，写入皮肤目录并生成对照条。
'use strict';
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');
const { getDrawSource } = require('./lib/crystal-neko-draw');
const remeshRules = require('../electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json');

const root = path.join(__dirname, '..');
const skinDir = path.join(root, 'electron/lib/desktop-pet-skins/cyber-neko');
const outDir = path.join(root, 'generated/desktop-pet-check');
const SIZE = 768;

async function run() {
  const win = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    webPreferences: { offscreen: true, webSecurity: false }
  });
  await win.loadURL('about:blank');

  const expressions = remeshRules.expressions || {};
  const drawSrc = getDrawSource();
  const states = ['idle', 'thinking', 'speaking', 'success', 'error', 'stopped', 'waiting', 'generating'];

  const result = await win.webContents.executeJavaScript(`(async function(){
    ${drawSrc}
    const SIZE=${SIZE};
    const expressions=${JSON.stringify(expressions)};
    const states=${JSON.stringify(states)};

    function render(state, wave){
      const c=document.createElement('canvas');
      c.width=SIZE; c.height=SIZE;
      const ctx=c.getContext('2d');
      const p=expressions[state]||expressions.idle||{lid:0.1,mouth:'smile',open:0.2,glow:1};
      drawCrystalNeko(ctx, SIZE, {
        lid:p.lid||0,
        mouth:p.mouth||'smile',
        open:p.open||0.2,
        glow:p.glow||1,
        wave:wave||0
      });
      return c;
    }

    const heads={};
    for(let i=0;i<states.length;i++){
      const st=states[i];
      heads[st]=render(st, 0).toDataURL('image/png').split(',')[1];
    }

    // 对照条
    const cell=360;
    const board=document.createElement('canvas');
    board.width=cell*states.length+24;
    board.height=cell+64;
    const bc=board.getContext('2d');
    bc.fillStyle='#16191f';
    bc.fillRect(0,0,board.width,board.height);
    bc.fillStyle='#e8edf5';
    bc.font='24px sans-serif';
    for(let i=0;i<states.length;i++){
      const st=states[i];
      const c=render(st, 0);
      bc.drawImage(c, 12+i*cell, 48, cell, cell);
      bc.fillText(st, 24+i*cell, 34);
    }

    // idle 高清头（透明底）作新源
    const idle=render('idle', 0);
    return {
      idle: idle.toDataURL('image/png').split(',')[1],
      strip: board.toDataURL('image/png').split(',')[1],
      heads: heads
    };
  })()`);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(skinDir, 'code-head.png'), Buffer.from(result.idle, 'base64'));
  fs.writeFileSync(path.join(skinDir, 'remesh-head.png'), Buffer.from(result.idle, 'base64'));
  fs.writeFileSync(path.join(outDir, 'crystal-code-expressions.png'), Buffer.from(result.strip, 'base64'));
  fs.writeFileSync(path.join(outDir, 'crystal-pure-expressions.png'), Buffer.from(result.strip, 'base64'));

  const headsDir = path.join(outDir, 'crystal-code-heads');
  fs.mkdirSync(headsDir, { recursive: true });
  const headKeys = Object.keys(result.heads);
  for (let i = 0; i < headKeys.length; i++) {
    const st = headKeys[i];
    fs.writeFileSync(path.join(headsDir, st + '.png'), Buffer.from(result.heads[st], 'base64'));
  }

  // 标记规则：烘焙优先吃代码头；假几何嘴关闭（嘴已在代码头里）
  remeshRules.face = remeshRules.face || {};
  remeshRules.face.paintMouth = false;
  remeshRules.face.paintBlink = false;
  remeshRules.face.说明 = '表情由 scripts/draw-crystal-neko-code.cjs 纯代码画进头图；bake 不再叠几何嘴/睑';
  remeshRules.source = 'code-head.png';
  remeshRules.draw = {
    method: 'canvas-paths',
    script: 'scripts/draw-crystal-neko-code.cjs',
    size: SIZE,
    说明: '矢量路径+渐变高清绘制，不做 1×1 像素复刻'
  };
  fs.writeFileSync(
    path.join(skinDir, 'remesh-rules.json'),
    JSON.stringify(remeshRules, null, 2),
    'utf8'
  );

  console.log('code-draw ok size=' + SIZE + ' heads=' + headKeys.join(','));
  win.destroy();
  app.quit();
}

app.whenReady().then(run).catch(function (err) {
  console.error(err);
  process.exit(1);
});
