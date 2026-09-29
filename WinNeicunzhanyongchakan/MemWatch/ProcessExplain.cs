namespace MemWatch;

/// <summary>进程悬停说明：是什么、有什么用、结束会导致什么（风格对齐大文件删除提示）。</summary>
internal static class ProcessExplain
{
    public static string BuildToolTip(string processName, int pid, long memMb, string levelName)
    {
        var key = Normalize(processName);
        var (title, role, impact) = Resolve(key, processName);

        return L.T(
            $"进程：{processName}.exe（PID {pid}）\n占用：{memMb:N0} MB · {levelName}\n\n" +
            $"这是什么：\n{title}\n\n有什么用：\n{role}\n\n结束影响：\n{impact}",
            $"Process: {processName}.exe (PID {pid})\nMemory: {memMb:N0} MB · {levelName}\n\n" +
            $"What it is:\n{title}\n\nWhat it does:\n{role}\n\nIf you end it:\n{impact}");
    }

    private static string Normalize(string name)
    {
        var s = (name ?? "").Trim();
        if (s.EndsWith(".exe", StringComparison.OrdinalIgnoreCase))
            s = s[..^4];
        return s.ToLowerInvariant();
    }

    private static (string Title, string Role, string Impact) Resolve(string key, string displayName)
    {
        // 关键系统 / 不建议结束
        if (key is "system" or "registry" or "smss" or "csrss" or "wininit" or "winlogon"
            or "services" or "lsass" or "lsm" or "fontdrvhost")
            return Crit(
                L.T("Windows 核心系统进程", "Windows core system process"),
                L.T("维持系统启动、安全与基础服务。", "Keeps boot, security, and core services running."),
                L.T("不要结束。强行结束可能导致蓝屏、注销或系统不稳定。",
                    "Do not end. Forcing it may cause BSOD, logoff, or instability."));

        if (key is "dwm" or "dwm.exe")
            return Crit(
                L.T("桌面窗口管理器 (DWM)", "Desktop Window Manager (DWM)"),
                L.T("负责窗口合成、透明效果与桌面流畅显示。", "Composites windows and desktop visuals."),
                L.T("结束会导致黑屏/桌面异常，系统通常会自动重启它。",
                    "Ending it can blank the desktop; Windows usually restarts it."));

        if (key is "explorer")
            return Tip(
                L.T("Windows 资源管理器", "Windows Explorer"),
                L.T("桌面、任务栏、开始菜单和文件夹窗口。", "Desktop, taskbar, Start menu, and folders."),
                L.T("结束后面板/桌面图标会消失，可在任务管理器里重新运行 explorer.exe 恢复。",
                    "Taskbar/desktop vanish; restart explorer.exe from Task Manager to recover."));

        if (key is "svchost")
            return Tip(
                L.T("服务宿主进程 (svchost)", "Service Host (svchost)"),
                L.T("承载多个 Windows 后台服务（更新、网络、系统组件等）。",
                    "Hosts many Windows background services."),
                L.T("结束可能中断网络、更新或其它服务；一般不建议手动结束，除非确认是异常占用。",
                    "May break network/updates/services. Avoid unless you know it's abnormal."));

        if (key is "runtimebroker" or "runtimebroker.exe")
            return Tip(
                L.T("Runtime Broker", "Runtime Broker"),
                L.T("管理 UWP/商店应用的权限与后台行为。", "Manages UWP/Store app permissions."),
                L.T("结束通常安全，系统或应用可能会再拉起；偶发权限弹窗异常。",
                    "Usually safe; Windows/apps may restart it."));

        if (key is "searchhost" or "searchapp" or "searchindexer" or "searchprotocolhost")
            return Tip(
                L.T("Windows 搜索相关进程", "Windows Search component"),
                L.T("开始菜单搜索、文件索引。", "Start search and file indexing."),
                L.T("结束会暂时搜不到内容，一般会自动恢复；索引可能稍慢一点。",
                    "Search may stop briefly; usually restarts. Indexing may lag."));

        if (key is "startmenuexperiencehost" or "shellexperiencehost" or "sihost"
            or "textinputhost" or "applicationframehost" or "systemsettings")
            return Tip(
                L.T("Windows 界面组件", "Windows UI component"),
                L.T("开始菜单、通知中心、输入法、设置或 UWP 窗口框架等。",
                    "Start menu, notifications, IME, Settings, or UWP frames."),
                L.T("结束后面板相关功能可能闪退，通常会自动重启。",
                    "UI pieces may flicker/crash and usually restart."));

        if (key is "audiodg")
            return Tip(
                L.T("Windows 音频设备图形隔离", "Windows Audio Device Graph Isolation"),
                L.T("处理系统与应用音频增强。", "Handles audio enhancements."),
                L.T("结束可能导致暂时没声音，音频服务重启后恢复。",
                    "Sound may cut out briefly until audio service recovers."));

        if (key is "msmpeng" or "securityhealthservice" or "securityhealthsystray"
            or "antimalware service executable")
            return Tip(
                L.T("Windows 安全 / Defender 相关", "Windows Security / Defender"),
                L.T("实时防护、威胁扫描。", "Real-time protection and scanning."),
                L.T("结束会降低防护能力，且常会被系统重新拉起；不建议为腾内存而关。",
                    "Lowers protection and often restarts. Don't kill just to free RAM."));

        if (key is "taskmgr" or "mmc")
            return Tip(
                L.T("任务管理器 / 管理控制台", "Task Manager / MMC"),
                L.T("查看与管理系统、服务。", "Inspect and manage the system."),
                L.T("结束只是关掉该窗口，不影响其它程序。", "Only closes that tool window."));

        // 浏览器
        if (key is "chrome" or "chrome.exe")
            return Tip(
                L.T("Google Chrome 浏览器", "Google Chrome"),
                L.T("上网、网页应用、扩展。多标签会开多个进程。",
                    "Web browsing; many tabs mean many processes."),
                L.T("结束会关闭对应窗口/标签，未保存的表单可能丢失；可重新打开浏览器。",
                    "Closes those tabs/windows; unsaved forms may be lost. Reopen Chrome anytime."));

        if (key is "msedge" or "msedgewebview2" or "microsoftedgeupdate")
            return Tip(
                L.T("Microsoft Edge / WebView2", "Microsoft Edge / WebView2"),
                L.T("微软浏览器，或给其它软件提供内嵌网页组件。",
                    "Microsoft browser, or embedded web UI for other apps."),
                L.T("结束 Edge 会关标签页；结束 WebView2 可能导致依赖它的软件界面空白。",
                    "Ending Edge closes tabs; ending WebView2 may blank apps that embed it."));

        if (key is "firefox" or "waterfox" or "librewolf")
            return Tip(
                L.T("Firefox 系浏览器", "Firefox-based browser"),
                L.T("上网浏览。", "Web browsing."),
                L.T("结束会关闭浏览窗口，未保存内容可能丢失。",
                    "Closes the browser; unsaved content may be lost."));

        if (key is "opera" or "brave" or "vivaldi" or "360chrome" or "360se" or "qqbrowser"
            or "sogouexplorer" or "liebao" or "maxthon")
            return Tip(
                L.T("第三方浏览器", "Third-party browser"),
                L.T("上网浏览。", "Web browsing."),
                L.T("结束会关闭该浏览器窗口，网页会话可能丢失。",
                    "Closes the browser; session may be lost."));

        // 通讯 / 社交
        if (key is "wechat" or "weixin" or "wechatappex" or "wechatbrowser")
            return Tip(
                L.T("微信", "WeChat"),
                L.T("即时通讯、支付、小程序等。", "Messaging, payments, mini programs."),
                L.T("结束会退出微信，收不到消息；可重新登录打开。",
                    "WeChat exits and may miss messages until reopened."));

        if (key is "qq" or "qqprotect" or "tim")
            return Tip(
                L.T("QQ / TIM", "QQ / TIM"),
                L.T("即时通讯。", "Instant messaging."),
                L.T("结束会退出 QQ，消息需重开后同步。", "QQ exits; reopen to sync messages."));

        if (key is "discord")
            return Tip(
                L.T("Discord", "Discord"),
                L.T("语音/文字社区聊天。", "Voice/text community chat."),
                L.T("结束会断开语音与消息；可再打开。", "Disconnects voice/chat; reopen anytime."));

        if (key is "telegram" or "telegramdesktop")
            return Tip(
                L.T("Telegram", "Telegram"),
                L.T("即时通讯。", "Messaging."),
                L.T("结束会退出客户端，可再打开。", "Exits the client; reopen anytime."));

        if (key is "slack" or "teams" or "ms-teams")
            return Tip(
                L.T("办公协作软件", "Work collaboration app"),
                L.T("团队聊天、会议。", "Team chat and meetings."),
                L.T("结束会退出会议/聊天客户端。", "Exits the chat/meeting client."));

        if (key is "feishu" or "lark" or "dingtalk" or "wxwork")
            return Tip(
                L.T("办公/协作客户端（飞书/钉钉/企微等）", "Work IM client (Lark/DingTalk/WeCom…)"),
                L.T("工作消息、会议、文档协作。", "Work messages, meetings, docs."),
                L.T("结束会收不到工作消息，会议可能中断。",
                    "You'll miss work messages; meetings may drop."));

        // 游戏 / 平台
        if (key is "steam" or "steamwebhelper" or "steamservice" or "gameoverlayui")
            return Tip(
                L.T("Steam 平台相关", "Steam platform"),
                L.T("游戏库、下载、覆盖层、后台更新。", "Library, downloads, overlay, updates."),
                L.T("结束 Steam 会停止下载/好友状态；游戏中覆盖层可能失效。正在运行的游戏不一定一起退出。",
                    "Stops Steam downloads/friends; overlay may die. Running games may keep going."));

        if (key is "epicgameslauncher" or "epicwebhelper" or "origin" or "eadesktop"
            or "battlenet" or "agent" or "gog galaxy")
            return Tip(
                L.T("游戏平台启动器", "Game launcher"),
                L.T("管理游戏安装、更新与启动。", "Installs, updates, and launches games."),
                L.T("结束启动器通常不影响已开游戏，但无法再从平台启动/更新。",
                    "Running games often continue; you can't launch/update from the store."));

        if (key.Contains("easyanticheat", StringComparison.Ordinal) ||
            key.Contains("battleye", StringComparison.Ordinal) ||
            key is "faceitclient")
            return Tip(
                L.T("游戏反作弊组件", "Game anti-cheat"),
                L.T("防止作弊，常随游戏启动。", "Anti-cheat, usually started with the game."),
                L.T("结束可能导致游戏无法进入或被踢出。", "Game may refuse to start or kick you."));

        // 开发工具
        if (key is "code" or "code - insiders" or "cursor" or "devenv" or "rider64"
            or "idea64" or "clion64" or "webstorm64" or "phpstorm64" or "pycharm64")
            return Tip(
                L.T("代码编辑器 / IDE", "Code editor / IDE"),
                L.T("写代码、调试、扩展语言服务。", "Editing, debugging, language services."),
                L.T("结束会丢失未保存文件（若未自动保存）；语言服务/终端会话也会中断。",
                    "Unsaved files may be lost; terminals/language servers stop."));

        if (key is "node" or "node.js")
            return Tip(
                L.T("Node.js 运行时", "Node.js runtime"),
                L.T("跑前端工具、本地服务、脚本。", "Runs JS tools, local servers, scripts."),
                L.T("结束会停掉对应脚本/开发服务器。", "Stops that script/dev server."));

        if (key is "python" or "pythonw" or "py")
            return Tip(
                L.T("Python 解释器", "Python interpreter"),
                L.T("运行 Python 脚本或服务。", "Runs Python scripts/services."),
                L.T("结束会中断正在跑的脚本。", "Stops the running script."));

        if (key is "git" or "ssh-agent")
            return Tip(
                L.T("开发辅助进程", "Dev helper process"),
                L.T("版本控制或 SSH 代理。", "Version control or SSH agent."),
                L.T("结束影响较小，需要时再启动即可。", "Low impact; restart when needed."));

        // 办公 / 创意
        if (key is "winword" or "excel" or "powerpnt" or "onenote" or "outlook"
            or "wps" or "wpsoffice" or "et" or "wpp")
            return Tip(
                L.T("办公文档软件", "Office document app"),
                L.T("编辑文档、表格、演示文稿等。", "Documents, spreadsheets, slides."),
                L.T("结束可能导致未保存内容丢失，请先保存。",
                    "Unsaved work may be lost — save first."));

        if (key is "photoshop" or "illustrator" or "afterfx" or "premiere pro" or "prproj"
            or "adobe premiere pro" or "acrobat" or "acrord32" or "lightroom")
            return Tip(
                L.T("Adobe / 设计相关软件", "Adobe / creative app"),
                L.T("图像、视频、设计或 PDF。", "Images, video, design, or PDF."),
                L.T("结束会丢失未保存工程；可能留下临时恢复文件。",
                    "Unsaved projects may be lost; recovery temps may remain."));

        if (key is "obs64" or "obs32" or "obs")
            return Tip(
                L.T("OBS Studio", "OBS Studio"),
                L.T("直播与录屏。", "Streaming and recording."),
                L.T("结束会停止推流/录像，未完成文件可能损坏。",
                    "Stops stream/recording; unfinished files may corrupt."));

        // 硬件 / 驱动相关
        if (key.Contains("nvidia", StringComparison.Ordinal) ||
            key is "nvcontainer" or "nvdisplay.container" ||
            key.Contains("amdow", StringComparison.Ordinal) ||
            key.Contains("radeon", StringComparison.Ordinal) ||
            key.StartsWith("igfx", StringComparison.Ordinal))
            return Tip(
                L.T("显卡驱动 / 控制面板组件", "GPU driver / control panel"),
                L.T("显卡调度、叠加层、设置面板。", "GPU scheduling, overlays, settings."),
                L.T("结束可能导致叠加层消失或短暂花屏，系统常会重启该组件。",
                    "Overlay may vanish or flicker; Windows often restarts it."));

        if (key is "memory compression")
            return Tip(
                L.T("内存压缩", "Memory Compression"),
                L.T("系统把空闲页压缩以腾出物理内存。", "Compresses pages to free physical RAM."),
                L.T("这不是普通应用进程，列表里通常不应手动结束。",
                    "Not a normal app; usually shouldn't be ended manually."));

        // 本程序
        if (key is "memwatch" or "memwatch.app")
            return Tip(
                L.T("本程序（内存监控）", "This app (MemWatch)"),
                L.T("监控内存占用并可选自动清理高占用进程。",
                    "Monitors memory and can auto-end high users."),
                L.T("结束会退出监控与亚哈/猎杀功能。",
                    "Exits monitoring and Ahab/Hunt features."));

        // 默认
        return Tip(
            L.T($"应用程序「{displayName}」", $"Application \"{displayName}\""),
            L.T("第三方或系统未单独标注的程序，可能是软件主程序、后台助手或更新器。",
                "A third-party or unmarked process — main app, helper, or updater."),
            L.T("结束会关闭该程序相关窗口/后台任务。若不确定用途，建议先看它是否在托盘运行，或结束前保存工作。",
                "Ends its windows/background tasks. If unsure, check the tray and save work first."));
    }

    private static (string, string, string) Tip(string title, string role, string impact) =>
        (title, role, impact);

    private static (string, string, string) Crit(string title, string role, string impact) =>
        (title, role, impact);
}
