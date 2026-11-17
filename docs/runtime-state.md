# 低开销运行时观察

runtime_state 已接入普通模型和直通 MCP 的共用工具入口，仅在 AGI 开启时提供。它负责结构化只读采样、快照对比和条件等待，不调用聊天模型、截图或 OCR，也不写入目标进程内存。

## 本次实现的范围

- windows：枚举标准可见顶层窗口，返回窗口句柄、PID、标题、进程名、前台及最小化状态。可按明确 PID 筛选；不列入 SpCode 自身窗口。
- controls：按明确窗口句柄与 PID，以及精确 name / automationId 查询控件，可同时限制 type。返回实际支持的属性，包括文本值、是否可用、勾选、选中、展开和范围值。
- memory：读取已知地址的小范围内存，沿用 process_memory 的小端类型解释，64 位整数保持字符串。常驻帮助进程避免每次采样重新启动 PowerShell。
- snapshot：返回完整记录和 snapshotId。
- diff：与同轮次、同查询的基线对比，只返回新增、移除及更新记录。
- wait：一次工具调用在本地采样，直到条件满足、超时、用户停止或 AGI 生命周期改变，再将结果交给模型。

普通模型与直通模式不再在每次推理前自动截图。实施任务仍要求实际工具执行；普通问答不再为凑工具次数额外请求模型。模型需要视觉证据或可操作的 c 编号时，仍显式调用 screen_read / screen_look，原来的操作后回看和危险操作确认保持原链路。

既有“请帮我”后台屏幕接单监听保持原规则，本次减少的是模型请求前的自动截图和等待过程中的重复模型调用，并非宣称 AGI 完全不采集屏幕。

这不是逐帧视频理解或全进程事件追踪。采样间隔内发生又消失的变化可能遗漏；视频含义仍需视觉、声音或字幕分析。

## 查询目标和精确性

先取窗口快照：

```json
{"action":"snapshot","source":"windows"}
```

后续 controls 的 target.pid 和 target.hwnd 必须复制该工具实际返回的 PID 和十进制句柄。内存地址必须来自 process_memory 或其他已经核实的运行证据，不能猜地址或数值的业务含义。

控件查询必须提供 1 至 16 个唯一 key，每个选择器至少含一个非空精确 name 或 automationId；type 可以进一步区分同名控件。多个匹配直接失败，不擅自选第一个。隐藏控件可能存在，offscreen 表示其是否离屏，不能把“存在”当成“可见”。

不支持的属性不返回，因此“属性不存在”与“值为空”“值为 false”不同。eq / ne 比较缺失属性会失败；对象不存在时二者均不满足。密码控件不返回 value。

控件的 runtimeId 用于发现对象替换，不是 screen_read 的操作编号。状态查询不会更新原有 UIA Scan 缓存或桌面坐标帧。

内存单次最多 16 个字段、总共 4096 字节；数值长度须按类型对齐，UTF-16 长度须为偶数。非有限浮点数不能被 JSON 无损表示时明确报错，不悄悄转为 null。

控件与内存读取前后核对进程启动身份；控件同时核对窗口所属 PID。失效目标、不可读地址、选择器歧义、UIA 超时和不完整读取均报告错误，不切换目标或伪造默认值。

## 等待条件

wait 要求调用方明确给出：

- timeoutMs：1 至 30000 毫秒，包含采集和排队耗时。
- intervalMs：100 至 5000 毫秒，表示一次采集完成到下次开始之间的等待。
- condition.key：正在查询的记录 key。窗口记录使用实际返回的 window:句柄。
- condition.operator：eq、ne、exists、absent 或 changed。
- eq / ne：还须给出 field 和严格类型的 value。
- changed：还须给出 field 及 baseline，以同查询的基线字段为比较依据。

内存数值的 value 是数组；例如一个 int32 应用 [80] 比较，不能用字符串 "80" 或标量 80 替代。64 位整数应使用字符串数组。文本解码值则是字符串。

条件满足返回 status=matched，超时返回 status=timeout；超时在 Agent 执行结果中不算成功。取消抛出 AbortError，关闭再开启 AGI 也不能让旧等待恢复。定时等待可立即取消；已经进入原生读取时会在该读取结束后丢弃结果，因此返回时间还受原生查询超时和帮助进程排队影响。超出判断截止时间才返回的匹配不算成功。观察器不自动执行后续动作，不启动重试模型或无限后台守护。

## 时效、增量和证据

每次结果包含：

| 字段 | 含义 |
|---|---|
| startedAt / observedAt | 当前返回采样在帮助进程中开始与结束的 Unix 毫秒时间 |
| elapsedMs | 本次工具执行的总耗时，包含等待和证据记录 |
| polls | 本次实际完成的采样次数 |
| maxGapMs | 本次相邻采样结束时间的最大差值；只有一次采样时为 0 |
| sampling | 固定为 true，明确属于离散采样 |
| evidencePath | 工作目录内可用 read_file 读取的 JSONL 证据相对路径 |

采样时间段不是原子系统快照，不同控件或字段可能先后读到。实际观察间隔还包括读取耗时、其他帮助进程请求排队及调度时间；intervalMs=100 不保证每秒准确采集十次。

每个工具调用在 generated/runtime-state/observation-*/events.jsonl 建立独立日志，记录请求、首次完整采样、之后每次有变化的完整采样以及最终结果或错误。连续未变化采样只计数，不重复写入相同正文。A→B→A 的采样变化不会被最终状态掩盖；采样之间未捕获的变化不能从日志恢复。

