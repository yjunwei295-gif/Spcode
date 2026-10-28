# 代码音轨与音频卡点

先准备音频 → 分析真实采样 → 核对卡点 → 按音频时间写分镜 → 预览 → 导出有声 MP4。

## 合成音轨
编写项目内 HTML，定义 async window.renderAudio(info)，使用 OfflineAudioContext，返回 AudioBuffer。
render_code_audio 明确传入 sourcePath、duration（秒）、sampleRate、channels（1 或 2）。
音轨帧数必须是 ceil(duration * sampleRate)，声道/采样率须相符。采样超出 [-1,1] 直接报错，应在音轨源稿调整混音，工具不自动削波或归一化。
输出 generated/code-audio-*/audio.wav 和 render.json；保留源稿，可修改旋律、音色、节奏后重做。自然旁白需另接语音合成引擎。

## 分析已有音乐
analyze_audio 可读取 FFmpeg 支持的音轨，不限代码合成音频。必填 audioPath 和以下检测参数：

| 参数 | 含义 |
| --- | --- |
| hopMs | 包络采样间隔（毫秒） |
| minGapMs | 起音最小间距（毫秒，不小于 hopMs） |
| peakThreshold | 相对最强包络上升幅度的阈值，0 到 1 之间 |
| energyWindowMs | RMS 能量分段（毫秒，不小于 hopMs） |
| riseRatio | 相邻能量段判为增强的倍数，大于 1 |

例如对鼓点清晰的音轨可以从 10 / 250 / 0.15 / 600 / 1.5 开始试听调整。这是调用示例，不是程序写死的参数。
输出 timeline.json、timeline.js：waveform 是 RMS 包络，onsets 是起音候选秒数和相对强度，energyRises 是能量增幅位置，tempoEstimate 是起音间距中位数换算的估值。
这是音量包络检测，不是全自动乐理识别；持续音、弱鼓点、切分、复杂混音可能漏检/误检，也无法确认小节重拍。静音无起音、无 BPM；不能把估值冒充确定 BPM 或均匀补出不存在的拍点。

## 跟随音频安排画面
在动画 HTML 用相对 script src 引入实际分析返回的 timeline.js，读取 window.audioTimeline。按 onsets 中核对过的时间安排文字/转场，在 energyRises 处增强动作或切段。先按视频叙事、阅读时间、重点揭晓、转场和收尾选取落点，再在源稿集中声明分镜与音频卡点对应表；内容可跨多拍保持，不按总拍数均分镜头，也不要求每拍都有动作。分镜和特殊重拍可以在源稿中人工标注，不能把估计当成已经试听确认。演示按第 1/3/5/11/15 个实测起音进入五段内容，两次增强后的起音承接重点展示和成品揭晓；这些选择是演示的剪辑安排，不是检测器声称识别出的音乐重拍。
同一音轨通过 audioPath 传给 present_artifact 和 render_code_video。工作台有音乐时以 audio.currentTime 为主时钟，暂停/跳转同步；短音轨结束后按导出的补静音规则继续尾段，长音轨在画面结束时暂停。
MP4 从源稿按固定时间逐帧绘制并合入同一音频。验收必须检查解码音轨、关键帧及卡点时间；只有容器里有 AAC 不代表音频内容或同步正确。

## 本地验收
运行 node_modules/electron/dist/electron.exe scripts/test-code-audio.cjs，覆盖真实 Agent 合成/分析分发、WAV 采样、已知拍点定位、能量变强、静音、取消、实际预览音频时钟和 MP4 音画时间核对。
新增工具需要重启源码版 SpCode；现有安装版需重新构建更新后才包含此功能。
