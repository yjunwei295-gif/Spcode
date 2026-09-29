# SimpleCode

开源桌面 **AI 编程助手**（Electron）。能接在线模型、下载并跑本地 GGUF、按任务组合多模型，并支持图片等多模态。

当前版本 `0.1.0`，主要面向 **Windows**。

仓库：[github.com/yjunwei295-gif/SimpleCode](https://github.com/yjunwei295-gif/SimpleCode)

---

## 能做什么

- **对话改代码**：打开项目目录后，助手可以读文件、改文件；改之前会自动打快照，改错了能还原。
- **在线模型**：OpenAI 兼容接口（填写 Base URL、API Key、模型 ID）。Key 只存在本机，不进仓库。
- **本地模型**：把 `.gguf` 放到模型目录，用内置 `node-llama-cpp` 直接加载，不必再开一层聊天服务。
- **下载模型**：按用途（写代码 / 对话 / 看图等）和本机配置推荐；支持多线程、断点续传；也可自己搜 HuggingFace 或粘贴 `.gguf` 链接。
- **模型组合**：给当前主模型挂辅助槽位——看图 / 总结 / 代码 / 规划。每个主模型（API 或本地）可以有自己的组合。
- **看图**：挂了看图槽后，先由本地视觉把图认成文字，再交给主模型。**不会把原图发给不支持视觉的接口**（例如 DeepSeek）。端点可留空，缺引擎时会自动下载隐藏的 llama.cpp 运行时。
- **联网搜索**：碰到可能过时或需要查官网的问题，最多搜一次网页再回答；改项目代码时不上网。可在设置里填优先站点（一行一个域名）。
- **技能 / 规则 / 人设**：对话里输入 `/` 调用技能；规则和人设写入系统提示。项目级写在工作目录 `.simple/`（旧目录 `.sinpo/` 仍可读）。
- **其它**：中英界面、浅色/深色、附件与粘贴图片、图片灯箱、对话分叉与历史、克隆 Git 仓库、多窗口。

默认自带技能（含 `zabingsk`）和猫娘人设，可在软件里改掉。

---

## 环境

| 项 | 说明 |
| --- | --- |
| 系统 | Windows 10/11 x64 |
| 运行时 | [Node.js](https://nodejs.org/) 18 或更高 |
| 本地推理 | 依赖 `node-llama-cpp@3.20.0`（请勿改成仓库里不存在的版本号） |
| 磁盘 | 本地模型另计，常见 7B GGUF 约数 GB |

---

## 安装与启动

```bash
git clone https://github.com/yjunwei295-gif/SimpleCode.git
cd SimpleCode
npm install
npm start
```

也可以双击 `启动.bat`：没有 `node_modules` 时会先 `npm install`（Electron 使用 npmmirror），再启动。日志在：

`%APPDATA%\SimpleCode\logs\`

首次装依赖会较久（含 Electron 和 llama 原生库）。装失败时看终端完整报错，不要只看「请确认已安装 Node.js」——常见原因是网络或包版本不存在。

---

## 第一次使用

1. 打开软件 → **文件 → 打开项目**，选一个代码目录（不打开项目就改不了文件）。
2. **文件 → 设置**
   - **本地模型**：指定模型目录，放入 `.gguf`，或点「下载模型」。
   - **API 模型**：添加接口地址、Key、模型 ID，可点「测试连接」。
3. 顶栏选好当前主模型，再开始聊天。
4. 需要看图时： **文件 → 模型组合**，给当前主模型加「看图」槽位（本地 VL GGUF + mmproj，mmproj 可留空自动搜/下）。

设置、会话、快照存在本机：

`%APPDATA%\SimpleCode\`

**不要把这个目录提交到 Git。** 仓库里的 `.gitignore` 已忽略 `.gguf`、`.env`、`.claude`、`Test.zip`、`settings.json` 等。

---

## 模型组合（看图流程）

```
用户发送图 ---> 看图槽把画面转成文字 ---> 主模型只吃文字继续任务
```

- 未挂看图槽、且主模型接口勾了「支持看图」时，才会把原图发给该接口。
- 已挂看图槽时，始终先转文字，不把原图发给 DeepSeek 等主模型。
- 看图引擎首次启动会下载，可能要等一会儿。

其它槽位（总结 / 代码 / 规划）只向主模型注入**文本**，不带工具调用。

---

## 技能、规则、人设

| 类型 | 作用 | 存放 |
| --- | --- | --- |
| 技能 | 对话输入 `/技能名` | 应用内置 `skills/`；项目 `.simple/skills/` |
| 规则 | 每轮都生效的约束 | 内置 `rules/`；项目 `.simple/rules/` |
| 人设 | 身份与语气 | 设置里编辑；默认见 `rules/persona.md` |

技能列表越靠上优先度越高；同名时上方覆盖下方。

---

## 仓库目录

```
electron/          主进程（窗口、IPC、Agent、本地 LLM、下载器）
renderer/          界面
scripts/launch.js  启动脚本（被 启动.bat 调用）
skills/            默认技能
rules/             默认规则与人设
models/            只放 .gitkeep；请自行放入 .gguf
icons.png          应用图标
```

---

## 开发

```bash
npm start
```

入口：`electron/main.js`。渲染进程：`renderer/app.js`。对话循环：`electron/lib/agent.js`。

改完功能后建议做一次冒烟：启动 → 打开项目 → 发一句对话 →（如有看图）贴一张图。

---

## 当前限制

- 未做 macOS / Linux 安装包与适配。
- 语音输入仍是占位。
- 本地 `node-llama-cpp` 文本推理本身不带多模态；看图走单独的视觉引擎 / 槽位。
- 没有打包发布流程（`electron-builder` 等），目前是源码启动。

---

## 许可证

尚未单独放置 LICENSE 文件。第三方依赖（Electron、node-llama-cpp 等）遵循各自许可证。模型权重版权归模型作者，请自行遵守其协议。