同一轮次最多保留最近 16 份完整快照。跨轮次、跨 AGI 生命周期、已淘汰或查询内容不同的 baseline 会明确失败，须重新 snapshot。旧快照的时间不会因为复用而被刷新。模型可以先看小体积差异，需要中间过程再按 evidencePath 取回原文。

## 生效方式与长时存活报错

本次修改包含主进程工具注册与常驻 PowerShell 帮助程序，不能靠刷新 renderer 加载。当前承载对话的进程不自动重启；完成任务后需完整退出 SpCode，再从源码启动。旧安装 EXE 需要重新打包才包含本次运行时工具。

若长时存活出现 No handler registered for 'long-alive:bind'，含义是当前主进程没有注册该 IPC，并非任务目标或时间参数错误。页面可以从磁盘加载新代码，而已启动的旧主进程仍运行旧模块。本次报错实例的主进程启动早于注册代码更新时间；独立新源码实例已经通过真实页面绑定、开启、停止与状态查询。无需为这个错误添加吞异常或空状态分支。

## 验证

执行以下命令，测试数据均写入 generated 的独立目录，不访问外部模型：

```text
node scripts/test-runtime-state.cjs
node_modules\.bin\electron.cmd scripts/test-runtime-state-native.cjs
node_modules\.bin\electron.cmd scripts/test-runtime-routing.cjs
node scripts/test-runtime-app.cjs
```

- 引擎测试覆盖增量、回到原值的中间采样、严格类型、未知属性、超时、取消、AGI 生命周期和基线隔离。
- 原生测试创建独立 WinForms 窗口与已知内存，经过生产 Agent 执行入口读取真实 UIA 和进程内存；另用生产 Uia.Scan / Observe / Act 核对旧操作编号仍有效。
- 路由测试使用生产模型循环及受控传输，确认普通问答不截图，状态任务不强制补截图，仍保留实际执行要求。
- 完整应用测试从真实 renderer / preload 进入长时存活 IPC，另核对运行时工具随 AGI 开关显示和隐藏。

性能数字见原生测试输出的 results.json；它比较相同已知内存字段的单次启动读取与十次常驻读取均值，包含工具包装和日志开销。该样本不是所有软件的性能保证，也未测量全机 CPU、GPU 或多日驻留负载。

### 本轮验证记录（2026-11-02）

- 引擎 29 项、真实原生 20 项、模型路由 10 项、完整应用 4 项通过，共 63 项新功能检查。
- 原有插话与 Codex MCP 回归 35 项、长时存活调度 89 项、真实长时面板测试报告 checks=11，均通过。
- 原有 test-agi-screen-requests.cjs 两次在“未变化的真实图像复用 OCR 文本”断言失败。前面的后台调度、队列闭环与真实 OCR 文本识别已通过；不能称这套桌面回归全通过。该图像缓存实现本轮未修改，也没有为使测试通过而放宽图像比较。
- 最终完整原生测量记录在 generated/runtime-native-6r1bcJ/results.json：单次启动读取约 200.16ms，十次常驻读取均值约 23.85ms；配置间隔 100ms 的等待实测最大采样间隔 173ms，4 次采样后匹配。这是单机样本。
- 完整新实例的长时存活 IPC 结果在 generated/runtime-app-6er4od/results.json；报错截图本地 OCR 在 generated/long-alive-diagnosis/screenshot-ocr.json。旧主进程的界面未通过热重载修复，仍需完整重启。

调试过程中保留了真实失败记录：WinForms 样本最初未满足标准顶层窗口筛选；PowerShell UTF-8 无 BOM 与 Add-Type 提示影响样本启动；可选选择器在 PowerShell string[] 绑定时变为空串，已按显式非空条件修正。一次工具被插话拦下，另一个依赖编辑已执行，导致原生帮助类暂时编译失败；读取实际工具结果后补齐该编辑，最终原生测试通过。没有回滚文件或掩盖失败。

## 本轮源码与测试文件

| 文件 | 改动 |
|---|---|
| electron/lib/runtime-state.js | 新增结构化查询、增量、有界基线、条件等待与严格状态判断 |
| electron/lib/runtime-state-tool.js | 新增轮次隔离、AGI 生命周期和 JSONL 证据归档 |
| electron/lib/desktop-hand.js | 接入常驻状态读取与 AGI 生命周期编号 |
| electron/lib/desktop-hand.ps1 | 新增指定控件与内存只读采样，独立于 UIA 操作缓存 |
| electron/lib/agent.js | 注册共用工具入口，取消推理前自动读屏，保留实施任务实际执行要求 |
| electron/lib/brain-pressure.js | 同步自主模式的按需观察提示 |
| scripts/test-runtime-state.cjs | 新增引擎语义与停止边界回归 |
| scripts/test-runtime-state-native.cjs | 新增真实 UIA、内存、Agent 入口及性能验收 |
| scripts/runtime-state-fixture.ps1 | 新增只修改自身的原生测试窗口与内存样本 |
| scripts/test-runtime-uia-cache.ps1 | 验证状态观察后旧 UIA 操作编号仍可用 |
| scripts/test-runtime-routing.cjs | 验证普通问答与状态任务不触发自动读屏 |
| scripts/test-runtime-app.cjs | 验证完整应用工具注册与长时存活 IPC |
| docs/runtime-state.md | 记录使用方式、适用边界、生效步骤和实际验收结果 |

generated 中另有独立测试日志、结果 JSON 和截图诊断脚本，不属于正式功能源码。未修改版本号、未打包、未提交或推送 Git。

