# SimpleCode 1.0.4

Windows x64 installer with the application runtime included. Node.js is not required to use the installed application.

## English

### What's new
- Long-running goals with recurring checks, per-turn timeout, persistent progress, start/stop controls and memory status.
- Goal and context archive views reuse the existing maps. Historical context can be selected without deleting the full archive.
- Automatic context and visible messages are bounded; manual drafts, attachments and ordinary conversation history are preserved.
- Cursor account/plan diagnostics and re-login handling.
- MXAPI OpenAI-compatible and native Nano asynchronous image generation routes.
- Expanded English and Chinese repository introductions and complete 21-section guides covering the application's feature families, setup and limitations.

### Feature overview
Project open/clone/additional folders; code maps, definitions, searches and call chains; file edits and tracked commands; builds/tests; model providers/catalogs, SDK integrations, local GGUF and model roles; attachments, context filtering, prompt preview, drafts, queues and interjections; Windows desktop tools and screen requests; animated pet and account display; local/API images and other generation routes; HTML/SVG artifacts, PNG/source export, code audio and MP4 rendering; skills/rules/persona/preferences; history, snapshots, milestones and recurring goals.

[Complete English guide](https://github.com/yjunwei295-gif/Spcode/blob/main/docs/user-guide.en.md) · [English introduction](https://github.com/yjunwei295-gif/Spcode/blob/main/README.md)

### Verification and limits
- Scheduler: 89 checks, including 1000 start/stop cycles, 150 scheduled rounds and 60 controlled send rounds.
- Real Electron long-running UI: 11 checks, including map lifecycle and bounded heap observations.
- UI/input: 24; onboarding: 15; local-image settings/routing: 18; artifact workbench: 31.
- AGI screen requests: 27 checks on retry. The first attempt failed the unchanged-image OCR-cache assertion and is retained in the verification record.
- Provider regressions passed after adding the existing Claude dependency to the test fixture; the initial fixture failure is recorded.
- Packaged EXE: 8 checks; all 127 application source/resource files match app.asar, including real recurring-task start/stop IPC.
- No multi-day endurance, live Cursor re-login, paid MXAPI generation, new macOS runtime validation or real social-media publication was performed.

Recurring tasks require SpCode running, computer awake, target conversation active and other tasks idle. They stop after app exit; this is not a background service. Desktop actions additionally require AGI. A fixed image seed does not guarantee frame consistency.

### Install
Download **SimpleCode-Setup-1.0.4.exe**, fully exit the old application, install to the existing directory and relaunch. Uploading the EXE does not update an already running copy. Model weights and service subscriptions are separate.

Installer: **694253462 bytes**. SHA256:
```text
bd503a1b18488fd7b735a5802ab8b7d7d039c5884d0b96a9293de28e443faf3f
```

## 简体中文

### 本次更新
- 长时目标、定时检查、单轮超时、进度持久化、启停和内存状态。
- 目标与上下文记录复用现有导图，筛选历史不删除完整归档。
- 自动上下文和可见消息有界，保留手动草稿、附件和普通聊天。
- Cursor 账号/套餐诊断及重新登录处理。
- MXAPI OpenAI 兼容和原生 Nano 异步生图入口。
- 更新中英文 GitHub 介绍，补齐各 21 章完整手册，涵盖全部主要功能类别、使用条件与边界。

### 功能范围
项目打开/克隆/附加目录；地图、定义、搜索、调用链；文件编辑、命令变更跟踪、构建测试；在线厂商/模型目录、SDK、本地 GGUF、角色组合；附件、上下文筛选、提示词预览、草稿、队列、插话；Windows 桌面工具和屏幕接单；桌宠与额度；本地/API 图片及其他生成路径；HTML/SVG 作品、PNG/源码、代码配乐和 MP4；技能/规则/人设/偏好；历史、快照、里程碑、长期任务。

[完整中文手册](https://github.com/yjunwei295-gif/Spcode/blob/main/docs/user-guide.zh-CN.md) · [中文介绍](https://github.com/yjunwei295-gif/Spcode/blob/main/README.zh-CN.md)

### 核对与边界
调度 89 项、真实长时界面 11 项、UI/输入 24 项、引导 15 项、生图设置路由 18 项、作品 31 项通过。AGI 27 项复测通过，首次 OCR 缓存断言失败如实记录；厂商专项补齐测试替身的 Claude 依赖后通过。真实 EXE 8 项及 127 文件 ASAR 逐字节核对通过。

未执行连续数天、真实 Cursor 换登、付费 MXAPI 出图、新版 Mac 运行或真实社交平台发布。软件运行、电脑未休眠、目标会话活动且其他任务空闲才定时执行；退出后无后台服务，桌面动作另需 AGI。

### 更新方式
完整退出旧程序，下载并运行 **SimpleCode-Setup-1.0.4.exe**，安装至原目录后重新启动。正在运行的旧进程不会自动更新。模型权重与厂商订阅需要另行准备。文件大小和 SHA256 见上方英文部分。
