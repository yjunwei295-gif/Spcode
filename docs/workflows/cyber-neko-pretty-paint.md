# 水晶猫娘 · 漂亮插画头工作流（可复现 / 可改）

目标：做出用户认可的「锐利漂亮水晶赛博猫娘头」，并烘焙进桌宠图集。

## 结论口径

- **漂亮头图**用 `generate_media` 生图，不靠手写 SVG 多边形硬凑精致度。
- **桌宠运行**仍用透明 `atlas.png`（192×16 状态×12 帧）。
- 矢量 `art.svg` 保留作部件协议/测试兼容；实际图集由插画头烘焙脚本生成。
- **像素复刻规则**写在 `electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json`：改阈值/采样/膨胀后再跑脚本即可复现或调参；实测规律落在 `crystal-laws.json`。

## 流程

准备提示词--->generate_media 生图--->用户审美确认--->拷贝为 painted-head-source.png--->（可选改 remesh-rules.json）--->remesh-crystal-head 像素级代码复刻--->bake-cyber-neko-painted 烤 atlas--->test-pet-vector / 作品卡自审--->重开桌宠小窗验收

## 1. 生图（关键）

调用 SpCode `generate_media`，`kind=image`，prompt 必须同时满足：

- 锐利漂亮赛博猫娘头像（不要软萌、不要圆墩 chibi）
- 雾紫几何/水晶切面发 + 青/薄荷绿闪电边
- 尖猫耳、锐利眼、自信斜笑、无尖牙、无绿屏面罩、无黑面罩脸
- 纯色灰底（方便去底），只画头/胸像

本轮用户认可稿对应：

- 源文件：`electron/lib/desktop-pet-skins/cyber-neko/painted-head-source.png`
- 同款生成记录：`generated/imageGen-20261027-184151.png`（同风格参考）
- 用户粘贴确认图：`%TEMP%/simple-paste/1793097723330-clipboard.png`

推荐复现 prompt（可微调，但不要改成软萌）：

```text
Beautiful sharp anime cyber catgirl head portrait, mist purple geometric crystal faceted hair with cyan mint lightning tips, pointed cat ears, glowing cyan sharp eyes, porcelain fair skin, confident smirk, crystal cheek and earring accents, hard edge low-poly crystal glamorous style, not soft moe, not chibi, not scary, solid flat dark gray background, head and shoulders only
```

## 2. 落盘

把用户点头的那张图复制为：

`electron/lib/desktop-pet-skins/cyber-neko/painted-head-source.png`

## 3. 像素级代码复刻（找规律 / 可改规则）

可编辑规则文件（改完再跑）：

`electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json`

常用可改字段：`chroma.floodThresh`、`chroma.expandThresh`、`chroma.expandPasses`、`chroma.edgeStep`。

```bat
npx electron scripts/remesh-crystal-head.cjs
```

脚本会：按规则边缘洪水去灰底 → 每个不透明像素用代码按原色 `fillRect` 重画 → 写出 `remesh-head.png`、主色/色带规律 `crystal-laws.json` / `crystal-laws.md`。

## 4. 烘焙图集

```bat
npx electron scripts/bake-cyber-neko-painted.cjs
```

优先吃 `remesh-head.png`（代码复刻头），没有才用 `painted-head-source.png`。

脚本会：

1. 边缘洪水去紫灰底做成透明（与 remesh 同款，不用饱和度阈值）
2. 按包围盒裁切
3. 写入 16 状态 × 12 帧 `atlas.png`（呼吸/侧倾/成功跳跃等轻动效）
4. 叠加锐利嘴形与头旁状态标
5. 更新 `skin.json`，并导出 `painted-head.png` 透明单头

## 5. 核对

```bat
npx electron scripts/test-pet-vector.cjs
```

再用 `generated/desktop-pet-check/mist-pet.html` 作品卡看大图；重开桌宠小窗看运行效果。

## 6. 验收标准（审美）

- 一眼是漂亮锐利赛博猫娘，不是丑图标/辛德拉贴图/眼镜框脸
- 保留雾紫 + 青彩水晶感
- 小尺寸仍可读五官与猫耳

## 禁止

- 未获用户认可就把未过关 SVG 图标脸当交付
- 用 Photos 突然弹吓人中间稿
- 把软萌圆脸当「漂亮」交差
