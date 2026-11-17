# 源码与发布版热更新

## 发布布局

正式构建与 `build.dev.json` 均使用 `asar: false`。安装目录的程序内容放在 `resources/app/` 的真实文件中，Node 加载的代码路径和文件监听路径一致；不再生成需要另行解包的 ASAR 代码归档。原生依赖、SDK、PowerShell 工具脚本也保留在正常文件目录中。

`electron/main.js` 在源码模式和发布模式都监听程序根目录下的 `electron/`、`renderer/` 和 `package.json`。技能、规则仍监听 `APP_ROOT` 下的外置目录；发布版的 `APP_ROOT` 是用户资料目录内的 `app-root/`，不会与安装目录混用。

## 生效流程

- `renderer/` 或 preload 更新通过校验后，等待聊天、下载、参考识别及弹窗空闲，保存窗口临时快照，再重新加载页面。标签、草稿、附件和上下文引用随快照恢复。
- 已登记的无常驻资源业务模块在空闲边界重建依赖闭包。
- 主入口和常驻服务保留原实例，通过 V8 更新兼容的既有函数。顶层初始化、函数签名或闭包结构变化会明确报告未应用；不把协议返回成功当成全量代码已经生效。
- 技能与规则更新后，下次请求读取新内容。已运行的 Electron、原生依赖和进程启动参数不属于原位替换范围。

首次从旧版本升级，需要安装本次构建并重新打开一次，让进程加载新增的更新入口。之后替换 `resources/app/` 中受支持的代码或界面文件，可沿用上述热更新流程；安装包布局改变本身不能注入尚未加载该入口的旧进程。

## 参考文件接口

`referenceImport({tabId, files})` 接收会话 ID，以及包含真实 `path` 和来源 `name` 的文件列表。识别成功后保存内容及父子层级并返回完整导图；解析、视觉识别和落盘失败会使 Promise 拒绝。

DOCX 参考导入单独使用 Word 标题样式及编号列表结构，不沿用纯文本结果判断层级。先建立父子边，再还原转换时添加的 Markdown 转义，普通井号、短横线和编号正文不会冒充标题或列表。内嵌图片仍由原媒体解析器提取并送视觉接口，不把整张图片的 base64 编入参考正文；这一分支不改变普通聊天附件的抽取方式。

`referenceTree({tabId})` 只读取该会话保存的导图；未导入时返回空树，读取或 JSON 解析错误会使 Promise 拒绝。

## 验证入口

- `node scripts/test-hot-reload.cjs`：业务更新、空闲时序、原位函数更新及不兼容结构拒绝。
- `node_modules/.bin/electron scripts/test-hot-reload-app.cjs`：真实生产主进程、preload、页面重载和会话快照恢复。
- `node scripts/test-hot-reload-packaged.cjs`：在隔离的真实发布目录启动 Electron，验证发布模式的文件更新事件及运行效果。测试复用项目依赖目录，不覆盖当前安装和用户资料。
- `node_modules/.bin/electron scripts/test-reference-tree.cjs`：真实拖入、IPC、文档解析、持久化及层级画布。
- `node scripts/test-docx-reference.cjs`：真实 DOCX 的标题样式、混合列表、普通正文字符、存档及内嵌图接口。
- `node scripts/verify-release.cjs [发布目录]`：核对目录版正式构建的实际文件字节和元数据，再启动该目录的 EXE 验证；省略目录时读取 `dist/win-unpacked`。
