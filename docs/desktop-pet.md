# 桌宠与运行时观察

本次直接改造现有悬浮小窗。同一 BrowserWindow 收成桌宠，展开后仍是原聊天节点，发送、附件、会话绑定、确认和停止继续走现有接口。

## 使用

- 默认皮肤为「棱光猫娘 · 雾紫巡游」，默认角色画布约115像素。采用雾紫、青绿与石墨黑，不对称几何短发、浅色短外套、分片短裙与长靴；三视图仅作形体参考，服装与发型重新设计。
- 单击角色展开或收起聊天，拖动角色移动。
- 按住Ctrl在角色上滚轮可随时缩放；右键菜单提供实时大小滑条、速度、减少动态、换肤及导入。
- 大小范围30%至160%，偏好及脚底位置按实例槽位保存到应用用户目录。
- 空闲时只保留角色，悬停显示状态气泡；等待回答或遇到问题时显示提醒。提起与放下只播放拖动、落地动画，不显示动作台词或气泡。
- 靠近屏幕边缘时，聊天面板选择有空间的一侧，保持角色脚底位置。
- 主进程、preload及Agent修改需要完整重启SpCode；仅刷新主页面不会加载新工具和宿主逻辑。当前开发入口为项目的npm start。

## 状态与证据

desktop-pet-config.json声明16种动作、显示名称、布局、初始皮肤、默认比例及动画参数。帧率、最短状态展示、结束停留、落地时长、切换缓动和拖动阈值均在配置中。

tool-activity.js在实际execTool边界分配callId，并保留running/done与明确结果。main.js向小窗透传工具名、调用编号、执行状态和轮次结束原因。桌宠以sessionKey和turnId隔离任务，按callId维护并行工具；等待回答优先，工具失败和用户停止不会显示正常结束动作。历史恢复不重播庆祝。

普通命令显示执行动作；调用方明确声明activity为build或test时显示验证动作。工具done只代表调用结束。

## 皮肤包

右键宠物 →「导入皮肤包」→ 选择ZIP → 在「皮肤」下拉框选择刚导入的名称，即时生效。若导入的是内置皮肤的改版，必须更换清单中的id和name，同名编号不会覆盖已有皮肤。

每个ZIP根目录直接包含skin.json，以及清单atlas指定的PNG，不能在ZIP里再套一层文件夹。只读取声明和图像，不执行包内脚本。

制作时可复制 `electron/lib/desktop-pet-skins/cyber-neko/` 作模板，修改 `skin.json` 的 `id` 和 `name`，再编辑透明 `atlas.png`。当前模板每格192×192、12列、16行，整图2304×3072；每格脚底对齐底边中央。不要把整张图集当成一张角色立绘。

图集从上往下各行依次为：陪伴、思考、说话、阅读、搜索、写代码、运行、测试、操作桌面、创作、等待、成功、错误、停止、被提起、落地；一行从左向右就是该动作的连续帧。成功和落地播放到最后一帧停止，其他动作循环。

清单字段：
- version：当前为1。
- id、name、author：唯一编号、显示名、作者。
- atlas：包内相对PNG路径。
- cellSize、columns、fps：方格边长、列数、播放帧率。
- anchor：帧底边中心，例如192像素帧使用[96,192]。
- animations：配置所列全部16种状态，每项包含row、frames、loop。

缺动作、图集尺寸不符或重复编号会明确报错。同一状态可由不同皮肤演出，热换肤保留正在执行的任务和草稿。内置图集由desktop-pet-art.js和scripts/build-desktop-pet-skins.cjs生成，品牌角色使用现有icons.png。猫娘由desktop-pet-vector.js读取皮肤目录的art.svg与art.json分关节烘焙；配色、锚点、姿态和口型集中在配置中，字段见electron/lib/desktop-pet-skins/cyber-neko/art.md。运行时仍只播放PNG，不加载参考位图或绘图脚本。

新皮肤实际动作预览为generated/desktop-pet-check/mist-pet.html；同目录mist-neko.zip为独立编号的可导入包。更新内置图集后，已经打开的小窗需要重新选择皮肤才能加载资源；若运行的是安装版而非当前源码，导入ZIP即可加载，无需为了换皮肤重启整个应用。

## 进程内存

process_memory为AGI开启时提供的只读工具：
- processes：按窗口标题确认目标进程。
- modules：获取目标模块和真实基址。
- regions：从明确地址开始分页查询内存区域，返回可读标识和下一页地址。
- read：按指定地址、字节数和类型读取；支持字节、UTF-8/UTF-16、32/64位整数及浮点数，采用小端解释。
- search：在明确区间内搜索文字、十六进制字节、int32或float32。

地址使用十六进制字符串，64位整数输出字符串，避免JavaScript精度损失。只申请QUERY_INFORMATION与VM_READ，不提供内存修改、注入或保护绕过。实际游戏中的数值含义需要结合画面、代码或地址变化核对；读到数字本身不证明它就是血量或游戏进度。

PowerShell帮助程序按UTF-8 BOM保存，并在打包设置中声明asarUnpack。

## 插话图片

主窗运行中提交图片或图文时进入当前轮的插话收件箱；其他附件仍保持原队列行为。桌宠图文和纯图使用同一条链路。接收回执成功后保存预览及原路径，不覆盖随后输入的新草稿。

普通模型在下一次请求中接收图片内容块；Codex和Cursor在工具边界接收MCP图片块。SDK收尾到达的图片通过同会话续接投递。支持原生视觉的模型直接接收原图，文本模型走既有视觉槽位；识别失败会保留明确失败说明。

## 验收入口

- scripts/test-desktop-pet.cjs：真实BrowserWindow、preload、Win32命中、缩放、换肤、原聊天与确认。
- scripts/test-desktop-pet-state.cjs：并行调用、历史恢复、停止与失败状态。
- scripts/test-desktop-pet-skins.cjs：真实ZIP导入与完整性检查。
- scripts/test-process-memory.cjs：独立进程分配已知数据后实测读取、搜索、模块和内存区域。
- scripts/test-interjection-images.cjs：纯图提交、图片原字节、实际MCP HTTP及Cursor内容块。
- scripts/test-agi-interjections.cjs：真实Agent入口、普通模型图片请求、直通插话及主窗/桌宠路由。
- scripts/test-agi-screen-requests.cjs：原AGI后台接单回归与真实Win32/OCR。

模型请求在传输边界受控，未以模拟答复冒充真实模型识图。结果文件位于generated/desktop-pet-check。可运行Electron专项脚本核对实际小窗；这些脚本不重启当前承载对话的SpCode进程。
