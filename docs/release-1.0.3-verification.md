# SimpleCode 1.0.3 发布核对

本轮按当前工作区实际源码验证与打包，不沿用旧版本的通过结论。

## 源码行为验证

- `electron scripts/test-pet-dashboard.cjs --screenshot`：75 项通过，覆盖当前大脑额度、三行正文在角色上方、余额在脚下、四档缩放、X/Y 真实像素微调与设置恢复。
- `electron scripts/test-pet-activity.cjs --hud-only`：75 项通过；两项原生桌面命中检查明确跳过，不计为通过。
- `electron scripts/test-pet-glasses.cjs`：20 项通过，覆盖 16 状态尖角镜形与原始资源哈希不变。
- `electron scripts/test-pet-glasses-motion.cjs`：实际图集 192 帧、470 个纹理点配准通过；最大额外位移修正为 0px，非零 X/Y 下四次动作切换实际像素一致。
- `node scripts/test-desktop-pet-state.cjs`：13 项通过，覆盖工具失败重试后不误报失败及真实失败保留。
- `electron scripts/test-local-image-generation.cjs`：18 项通过，覆盖设置、实际 IPC、工具协议、参数与参考图完整透传。本轮未重新执行 `--real` 模型出图质量测试。
- `electron scripts/test-ui-performance.cjs`：24 项通过，覆盖完整页面、流式输入、草稿和历史恢复。
- `git diff --check` 通过。版本锁文件仅修改项目版本两处，依赖版本保持原值。

## 实际打包产物

- 后台运行 `npm.cmd run dist:win`，日志为 `dist/build-1.0.3.log`；已生成 Windows x64 NSIS 安装包及便携 EXE。
- 安装包 `dist/SimpleCode Setup 1.0.3.exe`：694245696 字节，SHA256 为 `689aa2645a5f85b0e597e9a0e3952265e56e09b14e146512479fc79c198bef21`；便携版为 694002920 字节。
- `node scripts/verify-release.cjs`：7 项通过。实际启动 `dist/win-unpacked/SimpleCode.exe`，主进程版本为 1.0.3，`app.isPackaged` 为 true，使用独立测试数据目录。
- 主界面、真实 preload IPC、桌宠 X/Y 控件、余额节点和三行正文样式通过；未更改当前用户设置或替换承载会话的运行实例。
- 125 个 electron/renderer 源码与资源文件逐字节对照 ASAR 一致；package.json 按打包器处理后的运行元数据核对版本、入口与依赖一致。
- 成功记录：`generated/release-1.0.3-JxfTr8/results.json`。生成目录仅为本机验证证据，不进入源码提交。

## 修改与提交范围

本轮修改 `package.json`、`package-lock.json` 的项目版本，更新 `scripts/release-notes.md`；新增 `scripts/verify-release.cjs` 和本核对记录。现有未发布的桌宠与本地生图源码、相关文档和测试一起提交。

生成目录、命令残留、个人里程碑及独立 tools 目录保留本机，不纳入发布提交。原先的功能源码未回滚。

## 更新方式与边界

安装包发布后，当前运行的旧实例不会自动换成新版。完全退出旧程序，运行 1.0.3 安装包并安装至原目录，再启动即可；既有设置和会话保留，模型权重不随安装包分发。
