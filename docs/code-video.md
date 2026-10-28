# 用代码制作视频

Agent 可以直接编写 HTML/Canvas/SVG 动画，通过 render_code_video 导出 MP4。
该工具使用 Electron 自带 Chromium 和 PATH 中的 FFmpeg，不需要配置视频生成模型。
源文件与素材保留在项目中，可以修改分镜后再次渲染，每次生成独立目录，不覆盖旧视频。

## 动画约定

HTML 必须定义 window.renderFrame(time, frame, info)：

- time：当前时间，单位秒，从 0 开始，等于 frame / fps。
- frame：从 0 开始的帧编号。
- info：width、height、fps、duration（请求秒数）、totalFrames。
- 函数可返回 Promise，渲染器会等待它完成再截图。
- 每帧从传入时间计算所有状态。不要使用实时定时器、自动播放、Date.now 或未固定种子的随机数。
- 使用 Web Animations 时暂停动画并按 time 设置 currentTime；视频素材暂停后主动 seek 并等待 seeked。
- HTML 内的相对图片、样式、脚本路径相对于源文件。初始图片与字体自动等待；逐帧切换的动态素材要自行 await。
- Canvas 的像素宽高应使用 info.width / info.height；页面 margin 设为 0。
- 页面无 Node.js 集成，没有 SpCode 的 preload/API。不要在动画页里调用文件或系统命令。

## 调用

先用 write_file/edit_file 写动画文件，再调用 render_code_video：

    {
      "sourcePath": "video/scene.html",
      "width": 1280,
      "height": 720,
      "fps": 30,
      "duration": 6,
      "audioPath": "video/music.wav"
    }

底层 audioPath 可省略以支持明确要求的无声视频；正常有声视频应提供音轨。代码合成用 render_code_audio，分析现有音乐用 analyze_audio，先核对起音和能量增强时间，再安排画面卡点，详见 docs/code-audio.md。音轨短于画面时补静音，长于画面时截断。
宽高必须为正偶数；fps 和 duration 为正数；总帧数为 ceil(duration * fps)，实际时长为总帧数 / fps。
用户未指定视频规格时默认使用 1920×1080、60fps；用户指定的画幅、尺寸或帧率优先。调用工具仍须显式传入参数，时长按分镜与音频确定，不通过实时屏幕录制决定。

## 产物与验收

每次调用返回 generated/code-video-唯一编号/ 下的 video.mp4、首中尾 PNG 与 render.json。
记录包含源文件、参数、实际时长、帧数、文件大小和预览路径。
先检查预览画面，再播放 MP4 核对动作、分镜节奏和音画同步；编码完成仅证明文件导出成功。
界面停止按钮会中断隐藏页面与 FFmpeg，失败/中止不会返回完成结果；已生成的文件保留用于诊断。

运行集成验收：

    node_modules\electron\dist\electron.exe scripts/test-code-video.cjs

验收会生成独立测试目录和一个三秒代码动画样片，检查真实 MP4 帧数、尺寸、时长、
逐帧画面、音轨、错误传播、取消与工具注册，不调用外部聊天/生成 API。

## 运行环境

FFmpeg 必须能通过 ffmpeg 命令启动，且带 libx264 编码器；缺失或编码失败会返回实际错误，不改走视频生成模型。
安装版同样需要 FFmpeg 在 PATH 中。修改 Agent 源码后，当前已运行的 SpCode 需要重启才能发现新工具。
