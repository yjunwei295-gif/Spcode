# SimpleCode 1.0.6

Windows x64 安装版与免安装便携版。应用运行时随包提供，本地模型权重和外部模型账号需另行配置。

## 更新内容

- 文件树普通点击 HTML/HTM、BAT/CMD 和 EXE 时交给系统默认程序打开；中文、空格、井号、括号和与号保留原始路径。
- 其他文件继续使用现有预览；Ctrl 点击仍只添加上下文；系统启动失败按原错误返回。
- 主窗口及可见作品页面中的网页链接交给系统默认浏览器，原应用页面保持不变；邮件链接保留系统邮件程序入口。
- 网页子资源与作品 iframe 继续在原页面加载。

## 实际验证

- 真实生产 Electron 进程的系统打开验收：31 项通过，退出码 0。
- 实际启动受控 BAT、CMD、EXE 并确认各自标记文件；本地 HTML 和网页实际进入默认浏览器并访问本机验证服务。
- 本地聊天链接回归：15 项通过，退出码 0，覆盖 Markdown、图片、大型 EXE 元信息预览、特殊字符路径和资源管理器定位。
- `git diff --cached --check` 通过。
- 本轮生产验证记录：`spcode-system-open-kz2p8i/report.json`；本地链接记录：`generated/file-links-check-tCsCj3`。

构建、EXE 启动及上传摘要的实际结果另存于本次发布的 `generated/release-1.0.6/verification.json`。两种 EXE 的 SHA256 随发布附件 `SHA256SUMS.txt` 提供。

## 更新方式与范围

完整退出所有旧实例，安装新版至原目录，或启动新版便携 EXE。上传发布包不会替换正在运行的旧进程。

未将安装向导实际安装到用户原目录，未调用外部真实模型，未进行跨天运行测试。本轮不以这些项目作为已经通过的验收。

## English

Version 1.0.6 opens launchable files from the file tree with their system default applications and routes web links from the main window and artifact pages to the default browser. Other file previews, Ctrl-click context references and in-page resource loading retain their existing behavior.

The real Electron system-opening suite passed 31 checks, including controlled BAT/CMD/EXE execution and actual default-browser requests to a local server. The local-file-link regression suite passed 15 checks. Install the new executable after fully exiting older instances; publishing an executable does not update an already running process.
