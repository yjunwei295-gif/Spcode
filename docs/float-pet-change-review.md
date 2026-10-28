# 本轮 SpCode 改动核对

排查基线：HEAD为90797dc。开始排查时，Git报告23个已跟踪文件有未提交修改，合计844行新增、152行删除，另外有多项未跟踪文件。此数据包含此前工作，不能把这些修改都归因于本轮。

## 与反馈直接相关的此前改动

- electron/lib/float-bar.html：原聊天页加入桌宠画布与状态气泡，初始改为收起的桌宠形态。
- electron/lib/float-bar.js：同一窗口接入desktop-pet-host，普通显示改为showInactive；原最小化入口改为桌宠收放。
- electron/lib/desktop-pet.css：状态气泡与角色都是绝对定位，但没有在角色上方预留完整文字高度，长状态文字会被角色盖住。
- electron/main.js：原Ctrl+Alt+Space只切换显示/隐藏，没有聚焦输入的全局入口。
- 其余已有修改涉及Agent、模型协议与直通、作品工具、主界面、依赖和测试。本轮没有逐项评估这些功能是否正确，也没有撤销这些改动。另发现多个疑似命令残留的未跟踪文件，未擅自删除。

## 本轮实际修改或新增

### 小窗与输入

- electron/main.js：新增输入唤起后的可见性同步回调；输入键由用户录入。
- electron/lib/float-bar.js：展开并聚焦原输入框，保留草稿和会话；冷启动等页面就绪再聚焦。
- electron/lib/float-bar.html：加入触发键录入/清除控件；Alt组合不顺带发送。
- electron/lib/desktop-pet-host.js：气泡独立占位；按用户槽位保存、恢复、清除全局输入键，处理注册冲突及重录当前按键。
- electron/lib/desktop-pet.js：设置页录键、取消和错误提示；唤起后关闭换肤菜单并聚焦输入；同步真实气泡尺寸。
- electron/lib/desktop-pet.css：紫青配色、小窗与设置页圆角和边框；气泡与角色分区。
- electron/lib/desktop-pet-config.json：输入键初值为空；气泡宽度、高度、间距可配置。

### 猫娘图形

- electron/lib/desktop-pet-skins/cyber-neko/art.json：绘图尝试稿的紫青配色参数；当前像素复刻直接保留原图颜色。
- electron/lib/desktop-pet-skins/cyber-neko/remesh-rules.json：本轮参考尺寸、背景容差、眼嘴局部区域、显示占比和当前构建入口。
- electron/lib/desktop-pet-skins/cyber-neko/reference-user.png：保留本轮用户实际附件，不使用旧头像冒充参考。
- electron/lib/desktop-pet-skins/cyber-neko/pixel-source.js：无损压缩的原图RGBA及独立背景蒙版。
- electron/lib/desktop-pet-skins/cyber-neko/atlas.png、skin.json、code-head.png：更新实际皮肤图集、清单与原尺寸重绘结果。
- scripts/inspect-crystal-reference.cjs：读取实际附件像素与区域采样。
- scripts/compile-crystal-pixels.cjs：从明确指定的原附件编译像素数据，核对无损往返。
- scripts/lib/crystal-pixel-draw.js：Canvas像素重绘、去底与原像素局部变形。
- scripts/bake-crystal-code.cjs：输出16种动作，每种12帧，并验证原图RGBA哈希及边缘裁切。
- scripts/lib/crystal-neko-draw.js、scripts/draw-crystal-neko-code.cjs：本轮前段修改的路径绘图尝试稿已保留；当前皮肤不使用该稿作为构建入口。
- generated/desktop-pet-check/crystal-code-draw.html：原附件、原尺寸程序重绘、透明底动作的交互对照；同目录保存构建数据、截图和验收报告。

### 文档与验证

- docs/desktop-pet.md：更新自设触发键、像素复刻和构建约定。
- docs/float-pet-change-review.md：记录本轮改动范围及实际证据。
- scripts/test-float-input.cjs：37项真实Electron/Windows输入与布局检查。
- scripts/test-desktop-pet.cjs：改为按实际Alpha找鼠标命中点，并按各皮肤真实格尺寸核对；24项交互检查通过。
- scripts/test-crystal-preview.cjs：6项交互预览及实际导出PNG检查。

## 验证结果与边界

- 用户附件640×712，455680个像素；原尺寸Canvas重绘RGBA SHA-256与附件解码数据一致。
- 原附件文件SHA-256：6b16b57d20a68438ddd7a24b9437626d7042c4a669c127a634d0824f4920e657。
- 原始RGBA SHA-256：5aa8610050c0d518b00b7113caed5d1a1e0aa9381243e00edd12d3516a63fe5a。
- 像素一致仅指原尺寸、未去底和未变形的重绘。去背景、缩放、动作局部形变是随后单独执行的处理。
- 输入/布局37项、桌宠交互24项、状态机9项、皮肤包5项、交互预览6项均通过。
- 图集16×12帧均有动作变化，未发现格边缘裁切；已实际导出并核对1600×1100预览PNG。
- 测试使用隔离Electron实例；当前承载MCP对话的SpCode主进程没有重启。主进程和宿主改动需要完整退出并重新启动SpCode；仅刷新主页面不足以加载新接口。
- 所有代码、参数和文案写入UTF-8；未回滚此前修改，未改身份文件。
