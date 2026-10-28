// 水晶猫娘 · 纯代码高清绘制（不贴糊像素复刻）
// 导出 getDrawSource()：返回可在 BrowserWindow 里 executeJavaScript 的函数源码字符串。
'use strict';

function getDrawSource() {
  return String(function drawCrystalNeko(ctx, size, expr) {
    // expr: { lid, mouth, open, glow, wave }
    var S = size / 800;
    function sc(n) { return n * S; }
    function col(hex, a) {
      if (a === undefined || a >= 1) return hex;
      var r = parseInt(hex.slice(1, 3), 16);
      var g = parseInt(hex.slice(3, 5), 16);
      var b = parseInt(hex.slice(5, 7), 16);
      return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
    }
    var C = {
      hair: '#9b87e8',
      hairShadow: '#554283',
      hairLight: '#cfbdff',
      face: '#fff4fb',
      faceEdge: '#d4c4ec',
      ink: '#1a1230',
      accent: '#63f0b3',
      secondary: '#67cfff',
      blush: '#ff8aa8',
      jacket: '#f4f7fc',
      metal: '#f6fff9',
      lip: '#c070a0',
      lipDark: '#7a4068',
      lid: '#e8d4f0'
    };
    var lid = expr && expr.lid != null ? expr.lid : 0.1;
    var mouthKind = (expr && expr.mouth) || 'smile';
    var open = expr && expr.open != null ? expr.open : 0.2;
    var glow = expr && expr.glow != null ? expr.glow : 1;
    var wave = expr && expr.wave != null ? expr.wave : 0;

    ctx.clearRect(0, 0, size, size);
    ctx.save();
    ctx.translate(sc(wave * 3), sc(wave * 2));

    // —— 后发 ——
    function fillPath(pts, fill) {
      ctx.beginPath();
      ctx.moveTo(sc(pts[0]), sc(pts[1]));
      for (var i = 2; i < pts.length; i += 2) ctx.lineTo(sc(pts[i]), sc(pts[i + 1]));
      ctx.closePath();
      ctx.fillStyle = fill;
      ctx.fill();
    }
    fillPath([215,300,255,160,330,90,400,70,480,90,555,165,605,305,620,440,565,560,485,515,440,620,400,645,360,620,315,515,235,560,180,430], C.hairShadow);
    fillPath([235,295,270,170,335,100,400,82,475,100,540,175,585,300,598,430,550,540,475,500,435,595,400,612,365,595,325,500,250,540,202,420], C.hair);
    // 发顶高光
    var hg = ctx.createLinearGradient(sc(320), sc(120), sc(480), sc(260));
    hg.addColorStop(0, col(C.hairLight, 0.95));
    hg.addColorStop(1, col(C.hair, 0.15));
    fillPath([310,240,355,150,400,125,455,150,495,240,465,265,400,235,340,265], hg);

    // 猫耳
    fillPath([265,210,200,20,340,155], C.hair);
    fillPath([268,195,225,70,320,155], C.blush);
    fillPath([270,185,240,95,305,150], C.secondary);
    fillPath([535,210,600,20,460,155], C.hair);
    fillPath([532,195,575,70,480,155], C.blush);
    fillPath([530,185,560,95,495,150], C.accent);

    // 侧垂闪电发
    fillPath([210,350,145,400,165,435,120,505,160,480,205,425,220,455,255,380], C.hair);
    fillPath([590,350,655,400,635,435,680,505,640,480,595,425,580,455,545,380], C.hair);
    fillPath([155,405,130,470,158,480,185,425], C.secondary);
    fillPath([645,405,670,470,642,480,615,425], C.accent);

    // —— 脸 ——
    fillPath([265,250,330,175,400,155,485,180,545,255,540,400,475,515,400,550,325,515,260,400], C.hairShadow);
    var faceG = ctx.createRadialGradient(sc(400), sc(320), sc(40), sc(400), sc(360), sc(220));
    faceG.addColorStop(0, '#fffafd');
    faceG.addColorStop(0.55, C.face);
    faceG.addColorStop(1, C.faceEdge);
    fillPath([280,260,340,190,400,172,470,195,530,265,525,395,465,505,400,530,335,505,275,395], faceG);
    // 颊影
    fillPath([290,280,320,260,342,405,368,475,400,520,378,525,335,475,285,390], col(C.faceEdge, 0.55));
    fillPath([468,240,520,265,514,400,468,475,438,490,482,390], col(C.faceEdge, 0.45));
    // 腮红
    ctx.fillStyle = col(C.blush, 0.55);
    ctx.beginPath(); ctx.ellipse(sc(320), sc(412), sc(28), sc(12), -0.25, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.ellipse(sc(480), sc(412), sc(28), sc(12), 0.25, 0, Math.PI * 2); ctx.fill();

    // —— 眉 ——
    ctx.fillStyle = C.ink;
    fillPath([282,258,355,292,360,300,288,270], C.ink);
    fillPath([440,292,528,258,520,270,435,300], C.ink);

    // —— 眼（可眨眼）——
    function drawEye(cx, cy, flip) {
      var ex = flip ? -1 : 1;
      ctx.save();
      ctx.translate(sc(cx), sc(cy));
      // 眼窝裁剪：上睑下压
      var eyeH = sc(42);
      var eyeW = sc(52);
      var close = Math.max(0, Math.min(1, lid));
      ctx.beginPath();
      ctx.ellipse(0, sc(8), eyeW, eyeH * (1 - close * 0.92), 0, 0, Math.PI * 2);
      ctx.clip();
      // 眼白
      ctx.fillStyle = C.jacket;
      ctx.beginPath();
      ctx.ellipse(0, sc(8), eyeW, eyeH, 0, 0, Math.PI * 2);
      ctx.fill();
      // 紫虹
      var irisG = ctx.createRadialGradient(sc(-4), sc(4), sc(2), 0, sc(10), sc(28));
      irisG.addColorStop(0, C.hairLight);
      irisG.addColorStop(0.45, C.hair);
      irisG.addColorStop(1, C.hairShadow);
      ctx.fillStyle = irisG;
      ctx.beginPath();
      ctx.ellipse(sc(ex * 2), sc(10), sc(26), sc(28), 0, 0, Math.PI * 2);
      ctx.fill();
      // 青核发光
      var g = Math.max(0.4, Math.min(1.4, glow));
      ctx.fillStyle = col(C.secondary, 0.55 + 0.35 * Math.min(1, g));
      ctx.beginPath();
      ctx.ellipse(sc(ex * 2), sc(12), sc(11 * g), sc(12 * g), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = col(C.accent, 0.35 * g);
      ctx.beginPath();
      ctx.ellipse(sc(ex * 2), sc(12), sc(6 * g), sc(7 * g), 0, 0, Math.PI * 2);
      ctx.fill();
      // 瞳孔
      ctx.fillStyle = C.ink;
      ctx.beginPath();
      ctx.ellipse(sc(ex * 2), sc(12), sc(5), sc(14), 0, 0, Math.PI * 2);
      ctx.fill();
      // 高光
      ctx.fillStyle = C.metal;
      ctx.beginPath(); ctx.ellipse(sc(ex * -10), sc(-2), sc(7), sc(5), 0, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.ellipse(sc(ex * 8), sc(18), sc(4), sc(3), 0, 0, Math.PI * 2); ctx.fill();
      ctx.restore();

      // 上眼睑覆盖
      if (close > 0.04) {
        ctx.save();
        ctx.translate(sc(cx), sc(cy));
        var cover = eyeH * 2 * close;
        ctx.fillStyle = C.lid;
        ctx.beginPath();
        ctx.ellipse(0, sc(8) - eyeH + cover * 0.35, eyeW + sc(4), cover * 0.55 + sc(6), 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = col(C.ink, 0.75);
        ctx.lineWidth = sc(3.5);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(-eyeW + sc(2), sc(8) - eyeH + cover);
        ctx.quadraticCurveTo(0, sc(8) - eyeH + cover + sc(close > 0.6 ? 4 : -2), eyeW - sc(2), sc(8) - eyeH + cover);
        ctx.stroke();
        ctx.restore();
      }
      // 上眼线
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = sc(4);
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(sc(cx - ex * 40), sc(cy - 6));
      ctx.quadraticCurveTo(sc(cx), sc(cy - 18), sc(cx + ex * 44), sc(cy - 2));
      ctx.stroke();
    }
    drawEye(338, 330, false);
    drawEye(462, 330, true);

    // —— 嘴（折纸斜笑，匹配插画）——
    var mx = 400, my = 455;
    if (mouthKind === 'open') open = open + (wave + 1) * 0.12;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'miter';
    ctx.strokeStyle = C.lip;
    ctx.fillStyle = C.lipDark;
    ctx.lineWidth = sc(5.5);
    if (mouthKind === 'frown') {
      ctx.beginPath();
      ctx.moveTo(sc(mx - 42), sc(my + 8));
      ctx.quadraticCurveTo(sc(mx), sc(my - 14 - open * 16), sc(mx + 42), sc(my + 8));
      ctx.stroke();
    } else if (mouthKind === 'flat') {
      ctx.beginPath();
      ctx.moveTo(sc(mx - 36), sc(my));
      ctx.lineTo(sc(mx + 36), sc(my + 1));
      ctx.stroke();
    } else if (mouthKind === 'open') {
      var oh = 10 + open * 28;
      ctx.beginPath();
      ctx.moveTo(sc(mx - 38), sc(my - 4));
      ctx.lineTo(sc(mx - 12), sc(my + oh));
      ctx.lineTo(sc(mx + 12), sc(my + oh + 2));
      ctx.lineTo(sc(mx + 38), sc(my - 2));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // 齿一线
      ctx.strokeStyle = col(C.jacket, 0.85);
      ctx.lineWidth = sc(3);
      ctx.beginPath();
      ctx.moveTo(sc(mx - 18), sc(my + 2));
      ctx.lineTo(sc(mx + 18), sc(my + 3));
      ctx.stroke();
    } else {
      // smile：折纸斜笑（与 art.svg mouth-guide 同构）
      var lift = 8 + open * 18;
      ctx.beginPath();
      ctx.moveTo(sc(mx - 40), sc(my - 4));
      ctx.lineTo(sc(mx - 8), sc(my + lift));
      ctx.lineTo(sc(mx), sc(my + 2));
      ctx.lineTo(sc(mx + 8), sc(my + lift));
      ctx.lineTo(sc(mx + 40), sc(my - 8));
      ctx.stroke();
      if (open > 0.25) {
        ctx.fillStyle = C.lipDark;
        ctx.beginPath();
        ctx.moveTo(sc(mx - 18), sc(my + 2));
        ctx.lineTo(sc(mx), sc(my + lift * 0.7));
        ctx.lineTo(sc(mx + 10), sc(my + 4));
        ctx.closePath();
        ctx.fill();
      }
    }
    ctx.restore();

    // —— 前发 ——
    fillPath([275,230,245,130,280,115,265,55,310,85,345,160,330,180,360,225,325,245,285,238], C.hair);
    fillPath([368,225,352,120,378,100,368,48,400,72,432,48,422,100,448,120,432,225,400,248,380,235], C.hair);
    fillPath([465,230,505,130,480,115,525,55,500,85,455,160,470,180,440,225,475,245,510,235], C.hair);
    fillPath([300,195,285,130,320,122,310,80,340,145,338,190], C.hairLight);
    fillPath([400,198,390,125,418,130,410,80,435,145,422,192], C.hairLight);
    fillPath([260,238,215,160,240,145,200,90,245,120,285,190,275,220,295,245], C.hairShadow);
    fillPath([540,238,585,160,560,145,600,90,555,120,515,190,525,220,505,245], C.hairShadow);
    fillPath([230,135,190,65,260,122], C.accent);
    fillPath([570,130,610,60,535,120], C.secondary);

    // 耳环
    ctx.strokeStyle = C.jacket;
    ctx.lineWidth = sc(3);
    ctx.beginPath(); ctx.arc(sc(255), sc(188), sc(7), 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(sc(545), sc(188), sc(7), 0, Math.PI * 2); ctx.stroke();

    ctx.restore();
  });
}

module.exports = { getDrawSource: getDrawSource };
