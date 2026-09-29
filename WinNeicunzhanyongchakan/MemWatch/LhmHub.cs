using LibreHardwareMonitor.Hardware;

namespace MemWatch;

/// <summary>
/// 进程内唯一的 LibreHardwareMonitor Computer。
/// CPU / GPU / 硬盘检测共用，避免多次 Open/Close 抢 WinRing0 导致传感器只剩 1 个。
/// </summary>
internal static class LhmHub
{
    private static readonly object Gate = new();
    private static Computer? _computer;
    private static bool _failed;
    private static bool _shuttingDown;

    public static object Sync => Gate;

    public static bool IsFailed
    {
        get
        {
            lock (Gate)
                return _failed || _shuttingDown;
        }
    }

    /// <summary>调用方必须已持有 <see cref="Sync"/>。</summary>
    public static Computer? GetComputerUnlocked()
    {
        if (_shuttingDown || _failed)
            return null;

        if (_computer is not null)
            return _computer;

        try
        {
            var c = new Computer
            {
                IsCpuEnabled = true,
                IsGpuEnabled = true,
                IsStorageEnabled = true
            };
            c.Open();
            _computer = c;
            return _computer;
        }
        catch
        {
            _failed = true;
            _computer = null;
            return null;
        }
    }

    /// <summary>调用方必须已持有 <see cref="Sync"/>。短暂失败时可清失败标记并重试打开。</summary>
    public static Computer? RecoverComputerUnlocked()
    {
        if (_shuttingDown)
            return null;

        try
        {
            _computer?.Close();
        }
        catch
        {
            // ignore
        }

        _computer = null;
        _failed = false;
        return GetComputerUnlocked();
    }

    public static void Shutdown()
    {
        lock (Gate)
        {
            _shuttingDown = true;
            try
            {
                _computer?.Close();
            }
            catch
            {
                // ignore
            }

            _computer = null;
            _failed = false;
        }
    }
}
