using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>
/// 全局监听：自定义截图键连按 N 次触发（忽略按住连发）；Shift+F1~F12 切贴图分组。
/// 平时不拦截按键，仅在真正触发截图时吞掉该次按下/抬起，避免挡住正常输入。
/// </summary>
internal sealed class ScreenshotHotkeyWatcher : IDisposable
{
    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmSysKeyDown = 0x0104;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyUp = 0x0105;

    private readonly object _gate = new();
    private IntPtr _hook;
    private LowLevelKeyboardProc? _proc;
    private int _targetVk;
    private int _pressNeeded = 3;
    private int _gapMs = 700;
    private int _pressCount;
    private long _lastPressTick;
    private bool _targetHeld;
    private bool _paused;
    private bool _disposed;
    private bool _swallowNextTargetUp;
    private readonly HashSet<int> _fnHeld = new();

    public event Action? Triggered;
    /// <summary>Shift+F1~F12 → 分组 0~11。</summary>
    public event Action<int>? PinGroupHotkey;

    public void ApplySettings(int keyCode, int pressCount, int gapMs)
    {
        lock (_gate)
        {
            _targetVk = MapToVk(keyCode);
            _pressNeeded = LevelConfig.ClampScreenshotPressCount(pressCount);
            _gapMs = LevelConfig.ClampScreenshotPressGapMs(gapMs);
            _pressCount = 0;
            _lastPressTick = 0;
            _targetHeld = false;
            _swallowNextTargetUp = false;
        }
    }

    public void SetPaused(bool paused)
    {
        lock (_gate)
        {
            _paused = paused;
            _targetHeld = false;
            _pressCount = 0;
            _lastPressTick = 0;
            _swallowNextTargetUp = false;
        }
    }

    public void Start()
    {
        if (_hook != IntPtr.Zero) return;
        _proc = HookCallback;
        using var cur = Process.GetCurrentProcess();
        var modName = cur.MainModule?.ModuleName;
        _hook = SetWindowsHookEx(WhKeyboardLl, _proc, GetModuleHandle(modName), 0);
        if (_hook == IntPtr.Zero)
            _hook = SetWindowsHookEx(WhKeyboardLl, _proc, GetModuleHandle(null), 0);
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_hook != IntPtr.Zero)
        {
            UnhookWindowsHookEx(_hook);
            _hook = IntPtr.Zero;
        }
        _proc = null;
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            var msg = wParam.ToInt32();
            var vk = Marshal.ReadInt32(lParam);
            var eat = false;

            if (msg is WmKeyUp or WmSysKeyUp)
            {
                lock (_gate)
                {
                    if (vk == _targetVk)
                    {
                        _targetHeld = false;
                        if (_swallowNextTargetUp)
                        {
                            _swallowNextTargetUp = false;
                            eat = true;
                        }
                    }

                    _fnHeld.Remove(vk);
                }
            }
            else if (msg is WmKeyDown or WmSysKeyDown)
            {
                if (vk is >= 0x70 and <= 0x7B)
                {
                    bool first;
                    lock (_gate)
                        first = _fnHeld.Add(vk);
                    if (first && (GetAsyncKeyState(0x10) & 0x8000) != 0)
                    {
                        try { PinGroupHotkey?.Invoke(vk - 0x70); } catch { /* ignore */ }
                        eat = true;
                    }
                }

                bool fire = false;
                lock (_gate)
                {
                    if (!_paused && vk == _targetVk && !_targetHeld)
                    {
                        _targetHeld = true;
                        var now = Environment.TickCount64;
                        if (_lastPressTick != 0 && now - _lastPressTick > _gapMs)
                            _pressCount = 0;

                        _pressCount++;
                        _lastPressTick = now;
                        if (_pressCount >= _pressNeeded)
                        {
                            _pressCount = 0;
                            _lastPressTick = 0;
                            fire = true;
                            _swallowNextTargetUp = true;
                            eat = true; // 仅触发时拦截，平时不挡输入
                        }
                    }
                }

                if (fire)
                {
                    try { Triggered?.Invoke(); } catch { /* ignore */ }
                }
            }

            if (eat)
                return (IntPtr)1;
        }

        return CallNextHookEx(_hook, nCode, wParam, lParam);
    }

    private static int MapToVk(int keysValue)
    {
        var vk = keysValue & 0xFFFF;
        return vk == 0 ? (int)Keys.F2 : vk;
    }

    private delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr GetModuleHandle(string? lpModuleName);

    [DllImport("user32.dll")]
    private static extern short GetAsyncKeyState(int vKey);
}
