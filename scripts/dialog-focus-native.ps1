# 管道双向使用 UTF-8，中文按键不能按控制台默认代码页解析。
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Add-Type -AssemblyName System.Windows.Forms

# 一次建立原生输入通道，避免每次启动控制台进程改变待测窗口的激活状态。
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DialogFocusNative {
    public delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int count);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", SetLastError=true)] static extern uint SendInput(uint count, Input[] events, int size);
    // 保留鼠标结构成员以得到 Windows x64 INPUT 联合体的真实尺寸与对齐。
    [StructLayout(LayoutKind.Sequential)] struct Input { public uint type; public InputUnion data; }
    [StructLayout(LayoutKind.Explicit)] struct InputUnion { [FieldOffset(0)] public Keyboard keyboard; [FieldOffset(0)] public Mouse mouse; }
    [StructLayout(LayoutKind.Sequential)] struct Keyboard { public ushort virtualKey; public ushort scan; public uint flags; public uint time; public UIntPtr extra; }
    [StructLayout(LayoutKind.Sequential)] struct Mouse { public int x; public int y; public uint mouseData; public uint flags; public uint time; public UIntPtr extra; }
    /// <summary>通过系统键盘路由发送 Unicode 按下与释放事件，避免拼音输入法暂存测试字符。</summary>
    /// <param name="text">单个 UTF-16 代码单元，范围 U+0000 至 U+FFFF；测试传入单个基本多文种平面字符，不接收字符串或完整代理对。</param>
    /// <exception cref="System.ComponentModel.Win32Exception">SendInput 未完整发送两个事件时，携带系统错误码抛出异常，不报告输入成功。</exception>
    public static void TypeCharacter(char text) {
        var events = new Input[2];
        events[0].type = 1; events[0].data.keyboard.scan = text; events[0].data.keyboard.flags = 4;
        events[1].type = 1; events[1].data.keyboard.scan = text; events[1].data.keyboard.flags = 6;
        if (SendInput(2, events, Marshal.SizeOf(typeof(Input))) != 2) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    // 只查找给定测试进程的原生消息框，不匹配标题相同的其它程序。
    public static IntPtr FindDialog(uint target) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint process;
            GetWindowThreadProcessId(window, out process);
            if (process != target) return true;
            var name = new StringBuilder(256);
            GetClassName(window, name, 256);
            if (name.ToString() != "#32770") return true;
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }
}
'@

[Console]::WriteLine('{"ok":true,"result":"ready"}')
while ($requestLine = [Console]::ReadLine()) {
    try {
        $request = ConvertFrom-Json $requestLine
        if ($request.action -eq 'key' -or $request.action -eq 'activate') {
            $target = [IntPtr]([long]$request.hwnd)
            # 仅为初始基线建立前台窗口，错误弹窗关闭后不帮助生产代码重新激活。
            if ($request.action -eq 'activate') {
                # 与桌面工具相同：仅初始激活时发送 Alt 按下/释放，取得 Windows 前台切换许可。
                [DialogFocusNative]::keybd_event(18, 0, 0, [UIntPtr]::Zero)
                [DialogFocusNative]::keybd_event(18, 0, 2, [UIntPtr]::Zero)
                [DialogFocusNative]::SetForegroundWindow($target) | Out-Null
                # 清除初始自动化启动时继承的修饰键状态，仅作用于建立测试基线。
                foreach ($modifier in @(16, 17, 18, 160, 161, 162, 163, 164, 165)) {
                    [DialogFocusNative]::keybd_event([byte]$modifier, 0, 2, [UIntPtr]::Zero)
                }
            }
            if ([DialogFocusNative]::GetForegroundWindow() -ne $target) { throw ('测试窗口不在前台，实际句柄=' + [DialogFocusNative]::GetForegroundWindow()) }
            if ($request.action -eq 'key') { [DialogFocusNative]::TypeCharacter([char]$request.key) }
            $result = 'completed'
        } elseif ($request.action -eq 'dialog') {
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            $dialog = [IntPtr]::Zero
            while ([DateTime]::UtcNow -lt $deadline) {
                $dialog = [DialogFocusNative]::FindDialog([uint32]$request.process)
                if ($dialog -ne [IntPtr]::Zero) { break }
                Start-Sleep -Milliseconds 30
            }
            if ($dialog -eq [IntPtr]::Zero) { throw '未找到测试进程的原生错误弹窗' }
            # WM_COMMAND / IDOK 等价于确认本测试消息框，不操作其它窗口。
            if (-not [DialogFocusNative]::PostMessage($dialog, 273, [IntPtr]1, [IntPtr]::Zero)) { throw '确认原生错误弹窗失败' }
            $result = $dialog.ToInt64().ToString()
        } else {
            throw '未知的焦点测试操作'
        }
        [Console]::WriteLine((@{ ok = $true; result = $result } | ConvertTo-Json -Compress))
    } catch {
        [Console]::WriteLine((@{ ok = $false; error = $_.Exception.Message } | ConvertTo-Json -Compress))
    }
}
