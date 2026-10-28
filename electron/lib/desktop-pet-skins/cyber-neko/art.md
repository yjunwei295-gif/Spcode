# 水晶猫娘（插画头 · 高清表情）

本版交付：**用户认可的漂亮水晶赛博猫娘头**，图集格 **384**，并按五官规则改眨眼/嘴型，不再整张静图硬贴。

## 文件

- `painted-head-source.png`：用户点头的漂亮头图（灰底）
- `painted-head.png`：去底透明单头
- `remesh-head.png`：像素级代码复刻透明头
- `remesh-rules.json`：去底阈值、五官框、表情表、高清格（可编辑）
- `atlas.png` / `skin.json`：运行图集（cellSize=384）
- `art.svg` / `art.json`：保留部件协议与色板

## 构建

```bat
npx electron scripts/analyze-crystal-face.cjs
npx electron scripts/remesh-crystal-head.cjs
npx electron scripts/bake-cyber-neko-painted.cjs
npx electron scripts/preview-crystal-expr-heads.cjs
```

## 验收

- 桌宠小窗更清晰（384 格 + 更大显示尺寸）
- 切换 idle / speaking / error / stopped 时嘴型和眼睑明显不同
- 对照：`generated/desktop-pet-check/crystal-pure-expressions.png`
