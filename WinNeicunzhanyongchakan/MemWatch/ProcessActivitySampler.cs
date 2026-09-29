using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MemWatch;

/// <summary>短采样进程 CPU 占用，供猎杀弹窗判断低活动。</summary>
internal static class ProcessActivitySampler
{
    private const int SampleMs = 300;

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    /// <summary>当前前台窗口进程 PID；取不到时返回 -1。</summary>
    public static int TryGetForegroundPid()
    {
        try
        {
            var hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero)
                return -1;
            _ = GetWindowThreadProcessId(hwnd, out var pid);
            return pid > 0 ? (int)pid : -1;
        }
        catch
        {
            return -1;
        }
    }

    /// <summary>对所有 PID 同步采样一次，总耗时约 SampleMs。</summary>
    public static Dictionary<int, double> SampleMany(IReadOnlyList<int> pids)
    {
        var map = new Dictionary<int, double>();
        if (pids.Count == 0)
            return map;

        var cores = Environment.ProcessorCount;
        if (cores <= 0)
            cores = 1;

        var handles = new List<(int Pid, Process Proc, TimeSpan T1)>(pids.Count);
        foreach (var pid in pids)
        {
            if (pid <= 0 || map.ContainsKey(pid))
                continue;
            try
            {
                var proc = Process.GetProcessById(pid);
                handles.Add((pid, proc, proc.TotalProcessorTime));
            }
            catch
            {
                // 无权限或已退出
            }
        }

        if (handles.Count == 0)
            return map;

        Thread.Sleep(SampleMs);

        foreach (var (pid, proc, t1) in handles)
        {
            try
            {
                proc.Refresh();
                var usedMs = (proc.TotalProcessorTime - t1).TotalMilliseconds;
                map[pid] = Math.Max(0, usedMs / (SampleMs * (double)cores) * 100.0);
            }
            catch
            {
                // 采样失败则不写入，弹窗侧视为未知 CPU、不自动勾选
            }
            finally
            {
                proc.Dispose();
            }
        }

        return map;
    }
}
