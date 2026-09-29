# SimpleCode 项目地图

> 基于源码通读整理（electron/lib 30 模块 + 顶层 + renderer 骨架）。
> 未逐行读取的文件按文件名与调用关系归纳，未编造内部逻辑。

## 1. 目录结构

```
D:\SpCode\
├── electron\
│   ├── main.js              # 主进程入口：窗口 / IPC 路由 / chat:send 对话入口
│   ├── preload.js           # 桥：向渲染进程暴露 window.simple（兼容旧名 window.sinpo）
│   └── lib\                 # 30 个功能模块（见 §3）
├── renderer\
│   ├── index.html           # 界面骨架：菜单 / 欢迎页 / 聊天页 / 侧栏 / 预览 / 模态 / 灯箱
│   ├── app.js               # 渲染进程主逻辑：状态机 / UI 渲染 / IPC 调用 / 打字机
│   ├── i18n.js              # 国际化：t() / setLocale() / applyDom()
│   ├── markdown.js          # Markdown 渲染
│   ├── styles.css           # 样式
│   └── vision-settings.js  # 模型组合 / 视觉引擎设置界面
├── rules\                   # 注入规则：default / persona / zai-*（生成物）
├── skills\                  # 技能：code-review / explain-code / implement / vision-bridge / zabingsk / zai
├── scripts\                 # 打包分发：dist-win.ps1 / pack-share.ps1 / launch.js
├── build\icon.png
├── package.json             # 元信息 / 依赖 / electron-builder 配置
├── README.md · 启动.bat · icons.*
```

## 2. 三层划分

| 层 | 范围 | 落盘位置 |
|----|------|----------|
| 主进程 | 业务逻辑、模型、工具沙盒、记忆、配置 | `electron/` |
| 渲染进程 | 纯 UI，不发业务请求，只走 IPC | `renderer/` |
| 共享状态 | 配置 / 项目记忆→`userData`；技能 / 规则→`APP_ROOT`（`D:\SpCode` 或打包后 `userData/app-root`） | 二者分离 |

## 3. 模块索引（按职责）

**入口 / 编排**
- `main.js`：窗口 + IPC 路由 + `chat:send`
- `agent.js`：对话循环、工具编排中枢、`buildSystemPrompt`

**模型源**
- `api-protocol.js`：OpenAI/Anthropic/Gemini 统一补全
- `local-llm.js` / `-core.js` / `-host.js`：本地 GGUF（子进程 node-llama-cpp）
- `zbaingAi.js`：本地 Python 大脑守护进程

**视觉**
- `vision-engine.js` / `mmproj.js` / `media.js`(+`-core`/`-worker`)：看图 / 投影文件 / 附件解析

**工具 / 沙盒**
- `workspace.js`：文件读写范围控制（**读全放开，写受限**）
- `sandbox.js`：命令沙盒（cwd + 高危拦截 + 超时）
- `snapshot.js`：改前快照 / undo / redo
- `tool-xml.js`：非标准工具调用格式归一
- `generate.js`：生图 / 视频 / 3D（仅 API）

**记忆**
- `memory.js` / `memory-global.js` / `memory-retrieve.js` / `context-compact.js`

**技能 / 规则 / 语言**
- `skills.js`：技能 / 规则 / 人设读写（同名上层覆盖下层）
- `reply-lang.js`：回复语言

**组合 / 配置 / 硬件**
- `assembly.js`：多模型槽位组合 + 角色路由
- `store.js`：配置中心（`resolveModelCfg` 展开）
- `hardware.js` / `wallet.js`

**支撑**
- `web-search.js` / `http-fetch.js` / `milestone.js` / `diag.js` / `migrate-userdata.js` / `downloader.js`

## 4. 依赖映射

| 依赖 | 用途 | 对应模块 |
|------|------|----------|
| electron / electron-builder | 框架 / 打包 | 全局 |
| node-llama-cpp | 本地 GGUF 推理 | local-llm*.js |
| @xenova/transformers | 记忆向量召回 | memory-retrieve.js |
| mammoth / word-extractor / pdf-parse / xlsx / jszip | 文档解析 | media*.js |

## 5. 进程通信边界（preload 暴露的 `window.simple`）

渲染进程经 IPC 调用的能力（从 `app.js` 调用反推）：
- 对话：`chatAbort`
- 工作区：`setWorkspace` / `openProject` / `showInFolder` / `filePreview` / `fileTree`
- 配置 CRUD：`saveModels` / `listSkills` / `listRules` / `listSnapshots` / `listMilestones` / `listMemory` / `getGlobalMemory` / `addMemory` / `addGlobalPref` / `saveGlobalProfile`
- 会话：`loadSessions` / `saveSession` / `loadSession`
- 杂项：`fetchAccountBalance` / `savePasteFile` / `reportError`
- 兼容旧名：`window.sinpo`（SinpoCode→SimpleCode 迁移痕迹）

## 6. 主数据流

```
用户输入 → renderer/app.js
        → preload IPC
        → main.js(chat:send)
        → agent.js（拼系统提示 + 工具）
        → 模型（api-protocol / local-llm / zbaingAi）
        → 流式 delta 回 renderer（打字机 / Markdown 渲染）
工具调用 → workspace.js（读任意绝对路径 / 写受 roots 限）
        + snapshot.js（改前快照）
        + sandbox.js（命令沙盒）
```

## 7. 打包 / 分发

- `electron-builder`：win `nsis` + `portable`（x64）
- `extraResources`：`skills`/`rules` → `app-root`；`models`（排除 `.gguf`）
- `asarUnpack`：`.node` / `node-llama-cpp` / `@xenova` / `onnxruntime-node`
- 脚本：`scripts/dist-win.ps1`（构建）、`pack-share.ps1`（分享包）、`launch.js`（启动）

## 8. 三个关键收敛点

- **配置唯一收敛**：`store.resolveModelCfg` 把模型条目展开成各模块可用结构
- **文件范围边界**：`workspace.resolveRead`（读任意绝对路径）/ `resolveAllowed`（写限 roots）
- **技能层叠覆盖**：`skills.js` 上层（工作区）覆盖下层（APP_ROOT / 内置）
