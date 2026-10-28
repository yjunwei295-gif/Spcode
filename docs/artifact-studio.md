# 代码作品工作台

AI 将图片、方案、流程图、交互演示或动画写成项目内的 HTML/Canvas/SVG 源文件，然后调用 `present_artifact`。聊天会出现作品卡片；项目顶栏的「作品」可以重开磁盘清单中的作品，不依赖原对话是否打开。

## 登记和修改

`present_artifact` 必填 `sourcePath`、`title`、`width`、`height`，尺寸单位为作品像素。源文件必须已存在于项目内，类型为 HTML 或 SVG。同一源路径重复登记会更新同一清单；源文件和清单保存后，打开的作品窗口自动刷新，播放回到首帧。CSS、字体、图片等相对引用以源文件所在目录为基准；修改依赖素材后可点「刷新」。

动画额外提供正数 `fps`、`duration`，可选项目内的 `audioPath`。HTML 定义 `window.renderFrame(time, frame, info)`：`time` 是秒、`frame` 从零开始，`info` 含 width/height/fps/duration/totalFrames。可返回 Promise，动态素材须自行等待；每帧必须由参数决定，不依赖实时计时、随机数或自动播放。音乐先用 analyze_audio 读取真实采样，核对起音/能量增强候选，再引用其时间线组织分镜和转场；需要代码配乐时先用 render_code_audio 合成 WAV。见 docs/code-audio.md。

## 预览与下载

作品在独立 Chromium 视图运行，无 Node、无聊天主窗的 preload API。工具栏沿用 SpCode 主题。网页可正常交互；动画提供播放、暂停、时间轴和已有音轨试听。时间轴选择在松开拖动后提交画面。

- 「下载 PNG」保存当前预览内容，包括网页里临时调整的交互状态，按登记的像素尺寸输出；透明 SVG 保留透明背景。
- 「下载源文件」下载原 HTML 或 SVG；它是源稿，不是自动打包依赖的离线网站。引用素材仍按原目录关系保存。
- 「导出 MP4」按登记参数从源稿逐帧生成 H.264 视频，使用既有 FFmpeg 渲染器。短音轨补静音、长音轨截到画面结束；宽高须为正偶数。临时交互状态须写入源稿后才能进入重新渲染的视频。
- 用户先选择下载位置，再开始导出；取消选择不启动渲染，导出期间可点「停止导出」。关闭作品窗口也会中止它的导出任务。

## AI 导出与验收

`export_artifact` 接收 `manifest`、`format`，可选 PNG 的采样时间 `time`（秒，省略为首帧）。format 支持 png、svg、html、mp4；SVG/HTML 源文件下载必须与源稿类型一致。AI 导出从源稿重新绘制，输出到项目 `generated/artifact-export-*`，视频输出到既有 `generated/code-video-*`。

登记、导出接入现有 Agent 普通/直通工具、快照、只读和开工门槛；不会因为作品工具绕过原有授权。清单存于 `generated/artifacts/`，聊天只保存相对入口，不嵌入可执行 HTML。失败按原始错误报告，不降级格式或改用生成模型。

生成成功不等于画面已通过验收。交付前应检查实际 PNG/视频内容、尺寸、时长和下载文件；需要照片、插画等生成模型素材时再调用 `generate_media`。

## 本地验证

运行 `node_modules/electron/dist/electron.exe scripts/test-artifact-studio.cjs`。专项覆盖实际 Agent 分发、完整聊天 DOM 与 preload/IPC、透明 PNG、指定帧像素、真实 MP4 解码、网页交互、播放/暂停、源稿刷新、下载和会话保存。原代码视频、模块提示词、输入性能回归继续适用。

新 main/preload/工具注册需要重启源码版 SpCode。已发布的 1.0.1 安装包不包含这次新增工作台；使用安装版需重新构建新版后更新。
