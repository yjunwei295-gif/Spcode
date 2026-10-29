# 本地生图、图生图与像素动画配置

## 使用

打开「文件 → 设置 → 本地生图 / 图生图」，设置默认参数并点「完成」。模型仍由「模型组合 → 生图」选择，本次不替换模型。

附上参考图并说明下一帧动作，或在对话中给出本机图片路径。助手调用 generate_media 时把真实路径填入 imagePath；下一帧可以直接使用上一帧的输出路径。未传参考图时进行文生图。生成文件写入当前项目 generated/，输入图片不修改。

设置中的参数用于本地生图，单次对话指定的参数优先。留空沿用模型配方：当前 Qwen 配方为 768×768、28 步、CFG 2.5、Euler；其他配方保留原有 768×768、20 步设置。接口生图不接收这套本地引擎参数，显式传入时会报错，不会忽略参考图后生成另一张图片。

| 参数 | 作用 |
| --- | --- |
| width、height | 输出宽高，单位像素，至少 64，按 64 的倍数设置；支持非方形 |
| steps | 配置采样步数，正整数；图生图实际降噪步数受重绘强度影响 |
| seed | 种子，固定非负整数便于复现；-1 使用随机种子；0 是有效固定种子 |
| strength | 重绘强度，0～1；越低越贴近参考图，动作改动通常也越弱 |
| cfgScale | 提示词引导强度，非负数；合适数值取决于模型 |
| samplingMethod | 引擎实际支持的采样器；空项沿用配方 |
| negativePrompt | 反向提示词，可清空 |
| preset | custom 为自定义，pixel 为可继续覆盖的像素动画配置 |
| imagePath | 单次参考图片路径；接受项目相对路径或真实本机绝对路径，不保存为全局参考图 |

示例调用参数：

```json
{
  "kind": "image",
  "prompt": "保持参考角色的服装和配色，侧面站姿，右手比上一帧稍微抬高，单张游戏动画帧",
  "imagePath": "generated/frame-001.png",
  "preset": "pixel",
  "width": 512,
  "height": 512,
  "steps": 28,
  "seed": 42,
  "strength": 0.35
}
```

## 像素动画配置

用户主动选择「像素动画」后填入 512×512、28 步、种子 42、重绘强度 0.35、Euler 和反向提示词；每项都可以手动修改。CFG 保留当前输入或模型配方。

该配置追加清晰像素边缘、有限色板、平涂、单帧角色等风格提示，参考图缩放使用最近邻并关闭抗锯齿。它不把输出强制量化成固定色板，也不自动制作整段动画。固定种子不能保证角色身份或动作连续；建议保持镜头、尺寸、提示词主体和配色一致，仅逐帧改变动作。普通 Qwen-Image 图生图使用 init-img，不等于专用 Image Edit / 姿态控制模型。

## 实现与核对

调用顺序：生图工具参数 → Agent 参考图路径解析与设置合并 → 媒体路由 → 本地引擎 → sd-cli。普通模型和 Codex / Cursor 直通共用工具定义。图片附件额外提供真实本机路径，避免助手从视觉描述猜路径。

共享参数定义位于 electron/lib/image-gen-options.js。设置表单、IPC 校验、工具 schema 和 CLI 参数展开均使用该定义。新增参数没有通过 shell 拼接执行。

专项命令：

```cmd
node_modules\electron\dist\electron.exe scripts\test-local-image-generation.cjs
node_modules\electron\dist\electron.exe scripts\test-local-image-generation.cjs --real
```

第一条检查完整设置页面、保存/恢复、preload IPC、工具协议、路由及参数展开。第二条使用本机已经配置的模型与引擎生成两帧，第二帧引用第一帧；检查真实 PNG 尺寸及引擎嵌入的结构化采样元数据。所有测试配置与输出保留在 generated/local-image-check-*，不修改用户的真实模型配置。

实际以 Qwen-Image 2.1 Q4_0、Vulkan 完成两帧 256×256、配置 6 步、种子 42、强度 0.5 的低成本接通测试。引擎执行 4 次降噪，PNG 元数据记录配置 6 步；两者不是矛盾。此测试验证输入与参数生效，不作为动画动作质量验收。

本轮核对结论：本地 Qwen 图生图接入、参数控制与像素配置通过。专项 18 项、真实模型 7 项、完整页面回归 24 项、引导回归 15 项及图片插话回归通过。实际观察中低步数色块人物保持轮廓和配色，抬手动作不明显，因此不把该结果当作动画动作质量通过。

本轮证据：generated/local-image-check-qJvxCC/verification.json、generated/local-image-check-qJvxCC/settings.png、generated/local-image-check-5UI5HQ/verification.json，以及该目录下两帧 PNG 与 frame-0-metadata.json / frame-1-metadata.json。

源码修改后需完整退出再启动 SpCode，使主进程、preload 和工具 schema 一起更新；仅刷新页面不足。已发布的 1.0.2 EXE 不包含本次源码改动。
