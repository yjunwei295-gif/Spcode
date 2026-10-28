# SimpleCode 1.0.2 发布核对

日期：2026-10-28。此版本按当前工作区代码打包，不将旧汇报当成本轮验收证据。

## 实际通过

- `npm run dist -- --publish never`：退出码 0，生成 Windows x64 NSIS 安装包及便携 EXE。
- `test-desktop-pet-state.cjs`：9 项真实事件状态检查。
- `test-desktop-pet-skins.cjs`：5 项皮肤导入和资源检查。
- `test-interjection-images.cjs`：图片插话和真实 MCP 图片传输检查通过。
- `test-pet-activity.cjs`：41 项真实 Electron 工作图标、会话隔离、缩放及状态切换检查。
- `test-agi-interjections.cjs`：38 项真实插话链路检查。
- `test-code-audio.cjs`：28 项采样、时间线和音视频导出检查。
- `test-artifact-studio.cjs`：31 项作品登记、PNG/SVG/MP4 导出和真实窗口检查。测试取值改为查找真实导出事件，避免误取后续工具状态。
- `test-onboarding.cjs`：15 项独立用户目录和实际 IPC 检查。
- `test-ui-performance.cjs`：24 项草稿、输入、流式回复和完整页面检查。
- 实际运行 `dist/win-unpacked/SimpleCode.exe`：版本为 1.0.2、`app.isPackaged` 为 true；使用隔离数据目录，主界面与 preload 桥接初始化成功。
- 从实际 app.asar 读取 12 个关键文件，与已测试源码逐字节一致；覆盖主进程、preload、桌宠页面/样式/配置/宿主/状态机/猫娘图集、作品和音频入口及主界面。

## 未通过与未实现

- `test-float-input.cjs` 在最小缩放 0.3 时的长气泡与角色分区断言失败，未把它记为通过；后续热键项目未执行。
- 当前 `desktop-pet-config.json` 没有输入唤起键配置，`float-bar.js` 没有 `focusInput`，宿主没有录入唤起键接口。旧文档中关于这些功能已经完成的汇报不代表当前实现。
- 本轮没有更改上述业务行为，也没有回滚既有代码。已将限制列入 GitHub 版本说明。

## 提交范围

提交现有 electron、renderer、docs、scripts 中的项目源码、皮肤资源、文档与测试，以及版本配置。generated 下的生成记录、模型缓存、个人里程碑、命令残留及独立工具目录不纳入这次应用发布提交。

安装后需完全退出旧程序并启动新版；当前承载对话的旧进程不会自动加载安装包中的代码。
