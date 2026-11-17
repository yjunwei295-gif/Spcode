# SPAI 原始训练档案、代码模型池与 Mac 修复

## 内部训练采集

仅源码开发版支持，默认关闭，不在普通设置页面添加开关。当前用户配置没有被开启。

在当前实例的用户数据目录中的 settings.json 设置：
- trainingDataEnabled：布尔值 true 开启、false 关闭；只认布尔 true。
- trainingDataDir：固定输出目录，本轮按用户要求默认 D:\Shuju。

完整退出并重新启动修改后的源码版后，设置在每轮开始时读取。切换开关影响新轮次；已开始的轮次按开始时状态完成归档。关闭不会删除已有记录。发布版不能通过修改配置启用。

目录结构为：
- 数据根目录 / 会话 ID 的 SHA256 / UTC 时间与 UUID / events.jsonl
- 同一轮目录 / transcript.txt

JSONL 每行一个事件，字段为 schemaVersion、seq、at、sessionId、turnId、kind、data。TXT 为同一批事件的完整可读文本，序号一致。两份都是 UTF-8。每轮先确认目录可写，再开始模型工作；结束前排空写队列。写盘失败明确报错，不改存其他目录。目录按稳定会话编号分组，UUID 避免重启或多个实例覆盖旧轮次。

记录范围：
- 本轮用户原文、所带历史、附件引用、上下文和模型身份。
- 普通模型的完整请求消息、工具定义、逐段回答、接口返回的推理摘要/思考文本、最终返回及错误。
- Cursor、Codex、Claude 直通的请求上下文、SDK 实际返回的事件、完整 MCP 参数和实际回包，包括门槛拒绝与插话替换。
- 工具实际执行的参数、完整结果或异常，以及文件变更、状态、提问、用户回答和收到的插话。
- 成功、报错、用户停止分别记录 success、error、stopped。
- 本轮启动的后台画像模型也在结束标记前完成结果归档。

只保存程序实际收到的公开推理信息，不能得到模型没有返回的内部思维链。模型认证配置不复制到模型身份字段；对话、提示词及工具结果本身按原文保存。附件内容若已进入请求，会随请求保存；未解析的二进制附件保留原路径引用，不额外复制媒体文件。数据为原始轨迹，SPAI 训练时可用 callId 关联请求、结果与流片段，再转换为所需训练格式；不能把重试、错误或未结束轮次直接当作成功样本。程序异常退出时已落盘事件保留，缺少 turn-end 表示没有正常结束，不能视作完整轮次。

## 发布边界

- 标准 Windows 打包配置和开发打包配置排除 electron/lib/training-archive.js。
- Mac 自定义打包收集资源时同样排除此文件。
- training-recorder.js 在 app.isPackaged 时只转发原模型/工具调用，不加载采集实现，不创建档案。
- 主进程同时检查 !app.isPackaged；发布设置的默认值不提供内部训练开关和目录。
- 不在安装包中附带测试生成的档案。

## 平等代码模型池

设置 → 全局能力模型 → 代码，勾选任意多个已配置的 API 或本地模型。原来代码角色的默认/备用引用在读取时转为平等候选，保存为 code.models。取消勾选后保存会移除该候选。模型组合中的多个代码槽也进入同一个平等候选池，并去除重复引用。

大脑通过 use_code_model 明确指定 modelId 和本次 task。可分别选择不同模型完成工作，拿到前项结果后再交给后续模型配合。没有主备、优先级、首项默认或自动失败换模；未指定/未配置的模型会明确报错。普通模型与直通大脑均接入，AGI 模式可使用这个工具。模块不能继续选择其他模型；同文件或有依赖的工作应顺序完成。

界面列出全部已配置代码模型，并只点亮当前实际执行的模型。总结、规划和其他能力的原有设置形态没有改为代码池。

## Mac 问题与修复

用户截图文字经本地 OCR 读取为：models:listRemote / Codex 模型目录读取失败，请检查本机登录状态和 Codex 版本。

已检查本机现有 1.0.3 的 arm64 和 x64 Mac ZIP：两个包的内置 Codex 条目均为 100644。原自定义打包脚本为所有追加资源写入同一权限，导致 Mach-O 程序无法执行。这是与截图相符的实际打包缺陷；没有远程 Mac 日志，不能排除其登录环境另有问题。

现在按文件头识别 Mach-O 和 shebang 入口，ZIP 中写为 100755；普通源码/配置仍为 100644，Electron 外壳原有符号链接继续原样复制。RPC 启动错误保留 EACCES、退出码、信号和 stderr，不再把这些错误吞为 null 后统一提示登录问题。

## 本轮文件清单

- electron/lib/training-archive.js：新增按轮次追加的原始 JSONL/TXT 采集实现。
- electron/lib/training-recorder.js：新增开发加载与发布禁用边界。
- electron/lib/store.js：增加仅开发版存在的内部开关与固定目录默认值。
- electron/main.js：接入轮次事件、用户确认、结果和终态落盘。
- electron/lib/agent.js：接入模型/工具采集、插话记录与按需代码选模。
- electron/lib/codex-direct.js：保留实际 SDK 事件。
- electron/lib/cursor-direct.js：保留实际 SDK 更新及对应轮次。
- electron/lib/claude-direct.js：保留实际 SDK 消息。
- electron/lib/assembly.js：解析、去重代码池并迁移原主备引用。
- electron/lib/codex-model.js：保留 app-server 启动/通信失败的具体原因。
- renderer/app.js：代码池多选、保存恢复、引导兼容与当前模型展示。
- renderer/styles.css：代码池复选项布局。
- renderer/i18n.js：代码池提示及能力优先级适用范围。
- package.json：标准发布排除采集实现。
- build.dev.json：开发打包同样排除采集实现。
- scripts/build-mac.js：排除采集实现并保留内置原生程序/脚本执行权限。
- scripts/test-training-archive.cjs：归档全文、并发、异常与发布边界测试。
- scripts/test-training-app.cjs：完整应用的真实 preload/IPC 采集测试。
- scripts/test-code-model-pool.cjs：真实工具写入、直通选模与完整设置页面测试。
- scripts/test-mac-runtime.cjs：真实双架构二进制、完整 ZIP 权限/排除与故障诊断测试。
- scripts/test-onboarding.cjs：引导恢复测试同步加载新的模型池读取函数。
- docs/spai-training-and-model-pool.md：配置、格式、边界和验收说明。

旧的运行时观察相关改动保留，本轮没有回滚、提交或发布。

## 已完成验收

- 原始档案 18 项：全文不截断、并发隔离、直通 MCP 异步上下文、错误、中止、写入失败、发布版不加载实现。
- 整应用采集 8 项：真实 preload/IPC、默认关闭、开关启停、确认原文、最终回答和三种终态。
- 代码模型池 18 项：普通循环确实选择第二/第三候选并写入真实测试文件；未选首项零请求；选中模型失败不换模；完整直通轮次与真实设置页面保存/重开成功。
- Mac 基础 13 项：两种架构的真实 Codex/Mach-O/shebang ZIP 权限、排除规则、RPC 成功握手及 EACCES/退出诊断。
- 完整 Mac 包另加 8 项：两种架构分别检查 Codex 0755、训练实现缺席、发布禁用适配器和 Electron 符号链接。每包 116 个应用源码/配置文件还与当前源码逐字节一致。
- 以上专项共 65 项；包内源码逐字节检查另计。
- 既有首次引导 15 项、按需观察路由 10 项及供应商回归通过。

模型传输使用受控夹具，未消费用户真实模型额度；不把这些测试表述为所有远端服务已实连通过。当前环境为 Windows，Mac 包内容校验不等同于 macOS 真机启动/登录验收。Mac 重建包位于 generated/mac-runtime-ci9tKn，results.json 保存完整包验收结果，source-verification.json 保存两个包各 116 个源码比对结果、大小与 SHA256。

本轮证据：归档 generated/training-archive-3O8WhL/results.json；真实采集 IPC generated/training-app-DMRPso/results.json；代码池 generated/code-model-pool-tcTNNe/results.json；RPC 成功与错误路径 generated/mac-runtime-37CvWj/results.json。设置页采用真实 DOM、保存重开和几何断言验收，本机截图合成未取得可靠目视结果，不把截图文件存在等同于视觉验收。本轮承载对话的旧实例没有重启，新主进程代码需要完整退出重启源码版；仅刷新页面不生效，旧安装程序不会自动获得这些修改。
